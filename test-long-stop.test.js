const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const app = require('./server');

describe('WebSocket Long Running Stop Test', () => {
  let server;
  let port;
  let ws;
  let contextDir;

  beforeAll((done) => {
    contextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stop-'));
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
    if (ws && ws.readyState < WebSocket.CLOSING) {
      ws.close();
    }
    server.close(done);
  });

  test('should start a session, send input, and then stop it', (done) => {
    ws = new WebSocket(`ws://localhost:${port}/api/harness/stream`);
    let finished = false;

    const finish = (error) => {
      if (finished) {
        return;
      }

      finished = true;
      if (error) {
        done(error);
        return;
      }

      done();
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({
        action: 'init',
        tool: 'gemini',
        task: 'spawn_debug_test',
        contextDir,
      }));
    });

    let sessionId = null;
    let outputCounter = 0;

    ws.on('message', (message) => {
      const data = JSON.parse(message);

      if (data.type === 'session' && data.session) {
        sessionId = data.session.id;
      }

      if (data.type === 'output') {
        outputCounter++;
        if (outputCounter > 2 && sessionId) {
          ws.send(JSON.stringify({
            action: 'stop',
            sessionId: sessionId
          }));
        }
      }

      if (data.type === 'stopped') {
        ws.close();
        finish();
      }

      if (data.type === 'exit') {
        ws.close();
        finish();
      }

      if (data.type === 'error') {
        ws.close();
        finish(new Error(data.error));
      }
    });

    ws.on('error', (error) => {
      finish(error);
    });
  }, 30000); // 30 second timeout for this test
});
