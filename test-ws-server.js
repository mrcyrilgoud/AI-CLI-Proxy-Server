const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

const wss = new WebSocket.Server({ server, path: '/api/harness/stream' });

wss.on('connection', (ws) => {
  console.log('Got test connection!');
  ws.send('hello');
});

server.listen(3334, () => {
    console.log('3334 up');
});
