const express = require('express');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { ProgressTracker, TraceLogger } = require('./harness');
const {
    buildLowLevelArgs,
    extractCodexMessage,
    getToolsResponse,
    getUnsupportedToolMessage,
    isSupportedTool,
    normalizeToolResponse,
} = require('./cli-tools');
const { sessionManager, setupWebSocket } = require('./harness-api');

const app = express();
const PORT = process.env.PORT || 3333;

app.use(cors());
app.use(express.json());

app.get('/api/tools', (req, res) => {
    res.json(getToolsResponse());
});

app.post('/api/low-level', (req, res) => {
    const { tool, prompt, files = [] } = req.body;

    if (!tool || !prompt) {
        return res.status(400).json({ error: 'Tool and prompt are required' });
    }

    if (!isSupportedTool(tool)) {
        return res.status(400).json({ error: getUnsupportedToolMessage() });
    }

    if (typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Prompt must be a string' });
    }

    const cleanFiles = Array.isArray(files) ? files.filter((file) => typeof file === 'string') : [];
    const args = buildLowLevelArgs(tool, prompt, cleanFiles);
    const execOptions = { maxBuffer: 1024 * 1024 * 5, timeout: 120000 };

    console.log(`[Low-Level] Executing tool: ${tool} with args:`, args);
    execFile(tool, args, execOptions, (error, stdout, stderr) => handleCallback(res, tool, error, stdout, stderr));
});

app.post('/api/low-level-stream', (req, res) => {
    const { tool, prompt, files = [] } = req.body;

    if (!tool || !prompt) {
        return res.status(400).json({ error: 'Tool and prompt are required' });
    }

    if (!isSupportedTool(tool)) {
        return res.status(400).json({ error: getUnsupportedToolMessage() });
    }

    if (typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Prompt must be a string' });
    }

    const cleanFiles = Array.isArray(files) ? files.filter((file) => typeof file === 'string') : [];
    const args = buildLowLevelArgs(tool, prompt, cleanFiles);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const child = spawn(tool, args, {
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let streamedResponse = '';
    let codexBuffer = '';
    let streamFinished = false;

    const sendEvent = (payload) => {
        if (!streamFinished) {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
    };

    const finish = () => {
        if (streamFinished) {
            return;
        }

        streamFinished = true;
        res.end();
    };

    req.on('close', () => {
        if (!streamFinished) {
            child.kill();
        }
    });

    if (tool === 'codex') {
        child.stdout.on('data', (chunk) => {
            codexBuffer += chunk.toString();
            const lines = codexBuffer.split('\n');
            codexBuffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }

                stdout += `${line}\n`;
                const nextMessage = extractCodexMessage(line);
                if (nextMessage) {
                    streamedResponse = nextMessage;
                    sendEvent({ response: streamedResponse });
                }
            }
        });
    } else {
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
            streamedResponse = stdout.trim();
            if (streamedResponse) {
                sendEvent({ response: streamedResponse });
            }
        });
    }

    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    child.on('error', (error) => {
        sendEvent({ error: error.message });
        finish();
    });

    child.on('close', (code) => {
        if (tool === 'codex' && codexBuffer.trim()) {
            const finalMessage = extractCodexMessage(codexBuffer);
            if (finalMessage) {
                streamedResponse = finalMessage;
                sendEvent({ response: streamedResponse });
            }
        }

        if (streamFinished) {
            return;
        }

        if (code !== 0) {
            sendEvent({ error: stderr.trim() || `Command exited with code ${code}` });
            finish();
            return;
        }

        if (!streamedResponse) {
            const fallback = normalizeToolResponse(tool, stdout, stderr);
            if (fallback) {
                sendEvent({ response: fallback });
            }
        }

        finish();
    });
});

app.post('/api/harness/sessions', (req, res) => {
    const { tool, task, contextDir, mode = 'coding', timeBudgetMs } = req.body;

    if (!tool || !task) {
        return res.status(400).json({ error: 'Tool and task are required' });
    }

    if (!isSupportedTool(tool)) {
        return res.status(400).json({ error: getUnsupportedToolMessage() });
    }

    if (typeof task !== 'string') {
        return res.status(400).json({ error: 'Task must be a string' });
    }

    const session = sessionManager.create({
        tool,
        task,
        contextDir: typeof contextDir === 'string' ? contextDir : process.cwd(),
        mode,
        timeBudgetMs,
    });

    res.status(201).json({ session });
});

app.get('/api/harness/sessions/:id', (req, res) => {
    const session = sessionManager.get(req.params.id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    let traceSummary = null;
    try {
        const traceFile = path.join(session.contextDir || process.cwd(), '.harness', 'traces', `${session.id}.jsonl`);
        if (fs.existsSync(traceFile)) {
            const trace = new TraceLogger(session.contextDir || process.cwd(), session.id);
            traceSummary = trace.getSummary();
        }
    } catch {
        // best effort
    }

    let progress = null;
    try {
        const tracker = new ProgressTracker(session.contextDir || process.cwd());
        progress = {
            gitSummary: tracker.getGitSummary(),
            progressSummary: tracker.getProgressSummary(),
            featureSummary: tracker.getFeatureSummary(),
        };
    } catch {
        // best effort
    }

    res.json({ session, traceSummary, progress });
});

app.get('/api/harness/sessions', (req, res) => {
    const filter = {};
    if (typeof req.query.state === 'string' && req.query.state) {
        filter.state = req.query.state;
    }
    if (typeof req.query.contextDir === 'string' && req.query.contextDir) {
        filter.contextDir = req.query.contextDir;
    }

    res.json({ sessions: sessionManager.list(filter) });
});

const server = http.createServer(app);
setupWebSocket(server);

function handleCallback(res, tool, error, stdout, stderr) {
    if (error) {
        console.error(`Error executing command: ${error.message}`);
        return res.status(500).json({
            error: 'Command Execution Failed',
            details: error.message,
            stderr,
        });
    }

    const response = normalizeToolResponse(tool, stdout, stderr);
    if (response) {
        return res.json({ response });
    }

    return res.json({ response: '' });
}

if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`AI CLI Proxy Server running at http://localhost:${PORT}`);
        console.log(`WebSocket Harness available at ws://localhost:${PORT}/api/harness/stream`);
    });
}

app.server = server;
module.exports = app;
