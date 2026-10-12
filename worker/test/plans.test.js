const test = require('node:test');
const assert = require('node:assert');
const { PRESETS, effectivePlan } = require('../src/plans');

test('each mode has the agreed minimum trade size in USD', () => {
  assert.deepStrictEqual([PRESETS.easy.sizeUsd, PRESETS.medium.sizeUsd, PRESETS.hard.sizeUsd], [5, 10, 20]);
});
test('with no custom size the plan uses the mode minimum', () => {
  for (const [mode, usd] of [['easy', 5], ['medium', 10], ['hard', 20]]) assert.strictEqual(effectivePlan({ mode }, null).sizeUsd, usd);
});
test('a user may raise the size, but never go below the mode minimum, and the platform cap applies', () => {
  assert.strictEqual(effectivePlan({ mode: 'medium', size_usd: 35 }, null).sizeUsd, 35);
  assert.strictEqual(effectivePlan({ mode: 'hard', size_usd: 7 }, null).sizeUsd, 20, 'below the minimum is lifted to it');
  assert.strictEqual(effectivePlan({ mode: 'easy', size_usd: 100000 }, null).sizeUsd, 100, 'platform cap');
});
test('the SOL spend cap still wins over a large USD size', () => {
  const p = effectivePlan({ mode: 'easy', size_usd: 80, max_position_sol: 0.05 }, { maxPositionSol: 0.04 });
  assert.strictEqual(p.maxPositionSol, 0.04);
});
