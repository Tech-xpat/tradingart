'use client';
import { useEffect, useRef, useState } from 'react';
import * as charting from '@/lib/charting';

type Bar = number[];
type Tr = { t: number; side: 'buy' | 'sell'; sol: number; mcapSol: number };

const TF = [{ s: 5, l: '5s' }, { s: 15, l: '15s' }, { s: 60, l: '1m' }, { s: 300, l: '5m' }];
const TV = 'https://unpkg.com/lightweight-charts@4.2.1/dist/lightweight-charts.standalone.production.js';

declare global {
  interface Window { LightweightCharts?: any; }
}

function loadTv(): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-lwc]') as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve(window.LightweightCharts));
      existing.addEventListener('error', () => reject(new Error('chart script failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = TV; s.async = true; s.dataset.lwc = '1';
    s.onload = () => resolve(window.LightweightCharts);
    s.onerror = () => reject(new Error('chart script failed'));
    document.head.appendChild(s);
  });
}

/** TradingView Lightweight Charts widget. Candles and buy/sell marks come from the server history plus the live feed. */
export default function TvChart({ bars, trades, solUsd, height = 420 }: { mint: string; bars: Bar[]; trades: Tr[]; solUsd: number | null; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const candleRef = useRef<any>(null);
  const volRef = useRef<any>(null);
  const [tf, setTf] = useState(5);
  const [err, setErr] = useState<string | null>(null);
  const k = solUsd && solUsd > 0 ? solUsd : 1;

  useEffect(() => {
    let dead = false;
    const el = box.current;
    if (!el) return;
    loadTv().then((LWC) => {
      if (dead || !box.current) return;
      const chart = LWC.createChart(box.current, {
        width: box.current.clientWidth,
        height,
        layout: { background: { type: 'solid', color: '#0b0e14' }, textColor: '#b2b5be' },
        grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
        crosshair: { mode: 1 },
        rightPriceScale: { borderColor: '#2a2e39' },
        timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: tf < 60 },
        handleScroll: true,
        handleScale: true,
      });
      const candle = chart.addCandlestickSeries({
        upColor: '#26a69a', downColor: '#ef5350', borderUpColor: '#26a69a', borderDownColor: '#ef5350', wickUpColor: '#26a69a', wickDownColor: '#ef5350',
      });
      const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      chartRef.current = chart; candleRef.current = candle; volRef.current = vol;
      const ro = new ResizeObserver(() => { if (box.current && chartRef.current) chartRef.current.applyOptions({ width: box.current.clientWidth }); });
      ro.observe(box.current);
      (chart as any)._ro = ro;
    }).catch((e) => { if (!dead) setErr(e?.message || 'Chart failed to load'); });
    return () => {
      dead = true;
      try { chartRef.current?._ro?.disconnect(); } catch { /* ignore */ }
      try { chartRef.current?.remove(); } catch { /* ignore */ }
      chartRef.current = null; candleRef.current = null; volRef.current = null;
    };
  }, [height]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const candle = candleRef.current; const vol = volRef.current; const chart = chartRef.current;
    if (!candle || !vol || !chart) return;
    const src = charting.resample(bars, tf) as Bar[];
    const seen = new Set<number>();
    const candles: { time: number; open: number; high: number; low: number; close: number }[] = [];
    const vols: { time: number; value: number; color: string }[] = [];
    for (const b of src) {
      const time = Math.floor(b[0]);
      if (seen.has(time) || !(b[2] > 0)) continue;
      seen.add(time);
      const up = b[4] >= b[1];
      candles.push({ time, open: b[1] * k, high: b[2] * k, low: b[3] * k, close: b[4] * k });
      vols.push({ time, value: b[5] || 0, color: up ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)' });
    }
    candle.setData(candles);
    vol.setData(vols);
    const marks = trades
      .map((t) => ({ time: Math.floor(t.t > 1e12 ? t.t / 1000 : t.t), side: t.side, sol: t.sol }))
      .filter((t) => t.time > 0)
      .sort((a, b) => a.time - b.time)
      .slice(-80)
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
  }, [bars, trades, tf, k]);

  return (
    <div className="tvwidget" aria-label="TradingView chart">
      <div className="tvhead">
        <b>TradingView</b>
        <span>{solUsd ? 'Market cap · USD' : 'Market cap · SOL'}</span>
        <span className="grow" />
        <div className="tfs" role="tablist">{TF.map((t) => <button key={t.s} role="tab" className={tf === t.s ? 'on' : ''} onClick={() => setTf(t.s)}>{t.l}</button>)}</div>
      </div>
      <div ref={box} style={{ height }} />
      {!bars.length && <div className="hint" style={{ padding: '0 10px 8px' }}>{err || 'Waiting for the first trade. History and live buys/sells appear on this chart as soon as the server has them.'}</div>}
    </div>
  );
}
