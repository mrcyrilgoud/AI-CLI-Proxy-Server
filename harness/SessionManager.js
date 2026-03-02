const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * SessionManager — Manages harness session lifecycle.
 * 
 * Sessions represent a single invocation of a CLI tool within the harness.
 * They track state, tool, task, and link to progress/trace artifacts.
 * 
 * States: created → running → paused → completed | failed
 * Modes: 'initializer' (first-run setup) | 'coding' (incremental progress)
 */
class SessionManager {
    constructor() {
        /** @type {Map<string, object>} */
        this.sessions = new Map();
    }

    /**
     * Create a new harness session.
     * @param {object} opts
     * @param {string} opts.tool - CLI tool name (gemini, codex, etc.)
     * @param {string} opts.task - Task description
     * @param {string} opts.contextDir - Working directory for the session
     * @param {'initializer'|'coding'} [opts.mode='coding'] - Session mode
     * @param {number} [opts.timeBudgetMs] - Optional time budget in milliseconds
     * @returns {object} The created session object
     */
    create({ tool, task, contextDir, mode = 'coding', timeBudgetMs = null }) {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        const session = {
            id,
            tool,
            task,
            contextDir: contextDir || process.cwd(),
            mode,
            state: 'created',
            timeBudgetMs,
            startedAt: null,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
            summary: null,
            error: null,
        };

        this.sessions.set(id, session);
        this._persistToDisk(session);
        return { ...session };
    }

    /**
     * Transition a session to 'running' state.
     * @param {string} id
     * @returns {object} Updated session
     */
    start(id) {
        return this._transition(id, 'running', {
            startedAt: new Date().toISOString(),
        });
    }

    /**
     * Transition a session to 'paused' state.
     * @param {string} id
     * @returns {object} Updated session
     */
    pause(id) {
        return this._transition(id, 'paused');
    }

    /**
     * Transition a session to 'completed' state.
     * @param {string} id
     * @param {string} [summary] - Optional completion summary
     * @returns {object} Updated session
     */
    complete(id, summary = null) {
        return this._transition(id, 'completed', {
            completedAt: new Date().toISOString(),
            summary,
        });
    }

    /**
     * Transition a session to 'failed' state.
     * @param {string} id
     * @param {string} [error] - Error description
     * @returns {object} Updated session
     */
    fail(id, error = null) {
        return this._transition(id, 'failed', {
            completedAt: new Date().toISOString(),
            error,
        });
    }

    /**
     * Get a session by ID.
     * @param {string} id
     * @returns {object|null}
     */
    get(id) {
        const session = this.sessions.get(id);
        return session ? { ...session } : null;
    }

    /**
     * List all sessions, optionally filtered by state.
     * @param {object} [filter]
     * @param {string} [filter.state] - Filter by state
     * @param {string} [filter.contextDir] - Filter by context directory
     * @returns {object[]}
     */
    list(filter = {}) {
        let results = Array.from(this.sessions.values());

        if (filter.state) {
            results = results.filter(s => s.state === filter.state);
        }
        if (filter.contextDir) {
            results = results.filter(s => s.contextDir === filter.contextDir);
        }

        return results
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .map(s => ({ ...s }));
    }

    /**
     * Resume a session from a previous run by loading state from disk.
     * @param {string} contextDir - The project directory to look for session history
     * @returns {object|null} The most recent session, or null
     */
    resume(contextDir) {
        const sessionsFile = path.join(contextDir, '.harness', 'sessions.json');
        if (!fs.existsSync(sessionsFile)) return null;

        try {
            const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
            const sessions = Array.isArray(data) ? data : [];

            // Load all sessions into memory
            for (const session of sessions) {
                if (!this.sessions.has(session.id)) {
                    this.sessions.set(session.id, session);
                }
            }

            // Return the most recent session
            const sorted = sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            return sorted.length > 0 ? { ...sorted[0] } : null;
        } catch (err) {
            console.error(`[SessionManager] Failed to load sessions from ${sessionsFile}:`, err.message);
            return null;
        }
    }

    /**
     * Get elapsed time for a running session in milliseconds.
     * @param {string} id
     * @returns {number|null}
     */
    getElapsedMs(id) {
        const session = this.sessions.get(id);
        if (!session || !session.startedAt) return null;
        return Date.now() - new Date(session.startedAt).getTime();
    }

    // --- Internal ---

    _transition(id, newState, extra = {}) {
        const session = this.sessions.get(id);
        if (!session) {
            throw new Error(`Session not found: ${id}`);
        }

        session.state = newState;
        session.updatedAt = new Date().toISOString();
        Object.assign(session, extra);

        this._persistToDisk(session);
        return { ...session };
    }

    _persistToDisk(session) {
        try {
            const harnessDir = path.join(session.contextDir, '.harness');
            if (!fs.existsSync(harnessDir)) {
                fs.mkdirSync(harnessDir, { recursive: true });
            }

            const sessionsFile = path.join(harnessDir, 'sessions.json');
            let existing = [];
            if (fs.existsSync(sessionsFile)) {
                try {
                    existing = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
                } catch { /* start fresh */ }
            }

            const idx = existing.findIndex(s => s.id === session.id);
            if (idx >= 0) {
                existing[idx] = session;
            } else {
                existing.push(session);
            }

            fs.writeFileSync(sessionsFile, JSON.stringify(existing, null, 2));
        } catch (err) {
            console.error('[SessionManager] Persistence error:', err.message);
        }
    }
}

module.exports = SessionManager;
