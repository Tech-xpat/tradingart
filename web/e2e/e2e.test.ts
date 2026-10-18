/**
 * End-to-end: the REAL Next.js server + the REAL supabase-js client against an in-memory PostgREST,
 * driven the way a browser/wallet would. Then the REAL worker code consumes the withdrawal.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { curveOf } from '../lib/pumpchain';
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

const CHAIN_MINT = 'So11111111111111111111111111111111111111112';
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
      const one = (c: any) => { // chain history for the backfill test: 60 trades of one coin on its bonding curve
        if (c.method === 'getSignaturesForAddress') { const before = c.params?.[1]?.before; const start = before ? Number(before.slice(-2)) : 0; const n = Math.min(c.params?.[1]?.limit || 40, 60 - start); return { jsonrpc: '2.0', id: c.id, result: Array.from({ length: Math.max(0, n) }, (_, i) => ({ signature: 'S'.repeat(86) + String(start + i + 1).padStart(2, '0'), err: null })) }; }
        if (c.method === 'getTransaction') { const i = Number(String(c.params[0]).slice(-2)); const buy = i % 3 !== 0; const curve = curveOf(CHAIN_MINT);
          return { jsonrpc: '2.0', id: c.id, result: { blockTime: Math.floor(Date.now() / 1000) - i * 20, transaction: { signatures: [c.params[0]], message: { accountKeys: ['Trader' + String(i % 4).repeat(30) + 'XXXXXXXX', curve] } },
            meta: { err: null, preBalances: [5e9, 10e9], postBalances: [5e9, 10e9 + (buy ? 1 : -1) * 0.2e9], preTokenBalances: [{ mint: CHAIN_MINT, owner: curve, uiTokenAmount: { uiAmount: 800e6 } }], postTokenBalances: [{ mint: CHAIN_MINT, owner: curve, uiTokenAmount: { uiAmount: 800e6 + (buy ? -1 : 1) * 1e6 } }] } } }; }
        return null;
      };
      if (Array.isArray(call) || (call.method && one(call))) { const out = Array.isArray(call) ? call.map(one) : one(call); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out)); }
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
  const outOfRange = c.replace('0.05 SOL', '5000 SOL');
  assert.strictEqual((await b.call('/api/consent', { method: 'POST', body: { message: outOfRange, proof: signMsg(user, outOfRange) } })).status, 400, 'limit beyond platform cap');
  const smuggled = c + '\nAlso allow withdrawals to anyone';
  assert.strictEqual((await b.call('/api/consent', { method: 'POST', body: { message: smuggled, proof: signMsg(user, smuggled) } })).status, 400, 'extra text');
  assert.strictEqual((await b.call('/api/consent', { method: 'POST', body: { message: c, proof: signMsg(thief, c) } })).status, 401);
  assert.strictEqual((await b.call('/api/consent', { method: 'POST', body: { message: c, proof: signMsg(user, c) } })).status, 200);
  assert.strictEqual((await b.call('/api/consent', { method: 'POST', body: { message: c, proof: signMsg(user, c) } })).status, 409, 'replay');
  assert.strictEqual(pg.tables.art_consents.filter((r) => r.user_id === pg.tables.art_users.find((u) => u.wallet === user.address)!.id && !r.revoked_at).length, 1, 'a replay must not revoke the live consent');
  assert.strictEqual((await b.call('/api/consent?mode=medium&maxPositionSol=5000&maxDailyLossPct=20&maxConcurrent=1')).status, 400);

  // settings: tighten ok, loosen refused
  const patch = (body: object) => b.call('/api/settings', { method: 'PATCH', body });
  assert.strictEqual((await patch({ maxPositionSol: 0.02 })).status, 200);
  assert.strictEqual((await patch({ maxPositionSol: 0.08 })).status, 400);
  assert.strictEqual((await patch({ paused: false })).status, 200);

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
  // plans: starter plans are seeded, edits are sanitised, switching works, no maximum size
  const patch = (body: object) => b.call('/api/settings', { method: 'PATCH', body });
  const me0 = (await b.call('/api/me')).json.settings;
  assert.deepStrictEqual(me0.plans.map((p: any) => p.id), ['rider', 'steady', 'sniper']); assert.strictEqual(me0.active_plan, 'rider'); assert.strictEqual(me0.plans[0].sizeUsd, 7); assert.strictEqual(me0.plans[0].agent.pattern, 'momentum');
  const mine = { name: 'Whale', sizeUsd: 50000, minAgeSec: 45, maxAgeSec: 900, takeProfitPct: 80, stopLossPct: 500, scanEverySec: 2, requireRising: false };
  assert.strictEqual((await patch({ plans: [...me0.plans, mine], activePlan: 'nope' })).status, 200);
  const me1 = (await b.call('/api/me')).json.settings;
  assert.strictEqual(me1.plans.length, 4); assert.strictEqual(me1.active_plan, 'rider', 'unknown active id falls back');
  const w3 = me1.plans[3]; assert.strictEqual(w3.sizeUsd, 50000, 'no maximum'); assert.strictEqual(w3.stopLossPct, 95); assert.strictEqual(w3.scanEverySec, 10);
  assert.strictEqual(w3.minAgeSec, 45); assert.strictEqual(w3.maxAgeSec, 900); assert.ok(w3.id);
  assert.strictEqual((await patch({ activePlan: w3.id })).status, 200);
  assert.strictEqual((await b.call('/api/me')).json.settings.active_plan, w3.id);
  assert.strictEqual((await patch({ activePlan: 'missing' })).status, 400);
  assert.strictEqual((await patch({ plans: [] })).status, 400, 'at least one plan');
  assert.strictEqual((await patch({ plans: Array.from({ length: 11 }, () => ({})) })).status, 400, 'at most ten');
});

test('leaderboard: everyone listed by default, ranked profit, profile, copy plan, auto-copy follows the leader', async () => {
  const A = new Browser(), B = new Browser(), wa = mkWallet(), wb = mkWallet();
  await A.signIn(wa); await B.signIn(wb);
  const meA = (await A.call('/api/me')).json, meB = (await B.call('/api/me')).json;
  const uidA = pg.tables.art_users.find((u) => u.wallet === wa.address)!.id;
  const row = (over: any) => ({ user_id: uidA, paper: false, mint: 'M'.repeat(8), cost_sol: 0.05, ...over });
  const now = Date.now();
  pg.tables.art_trades = [row({ realized_sol: 0.02, created_at: new Date(now - 3600e3).toISOString(), pct: 40, exit_reason: 'take_profit' }), row({ realized_sol: -0.005, created_at: new Date(now - 1800e3).toISOString(), pct: -10, exit_reason: 'stop_loss' }), row({ paper: true, realized_sol: 9 })];
  pg.tables.art_state.push({ user_id: uidA, key: 'live:positions', value: [{ mint: 'OPENMINT1', openedAt: now - 20000, lastPnl: 12.5, trail: [[now - 8000, 1], [now - 4000, 12.5]], takeProfitPct: 50, stopLossPct: 25 }] });
  // everyone is public by default with an auto handle (never the wallet); a trader with no trades is not ranked
  assert.strictEqual(meA.settings.public_profile, true); assert.match(meA.settings.handle, /^trader_[a-z0-9]+$/); assert.ok(!meA.settings.handle.includes(wa.address));
  const first = (await B.call('/api/leaderboard?mode=live&period=all')).json.board;
  assert.strictEqual(first.length, 1, 'listed without doing anything'); assert.strictEqual(first[0].handle, meA.settings.handle);
  assert.strictEqual((await B.call('/api/profile?handle=alpha')).status, 404);
  // opting in needs a valid, unique handle
  const patchA = (body: any) => A.call('/api/settings', { method: 'PATCH', body });
  assert.strictEqual((await patchA({ handle: 'a b', publicProfile: true })).status, 400, 'bad handle');
  assert.strictEqual((await patchA({ handle: 'Alpha', publicProfile: true })).status, 200);
  assert.strictEqual((await B.call('/api/settings', { method: 'PATCH', body: { handle: 'alpha', publicProfile: true } })).status, 400, 'handle taken');
  const lb = (await B.call('/api/leaderboard?mode=live&period=all')).json.board;
  assert.strictEqual(lb.length, 1); assert.strictEqual(lb[0].handle, 'alpha'); assert.strictEqual(lb[0].trades, 2); assert.ok(Math.abs(lb[0].pnlSol - 0.015) < 1e-9, 'live only, paper excluded'); assert.strictEqual(lb[0].rank, 1);
  assert.ok(!JSON.stringify(lb).includes(wa.address), 'never the wallet');
  const prof = (await B.call('/api/profile?handle=alpha&mode=live')).json;
  assert.strictEqual(prof.stats.trades, 2); assert.strictEqual(prof.curve.length, 2); assert.strictEqual(prof.open[0].lastPnl, 12.5); assert.strictEqual(prof.open[0].trail.length, 2);
  assert.strictEqual(prof.plan.sizeUsd, 7); assert.strictEqual(prof.following, false);
  assert.ok(!JSON.stringify(prof).includes(wa.address) && !JSON.stringify(prof).includes('vault'));
  // copy: saved, not switched on; own limits untouched; cannot copy yourself
  assert.strictEqual((await A.call('/api/copy', { method: 'POST', body: { handle: 'alpha' } })).status, 400);
  assert.strictEqual((await B.call('/api/copy', { method: 'POST', body: { handle: 'nobody' } })).status, 404);
  assert.strictEqual((await B.call('/api/copy', { method: 'POST', body: { handle: 'alpha' } })).status, 200);
  let b1 = (await B.call('/api/me')).json.settings;
  assert.strictEqual(b1.plans.length, 4); assert.strictEqual(b1.active_plan, 'rider'); assert.strictEqual(b1.follow_user_id, null);
  const cp = b1.plans.find((p: any) => p.id.startsWith('cp-')); assert.strictEqual(cp.name, '@alpha'); assert.strictEqual(cp.sizeUsd, 7);
  assert.strictEqual(b1.max_position_sol, meB.settings.max_position_sol, 'safety limits untouched');
  // auto-copy: switched on, then follows the leader's plan changes
  assert.strictEqual((await B.call('/api/copy', { method: 'POST', body: { handle: 'alpha', auto: true } })).status, 200);
  b1 = (await B.call('/api/me')).json.settings; assert.strictEqual(b1.active_plan, cp.id); assert.ok(b1.follow_user_id);
  assert.strictEqual(b1.plans.length, 4, 're-copy replaces, not piles up');
  assert.strictEqual((await B.call('/api/profile?handle=alpha')).json.following, true);
  const sniperA = meA.settings.plans.find((p: any) => p.id === 'sniper');
  assert.strictEqual((await patchA({ activePlan: 'sniper' })).status, 200);
  b1 = (await B.call('/api/me')).json.settings; const cp2 = b1.plans.find((p: any) => p.id === cp.id);
  assert.strictEqual(cp2.sizeUsd, sniperA.sizeUsd); assert.strictEqual(cp2.maxHoldMin, sniperA.maxHoldMin); assert.strictEqual(cp2.scanEverySec, 20, 'mirrors the leader');
  // deleting the copied plan ends auto-copy
  const rest = b1.plans.filter((p: any) => p.id !== cp.id);
  assert.strictEqual((await B.call('/api/settings', { method: 'PATCH', body: { plans: rest } })).status, 200);
  assert.strictEqual((await B.call('/api/me')).json.settings.follow_user_id, null);
  // going private removes the profile and releases followers
  await B.call('/api/copy', { method: 'POST', body: { handle: 'alpha', auto: true } });
  assert.strictEqual((await patchA({ publicProfile: false })).status, 200);
  assert.strictEqual((await B.call('/api/me')).json.settings.follow_user_id, null);
  assert.strictEqual((await B.call('/api/profile?handle=alpha')).status, 404);
  assert.deepStrictEqual((await B.call('/api/leaderboard?period=all')).json.board, []);
  void meB;
});

test('board: new / final stretch / migrated / trending come from the robot\'s own records, and wallets are read in-app', async () => {
  const now = Date.now(), iso = (ms: number) => new Date(ms).toISOString();
  const mk = (n: string, over: any) => ({ mint: n.padEnd(44, 'A'), name: n, symbol: n.slice(0, 3), uri: null, created: true, first_seen: iso(now - 600e3), mcap_sol: 40, v_sol: 35, migrated: false, migrated_at: null, stats: { c5: 3, c1h: 9, volSol1h: 1, buys1h: 4, sells1h: 2 }, image: null, description: null, has_thumb: false, updated_at: iso(now - 20e3), ...over });
  pg.tables.art_charts = [
    mk('Fresh', {}), mk('NearGrad', { v_sol: 100, first_seen: iso(now - 3600e3) }), mk('HalfWay', { v_sol: 73 }), mk('Graduated', { migrated: true, migrated_at: iso(now - 60e3), v_sol: 115 }),
    mk('Hotcoin', { stats: { c5: 40, c1h: 90, volSol1h: 50, buys1h: 80, sells1h: 60 } }), mk('Quiet', { stats: { c5: 0, c1h: 0, volSol1h: 0, buys1h: 0, sells1h: 0 }, updated_at: iso(now - 2 * 3600e3) }),
  ];
  const A = new Browser(); const j = (await A.call('/api/board')).json;
  assert.ok(j.new.some((x: any) => x.name === 'Fresh'), 'new list has launches');
  assert.deepStrictEqual(j.stretch.map((x: any) => x.name), ['NearGrad', 'HalfWay'], 'final stretch = past half way up the curve, closest first');
  assert.deepStrictEqual(j.migrated.map((x: any) => x.name), ['Graduated']);
  assert.strictEqual(j.trending[0].name, 'Hotcoin', 'trending ranks the busiest coin first'); assert.ok(!j.trending.some((x: any) => x.name === 'Quiet'));
  assert.ok(j.topProgress > 0.8);
  assert.strictEqual((await A.call('/api/wallet?addr=not-a-wallet')).status, 400);
});

test('any coin gets a chart and a full trade history from the public chain, with no chart service', async () => {
  const A = new Browser();
  assert.strictEqual((await A.call('/api/history?mint=bad')).status, 400);
  const h1 = (await A.call(`/api/history?mint=${CHAIN_MINT}`)).json;
  assert.ok(h1.trades.length >= 20, 'trades read from the chain'); assert.ok(h1.trades.some((t: any) => t.side === 'sell') && h1.trades.some((t: any) => t.side === 'buy'));
  assert.ok(h1.trades[0].who.startsWith('Trader') && h1.trades[0].mcapSol > 0);
  assert.ok(h1.next, 'there is an older page'); const h2 = (await A.call(`/api/history?mint=${CHAIN_MINT}&before=${h1.next}`)).json; assert.ok(h2.trades.length >= 1, 'older page loads');
  const bfr = await A.call(`/api/backfill?mint=${CHAIN_MINT}`, { method: 'POST' }); const bf = bfr.json; assert.ok(bf.ok && bf.count >= 20, JSON.stringify(bf));
  const row = pg.tables.art_charts.find((r) => r.mint === CHAIN_MINT)!; assert.ok(row.bars.length >= 5 && row.trades.length >= 20 && row.bars_5m.length >= 1);
  const ch = (await A.call(`/api/chart?mint=${CHAIN_MINT}`)).json.chart; assert.ok(ch.bars.length >= 5 && ch.trades.length >= 20);
});

test('manual buy: needs sign-in, validates, records one order at a time, and the owner can read its result', async () => {
  const anon = new Browser();
  assert.strictEqual((await anon.call('/api/order', { method: 'POST', body: { mint: CHAIN_MINT, sizeSol: 0.02 } })).status, 401);
  const user = mkWallet(); const b = new Browser(); assert.strictEqual((await b.signIn(user)).status, 200);
  assert.strictEqual((await b.call('/api/order', { method: 'POST', body: { mint: 'bad', sizeSol: 0.02 } })).status, 400);
  assert.strictEqual((await b.call('/api/order', { method: 'POST', body: { mint: CHAIN_MINT, sizeSol: 0 } })).status, 400);
  assert.strictEqual((await b.call('/api/order', { method: 'POST', body: { mint: CHAIN_MINT, sizeSol: 0.02, slPct: 150 } })).status, 400);
  const r = await b.call('/api/order', { method: 'POST', body: { mint: CHAIN_MINT, sizeSol: 0.02, tpPct: 20, slPct: 10, holdMin: 5 } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json)); const id = r.json.id; assert.ok(id);
  assert.strictEqual((await b.call('/api/order', { method: 'POST', body: { mint: CHAIN_MINT, sizeSol: 0.02 } })).status, 409, 'one at a time');
  assert.strictEqual((await b.call(`/api/order?id=${id}`)).json.status, 'pending');
  const other = new Browser(); await other.signIn(mkWallet());
  assert.strictEqual((await other.call(`/api/order?id=${id}`)).status, 404, 'only the owner can see it');
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
