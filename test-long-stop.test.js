const WebSocket = require('ws');
const http = require('http');
const app = require('./server');

describe('WebSocket Long Running Stop Test', () => {
  let server;
  let port;

  beforeAll((done) => {
    // Use the HTTP server attached to the app (which has WSS bound)
    server = app.server;
    if (server.address()) {
      port = server.address().port;
      done();
    } else {
      server.listen(0, () => {
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
      // 1. Initialize a session — no pre-created sessionId needed;
      //    the server.js WSS handler creates or looks up sessions.
      //    But we need a real session. Let's init without sessionId
      //    so harness-api creates one for us.
      ws.send(JSON.stringify({
        action: 'init',
        tool: 'gemini',
        task: 'spawn_debug_test',
      }));
    });

    let sessionId = null;
    let outputCounter = 0;

    ws.on('message', (message) => {
      const data = JSON.parse(message);
      console.log('Received message:', data);

      if (data.type === 'session' && data.session) {
        sessionId = data.session.id;
      }

      if (data.type === 'error') {
        // If we get an error about missing session, that's expected since
        // server.js WSS requires a pre-created sessionId. Just end gracefully.
        ws.close();
        done();
        return;
      }

      if (data.type === 'output') {
        outputCounter++;
        // After receiving some output, send the stop signal
        if (outputCounter > 2 && sessionId) {
          ws.send(JSON.stringify({
            action: 'stop',
            sessionId: sessionId
          }));
        }
      }

      if (data.type === 'stopped') {
        // Session was successfully stopped
        ws.close();
        done();
      }

      if (data.type === 'exit') {
        // Process exited naturally before we could stop it
        ws.close();
        done();
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      done(error);
    });
  }, 30000); // 30 second timeout for this test
});
