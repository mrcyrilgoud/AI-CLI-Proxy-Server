const fs = require('fs');
const path = require('path');

/**
 * TraceLogger — Structured observability for harness sessions.
 *
 * Logs events as JSONL (one JSON object per line) to:
 *   <contextDir>/.harness/traces/<sessionId>.jsonl
 *
 * Uses an in-memory buffer with periodic flush to reduce I/O.
 *
 * Event types:
 *   session_start, session_end, context_injected, tool_output,
 *   middleware_triggered, loop_detected, verification_requested,
 *   time_warning, error
 */
class TraceLogger {
    /**
     * @param {string} contextDir - Project working directory
     * @param {string} sessionId - Session identifier
     * @param {object} [options]
     * @param {number} [options.flushIntervalMs=5000] - Buffer flush interval
     * @param {number} [options.maxBufferSize=50] - Max events to buffer before force flush
     */
    constructor(contextDir, sessionId, options = {}) {
        this.contextDir = contextDir;
        this.sessionId = sessionId;
        this.flushIntervalMs = options.flushIntervalMs ?? 5000;
        this.maxBufferSize = options.maxBufferSize ?? 50;
        this.autoFlush = options.autoFlush !== false; // default true

        this.tracesDir = path.join(contextDir, '.harness', 'traces');
        this.traceFile = path.join(this.tracesDir, `${sessionId}.jsonl`);
        this.buffer = [];
        this.flushTimer = null;
        this.eventCount = 0;

        this._ensureDir();
        if (this.autoFlush) {
            this._startFlushTimer();
        }
    }

    /**
     * Log a trace event.
     * @param {string} event - Event type
     * @param {object} [data={}] - Event payload
     */
    log(event, data = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            sessionId: this.sessionId,
            seq: ++this.eventCount,
            event,
            data,
        };

        this.buffer.push(entry);

        if (this.buffer.length >= this.maxBufferSize) {
            this.flush();
        }
    }

    // ---- Convenience Methods ----

    sessionStart(session) {
        this.log('session_start', {
            tool: session.tool,
            task: session.task,
            mode: session.mode,
            contextDir: session.contextDir,
        });
    }

    sessionEnd(session) {
        this.log('session_end', {
            state: session.state,
            summary: session.summary,
            error: session.error,
        });
    }

    contextInjected(contextSummary) {
        this.log('context_injected', {
            lengthChars: contextSummary.length,
            preview: contextSummary.substring(0, 200),
        });
    }

    toolOutput(chunk) {
        this.log('tool_output', {
            lengthChars: chunk.length,
            preview: chunk.substring(0, 300),
        });
    }

    middlewareTriggered(middlewareName, details = {}) {
        this.log('middleware_triggered', {
            middleware: middlewareName,
            ...details,
        });
    }

    loopDetected(details) {
        this.log('loop_detected', details);
    }

    verificationRequested(reason) {
        this.log('verification_requested', { reason });
    }

    timeWarning(elapsedMs, budgetMs, message) {
        this.log('time_warning', { elapsedMs, budgetMs, message });
    }

    error(message, err = null) {
        this.log('error', {
            message,
            stack: err?.stack || null,
        });
    }

    // ---- Buffer Management ----

    /**
     * Flush the in-memory buffer to disk.
     */
    flush() {
        if (this.buffer.length === 0) return;

        try {
            const lines = this.buffer.map(e => JSON.stringify(e)).join('\n') + '\n';
            fs.appendFileSync(this.traceFile, lines);
            this.buffer = [];
        } catch (err) {
            console.error('[TraceLogger] Flush error:', err.message);
        }
    }

    /**
     * Stop the flush timer and flush remaining events. 
     * Call this when the session ends.
     */
    close() {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        this.flush();
    }

    /**
     * Read the full trace log for this session.
     * @returns {object[]}
     */
    getTrace() {
        // Include buffered events not yet flushed
        const buffered = [...this.buffer];

        try {
            if (!fs.existsSync(this.traceFile)) return buffered;

            const content = fs.readFileSync(this.traceFile, 'utf8').trim();
            if (!content) return buffered;

            const persisted = content.split('\n').map(line => {
                try { return JSON.parse(line); } catch { return null; }
            }).filter(Boolean);

            return [...persisted, ...buffered];
        } catch {
            return buffered;
        }
    }

    /**
     * Get a summary of the trace for API responses.
     * @returns {object}
     */
    getSummary() {
        const trace = this.getTrace();
        const eventCounts = {};
        for (const entry of trace) {
            eventCounts[entry.event] = (eventCounts[entry.event] || 0) + 1;
        }

        return {
            sessionId: this.sessionId,
            totalEvents: trace.length,
            eventCounts,
            firstEvent: trace[0]?.timestamp || null,
            lastEvent: trace[trace.length - 1]?.timestamp || null,
        };
    }

    // ---- Internal ----

    _ensureDir() {
        if (!fs.existsSync(this.tracesDir)) {
            fs.mkdirSync(this.tracesDir, { recursive: true });
        }
    }

    _startFlushTimer() {
        this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
        // Don't prevent process exit
        if (this.flushTimer.unref) {
            this.flushTimer.unref();
        }
    }
}

module.exports = TraceLogger;
