const express = require('express');
const cors = require('cors');
const { exec, execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3333;

app.use(cors());
app.use(express.json());

const ALLOWED_TOOLS = ['gemini', 'opencode', 'codex', 'cursor'];

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

    // Ensure prompt is a string and files is an array of strings
    if (typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Prompt must be a string' });
    }
    const cleanFiles = Array.isArray(files) ? files.filter(f => typeof f === 'string') : [];

    // Map prompts and files to appropriate CLI arguments
    const args = buildLowLevelArgs(tool, prompt, cleanFiles);

    // Standard execution limit for low-level (e.g., 2 mins)
    const execOptions = { maxBuffer: 1024 * 1024 * 5, timeout: 120000 };

    console.log(`[Low-Level] Executing tool: ${tool} with args:`, args);
    execFile(tool, args, execOptions, (error, stdout, stderr) => handleCallback(res, error, stdout, stderr));
});

app.post('/api/harness', (req, res) => {
    const { tool, task, contextDir } = req.body;

    if (!tool || !task) {
        return res.status(400).json({ error: 'Tool and task are required' });
    }

    if (!ALLOWED_TOOLS.includes(tool)) {
        return res.status(400).json({ error: `Unsupported CLI tool. Allowed tools: ${ALLOWED_TOOLS.join(', ')}` });
    }

    // Ensure task and contextDir are strings
    if (typeof task !== 'string') {
        return res.status(400).json({ error: 'Task must be a string' });
    }
    const safeContextDir = typeof contextDir === 'string' ? contextDir : process.cwd();

    // Map tasks to auto-approving / agentic optimized CLI arguments
    const args = buildHarnessArgs(tool, task);

    // High level harness needs a longer timeout for autonomous execution (e.g., 10 mins)
    const execOptions = {
        maxBuffer: 1024 * 1024 * 10, // 10MB buffer
        timeout: 600000,
        cwd: safeContextDir // Allow isolated workspace context
    };

    console.log(`[Harness] Executing tool: ${tool} in ${execOptions.cwd} with args:`, args);
    execFile(tool, args, execOptions, (error, stdout, stderr) => handleCallback(res, error, stdout, stderr));
});

// Helper for generic response handling
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

// Argument Mapping Helpers
function buildLowLevelArgs(tool, prompt, files) {
    switch (tool) {
        case 'gemini':
            // E.g. gemini prompt "Explain this code" --files utils.js main.js
            return ['prompt', prompt].concat(files.length > 0 ? ['--files', ...files] : []);
        case 'opencode':
            // Hypothetical opencode format
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
            // Example: gemini "Refactor everything" --yolo for auto-approval
            return [task, '--yolo'];
        case 'opencode':
            // Hypothetical opencode format
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
    app.listen(PORT, () => {
        console.log(`AI CLI Proxy Server running at http://localhost:${PORT}`);
        console.log(`Ready to execute commands for the frontend.`);
    });
}

module.exports = app;
