const test = require('node:test');
const assert = require('node:assert');
const { effectivePlan, sanitizePlan, defaultPlans, activePlan } = require('../src/plans');
const scanner = require('../src/scanner/scanner');
const stream = require('../src/scanner/stream');

test('default minimum trade is $7 and there is no maximum', () => {
  assert.strictEqual(sanitizePlan({}).sizeUsd, 7);
  assert.strictEqual(sanitizePlan({ sizeUsd: 5000 }).sizeUsd, 5000);
  assert.strictEqual(effectivePlan({}, null).sizeUsd, 7);
  assert.strictEqual(effectivePlan({ plans: [{ id: 'x', name: 'Big', sizeUsd: 25000 }], active_plan: 'x' }, null).sizeUsd, 25000);
});
test('plans are sanitised: ranges clamp, bad max age is dropped, names trimmed', () => {
  const p = sanitizePlan({ name: '  ' + 'x'.repeat(40), minAgeSec: 100, maxAgeSec: 50, stopLossPct: 500, scanEverySec: 1, sizeUsd: -3, minLiqUsd: 'abc' });
  assert.strictEqual(p.name.length, 24); assert.strictEqual(p.maxAgeSec, null); assert.strictEqual(p.stopLossPct, 95);
  assert.strictEqual(p.scanEverySec, 10); assert.strictEqual(p.sizeUsd, 1); assert.strictEqual(p.minLiqUsd, 8000);
});
test('the active plan is the one the user switched to; unknown id falls back to the first (Rider)', () => {
  const plans = defaultPlans();
  assert.strictEqual(activePlan({ plans, active_plan: 'sniper' }).name, 'Sniper');
  assert.strictEqual(activePlan({ plans, active_plan: 'nope' }).name, 'Rider');
  assert.strictEqual(activePlan({}).name, 'Rider');
});
test('safety limits still can only tighten', () => {
  const p = effectivePlan({ max_position_sol: 5, max_daily_loss_pct: 90, max_concurrent: 9 }, { maxPositionSol: 0.3, maxDailyLossPct: 15, maxConcurrent: 2 });
  assert.deepStrictEqual([p.maxPositionSol, p.maxDailyLossPct, p.maxConcurrent], [0.3, 15, 2]);
});
const base = { priceNative: 1, liquidityUsd: 20000, volume1h: 5000, volume6h: 9000, priceChange5m: 1, priceChange1h: 5, priceChange6h: 5, priceChange24h: 1, buys1h: 30, sells1h: 10, pairCreatedAt: 1 };
test('the age window works down to seconds, with an optional upper bound', () => {
  const plan = sanitizePlan({ minAgeSec: 30, maxAgeSec: 600, minLiqUsd: 4000, minVol1hUsd: 500, minBuys1h: 5, requireRising: false });
  assert.strictEqual(scanner.scoreChart({ ...base, ageSec: 10 }, plan), -Infinity, 'too young');
  assert.ok(scanner.scoreChart({ ...base, ageSec: 45 }, plan) > 0);
  assert.strictEqual(scanner.scoreChart({ ...base, ageSec: 3600 }, plan), -Infinity, 'too old');
  const open = sanitizePlan({ minAgeSec: 86400, maxAgeSec: null });
  assert.ok(scanner.scoreChart({ ...base, ageSec: 86400 * 400 }, open) > 0, 'no max = unlimited');
});
test('requireRising can be switched off for brand-new coins', () => {
  const flat = { ...base, ageSec: 60, priceChange1h: 0, priceChange6h: 0 };
  assert.strictEqual(scanner.scoreChart(flat, sanitizePlan({ minAgeSec: 0, requireRising: true })), -Infinity);
  assert.ok(scanner.scoreChart(flat, sanitizePlan({ minAgeSec: 0, requireRising: false })) > -Infinity);
});
test('the live stream remembers new and migrated mints and filters by age window', () => {
  stream._feed({ txType: 'create', mint: 'MintA' + 'x'.repeat(30), name: 'A' });
  stream._feed({ txType: 'migrate', mint: 'MintB' + 'x'.repeat(30) });
  stream._feed({ txType: 'buy', mint: 'Ignored' });
  assert.strictEqual(stream.size(), 2);
  assert.strictEqual(stream.recent(0, 60).length, 2);
  assert.strictEqual(stream.recent(3600, null).length, 0, 'nothing is an hour old yet');
});

test('agent settings are sanitised: unknown patterns, odd timeframes and backwards market-cap ranges are pulled back', () => {
  const { sanitizePlan, HUNTER, sanitizeAgent } = require('../src/planrules');
  const a = sanitizeAgent({ enabled: 1, pattern: 'rug_pull', tfSec: 7, mcapMinUsd: 50000, mcapMaxUsd: 1000, tolerancePct: 99, minDropPct: -5, trigger: 'x', lookbackBars: 5, volMult: 0 });
  assert.strictEqual(a.enabled, true); assert.strictEqual(a.pattern, 'double_bottom'); assert.strictEqual(a.tfSec, 15); assert.strictEqual(a.mcapMaxUsd, null, 'max below min is dropped');
  assert.strictEqual(a.tolerancePct, 25); assert.strictEqual(a.minDropPct, 5); assert.strictEqual(a.trigger, 'confirm'); assert.strictEqual(a.lookbackBars, 20); assert.strictEqual(a.volMult, 1.5);
  const p = sanitizePlan({ ...HUNTER, agent: { ...HUNTER.agent, mcapMinUsd: 12000, mcapMaxUsd: 90000, tfSec: 60, pattern: 'breakout' } });
  assert.strictEqual(p.agent.enabled, true); assert.strictEqual(p.agent.mcapMinUsd, 12000); assert.strictEqual(p.agent.tfSec, 60); assert.strictEqual(p.agent.pattern, 'breakout');
  assert.strictEqual(sanitizePlan({ name: 'plain' }).agent.enabled, false, 'ordinary plans carry a switched-off agent');
});
