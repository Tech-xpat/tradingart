const test = require('node:test');
const assert = require('node:assert');
const c = require('../src/charting');

// build bars straight from a list of closes (one bar each, 5 s apart)
const mk = (closes, v = 1) => { const bars = []; closes.forEach((p, i) => c.addTrade(bars, { t: 1000 + i * 5, p, v, side: i % 2 ? 'sell' : 'buy' })); return bars; };
const path = (...legs) => { const out = []; let p = legs[0]; out.push(p); for (let i = 1; i < legs.length; i += 2) { const to = legs[i + 1], n = legs[i]; for (let s = 1; s <= n; s++) out.push(p + ((to - p) * s) / n); p = to; } return out; };

test('trades build 5-second candles; late trades only touch their own bar; resample combines', () => {
  const bars = [];
  c.addTrade(bars, { t: 1002, p: 10, v: 1, side: 'buy' }); c.addTrade(bars, { t: 1003, p: 12, v: 2, side: 'sell' }); c.addTrade(bars, { t: 1004, p: 9, v: 1, side: 'buy' });
  assert.deepStrictEqual(bars, [[1000, 10, 12, 9, 9, 4, 2, 1]]);
  c.addTrade(bars, { t: 1007, p: 11, v: 1, side: 'buy' });
  assert.strictEqual(bars.length, 2); assert.strictEqual(bars[1][1], 9, 'opens at the previous close');
  c.addTrade(bars, { t: 1001, p: 20, v: 1, side: 'buy' }); // late: raises bar 1 high, does not change the close
  assert.strictEqual(bars[0][2], 20); assert.strictEqual(bars[1][4], 11);
  const r = c.resample(bars, 60); assert.strictEqual(r.length, 1); assert.strictEqual(r[0][2], 20); assert.strictEqual(r[0][4], 11); assert.strictEqual(r[0][5], 6);
  assert.strictEqual(c.addTrade(bars, { t: 1, p: 0 }).length, 2, 'zero or bad prices are ignored');
});

test('double bottom: found on a textbook shape; refused when lows differ, no bounce, or the low is broken', () => {
  // 100 -> 60 (first low) -> 80 (neckline) -> 61 (second low) -> 66 (turning up)
  const good = mk(path(100, 12, 60, 8, 80, 8, 61, 5, 66));
  const r = c.doubleBottom(good, { tolerancePct: 6, minDropPct: 25, bouncePct: 8, confirmPct: 2 });
  assert.ok(r.match, r.reason); assert.ok(r.levels.neckline >= 79); assert.strictEqual(r.idx.length, 2);
  assert.ok(c.detect('double_bottom', good, {}).match);
  const different = mk(path(100, 12, 60, 8, 80, 8, 45, 5, 52));
  assert.ok(!c.doubleBottom(different).match, 'second low far below the first is not a double bottom');
  const noBounce = mk(path(100, 12, 60, 8, 62, 8, 61, 5, 66));
  assert.ok(!c.doubleBottom(noBounce).match, 'no bounce between the lows');
  const broken = mk(path(100, 12, 60, 8, 80, 8, 61, 4, 66, 4, 50));
  assert.ok(!c.doubleBottom(broken).match, 'price fell below the second low again');
  const tight = c.doubleBottom(mk(path(100, 12, 60, 8, 80, 8, 63, 5, 69)), { tolerancePct: 2 });
  assert.ok(!tight.match, 'tolerance is respected');
  assert.ok(!c.doubleBottom(mk([1, 2, 3])).match, 'too few candles');
});

test('double bottom trigger modes: confirm enters before the neckline, neckline waits for the break', () => {
  const beforeNeck = mk(path(100, 12, 60, 8, 80, 8, 61, 5, 68));
  assert.ok(c.doubleBottom(beforeNeck, { trigger: 'confirm' }).match);
  assert.ok(!c.doubleBottom(beforeNeck, { trigger: 'neckline' }).match);
  const above = mk(path(100, 12, 60, 8, 80, 8, 61, 6, 82));
  assert.ok(c.doubleBottom(above, { trigger: 'neckline' }).match);
  assert.ok(!c.doubleBottom(above, { trigger: 'confirm' }).match, 'confirm mode does not chase a price already above the neckline');
});

test('breakout, dip buy and volume spike', () => {
  const flat = Array.from({ length: 30 }, (_, i) => 50 + (i % 3));
  const b = mk([...flat, 60]); b[b.length - 1][5] = 30; // big volume on the break
  assert.ok(c.breakout(b, { volMult: 3 }).match);
  const quiet = mk([...flat, 60]); assert.ok(!c.breakout(quiet, { volMult: 3 }).match, 'no volume surge');
  const dip = mk(path(100, 10, 60, 4, 66)); assert.ok(c.dipBuy(dip, { minDropPct: 25 }).match);
  assert.ok(!c.dipBuy(mk(path(100, 10, 90, 3, 92)), { minDropPct: 25 }).match, 'small dip is not enough');
  const vs = mk([...flat, 55]); vs[vs.length - 1][5] = 20; assert.ok(c.volumeSpike(vs, { volMult: 4 }).match);
  assert.ok(!c.detect('nope', vs).match);
});

test('mergeBars lets newer data win per bucket and keeps order', () => {
  const m = c.mergeBars([[0, 1, 1, 1, 1, 1, 0, 0], [5, 1, 1, 1, 1, 1, 0, 0]], [[5, 2, 2, 2, 2, 9, 0, 0], [10, 3, 3, 3, 3, 1, 0, 0]]);
  assert.deepStrictEqual(m.map((b) => b[0]), [0, 5, 10]); assert.strictEqual(m[1][5], 9);
});

test('momentum: buys a coin that is climbing with buyers in control; refuses flat, too-late, red and seller-heavy coins', () => {
  const up = []; // 12 flat-ish candles, then a steady climb of ~8%, all buys
  const closes = [100, 100, 101, 100, 101, 100, 101, 100, 102, 104, 106, 108];
  closes.forEach((p, i) => c.addTrade(up, { t: 1000 + i * 5, p, v: 1, side: 'buy' }));
  const r = c.momentum(up, { confirmPct: 3, maxRisePct: 60 });
  assert.ok(r.match, r.reason);
  assert.ok(!c.momentum(mk([100, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101]), { confirmPct: 3 }).match, 'flat');
  assert.ok(!c.momentum(up, { confirmPct: 3, maxRisePct: 5 }).match, 'already up too much');
  const sells = []; closes.forEach((p, i) => c.addTrade(sells, { t: 1000 + i * 5, p, v: 1, side: 'sell' }));
  assert.ok(!c.momentum(sells, { confirmPct: 3 }).match, 'sellers');
  assert.ok(!c.momentum(up.slice(0, 5), {}).match, 'too few candles');
});
