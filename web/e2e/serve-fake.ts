// Starts the fake PostgREST + a fake Solana RPC so you can click through the real UI locally without Supabase.
import http from 'http';
import { startFakePostgrest } from './fake-postgrest';
(async () => {
  await startFakePostgrest(54399);
  http.createServer((req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); } let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => { const call = raw ? JSON.parse(raw) : {}; res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id ?? 1, result: call.method === 'getLatestBlockhash' ? { context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 } } : { context: { slot: 1 }, value: 300_000_000 } })); }); }).listen(54398, '127.0.0.1');
  console.log('fake backend up');
})();
