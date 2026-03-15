const WebSocket = require('ws');
const http = require('http');
const app = require('../server');
const { setupWebSocket, sessionManager } = require('../harness-api');
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('Harness WebSocket Stream', () => {
    let server;
    let wsClient;
    let TEST_PORT;
    let contextDir;

    beforeAll((done) => {
        contextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ws-'));
        server = http.createServer(app);
        server.listen(0, () => {
            TEST_PORT = server.address().port;
            setupWebSocket(server);
            done();
        });
    });

    afterAll((done) => {
        if (wsClient) {
            wsClient.close();
        }
        server.close(done);
    });

    test('should execute spawn_debug_test task via WebSocket and receive output', (done) => {
        wsClient = new WebSocket(`ws://localhost:${TEST_PORT}/api/harness/stream`);

        const messages = [];
        let sessionId = null;
        let ptyExited = false;

        wsClient.onopen = () => {
            wsClient.send(JSON.stringify({
                action: 'init',
                tool: 'gemini',
                task: 'spawn_debug_test',
                contextDir
            }));
        };

        wsClient.onmessage = (event) => {
            const message = JSON.parse(event.data);
            messages.push(message);

            if (message.type === 'session' && message.session) {
                sessionId = message.session.id;
            }

            if (message.type === 'output') {
                expect(message.data).toBeDefined();
                expect(typeof message.data).toBe('string');
            }

            if (message.type === 'exit') {
                ptyExited = true;
                expect(message.code).toBe(0);

                const session = sessionManager.get(sessionId);
                expect(session).toBeDefined();
                expect(session.state).toBe('completed');
                expect(session.tool).toBe('gemini');
                expect(session.task).toBe('spawn_debug_test');

                const outputMessages = messages.filter(m => m.type === 'output');
                expect(outputMessages.length).toBeGreaterThan(0);

                done();
            }
        };

        wsClient.onerror = (err) => {
            done(err);
        };

        wsClient.onclose = () => {
            if (!ptyExited) {
                done(new Error('WebSocket closed before PTY exited'));
            }
        };
    }, 15000); // Increase timeout for WebSocket tests
});
