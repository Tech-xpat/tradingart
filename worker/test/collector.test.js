const test = require('node:test');
const assert = require('node:assert');
process.env.STREAM_ENABLED = 'false';
const collector = require('../src/data/collector');
const stream = require('../src/scanner/stream');
const M = 'MintMintMintMintMintMintMintMintMintMint1';

test('live feed messages become candles, and the robot reads market data built from them', () => {
  collector._reset();
  stream._feed({ txType: 'create', mint: M, name: 'Coin', symbol: 'CN', uri: 'ipfs://x', marketCapSol: 30, vSolInBondingCurve: 30, solAmount: 1 });
  stream._feed({ txType: 'buy', mint: M, marketCapSol: 36, vSolInBondingCurve: 33, solAmount: 3 });
  stream._feed({ txType: 'sell', mint: M, marketCapSol: 33, vSolInBondingCurve: 32, solAmount: 1 });
  assert.ok(collector.has(M)); const bars = collector.barsFor(M); assert.ok(bars.length >= 1);
  assert.strictEqual(bars[bars.length - 1][4], 33); assert.strictEqual(Math.max(...bars.map((b) => b[2])), 36);
  collector.setSolUsd(200);
  const mk = collector.marketFor(M);
  assert.ok(mk); assert.strictEqual(mk.marketCapUsd, 33 * 200); assert.ok(Math.abs(mk.priceNative - 33 / 1e9) < 1e-18);
  assert.strictEqual(mk.buys1h, 2); assert.strictEqual(mk.sells1h, 1); assert.ok(mk.ageSec < 5); assert.strictEqual(mk.source, 'own');
  assert.strictEqual(collector.marketFor('nope'), null);
});

test('a coin we never saw being created has no trusted age, so the caller falls back to another source', () => {
  collector._reset();
  collector.onMessage({ txType: 'buy', mint: M, marketCapSol: 50, solAmount: 1 });
  assert.ok(collector.barsFor(M).length === 1 && collector.marketFor(M) === null);
});

test('flush saves the busiest coins in one batch and keeps unsaved ones dirty when the save fails', async () => {
  collector._reset();
  collector.onMessage({ txType: 'create', mint: M, name: 'A', marketCapSol: 30, solAmount: 1 });
  let saved = null; const db = { saveCharts: async (rows) => { saved = rows; } };
  assert.strictEqual(await collector.flush(db), 1); assert.strictEqual(saved[0].mint, M); assert.ok(Array.isArray(saved[0].bars));
  assert.strictEqual(await collector.flush(db), 0, 'nothing new to save');
  collector.onMessage({ txType: 'buy', mint: M, marketCapSol: 31, solAmount: 1 });
  assert.strictEqual(await collector.flush({ saveCharts: async () => { throw new Error('no table'); } }), 0);
  assert.strictEqual(await collector.flush(db), 1, 'retried after the failed save');
});

test('trade price falls back to sol/token when the feed omits market cap', () => {
  collector._reset();
  collector.onMessage({ txType: 'create', mint: M, marketCapSol: 30, solAmount: 1 });
  collector.onMessage({ txType: 'buy', mint: M, solAmount: 2, tokenAmount: 50_000_000 });
  assert.ok(Math.abs(collector.barsFor(M).slice(-1)[0][4] - 40) < 1e-9);
});

test('coarser candle tiers are kept for the zoomed-out chart views', () => {
  collector._reset();
  collector.onMessage({ txType: 'create', mint: 'T1', name: 'T', symbol: 'T', marketCapSol: 30, vSolInBondingCurve: 31, solAmount: 1 });
  for (let i = 0; i < 5; i++) collector.onMessage({ txType: 'buy', mint: 'T1', marketCapSol: 31 + i, vSolInBondingCurve: 32, solAmount: 1 });
  const rows = []; return collector.flush({ saveCharts: async (r) => rows.push(...r) }).then(() => {
    assert.strictEqual(rows[0].bars_1m.length, 0, 'tiny coins do not store tiers'); collector._reset();
  });
});
