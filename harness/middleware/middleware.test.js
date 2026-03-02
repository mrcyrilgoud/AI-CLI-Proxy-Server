const MiddlewareRunner = require('./runner');
const createLoopDetectionMiddleware = require('./loopDetection');
const createTimeBudgetMiddleware = require('./timeBudget');
const createPreCompletionMiddleware = require('./preCompletion');

describe('MiddlewareRunner', () => {
    it('should register and list middleware', () => {
        const runner = new MiddlewareRunner();
        runner.use({ name: 'test', events: ['pty:output'], handler: async () => { } });
        expect(runner.list()).toEqual(['test']);
    });

    it('should run matching middleware in order', async () => {
        const runner = new MiddlewareRunner();
        const calls = [];

        runner.use({
            name: 'first',
            events: ['pty:output'],
            handler: async ({ data }) => {
                calls.push('first');
                return { data: data + '-first' };
            },
        });
        runner.use({
            name: 'second',
            events: ['pty:output'],
            handler: async ({ data }) => {
                calls.push('second');
                return { data: data + '-second' };
            },
        });
        runner.use({
            name: 'other-event',
            events: ['session:start'],
            handler: async () => {
                calls.push('should-not-run');
            },
        });

        const result = await runner.run('pty:output', {
            data: 'hello',
            session: {},
            context: null,
            inject: () => { },
            trace: null,
        });

        expect(result.data).toBe('hello-first-second');
        expect(calls).toEqual(['first', 'second']);
    });

    it('should support suppress', async () => {
        const runner = new MiddlewareRunner();
        runner.use({
            name: 'blocker',
            events: ['pty:output'],
            handler: async () => ({ suppress: true }),
        });
        runner.use({
            name: 'after',
            events: ['pty:output'],
            handler: async () => ({ data: 'should not reach' }),
        });

        const result = await runner.run('pty:output', {
            data: 'test',
            session: {},
            context: null,
            inject: () => { },
            trace: null,
        });

        expect(result.suppress).toBe(true);
    });

    it('should handle middleware errors gracefully', async () => {
        const runner = new MiddlewareRunner();
        runner.use({
            name: 'broken',
            events: ['pty:output'],
            handler: async () => { throw new Error('boom'); },
        });
        runner.use({
            name: 'after',
            events: ['pty:output'],
            handler: async ({ data }) => ({ data: data + '-ok' }),
        });

        const result = await runner.run('pty:output', {
            data: 'test',
            session: {},
            context: null,
            inject: () => { },
            trace: null,
        });

        // Should continue despite error
        expect(result.data).toBe('test-ok');
    });
});

describe('LoopDetectionMiddleware', () => {
    it('should inject nudge after threshold repetitions', async () => {
        const injected = [];
        const mw = createLoopDetectionMiddleware({ threshold: 3, cooldownMs: 0 });

        const ctx = {
            inject: (text) => injected.push(text),
            trace: null,
            session: {},
            context: null,
        };

        // Send the same data 3 times (threshold)
        const repeatedData = 'Error: file not found at /some/path/that/is/long/enough/to/hash';
        for (let i = 0; i < 3; i++) {
            await mw.handler({ ...ctx, data: repeatedData });
        }

        expect(injected.length).toBe(1);
        expect(injected[0]).toContain('reconsidering your strategy');
    });

    it('should not fire for short output', async () => {
        const injected = [];
        const mw = createLoopDetectionMiddleware({ threshold: 2, cooldownMs: 0 });

        for (let i = 0; i < 5; i++) {
            await mw.handler({
                data: 'short',
                inject: (text) => injected.push(text),
                trace: null,
            });
        }

        expect(injected.length).toBe(0);
    });
});

describe('TimeBudgetMiddleware', () => {
    it('should inject warning at 50% elapsed', async () => {
        const injected = [];
        const mw = createTimeBudgetMiddleware({ checkInterval: 1 });

        const startTime = new Date(Date.now() - 35000).toISOString(); // 35s ago
        const session = { startedAt: startTime, timeBudgetMs: 60000 }; // 1min budget, ~58% elapsed

        await mw.handler({
            data: 'some output',
            session,
            inject: (text) => injected.push(text),
            trace: null,
        });

        expect(injected.length).toBe(1);
        expect(injected[0]).toContain('half');
    });

    it('should not fire without time budget', async () => {
        const injected = [];
        const mw = createTimeBudgetMiddleware({ checkInterval: 1 });

        await mw.handler({
            data: 'output',
            session: { startedAt: new Date().toISOString() },
            inject: (text) => injected.push(text),
            trace: null,
        });

        expect(injected.length).toBe(0);
    });
});

describe('PreCompletionMiddleware', () => {
    it('should nudge when completion detected without verification', async () => {
        const injected = [];
        const mw = createPreCompletionMiddleware();

        await mw.handler({
            data: 'Task is complete, all changes have been applied.',
            inject: (text) => injected.push(text),
            trace: null,
        });

        expect(injected.length).toBe(1);
        expect(injected[0]).toContain('verify your changes');
    });

    it('should not nudge if verification was seen', async () => {
        const injected = [];
        const mw = createPreCompletionMiddleware();

        // First, observe a test run
        await mw.handler({
            data: 'npm test\n5 tests passed',
            inject: (text) => injected.push(text),
            trace: null,
        });

        // Then completion
        await mw.handler({
            data: 'Task is complete.',
            inject: (text) => injected.push(text),
            trace: null,
        });

        expect(injected.length).toBe(0);
    });
});
