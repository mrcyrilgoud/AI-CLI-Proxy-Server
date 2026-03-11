const express = require('express');
const cors = require('cors');
const { execFile, spawn, spawnSync } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

// Harness modules
const { SessionManager, ProgressTracker, ContextEngine, TraceLogger, MiddlewareRunner } = require('./harness');
const createContextInjectionMiddleware = require('./harness/middleware/contextInjection');
const createLoopDetectionMiddleware = require('./harness/middleware/loopDetection');
const createPreCompletionMiddleware = require('./harness/middleware/preCompletion');
const createTimeBudgetMiddleware = require('./harness/middleware/timeBudget');

const app = express();
const PORT = process.env.PORT || 3333;

app.use(cors());
app.use(express.json());

const ALLOWED_TOOLS = ['gemini', 'opencode', 'codex', 'cursor'];

// Instantiating the unified session manager
const sessionManager = new SessionManager();

app.get('/api/tools', (req, res) => {
    res.json({ tools: ALLOWED_TOOLS });
});

app.post('/api/low-level', (req, res) => {
    const { tool, prompt, files = [] } = req.body;

    if (!tool || !prompt) {
        return res.status(400).json({ error: 'Tool and prompt are required' });
    }

    if (!ALLOWED_TOOLS.includes(tool)) {
        return res.status(400).json({ error: `Unsupported CLI tool. Allowed tools: ${ALLOWED_TOOLS.join(', ')}` });
    }

    if (typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Prompt must be a string' });
    }
    const cleanFiles = Array.isArray(files) ? files.filter(f => typeof f === 'string') : [];

    const args = buildLowLevelArgs(tool, prompt, cleanFiles);
    const execOptions = { maxBuffer: 1024 * 1024 * 5, timeout: 120000 };

    console.log(`[Low-Level] Executing tool: ${tool} with args:`, args);
    execFile(tool, args, execOptions, (error, stdout, stderr) => handleCallback(res, error, stdout, stderr));
});

// Create a new long-running harness session
app.post('/api/harness/sessions', (req, res) => {
    const { tool, task, contextDir, mode = 'coding', timeBudgetMs } = req.body;

    if (!tool || !task) {
        return res.status(400).json({ error: 'Tool and task are required' });
    }

    if (!ALLOWED_TOOLS.includes(tool)) {
        return res.status(400).json({ error: `Unsupported CLI tool. Allowed tools: ${ALLOWED_TOOLS.join(', ')}` });
    }

    if (typeof task !== 'string') {
        return res.status(400).json({ error: 'Task must be a string' });
    }
    const safeContextDir = typeof contextDir === 'string' ? contextDir : process.cwd();

    // Create session entry
    const session = sessionManager.create({ tool, task, contextDir: safeContextDir, mode, timeBudgetMs });
    console.log(`[Harness] Session created: ${session.id} (${session.mode} mode)`);

    res.status(201).json({ session });
});

// Fetch info for a specific session (useful for UI initial load)
app.get('/api/harness/sessions/:id', (req, res) => {
    const session = sessionManager.get(req.params.id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    // Load trace summary if available
    let traceSummary = null;
    try {
        const trace = new TraceLogger(session.contextDir || process.cwd(), session.id);
        traceSummary = trace.getSummary();
    } catch { /* session might not have traces yet */ }

    // Load progress context 
    let progress = null;
    try {
        const tracker = new ProgressTracker(session.contextDir);
        tracker.addProgress({
            sessionId: session.id,
            mode: session.mode,
            events: []
        });
        progress = {
            gitSummary: tracker.getGitSummary(),
            progressSummary: tracker.getProgressSummary(),
            featureSummary: tracker.getFeatureSummary(),
        };
    } catch { /* no progress */ }

    res.json({ session, traceSummary, progress });
});

// Fetch all active/historical sessions
app.get('/api/harness/sessions', (req, res) => {
    res.json({ sessions: sessionManager.list() });
});

// --- WebSocket Setup for Harness Streams ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/api/harness/stream' });

wss.on('connection', (ws) => {
    console.log('Client connected to harness stream');

    let activeSession = null;
    let trace = null;
    let runner = null;

    ws.on('message', async (message) => {
        try {
            const payload = JSON.parse(message);

            if (payload.action === 'init') {
                const { tool, task, sessionId } = payload;
                if (!tool || !task || !sessionId) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Missing required initialization parameters' }));
                    return;
                }

                activeSession = sessionManager.get(sessionId);
                if (!activeSession) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Session not found' }));
                    return;
                }

                // If session is already running or completed, we probably shouldn't start a new PTY
                if (activeSession.state !== 'created') {
                    ws.send(JSON.stringify({ type: 'error', error: `Session is in state: ${activeSession.state}` }));
                    return;
                }

                trace = new TraceLogger(activeSession.contextDir || process.cwd(), sessionId);
                await handleHarnessInit(ws, activeSession, tool, task, trace);
            } else if (payload.action === 'input' && global.activePtyProcesses && global.activePtyProcesses[payload.sessionId]) {
                const ptyProcess = global.activePtyProcesses[payload.sessionId];
                ptyProcess.write(payload.data);
            } else if (payload.action === 'stop' && payload.sessionId) {
                if (global.activePtyProcesses && global.activePtyProcesses[payload.sessionId]) {
                    console.log(`[Harness WSS] Stop requested, killing PTY process`);
                    global.activePtyProcesses[payload.sessionId].kill();
                    sessionManager.complete(payload.sessionId, 'Session manually stopped by user.');
                    ws.send(JSON.stringify({ type: 'stopped', sessionId: payload.sessionId }));
                }
            } else {
                ws.send(JSON.stringify({ type: 'error', error: 'Unknown action or invalid state' }));
            }
        } catch (error) {
            console.error('[Harness WSS] Error handling message:', error);
            ws.send(JSON.stringify({ type: 'error', error: error.message }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected from harness stream');
        // Clean up trace if open
        if (trace && typeof trace.close === 'function') {
            try { trace.close(); } catch (e) { }
        }
    });

    ws.on('error', (error) => {
        console.error('[Harness WSS] Connection error:', error);
    });
});

if (!global.activePtyProcesses) {
    global.activePtyProcesses = {};
}

// Handler for spawning and piping a harness session
async function handleHarnessInit(ws, session, tool, task, trace) {
    const safeContextDir = session.contextDir || process.cwd();

    // 1. Mark session as running
    sessionManager.start(session.id);
    trace.sessionStart(session);

    // 2. Initialize progress tracker
    const progressTracker = new ProgressTracker(safeContextDir);
    progressTracker.addProgress({
        sessionId: session.id,
        mode: session.mode,
        events: [{ type: 'session_start', timestamp: Date.now() }]
    });

    // 3. Initialize Middleware Pipeline
    const runner = new MiddlewareRunner();
    runner.use(createContextInjectionMiddleware());
    runner.use(createLoopDetectionMiddleware({
        threshold: 5,
        windowSize: 20
    }));
    runner.use(createPreCompletionMiddleware());

    // Only apply strict time budget if in planning mode, roughly 2 mins
    if (session.mode === 'planning') {
        runner.use(createTimeBudgetMiddleware({
            timeLimitMs: 120 * 1000,
            thresholds: [{ percent: 50, message: 'Half time used' }, { percent: 80, message: 'Time warning' }]
        }));
    }

    console.log(`[Harness] Session ${session.id} (${session.mode} mode)`);
    console.log(`[Harness] Middleware: ${runner.list().join(', ')}`);

    // 4. Send session info to the client
    ws.send(JSON.stringify({
        type: 'session',
        session: {
            id: session.id,
            mode: session.mode,
            state: session.state,
            middleware: runner.list(),
        },
    }));

    // 5. Build harness args and resolve command
    const args = buildHarnessArgs(tool, task);
    console.log(`[Harness WSS] Preparing to spawn proxy for session ${session.id}: ${tool} in ${safeContextDir} with args:`, args);

    let commandLine = '';
    const hasTool = spawnSync('which', [tool]).status === 0;
    const escapedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');

    if (hasTool) {
        commandLine = `${tool} ${escapedArgs}`;
    } else {
        console.log(`[Harness WSS] Tool '${tool}' not found in PATH. Falling back to npx...`);
        ws.send(JSON.stringify({ type: 'output', data: `\x1b[90m[harness] Tool '${tool}' not found globally. Trying via npx...\x1b[0m\r\n` }));
        commandLine = `npx --yes ${tool} ${escapedArgs}`;
    }

    // 6. Spawn via native bash pipe and construct synchronous event adapter
    let ptyProcess;
    try {
        const cp = spawn('bash', ['-c', commandLine], {
            cwd: safeContextDir,
            env: { ...process.env, FORCE_COLOR: '1' },
            stdio: ['pipe', 'pipe', 'pipe']
        });
        cp.stdin.on('error', (err) => {
            if (err && err.code !== 'EPIPE') {
                console.error('[Harness WSS] stdin error:', err.message);
            }
        });

        // Eagerly bind handlers so NO streamed output is dropped while async middleware runs
        const dataHandlers = [];
        const exitHandlers = [];

        cp.stdout.on('data', d => dataHandlers.forEach(cb => cb(d.toString())));
        cp.stderr.on('data', d => dataHandlers.forEach(cb => cb(d.toString())));
        cp.on('exit', (code, signal) => exitHandlers.forEach(cb => cb({ exitCode: code, signal })));

        ptyProcess = {
            write: (data) => {
                if (!cp.stdin || cp.stdin.destroyed || cp.stdin.writableEnded || !cp.stdin.writable) {
                    return;
                }
                try {
                    cp.stdin.write(data);
                } catch {
                    // Process already exited; ignore late middleware writes.
                }
            },
            onData: (cb) => dataHandlers.push(cb),
            onExit: (cb) => exitHandlers.push(cb),
            kill: () => cp.kill()
        };

        global.activePtyProcesses[session.id] = ptyProcess;
    } catch (err) {
        sessionManager.fail(session.id, err.message);
        trace.log('spawn_error', { error: err.message });
        trace.close();
        ws.send(JSON.stringify({ type: 'error', error: err.message }));
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

    // 8. Pipe streamed output through middleware pipeline back to WebSocket
    ptyProcess.onData((data) => {
        trace.toolOutput(data);

        runner.run('pty:output', {
            data,
            session: sessionManager.get(session.id),
            context: contextResult.data,
            inject: (text) => ptyProcess.write(text),
            trace,
        }).then(({ data: processedData, suppress }) => {
            if ((!suppress) && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'output', data: processedData }));
            }
        }).catch(err => {
            console.error(`[MiddlewareRunner] Error inside pty:output chain:`, err);
        });
    });

    // 9. Handle native process exit
    ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`[Harness WSS] PTY process exited with code ${exitCode} (session ${session.id})`);

        runner.run('session:exit', {
            data: { exitCode, signal },
            session: sessionManager.get(session.id),
            context: null,
            inject: () => { },
            trace,
        });

        const activeSessionRef = sessionManager.get(session.id);
        if (activeSessionRef && activeSessionRef.state !== 'completed' && activeSessionRef.state !== 'failed') {
            if (exitCode !== 0 && exitCode !== null) {
                // Determine failure threshold
                sessionManager.fail(session.id, `Exited with code ${exitCode}`);
            } else {
                sessionManager.complete(session.id, 'Task finished successfully.');
            }
        }

        trace.sessionEnd(sessionManager.get(session.id));
        trace.close();

        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'exit', code: exitCode, sessionId: session.id }));
        }

        delete global.activePtyProcesses[session.id];
    });
}

// ===== Helper Functions =====

function handleCallback(res, error, stdout, stderr) {
    if (error) {
        console.error(`Error executing command: ${error.message}`);
        return res.status(500).json({
            error: 'Command Execution Failed',
            details: error.message,
            stderr: stderr
        });
    }

    if (stderr && !stdout) {
        console.warn(`Command stderr: ${stderr}`);
        return res.json({ response: stderr.trim() });
    }

    res.json({ response: stdout.trim() });
}

function buildLowLevelArgs(tool, prompt, files) {
    switch (tool) {
        case 'gemini':
            return ['prompt', prompt].concat(files.length > 0 ? ['--files', ...files] : []);
        case 'opencode':
            return ['ask', prompt].concat(files.map(f => `--context=${f}`));
        case 'codex':
            return ['--prompt', prompt, ...files];
        case 'cursor':
            return ['--query', prompt, ...files.map(f => `--file=${f}`)];
        default:
            return [prompt, ...files];
    }
}

function buildHarnessArgs(tool, task) {
    switch (tool) {
        case 'gemini':
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

if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`AI CLI Proxy Server running at http://localhost:${PORT}`);
        console.log(`WebSocket Harness available at ws://localhost:${PORT}/api/harness/stream`);
        console.log(`Ready to execute commands for the frontend.`);
    });
}

// Export app for testing, attaching server for WS tests if needed
app.server = server;
module.exports = app;
