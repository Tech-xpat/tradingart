'use client';
import { useEffect, useRef, useState } from 'react';

type Bar = number[];
type Tr = { t: number; side: 'buy' | 'sell'; sol: number; mcapSol: number; who?: string };

const TF = [
  { s: 1, l: '1s' },
  { s: 5, l: '5s' },
  { s: 15, l: '15s' },
  { s: 30, l: '30s' },
  { s: 60, l: '1m' },
  { s: 300, l: '5m' },
  { s: 900, l: '15m' },
  { s: 3600, l: '1h' },
];
const TV = 'https://unpkg.com/lightweight-charts@5.0.8/dist/lightweight-charts.standalone.production.js';

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

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

function buildCandles(trades: Tr[], bars: Bar[], tf: number, k: number): Candle[] {
  const rows: { sec: number; p: number; sol: number }[] = [];
  for (const t of trades) {
    const p = (t.mcapSol || 0) * k;
    const sec = Math.floor(msOf(t.t) / 1000);
    if (sec > 0 && p > 0) rows.push({ sec, p, sol: t.sol || 0 });
  }
  if (!rows.length) {
    for (const b of bars) {
      const sec = Math.floor(Number(b[0]));
      const p = Number(b[4]) * k;
      if (sec > 0 && p > 0) rows.push({ sec, p, sol: Number(b[5]) || 0 });
    }
  }
  rows.sort((a, b) => a.sec - b.sec);
  const out: Candle[] = [];
  for (const r of rows) {
    const time = Math.floor(r.sec / tf) * tf;
    const last = out[out.length - 1];
    if (last && last.time === time) {
      if (r.p > last.high) last.high = r.p;
      if (r.p < last.low) last.low = r.p;
      last.close = r.p;
      last.volume += r.sol;
    } else {
      const open = last ? last.close : r.p;
      out.push({ time, open, high: Math.max(open, r.p), low: Math.min(open, r.p), close: r.p, volume: r.sol });
    }
  }
  return out;
}

function addSeries(LWC: any, chart: any, kind: 'candle' | 'vol') {
  if (kind === 'candle') {
    if (LWC.CandlestickSeries) return chart.addSeries(LWC.CandlestickSeries, {
      upColor: '#26a69a', downColor: '#ef5350',
      borderUpColor: '#26a69a', borderDownColor: '#ef5350',
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
      borderVisible: false,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    return chart.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350',
      borderUpColor: '#26a69a', borderDownColor: '#ef5350',
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
      borderVisible: false,
    });
  }
  if (LWC.HistogramSeries) return chart.addSeries(LWC.HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' });
  return chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '' });
}

/** TradingView Lightweight Charts v5 - the library Axiom uses. Market-cap candles like pump.fun. Live candle grows via update(). */
export default function TvChart({ bars = [], trades, solUsd, height = 480 }: { mint: string; bars?: Bar[]; trades: Tr[]; solUsd: number | null; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const candleRef = useRef<any>(null);
  const volRef = useRef<any>(null);
  const painted = useRef('');
  const follow = useRef(true);
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
        timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: true, rightOffset: 6, barSpacing: 8 },
        handleScroll: true,
        handleScale: true,
      });
      const candle = addSeries(LWC, chart, 'candle');
      const vol = addSeries(LWC, chart, 'vol');
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      chart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
        if (!range) return;
        const barsInfo = candle.barsInLogicalRange?.(range);
        follow.current = !barsInfo || (typeof barsInfo.barsAfter === 'number' && barsInfo.barsAfter < 2);
      });
      chartRef.current = chart; candleRef.current = candle; volRef.current = vol;
      const ro = new ResizeObserver(() => { if (box.current && chartRef.current) chartRef.current.applyOptions({ width: box.current.clientWidth }); });
      ro.observe(box.current);
      (chart as any)._ro = ro;
      setReady(true);
    }).catch((e) => { if (!dead) setErr(e?.message || 'Chart failed to load'); });
    return () => {
      dead = true; setReady(false); painted.current = '';
      try { chartRef.current?._ro?.disconnect(); } catch { /* ignore */ }
      try { chartRef.current?.remove(); } catch { /* ignore */ }
      chartRef.current = null; candleRef.current = null; volRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const candle = candleRef.current; const vol = volRef.current; const chart = chartRef.current;
    if (!candle || !vol || !chart) return;
    const candles = buildCandles(trades, bars, tf, k);
    if (!candles.length) return;
    const last = candles[candles.length - 1];
    const key = `${tf}:${candles.length}:${last.time}`;
    const sameTf = painted.current.startsWith(`${tf}:`);
    if (!sameTf || !painted.current) {
      candle.setData(candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
      vol.setData(candles.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)' })));
      chart.timeScale().fitContent();
      chart.timeScale().scrollToRealTime?.();
      painted.current = key;
      return;
    }
    candle.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
    vol.update({ time: last.time, value: last.volume, color: last.close >= last.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)' });
    if (follow.current) chart.timeScale().scrollToRealTime?.();
    painted.current = key;
  }, [bars, trades, tf, k, ready]);

  return (
    <div className="tvwidget" aria-label="TradingView chart">
      <div className="tvhead">
        <b>TradingView</b>
        <span>{solUsd ? 'Market cap - USD' : 'Market cap - SOL'}</span>
        <span className="grow" />
        <div className="tfs" role="tablist">{TF.map((t) => <button key={t.s} role="tab" aria-selected={tf === t.s} className={tf === t.s ? 'on' : ''} onClick={() => setTf(t.s)}>{t.l}</button>)}</div>
      </div>
      <div ref={box} style={{ height }} />
      {!trades.length && !bars.length && <div className="hint" style={{ padding: '0 10px 8px' }}>{err || 'Loading every trade from the first swap. The live candle grows as new trades land.'}</div>}
    </div>
  );
}
