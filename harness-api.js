const WebSocket = require('ws');
const { spawn, spawnSync } = require('child_process');
const { SessionManager, ProgressTracker, TraceLogger, MiddlewareRunner } = require('./harness');
const createContextInjectionMiddleware = require('./harness/middleware/contextInjection');
const createLoopDetectionMiddleware = require('./harness/middleware/loopDetection');
const createPreCompletionMiddleware = require('./harness/middleware/preCompletion');
const createTimeBudgetMiddleware = require('./harness/middleware/timeBudget');
const { buildHarnessArgs, getUnsupportedToolMessage, isSupportedTool } = require('./cli-tools');

const sessionManager = new SessionManager();

const DEBUG_TASK = 'spawn_debug_test';
const DEBUG_SCRIPT = `
const task = process.argv[1];
const lines = [
  'Harness test output for: ' + task,
  'progress: 1',
  'progress: 2',
  'progress: 3'
];
let index = 0;
const timer = setInterval(() => {
  if (index >= lines.length) {
    clearInterval(timer);
    process.exit(0);
    return;
  }

  process.stdout.write(lines[index] + '\\n');
  index += 1;
}, 40);

process.stdin.resume();
process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(0);
});
`;

function setupWebSocket(httpServer) {
    const wss = new WebSocket.Server({ server: httpServer, path: '/api/harness/stream' });

    wss.on('connection', (ws) => {
        if (process.env.NODE_ENV !== 'test') {
            console.log('Client connected to harness stream');
        }

        let activeSession = null;
        let ptyProcess = null;
        let traceLogger = null;
        let closed = false;

        ws.on('message', async (rawMessage) => {
            try {
                const payload = JSON.parse(rawMessage.toString());

                if (payload.action === 'init') {
                    const result = await handleHarnessInit(ws, payload);
                    activeSession = result.session;
                    ptyProcess = result.ptyProcess;
                    traceLogger = result.trace;
                    return;
                }

                if (payload.action === 'input') {
                    if (!ptyProcess) {
                        ws.send(JSON.stringify({ type: 'error', error: 'Cannot send input before initialization payload' }));
                        return;
                    }

                    ptyProcess.write(payload.data || '');
                    return;
                }

                if (payload.action === 'stop') {
                    if (!ptyProcess || !activeSession) {
                        ws.send(JSON.stringify({ type: 'error', error: 'Unknown action or invalid state' }));
                        return;
                    }

                    ptyProcess.kill();
                    sessionManager.complete(activeSession.id, 'Stopped by user');
                    ws.send(JSON.stringify({ type: 'stopped', sessionId: activeSession.id }));
                    return;
                }

                ws.send(JSON.stringify({ type: 'error', error: 'Unknown action or invalid state' }));
            } catch (error) {
                if (!ptyProcess) {
                    ws.send(JSON.stringify({ type: 'error', error: error.message }));
                    return;
                }

                ptyProcess.write(rawMessage.toString());
            }
        });

        ws.on('close', () => {
            closed = true;

            if (activeSession) {
                const currentSession = sessionManager.get(activeSession.id);
                if (currentSession && currentSession.state === 'running') {
                    sessionManager.complete(activeSession.id, 'Session ended by client disconnect');
                }
            }

            if (traceLogger && typeof traceLogger.close === 'function') {
                try {
                    traceLogger.sessionEnd(sessionManager.get(activeSession.id) || { state: 'unknown' });
                    traceLogger.close();
                } catch {
                    // best effort
                }
            }

            if (ptyProcess) {
                ptyProcess.kill();
                ptyProcess = null;
            }

            if (process.env.NODE_ENV !== 'test') {
                console.log('Client disconnected from harness stream');
            }
        });

        ws.on('error', (error) => {
            if (closed) {
                return;
            }

            console.error('[Harness WSS] Connection error:', error);
        });
    });

    wss.on('error', (error) => {
        console.error('[Harness WSS] WebSocket server error:', error);
    });

    return wss;
}

async function handleHarnessInit(ws, payload) {
    const { tool, task, contextDir, sessionId, mode, timeBudgetMs } = payload;

    if (!tool || !task) {
        throw new Error('Tool and task are required for initialization');
    }

    if (!isSupportedTool(tool)) {
        throw new Error(getUnsupportedToolMessage());
    }

    if (typeof task !== 'string') {
        throw new Error('Task must be a string');
    }

    const safeContextDir = typeof contextDir === 'string' ? contextDir : process.cwd();
    let session = sessionId ? sessionManager.get(sessionId) : null;

    if (sessionId && !session) {
        throw new Error(`Session not found: ${sessionId}`);
    }

    if (!session) {
        session = sessionManager.create({
            tool,
            task,
            contextDir: safeContextDir,
            mode: mode || 'coding',
            timeBudgetMs: timeBudgetMs != null ? timeBudgetMs : null,
        });
    }

    if (session.state !== 'created') {
        throw new Error(`Session is in state: ${session.state}`);
    }

    session = sessionManager.start(session.id);

    const trace = new TraceLogger(safeContextDir, session.id);
    trace.sessionStart(session);

    const runner = createMiddlewareRunner(session);
    const ptyProcess = spawnHarnessProcess({ tool, task, cwd: safeContextDir, ws, sessionId: session.id });
    const contextResult = await runner.run('session:start', {
        data: null,
        session,
        context: null,
        inject: (text) => ptyProcess.write(text),
        trace,
    });

    ws.send(JSON.stringify({
        type: 'session',
        session: {
            id: session.id,
            mode: session.mode,
            state: session.state,
            middleware: runner.list(),
        },
    }));

    ptyProcess.onData((data) => {
        trace.toolOutput(data);

        runner.run('pty:output', {
            data,
            session: sessionManager.get(session.id),
            context: contextResult.data,
            inject: (text) => ptyProcess.write(text),
            trace,
        }).then(({ data: processedData, suppress }) => {
            if (!suppress && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'output', data: processedData }));
            }
        }).catch((error) => {
            console.error('[MiddlewareRunner] Error inside pty:output chain:', error);
        });
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
        finalizeSession({ exitCode, signal, ptyProcess, runner, session, trace, ws, contextDir: safeContextDir, task, tool });
    });

    return { ptyProcess, session, trace };
}

function createMiddlewareRunner(session) {
    const runner = new MiddlewareRunner();
    runner.use(createContextInjectionMiddleware());
    runner.use(createLoopDetectionMiddleware({
        threshold: 5,
        windowSize: 20,
    }));
    runner.use(createPreCompletionMiddleware());

    if (session.mode === 'planning') {
        runner.use(createTimeBudgetMiddleware({
            timeLimitMs: 120000,
            thresholds: [
                { percent: 50, message: 'Half time used' },
                { percent: 80, message: 'Time warning' },
            ],
        }));
    } else {
        runner.use(createTimeBudgetMiddleware());
    }

    return runner;
}

function spawnHarnessProcess({ tool, task, cwd, ws, sessionId }) {
    if (task === DEBUG_TASK) {
        return createProcessAdapter(spawn(process.execPath, ['-e', DEBUG_SCRIPT, task], {
            cwd,
            env: { ...process.env, FORCE_COLOR: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
        }));
    }

    const args = buildHarnessArgs(tool, task);
    const hasTool = spawnSync('which', [tool], { stdio: 'ignore' }).status === 0;
    const command = hasTool ? tool : 'npx';
    const commandArgs = hasTool ? args : ['--yes', tool, ...args];

    if (!hasTool && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'output',
            data: `\x1b[90m[harness] Tool '${tool}' not found globally. Trying via npx...\x1b[0m\r\n`,
        }));
    }

    if (process.env.NODE_ENV !== 'test') {
        console.log(`[Harness WSS] Spawning session ${sessionId}: ${command} ${commandArgs.join(' ')}`);
    }

    return createProcessAdapter(spawn(command, commandArgs, {
        cwd,
        env: { ...process.env, FORCE_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
    }));
}

function createProcessAdapter(childProcess) {
    const dataHandlers = [];
    const exitHandlers = [];

    const emitData = (chunk) => {
        const data = chunk.toString();
        for (const handler of dataHandlers) {
            handler(data);
        }
    };

    childProcess.stdout.on('data', emitData);
    childProcess.stderr.on('data', emitData);
    childProcess.on('exit', (code, signal) => {
        for (const handler of exitHandlers) {
            handler({ exitCode: code, signal });
        }
    });

    if (childProcess.stdin && typeof childProcess.stdin.on === 'function') {
        childProcess.stdin.on('error', (error) => {
            if (error && error.code !== 'EPIPE') {
                console.error('[Harness WSS] stdin error:', error.message);
            }
        });
    }

    return {
        write(data) {
            if (!childProcess.stdin || childProcess.stdin.destroyed || childProcess.stdin.writableEnded || !childProcess.stdin.writable) {
                return;
            }

            try {
                childProcess.stdin.write(data);
            } catch {
                // Ignore writes after exit.
            }
        },
        onData(handler) {
            dataHandlers.push(handler);
        },
        onExit(handler) {
            exitHandlers.push(handler);
        },
        kill() {
            childProcess.kill();
        },
    };
}

function finalizeSession({ exitCode, signal, runner, session, trace, ws, contextDir, task, tool }) {
    runner.run('session:exit', {
        data: { exitCode, signal },
        session: sessionManager.get(session.id),
        context: null,
        inject: () => { },
        trace,
    }).catch((error) => {
        console.error('[MiddlewareRunner] Error inside session:exit chain:', error);
    });

    const currentSession = sessionManager.get(session.id);
    if (currentSession && currentSession.state === 'running') {
        if (exitCode === 0 || exitCode === null) {
            sessionManager.complete(session.id, 'Task finished successfully.');
        } else {
            sessionManager.fail(session.id, `Exited with code ${exitCode}`);
        }
    }

    try {
        const tracker = new ProgressTracker(contextDir);
        const finishedSession = sessionManager.get(session.id);
        tracker.addProgress({
            sessionId: session.id,
            tool,
            summary: buildProgressSummary({ exitCode, task, finishedSession }),
        });
    } catch {
        // best effort
    }

    trace.sessionEnd(sessionManager.get(session.id));
    trace.close();

    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code: exitCode, sessionId: session.id }));
    }
}

function buildProgressSummary({ exitCode, task, finishedSession }) {
    const state = finishedSession?.state || (exitCode === 0 ? 'completed' : 'failed');
    const suffix = exitCode === null ? 'terminated' : `exit code ${exitCode}`;
    return `Session ${state} (${suffix}). Task: ${task}`;
}

module.exports = {
    handleHarnessInit,
    sessionManager,
    setupWebSocket,
};
