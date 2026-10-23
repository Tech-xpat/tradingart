'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, createSeriesMarkers, CandlestickSeries, BarSeries, LineSeries, AreaSeries, HistogramSeries, ColorType, LineStyle, CrosshairMode, PriceScaleMode } from 'lightweight-charts';
import { IND_DEFS, computeInd, indLabel, makeInd, heikinAshi, type Candle, type IndInst, type IndKind } from './chartkit/indicators';
import { toolDef, newDrawing, finalize, normalize, buildOps, hitOps, hitHandle, renderOps, renderHandles, timeToLogical, logicalToTime, loadDrawings, saveDrawings, sanitize, rgba, needPts, type Drawing, type Pt, type ToolId, type Proj, type Handle } from './chartkit/drawings';
import { loadPrefs, savePrefs, DEFAULT_PREFS, TF, CHART_TYPES, type Prefs, type ChartType } from './chartkit/prefs';
import { Toolbar, DrawStyleBar, IndicatorPicker, IndicatorSettings, ChartSettings, Icon, EYE, EYE_OFF, GEAR, X } from './chartkit/ui';

type Bar = number[];
type Tr = { t: number; side: 'buy' | 'sell'; sol: number; mcapSol: number; who?: string; sig?: string };

const msOf = (t: number) => (t > 1e12 ? t : t * 1000);
const p2 = (n: number) => String(n).padStart(2, '0');
const clock = (sec: number) => { const d = new Date(sec * 1000); return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Axis labels in the viewer's own time zone (the chart itself counts in UTC). */
function tickLabel(sec: number, type: number): string {
  const d = new Date(sec * 1000);
  if (type === 0) return String(d.getFullYear());
  if (type === 1) return MONTHS[d.getMonth()];
  if (type === 2) return String(d.getDate());
  if (type === 3) return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
function compact(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  if (a >= 100) return n.toFixed(1);
  if (a >= 1) return n.toFixed(2);
  if (a === 0) return '0';
  return n.toPrecision(3);
}

/** Draws our drawings inside the chart's own canvas so they move with every zoom, scroll and resize. */
class DrawPrimitive {
  private req: (() => void) | null = null;
  constructor(private paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {}
  attached(p: { requestUpdate: () => void }) { this.req = p.requestUpdate; }
  detached() { this.req = null; }
  redraw() { this.req?.(); }
  paneViews() {
    const paint = this.paint;
    return [{ zOrder: () => 'top' as const, renderer: () => ({ draw: (target: any) => { target.useMediaCoordinateSpace((s: any) => paint(s.context, s.mediaSize.width, s.mediaSize.height)); } }) }];
  }
}

type Draft = { d: Drawing; toolId: ToolId; idx: number; downX: number; downY: number; fresh: boolean; brush: boolean };
type Drag = { id: string; mode: 'move' | 'handle'; hi: number; sx: number; sy: number; orig: { x: number; y: number }[]; set?: Handle['set']; snap: string; moved: boolean };
type Panel = null | 'ind' | 'cfg' | { ind: string };

/**
 * Pro token chart. Same candle engine as the demo: each trade lands in a timeframe bucket, open = previous close, and live
 * trades call series.update() so the body and wick move on every fill. On top: chart types, indicators, drawing tools.
 */
export default function TvChart({ mint, bars = [], trades, solUsd, height = 480 }: { mint: string; bars?: Bar[]; trades: Tr[]; solUsd: number | null; height?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const mainRef = useRef<any>(null);
  const volRef = useRef<any>(null);
  const mkRef = useRef<any>(null);
  const primRef = useRef<DrawPrimitive | null>(null);
  const indRef = useRef<Map<string, { series: any[]; pane: number }>>(new Map());
  const indSig = useRef('');
  const vals = useRef<Map<string, number[][]>>(new Map());
  const arr = useRef<Candle[]>([]);
  const pos = useRef<Map<number, number>>(new Map());
  const ha = useRef<Candle[]>([]);
  const mk = useRef<Map<number, { b: number; s: number }>>(new Map());
  const seen = useRef<Set<string>>(new Set());
  const timesRef = useRef<number[] | null>(null);
  const follow = useRef(true);
  const dirty = useRef(false);
  const indTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fullTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [err, setErr] = useState<string | null>(null);
  const [hoverI, setHoverI] = useState<number | null>(null);
  const [live, setLive] = useState<Candle | null>(null);
  const [vol, setVol] = useState(0);
  const [, setTick] = useState(0);
  const [paneTops, setPaneTops] = useState<number[]>([0]);
  const [tool, setToolState] = useState<ToolId>('cursor');
  const [sticky, setSticky] = useState(false);
  const [sel, setSelState] = useState<string | null>(null);
  const [dver, setDver] = useState(0);
  const [panel, setPanel] = useState<Panel>(null);
  const [full, setFull] = useState(false);

  const k = solUsd && solUsd > 0 ? solUsd : 1;
  const usd = !!(solUsd && solUsd > 0);
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const kRef = useRef(k); kRef.current = k;
  const usdRef = useRef(usd); usdRef.current = usd;
  const tf = prefs.tf;
  const tfRef = useRef(tf); tfRef.current = tf;
  const toolRef = useRef(tool); toolRef.current = tool;
  const selRef = useRef(sel); selRef.current = sel;
  const stickyRef = useRef(sticky); stickyRef.current = sticky;
  const drawRef = useRef<Drawing[]>([]);
  const draftRef = useRef<Draft | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const hist = useRef<string[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const burst = useRef(0);
  const over = useRef(false);
  const block = useRef(false);
  const lastStyle = useRef<Partial<Drawing>>({});

  const fmtP = (v: number) => (usdRef.current ? '$' : '') + compact(v);
  const setPrefs = (patch: Partial<Prefs>) => setPrefsState((p) => ({ ...p, ...patch }));
  const setSel = (id: string | null) => { selRef.current = id; setSelState(id); primRef.current?.redraw(); };

  // ───────────────────────── candle engine ─────────────────────────
  const bucket = (sec: number) => Math.floor(sec / tfRef.current) * tfRef.current;
  const getTimes = () => { if (!timesRef.current) timesRef.current = arr.current.map((c) => c.time); return timesRef.current; };
  const reindex = () => { pos.current = new Map(arr.current.map((c, i) => [c.time, i])); timesRef.current = null; };
  const upA = (a = 0.45) => rgba(prefsRef.current.up, a);
  const dnA = (a = 0.45) => rgba(prefsRef.current.down, a);

  const pointAt = (i: number): any => {
    const c = prefsRef.current.type === 'ha' ? (ha.current[i] ?? arr.current[i]) : arr.current[i];
    const t = prefsRef.current.type;
    return t === 'line' || t === 'area' ? { time: c.time, value: c.close } : { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
  };
  const volAt = (i: number) => { const c = arr.current[i]; return { time: c.time, value: c.vol, color: c.close >= c.open ? upA() : dnA() }; };
  const syncHA = (i: number) => {
    if (prefsRef.current.type !== 'ha') return;
    if (ha.current.length < i) ha.current = heikinAshi(arr.current.slice(0, i));
    ha.current.length = i;
    const c = arr.current[i], close = (c.open + c.high + c.low + c.close) / 4, prev = ha.current[i - 1];
    const open = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
    ha.current[i] = { time: c.time, open, high: Math.max(c.high, open, close), low: Math.min(c.low, open, close), close, vol: c.vol };
  };

  /** Apply one price point. live=true updates the series right away so the candle ticks. */
  function applyPoint(sec: number, price: number, size: number, side: 'buy' | 'sell' | null, liveFlag: boolean): Candle {
    const b = bucket(sec), a = arr.current;
    let i = pos.current.get(b);
    let c: Candle;
    if (i === undefined) {
      const last = a[a.length - 1];
      if (last && b < last.time) {
        let lo = 0; while (lo < a.length && a[lo].time < b) lo++;
        const pc = lo > 0 ? a[lo - 1].close : price;
        c = { time: b, open: pc, high: Math.max(pc, price), low: Math.min(pc, price), close: price, vol: 0 };
        a.splice(lo, 0, c); reindex(); i = lo; dirty.current = true;
      } else {
        const pc = last ? last.close : price;
        c = { time: b, open: pc, high: Math.max(pc, price), low: Math.min(pc, price), close: price, vol: 0 };
        a.push(c); i = a.length - 1; pos.current.set(b, i); timesRef.current = null;
      }
    } else {
      c = a[i];
      if (price > c.high) c.high = price;
      if (price < c.low) c.low = price;
      c.close = price;
    }
    c.vol += size;
    if (side && size > 0) { const m = mk.current.get(b) || { b: 0, s: 0 }; if (side === 'buy') m.b = Math.max(m.b, size); else m.s = Math.max(m.s, size); mk.current.set(b, m); }
    if (liveFlag && mainRef.current && volRef.current) {
      if (dirty.current) scheduleFull();
      else {
        syncHA(i);
        mainRef.current.update(pointAt(i));
        volRef.current.update(volAt(i));
        if (follow.current) chartRef.current?.timeScale().scrollToRealTime?.();
        scheduleInd();
      }
    }
    return c;
  }

  function pushMain() {
    const a = arr.current; if (!mainRef.current) return;
    if (prefsRef.current.type === 'ha') ha.current = heikinAshi(a);
    mainRef.current.setData(a.map((_, i) => pointAt(i)));
  }
  function pushVol() { volRef.current?.setData(arr.current.map((_, i) => volAt(i))); }
  function pushAll() { pushMain(); pushVol(); setIndData(); setMarkers(); }
  function scheduleFull() {
    if (fullTimer.current) return;
    fullTimer.current = setTimeout(() => { fullTimer.current = null; dirty.current = false; pushAll(); primRef.current?.redraw(); }, 60);
  }
  function scheduleInd() {
    if (indTimer.current) return;
    indTimer.current = setTimeout(() => { indTimer.current = null; setIndData(); setMarkers(); measurePanes(); setTick((x) => x + 1); primRef.current?.redraw(); }, 250);
  }

  const tkey = (t: Tr) => (t.sig ? t.sig.slice(0, 10) : `t:${Math.floor(msOf(t.t) / 1000)}:${t.sol}:${t.side}`);

  /** Rebuild every candle from stored bars (older history) and trades (exact recent fills). */
  function rebuild(all: Tr[], barList: Bar[]) {
    arr.current = []; pos.current = new Map(); ha.current = []; mk.current.clear(); seen.current.clear(); timesRef.current = null; dirty.current = false;
    const kk = kRef.current;
    let oldest = Infinity;
    for (const t of all) { const s = Math.floor(msOf(t.t) / 1000); if (s > 0 && (t.mcapSol || 0) > 0 && s < oldest) oldest = s; }
    type P = { sec: number; p: number; sol: number; side: 'buy' | 'sell' | null; key?: string };
    const pts: P[] = [];
    for (const b of barList) {
      const sec = Math.floor(Number(b[0])), o = Number(b[1]) * kk, h = Number(b[2]) * kk, l = Number(b[3]) * kk, c = Number(b[4]) * kk;
      if (!(sec > 0 && c > 0)) continue;
      if (sec >= oldest - 5) continue; // exact trades cover this stretch, so the bar would count it twice
      const seq = c >= o ? [o, l, h, c] : [o, h, l, c];
      seq.forEach((p, j) => { if (p > 0) pts.push({ sec, p, sol: j === seq.length - 1 ? Number(b[5]) || 0 : 0, side: null }); });
    }
    for (const t of all) {
      const p = (t.mcapSol || 0) * kk, sec = Math.floor(msOf(t.t) / 1000);
      if (sec > 0 && p > 0) pts.push({ sec, p, sol: t.sol || 0, side: t.side, key: tkey(t) });
    }
    pts.sort((x, y) => x.sec - y.sec);
    for (const r of pts) { applyPoint(r.sec, r.p, r.sol, r.side, false); if (r.key) seen.current.add(r.key); }
    pushAll();
    const n = arr.current.length;
    if (n > 0) chartRef.current?.timeScale().setVisibleLogicalRange?.({ from: Math.max(0, n - Math.min(n, 120)), to: n + 6 });
    else chartRef.current?.timeScale().fitContent();
    setLive(n ? arr.current[n - 1] : null);
    setVol(arr.current.reduce((s, c) => s + c.vol, 0));
    measurePanes();
    primRef.current?.redraw();
  }

  // ───────────────────────── series, indicators, look ─────────────────────────
  function mainOpts(p: Prefs): any {
    const base = { lastValueVisible: true, priceLineVisible: p.lastLine, priceLineStyle: LineStyle.Dashed, priceFormat: { type: 'custom', formatter: (v: number) => fmtP(v), minMove: 0.0000001 } };
    if (p.type === 'bars') return { ...base, upColor: p.up, downColor: p.down, thinBars: false };
    if (p.type === 'line') return { ...base, color: '#38bdf8', lineWidth: 2 };
    if (p.type === 'area') return { ...base, lineColor: '#38bdf8', topColor: 'rgba(56,189,248,.35)', bottomColor: 'rgba(56,189,248,0)', lineWidth: 2 };
    if (p.type === 'hollow') return { ...base, upColor: 'rgba(0,0,0,0)', downColor: p.down, borderUpColor: p.up, borderDownColor: p.down, wickUpColor: p.up, wickDownColor: p.down, borderVisible: true };
    return { ...base, upColor: p.up, downColor: p.down, borderUpColor: p.up, borderDownColor: p.down, wickUpColor: p.up, wickDownColor: p.down, borderVisible: false };
  }
  function buildMain(type: ChartType) {
    const chart = chartRef.current; if (!chart) return;
    const old = mainRef.current;
    if (old) {
      try { mkRef.current?.detach?.(); } catch { /* ignore */ }
      try { old.detachPrimitive(primRef.current); } catch { /* ignore */ }
      try { chart.removeSeries(old); } catch { /* ignore */ }
    }
    const def = type === 'bars' ? BarSeries : type === 'line' ? LineSeries : type === 'area' ? AreaSeries : CandlestickSeries;
    const s = chart.addSeries(def, mainOpts({ ...prefsRef.current, type }), 0);
    try { s.setSeriesOrder(1); } catch { /* ignore */ }
    if (primRef.current) s.attachPrimitive(primRef.current as any);
    mkRef.current = createSeriesMarkers(s, []);
    mainRef.current = s;
    pushMain(); setMarkers();
  }
  function applyLook() {
    const chart = chartRef.current, p = prefsRef.current; if (!chart || !mainRef.current) return;
    chart.applyOptions({ grid: { vertLines: { visible: p.grid, color: '#12171d' }, horzLines: { visible: p.grid, color: '#12171d' } } });
    chart.priceScale('right').applyOptions({
      mode: p.scale === 'log' ? PriceScaleMode.Logarithmic : p.scale === 'pct' ? PriceScaleMode.Percentage : PriceScaleMode.Normal,
      scaleMargins: { top: 0.08, bottom: p.volume ? 0.25 : 0.08 },
    });
    volRef.current?.applyOptions({ visible: p.volume });
    mainRef.current.applyOptions(mainOpts(p));
    pushVol(); setIndData(); setMarkers();
    primRef.current?.redraw();
  }
  function setMarkers() {
    const api = mkRef.current; if (!api) return;
    const p = prefsRef.current; if (!p.markers) { api.setMarkers([]); return; }
    const a = arr.current, out: any[] = [];
    for (let i = Math.max(0, a.length - 500); i < a.length; i++) {
      const m = mk.current.get(a[i].time); if (!m) continue;
      if (m.b >= p.markerMin && m.b > 0) out.push({ time: a[i].time, position: 'belowBar', color: p.up, shape: 'arrowUp', text: m.b.toFixed(m.b < 10 ? 1 : 0) });
      if (m.s >= p.markerMin && m.s > 0) out.push({ time: a[i].time, position: 'aboveBar', color: p.down, shape: 'arrowDown', text: m.s.toFixed(m.s < 10 ? 1 : 0) });
    }
    api.setMarkers(out);
  }
  function outSeries(chart: any, kind: IndKind, inst: IndInst, oi: number, pane: number) {
    const def = IND_DEFS[kind], o = def.outs[oi], color = inst.colors[oi] ?? o.color;
    if (o.hist) return chart.addSeries(HistogramSeries, { priceFormat: { type: 'price', precision: 3, minMove: 0.001 }, priceLineVisible: false, lastValueVisible: false, color }, pane);
    const range = def.fixedRange;
    const s = chart.addSeries(LineSeries, {
      color, lineWidth: inst.width, lineStyle: o.dash ? LineStyle.Dashed : LineStyle.Solid, priceLineVisible: false, lastValueVisible: def.pane, crosshairMarkerVisible: false,
      priceFormat: def.pane ? { type: 'price', precision: 2, minMove: 0.01 } : { type: 'custom', formatter: (v: number) => fmtP(v), minMove: 0.0000001 },
      autoscaleInfoProvider: range ? () => ({ priceRange: { minValue: range[0], maxValue: range[1] } }) : undefined,
    }, pane);
    if (oi === 0 && def.refs) for (const r of def.refs) s.createPriceLine({ price: r, color: 'rgba(148,163,184,.35)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
    return s;
  }
  function syncInds() {
    const chart = chartRef.current; if (!chart) return;
    const want = prefsRef.current.inds, sig = want.map((i) => `${i.id}:${i.kind}`).join('|');
    if (sig !== indSig.current) {
      for (const e of indRef.current.values()) for (const s of e.series) { try { chart.removeSeries(s); } catch { /* ignore */ } }
      indRef.current.clear(); vals.current.clear();
      let guard = 0;
      while (chart.panes().length > 1 && guard++ < 20) { try { chart.removePane(chart.panes().length - 1); } catch { break; } }
      let pane = 0;
      for (const inst of want) {
        const def = IND_DEFS[inst.kind], p = def.pane ? ++pane : 0;
        indRef.current.set(inst.id, { series: def.outs.map((_, oi) => outSeries(chart, inst.kind, inst, oi, p)), pane: p });
      }
      indSig.current = sig;
    }
    for (const inst of want) {
      const e = indRef.current.get(inst.id); if (!e) continue;
      const def = IND_DEFS[inst.kind];
      e.series.forEach((s, oi) => { const o = def.outs[oi]; s.applyOptions(o.hist ? { color: inst.colors[oi] ?? o.color, visible: inst.visible } : { color: inst.colors[oi] ?? o.color, lineWidth: inst.width, visible: inst.visible }); });
    }
    const panes = chart.panes();
    panes.forEach((pn: any, i: number) => { try { pn.setStretchFactor(i === 0 ? 3 : 1); } catch { /* ignore */ } });
    setIndData(); measurePanes();
  }
  function setIndData() {
    const a = arr.current, tm = a.map((c) => c.time), p = prefsRef.current;
    for (const inst of p.inds) {
      const e = indRef.current.get(inst.id); if (!e) continue;
      const def = IND_DEFS[inst.kind];
      const arrays = inst.visible ? computeInd(inst, a) : def.outs.map(() => [] as number[]);
      vals.current.set(inst.id, arrays);
      arrays.forEach((v, oi) => {
        const o = def.outs[oi];
        e.series[oi]?.setData(a.map((_, i) => (Number.isFinite(v[i]) ? (o.hist ? { time: tm[i], value: v[i], color: v[i] >= 0 ? upA(0.7) : dnA(0.7) } : { time: tm[i], value: v[i] }) : { time: tm[i] })));
      });
    }
  }
  function measurePanes() {
    const chart = chartRef.current; if (!chart) return;
    try {
      let top = 0; const tops: number[] = [];
      for (const pn of chart.panes()) { tops.push(top); top += pn.getHeight() + 1; }
      setPaneTops((old) => (old.length === tops.length && old.every((x, i) => Math.abs(x - tops[i]) < 1) ? old : tops));
    } catch { /* ignore */ }
  }

  // ───────────────────────── drawings ─────────────────────────
  const dims = () => {
    const chart = chartRef.current;
    const w = (box.current?.clientWidth || 0) - (chart?.priceScale('right').width() || 0);
    let h = box.current?.clientHeight || 0;
    try { h = chart.panes()[0].getHeight(); } catch { /* ignore */ }
    return { w, h };
  };
  const makeProj = (w: number, h: number): Proj => {
    const chart = chartRef.current, main = mainRef.current, ts = chart.timeScale(), tms = getTimes(), tfv = tfRef.current, kk = kRef.current;
    return {
      w, h, tf: tfv,
      px: (p) => { const lg = timeToLogical(p.time, tms, tfv); if (lg == null) return null; const x = ts.logicalToCoordinate(lg), y = main.priceToCoordinate(p.price * kk); return x == null || y == null ? null : { x, y }; },
      price: (b) => fmtP(b * kk), time: clock,
    };
  };
  const unpx = (x: number, y: number, snap: boolean): Pt | null => {
    const chart = chartRef.current, main = mainRef.current; if (!chart || !main) return null;
    const ts = chart.timeScale(), lg = ts.coordinateToLogical(x), pr = main.coordinateToPrice(y);
    if (lg == null || pr == null) return null;
    let time = logicalToTime(lg, getTimes(), tfRef.current), price = pr / kRef.current;
    if (time == null) return null;
    if (snap && prefsRef.current.magnet) {
      const c = arr.current[Math.round(lg)];
      if (c) {
        let best: number | null = null, bd = 14;
        for (const v of [c.open, c.high, c.low, c.close]) { const yy = main.priceToCoordinate(v); if (yy != null && Math.abs(yy - y) < bd) { bd = Math.abs(yy - y); best = v; } }
        if (best != null) { price = best / kRef.current; time = c.time; }
      }
    }
    return { time, price };
  };
  const touch = () => { setDver((v) => v + 1); primRef.current?.redraw(); if (saveTimer.current) clearTimeout(saveTimer.current); saveTimer.current = setTimeout(() => saveDrawings(mint, drawRef.current), 350); };
  const pushHist = () => { hist.current.push(JSON.stringify(drawRef.current)); if (hist.current.length > 60) hist.current.shift(); };
  const undo = () => { const s = hist.current.pop(); if (s == null) return; try { drawRef.current = sanitize(JSON.parse(s)); } catch { return; } if (selRef.current && !drawRef.current.some((d) => d.id === selRef.current)) setSel(null); touch(); };
  const setTool = (t: ToolId) => { draftRef.current = null; toolRef.current = t; setToolState(t); if (t !== 'cursor') { setSel(null); if (prefsRef.current.hideDrawings) setPrefs({ hideDrawings: false }); } primRef.current?.redraw(); };
  const selected = () => drawRef.current.find((d) => d.id === selRef.current) || null;
  const patchSel = (patch: Partial<Drawing>) => {
    const d = selected(); if (!d) return;
    if (Date.now() - burst.current > 800) pushHist(); burst.current = Date.now();
    Object.assign(d, patch);
    const { color, width, style, fill } = d; lastStyle.current = { ...lastStyle.current, ...(('color' in patch || 'width' in patch || 'style' in patch || 'fill' in patch) ? { color, width, style, ...(d.fill ? { fill } : {}) } : {}) };
    touch();
  };
  const deleteSel = () => { const id = selRef.current; if (!id) return; pushHist(); drawRef.current = drawRef.current.filter((d) => d.id !== id); setSel(null); touch(); };
  const cloneSel = () => {
    const d = selected(); if (!d) return; pushHist();
    const c: Drawing = JSON.parse(JSON.stringify(d)); c.id = `d${Date.now().toString(36)}c`; c.locked = false;
    c.pts = c.pts.map((p) => ({ time: p.time + tfRef.current * 4, price: p.price })); drawRef.current = [...drawRef.current, c]; setSel(c.id); touch();
  };
  const clearAll = () => { if (!drawRef.current.length) return; pushHist(); drawRef.current = []; setSel(null); touch(); };

  const localXY = (e: { clientX: number; clientY: number }) => { const r = box.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const hitTest = (x: number, y: number): { d: Drawing; hi: number } | null => {
    const { w, h } = dims(); const pr = makeProj(w, h);
    const s = selected();
    if (s && !s.hidden) { const { handles } = buildOps(s, pr); const hi = hitHandle(handles, x, y, 10); if (hi >= 0) return { d: s, hi }; }
    const list = drawRef.current;
    for (let i = list.length - 1; i >= 0; i--) { const d = list[i]; if (d.hidden) continue; if (hitOps(buildOps(d, pr).ops, x, y, 8)) return { d, hi: -1 }; }
    return null;
  };

  function commitDraft() {
    const dr = draftRef.current; if (!dr) return;
    let d = dr.d;
    if (d.kind === 'brush' && d.pts.length < 2) { draftRef.current = null; touch(); return; }
    d = finalize(d);
    pushHist(); drawRef.current = [...drawRef.current, d];
    draftRef.current = null;
    lastStyle.current = { ...lastStyle.current, width: d.width, style: d.style };
    if (!stickyRef.current) { toolRef.current = 'cursor'; setToolState('cursor'); setSel(d.id); }
    touch();
  }
  const placeAt = (dr: Draft, pt: Pt) => {
    const d = dr.d;
    if (d.kind === 'channel' && dr.idx === 2) d.pts[2] = { time: (d.pts[0].time + d.pts[1].time) / 2, price: pt.price };
    else d.pts[dr.idx] = pt;
  };

  function onDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const { x, y } = localXY(e), { w, h } = dims();
    if (x < 0 || y < 0 || x > w || y > h) return; // price axis, time axis and lower panes belong to the chart
    const t = toolRef.current, def = toolDef(t);
    const grab = () => { block.current = true; e.stopPropagation(); e.preventDefault(); try { box.current?.setPointerCapture(e.pointerId); } catch { /* ignore */ } };
    if (t !== 'cursor' && def) {
      const pt = unpx(x, y, true); if (!pt) return;
      grab();
      const dr = draftRef.current;
      if (dr) { // click-click mode: this press places the next point
        placeAt(dr, pt);
        const total = dr.toolId === 'channel' ? 3 : needPts(dr.d.kind) === 3 ? 2 : needPts(dr.d.kind);
        if (dr.idx + 1 >= total) { commitDraft(); return; }
        dr.idx++; dr.fresh = false;
        if (dr.d.kind === 'channel' && dr.idx === 2) dr.d = finalize(dr.d);
        else dr.d.pts[dr.idx] = { ...pt };
        primRef.current?.redraw(); return;
      }
      const d = newDrawing(def, pt, lastStyle.current);
      if (def.id === 'ray' || def.id === 'extended') { d.extR = !!def.preset?.extR; d.extL = !!def.preset?.extL; }
      if (def.kind === 'brush') { d.pts = [pt]; draftRef.current = { d, toolId: t, idx: 0, downX: x, downY: y, fresh: true, brush: true }; primRef.current?.redraw(); return; }
      if (def.need === 1) { draftRef.current = { d, toolId: t, idx: 0, downX: x, downY: y, fresh: true, brush: false }; commitDraft(); return; }
      draftRef.current = { d, toolId: t, idx: 1, downX: x, downY: y, fresh: true, brush: false };
      primRef.current?.redraw(); return;
    }
    // cursor: select / move / drag a handle
    const hit = hitTest(x, y);
    if (!hit) { if (selRef.current) setSel(null); return; }
    grab();
    setSel(hit.d.id);
    if (hit.d.locked) return;
    const pr = makeProj(w, h), orig = hit.d.pts.map((p) => pr.px(p) || { x: 0, y: 0 });
    const handles = buildOps(hit.d, pr).handles;
    dragRef.current = { id: hit.d.id, mode: hit.hi >= 0 ? 'handle' : 'move', hi: hit.hi, sx: x, sy: y, orig, set: hit.hi >= 0 ? handles[hit.hi].set : undefined, snap: JSON.stringify(drawRef.current), moved: false };
  }

  function onMove(e: PointerEvent) {
    const { x, y } = localXY(e);
    const dr = draftRef.current, dg = dragRef.current;
    if (dr) {
      const pt = unpx(x, y, !dr.brush); if (!pt) return;
      if (dr.brush) { const last = dr.d.pts[dr.d.pts.length - 1], pr = makeProj(dims().w, dims().h), lp = pr.px(last); if (!lp || Math.hypot(lp.x - x, lp.y - y) >= 3) dr.d.pts.push(pt); }
      else { placeAt(dr, pt); if (Math.hypot(x - dr.downX, y - dr.downY) > 6) dr.fresh = dr.fresh && true; }
      primRef.current?.redraw(); return;
    }
    if (dg) {
      const d = drawRef.current.find((q) => q.id === dg.id); if (!d) return;
      if (!dg.moved && Math.hypot(x - dg.sx, y - dg.sy) < 3) return;
      if (!dg.moved) { dg.moved = true; hist.current.push(dg.snap); if (hist.current.length > 60) hist.current.shift(); }
      if (dg.mode === 'handle' && dg.set) { const pt = unpx(x, y, true); if (pt) dg.set(d, pt); }
      else { d.pts = dg.orig.map((o, i) => unpx(o.x + (x - dg.sx), o.y + (y - dg.sy), false) ?? d.pts[i]); }
      normalize(d); touch(); return;
    }
    // hover: show a hand over drawings, a crosshair while a tool is armed
    const el = box.current; if (!el) return;
    const { w, h } = dims(); const inside = x >= 0 && y >= 0 && x <= w && y <= h;
    const t = toolRef.current;
    const cls = t !== 'cursor' && inside ? 'cross' : inside && !e.buttons && hitTest(x, y) ? 'hand' : '';
    if (el.dataset.cur !== cls) { el.dataset.cur = cls; el.classList.toggle('cross', cls === 'cross'); el.classList.toggle('hand', cls === 'hand'); }
  }

  function onUp(e: PointerEvent) {
    const dr = draftRef.current, dg = dragRef.current;
    if (dr) {
      if (dr.brush) { commitDraft(); }
      else if (dr.fresh) {
        const { x, y } = localXY(e);
        if (Math.hypot(x - dr.downX, y - dr.downY) > 6) { // press-drag-release: the second point is where the pointer let go
          const pt = unpx(x, y, true); if (pt) placeAt(dr, pt);
          const total = dr.toolId === 'channel' ? 3 : needPts(dr.d.kind) === 3 ? 2 : needPts(dr.d.kind);
          if (dr.idx + 1 >= total) commitDraft();
          else { dr.idx++; dr.fresh = false; if (dr.d.kind === 'channel' && dr.idx === 2) dr.d = finalize(dr.d); else dr.d.pts[dr.idx] = { ...dr.d.pts[dr.idx - 1] }; primRef.current?.redraw(); }
        } else dr.fresh = false; // a plain click: wait for the next click to place the point
      }
    }
    if (dg) { dragRef.current = null; if (dg.moved) touch(); }
    block.current = false;
    try { box.current?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }
  const stopIfBlocked = (e: Event) => { if (block.current) { e.stopPropagation(); } };

  // ───────────────────────── effects ─────────────────────────
  useEffect(() => { setPrefsState(loadPrefs()); setLoaded(true); }, []);
  useEffect(() => { if (loaded) savePrefs(prefs); }, [prefs, loaded]);
  useEffect(() => { drawRef.current = loadDrawings(mint); hist.current = []; draftRef.current = null; dragRef.current = null; setSel(null); setDver((v) => v + 1); primRef.current?.redraw(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [mint]);
  useEffect(() => () => { if (saveTimer.current) { clearTimeout(saveTimer.current); saveDrawings(mint, drawRef.current); } }, [mint]);

  const paintRef = useRef<(ctx: CanvasRenderingContext2D, w: number, h: number) => void>(() => {});
  paintRef.current = (ctx, w, h) => {
    if (prefsRef.current.hideDrawings || !mainRef.current || !chartRef.current) return;
    const pr = makeProj(w, h);
    for (const d of drawRef.current) { if (d.hidden) continue; renderOps(ctx, buildOps(d, pr).ops); }
    const s = drawRef.current.find((d) => d.id === selRef.current);
    if (s && !s.hidden) renderHandles(ctx, buildOps(s, pr).handles, s.color);
    const dr = draftRef.current;
    if (dr) { const { ops, handles } = buildOps(dr.d, pr); renderOps(ctx, ops); renderHandles(ctx, handles, dr.d.color); }
  };

  useEffect(() => {
    if (!loaded || !box.current) return;
    const el = box.current;
    let chart: any, ro: ResizeObserver | null = null;
    const listeners: [string, any, boolean][] = [];
    try {
      chart = createChart(el, {
        width: el.clientWidth || 600, height: el.clientHeight || height,
        layout: { background: { type: ColorType.Solid, color: '#0b0d10' }, textColor: '#7d8794', fontSize: 11, panes: { separatorColor: '#1e252d', separatorHoverColor: 'rgba(245,184,61,.25)', enableResize: true } } as any,
        grid: { vertLines: { color: '#12171d' }, horzLines: { color: '#12171d' } },
        rightPriceScale: { borderColor: '#1e252d', scaleMargins: { top: 0.08, bottom: 0.25 } },
        timeScale: { borderColor: '#1e252d', timeVisible: true, secondsVisible: true, rightOffset: 6, barSpacing: 8, tickMarkFormatter: (t: any, type: number) => tickLabel(Number(t), type) },
        crosshair: { mode: CrosshairMode.Normal },
        localization: { locale: 'en-US', timeFormatter: (t: any) => clock(Number(t)) }, // each series formats its own prices, so oscillator panes are not shown in dollars
        handleScroll: true, handleScale: true,
      });
      chartRef.current = chart;
      primRef.current = new DrawPrimitive((ctx, w, h) => paintRef.current(ctx, w, h));
      const vs = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false }, 0);
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      volRef.current = vs;
      mainRef.current = null; indSig.current = '';
      buildMain(prefsRef.current.type);
      applyLook(); syncInds();

      chart.subscribeCrosshairMove((p: any) => {
        const i = p && p.time != null ? pos.current.get(Number(p.time)) : undefined;
        setHoverI((old) => (i === undefined ? (old === null ? old : null) : old === i ? old : i));
      });
      chart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
        if (!range) return;
        const info = mainRef.current?.barsInLogicalRange?.(range);
        follow.current = !info || (typeof info.barsAfter === 'number' && info.barsAfter < 3);
      });
      const add = (type: string, fn: any, capture = false) => { el.addEventListener(type, fn, capture); listeners.push([type, fn, capture]); };
      add('pointerdown', (e: PointerEvent) => onDownRef.current(e), true);
      add('pointermove', (e: PointerEvent) => onMoveRef.current(e));
      add('pointerup', (e: PointerEvent) => onUpRef.current(e));
      add('pointercancel', (e: PointerEvent) => onUpRef.current(e));
      add('mousedown', stopIfBlocked, true);
      add('touchstart', stopIfBlocked, true);
      ro = new ResizeObserver(() => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && chartRef.current) { chartRef.current.applyOptions({ width: Math.floor(r.width), height: Math.floor(r.height) }); measurePanes(); }
      });
      ro.observe(el);
      setReady(true); setErr(null);
    } catch (e: any) { setErr(e?.message || 'Chart failed'); }
    return () => {
      setReady(false);
      for (const [t, f, c] of listeners) el.removeEventListener(t, f, c);
      try { ro?.disconnect(); } catch { /* ignore */ }
      if (indTimer.current) { clearTimeout(indTimer.current); indTimer.current = null; }
      if (fullTimer.current) { clearTimeout(fullTimer.current); fullTimer.current = null; }
      try { chart?.remove(); } catch { /* ignore */ }
      chartRef.current = null; mainRef.current = null; volRef.current = null; mkRef.current = null; primRef.current = null; indRef.current.clear(); indSig.current = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const onDownRef = useRef(onDown); onDownRef.current = onDown;
  const onMoveRef = useRef(onMove); onMoveRef.current = onMove;
  const onUpRef = useRef(onUp); onUpRef.current = onUp;

  const histKey = useMemo(() => {
    let m = bars.length ? Number(bars[0][0]) : Infinity;
    for (const t of trades) { const s = Math.floor(msOf(t.t) / 1000); if (s > 0 && s < m) m = s; }
    return m === Infinity ? 0 : m;
  }, [bars, trades]);

  // rebuild when the timeframe or unit changes, or when older history arrives
  useEffect(() => { if (ready) rebuild(trades, bars); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tf, k, ready, histKey]);
  useEffect(() => { if (ready) buildMain(prefs.type); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [prefs.type, ready]);
  useEffect(() => { if (ready) applyLook(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [prefs.grid, prefs.scale, prefs.volume, prefs.lastLine, prefs.up, prefs.down, ready]);
  useEffect(() => { if (ready) setMarkers(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [prefs.markers, prefs.markerMin, ready]);
  const indsKey = JSON.stringify(prefs.inds);
  useEffect(() => { if (ready) { syncInds(); setTick((x) => x + 1); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [indsKey, ready]);
  useEffect(() => { if (ready) primRef.current?.redraw(); }, [prefs.hideDrawings, dver, sel, ready]);

  // new trades arriving from the page: apply only the fresh ones, like the demo's onTrade
  useEffect(() => {
    if (!ready || !mainRef.current) return;
    const fresh: Tr[] = [];
    for (const t of trades) { if (seen.current.has(tkey(t))) continue; if ((t.mcapSol || 0) > 0 && msOf(t.t) > 0) fresh.push(t); }
    if (!fresh.length) return;
    fresh.sort((a, b) => msOf(a.t) - msOf(b.t));
    const firstKey = arr.current.length ? arr.current[0].time : 0;
    if (firstKey > 0 && fresh.some((t) => Math.floor(msOf(t.t) / 1000) < firstKey)) { rebuild(trades, bars); return; }
    let last: Candle | null = null;
    for (const t of fresh) { last = applyPoint(Math.floor(msOf(t.t) / 1000), (t.mcapSol || 0) * kRef.current, t.sol || 0, t.side, true); seen.current.add(tkey(t)); }
    if (last) setLive(last);
    setVol(arr.current.reduce((s, c) => s + c.vol, 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades, ready]);

  // direct live stream for this coin: each trade ticks the candle immediately
  useEffect(() => {
    if (!ready || !mint) return;
    let ws: WebSocket | null = null, closed = false, retry: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      if (closed) return;
      try {
        ws = new WebSocket('wss://pumpportal.fun/api/data');
        ws.onopen = () => { try { ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] })); } catch { /* ignore */ } };
        ws.onmessage = (e) => {
          try {
            const m = JSON.parse(String(e.data));
            if (!m || m.mint !== mint) return;
            const tx = m.txType; if (tx !== 'buy' && tx !== 'sell' && tx !== 'create') return;
            let p = Number(m.marketCapSol);
            if (!(p > 0)) { const sol = Number(m.solAmount), tok = Number(m.tokenAmount); p = sol > 0 && tok > 0 ? (sol / tok) * 1e9 : NaN; }
            if (!(p > 0)) return;
            const sec = Math.floor(Date.now() / 1000), size = Number(m.solAmount) || 0;
            const key = typeof m.signature === 'string' ? m.signature.slice(0, 10) : `live:${sec}:${size}:${tx}`;
            if (seen.current.has(key)) return;
            seen.current.add(key);
            const c = applyPoint(sec, p * kRef.current, size, tx === 'sell' ? 'sell' : 'buy', true);
            setLive(c); setVol(arr.current.reduce((s, x) => s + x.vol, 0));
          } catch { /* ignore */ }
        };
        ws.onclose = () => { if (!closed) retry = setTimeout(open, 1500); };
        ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
      } catch { retry = setTimeout(open, 3000); }
    };
    open();
    return () => { closed = true; if (retry) clearTimeout(retry); try { ws?.close(); } catch { /* ignore */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, mint]);

  // keyboard: Esc steps back one level, Delete removes, Ctrl+Z undoes. Captured first so the sheet only closes when nothing here is active.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null, typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === 'Escape') {
        if (draftRef.current) { draftRef.current = null; primRef.current?.redraw(); }
        else if (toolRef.current !== 'cursor') setTool('cursor');
        else if (selRef.current) setSel(null);
        else if (panelRef.current) setPanel(null);
        else if (fullRef.current && !document.fullscreenElement) setFull(false);
        else return;
        e.stopPropagation(); e.preventDefault(); return;
      }
      if (typing || !(over.current || (wrap.current && wrap.current.contains(document.activeElement)))) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selRef.current) { deleteSel(); e.preventDefault(); e.stopPropagation(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { undo(); e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const panelRef = useRef(panel); panelRef.current = panel;
  const fullRef = useRef(full); fullRef.current = full;
  useEffect(() => { const f = () => setFull(document.fullscreenElement === wrap.current); document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); }, []);

  // ───────────────────────── actions ─────────────────────────
  const toggleFull = async () => {
    const el = wrap.current; if (!el) return;
    if (document.fullscreenElement === el) { await document.exitFullscreen().catch(() => {}); return; }
    if (full) { setFull(false); return; }
    if (el.requestFullscreen) { try { await el.requestFullscreen(); return; } catch { /* fall back to the in-page version */ } }
    setFull(true);
  };
  const snapshot = () => {
    try {
      const cv: HTMLCanvasElement = chartRef.current.takeScreenshot();
      cv.toBlob((b) => { if (!b) return; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${mint.slice(0, 6)}-chart.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); });
    } catch { /* ignore */ }
  };
  const addInd = (kind: IndKind) => { setPrefs({ inds: [...prefs.inds, makeInd(kind)].slice(0, 10) }); setPanel(null); };
  const patchInd = (id: string, patch: Partial<IndInst>) => setPrefs({ inds: prefs.inds.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
  const removeInd = (id: string) => { setPrefs({ inds: prefs.inds.filter((i) => i.id !== id) }); setPanel(null); };

  // ───────────────────────── render ─────────────────────────
  const n = arr.current.length;
  const hc = hoverI != null ? arr.current[hoverI] : null;
  const shown = hc || live;
  const idx = hoverI != null ? hoverI : n - 1;
  const up = shown ? shown.close >= shown.open : true;
  const change = shown && shown.open ? ((shown.close - shown.open) / shown.open) * 100 : 0;
  const chgAbs = shown ? Math.abs(shown.close - shown.open) : 0;
  const oscCount = prefs.inds.filter((i) => IND_DEFS[i.kind].pane).length;
  const stageH = full ? undefined : height + oscCount * 130;
  const selD = sel ? drawRef.current.find((d) => d.id === sel) || null : null;
  const val = (id: string, oi: number) => { const v = vals.current.get(id)?.[oi]?.[idx]; return v != null && Number.isFinite(v) ? compact(v) : '–'; };
  const editing = panel && typeof panel === 'object' ? prefs.inds.find((i) => i.id === panel.ind) || null : null;
  const armed = tool !== 'cursor';
  void dver;

  return (
    <div ref={wrap} className={`tvwidget pro${full ? ' full' : ''}`} aria-label="Trading chart" onMouseEnter={() => { over.current = true; }} onMouseLeave={() => { over.current = false; }}>
      <div className="tvhead">
        <div className="tvtitle">
          <b>{usd ? 'Market Cap · USD' : 'Market Cap · SOL'}</b>
          {shown && (
            <span className="ohlc" style={{ color: up ? prefs.up : prefs.down }}>
              O{compact(shown.open)} H{compact(shown.high)} L{compact(shown.low)} C{compact(shown.close)} {compact(chgAbs)} ({change >= 0 ? '+' : ''}{change.toFixed(2)}%)
            </span>
          )}
          <span className="volabel">Volume {hc ? hc.vol.toFixed(hc.vol >= 100 ? 0 : 2) : vol >= 1000 ? (vol / 1000).toFixed(2) + 'K' : vol.toFixed(1)} SOL{hc ? ' (candle)' : ' (total)'}</span>
        </div>
      </div>
      <div className="tvbar">
        <div className="tfs" role="tablist" aria-label="Timeframe">
          {TF.map((t) => <button key={t.s} role="tab" aria-selected={tf === t.s} className={tf === t.s ? 'on' : ''} onClick={() => setPrefs({ tf: t.s })}>{t.l}</button>)}
        </div>
        <div className="tvacts">
          <select aria-label="Chart type" value={prefs.type} onChange={(e) => setPrefs({ type: e.target.value as ChartType })}>{CHART_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
          <button className={panel === 'ind' ? 'on' : ''} onClick={() => setPanel(panel === 'ind' ? null : 'ind')} aria-label="Indicators">ƒx Indicators{prefs.inds.length ? ` (${prefs.inds.length})` : ''}</button>
          <button className={panel === 'cfg' ? 'on' : ''} onClick={() => setPanel(panel === 'cfg' ? null : 'cfg')} aria-label="Chart settings" title="Chart settings"><Icon html={GEAR} size={16} /></button>
          <button onClick={snapshot} aria-label="Save picture" title="Save a picture of the chart"><Icon html='<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>' size={16} /></button>
          <button onClick={toggleFull} aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen' : 'Full screen'}><Icon html={full ? '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>' : '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'} size={16} /></button>
        </div>
      </div>
      <div className="tvbody">
        <Toolbar tool={tool} setTool={setTool} sticky={sticky} setSticky={setSticky} magnet={prefs.magnet} setMagnet={(b) => setPrefs({ magnet: b })} hidden={prefs.hideDrawings} setHidden={(b) => setPrefs({ hideDrawings: b })} count={drawRef.current.length} onClear={clearAll} onUndo={undo} canUndo={hist.current.length > 0} />
        <div className={`tvstage${armed ? ' armed' : ''}${selD ? ' hasSel' : ''}`} style={{ height: stageH }}>
          <div ref={box} className="tvcanvas" />
          <div className="tvlegend" aria-label="Indicators on the chart">
            {prefs.inds.map((i) => {
              const def = IND_DEFS[i.kind], top = (def.pane ? paneTops[indRef.current.get(i.id)?.pane ?? 0] ?? 0 : 0);
              const sameTop = prefs.inds.filter((q) => (IND_DEFS[q.kind].pane ? paneTops[indRef.current.get(q.id)?.pane ?? 0] ?? 0 : 0) === top);
              const row = sameTop.findIndex((q) => q.id === i.id);
              return (
                <div key={i.id} className={`lchip${i.visible ? '' : ' off'}`} style={{ top: top + 4 + row * 22 + (def.pane ? 0 : 0) + (!def.pane ? 0 : 0) }}>
                  <i style={{ background: i.colors[0] }} />
                  <span>{indLabel(i)}</span>
                  {def.outs.map((o, oi) => <b key={o.key} style={{ color: i.colors[oi] }}>{val(i.id, oi)}</b>)}
                  <button aria-label={i.visible ? `Hide ${indLabel(i)}` : `Show ${indLabel(i)}`} onClick={() => patchInd(i.id, { visible: !i.visible })}><Icon html={i.visible ? EYE : EYE_OFF} size={13} /></button>
                  <button aria-label={`Settings for ${indLabel(i)}`} onClick={() => setPanel({ ind: i.id })}><Icon html={GEAR} size={13} /></button>
                  <button aria-label={`Remove ${indLabel(i)}`} onClick={() => removeInd(i.id)}><Icon html={X} size={13} /></button>
                </div>
              );
            })}
          </div>
          {selD && <DrawStyleBar d={selD} onChange={patchSel} onDelete={deleteSel} onClone={cloneSel} />}
          {panel === 'ind' && <IndicatorPicker onAdd={addInd} onClose={() => setPanel(null)} count={prefs.inds.length} />}
          {panel === 'cfg' && <ChartSettings prefs={prefs} set={setPrefs} onClose={() => setPanel(null)} onReset={() => setPrefsState((p) => ({ ...DEFAULT_PREFS, tf: p.tf, inds: p.inds }))} />}
          {editing && <IndicatorSettings ind={editing} onChange={(patch) => patchInd(editing.id, patch)} onRemove={() => removeInd(editing.id)} onClose={() => setPanel(null)} />}
          {armed && <div className="tvhint">{toolDef(tool)?.label}: {toolDef(tool)?.tip}. Esc to cancel.</div>}
        </div>
      </div>
      {err && <div className="hint warn" style={{ padding: '0 10px 8px' }}>{err}</div>}
      {!trades.length && !bars.length && !err && (
        <div className="hint" style={{ padding: '0 10px 8px' }}>Waiting for the first trade. The candle will move as each fill lands.</div>
      )}
    </div>
  );
}
