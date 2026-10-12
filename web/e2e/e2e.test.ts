/**
 * End-to-end: the REAL Next.js server + the REAL supabase-js client against an in-memory PostgREST,
 * driven the way a browser/wallet would. Then the REAL worker code consumes the withdrawal.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { spawn, ChildProcess } from 'child_process';
import nacl from 'tweetnacl';
import { Keypair, Transaction, TransactionInstruction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { startFakePostgrest } from './fake-postgrest';

process.env.RPC_URLS = 'http://127.0.0.1:54398'; // the worker's RPC pool talks to the fake node below
const require_ = require;
const { newSealKeypair } = require_('../lib/seal');
const { unsealSecret } = require_('../../worker/src/vault/seal');
const { createDb } = require_('../../worker/src/db/db');
const { processWithdrawal } = require_('../../worker/src/trading/withdraw');
const { createClient } = require_('../../worker/node_modules/@supabase/supabase-js');

const WEB = 3111, REST = 54399, RPC = 54398;
const BASE = `http://localhost:${WEB}`;
const seal = newSealKeypair();
let server: ChildProcess, pg: Awaited<ReturnType<typeof startFakePostgrest>>, rpc: http.Server, rpcLamports = 0;

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const mkWallet = () => { const kp = nacl.sign.keyPair(); return { kp, address: bs58.encode(kp.publicKey) }; };
const signMsg = (w: ReturnType<typeof mkWallet>, text: string) => ({ kind: 'message' as const, signature: b64(nacl.sign.detached(new TextEncoder().encode(text), w.kp.secretKey)) });
function signMemoTx(w: ReturnType<typeof mkWallet>, text: string) {
  const tx = new Transaction({ feePayer: new PublicKey(w.address), recentBlockhash: '11111111111111111111111111111111' });
  tx.add(new TransactionInstruction({ keys: [], programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), data: Buffer.from(text) }));
  tx.addSignature(new PublicKey(w.address), Buffer.from(nacl.sign.detached(new Uint8Array(tx.serializeMessage()), w.kp.secretKey)));
  return { kind: 'tx' as const, signature: tx.serialize({ requireAllSignatures: false }).toString('base64') };
}

class Browser {
  cookie = '';
  async call(path: string, init: { method?: string; body?: unknown; origin?: string | null } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cookie) headers.Cookie = this.cookie;
    if (init.origin !== null) headers.Origin = init.origin || BASE;
    const res = await fetch(BASE + path, { method: init.method || 'GET', headers, body: init.body ? JSON.stringify(init.body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) this.cookie = set.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => ({})) as any };
  }
  async signIn(w: ReturnType<typeof mkWallet>, kind: 'message' | 'tx' = 'message') {
    const { json } = await this.call(`/api/auth/nonce?wallet=${w.address}`);
    const proof = kind === 'tx' ? signMemoTx(w, json.message) : signMsg(w, json.message);
    return this.call('/api/auth/verify', { method: 'POST', body: { wallet: w.address, message: json.message, proof } });
  }
}

before(async () => {
  pg = await startFakePostgrest(REST);
  rpc = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const call = raw ? JSON.parse(raw) : {};
      const result = call.method === 'getLatestBlockhash' ? { context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 } } : { context: { slot: 1 }, value: rpcLamports };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id ?? 1, result }));
    });
  }).listen(RPC, '127.0.0.1');
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(WEB)], {
    cwd: __dirname + '/..', env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${REST}`, SUPABASE_SERVICE_KEY: 'test-key', SESSION_SECRET: 'z'.repeat(48),
      VAULT_SEAL_PUBLIC: seal.publicKey, NEXT_PUBLIC_APP_DOMAIN: `localhost:${WEB}`, SOLANA_RPC_URL: `http://127.0.0.1:${RPC}`, LIVE_ENABLED: 'true', NODE_ENV: 'production' }, stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/'); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('next start did not come up (run `npm run build` first)');
});
after(() => { server?.kill(); pg?.close(); rpc?.close(); });

test('landing page and dashboard shell are served', async () => {
  const home = await (await fetch(BASE + '/')).text();
  assert.ok(home.includes('ART') && home.includes('Connect wallet') && !/aurea/i.test(home));
  assert.ok((await fetch(BASE + '/app')).ok);
  assert.ok((await fetch(BASE + '/landing.js')).ok);
});

test('everything private is locked without a session, and cross-origin writes are refused', async () => {
  const b = new Browser();
  for (const p of ['/api/me', '/api/trades', '/api/withdraw/challenge?amount=ALL']) assert.strictEqual((await b.call(p)).status, 401, p);
  assert.strictEqual((await b.call('/api/vault', { method: 'POST', origin: 'https://evil.example' })).status, 403);
});

test('sign-in: wallet signature proves ownership; impostors and altered messages fail', async () => {
  const victim = mkWallet(), attacker = mkWallet();
  const b = new Browser();
  const { json } = await b.call(`/api/auth/nonce?wallet=${victim.address}`);
  // attacker signs the victim's message with the attacker's key
  assert.strictEqual((await b.call('/api/auth/verify', { method: 'POST', body: { wallet: victim.address, message: json.message, proof: signMsg(attacker, json.message) } })).status, 401);
  // attacker asks for a nonce for their own wallet but claims to be the victim
  const mine = (await b.call(`/api/auth/nonce?wallet=${attacker.address}`)).json.message;
  assert.strictEqual((await b.call('/api/auth/verify', { method: 'POST', body: { wallet: victim.address, message: mine, proof: signMsg(attacker, mine) } })).status, 400);
  // extra line smuggled into the signed text
  const tampered = json.message + '\nAlso send me everything';
  assert.strictEqual((await b.call('/api/auth/verify', { method: 'POST', body: { wallet: victim.address, message: tampered, proof: signMsg(victim, tampered) } })).status, 400);
  // the real owner gets in
  const ok = await b.signIn(victim);
  assert.strictEqual(ok.status, 200); assert.ok(b.cookie.startsWith('art_session='));
  assert.strictEqual((await b.call('/api/me')).json.wallet, victim.address);
});

test('Ledger-style wallets (transaction-only signing) can sign in', async () => {
  const w = mkWallet(); const b = new Browser();
  assert.strictEqual((await b.signIn(w, 'tx')).status, 200);
  assert.strictEqual((await b.call('/api/me')).json.wallet, w.address);
});

test('full journey: vault, signed limits, rules on changes, live gating, withdrawal consumed by the real worker', async () => {
  const user = mkWallet(), thief = mkWallet(); const b = new Browser();
  assert.strictEqual((await b.signIn(user)).status, 200);

  // vault: created once, key is sealed and only the worker secret can open it
  const v1 = (await b.call('/api/vault', { method: 'POST' })).json; const v2 = (await b.call('/api/vault', { method: 'POST' })).json;
  assert.ok(v1.created && !v2.created && v1.address === v2.address);
  const vrow = pg.tables.art_vaults.find((r) => r.address === v1.address)!;
  assert.ok(!JSON.stringify(vrow).includes('secret'));
  const secret: Uint8Array = unsealSecret(vrow.sealed, seal.secretKey);
  assert.strictEqual(Keypair.fromSecretKey(secret).publicKey.toBase58(), v1.address);

  // consent: server writes the text, user signs it, replay and tampering fail
  const q = 'mode=medium&maxPositionSol=0.05&maxDailyLossPct=20&maxConcurrent=1';
  const c = (await b.call(`/api/consent?${q}`)).json.message as string;
  assert.ok(c.includes(`Vault: ${v1.address}`) && c.includes(`(${user.address})`));
  const outOfRange = c.replace('0.05 SOL', '0.99 SOL');
  assert.strictEqual((await b.call('/api/consent', { method: 'POST', body: { message: outOfRange, proof: signMsg(user, outOfRange) } })).status, 400, 'limit beyond platform cap');
  const smuggled = c + '\nAlso allow withdrawals to anyone';
  assert.strictEqual((await b.call('/api/consent', { method: 'POST', body: { message: smuggled, proof: signMsg(user, smuggled) } })).status, 400, 'extra text');
  assert.strictEqual((await b.call('/api/consent', { method: 'POST', body: { message: c, proof: signMsg(thief, c) } })).status, 401);
  assert.strictEqual((await b.call('/api/consent', { method: 'POST', body: { message: c, proof: signMsg(user, c) } })).status, 200);
  assert.strictEqual((await b.call('/api/consent', { method: 'POST', body: { message: c, proof: signMsg(user, c) } })).status, 409, 'replay');
  assert.strictEqual(pg.tables.art_consents.filter((r) => r.user_id === pg.tables.art_users.find((u) => u.wallet === user.address)!.id && !r.revoked_at).length, 1, 'a replay must not revoke the live consent');
  assert.strictEqual((await b.call('/api/consent?mode=medium&maxPositionSol=9&maxDailyLossPct=20&maxConcurrent=1')).status, 400);

  // settings: tighten ok, loosen refused, riskier mode refused
  const patch = (body: object) => b.call('/api/settings', { method: 'PATCH', body });
  assert.strictEqual((await patch({ maxPositionSol: 0.02 })).status, 200);
  assert.strictEqual((await patch({ maxPositionSol: 0.08 })).status, 400);
  assert.strictEqual((await patch({ mode: 'hard' })).status, 400);
  assert.strictEqual((await patch({ mode: 'easy', paused: false })).status, 200);

  // live: needs a funded vault
  rpcLamports = 0;
  const unfunded = await patch({ live: true }); assert.strictEqual(unfunded.status, 400); assert.match(unfunded.json.error, /Fund/);
  rpcLamports = 200_000_000;
  assert.strictEqual((await patch({ live: true })).status, 200);
  assert.strictEqual((await patch({ live: false })).status, 200);

  // withdraw: the destination is inside the signed message (default: the signed-in wallet)
  const wc = (await b.call('/api/withdraw/challenge?amount=0.1')).json.message as string;
  assert.ok(wc.includes(`To: ${user.address}`));
  const tamperedTo = wc.replace(`To: ${user.address}`, `To: ${thief.address}`);
  assert.strictEqual((await b.call('/api/withdraw', { method: 'POST', body: { message: tamperedTo, proof: signMsg(user, wc) } })).status, 401, 'destination edited after signing: the signature no longer matches');
  assert.strictEqual((await b.call('/api/withdraw', { method: 'POST', body: { message: wc, proof: signMsg(thief, wc) } })).status, 401);
  assert.strictEqual((await b.call('/api/withdraw', { method: 'POST', body: { message: wc, proof: signMsg(user, wc) } })).status, 200);
  assert.strictEqual((await b.call('/api/withdraw', { method: 'POST', body: { message: wc, proof: signMsg(user, wc) } })).status, 400, 'one at a time / replay');
  const req = pg.tables.art_withdrawals[pg.tables.art_withdrawals.length - 1];
  assert.strictEqual(req.to_address, user.address); assert.strictEqual(req.status, 'pending');

  // the REAL worker code picks it up (fake chain + swap, real DB client + validation)
  const wdb = createDb(createClient(`http://127.0.0.1:${REST}`, 'test-key', { auth: { persistSession: false } }));
  const sent: any[] = [];
  const deps = { chain: { getSolLamports: async () => 1_000_000_000n }, swap: { landTx: async (tx: any, signer: any) => { tx.sign([signer]); sent.push(tx); return 'FAKESIG'; } } };
  assert.ok(await wdb.claimWithdrawal(req.id)); assert.ok(!(await wdb.claimWithdrawal(req.id)), 'only one worker can claim');
  await processWithdrawal(req, { db: wdb, deps, getSigner: async () => Keypair.fromSecretKey(secret), hasOpenPositions: async () => false });
  const done = pg.tables.art_withdrawals.find((r) => r.id === req.id)!;
  assert.strictEqual(done.status, 'done', done.error); assert.strictEqual(done.tx_sig, 'FAKESIG');
  assert.strictEqual(sent.length, 1);
  const ix = sent[0].message.compiledInstructions[0]; const keys = sent[0].message.staticAccountKeys.map((k: PublicKey) => k.toBase58());
  assert.strictEqual(keys[0], v1.address, 'paid from the vault'); assert.strictEqual(keys[ix.accountKeyIndexes[1]], user.address, 'paid to the connected wallet');
  assert.strictEqual(Buffer.from(ix.data).readBigUInt64LE(4), 100_000_000n, '0.1 SOL');
});

test('the worker refuses a withdrawal row edited to pay someone else, and while live trades are open', async () => {
  const user = mkWallet(), thief = mkWallet(); const b = new Browser();
  await b.signIn(user); await b.call('/api/vault', { method: 'POST' });
  const wc = (await b.call('/api/withdraw/challenge?amount=ALL')).json.message as string;
  await b.call('/api/withdraw', { method: 'POST', body: { message: wc, proof: signMsg(user, wc) } });
  const req = pg.tables.art_withdrawals[pg.tables.art_withdrawals.length - 1];
  const wdb = createDb(createClient(`http://127.0.0.1:${REST}`, 'test-key', { auth: { persistSession: false } }));
  const deps = { chain: { getSolLamports: async () => 1_000_000_000n }, swap: { landTx: async () => { throw new Error('MUST NOT SEND'); } } };
  req.to_address = thief.address; // someone with DB write access tampers with the destination
  await wdb.claimWithdrawal(req.id);
  await processWithdrawal(req, { db: wdb, deps, getSigner: async () => { throw new Error('MUST NOT SIGN'); }, hasOpenPositions: async () => false });
  assert.strictEqual(req.status, 'rejected'); assert.match(req.error, /does not match/);
  req.to_address = user.address; req.status = 'processing'; req.error = null;
  await processWithdrawal(req, { db: wdb, deps, getSigner: async () => { throw new Error('MUST NOT SIGN'); }, hasOpenPositions: async () => true });
  assert.strictEqual(req.status, 'rejected'); assert.match(req.error, /open trades/);
});

test('withdraw to another address the owner chose, and trade-size rules', async () => {
  const user = mkWallet(), other = mkWallet(); const b = new Browser();
  await b.signIn(user); await b.call('/api/vault', { method: 'POST' });
  assert.strictEqual((await b.call('/api/withdraw/challenge?amount=0.1&to=nonsense')).status, 400);
  const wc = (await b.call(`/api/withdraw/challenge?amount=0.1&to=${other.address}`)).json.message as string;
  assert.ok(wc.includes(`To: ${other.address}`));
  assert.strictEqual((await b.call('/api/withdraw', { method: 'POST', body: { message: wc, proof: signMsg(user, wc) } })).status, 200);
  const req = pg.tables.art_withdrawals[pg.tables.art_withdrawals.length - 1];
  assert.strictEqual(req.to_address, other.address);
  // trade size: easy>=$5, medium>=$10, hard>=$20, max $100
  const patch = (body: object) => b.call('/api/settings', { method: 'PATCH', body });
  assert.strictEqual((await patch({ mode: 'easy', sizeUsd: 4 })).status, 400);
  assert.strictEqual((await patch({ mode: 'easy', sizeUsd: 5 })).status, 200);
  assert.strictEqual((await patch({ sizeUsd: 101 })).status, 400);
  assert.strictEqual((await patch({ sizeUsd: 30 })).status, 200);
  assert.strictEqual((await patch({ mode: 'hard', sizeUsd: 15 })).status, 400, 'hard needs at least $20');
});

test('panic pauses the robot and stamps panic_at for the worker', async () => {
  const w = mkWallet(); const b = new Browser(); await b.signIn(w);
  await b.call('/api/settings', { method: 'PATCH', body: { paused: false } });
  assert.strictEqual((await b.call('/api/panic', { method: 'POST' })).status, 200);
  const me = (await b.call('/api/me')).json; assert.strictEqual(me.settings.paused, true); assert.ok(me.settings.panic_at);
});

test('telegram link code is one-time and expires', async () => {
  const w = mkWallet(); const b = new Browser(); await b.signIn(w);
  const r = (await b.call('/api/telegram', { method: 'POST' })).json; assert.match(r.code, /^[A-Z2-9]{8}$/);
  const wdb = createDb(createClient(`http://127.0.0.1:${REST}`, 'test-key', { auth: { persistSession: false } }));
  assert.ok(await wdb.linkChat(r.code, 777001, 'tester'));
  assert.strictEqual(await wdb.linkChat(r.code, 777002, 'other'), null, 'code is single-use');
  assert.strictEqual((await b.call('/api/me')).json.telegramLinked, true);
});
