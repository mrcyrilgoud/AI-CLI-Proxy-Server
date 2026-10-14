const express = require('express');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { installInferenceApi } = require('./inference-api');
const { localAccess, isLoopbackOrigin } = require('./local-access');
const { ProgressTracker, TraceLogger } = require('./harness');
const {
    getUnsupportedToolMessage,
    isSupportedTool,
} = require('./cli-tools');
const { sessionManager, setupWebSocket } = require('./harness-api');

const app = express();
const PORT = process.env.PORT || 3333;

app.use(localAccess);
app.use(cors({ origin: (origin, callback) => callback(null, isLoopbackOrigin(origin)) }));
app.use(express.json());

installInferenceApi(app);

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


if (require.main === module) {
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`AI CLI Proxy Server running at http://localhost:${PORT}`);
        console.log(`WebSocket Harness available at ws://localhost:${PORT}/api/harness/stream`);
    });
}

app.server = server;
module.exports = app;
