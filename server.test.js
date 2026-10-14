const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const app = require('./server');

jest.mock('child_process', () => ({
    execFile: jest.fn(),
    spawn: jest.fn(),
    spawnSync: jest.fn(() => ({ status: 0 })),
}));


describe('AI CLI Proxy Server', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/tools', () => {
        it('returns Codex-first tool metadata', async () => {
            const res = await request(app).get('/api/tools');

            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({
                defaultTool: 'codex',
                tools: ['codex', 'gemini', 'opencode', 'cursor', 'claude', 'kiro'],
            });
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
