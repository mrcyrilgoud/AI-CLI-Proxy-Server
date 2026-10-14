// Fixture executable: no vendor process, live account, or network request is used.
const fs = require('fs');
const records = require('./inference-events.json');
const id = process.argv[2];
const args = process.argv.slice(3);
const prompt = id === 'gemini' ? args.at(-1).replace(/^--prompt=/, '') : args.at(-1);
const apiKeyEnv = { codex: 'CODEX_API_KEY', gemini: 'GEMINI_API_KEY', cursor: 'CURSOR_API_KEY', claude: 'ANTHROPIC_API_KEY', kiro: 'KIRO_API_KEY' }[id];
if (!process.cwd().includes('ai-proxy-inference-')) process.exit(20);
if (args.some((arg) => /bypass|yolo|trust-all|force$/.test(arg))) process.exit(21);
if (process.env.UNRELATED_APP_SECRET || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.OPENAI_API_KEY) process.exit(22);
if (prompt === 'credential' && (!apiKeyEnv || process.env[apiKeyEnv] !== `fixture-key-${id}`)) process.exit(23);
if (id === 'gemini' && !fs.existsSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH)) process.exit(24);
if (id === 'kiro' && JSON.parse(fs.readFileSync('.kiro/agents/proxy-inference.json')).tools.length) process.exit(25);
if (prompt === 'fail') { process.stderr.write('SECRET-private-credential'); process.exit(1); }
if (prompt === 'malformed') { process.stdout.write('{malformed}\n'); process.exit(0); }
if (prompt === 'oversized') { process.stdout.write(Buffer.alloc(6 * 1024 * 1024, 120)); }
else if (prompt === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else {
    // Deliberately split every record, including a multibyte character, and omit the last newline.
    const data = Buffer.from(records[id].map((event) => JSON.stringify(event)).join('\n'));
    let offset = 0;
    const timer = setInterval(() => {
        if (offset >= data.length) { clearInterval(timer); return; }
        process.stdout.write(data.subarray(offset, offset + 7));
        offset += 7;
    }, 1);
}
