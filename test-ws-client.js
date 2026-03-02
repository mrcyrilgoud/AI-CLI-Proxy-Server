const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3334/api/harness/stream');
ws.on('open', () => console.log('Client connected!'));
ws.on('error', (e) => console.log('Client Error: ', e));
