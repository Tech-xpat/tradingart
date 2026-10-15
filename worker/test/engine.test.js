const test = require('node:test');
const assert = require('node:assert');
const { Engine } = require('../src/engine');

const MINT = 'MintMintMintMintMintMintMintMintMintMint1';
function mkEngine(users) {
  const state = new Map(); const sent = []; const picks = [];
  const settings = users.map((u) => ({ user_id: u.id, plans: u.plans, active_plan: u.plan, paused: !!u.paused, live: false, max_position_sol: 0.05, max_daily_loss_pct: 20, max_concurrent: 1, panic_at: u.panic_at || null }));
  const db = {
    async settingsRunning() { return settings.filter((s) => !s.paused); },
    async usersWithOpenPositions() { return [...state.entries()].filter(([k, v]) => k.endsWith('positions') && v.length).map(([k]) => k.split('|')[0]); },
    async settingsFor(ids) { return settings.filter((s) => ids.includes(s.user_id)); },
    async users(ids) { return new Map(users.filter((u) => ids.includes(u.id)).map((u) => [u.id, { id: u.id, wallet: u.id + 'W'.repeat(30), tg_chat_id: u.chat }])); },
    async vaults() { return new Map(); }, async consents() { return new Map(); },
    async getState(u, k) { return state.get(u + '|' + k) || null; }, async setState(u, k, v) { state.set(u + '|' + k, JSON.parse(JSON.stringify(v))); },
    async insertTrade() {},
  };
  const price = { v: 0.001 };
  const deps = {
    db,
    market: { async getTokenMarket() { return { priceNative: price.v, liquidityUsd: 50000, ageDays: 30, volume1h: 9000, buys1h: 40 }; } },
    chain: { async getMintInfo() { return { mintAuthority: null, freezeAuthority: null }; } },
    swap: {}, fills: {},
    scanner: { async fetchSolPriceUsd() { return 200; }, async pickOne(plan, key) { picks.push(key); return { mint: MINT, score: 42, mkt: {} }; } },
  };
  const eng = new Engine({ db, deps, unsealSecret: () => { throw new Error('no'); }, send: (chat, text) => sent.push([chat, text]) });
  return { eng, sent, picks, price, state };
}

test('each running account scans on its own plan and keeps its own state', async () => {
  const { eng, sent, picks } = mkEngine([{ id: 'a', chat: 1 }, { id: 'b', chat: 2, plan: 'sniper' }, { id: 'p', paused: true, chat: 4 }]);
  await eng.sync();
  assert.strictEqual(eng.accounts.size, 2, 'paused user with no open trades is not loaded');
  assert.strictEqual(eng.accounts.get('a').plan.name, 'Steady'); assert.strictEqual(eng.accounts.get('b').plan.name, 'Sniper');
  await eng.scanTick();
  assert.deepStrictEqual(picks.sort(), ['a', 'b'], 'one scan per running account, none for the paused one');
  assert.deepStrictEqual(sent.map((s) => s[0]).sort(), [1, 2]);
  assert.ok(sent.every((s) => /ENTERED/.test(s[1]) && /PAPER/.test(s[1])));
  assert.ok(/plan Sniper/.test(sent.find((s) => s[0] === 2)[1]));
  await eng.scanTick(); assert.strictEqual(picks.length, 2, 'each plan scan interval respected');
});

test('a user who pauses keeps being monitored until flat; panic closes their trades', async () => {
  const u = { id: 'a', chat: 1 };
  const { eng, sent, price } = mkEngine([u]);
  await eng.sync(); await eng.scanTick();
  assert.strictEqual(eng.accounts.get('a').openCount(), 1);
  // user pauses + hits panic
  const acct = eng.accounts.get('a'); acct.update({ ...acct.settings, paused: true }, null);
  eng.db.settingsRunning = async () => [];
  const s = (await eng.db.settingsFor(['a']))[0]; s.paused = true; s.panic_at = new Date(Date.now() + 1000).toISOString();
  await eng.sync();
  assert.ok(eng.accounts.has('a'), 'still tracked: it has an open trade');
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(eng.accounts.get('a').openCount(), 0);
  assert.ok(sent.some((x) => /Stop and sell all/.test(x[1])) && sent.some((x) => /EXIT/.test(x[1])));
  await eng.sync(); assert.ok(!eng.accounts.has('a'), 'dropped once flat and paused');
  void price;
});
