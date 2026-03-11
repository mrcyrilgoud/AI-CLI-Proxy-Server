const WebSocket = require('ws');
const http = require('http');
const { server: appServer } = require('./server'); // Assuming your express app is exported from server.js

describe('WebSocket Long Running Stop Test', () => {
  let server;
  let port;

  beforeAll((done) => {
    server = appServer;
    if (server.address()) {
      port = server.address().port;
      done();
    } else {
      server.listen(() => {
        port = server.address().port;
        done();
      });
    }
  });

  afterAll((done) => {
    server.close(done);
  });

  test('should start a session, send input, and then stop it', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/api/harness/stream`);

    ws.on('open', () => {
      // 1. Initialize a session
      ws.send(JSON.stringify({
        action: 'init',
        tool: 'gemini',
        task: 'create a file named long_stop_test.txt and write the numbers 1 to 100, waiting 1 second between each number',
        sessionId: 'test-session-123'
      }));
    });

    let outputCounter = 0;
    ws.on('message', (message) => {
      const data = JSON.parse(message);
      console.log('Received message:', data);

      if (data.type === 'output') {
        outputCounter++;
        // After receiving some output, send the stop signal
        if (outputCounter > 5) {
          ws.send(JSON.stringify({
            action: 'stop',
            sessionId: 'test-session-123'
          }));
        }
      }

      if (data.type === 'stopped') {
        // Session was successfully stopped
        ws.close();
        done();
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      done(error);
    });

    ws.on('close', () => {
      console.log('WebSocket connection closed');
    });
  }, 30000); // 30 second timeout for this test
});
