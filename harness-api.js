const WebSocket = require('ws');
const { spawn, spawnSync } = require('child_process');
const { SessionManager, ProgressTracker, ContextEngine, TraceLogger, MiddlewareRunner } = require('./harness');
const createContextInjectionMiddleware = require('./harness/middleware/contextInjection');
const createLoopDetectionMiddleware = require('./harness/middleware/loopDetection');
const createPreCompletionMiddleware = require('./harness/middleware/preCompletion');
const createTimeBudgetMiddleware = require('./harness/middleware/timeBudget');

// Shared SessionManager instance
const sessionManager = new SessionManager();

let wss; // Declare wss here so it can be assigned by setupWebSocket

const ALLOWED_TOOLS = ['gemini', 'opencode', 'codex', 'cursor'];

/**
 * Sets up the WebSocket Server for the harness stream.
 * @param {http.Server} httpServer The HTTP server instance to attach the WebSocket server to.
 */
function setupWebSocket(httpServer) {
    wss = new WebSocket.Server({ server: httpServer, path: '/api/harness/stream' });

    wss.on('connection', (ws) => {
        console.log('Client connected to harness stream');
        let ptyProcess = null;
        let activeSession = null;
        let traceLogger = null;
        let middlewareRunner = null;

        ws.on('message', (message) => {
            try {
                // Check if the message is a JSON initialization payload
                const payload = JSON.parse(message.toString());

                if (payload.action === 'init') {
                    // Guard against double-init: kill any existing PTY first
                    if (ptyProcess) {
                        console.warn('[Harness WSS] Re-init requested, killing existing PTY process');
                        ptyProcess.kill();
                        ptyProcess = null;
                        if (traceLogger) { traceLogger.close(); traceLogger = null; }
                    }

                    handleHarnessInit(ws, payload).then(result => {
                        ptyProcess = result.ptyProcess;
                        activeSession = result.session;
                        traceLogger = result.trace;
                        middlewareRunner = result.middlewareRunner;
                    }).catch(err => {
                        console.error('[Harness WSS] Init error:', err);
                        ws.send(JSON.stringify({ type: 'error', error: err.message }));
                    });
                } else if (payload.action === 'stop') {
                    // Stop the running session
                    const targetSessionId = activeSession?.id || payload.sessionId;

                    if (ptyProcess) {
                        console.log('[Harness WSS] Stop requested, killing PTY process');
                        ptyProcess.kill();
                        ptyProcess = null;
                    }
                    if (targetSessionId) {
                        try {
                            sessionManager.complete(targetSessionId, 'Stopped by user');
                        } catch (err) {
                            console.error('[Harness WSS] Failed to complete session:', err.message);
                        }
                        if (traceLogger) {
                            traceLogger.log('session_stopped', { reason: 'user_request' });
                            traceLogger.close();
                            traceLogger = null;
                        }
                    }
                    ws.send(JSON.stringify({ type: 'stopped', sessionId: targetSessionId }));
                    activeSession = null;
                }
            } catch (e) {
                // If the message is not JSON, assume it is raw stdin string data meant for the active PTY process
                if (ptyProcess) {
                    // Run input through middleware pipeline
                    if (middlewareRunner && activeSession) {
                        middlewareRunner.run('pty:input', {
                            data: message.toString(),
                            session: activeSession,
                            context: null,
                            inject: (text) => ptyProcess.write(text),
                            trace: traceLogger,
                        }).then(({ data: processedData, suppress }) => {
                            if (!suppress) {
                                ptyProcess.write(processedData);
                            }
                        });
                    } else {
                        ptyProcess.write(message.toString());
                    }
                } else {
                    ws.send(JSON.stringify({ error: 'Cannot send input before initialization payload' }));
                }
            }
        });

        ws.on('close', () => {
            console.log('Client disconnected from harness stream');
            if (activeSession) {
                // Get fresh session state (activeSession is a snapshot from init time)
                const currentSession = sessionManager.get(activeSession.id);
                try {
                    if (currentSession && currentSession.state === 'running') {
                        sessionManager.complete(activeSession.id, 'Session ended by client disconnect');
                    }
                } catch { /* ignore */ }

                if (traceLogger) {
                    traceLogger.sessionEnd(sessionManager.get(activeSession.id) || { state: 'unknown' });
                    traceLogger.close();
                }
            }
            if (ptyProcess) {
                ptyProcess.kill();
            }
        });
    });

    // Handle WebSocket server errors
    wss.on('error', (error) => {
        console.error('[Harness WSS] WebSocket server error:', error);
    });
}

/**
 * Handle the harness init action — wires up the full harness pipeline.
 * @param {WebSocket} ws
 * @param {object} payload — { tool, task, contextDir, sessionId?, mode?, timeBudgetMs? }
 * @returns {Promise<{ptyProcess, session, trace, middlewareRunner}>}
 */
async function handleHarnessInit(ws, payload) {
    const { tool, task, contextDir, sessionId, mode, timeBudgetMs } = payload;

    if (!tool || !task) {
        throw new Error('Tool and task are required for initialization');
    }

    if (!ALLOWED_TOOLS.includes(tool)) {
        throw new Error(`Unsupported CLI tool. Allowed tools: ${ALLOWED_TOOLS.join(', ')}`);
    }

    if (typeof task !== 'string') {
        throw new Error('Task must be a string');
    }

    const safeContextDir = typeof contextDir === 'string' ? contextDir : process.cwd();

    // 1. Create or resume session
    let session;
    if (sessionId) {
        session = sessionManager.get(sessionId);
        if (!session) {
            throw new Error(`Session not found: ${sessionId}`);
        }
    } else {
        session = sessionManager.create({
            tool,
            task,
            contextDir: safeContextDir,
            mode: mode || 'coding',
            timeBudgetMs: timeBudgetMs != null ? timeBudgetMs : null,
        });
    }

    // 2. Start the session
    session = sessionManager.start(session.id);

    // 3. Initialize trace logger
    const trace = new TraceLogger(safeContextDir, session.id);
    trace.sessionStart(session);

    // 4. Set up middleware pipeline
    const runner = new MiddlewareRunner();
    runner.use(createContextInjectionMiddleware());
    runner.use(createLoopDetectionMiddleware());
    runner.use(createPreCompletionMiddleware());
    runner.use(createTimeBudgetMiddleware());

    // 5. Send session info to the client
    ws.send(JSON.stringify({
        type: 'session',
        session: {
            id: session.id,
            mode: session.mode,
            state: session.state,
            middleware: runner.list(),
        },
    }));

    // 6. Build harness args and resolve PTY command
    const args = buildHarnessArgs(tool, task);
    console.log(`[Harness WSS] Preparing to spawn PTY for session ${session.id}: ${tool} in ${safeContextDir} with args:`, args);

    // Always use 'bash' to spawn to avoid node-pty posix_spawnp crashes
    // on macOS when dealing with non-binary scripts (like gemini or npx).
    const hasTool = spawnSync('which', [tool]).status === 0;
    const escapedArgs = args.map(a => '"' + a.replace(/"/g, '\"') + '"').join(' ');

    let commandLine = '';

    if (hasTool) {
        commandLine = `${tool} ${escapedArgs}`;
    } else {
        console.log(`[Harness WSS] Tool '${tool}' not found in PATH. Falling back to npx...`);
        ws.send(JSON.stringify({ type: 'output', data: `\x1b[90m[harness] Tool '${tool}' not found globally. Trying via npx...\x1b[0m\r\n` }));
        commandLine = `npx --yes ${tool} ${escapedArgs}`;
    }

    let ptyProcess;
    try {
        // Fallback to native child_process.spawn due to node-pty posix_spawnp ABI crash on Node v25+ macOS
        const cp = spawn('bash', ['-c', commandLine], {
            cwd: safeContextDir,
            env: { ...process.env, FORCE_COLOR: '1' },
        });

        // Mock node-pty interface to maintain middleware pipeline compatibility
        ptyProcess = {
            write: (data) => cp.stdin.write(data),
            onData: (cb) => {
                cp.stdout.on('data', d => cb(d.toString()));
                cp.stderr.on('data', d => cb(d.toString()));
            },
            onExit: (cb) => {
                cp.on('exit', (code, signal) => {
                    console.log(`[Harness WSS - PTY Mock] Child process exited with code ${code}, signal ${signal}`);
                    cb({ exitCode: code, signal });
                });
            },
            kill: () => cp.kill()
        };
    } catch (err) {
        // Init failed (e.g. bash not found), mark session failed so it doesn't get stuck running
        sessionManager.fail(session.id, err.message);
        trace.log('spawn_error', { error: err.message });
        trace.close();
        throw err;
    }

    // 7. Run session:start middleware (context injection, etc.)
    const contextResult = await runner.run('session:start', {
        data: null,
        session,
        context: null,
        inject: (text) => ptyProcess.write(text),
        trace,
    });

    // 8. Pipe PTY output through middleware pipeline back to WebSocket
    ptyProcess.onData((data) => {
        // Log raw output
        trace.toolOutput(data);

        // Run pty:output middleware (loop detection, pre-completion, time budget)
        runner.run('pty:output', {
            data,
            session: sessionManager.get(session.id), // Get fresh session state for time tracking
            context: contextResult.data,
            inject: (text) => ptyProcess.write(text),
            trace,
        }).then(({ data: processedData, suppress }) => {
            if ((!suppress) && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'output', data: processedData }));
            }
        });
    });

    // 9. Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`[Harness WSS] PTY process exited with code ${exitCode} (session ${session.id})`);

        // Run session:exit middleware
        runner.run('session:exit', {
            data: { exitCode, signal },
            session: sessionManager.get(session.id),
            context: null,
            inject: () => { }, // Can't inject after exit
            trace,
        });

        // Update session state
        if (exitCode === 0) {
            sessionManager.complete(session.id, `Completed with exit code ${exitCode}`);
        } else {
            sessionManager.fail(session.id, `Exited with code ${exitCode}`);
        }

        // Record progress
        try {
            const tracker = new ProgressTracker(safeContextDir);
            tracker.addProgress({
                sessionId: session.id,
                tool,
                summary: `Session ended (exit code: ${exitCode}). Task: ${task}`,
            });
        } catch { /* best effort */ }

        // Finalize trace
        trace.sessionEnd(sessionManager.get(session.id));
        trace.close();

        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'exit', code: exitCode, sessionId: session.id }));
            ws.close();
        }
    });

    return { ptyProcess, session, trace, middlewareRunner: runner };
}

// ===== Helper Functions =====

function buildHarnessArgs(tool, task) {
    switch (tool) {
        case 'gemini':
            if (task === 'spawn_debug_test') {
                return ['echo', 'Harness test output for:', task];
            }
            return [task, '--yolo'];
        case 'opencode':
            return ['run-task', task, '--yes'];
        case 'codex':
            return ['--harness', task, '--autonomous'];
        case 'cursor':
            return ['--task', task, '--auto-confirm'];
        default:
            return [task];
    }
}

module.exports = { setupWebSocket, sessionManager, SessionManager };
