const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { registry, findExecutable } = require('./inference-tools');
const { CredentialStore } = require('./credentials');

const MAX_OUTPUT = 5 * 1024 * 1024;
const TIMEOUT_MS = 120000;

function childEnvironment(tool, credentialStore, source = process.env) {
    const env = {};
    // Do not pass application secrets, CLI session tokens, NODE_OPTIONS or config overrides.
    for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SystemRoot']) {
        if (source[name]) env[name] = source[name];
    }
    Object.assign(env, { FORCE_COLOR: '0', NO_COLOR: '1' });
    if (tool.apiKeyEnv) {
        const secret = credentialStore.get(tool.id);
        if (secret) env[tool.apiKeyEnv] = secret;
    }
    return env;
}

function prepareWorkspace(tool, cwd, env) {
    const writeJson = (relative, value) => {
        const filename = path.join(cwd, relative);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
    };
    if (tool.id === 'opencode') {
        env.XDG_CONFIG_HOME = path.join(cwd, 'config');
        env.OPENCODE_CONFIG_DIR = path.join(cwd, 'config', 'opencode');
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: { '*': 'deny' }, plugin: [], mcp: {} });
        env.OPENCODE_PERMISSION = '{"*":"deny"}';
        env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true';
        env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
    } else if (tool.id === 'gemini') {
        writeJson('.gemini/settings.json', { tools: { core: [], exclude: ['run_shell_command', 'write_file', 'replace'] }, mcp: { allowed: [] }, hooks: { enabled: false }, advanced: { ignoreLocalEnv: true } });
        env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = path.join(cwd, '.gemini/settings.json');
        const policy = path.join(cwd, 'deny-tools.toml');
        fs.writeFileSync(policy, '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n', { mode: 0o600 });
        return ['--admin-policy', policy];
    } else if (tool.id === 'cursor') {
        writeJson('.cursor/cli.json', { permissions: { allow: [], deny: ['Shell(*)', 'Read(*)', 'Write(*)', 'WebFetch(*)', 'Mcp(*:*)'] } });
    } else if (tool.id === 'kiro') {
        writeJson('.kiro/agents/proxy-inference.json', { name: 'proxy-inference', description: 'Text inference without tools', tools: [], allowedTools: [], resources: [], mcpServers: {}, includeMcpJson: false });
    }
    return [];
}

function publicToolDetails(credentialStore, resolveExecutable = findExecutable) {
    return Object.values(registry).map((tool) => {
        let authenticationStatus = 'unknown';
        if (tool.apiKeyEnv) {
            try { if (credentialStore.get(tool.id)) authenticationStatus = 'authenticated'; }
            catch { authenticationStatus = 'unknown'; }
        }
        return {
            id: tool.id, available: Boolean(resolveExecutable(tool.executables)),
            capabilities: { ...tool.capabilities }, streamMode: 'delta',
            authenticationInstructions: tool.authenticationInstructions, authenticationStatus,
        };
    });
}

function installInferenceApi(app, options = {}) {
    const credentialStore = options.credentialStore || new CredentialStore();
    const launch = options.spawn || spawn;
    const resolveExecutable = options.resolveExecutable || findExecutable;
    const timeoutMs = options.timeoutMs || TIMEOUT_MS;
    const killGraceMs = options.killGraceMs || 1000;

    app.get('/api/tools', (req, res) => res.json({
        defaultTool: 'codex', tools: Object.keys(registry), streamMode: 'delta',
        toolDetails: publicToolDetails(credentialStore, resolveExecutable),
    }));

    app.put('/api/tools/:id/credential', (req, res) => {
        const tool = registry[req.params.id];
        if (!tool?.apiKeyEnv) return res.status(400).json({ error: 'This tool uses vendor login; API key storage is unsupported' });
        const body = req.body;
        if (!body || Object.keys(body).some((key) => key !== 'apiKey') || typeof body.apiKey !== 'string' || !body.apiKey.trim() || body.apiKey.length > 8192 || /[\r\n\0]/.test(body.apiKey)) {
            return res.status(400).json({ error: 'Provide only a nonempty API key; session tokens are not accepted' });
        }
        // Known subscription token format; OAuth/session-token fields are never accepted.
        if (body.apiKey.startsWith('sk-ant-oat')) return res.status(400).json({ error: 'Subscription session tokens are not accepted' });
        try {
            credentialStore.set(tool.id, body.apiKey.trim());
            return res.json({ id: tool.id, authenticationStatus: 'authenticated' });
        } catch { return res.status(503).json({ code: 'AI_CREDENTIAL_STORE_UNAVAILABLE', error: 'Native credential storage is unavailable or access was denied' }); }
    });
    app.delete('/api/tools/:id/credential', (req, res) => {
        const tool = registry[req.params.id];
        if (!tool?.apiKeyEnv) return res.status(400).json({ error: 'API key storage is unsupported for this tool' });
        try { credentialStore.delete(tool.id); return res.json({ id: tool.id, authenticationStatus: 'unknown' }); }
        catch { return res.status(503).json({ code: 'AI_CREDENTIAL_STORE_UNAVAILABLE', error: 'Native credential storage is unavailable or access was denied' }); }
    });

    const infer = (streaming) => (req, res) => {
        const body = req.body || {};
        const tool = registry[body.tool];
        if (!tool) return res.status(400).json({ error: 'Unsupported CLI tool', code: 'AI_TOOL_UNSUPPORTED' });
        if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 100000) return res.status(400).json({ error: 'A nonempty prompt of at most 100000 characters is required' });
        if (body.model !== undefined && (typeof body.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/.test(body.model))) return res.status(400).json({ error: 'Invalid model identifier' });
        if (body.image || (body.files && (!Array.isArray(body.files) || body.files.length))) return res.status(400).json({ error: 'File and image inputs are unsupported for isolated text inference', code: 'AI_CAPABILITY_UNSUPPORTED' });
        const executable = resolveExecutable(tool.executables);
        if (!executable) return res.status(503).json({ error: 'CLI tool is not installed', code: 'AI_TOOL_UNAVAILABLE' });
        let env;
        try { env = childEnvironment(tool, credentialStore); }
        catch { return res.status(503).json({ error: 'Native credential storage is unavailable or access was denied', code: 'AI_CREDENTIAL_STORE_UNAVAILABLE' }); }

        let cwd;
        let child;
        let timer;
        let forceTimer;
        let finished = false;
        let closed = false;
        let bytes = 0;
        const cleanup = () => { if (cwd) { fs.rmSync(cwd, { recursive: true, force: true }); cwd = null; } };
        const send = (payload) => {
            if (!finished && !res.destroyed) res.write(`data: ${JSON.stringify({ ...payload, streamMode: 'delta' })}\n\n`);
        };
        const kill = (signal) => {
            if (!child) return;
            try {
                if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch { /* already exited */ }
        };
        const terminate = () => {
            if (!child || closed) return;
            kill('SIGTERM');
            forceTimer = setTimeout(() => kill('SIGKILL'), killGraceMs);
            forceTimer.unref?.();
        };
        const finish = (error, code = 'AI_INFERENCE_FAILED', status = 502) => {
            if (finished) return;
            clearTimeout(timer);
            if (streaming) {
                if (error) send({ error, code }); else send({ done: true });
                finished = true;
                res.end();
            } else {
                finished = true;
                if (!res.destroyed) {
                    if (error) res.status(status).json({ error, code });
                    else res.json({ response: parser.text, streamMode: 'delta' });
                }
            }
        };
        const parser = tool.parseStream((delta) => { if (streaming) send({ response: delta, delta }); });
        try {
            cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-inference-'));
            const extraArgs = prepareWorkspace(tool, cwd, env);
            if (streaming) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
                res.flushHeaders();
            }
            child = launch(executable, [...extraArgs, ...tool.buildArgs(body.prompt, body.model)], {
                cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch {
            finish('Unable to launch CLI inference');
            cleanup();
            return;
        }
        const cancel = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            terminate();
        };
        req.once('aborted', cancel);
        res.once('close', cancel);
        timer = setTimeout(() => {
            terminate();
            finish('CLI inference timed out', 'AI_INFERENCE_TIMEOUT', 504);
        }, timeoutMs);
        const accountOutput = (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_OUTPUT) { terminate(); finish('CLI output limit exceeded'); return false; }
            return !finished;
        };
        child.stdout.on('data', (chunk) => {
            if (accountOutput(chunk)) {
                parser.push(chunk);
                if (parser.error) { terminate(); finish(parser.error); }
            }
        });
        // Bound stderr, but never return it: it can contain prompts, account details or credentials.
        child.stderr.on('data', accountOutput);
        child.on('error', () => { finish('Unable to launch CLI inference', 'AI_TOOL_UNAVAILABLE', 503); });
        child.on('close', (code) => {
            closed = true;
            // An exited group leader can leave descendants alive after SIGTERM.
            if (forceTimer) kill('SIGKILL');
            clearTimeout(forceTimer);
            if (!finished) {
                parser.end();
                finish(code !== 0 ? 'CLI inference failed; check vendor authentication and model settings' : parser.error || (!parser.text ? 'CLI returned no assistant text' : null));
            }
            cleanup();
            req.removeListener('aborted', cancel);
            res.removeListener('close', cancel);
        });
    };
    app.post(['/api/inference', '/api/low-level'], infer(false));
    app.post(['/api/inference-stream', '/api/low-level-stream'], infer(true));
}

module.exports = { installInferenceApi, childEnvironment, prepareWorkspace, publicToolDetails };
