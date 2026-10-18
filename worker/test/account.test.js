const test = require('node:test');
const assert = require('node:assert');
process.env.LIVE_TRADING_ENABLED = 'false';
const config = require('../src/config');
const { Account } = require('../src/trading/account');
const { effectivePlan } = require('../src/plans');

const MINT = 'MintMintMintMintMintMintMintMintMintMint1';
function fakeDeps({ price = { v: 0.001 } } = {}) {
  const state = new Map(); const trades = [];
  return {
    trades, state,
    db: {
      async getState(u, k) { return state.get(u + k) || null; },
      async setState(u, k, v) { state.set(u + k, JSON.parse(JSON.stringify(v))); },
      async insertTrade(r) { trades.push(r); },
    },
    market: { async getTokenMarket() { return { priceNative: price.v, liquidityUsd: 50000, ageDays: 30, volume1h: 9000, priceChange1h: 5, priceChange6h: 6, buys1h: 40 }; } },
    chain: { async getMintInfo() { return { mintAuthority: null, freezeAuthority: null, decimals: 6 }; }, async getSolLamports() { return 0n; }, async getSolBalance() { return 0; }, async getTokenBalance() { return { raw: 0n } } },
    swap: { async buy() { throw new Error('LIVE BUY MUST NOT HAPPEN IN PAPER'); }, async sellAll() { throw new Error('LIVE SELL MUST NOT HAPPEN IN PAPER'); } },
    fills: {},
    scanner: { async fetchSolPriceUsd() { return 200; } },
    price,
  };
}
const settings = (o = {}) => ({ mode: 'medium', paused: false, live: false, max_position_sol: 0.05, max_daily_loss_pct: 20, max_concurrent: 1, panic_at: null, ...o });
const mk = (deps, o = {}) => new Account({ userId: 'u1', wallet: 'WALLETWALLETWALLETWALLETWALLETWALLETWALLETW1', vaultAddress: o.vault || null, settings: o.settings || settings(), consent: o.consent ?? null, deps, unseal: () => { throw new Error('no key'); }, notify: o.notify || (() => {}) });

test('a user can only tighten limits, never loosen them past consent or platform caps', () => {
  const p = effectivePlan(settings({ mode: 'hard', max_position_sol: 5, max_daily_loss_pct: 90, max_concurrent: 9 }), { maxPositionSol: 0.1, maxDailyLossPct: 15, maxConcurrent: 2 });
  assert.strictEqual(p.maxPositionSol, 0.1); assert.strictEqual(p.maxDailyLossPct, 15); assert.strictEqual(p.maxConcurrent, 2);
  const q = effectivePlan(settings({ mode: 'hard', max_position_sol: 5, max_daily_loss_pct: 90, max_concurrent: 9 }), null);
  assert.ok(q.maxDailyLossPct <= config.CAP_MAX_DAILY_LOSS_PCT && q.maxConcurrent <= config.CAP_MAX_CONCURRENT);
  assert.strictEqual(q.maxPositionSol, 5, 'no platform cap by default: the user setting stands');
});

test('live is impossible while the platform switch is off, even if the user chose live and has a vault + consent', () => {
  const a = mk(fakeDeps(), { settings: settings({ live: true }), vault: 'VAULT', consent: { maxPositionSol: 0.05, maxDailyLossPct: 20, maxConcurrent: 1 } });
  assert.strictEqual(a.liveAllowed, false); assert.strictEqual(a.entryBook().paper, true);
});

test('live needs consent: with the switch on but no consent it stays paper', () => {
  config.LIVE_TRADING_ENABLED = true;
  try {
    const noConsent = mk(fakeDeps(), { settings: settings({ live: true }), vault: 'VAULT', consent: null });
    assert.strictEqual(noConsent.liveAllowed, false);
    const noVault = mk(fakeDeps(), { settings: settings({ live: true }), vault: null, consent: { maxPositionSol: 0.05 } });
    assert.strictEqual(noVault.liveAllowed, false);
    const ok = mk(fakeDeps(), { settings: settings({ live: true }), vault: 'VAULT', consent: { maxPositionSol: 0.05, maxDailyLossPct: 20, maxConcurrent: 1 } });
    assert.strictEqual(ok.liveAllowed, true);
  } finally { config.LIVE_TRADING_ENABLED = false; }
});

test('paper trade: enter, take profit, close, record a trade, balance moves', async () => {
  const d = fakeDeps(); const msgs = []; const a = mk(d, { notify: (t) => msgs.push(t) });
  const r = await a.offer(MINT, 'scanner:50');
  assert.ok(r.ok, r.why); assert.strictEqual(a.openCount(), 1);
  assert.ok(r.pos.sizeSol > 0 && r.pos.sizeSol <= 0.05 + 1e-9, 'respects the per-trade cap');
  const bal0 = a.books.paper.daily.paperBalanceSol;
  d.price.v = 0.001 * 2; // +100% > TP 60% for medium
  await a.monitorTick(); await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(a.openCount(), 0);
  assert.strictEqual(d.trades.length, 1); assert.strictEqual(d.trades[0].paper, true); assert.strictEqual(d.trades[0].exit_reason, 'take_profit');
  assert.ok(a.books.paper.daily.paperBalanceSol > bal0);
  assert.ok(msgs.some((m) => m.includes('EXIT') && m.includes('PAPER')));
});

test('stop loss exits; the daily loss limit then blocks new entries', async () => {
  const d = fakeDeps(); const a = mk(d, { settings: settings({ max_daily_loss_pct: 1, max_position_sol: 0.12 }) });
  assert.ok((await a.offer(MINT, 'scanner:50')).ok);
  d.price.v = 0.001 * 0.5; await a.monitorTick(); await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(d.trades[0].exit_reason, 'stop_loss'); assert.ok(d.trades[0].realized_sol < 0);
  const again = await a.offer('Other1111111111111111111111111111111111111', 'scanner:50');
  assert.ok(!again.ok); assert.match(again.why, /daily loss/);
});

test('paused accounts never enter, but open trades still exit', async () => {
  const d = fakeDeps(); const a = mk(d);
  assert.ok((await a.offer(MINT, 'scanner:50')).ok);
  a.update(settings({ paused: true }), null);
  assert.ok(!(await a.offer('Other1111111111111111111111111111111111111', 'x')).ok);
  d.price.v = 0.01; await a.monitorTick(); await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(a.openCount(), 0);
});

test('max concurrent is enforced and panic closes everything once per request', async () => {
  const d = fakeDeps(); const a = mk(d, { settings: settings({ max_concurrent: 1 }) });
  assert.ok((await a.offer(MINT, 'scanner:50')).ok);
  assert.strictEqual((await a.offer('Other1111111111111111111111111111111111111', 'x')).why, 'max concurrent');
  const t = Date.now() + 1000;
  assert.strictEqual(a.handlePanic(t), 1); await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(a.openCount(), 0);
  assert.strictEqual(a.handlePanic(t), 0, 'same request is not replayed');
});

test('positions survive a restart (state saved, reloaded by a new Account)', async () => {
  const d = fakeDeps(); const a = mk(d);
  assert.ok((await a.offer(MINT, 'scanner:50')).ok); await new Promise((r) => setTimeout(r, 30));
  const b = mk(d); await b.load();
  assert.strictEqual(b.openCount(), 1);
});

test('two users never share positions or balances', async () => {
  const d = fakeDeps(); const a = mk(d); const b = new Account({ userId: 'u2', wallet: 'W2W2W2W2W2W2W2W2W2W2W2W2W2W2W2W2W2W2W2', settings: settings(), consent: null, deps: d, unseal: () => {}, notify: () => {} });
  assert.ok((await a.offer(MINT, 'scanner:50')).ok);
  await b.load(); assert.strictEqual(b.openCount(), 0);
  assert.strictEqual(b.books.paper.daily.paperBalanceSol, config.PAPER_BALANCE_SOL);
});

test('open trades keep a fresh up/down value and a progress trail in the stored state (live and paper alike)', async () => {
  const deps = fakeDeps();
  const a = mk(deps);
  const book = a.entryBook();
  book.open.set(MINT, { mint: MINT, openedAt: Date.now(), dryRun: true, status: 'open', costLamports: '1000000000', tokenRaw: '1000000000', decimals: 6, takeProfitPct: 500, stopLossPct: 90, maxHoldMin: 60, priceMisses: 0 });
  deps.price.v = 0.001; // pnl is relative to the cost, whatever the price is
  await book.monitorTick();
  const saved = await deps.db.getState('u1', book.key('positions'));
  assert.strictEqual(saved.length, 1);
  assert.ok(Number.isFinite(saved[0].lastPnl), 'lastPnl is persisted every tick');
  assert.strictEqual(saved[0].trail.length, 1);
  await book.monitorTick(); // inside 4s: no extra sample, trail does not balloon
  assert.strictEqual(book.open.get(MINT).trail.length, 1);
  for (let i = 0; i < 200; i++) book.trail(book.open.get(MINT), i);
  assert.ok(book.open.get(MINT).trail.length <= 150);
});

test('a $5 vault can trade: size shrinks to fit, fee reserve is small, and the live minimum is low', async () => {
  const deps = fakeDeps();
  deps.chain.getSolBalance = async () => 0.0275; // about $5 at $180 per SOL
  deps.scanner.fetchSolPriceUsd = async () => 180;
  const a = mk(deps, { vault: 'VAULT', consent: { maxPositionSol: 0.05, maxDailyLossPct: 20, maxConcurrent: 1 } });
  assert.ok(config.MIN_VAULT_SOL <= 0.02, 'live minimum must allow a $5 vault');
  const sol = await a.books.live.sizeSol();
  assert.ok(sol >= config.MIN_POSITION_SOL, `size ${sol} must clear the minimum`);
  assert.ok(sol <= 0.0275 - config.SOL_FEE_RESERVE + 1e-9, 'never spends the fee reserve');
  assert.ok(0.0275 >= config.MIN_VAULT_SOL, 'passes the vault minimum');
});

test('every scan leaves a plain-language status, and says why live is not running', async () => {
  const saved = {};
  const deps = fakeDeps(); deps.db.setState = async (u, k, v) => { saved[k] = v; };
  const a = mk(deps, { settings: settings({ live: true }), vault: 'VAULT', consent: null });
  assert.match(a.liveBlock(), /LIVE_TRADING_ENABLED|signed limits/);
  a.noteScan({ candidates: 12, matched: 0, outcome: 'none matched your plan this round' });
  assert.strictEqual(saved.status.candidates, 12); assert.strictEqual(saved.status.book, 'paper'); assert.ok(saved.status.note);
});

test('live buy retries with a higher fee after a dropped tx, and never double-buys', async () => {
  const deps = fakeDeps(); const calls = [];
  deps.chain.getSolLamports = async () => 1_000_000_000n;
  deps.swap = {
    async buy(_s, _m, _sol, attempt) {
      calls.push(attempt);
      if (attempt === 1) { const e = new Error('not confirmed'); e.signature = 'SIG1'; e.timedOut = true; throw e; }
      return 'SIG2';
    },
    async waitForSignature() { return { ok: false, reason: 'never landed (tx expired)' }; },
  };
  deps.fills = { async readFill() { return { failed: false, tokenDeltaRaw: 5000n, decimals: 6, solDeltaLamports: -50_000_000n }; } };
  const a = mk(deps, { vault: 'VAULT' }); a.getSigner = async () => ({});
  const r = await a.books.live.liveBuy(MINT, 0.05);
  assert.deepStrictEqual(calls, [1, 2]); assert.strictEqual(r.signature, 'SIG2');
  // if the first one actually landed late, the second is never sent
  calls.length = 0;
  deps.chain.getTokenBalance = async () => ({ raw: 9n, decimals: 6 });
  const r2 = await a.books.live.liveBuy(MINT, 0.05);
  assert.deepStrictEqual(calls, [1]); assert.strictEqual(r2.signature, 'SIG1');
});
