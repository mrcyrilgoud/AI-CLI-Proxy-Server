const SessionManager = require('./SessionManager');

describe('SessionManager', () => {
    let sm;

    beforeEach(() => {
        sm = new SessionManager();
        // Override persistence to avoid writing to disk during tests
        sm._persistToDisk = jest.fn();
    });

    describe('create()', () => {
        it('should create a session with required fields', () => {
            const session = sm.create({
                tool: 'gemini',
                task: 'refactor code',
                contextDir: '/tmp/test',
            });

            expect(session.id).toBeDefined();
            expect(session.tool).toBe('gemini');
            expect(session.task).toBe('refactor code');
            expect(session.contextDir).toBe('/tmp/test');
            expect(session.mode).toBe('coding');
            expect(session.state).toBe('created');
            expect(session.startedAt).toBeNull();
            expect(session.createdAt).toBeDefined();
        });

        it('should accept optional mode and timeBudgetMs', () => {
            const session = sm.create({
                tool: 'codex',
                task: 'build feature',
                contextDir: '/tmp/test',
                mode: 'initializer',
                timeBudgetMs: 60000,
            });

            expect(session.mode).toBe('initializer');
            expect(session.timeBudgetMs).toBe(60000);
        });

        it('should generate unique IDs', () => {
            const s1 = sm.create({ tool: 'gemini', task: 'a', contextDir: '/tmp' });
            const s2 = sm.create({ tool: 'gemini', task: 'b', contextDir: '/tmp' });
            expect(s1.id).not.toBe(s2.id);
        });
    });

    describe('state transitions', () => {
        it('should transition through lifecycle states', () => {
            const session = sm.create({ tool: 'gemini', task: 'test', contextDir: '/tmp' });

            const started = sm.start(session.id);
            expect(started.state).toBe('running');
            expect(started.startedAt).toBeDefined();

            const paused = sm.pause(session.id);
            expect(paused.state).toBe('paused');

            const completed = sm.complete(session.id, 'All done');
            expect(completed.state).toBe('completed');
            expect(completed.summary).toBe('All done');
            expect(completed.completedAt).toBeDefined();
        });

        it('should handle fail transition', () => {
            const session = sm.create({ tool: 'gemini', task: 'test', contextDir: '/tmp' });
            sm.start(session.id);

            const failed = sm.fail(session.id, 'Something broke');
            expect(failed.state).toBe('failed');
            expect(failed.error).toBe('Something broke');
        });

        it('should throw for unknown session ID', () => {
            expect(() => sm.start('nonexistent')).toThrow('Session not found');
        });
    });

    describe('get() and list()', () => {
        it('should get a session by ID', () => {
            const session = sm.create({ tool: 'gemini', task: 'test', contextDir: '/tmp' });
            const fetched = sm.get(session.id);
            expect(fetched).toEqual(session);
        });

        it('should return null for unknown ID', () => {
            expect(sm.get('unknown')).toBeNull();
        });

        it('should list all sessions', () => {
            sm.create({ tool: 'gemini', task: 'a', contextDir: '/tmp' });
            sm.create({ tool: 'codex', task: 'b', contextDir: '/tmp' });
            expect(sm.list()).toHaveLength(2);
        });

        it('should filter by state', () => {
            const s1 = sm.create({ tool: 'gemini', task: 'a', contextDir: '/tmp' });
            sm.create({ tool: 'codex', task: 'b', contextDir: '/tmp' });
            sm.start(s1.id);

            expect(sm.list({ state: 'running' })).toHaveLength(1);
            expect(sm.list({ state: 'created' })).toHaveLength(1);
        });

        it('should filter by contextDir', () => {
            sm.create({ tool: 'gemini', task: 'a', contextDir: '/tmp/a' });
            sm.create({ tool: 'codex', task: 'b', contextDir: '/tmp/b' });

            expect(sm.list({ contextDir: '/tmp/a' })).toHaveLength(1);
        });
    });

    describe('getElapsedMs()', () => {
        it('should return elapsed time for running session', () => {
            const session = sm.create({ tool: 'gemini', task: 'test', contextDir: '/tmp' });
            sm.start(session.id);
            const elapsed = sm.getElapsedMs(session.id);
            expect(elapsed).toBeGreaterThanOrEqual(0);
        });

        it('should return null for unstarted session', () => {
            const session = sm.create({ tool: 'gemini', task: 'test', contextDir: '/tmp' });
            expect(sm.getElapsedMs(session.id)).toBeNull();
        });
    });

    describe('returns copies', () => {
        it('should return copies, not references', () => {
            const session = sm.create({ tool: 'gemini', task: 'test', contextDir: '/tmp' });
            const fetched = sm.get(session.id);
            fetched.task = 'MODIFIED';
            expect(sm.get(session.id).task).toBe('test');
        });
    });
});
