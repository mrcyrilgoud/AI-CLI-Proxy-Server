const fs = require('fs');
const path = require('path');
const ContextEngine = require('./ContextEngine');

describe('ContextEngine', () => {
    const testDir = path.join('/tmp', `context-test-${Date.now()}`);

    beforeAll(() => {
        fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(testDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(testDir, 'src', 'index.js'), 'console.log("hi")');
        fs.writeFileSync(path.join(testDir, 'README.md'), '# Test Project');
    });

    afterAll(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('should detect Node.js project type', async () => {
        const engine = new ContextEngine(testDir);
        const context = await engine.assemble();
        expect(context.projectType).toBeDefined();
        expect(context.projectType.type).toBe('Node.js / JavaScript');
        expect(context.projectType.indicator).toBe('package.json');
    });

    it('should scan directory structure', async () => {
        const engine = new ContextEngine(testDir);
        const context = await engine.assemble();
        expect(context.directoryTree).toBeDefined();
        expect(context.directoryTree).toContain('package.json');
    });

    it('should include working directory', async () => {
        const engine = new ContextEngine(testDir);
        const context = await engine.assemble();
        expect(context.workingDirectory).toBe(testDir);
    });

    it('should include session info when provided', async () => {
        const engine = new ContextEngine(testDir);
        const mockSession = { id: 's-1', mode: 'coding', task: 'test task', tool: 'gemini' };
        const context = await engine.assemble(mockSession);
        expect(context.session).toEqual(mockSession);
    });

    it('should format context for injection', async () => {
        const engine = new ContextEngine(testDir);
        const context = await engine.assemble();
        const text = engine.formatForInjection(context);

        expect(text).toContain('=== HARNESS CONTEXT ===');
        expect(text).toContain('=== END HARNESS CONTEXT ===');
        expect(text).toContain(testDir);
        expect(text).toContain('Node.js / JavaScript');
    });
});
