'use client';
import { useEffect, useRef, useState } from 'react';

type Bar = number[];
type Tr = { t: number; side: 'buy' | 'sell'; sol: number; mcapSol: number; who?: string };

const TF = [
  { s: 1, l: '1s' },
  { s: 5, l: '5s' },
  { s: 15, l: '15s' },
  { s: 60, l: '1m' },
  { s: 300, l: '5m' },
];
const TV = 'https://unpkg.com/lightweight-charts@4.2.1/dist/lightweight-charts.standalone.production.js';

declare global { interface Window { LightweightCharts?: any; } }

function loadTv(): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-lwc]') as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve(window.LightweightCharts));
      existing.addEventListener('error', () => reject(new Error('chart failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = TV; s.async = true; s.dataset.lwc = '1';
    s.onload = () => resolve(window.LightweightCharts);
    s.onerror = () => reject(new Error('chart failed'));
    document.head.appendChild(s);
  });
}

const msOf = (t: number) => (t > 1e12 ? t : t * 1000);

/** Build OHLC candles from every individual trade so the chart has the full history, not only 5s buckets. */
function tradesToBars(trades: Tr[], tf: number, k: number) {
  const rows = [...trades]
    .map((t) => ({ sec: Math.floor(msOf(t.t) / 1000), p: (t.mcapSol || 0) * k, sol: t.sol || 0, side: t.side }))
    .filter((t) => t.sec > 0 && t.p > 0)
    .sort((a, b) => a.sec - b.sec);
  const out: { time: number; open: number; high: number; low: number; close: number; volume: number; up: boolean }[] = [];
  for (const r of rows) {
    const bucket = Math.floor(r.sec / tf) * tf;
    const last = out[out.length - 1];
    if (last && last.time === bucket) {
      if (r.p > last.high) last.high = r.p;
      if (r.p < last.low) last.low = r.p;
      last.close = r.p;
      last.volume += r.sol;
      last.up = last.close >= last.open;
    } else {
      const open = last ? last.close : r.p;
      out.push({ time: bucket, open, high: Math.max(open, r.p), low: Math.min(open, r.p), close: r.p, volume: r.sol, up: r.p >= open });
    }
  }
  return out;
}

function barsToCandles(bars: Bar[], tf: number, k: number) {
  const out: { time: number; open: number; high: number; low: number; close: number; volume: number; up: boolean }[] = [];
  for (const b of bars) {
    const t = Math.floor(Number(b[0]) / tf) * tf;
    if (!(b[2] > 0)) continue;
    const o = b[1] * k, h = b[2] * k, l = b[3] * k, c = b[4] * k, v = b[5] || 0;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      if (h > last.high) last.high = h;
      if (l < last.low) last.low = l;
      last.close = c; last.volume += v; last.up = last.close >= last.open;
    } else out.push({ time: t, open: o, high: h, low: l, close: c, volume: v, up: c >= o });
  }
  return out;
}

function mergeCandles(a: ReturnType<typeof tradesToBars>, b: ReturnType<typeof tradesToBars>) {
  const m = new Map<number, (typeof a)[number]>();
  for (const x of a) m.set(x.time, x);
  for (const x of b) {
    const prev = m.get(x.time);
    if (!prev) { m.set(x.time, x); continue; }
    m.set(x.time, {
      time: x.time,
      open: prev.open,
      high: Math.max(prev.high, x.high),
      low: Math.min(prev.low, x.low),
      close: x.close,
      volume: Math.max(prev.volume, x.volume),
      up: x.close >= prev.open,
    });
  }
  return [...m.values()].sort((p, q) => p.time - q.time);
}

/** TradingView Lightweight Charts — the same library Axiom uses. Candles + a marker for every buy and sell. */
export default function TvChart({ bars = [], trades, solUsd, height = 460 }: { mint: string; bars?: Bar[]; trades: Tr[]; solUsd: number | null; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const candleRef = useRef<any>(null);
  const volRef = useRef<any>(null);
  const [tf, setTf] = useState(5);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const k = solUsd && solUsd > 0 ? solUsd : 1;

  useEffect(() => {
    let dead = false;
    loadTv().then((LWC) => {
      if (dead || !box.current) return;
      const chart = LWC.createChart(box.current, {
        width: box.current.clientWidth,
        height,
        layout: { background: { type: 'solid', color: '#131722' }, textColor: '#d1d4dc' },
        grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
        crosshair: { mode: 1 },
        rightPriceScale: { borderColor: '#2a2e39' },
        timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: true, rightOffset: 4 },
        handleScroll: true,
        handleScale: true,
      });
      const candle = chart.addCandlestickSeries({
        upColor: '#26a69a', downColor: '#ef5350',
        borderUpColor: '#26a69a', borderDownColor: '#ef5350',
        wickUpColor: '#26a69a', wickDownColor: '#ef5350',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });
      const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '' });
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      chartRef.current = chart; candleRef.current = candle; volRef.current = vol;
      const ro = new ResizeObserver(() => { if (box.current && chartRef.current) chartRef.current.applyOptions({ width: box.current.clientWidth }); });
      ro.observe(box.current);
      (chart as any)._ro = ro;
      setReady(true);
    }).catch((e) => { if (!dead) setErr(e?.message || 'Chart failed to load'); });
    return () => {
      dead = true; setReady(false);
      try { chartRef.current?._ro?.disconnect(); } catch { /* ignore */ }
      try { chartRef.current?.remove(); } catch { /* ignore */ }
      chartRef.current = null; candleRef.current = null; volRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const candle = candleRef.current; const vol = volRef.current; const chart = chartRef.current;
    if (!candle || !vol || !chart) return;
    const fromTrades = tradesToBars(trades, tf, k);
    const fromBars = barsToCandles(bars, tf, k);
    const candles = fromTrades.length ? mergeCandles(fromBars, fromTrades) : fromBars;
    candle.setData(candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
    vol.setData(candles.map((c) => ({ time: c.time, value: c.volume, color: c.up ? 'rgba(38,166,154,0.45)' : 'rgba(239,83,80,0.45)' })));
    const seen = new Set<number>();
    const marks = [...trades]
      .map((t) => ({ time: Math.floor(msOf(t.t) / 1000), side: t.side, sol: t.sol || 0 }))
      .filter((t) => t.time > 0)
      .sort((a, b) => a.time - b.time)
      .filter((t) => { if (seen.has(t.time)) return false; seen.add(t.time); return true; })
      .slice(-200)
      .map((t) => ({
        time: t.time,
        position: t.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: t.side === 'buy' ? '#26a69a' : '#ef5350',
        shape: t.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: `${t.side === 'buy' ? 'B' : 'S'} ${t.sol.toFixed(2)}`,
      }));
    candle.setMarkers(marks);
    chart.timeScale().applyOptions({ secondsVisible: tf < 60 });
    if (candles.length) chart.timeScale().fitContent();
  }, [bars, trades, tf, k, ready]);

  return (
    <div className="tvwidget" aria-label="TradingView chart">
      <div className="tvhead">
        <b>TradingView</b>
        <span>{solUsd ? 'USD · market cap' : 'SOL · market cap'}</span>
        <span className="grow" />
        <div className="tfs" role="tablist">{TF.map((t) => <button key={t.s} role="tab" aria-selected={tf === t.s} className={tf === t.s ? 'on' : ''} onClick={() => setTf(t.s)}>{t.l}</button>)}</div>
      </div>
      <div ref={box} style={{ height }} />
      {!trades.length && !bars.length && <div className="hint" style={{ padding: '0 10px 8px' }}>{err || 'Loading every trade from the chain. The chart fills as history arrives, then ticks live.'}</div>}
    </div>
  );
}
