const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * ProgressTracker — Multi-session persistence layer.
 *
 * Manages two key artifacts per project:
 *   - progress.json: chronological log of session accomplishments
 *   - features.json: feature checklist with pass/fail status
 *
 * Inspired by Anthropic's claude-progress.txt and feature_list.json pattern,
 * but using JSON for both (models are less likely to inappropriately modify JSON).
 */
class ProgressTracker {
    /**
     * @param {string} contextDir - The project working directory
     */
    constructor(contextDir) {
        this.contextDir = contextDir;
        this.harnessDir = path.join(contextDir, '.harness');
        this.progressFile = path.join(this.harnessDir, 'progress.json');
        this.featuresFile = path.join(this.harnessDir, 'features.json');
    }

    /**
     * Ensure the .harness directory exists.
     */
    _ensureDir() {
        if (!fs.existsSync(this.harnessDir)) {
            fs.mkdirSync(this.harnessDir, { recursive: true });
        }
    }

    // ---- Progress Log ----

    /**
     * Add a progress entry for a session.
     * @param {object} entry
     * @param {string} entry.sessionId
     * @param {string} entry.summary - What was accomplished
     * @param {string[]} [entry.filesModified] - List of files changed
     * @param {string} [entry.tool] - Tool used
     */
    addProgress(entry) {
        this._ensureDir();
        const log = this._readJSON(this.progressFile, []);

        log.push({
            timestamp: new Date().toISOString(),
            sessionId: entry.sessionId,
            tool: entry.tool || null,
            summary: entry.summary,
            filesModified: entry.filesModified || [],
        });

        this._writeJSON(this.progressFile, log);
    }

    /**
     * Get the full progress log.
     * @returns {object[]}
     */
    getProgress() {
        return this._readJSON(this.progressFile, []);
    }

    /**
     * Get a text summary of recent progress for context injection.
     * @param {number} [count=5] - Number of recent entries to include
     * @returns {string}
     */
    getProgressSummary(count = 5) {
        const log = this.getProgress();
        if (log.length === 0) return 'No prior progress recorded.';

        const recent = log.slice(-count);
        const lines = recent.map((e, i) => {
            const files = e.filesModified.length > 0
                ? ` (files: ${e.filesModified.join(', ')})`
                : '';
            return `${i + 1}. [${e.timestamp}] ${e.summary}${files}`;
        });

        return `Recent progress (${recent.length} of ${log.length} entries):\n${lines.join('\n')}`;
    }

    // ---- Feature List ----

    /**
     * Initialize the feature list from a task description.
     * Called during initializer sessions.
     * @param {object[]} features - Array of feature specs
     * @param {string} features[].description
     * @param {string} [features[].category='functional']
     * @param {string[]} [features[].steps]
     */
    initFeatures(features) {
        this._ensureDir();
        const featureList = features.map((f, i) => ({
            id: i + 1,
            category: f.category || 'functional',
            description: f.description,
            steps: f.steps || [],
            passes: false,
            updatedAt: null,
        }));

        this._writeJSON(this.featuresFile, featureList);
    }

    /**
     * Get the full feature list.
     * @returns {object[]}
     */
    getFeatures() {
        return this._readJSON(this.featuresFile, []);
    }

    /**
     * Update the pass/fail status of a feature.
     * @param {number} featureId
     * @param {boolean} passes
     */
    updateFeatureStatus(featureId, passes) {
        const features = this.getFeatures();
        const feature = features.find(f => f.id === featureId);
        if (!feature) {
            throw new Error(`Feature not found: ${featureId}`);
        }

        feature.passes = passes;
        feature.updatedAt = new Date().toISOString();
        this._writeJSON(this.featuresFile, features);
    }

    /**
     * Get a summary of feature completion for context injection.
     * @returns {string}
     */
    getFeatureSummary() {
        const features = this.getFeatures();
        if (features.length === 0) return 'No feature list defined.';

        const passing = features.filter(f => f.passes).length;
        const failing = features.filter(f => !f.passes).length;

        const nextTodo = features.find(f => !f.passes);
        const nextLine = nextTodo
            ? `\nNext feature to implement: [#${nextTodo.id}] ${nextTodo.description}`
            : '\nAll features passing!';

        return `Features: ${passing}/${features.length} passing, ${failing} remaining.${nextLine}`;
    }

    // ---- Git Integration ----

    /**
     * Get recent git log for context injection.
     * @param {number} [count=20]
     * @returns {string}
     */
    getGitSummary(count = 20) {
        try {
            const log = execFileSync('git', ['log', '--oneline', `-${count}`], {
                cwd: this.contextDir,
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();

            return log || 'No git history found.';
        } catch {
            return 'Not a git repository or git not available.';
        }
    }

    /**
     * Auto-commit progress artifacts to git.
     * @param {string} message
     */
    commitProgress(message) {
        try {
            execFileSync('git', ['add', '.harness/'], { cwd: this.contextDir, timeout: 5000 });
            execFileSync('git', ['commit', '-m', message, '--allow-empty'], {
                cwd: this.contextDir,
                encoding: 'utf8',
                timeout: 10000,
            });
        } catch (err) {
            console.error('[ProgressTracker] Git commit failed:', err.message);
        }
    }

    // ---- Internal ----

    _readJSON(filePath, fallback) {
        try {
            if (!fs.existsSync(filePath)) return fallback;
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            return fallback;
        }
    }

    _writeJSON(filePath, data) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }
}

module.exports = ProgressTracker;
