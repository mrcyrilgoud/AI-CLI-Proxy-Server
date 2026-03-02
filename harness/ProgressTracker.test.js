const fs = require('fs');
const path = require('path');
const ProgressTracker = require('./ProgressTracker');

describe('ProgressTracker', () => {
    const testDir = path.join('/tmp', `harness-test-${Date.now()}`);
    let tracker;

    beforeEach(() => {
        fs.mkdirSync(testDir, { recursive: true });
        tracker = new ProgressTracker(testDir);
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    describe('Progress Log', () => {
        it('should add and retrieve progress entries', () => {
            tracker.addProgress({
                sessionId: 'sess-1',
                summary: 'Implemented login page',
                tool: 'gemini',
                filesModified: ['src/login.js'],
            });

            const log = tracker.getProgress();
            expect(log).toHaveLength(1);
            expect(log[0].sessionId).toBe('sess-1');
            expect(log[0].summary).toBe('Implemented login page');
            expect(log[0].filesModified).toEqual(['src/login.js']);
        });

        it('should append multiple entries', () => {
            tracker.addProgress({ sessionId: 's1', summary: 'First' });
            tracker.addProgress({ sessionId: 's2', summary: 'Second' });

            expect(tracker.getProgress()).toHaveLength(2);
        });

        it('should generate a progress summary', () => {
            tracker.addProgress({ sessionId: 's1', summary: 'Built the thing' });
            const summary = tracker.getProgressSummary();
            expect(summary).toContain('Built the thing');
            expect(summary).toContain('1 of 1 entries');
        });

        it('should return "No prior progress" for empty log', () => {
            expect(tracker.getProgressSummary()).toBe('No prior progress recorded.');
        });
    });

    describe('Feature List', () => {
        it('should initialize features', () => {
            tracker.initFeatures([
                { description: 'Login works', category: 'functional' },
                { description: 'Style looks good', category: 'visual' },
            ]);

            const features = tracker.getFeatures();
            expect(features).toHaveLength(2);
            expect(features[0].id).toBe(1);
            expect(features[0].passes).toBe(false);
            expect(features[1].category).toBe('visual');
        });

        it('should update feature status', () => {
            tracker.initFeatures([{ description: 'Feature A' }]);
            tracker.updateFeatureStatus(1, true);

            const features = tracker.getFeatures();
            expect(features[0].passes).toBe(true);
            expect(features[0].updatedAt).toBeDefined();
        });

        it('should throw for unknown feature ID', () => {
            tracker.initFeatures([{ description: 'Feature A' }]);
            expect(() => tracker.updateFeatureStatus(999, true)).toThrow('Feature not found');
        });

        it('should generate feature summary', () => {
            tracker.initFeatures([
                { description: 'Feature A' },
                { description: 'Feature B' },
            ]);
            tracker.updateFeatureStatus(1, true);

            const summary = tracker.getFeatureSummary();
            expect(summary).toContain('1/2 passing');
            expect(summary).toContain('1 remaining');
            expect(summary).toContain('Feature B');
        });

        it('should report all passing', () => {
            tracker.initFeatures([{ description: 'Only feature' }]);
            tracker.updateFeatureStatus(1, true);

            const summary = tracker.getFeatureSummary();
            expect(summary).toContain('All features passing');
        });
    });

    describe('Git Integration', () => {
        it('should return git summary or fallback', () => {
            // testDir is not a git repo, so should get fallback
            const summary = tracker.getGitSummary();
            expect(summary).toContain('Not a git repository');
        });
    });
});
