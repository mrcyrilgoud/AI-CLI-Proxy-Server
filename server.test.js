const request = require('supertest');
const { execFile } = require('child_process');
const app = require('./server'); // Assuming your server.js exports the app

// Mock child_process.execFile
jest.mock('child_process', () => ({
    execFile: jest.fn(),
}));

describe('AI CLI Proxy Server', () => {
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
    });

    describe('POST /api/harness', () => {
        it('should execute the command for an allowed tool with a task', async () => {
            execFile.mockImplementationOnce((command, args, options, callback) => {
                callback(null, 'Harness output', null);
            });

            const res = await request(app)
                .post('/api/harness')
                .send({ tool: 'gemini', task: 'refactor code' });

            expect(res.statusCode).toEqual(200);
            expect(res.body).toEqual({ response: 'Harness output' });
            expect(execFile).toHaveBeenCalledWith('gemini', ['refactor code', '--yolo'], expect.any(Object), expect.any(Function));
        });

        it('should return 400 if tool is missing', async () => {
            const res = await request(app)
                .post('/api/harness')
                .send({ task: 'refactor code' });
            expect(res.statusCode).toEqual(400);
            expect(res.body).toEqual({ error: 'Tool and task are required' });
        });

        it('should return 400 if task is missing', async () => {
            const res = await request(app)
                .post('/api/harness')
                .send({ tool: 'gemini' });
            expect(res.statusCode).toEqual(400);
            expect(res.body).toEqual({ error: 'Tool and task are required' });
        });

        it('should return 400 if tool is not allowed', async () => {
            const res = await request(app)
                .post('/api/harness')
                .send({ tool: 'unsupported', task: 'refactor code' });
            expect(res.statusCode).toEqual(400);
            expect(res.body).toEqual({ error: 'Unsupported CLI tool. Allowed tools: gemini, opencode, codex, cursor' });
        });

        it('should execute the command with contextDir', async () => {
            execFile.mockImplementationOnce((command, args, options, callback) => {
                expect(options.cwd).toEqual('/test/dir');
                callback(null, 'Harness output with contextDir', null);
            });

            const res = await request(app)
                .post('/api/harness')
                .send({ tool: 'gemini', task: 'refactor code', contextDir: '/test/dir' });

            expect(res.statusCode).toEqual(200);
            expect(res.body).toEqual({ response: 'Harness output with contextDir' });
            expect(execFile).toHaveBeenCalledWith('gemini', ['refactor code', '--yolo'], expect.any(Object), expect.any(Function));
        });

        it('should handle command execution error for harness', async () => {
            execFile.mockImplementationOnce((command, args, options, callback) => {
                callback(new Error('Harness command failed'), null, 'Harness error details on stderr');
            });

            const res = await request(app)
                .post('/api/harness')
                .send({ tool: 'gemini', task: 'refactor code' });

            expect(res.statusCode).toEqual(500);
            expect(res.body).toEqual({
                error: 'Command Execution Failed',
                details: 'Harness command failed',
                stderr: 'Harness error details on stderr'
            });
        });

        it('should return stderr as response if stdout is empty for harness', async () => {
            execFile.mockImplementationOnce((command, args, options, callback) => {
                callback(null, '', 'Harness warning on stderr');
            });

            const res = await request(app)
                .post('/api/harness')
                .send({ tool: 'gemini', task: 'refactor code' });

            expect(res.statusCode).toEqual(200);
            expect(res.body).toEqual({ response: 'Harness warning on stderr' });
        });
    });
});
