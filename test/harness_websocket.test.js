const WebSocket = require('ws');
const http = require('http');
const { app } = require('../server'); // Import app from server
const { setupWebSocket, sessionManager, SessionManager } = require('../harness-api'); // Import from harness-api
const path = require('path');
const fs = require('fs');

describe('Harness WebSocket Stream', () => {
    let server;
    let wsClient;
    const TEST_PORT = 4444; // Use a different port for testing

    beforeAll((done) => {
        // Start the server on a test port
        server = http.createServer(app);
        server.listen(TEST_PORT, () => {
            console.log(`Test server running on port ${TEST_PORT}`);
            setupWebSocket(server); // Pass SessionManager class to setupWebSocket

            // Clear any existing sessions from previous test runs
            const harnessDir = path.join(process.cwd(), '.harness');
            const sessionsFile = path.join(harnessDir, 'sessions.json');
            if (fs.existsSync(sessionsFile)) {
                fs.unlinkSync(sessionsFile);
            }
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
            // Send init payload for spawn_debug_test
            wsClient.send(JSON.stringify({
                action: 'init',
                tool: 'gemini',
                task: 'spawn_debug_test',
                contextDir: process.cwd()
            }));
        };

        wsClient.onmessage = (event) => {
            const message = JSON.parse(event.data);
            messages.push(message);

            if (message.type === 'session' && message.session) {
                sessionId = message.session.id;
            }

            if (message.type === 'output') {
                // We expect some output from the 'gemini spawn_debug_test --yolo' command
                // The exact output might vary, so we'll just check if there's any output.
                expect(message.data).toBeDefined();
                expect(typeof message.data).toBe('string');
            }

            if (message.type === 'exit') {
                ptyExited = true;
                expect(message.code).toBe(0); // Expect a successful exit
                
                // Once the PTY has exited, we can perform final assertions
                const session = sessionManager.get(sessionId);
                expect(session).toBeDefined();
                expect(session.state).toBe('completed');
                expect(session.tool).toBe('gemini');
                expect(session.task).toBe('spawn_debug_test');

                // Check for some output messages
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
