/**
 * Indicator math for the token chart. Pure functions, no imports, so they are easy to test.
 * Every indicator takes the candle list and returns arrays aligned to it (NaN = no value yet).
 */
export type Candle = { time: number; open: number; high: number; low: number; close: number; vol: number };
export type Arr = number[];

const nan = (n: number): Arr => new Array<number>(n).fill(NaN);
const lead = (v: Arr) => { let i = 0; while (i < v.length && Number.isNaN(v[i])) i++; return i; };
/** Run f on the part of v that has values, then pad the front with NaN again. */
function withLead(v: Arr, f: (x: Arr) => Arr): Arr {
  const s = lead(v);
  if (s >= v.length) return nan(v.length);
  return nan(s).concat(f(v.slice(s)));
}

export const sma = (v: Arr, n: number): Arr => withLead(v, (x) => {
  const out = nan(x.length); let s = 0;
  for (let i = 0; i < x.length; i++) { s += x[i]; if (i >= n) s -= x[i - n]; if (i >= n - 1) out[i] = s / n; }
  return out;
});

/** Exponential average, seeded with the simple average of the first n values. */
export const ema = (v: Arr, n: number, alpha = 2 / (n + 1)): Arr => withLead(v, (x) => {
  const out = nan(x.length); let e = NaN, s = 0;
  for (let i = 0; i < x.length; i++) {
    if (i < n - 1) s += x[i];
    else if (i === n - 1) { s += x[i]; e = s / n; out[i] = e; }
    else { e = x[i] * alpha + e * (1 - alpha); out[i] = e; }
  }
  return out;
});

/** Wilder smoothing (used by RSI and ATR). */
export const rma = (v: Arr, n: number): Arr => ema(v, n, 1 / n);

export const wma = (v: Arr, n: number): Arr => withLead(v, (x) => {
  const out = nan(x.length), den = (n * (n + 1)) / 2;
  for (let i = n - 1; i < x.length; i++) { let s = 0; for (let j = 0; j < n; j++) s += x[i - j] * (n - j); out[i] = s / den; }
  return out;
});

export function stdev(v: Arr, n: number): Arr {
  const out = nan(v.length);
  for (let i = n - 1; i < v.length; i++) {
    let s = 0; for (let j = 0; j < n; j++) s += v[i - j];
    const m = s / n; let q = 0; for (let j = 0; j < n; j++) q += (v[i - j] - m) ** 2;
    out[i] = Math.sqrt(q / n);
  }
  return out;
}
export function highest(v: Arr, n: number): Arr { const out = nan(v.length); for (let i = n - 1; i < v.length; i++) { let m = -Infinity; for (let j = 0; j < n; j++) if (v[i - j] > m) m = v[i - j]; out[i] = m; } return out; }
export function lowest(v: Arr, n: number): Arr { const out = nan(v.length); for (let i = n - 1; i < v.length; i++) { let m = Infinity; for (let j = 0; j < n; j++) if (v[i - j] < m) m = v[i - j]; out[i] = m; } return out; }

export function trueRange(c: Candle[]): Arr {
  return c.map((x, i) => (i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close))));
}
export const atr = (c: Candle[], n: number): Arr => rma(trueRange(c), n);

export function rsi(close: Arr, n: number): Arr {
  const g = nan(close.length), l = nan(close.length);
  for (let i = 1; i < close.length; i++) { const d = close[i] - close[i - 1]; g[i] = d > 0 ? d : 0; l[i] = d < 0 ? -d : 0; }
  const ag = rma(g, n), al = rma(l, n);
  return close.map((_, i) => (Number.isNaN(ag[i]) || Number.isNaN(al[i]) ? NaN : al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i])));
}

export function macd(close: Arr, fast: number, slow: number, sig: number): [Arr, Arr, Arr] {
  const f = ema(close, fast), s = ema(close, slow);
  const line = close.map((_, i) => (Number.isNaN(f[i]) || Number.isNaN(s[i]) ? NaN : f[i] - s[i]));
  const signal = ema(line, sig);
  const hist = line.map((x, i) => (Number.isNaN(x) || Number.isNaN(signal[i]) ? NaN : x - signal[i]));
  return [line, signal, hist];
}

export function stoch(c: Candle[], n: number, smooth: number, d: number): [Arr, Arr] {
  const hh = highest(c.map((x) => x.high), n), ll = lowest(c.map((x) => x.low), n);
  const raw = c.map((x, i) => (Number.isNaN(hh[i]) ? NaN : hh[i] === ll[i] ? 50 : (100 * (x.close - ll[i])) / (hh[i] - ll[i])));
  const k = smooth > 1 ? sma(raw, smooth) : raw;
  return [k, sma(k, d)];
}

export function cci(c: Candle[], n: number): Arr {
  const tp = c.map((x) => (x.high + x.low + x.close) / 3), m = sma(tp, n);
  return tp.map((x, i) => {
    if (Number.isNaN(m[i])) return NaN;
    let dev = 0; for (let j = 0; j < n; j++) dev += Math.abs(tp[i - j] - m[i]);
    dev /= n; return dev === 0 ? 0 : (x - m[i]) / (0.015 * dev);
  });
}

export function obv(c: Candle[]): Arr {
  const out = nan(c.length); let s = 0;
  for (let i = 0; i < c.length; i++) { if (i > 0) s += c[i].close > c[i - 1].close ? c[i].vol : c[i].close < c[i - 1].close ? -c[i].vol : 0; out[i] = s; }
  return out;
}

export function roc(close: Arr, n: number): Arr { return close.map((x, i) => (i >= n && close[i - n] ? (x / close[i - n] - 1) * 100 : NaN)); }

export function willr(c: Candle[], n: number): Arr {
  const hh = highest(c.map((x) => x.high), n), ll = lowest(c.map((x) => x.low), n);
  return c.map((x, i) => (Number.isNaN(hh[i]) ? NaN : hh[i] === ll[i] ? -50 : (-100 * (hh[i] - x.close)) / (hh[i] - ll[i])));
}

export function vwap(c: Candle[], resetDaily: boolean): Arr {
  const out = nan(c.length); let pv = 0, vv = 0, day = -1;
  for (let i = 0; i < c.length; i++) {
    const d = Math.floor(c[i].time / 86400);
    if (resetDaily && d !== day) { pv = 0; vv = 0; }
    day = d;
    const tp = (c[i].high + c[i].low + c[i].close) / 3;
    pv += tp * c[i].vol; vv += c[i].vol;
    out[i] = vv > 0 ? pv / vv : NaN;
  }
  return out;
}

/** Returns [uptrend line, downtrend line]; the other side is NaN so the colour changes where the trend flips. */
export function supertrend(c: Candle[], n: number, mult: number): [Arr, Arr] {
  const a = atr(c, n), up = nan(c.length), dn = nan(c.length);
  let fu = NaN, fl = NaN, st = NaN, dir = 1;
  for (let i = 0; i < c.length; i++) {
    if (Number.isNaN(a[i])) continue;
    const hl2 = (c[i].high + c[i].low) / 2, bu = hl2 + mult * a[i], bl = hl2 - mult * a[i];
    const pc = i > 0 ? c[i - 1].close : c[i].close;
    fu = Number.isNaN(fu) || bu < fu || pc > fu ? bu : fu;
    fl = Number.isNaN(fl) || bl > fl || pc < fl ? bl : fl;
    if (Number.isNaN(st)) dir = c[i].close >= hl2 ? 1 : -1;
    else if (dir === -1 && c[i].close > fu) dir = 1;
    else if (dir === 1 && c[i].close < fl) dir = -1;
    st = dir === 1 ? fl : fu;
    if (dir === 1) up[i] = st; else dn[i] = st;
  }
  return [up, dn];
}

export function heikinAshi(c: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < c.length; i++) {
    const x = c[i], close = (x.open + x.high + x.low + x.close) / 4;
    const open = i === 0 ? (x.open + x.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({ time: x.time, open, high: Math.max(x.high, open, close), low: Math.min(x.low, open, close), close, vol: x.vol });
  }
  return out;
}

// ───────────────────────── catalogue ─────────────────────────

export type IndKind = 'sma' | 'ema' | 'wma' | 'vwap' | 'bb' | 'keltner' | 'donchian' | 'supertrend' | 'rsi' | 'macd' | 'stoch' | 'atr' | 'cci' | 'obv' | 'roc' | 'willr';
export type OutSpec = { key: string; label: string; color: string; hist?: boolean; dash?: boolean; width?: number };
export type ParamSpec = { key: string; label: string; def: number; min: number; max: number; step?: number };
export type IndDef = {
  kind: IndKind; name: string; group: 'Trend' | 'Volatility' | 'Momentum' | 'Volume'; pane: boolean; desc: string;
  params: ParamSpec[]; outs: OutSpec[]; refs?: number[]; fixedRange?: [number, number];
  compute: (c: Candle[], p: Record<string, number>) => Arr[];
};

const C = { gold: '#f5b83d', blue: '#38bdf8', violet: '#a78bfa', pink: '#f472b6', green: '#22c55e', red: '#ef4444', teal: '#2dd4bf', orange: '#fb923c', grey: '#94a3b8' };
const closes = (c: Candle[]) => c.map((x) => x.close);
const P = (key: string, label: string, def: number, min = 1, max = 500, step = 1): ParamSpec => ({ key, label, def, min, max, step });

export const IND_DEFS: Record<IndKind, IndDef> = {
  sma: { kind: 'sma', name: 'Simple Moving Average', group: 'Trend', pane: false, desc: 'Average close over the last N candles.', params: [P('n', 'Length', 20)], outs: [{ key: 'ma', label: 'SMA', color: C.gold }], compute: (c, p) => [sma(closes(c), p.n)] },
  ema: { kind: 'ema', name: 'Exponential Moving Average', group: 'Trend', pane: false, desc: 'Moving average that reacts faster to recent candles.', params: [P('n', 'Length', 21)], outs: [{ key: 'ma', label: 'EMA', color: C.blue }], compute: (c, p) => [ema(closes(c), p.n)] },
  wma: { kind: 'wma', name: 'Weighted Moving Average', group: 'Trend', pane: false, desc: 'Recent candles count more than older ones.', params: [P('n', 'Length', 20)], outs: [{ key: 'ma', label: 'WMA', color: C.violet }], compute: (c, p) => [wma(closes(c), p.n)] },
  vwap: { kind: 'vwap', name: 'VWAP', group: 'Volume', pane: false, desc: 'Volume-weighted average price. Set "Daily reset" to 1 to restart each UTC day.', params: [P('reset', 'Daily reset (0/1)', 0, 0, 1)], outs: [{ key: 'vwap', label: 'VWAP', color: C.pink }], compute: (c, p) => [vwap(c, p.reset >= 1)] },
  bb: { kind: 'bb', name: 'Bollinger Bands', group: 'Volatility', pane: false, desc: 'Average with bands N standard deviations either side.', params: [P('n', 'Length', 20), P('m', 'Std dev', 2, 0.5, 6, 0.5)], outs: [{ key: 'up', label: 'Upper', color: C.teal }, { key: 'mid', label: 'Basis', color: C.orange, dash: true }, { key: 'lo', label: 'Lower', color: C.teal }],
    compute: (c, p) => { const cl = closes(c), m = sma(cl, p.n), s = stdev(cl, p.n); return [m.map((x, i) => x + p.m * s[i]), m, m.map((x, i) => x - p.m * s[i])]; } },
  keltner: { kind: 'keltner', name: 'Keltner Channels', group: 'Volatility', pane: false, desc: 'EMA with bands set by average true range.', params: [P('n', 'EMA length', 20), P('a', 'ATR length', 10), P('m', 'Multiplier', 2, 0.5, 6, 0.5)], outs: [{ key: 'up', label: 'Upper', color: C.blue }, { key: 'mid', label: 'Basis', color: C.grey, dash: true }, { key: 'lo', label: 'Lower', color: C.blue }],
    compute: (c, p) => { const m = ema(closes(c), p.n), a = atr(c, p.a); return [m.map((x, i) => x + p.m * a[i]), m, m.map((x, i) => x - p.m * a[i])]; } },
  donchian: { kind: 'donchian', name: 'Donchian Channels', group: 'Volatility', pane: false, desc: 'Highest high and lowest low of the last N candles.', params: [P('n', 'Length', 20)], outs: [{ key: 'up', label: 'Upper', color: C.green }, { key: 'mid', label: 'Middle', color: C.grey, dash: true }, { key: 'lo', label: 'Lower', color: C.red }],
    compute: (c, p) => { const h = highest(c.map((x) => x.high), p.n), l = lowest(c.map((x) => x.low), p.n); return [h, h.map((x, i) => (x + l[i]) / 2), l]; } },
  supertrend: { kind: 'supertrend', name: 'Supertrend', group: 'Trend', pane: false, desc: 'ATR trailing line that flips colour when the trend changes.', params: [P('n', 'ATR length', 10), P('m', 'Multiplier', 3, 0.5, 10, 0.5)], outs: [{ key: 'up', label: 'Up', color: C.green, width: 2 }, { key: 'dn', label: 'Down', color: C.red, width: 2 }], compute: (c, p) => supertrend(c, p.n, p.m) },
  rsi: { kind: 'rsi', name: 'Relative Strength Index', group: 'Momentum', pane: true, desc: 'Momentum from 0 to 100. Above 70 is stretched up, below 30 stretched down.', params: [P('n', 'Length', 14)], outs: [{ key: 'rsi', label: 'RSI', color: C.violet }], refs: [30, 70], fixedRange: [0, 100], compute: (c, p) => [rsi(closes(c), p.n)] },
  macd: { kind: 'macd', name: 'MACD', group: 'Momentum', pane: true, desc: 'Gap between a fast and a slow average, with a signal line and histogram.', params: [P('f', 'Fast', 12), P('s', 'Slow', 26), P('g', 'Signal', 9)], outs: [{ key: 'macd', label: 'MACD', color: C.blue }, { key: 'sig', label: 'Signal', color: C.orange }, { key: 'hist', label: 'Histogram', color: C.green, hist: true }], refs: [0], compute: (c, p) => { const [l, s, h] = macd(closes(c), p.f, p.s, p.g); return [l, s, h]; } },
  stoch: { kind: 'stoch', name: 'Stochastic', group: 'Momentum', pane: true, desc: 'Where the close sits inside the recent high to low range.', params: [P('n', '%K length', 14), P('k', '%K smooth', 3), P('d', '%D smooth', 3)], outs: [{ key: 'k', label: '%K', color: C.blue }, { key: 'd', label: '%D', color: C.orange }], refs: [20, 80], fixedRange: [0, 100], compute: (c, p) => { const [k, d] = stoch(c, p.n, p.k, p.d); return [k, d]; } },
  atr: { kind: 'atr', name: 'Average True Range', group: 'Volatility', pane: true, desc: 'Typical candle size. Higher means a more volatile coin.', params: [P('n', 'Length', 14)], outs: [{ key: 'atr', label: 'ATR', color: C.orange }], compute: (c, p) => [atr(c, p.n)] },
  cci: { kind: 'cci', name: 'Commodity Channel Index', group: 'Momentum', pane: true, desc: 'How far price is from its average, in mean deviations.', params: [P('n', 'Length', 20)], outs: [{ key: 'cci', label: 'CCI', color: C.teal }], refs: [-100, 100], compute: (c, p) => [cci(c, p.n)] },
  obv: { kind: 'obv', name: 'On-Balance Volume', group: 'Volume', pane: true, desc: 'Running total of volume: added on up candles, taken off on down candles.', params: [], outs: [{ key: 'obv', label: 'OBV', color: C.gold }], compute: (c) => [obv(c)] },
  roc: { kind: 'roc', name: 'Rate of Change', group: 'Momentum', pane: true, desc: 'Percent change over the last N candles.', params: [P('n', 'Length', 9)], outs: [{ key: 'roc', label: 'ROC', color: C.pink }], refs: [0], compute: (c, p) => [roc(closes(c), p.n)] },
  willr: { kind: 'willr', name: 'Williams %R', group: 'Momentum', pane: true, desc: 'Like Stochastic, scaled from -100 to 0.', params: [P('n', 'Length', 14)], outs: [{ key: 'wr', label: '%R', color: C.violet }], refs: [-80, -20], fixedRange: [-100, 0], compute: (c, p) => [willr(c, p.n)] },
};
export const IND_ORDER: IndKind[] = ['sma', 'ema', 'wma', 'vwap', 'supertrend', 'bb', 'keltner', 'donchian', 'rsi', 'macd', 'stoch', 'cci', 'roc', 'willr', 'atr', 'obv'];

export type IndInst = { id: string; kind: IndKind; params: Record<string, number>; colors: string[]; width: number; visible: boolean };

let seq = 0;
export function makeInd(kind: IndKind): IndInst {
  const d = IND_DEFS[kind];
  return { id: `i${Date.now().toString(36)}${(seq++).toString(36)}`, kind, params: Object.fromEntries(d.params.map((p) => [p.key, p.def])), colors: d.outs.map((o) => o.color), width: 2, visible: true };
}
const SHORT: Record<IndKind, string> = { sma: 'SMA', ema: 'EMA', wma: 'WMA', vwap: 'VWAP', bb: 'BB', keltner: 'KC', donchian: 'DC', supertrend: 'Supertrend', rsi: 'RSI', macd: 'MACD', stoch: 'Stoch', atr: 'ATR', cci: 'CCI', obv: 'OBV', roc: 'ROC', willr: '%R' };
export function indLabel(i: IndInst): string {
  const d = IND_DEFS[i.kind];
  if (i.kind === 'vwap') return 'VWAP';
  const ps = d.params.map((p) => i.params[p.key] ?? p.def);
  return ps.length ? `${SHORT[i.kind]} ${ps.join(' ')}` : SHORT[i.kind];
}
/** Clamp user-typed params to the allowed range so a bad number can never break the maths. */
export function cleanParams(kind: IndKind, p: Record<string, number>): Record<string, number> {
  const d = IND_DEFS[kind]; const out: Record<string, number> = {};
  for (const s of d.params) { const v = Number(p[s.key]); out[s.key] = Number.isFinite(v) ? Math.min(s.max, Math.max(s.min, s.step && s.step < 1 ? v : Math.round(v))) : s.def; }
  return out;
}
export function computeInd(i: IndInst, c: Candle[]): Arr[] {
  if (!c.length) return IND_DEFS[i.kind].outs.map(() => []);
  return IND_DEFS[i.kind].compute(c, cleanParams(i.kind, i.params));
}
