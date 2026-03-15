const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const request = require('supertest');
const { execFile, spawn } = require('child_process');
const app = require('./server');

jest.mock('child_process', () => ({
    execFile: jest.fn(),
    spawn: jest.fn(),
    spawnSync: jest.fn(() => ({ status: 0 })),
}));

function createChildProcessMock() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
        destroyed: false,
        writableEnded: false,
        writable: true,
        write: jest.fn(),
        on: jest.fn(),
    };
    child.kill = jest.fn();
    return child;
}

describe('AI CLI Proxy Server', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/tools', () => {
        it('returns Codex-first tool metadata', async () => {
            const res = await request(app).get('/api/tools');

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({
                defaultTool: 'codex',
                tools: ['codex', 'gemini', 'opencode', 'cursor'],
            });
        });
    });

    describe('POST /api/low-level', () => {
        it('executes compatible non-Codex tools unchanged', async () => {
            execFile.mockImplementationOnce((command, args, options, callback) => {
                callback(null, 'Tool output', null);
            });

            const res = await request(app)
                .post('/api/low-level')
                .send({ tool: 'gemini', prompt: 'test prompt' });

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ response: 'Tool output' });
            expect(execFile).toHaveBeenCalledWith('gemini', ['prompt', 'test prompt'], expect.any(Object), expect.any(Function));
        });

        it('passes file arguments through to compatible non-Codex tools', async () => {
            execFile.mockImplementationOnce((command, args, options, callback) => {
                callback(null, 'Tool output with files', null);
            });

            const res = await request(app)
                .post('/api/low-level')
                .send({ tool: 'gemini', prompt: 'test prompt', files: ['file1.js', 'file2.js'] });

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ response: 'Tool output with files' });
            expect(execFile).toHaveBeenCalledWith(
                'gemini',
                ['prompt', 'test prompt', '--files', 'file1.js', 'file2.js'],
                expect.any(Object),
                expect.any(Function)
            );
        });

        it('executes Codex via exec and parses JSONL agent output', async () => {
            execFile.mockImplementationOnce((command, args, options, callback) => {
                callback(
                    null,
                    '{"type":"item.completed","item":{"type":"agent_message","text":"Codex response"}}\n',
                    'noisy stderr'
                );
            });

            const res = await request(app)
                .post('/api/low-level')
                .send({ tool: 'codex', prompt: 'test prompt' });

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ response: 'Codex response' });
            expect(execFile).toHaveBeenCalledWith(
                'codex',
                ['exec', 'test prompt', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json'],
                expect.any(Object),
                expect.any(Function)
            );
        });

        it('returns 400 when the tool is missing', async () => {
            const res = await request(app)
                .post('/api/low-level')
                .send({ prompt: 'test prompt' });

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: 'Tool and prompt are required' });
        });

        it('returns 400 when the tool is unsupported', async () => {
            const res = await request(app)
                .post('/api/low-level')
                .send({ tool: 'unsupported', prompt: 'test prompt' });

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: 'Unsupported CLI tool. Allowed tools: codex, gemini, opencode, cursor' });
        });

        it('returns stderr when stdout is empty', async () => {
            execFile.mockImplementationOnce((command, args, options, callback) => {
                callback(null, '', 'Warning on stderr');
            });

            const res = await request(app)
                .post('/api/low-level')
                .send({ tool: 'gemini', prompt: 'test prompt' });

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ response: 'Warning on stderr' });
        });
    });

    describe('POST /api/low-level-stream', () => {
        it('streams Codex agent messages as SSE', async () => {
            const child = createChildProcessMock();
            spawn.mockImplementationOnce(() => {
                process.nextTick(() => {
                    child.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"type":"reasoning","text":"Thinking"}}\n'));
                    child.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"Streamed Codex reply"}}\n'));
                    child.emit('close', 0);
                });
                return child;
            });

            const res = await request(app)
                .post('/api/low-level-stream')
                .send({ tool: 'codex', prompt: 'test prompt' });

            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');
            expect(res.text).toContain('Streamed Codex reply');
            expect(spawn).toHaveBeenCalledWith(
                'codex',
                ['exec', 'test prompt', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json'],
                expect.any(Object)
            );
        });

        it('kills the child process when the client disconnects early', async () => {
            const child = createChildProcessMock();
            spawn.mockImplementationOnce(() => {
                process.nextTick(() => {
                    child.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"Chunk"}}\n'));
                });
                return child;
            });

            const server = http.createServer(app);
            await new Promise((resolve) => server.listen(0, resolve));
            const port = server.address().port;

            await new Promise((resolve, reject) => {
                const req = http.request({
                    host: '127.0.0.1',
                    method: 'POST',
                    path: '/api/low-level-stream',
                    port,
                    headers: { 'Content-Type': 'application/json' },
                });

                req.on('error', (error) => {
                    if (error.code === 'ECONNRESET') {
                        return;
                    }
                    reject(error);
                });
                req.write(JSON.stringify({ tool: 'codex', prompt: 'disconnect me' }));
                req.end();

                req.on('response', (res) => {
                    res.on('data', () => {
                        res.destroy();
                        setImmediate(() => {
                            expect(child.kill).toHaveBeenCalledTimes(1);
                            server.close((error) => {
                                if (error) {
                                    reject(error);
                                    return;
                                }
                                resolve();
                            });
                        });
                    });
                });
            });
        });

        it('returns 400 when the tool is missing', async () => {
            const res = await request(app)
                .post('/api/low-level-stream')
                .send({ prompt: 'test prompt' });

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: 'Tool and prompt are required' });
        });
    });

    describe('POST /api/harness/sessions', () => {
        it('creates a session for a supported tool', async () => {
            const res = await request(app)
                .post('/api/harness/sessions')
                .send({ tool: 'gemini', task: 'refactor code', contextDir: '/tmp' });

            expect(res.statusCode).toBe(201);
            expect(res.body.session.tool).toBe('gemini');
            expect(res.body.session.task).toBe('refactor code');
            expect(res.body.session.state).toBe('created');
            expect(res.body.session.mode).toBe('coding');
            expect(res.body.session.id).toBeDefined();
        });

        it('accepts optional mode and timeBudgetMs', async () => {
            const res = await request(app)
                .post('/api/harness/sessions')
                .send({ tool: 'gemini', task: 'build app', contextDir: '/tmp', mode: 'initializer', timeBudgetMs: 120000 });

            expect(res.statusCode).toBe(201);
            expect(res.body.session.mode).toBe('initializer');
            expect(res.body.session.timeBudgetMs).toBe(120000);
        });

        it('returns 400 for unsupported tools', async () => {
            const res = await request(app)
                .post('/api/harness/sessions')
                .send({ tool: 'unsupported', task: 'refactor code' });

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: 'Unsupported CLI tool. Allowed tools: codex, gemini, opencode, cursor' });
        });
    });

    describe('GET /api/harness/sessions', () => {
        it('lists sessions and supports filtering', async () => {
            await request(app)
                .post('/api/harness/sessions')
                .send({ tool: 'gemini', task: 'test task', contextDir: '/tmp/list-a' });

            await request(app)
                .post('/api/harness/sessions')
                .send({ tool: 'codex', task: 'another task', contextDir: '/tmp/list-b' });

            const res = await request(app).get('/api/harness/sessions?contextDir=/tmp/list-a');

            expect(res.statusCode).toBe(200);
            expect(Array.isArray(res.body.sessions)).toBe(true);
            expect(res.body.sessions).toHaveLength(1);
            expect(res.body.sessions[0].contextDir).toBe('/tmp/list-a');
        });
    });

    describe('GET /api/harness/sessions/:id', () => {
        it('returns 404 for unknown sessions', async () => {
            const res = await request(app).get('/api/harness/sessions/nonexistent');

            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: 'Session not found' });
        });

        it('does not create progress artifacts on read', async () => {
            const contextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-server-session-'));
            const createRes = await request(app)
                .post('/api/harness/sessions')
                .send({ tool: 'gemini', task: 'test task', contextDir });
            const sessionId = createRes.body.session.id;

            const res = await request(app).get(`/api/harness/sessions/${sessionId}`);

            expect(res.statusCode).toBe(200);
            expect(res.body.session.id).toBe(sessionId);
            expect(fs.existsSync(path.join(contextDir, '.harness', 'progress.json'))).toBe(false);
            expect(fs.existsSync(path.join(contextDir, '.harness', 'traces'))).toBe(false);

            fs.rmSync(contextDir, { recursive: true, force: true });
        });
    });
});
