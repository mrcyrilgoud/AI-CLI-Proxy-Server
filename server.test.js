const request = require('supertest');
const { EventEmitter } = require('events');
const { execFile, spawn, spawnSync } = require('child_process');
const app = require('./server'); // Assuming your server.js exports the app

// Mock child_process APIs used by server routes.
jest.mock('child_process', () => ({
    execFile: jest.fn(),
    spawn: jest.fn(),
    spawnSync: jest.fn(),
}));

describe('AI CLI Proxy Server', () => {
    beforeEach(() => {
        spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/tools', () => {
        it('should return a list of allowed tools', async () => {
            const res = await request(app).get('/api/tools');
            expect(res.statusCode).toEqual(200);
            expect(res.body).toHaveProperty('tools');
            expect(res.body.tools).toEqual(['gemini', 'opencode', 'codex', 'cursor']);
        });
    });

    describe('POST /api/low-level', () => {
        it('should execute the command for an allowed tool with a prompt', async () => {
            execFile.mockImplementationOnce((command, args, options, callback) => {
                callback(null, 'Tool output', null);
            });

            const res = await request(app)
                .post('/api/low-level')
                .send({ tool: 'gemini', prompt: 'test prompt' });

            expect(res.statusCode).toEqual(200);
            expect(res.body).toEqual({ response: 'Tool output' });
            expect(execFile).toHaveBeenCalledWith('gemini', ['prompt', 'test prompt'], expect.any(Object), expect.any(Function));
        });

        it('should return 400 if tool is missing', async () => {
            const res = await request(app)
                .post('/api/low-level')
                .send({ prompt: 'test prompt' });
            expect(res.statusCode).toEqual(400);
            expect(res.body).toEqual({ error: 'Tool and prompt are required' });
        });

        it('should return 400 if prompt is missing', async () => {
            const res = await request(app)
                .post('/api/low-level')
                .send({ tool: 'gemini' });
            expect(res.statusCode).toEqual(400);
            expect(res.body).toEqual({ error: 'Tool and prompt are required' });
        });

        it('should return 400 if tool is not allowed', async () => {
            const res = await request(app)
                .post('/api/low-level')
                .send({ tool: 'unsupported', prompt: 'test prompt' });
            expect(res.statusCode).toEqual(400);
            expect(res.body).toEqual({ error: 'Unsupported CLI tool. Allowed tools: gemini, opencode, codex, cursor' });
        });

        it('should execute the command with files', async () => {
            execFile.mockImplementationOnce((command, args, options, callback) => {
                callback(null, 'Tool output with files', null);
            });

            const res = await request(app)
                .post('/api/low-level')
                .send({ tool: 'gemini', prompt: 'test prompt', files: ['file1.js', 'file2.js'] });

            expect(res.statusCode).toEqual(200);
            expect(res.body).toEqual({ response: 'Tool output with files' });
            expect(execFile).toHaveBeenCalledWith('gemini', ['prompt', 'test prompt', '--files', 'file1.js', 'file2.js'], expect.any(Object), expect.any(Function));
        });

        it('should handle command execution error', async () => {
            execFile.mockImplementationOnce((command, args, options, callback) => {
                callback(new Error('Command failed'), null, 'Error details on stderr');
            });

            const res = await request(app)
                .post('/api/low-level')
                .send({ tool: 'gemini', prompt: 'test prompt' });

            expect(res.statusCode).toEqual(500);
            expect(res.body).toEqual({
                error: 'Command Execution Failed',
                details: 'Command failed',
                stderr: 'Error details on stderr'
            });
        });

        it('should return stderr as response if stdout is empty', async () => {
            execFile.mockImplementationOnce((command, args, options, callback) => {
                callback(null, '', 'Warning on stderr');
            });

            const res = await request(app)
                .post('/api/low-level')
                .send({ tool: 'gemini', prompt: 'test prompt' });

            expect(res.statusCode).toEqual(200);
            expect(res.body).toEqual({ response: 'Warning on stderr' });
        });

        it('should run codex exec and return the last agent message', async () => {
            spawn.mockImplementationOnce(() => {
                const cp = new EventEmitter();
                cp.stdout = new EventEmitter();
                cp.stderr = new EventEmitter();
                cp.kill = jest.fn();

                setImmediate(() => {
                    cp.stdout.emit('data', '{"type":"thread.started","thread_id":"t_123"}\n');
                    cp.stdout.emit('data', '{"type":"item.completed","item":{"type":"agent_message","text":"Codex says hi"}}\n');
                    cp.emit('close', 0, null);
                });

                return cp;
            });

            const res = await request(app)
                .post('/api/low-level')
                .send({ tool: 'codex', prompt: 'test codex prompt' });

            expect(res.statusCode).toEqual(200);
            expect(res.body).toEqual({ response: 'Codex says hi' });
            expect(spawn).toHaveBeenCalledTimes(1);
            expect(spawn.mock.calls[0][0]).toBe('codex');
            expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['-a', 'never', '-s', 'read-only', 'exec', '--json']));
        });

        it('should fail codex low-level when codex binary is missing', async () => {
            spawnSync.mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not found' });

            const res = await request(app)
                .post('/api/low-level')
                .send({ tool: 'codex', prompt: 'test codex prompt' });

            expect(res.statusCode).toEqual(400);
            expect(res.body.error).toContain('Codex CLI is not installed');
        });
    });

    describe('POST /api/harness/sessions', () => {
        it('should create a session for an allowed tool with a task', async () => {
            const res = await request(app)
                .post('/api/harness/sessions')
                .send({ tool: 'gemini', task: 'refactor code', contextDir: '/tmp' });

            expect(res.statusCode).toEqual(201);
            expect(res.body).toHaveProperty('session');
            expect(res.body.session.tool).toBe('gemini');
            expect(res.body.session.task).toBe('refactor code');
            expect(res.body.session.state).toBe('created');
            expect(res.body.session.mode).toBe('coding');
            expect(res.body.session.id).toBeDefined();
        });

        it('should return 400 if tool is missing', async () => {
            const res = await request(app)
                .post('/api/harness/sessions')
                .send({ task: 'refactor code' });
            expect(res.statusCode).toEqual(400);
            expect(res.body).toEqual({ error: 'Tool and task are required' });
        });

        it('should return 400 if task is missing', async () => {
            const res = await request(app)
                .post('/api/harness/sessions')
                .send({ tool: 'gemini' });
            expect(res.statusCode).toEqual(400);
            expect(res.body).toEqual({ error: 'Tool and task are required' });
        });

        it('should return 400 if tool is not allowed', async () => {
            const res = await request(app)
                .post('/api/harness/sessions')
                .send({ tool: 'unsupported', task: 'refactor code' });
            expect(res.statusCode).toEqual(400);
            expect(res.body).toEqual({ error: 'Unsupported CLI tool. Allowed tools: gemini, opencode, codex, cursor' });
        });

        it('should accept optional mode and timeBudgetMs', async () => {
            const res = await request(app)
                .post('/api/harness/sessions')
                .send({ tool: 'gemini', task: 'build app', contextDir: '/tmp', mode: 'initializer', timeBudgetMs: 120000 });

            expect(res.statusCode).toEqual(201);
            expect(res.body.session.mode).toBe('initializer');
            expect(res.body.session.timeBudgetMs).toBe(120000);
        });

        it('should reject codex session creation when not authenticated', async () => {
            spawnSync
                .mockReturnValueOnce({ status: 0, stdout: '/opt/homebrew/bin/codex\n', stderr: '' })
                .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not logged in' });

            const res = await request(app)
                .post('/api/harness/sessions')
                .send({ tool: 'codex', task: 'build app', contextDir: '/tmp' });

            expect(res.statusCode).toEqual(400);
            expect(res.body.error).toContain('not authenticated');
        });
    });

    describe('GET /api/harness/sessions', () => {
        it('should list all sessions', async () => {
            // Create a session first
            await request(app)
                .post('/api/harness/sessions')
                .send({ tool: 'gemini', task: 'test task', contextDir: '/tmp' });

            const res = await request(app).get('/api/harness/sessions');
            expect(res.statusCode).toEqual(200);
            expect(res.body).toHaveProperty('sessions');
            expect(Array.isArray(res.body.sessions)).toBe(true);
        });
    });

    describe('GET /api/harness/sessions/:id', () => {
        it('should return 404 for unknown session', async () => {
            const res = await request(app).get('/api/harness/sessions/nonexistent');
            expect(res.statusCode).toEqual(404);
            expect(res.body).toEqual({ error: 'Session not found' });
        });

        it('should return session details', async () => {
            const createRes = await request(app)
                .post('/api/harness/sessions')
                .send({ tool: 'gemini', task: 'test task', contextDir: '/tmp' });
            const sessionId = createRes.body.session.id;

            const res = await request(app).get(`/api/harness/sessions/${sessionId}`);
            expect(res.statusCode).toEqual(200);
            expect(res.body.session.id).toBe(sessionId);
            expect(res.body.session.tool).toBe('gemini');
        });
    });
});
