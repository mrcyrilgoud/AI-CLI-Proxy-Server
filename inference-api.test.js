const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const request = require('supertest');
const { installInferenceApi, childEnvironment } = require('./inference-api');
const { registry, OutputParser, findExecutable } = require('./inference-tools');
const { localAccess, isLoopbackOrigin } = require('./local-access');
const records = require('./test/fixtures/inference-events.json');

function testApp(options = {}) {
    const secrets = new Map();
    const store = { get: (id) => secrets.get(id) || null, set: (id, key) => secrets.set(id, key), delete: (id) => secrets.delete(id) };
    const children = [];
    const app = express();
    app.use(localAccess, cors({ origin: (origin, callback) => callback(null, isLoopbackOrigin(origin)) }), express.json());
    installInferenceApi(app, {
        credentialStore: store,
        resolveExecutable: (names) => Object.values(registry).find((tool) => tool.executables === names).id,
        spawn: (id, args, config) => {
            const child = spawn(process.execPath, [path.join(__dirname, 'test/fixtures/inference-cli.cjs'), id, ...args], config);
            children.push({ child, args, config });
            return child;
        },
        ...options,
    });
    return { app, store, children };
}

describe('isolated inference adapters', () => {
    test.each(Object.keys(registry))('%s parses UTF-8, split records, final tail and duplicate aggregates', (id) => {
        const deltas = [];
        const parser = new OutputParser(id, (delta) => deltas.push(delta));
        const buffer = Buffer.from(records[id].map((record) => JSON.stringify(record)).join('\n'));
        for (let i = 0; i < buffer.length; i++) parser.push(buffer.subarray(i, i + 1));
        parser.end();
        expect(parser.error).toBeNull();
        expect(parser.text).toBe('Hello 🌍');
        expect(deltas.join('')).toBe(parser.text);
        expect(registry[id].parseOutput(buffer.toString())).toBe('Hello 🌍');
    });
    test.each(Object.keys(registry))('%s executes safe arguments, model and isolated environment', async (tool) => {
        const { app, store, children } = testApp();
        if (registry[tool].apiKeyEnv) store.set(tool, `fixture-key-${tool}`);
        const result = await request(app).post('/api/inference').send({ tool, prompt: registry[tool].apiKeyEnv ? 'credential' : 'hello', model: 'fixture/model' });
        expect(result.status).toBe(200);
        expect(result.body).toEqual({ response: 'Hello 🌍', streamMode: 'delta' });
        expect(children[0].args).toContain('fixture/model');
        expect(children[0].config.shell).toBe(false);
        expect(fs.existsSync(children[0].config.cwd)).toBe(false);
        expect(children[0].config.env.ANTHROPIC_API_KEY).toBe(tool === 'claude' ? 'fixture-key-claude' : undefined);
    });
    test('environment does not inherit unrelated keys, tokens or executable hooks', () => {
        expect(childEnvironment(registry.codex, { get: () => 'owned-key' }, { PATH: '/bin', HOME: '/fixture', OPENAI_API_KEY: 'ambient', CLAUDE_CODE_OAUTH_TOKEN: 'token', NODE_OPTIONS: '--require evil', CODEX_API_KEY: 'ambient' })).toEqual({ PATH: '/bin', HOME: '/fixture', FORCE_COLOR: '0', NO_COLOR: '1', CODEX_API_KEY: 'owned-key' });
    });
    test('flag-like prompts cannot inject CLI flags', () => {
        for (const tool of Object.values(registry)) {
            const args = tool.buildArgs('--yolo', 'fixture-model');
            if (tool.id === 'gemini') expect(args.at(-1)).toBe('--prompt=--yolo');
            else expect(args.slice(-2)).toEqual(['--', '--yolo']);
        }
    });
    test('reports inconsistent aggregates and malformed record shapes without throwing', () => {
        const parser = new OutputParser('claude');
        parser.record(JSON.stringify({ type: 'assistant', message: { content: 'not-an-array' } }));
        parser.record(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } } }));
        parser.record(JSON.stringify({ type: 'result', result: 'a different answer' }));
        expect(parser.error).toBe('CLI returned an inconsistent response');
    });
    test('discovery includes six IDs and no paths, keys or account details', async () => {
        const { app, store } = testApp();
        store.set('claude', 'private-secret');
        const result = await request(app).get('/api/tools');
        expect(result.body.tools).toEqual(['codex', 'gemini', 'opencode', 'cursor', 'claude', 'kiro']);
        expect(result.body.toolDetails).toHaveLength(6);
        expect(result.body.toolDetails.find((tool) => tool.id === 'claude').authenticationStatus).toBe('authenticated');
        expect(JSON.stringify(result.body)).not.toMatch(/private-secret|executable|\/Users\//);
    });
    test('stream deltas reconstruct the answer exactly once', async () => {
        const { app } = testApp();
        const result = await request(app).post('/api/low-level-stream').send({ tool: 'claude', prompt: 'hello' });
        const events = result.text.split('\n\n').filter(Boolean).map((line) => JSON.parse(line.slice(6)));
        expect(events.every((event) => event.streamMode === 'delta')).toBe(true);
        expect(events.map((event) => event.delta || '').join('')).toBe('Hello 🌍');
        expect(events.at(-1).done).toBe(true);
    });
    test('nonstreaming legacy route accepts the explicit model contract', async () => {
        const { app } = testApp();
        const result = await request(app).post('/api/low-level').send({ tool: 'gemini', prompt: 'hello', model: 'fixture-model' });
        expect(result.status).toBe(200);
        expect(result.body.response).toBe('Hello 🌍');
    });
    test('stream failure emits a sanitized error without a successful done event', async () => {
        const { app } = testApp();
        const result = await request(app).post('/api/inference-stream').send({ tool: 'codex', prompt: 'fail' });
        const events = result.text.split('\n\n').filter(Boolean).map((line) => JSON.parse(line.slice(6)));
        expect(events.at(-1)).toMatchObject({ code: 'AI_INFERENCE_FAILED', streamMode: 'delta' });
        expect(events.some((event) => event.done)).toBe(false);
        expect(result.text).not.toContain('SECRET');
    });
    test('limits unstructured stdout and removes the killed workspace', async () => {
        const { app, children } = testApp({ killGraceMs: 20 });
        const result = await request(app).post('/api/inference').send({ tool: 'codex', prompt: 'oversized' });
        expect(result.status).toBe(502);
        expect(result.body.error).toBe('CLI output limit exceeded');
        await new Promise((resolve) => children[0].child.once('close', resolve));
        expect(fs.existsSync(children[0].config.cwd)).toBe(false);
    });
    test.each(['fail', 'malformed'])('sanitizes process/parse failure: %s', async (prompt) => {
        const { app, children } = testApp();
        const result = await request(app).post('/api/inference').send({ tool: 'codex', prompt });
        expect(result.status).toBe(502);
        expect(JSON.stringify(result.body)).not.toContain('SECRET');
        await new Promise((resolve) => children[0].child.exitCode !== null ? resolve() : children[0].child.once('close', resolve));
        expect(fs.existsSync(children[0].config.cwd)).toBe(false);
    });
    test('timeout terminates stubborn process and removes workspace', async () => {
        const { app, children } = testApp({ timeoutMs: 100, killGraceMs: 20 });
        const result = await request(app).post('/api/inference').send({ tool: 'codex', prompt: 'hang' });
        expect(result.status).toBe(504);
        await new Promise((resolve) => children[0].child.once('close', resolve));
        expect(fs.existsSync(children[0].config.cwd)).toBe(false);
    });
    test('disconnect cancels an in-flight child and removes workspace', async () => {
        const { app, children } = testApp({ killGraceMs: 20 });
        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            await new Promise((resolve, reject) => {
                const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/inference-stream', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
                    res.destroy();
                    resolve();
                });
                req.on('error', reject);
                req.end(JSON.stringify({ tool: 'codex', prompt: 'hang' }));
            });
            await new Promise((resolve) => children[0].child.once('close', resolve));
            expect(fs.existsSync(children[0].config.cwd)).toBe(false);
        } finally { await new Promise((resolve) => server.close(resolve)); }
    });
    test.each([{ tool: '__proto__', prompt: 'hello' }, { tool: 'codex', prompt: '' }, { tool: 'codex', prompt: 'hello', model: '--bypass' }, { tool: 'codex', prompt: 'hello', files: ['/private'] }])('rejects invalid input %j before spawning', async (body) => {
        const { app, children } = testApp();
        expect((await request(app).post('/api/inference').send(body)).status).toBe(400);
        expect(children).toHaveLength(0);
    });
    test('reports a missing executable without launching', async () => {
        const { app, children } = testApp({ resolveExecutable: () => null });
        expect((await request(app).post('/api/inference').send({ tool: 'codex', prompt: 'hi' })).status).toBe(503);
        expect(children).toHaveLength(0);
        expect(findExecutable(['cannot-exist'], '/not-present')).toBeNull();
    });
});

describe('credential API and loopback access', () => {
    test('writes/deletes an owned API key without reading it back', async () => {
        const { app, store } = testApp();
        const result = await request(app).put('/api/tools/claude/credential').send({ apiKey: 'owned-key' });
        expect(result.status).toBe(200);
        expect(JSON.stringify(result.body)).not.toContain('owned-key');
        expect(store.get('claude')).toBe('owned-key');
        expect((await request(app).get('/api/tools/claude/credential')).status).toBe(404);
        expect((await request(app).delete('/api/tools/claude/credential')).status).toBe(200);
        expect(store.get('claude')).toBeNull();
    });
    test.each([{ token: 'subscription' }, { apiKey: 'key', sessionToken: 'subscription' }, { apiKey: 'sk-ant-oat01-subscription' }])('rejects session token collection %j', async (body) => {
        const { app } = testApp();
        expect((await request(app).put('/api/tools/claude/credential').send(body)).status).toBe(400);
    });
    test('sanitizes native keychain denial and preserves stored state', async () => {
        const { app } = testApp({ credentialStore: { get: () => { throw new Error('PRIVATE'); }, set: () => { throw new Error('PRIVATE'); }, delete: () => { throw new Error('PRIVATE'); } } });
        const result = await request(app).put('/api/tools/codex/credential').send({ apiKey: 'private-key' });
        expect(result.status).toBe(503);
        expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE|private-key/);
        expect((await request(app).get('/api/tools')).body.toolDetails[0].authenticationStatus).toBe('unknown');
    });
    test.each(['https://evil.example', 'null', 'http://localhost.evil.example', 'http://user@localhost'])('rejects hostile browser origin %s', async (origin) => {
        const { app } = testApp();
        expect((await request(app).put('/api/tools/codex/credential').set('Origin', origin).send({ apiKey: 'key' })).status).toBe(403);
    });
    test('allows loopback browser origins and rejects rebinding hosts', async () => {
        const { app } = testApp();
        expect((await request(app).get('/api/tools').set('Origin', 'http://localhost:5173')).headers['access-control-allow-origin']).toBe('http://localhost:5173');
        expect((await request(app).get('/api/tools').set('Host', 'evil.example')).status).toBe(403);
    });
});
