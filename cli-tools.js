const DEFAULT_TOOL = 'codex';
const SUPPORTED_TOOLS = [DEFAULT_TOOL, 'gemini', 'opencode', 'cursor'];

function getToolsResponse() {
    return {
        defaultTool: DEFAULT_TOOL,
        tools: [...SUPPORTED_TOOLS],
    };
}

function isSupportedTool(tool) {
    return SUPPORTED_TOOLS.includes(tool);
}

function getUnsupportedToolMessage() {
    return `Unsupported CLI tool. Allowed tools: ${SUPPORTED_TOOLS.join(', ')}`;
}

function buildLowLevelArgs(tool, prompt, files = []) {
    switch (tool) {
        case 'gemini':
            return ['prompt', prompt].concat(files.length > 0 ? ['--files', ...files] : []);
        case 'opencode':
            return ['ask', prompt].concat(files.map((file) => `--context=${file}`));
        case 'codex':
            return [
                'exec',
                buildPromptWithFiles(prompt, files),
                '--dangerously-bypass-approvals-and-sandbox',
                '--skip-git-repo-check',
                '--json',
            ];
        case 'cursor':
            return ['--query', prompt, ...files.map((file) => `--file=${file}`)];
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
            return [task, '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'];
        case 'cursor':
            return ['--task', task, '--auto-confirm'];
        default:
            return [task];
    }
}

function normalizeToolResponse(tool, stdout, stderr) {
    const trimmedStdout = stdout ? stdout.trim() : '';
    const trimmedStderr = stderr ? stderr.trim() : '';

    if (tool === 'codex') {
        const parsed = parseCodexJsonOutput(trimmedStdout);
        if (parsed) {
            return parsed;
        }
    }

    if (trimmedStdout) {
        return trimmedStdout;
    }

    if (trimmedStderr) {
        return trimmedStderr;
    }

    return '';
}

function parseCodexJsonOutput(output) {
    if (!output) {
        return '';
    }

    let latestMessage = '';

    for (const line of output.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
        const candidate = extractCodexMessage(line);
        if (candidate) {
            latestMessage = candidate;
        }
    }

    return latestMessage;
}

function extractCodexMessage(line) {
    try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'item.completed' && parsed.item?.type === 'agent_message' && parsed.item.text) {
            return parsed.item.text.trim();
        }
    } catch {
        return '';
    }

    return '';
}

function buildPromptWithFiles(prompt, files) {
    if (!files.length) {
        return prompt;
    }

    return `${prompt}\n\nRelevant files:\n${files.map((file) => `- ${file}`).join('\n')}`;
}

module.exports = {
    DEFAULT_TOOL,
    SUPPORTED_TOOLS,
    buildHarnessArgs,
    buildLowLevelArgs,
    extractCodexMessage,
    getToolsResponse,
    getUnsupportedToolMessage,
    isSupportedTool,
    normalizeToolResponse,
    parseCodexJsonOutput,
};
