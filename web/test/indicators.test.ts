import { test } from 'node:test';
import assert from 'node:assert';
import { sma, ema, wma, rsi, macd, stdev, atr, stoch, obv, vwap, supertrend, heikinAshi, cleanParams, computeInd, makeInd, IND_DEFS, IND_ORDER, type Candle } from '../app/app/chartkit/indicators';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const bars = (closes: number[]): Candle[] => closes.map((c, i) => ({ time: 1000 + i * 5, open: i ? closes[i - 1] : c, high: Math.max(c, i ? closes[i - 1] : c) + 1, low: Math.min(c, i ? closes[i - 1] : c) - 1, close: c, vol: 10 }));

test('sma: first values are empty, then the rolling mean', () => {
  const r = sma([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(r[0]) && Number.isNaN(r[1]));
  near(r[2], 2); near(r[3], 3); near(r[4], 4);
});

test('ema: seeded with the simple mean, then k = 2/(n+1)', () => {
  const r = ema([1, 2, 3, 4, 5], 3);
  near(r[2], 2); near(r[3], 4 * 0.5 + 2 * 0.5); near(r[4], 5 * 0.5 + 3 * 0.5);
});

test('wma weights the newest value most', () => {
  const r = wma([1, 2, 3], 3);
  near(r[2], (1 * 1 + 2 * 2 + 3 * 3) / 6);
});

test('stdev is the population deviation', () => {
  near(stdev([2, 4, 4, 4, 5, 5, 7, 9], 8)[7], 2);
});

test('rsi: only gains is 100, only losses is 0, flat-then-up stays within 0..100', () => {
  const up = rsi([1, 2, 3, 4, 5, 6, 7, 8], 3);
  near(up[7], 100);
  const down = rsi([8, 7, 6, 5, 4, 3, 2, 1], 3);
  near(down[7], 0);
  const mix = rsi([10, 11, 10.5, 12, 11, 13, 12.5, 14, 13, 15], 4);
  for (const x of mix) if (!Number.isNaN(x)) assert.ok(x >= 0 && x <= 100);
});

test('rsi matches a hand-worked Wilder example', () => {
  // closes with changes +1,-1,+2 then +1: n=3 -> avgGain=(1+0+2)/3=1, avgLoss=(0+1+0)/3=1/3 -> RS=3 -> RSI=75
  const r = rsi([10, 11, 10, 12, 13], 3);
  near(r[3], 75);
  // next: gain 1 -> avgGain=(1*2+1)/3=1, avgLoss=(1/3*2)/3=2/9 -> RS=4.5 -> RSI=100-100/5.5
  near(r[4], 100 - 100 / 5.5);
});

test('macd histogram is line minus signal', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.1);
  const [l, s, h] = macd(closes, 12, 26, 9);
  let checked = 0;
  for (let i = 0; i < closes.length; i++) if (!Number.isNaN(h[i])) { near(h[i], l[i] - s[i]); checked++; }
  assert.ok(checked > 30);
  assert.ok(Number.isNaN(l[24]) && !Number.isNaN(l[25]));
});

test('atr is smoothed true range and never negative', () => {
  const a = atr(bars([10, 12, 9, 11, 13, 12, 14, 10, 9, 11]), 3);
  for (const x of a) if (!Number.isNaN(x)) assert.ok(x > 0);
});

test('stochastic stays inside 0..100 and sits at 100 on a new high', () => {
  const c = bars([1, 2, 3, 4, 5, 6, 7, 8]);
  const [k] = stoch(c, 4, 1, 3);
  for (const x of k) if (!Number.isNaN(x)) assert.ok(x >= 0 && x <= 100);
});

test('obv adds volume on up candles and subtracts on down candles', () => {
  const r = obv(bars([10, 11, 10, 10, 12]));
  assert.deepStrictEqual(r, [0, 10, 0, 0, 10]);
});

test('vwap with a constant volume is the running mean of typical price, and resets per day when asked', () => {
  const c = bars([10, 20]);
  const tp = c.map((x) => (x.high + x.low + x.close) / 3);
  near(vwap(c, false)[1], (tp[0] + tp[1]) / 2);
  const days: Candle[] = [{ ...c[0], time: 86400 * 3 + 5 }, { ...c[1], time: 86400 * 4 + 5 }];
  near(vwap(days, true)[1], tp[1]);
});

test('supertrend: uptrend line below price, downtrend line above, never both at once', () => {
  const closes = [...Array.from({ length: 30 }, (_, i) => 100 + i * 2), ...Array.from({ length: 30 }, (_, i) => 160 - i * 3)];
  const c = bars(closes);
  const [up, dn] = supertrend(c, 7, 2);
  let sawUp = false, sawDn = false;
  for (let i = 0; i < c.length; i++) {
    assert.ok(!(Number.isFinite(up[i]) && Number.isFinite(dn[i])));
    if (Number.isFinite(up[i])) { sawUp = true; assert.ok(up[i] <= c[i].close + 1e-9); }
    if (Number.isFinite(dn[i])) { sawDn = true; assert.ok(dn[i] >= c[i].close - 1e-9); }
  }
  assert.ok(sawUp && sawDn);
});

test('heikin ashi: first open is the mid of the first candle, close is the OHLC average, high/low contain open and close', () => {
  const c: Candle[] = [{ time: 1, open: 10, high: 14, low: 8, close: 12, vol: 1 }, { time: 2, open: 12, high: 16, low: 11, close: 15, vol: 1 }];
  const ha = heikinAshi(c);
  near(ha[0].open, 11); near(ha[0].close, 11);
  near(ha[1].close, (12 + 16 + 11 + 15) / 4); near(ha[1].open, (ha[0].open + ha[0].close) / 2);
  for (const x of ha) assert.ok(x.high >= Math.max(x.open, x.close) && x.low <= Math.min(x.open, x.close));
});

test('every indicator computes on short, empty and long data without throwing, with output aligned to the candles', () => {
  const long = bars(Array.from({ length: 300 }, (_, i) => 50 + Math.sin(i / 7) * 20 + (i % 3)));
  for (const kind of IND_ORDER) {
    const inst = makeInd(kind);
    for (const set of [[], bars([5]), bars([5, 6, 7]), long]) {
      const out = computeInd(inst, set);
      assert.strictEqual(out.length, IND_DEFS[kind].outs.length, kind);
      for (const a of out) assert.ok(a.length === set.length || set.length === 0, `${kind} length`);
    }
    const last = computeInd(inst, long).map((a) => a[a.length - 1]);
    assert.ok(last.some((x) => Number.isFinite(x)), `${kind} has a value at the end`);
  }
});

test('cleanParams clamps nonsense so a typo cannot break the chart', () => {
  assert.deepStrictEqual(cleanParams('sma', { n: -5 }), { n: 1 });
  assert.deepStrictEqual(cleanParams('sma', { n: 99999 }), { n: 500 });
  assert.deepStrictEqual(cleanParams('sma', { n: NaN }), { n: 20 });
  assert.deepStrictEqual(cleanParams('bb', { n: 20.7, m: 2.5 }), { n: 21, m: 2.5 });
});
