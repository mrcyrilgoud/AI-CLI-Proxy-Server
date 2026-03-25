const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('child_process', () => ({
    execFile: jest.fn((command, args, options, callback) => callback(null, '/usr/bin/codex\n', '')),
    spawn: jest.fn(),
}));

const { execFile, spawn } = require('child_process');
const { handleHarnessInit, resetToolResolutionCache } = require('./harness-api');

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

describe('harness-api', () => {
    let tempDir;
    let nowSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        resetToolResolutionCache();
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-api-test-'));
    });

    afterEach(() => {
        nowSpy.mockRestore();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('spawns Codex harness sessions with direct argv execution', async () => {
        const child = createChildProcessMock();
        spawn.mockReturnValueOnce(child);

        const ws = {
            readyState: 1,
            send: jest.fn(),
        };

        const result = await handleHarnessInit(ws, {
            tool: 'codex',
            task: 'build feature',
            contextDir: tempDir,
        });

        expect(spawn).toHaveBeenCalledWith(
            'codex',
            ['build feature', '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'],
            expect.objectContaining({
                cwd: tempDir,
                stdio: ['pipe', 'pipe', 'pipe'],
            })
        );
        expect(result.ptyProcess).toBeDefined();
    });

    it('falls back to npx when Codex is not installed', async () => {
        const child = createChildProcessMock();
        spawn.mockReturnValueOnce(child);
        execFile.mockImplementationOnce((command, args, options, callback) => callback(new Error('not found')));

        const ws = {
            readyState: 1,
            send: jest.fn(),
        };

        await handleHarnessInit(ws, {
            tool: 'codex',
            task: 'build feature',
            contextDir: tempDir,
        });

        expect(spawn).toHaveBeenCalledWith(
            'npx',
            ['--yes', 'codex', 'build feature', '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'],
            expect.any(Object)
        );
        expect(ws.send).toHaveBeenCalledWith(expect.stringContaining("Tool 'codex' not found globally"));
    });

    it('reuses cached tool resolution across harness sessions', async () => {
        const firstChild = createChildProcessMock();
        const secondChild = createChildProcessMock();
        spawn
            .mockReturnValueOnce(firstChild)
            .mockReturnValueOnce(secondChild);

        const ws = {
            readyState: 1,
            send: jest.fn(),
        };

        await handleHarnessInit(ws, {
            tool: 'codex',
            task: 'first task',
            contextDir: tempDir,
        });

        await handleHarnessInit(ws, {
            tool: 'codex',
            task: 'second task',
            contextDir: tempDir,
        });

        expect(execFile).toHaveBeenCalledTimes(1);
    });

    it('revalidates cached tool resolution after the ttl expires', async () => {
        const firstChild = createChildProcessMock();
        const secondChild = createChildProcessMock();
        spawn
            .mockReturnValueOnce(firstChild)
            .mockReturnValueOnce(secondChild);

        const ws = {
            readyState: 1,
            send: jest.fn(),
        };

        await handleHarnessInit(ws, {
            tool: 'codex',
            task: 'first task',
            contextDir: tempDir,
        });

        nowSpy.mockReturnValue(31000);

        await handleHarnessInit(ws, {
            tool: 'codex',
            task: 'second task',
            contextDir: tempDir,
        });

        expect(execFile).toHaveBeenCalledTimes(2);
    });
});
