const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const definitions = [
    ['codex', ['codex'], 'CODEX_API_KEY', 'Run codex login for ChatGPT, or save a Codex API key.'],
    ['gemini', ['gemini'], 'GEMINI_API_KEY', 'Run gemini and follow Google login, or save a Gemini API key.'],
    ['opencode', ['opencode'], null, 'Run opencode auth login for the selected provider.'],
    ['cursor', ['cursor-agent', 'agent'], 'CURSOR_API_KEY', 'Run cursor-agent login, or save a Cursor API key.'],
    ['claude', ['claude'], 'ANTHROPIC_API_KEY', 'Run claude auth login, or save an Anthropic API key.'],
    ['kiro', ['kiro-cli'], 'KIRO_API_KEY', 'Run kiro-cli login, or save a Kiro API key.'],
];

function buildArgs(id, prompt, model) {
    const modelArgs = model ? ['--model', model] : [];
    switch (id) {
        case 'codex': return ['exec', '--sandbox', 'read-only', '--ignore-user-config', '--disable', 'shell_tool', '--disable', 'hooks', '--disable', 'plugins', '--ephemeral', '--skip-git-repo-check', '--json', ...modelArgs, '--', prompt];
        case 'gemini': return ['--approval-mode', 'plan', '--extensions', 'none', '--output-format', 'stream-json', ...modelArgs, `--prompt=${prompt}`];
        case 'opencode': return ['run', '--format', 'json', ...modelArgs, '--', prompt];
        case 'cursor': return ['--print', '--mode', 'ask', '--sandbox', 'enabled', '--output-format', 'stream-json', '--stream-partial-output', ...modelArgs, '--', prompt];
        case 'claude': return ['--print', '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...modelArgs, '--', prompt];
        case 'kiro': return ['chat', '--v2', '--no-interactive', '--agent', 'proxy-inference', '--trust-tools=', '--output-format', 'stream-json', ...modelArgs, '--', prompt];
        default: throw new Error('Unsupported CLI tool');
    }
}

function findExecutable(names, searchPath = process.env.PATH || '') {
    for (const name of names) {
        for (const directory of searchPath.split(path.delimiter).filter(path.isAbsolute)) {
            const candidate = path.join(directory, name);
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                if (fs.statSync(candidate).isFile()) return candidate;
            } catch { /* unavailable */ }
        }
    }
    return null;
}

// Never expose raw discovery stdout, executable paths, account identities or secrets.
const registry = Object.assign(Object.create(null), Object.fromEntries(definitions.map(([id, executables, apiKeyEnv, authenticationInstructions]) => [id, {
    id, executables, apiKeyEnv, authenticationInstructions,
    capabilities: { image: false, streaming: true, model: true },
    buildArgs: (prompt, model) => buildArgs(id, prompt, model),
    parseStream: (onDelta) => new OutputParser(id, onDelta),
    parseOutput: (output) => {
        const parser = new OutputParser(id);
        parser.push(Buffer.from(output));
        parser.end();
        return parser.text;
    },
}])));

class OutputParser {
    constructor(tool, onDelta = () => {}) {
        this.tool = tool;
        this.onDelta = onDelta;
        this.decoder = new StringDecoder('utf8');
        this.buffer = '';
        this.text = '';
        this.snapshots = new Map();
        this.hasPartial = false;
        this.error = null;
    }
    append(text) {
        if (typeof text !== 'string' || !text) return;
        this.text += text;
        this.onDelta(text);
    }
    snapshot(text, id = 'answer') {
        if (typeof text !== 'string') return;
        const previous = this.snapshots.get(id) || '';
        if (!text.startsWith(previous)) {
            this.error = 'CLI returned an inconsistent response';
            return;
        }
        this.append(text.slice(previous.length));
        this.snapshots.set(id, text);
    }
    push(chunk) {
        this.buffer += this.decoder.write(chunk);
        let newline;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
            this.record(this.buffer.slice(0, newline));
            this.buffer = this.buffer.slice(newline + 1);
        }
    }
    end() {
        this.buffer += this.decoder.end();
        if (this.buffer.trim()) this.record(this.buffer);
        this.buffer = '';
    }
    record(line) {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch {
            this.error = 'CLI returned malformed structured output';
            return;
        }
        if (!event || typeof event !== 'object') { this.error = 'CLI returned malformed structured output'; return; }
        if (event.type === 'error' || event.type === 'turn.failed' || event.is_error || event.error || event.status === 'error' || event.status === 'failed') {
            this.error = 'CLI inference failed; check vendor authentication and model settings';
            return;
        }
        if (this.tool === 'codex' && event.type === 'item.completed' && event.item?.type === 'agent_message') {
            this.snapshot(event.item.text, event.item.id || 'answer');
        } else if (this.tool === 'gemini' && event.type === 'message' && event.role === 'assistant') {
            if (event.delta) this.append(event.content); else this.snapshot(event.content);
        } else if (this.tool === 'opencode' && event.type === 'text') {
            this.snapshot(event.part?.text, event.part?.id || 'answer');
        } else if (this.tool === 'kiro') {
            const update = event.params?.update || event.update || event;
            if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') this.append(update.content.text);
        } else if (this.tool === 'claude' || this.tool === 'cursor') {
            const delta = event.type === 'stream_event' ? event.event : event;
            if (delta.type === 'content_block_delta' && delta.delta?.type === 'text_delta') {
                this.hasPartial = true;
                this.append(delta.delta.text);
            } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
                const text = event.message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('');
                if (this.tool === 'cursor' && event.timestamp_ms !== undefined && !event.model_call_id) {
                    this.hasPartial = true;
                    this.append(text);
                } else if (this.tool !== 'cursor' && !this.hasPartial) {
                    this.snapshot(text, event.message.id || 'answer');
                }
            } else if (event.type === 'result' && typeof event.result === 'string') {
                // A terminal aggregate duplicates partial output; only append a missing suffix.
                if (event.result.startsWith(this.text)) this.append(event.result.slice(this.text.length));
                else if (!this.text) this.append(event.result);
                else this.error = 'CLI returned an inconsistent response';
            }
        }
    }
}

module.exports = { registry, findExecutable, buildArgs, OutputParser };
