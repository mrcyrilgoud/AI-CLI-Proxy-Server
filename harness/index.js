/**
 * Harness Module — Barrel export.
 *
 * Provides the full agent harness toolkit:
 *   - SessionManager: session lifecycle management
 *   - ProgressTracker: multi-session persistence
 *   - ContextEngine: environment auto-discovery
 *   - TraceLogger: structured event logging
 *   - MiddlewareRunner: composable middleware pipeline
 */

const SessionManager = require('./SessionManager');
const ProgressTracker = require('./ProgressTracker');
const ContextEngine = require('./ContextEngine');
const TraceLogger = require('./TraceLogger');
const MiddlewareRunner = require('./middleware/runner');

module.exports = {
    SessionManager,
    ProgressTracker,
    ContextEngine,
    TraceLogger,
    MiddlewareRunner,
};
