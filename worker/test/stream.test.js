const test = require('node:test');
const assert = require('node:assert');
const { WebSocketServer } = require('ws');
const config = require('../src/config');
const stream = require('../src/scanner/stream');

test('stream connects, subscribes, collects creates/migrations, and reconnects after a drop', async () => {
  const subs = []; let conns = 0;
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on('listening', r));
  wss.on('connection', (sock) => {
    conns += 1;
    sock.on('message', (m) => { subs.push(JSON.parse(String(m)).method); });
    setTimeout(() => {
      sock.send(JSON.stringify({ txType: 'create', mint: 'LiveMint1' + 'z'.repeat(30), name: 'Live', symbol: 'LV' }));
      sock.send(JSON.stringify({ txType: 'migrate', mint: 'LiveMint2' + 'z'.repeat(30) }));
      if (conns === 1) setTimeout(() => sock.terminate(), 50); // drop the first connection
    }, 30);
  });
  config.STREAM_URL = `ws://127.0.0.1:${wss.address().port}`; config.STREAM_ENABLED = true;
  const before = stream.size();
  stream.start();
  const until = async (f, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 25)); } };
  await until(() => stream.size() >= before + 2);
  assert.ok(subs.includes('subscribeNewToken') && subs.includes('subscribeMigration'));
  await until(() => conns >= 2); // reconnected on its own
  stream.stop(); wss.close();
});
