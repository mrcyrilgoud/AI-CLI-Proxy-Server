const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('child_process', () => ({
    spawn: jest.fn(),
    spawnSync: jest.fn(() => ({ status: 0 })),
}));

const { spawn, spawnSync } = require('child_process');
const { handleHarnessInit } = require('./harness-api');

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

    beforeEach(() => {
        jest.clearAllMocks();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-api-test-'));
    });

    afterEach(() => {
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
        spawnSync.mockReturnValueOnce({ status: 1 });

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
});
