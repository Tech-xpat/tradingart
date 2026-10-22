'use client';
import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, ColorType, LineStyle } from 'lightweight-charts';

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

const msOf = (t: number) => (t > 1e12 ? t : t * 1000);

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

function fmtMcap(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '–';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(2);
}

/** Build candles from recorded bars (dense history) then overlay live trades so the last candle ticks. */
function buildCandles(trades: Tr[], bars: Bar[], tf: number, k: number): Candle[] {
  const points: { sec: number; p: number; sol: number }[] = [];

  // Bars first — the worker has been recording these, so the chart is dense like DexScreener
  for (const b of bars) {
    const sec = Math.floor(Number(b[0]));
    const close = Number(b[4]) * k;
    if (sec > 0 && close > 0) points.push({ sec, p: close, sol: Number(b[5]) || 0 });
  }

  // Live trades overlay the recent end so the current candle moves with every fill
  for (const t of trades) {
    const p = (t.mcapSol || 0) * k;
    const sec = Math.floor(msOf(t.t) / 1000);
    if (sec > 0 && p > 0) points.push({ sec, p, sol: t.sol || 0 });
  }

  points.sort((a, b) => a.sec - b.sec);
  const out: Candle[] = [];
  for (const r of points) {
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

/** TradingView Lightweight Charts, styled to match the DexScreener screenshot. */
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
  const [hover, setHover] = useState<Candle | null>(null);
  const k = solUsd && solUsd > 0 ? solUsd : 1;

  useEffect(() => {
    if (!box.current) return;
    let chart: any;
    try {
      chart = createChart(box.current, {
        width: box.current.clientWidth,
        height,
        layout: {
          background: { type: ColorType.Solid, color: '#0e1621' },
          textColor: '#b2b5be',
          fontSize: 11,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, sans-serif',
        },
        grid: {
          vertLines: { color: '#1c2331' },
          horzLines: { color: '#1c2331' },
        },
        crosshair: {
          mode: 1,
          vertLine: { color: '#758696', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#2a2e39' },
          horzLine: { color: '#758696', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#2a2e39' },
        },
        rightPriceScale: {
          borderColor: '#2a2e39',
          scaleMargins: { top: 0.06, bottom: 0.22 },
        },
        timeScale: {
          borderColor: '#2a2e39',
          timeVisible: true,
          secondsVisible: true,
          rightOffset: 6,
          barSpacing: 7,
          minBarSpacing: 3,
        },
        localization: {
          priceFormatter: (p: number) => fmtMcap(p),
        },
        handleScroll: true,
        handleScale: true,
      });

      const candle = chart.addSeries(CandlestickSeries, {
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderUpColor: '#26a69a',
        borderDownColor: '#ef5350',
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
        borderVisible: false,
        lastValueVisible: true,
        priceLineVisible: true,
        priceLineStyle: LineStyle.Dashed,
        priceLineWidth: 1,
        priceFormat: {
          type: 'custom',
          minMove: 0.01,
          formatter: (p: number) => fmtMcap(p),
        },
      });

      const vol = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
      });
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      candle.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 } });

      chart.subscribeCrosshairMove((param: any) => {
        if (!param || !param.time) { setHover(null); return; }
        const data = param.seriesData?.get?.(candle);
        if (data && typeof data.open === 'number') {
          setHover({ time: param.time as number, open: data.open, high: data.high, low: data.low, close: data.close, volume: 0 });
        } else setHover(null);
      });

      chart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
        if (!range) return;
        const info = candle.barsInLogicalRange?.(range);
        follow.current = !info || (typeof info.barsAfter === 'number' && info.barsAfter < 3);
      });

      chartRef.current = chart;
      candleRef.current = candle;
      volRef.current = vol;
      const ro = new ResizeObserver(() => {
        if (box.current && chartRef.current) chartRef.current.applyOptions({ width: box.current.clientWidth });
      });
      ro.observe(box.current);
      (chart as any)._ro = ro;
      setReady(true);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message || 'Chart failed');
    }
    return () => {
      setReady(false);
      painted.current = '';
      try { (chart as any)?._ro?.disconnect(); } catch { /* ignore */ }
      try { chart?.remove(); } catch { /* ignore */ }
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const candle = candleRef.current;
    const vol = volRef.current;
    const chart = chartRef.current;
    if (!candle || !vol || !chart) return;
    const candles = buildCandles(trades, bars, tf, k);
    if (!candles.length) return;
    const last = candles[candles.length - 1];
    const key = `${tf}:${candles.length}:${last.time}:${last.close.toFixed(4)}`;
    const sameTf = painted.current.startsWith(`${tf}:`);
    const volColor = (c: Candle) => c.close >= c.open ? 'rgba(38,166,154,0.55)' : 'rgba(239,83,80,0.55)';

    if (!sameTf || !painted.current) {
      candle.setData(candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
      vol.setData(candles.map((c) => ({ time: c.time, value: c.volume, color: volColor(c) })));
      chart.timeScale().fitContent();
      chart.timeScale().scrollToRealTime?.();
      painted.current = key;
      return;
    }
    candle.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
    vol.update({ time: last.time, value: last.volume, color: volColor(last) });
    if (follow.current) chart.timeScale().scrollToRealTime?.();
    painted.current = key;
  }, [bars, trades, tf, k, ready]);

  const candles = buildCandles(trades, bars, tf, k);
  const live = candles.length ? candles[candles.length - 1] : null;
  const shown = hover || live;
  const up = shown ? shown.close >= shown.open : true;
  const change = shown && shown.open ? ((shown.close - shown.open) / shown.open) * 100 : 0;
  const chgAbs = shown ? Math.abs(shown.close - shown.open) : 0;
  const vol = live ? live.volume : 0;
  const title = solUsd ? 'Market Cap · USD' : 'Market Cap · SOL';

  return (
    <div className="tvwidget" aria-label="TradingView chart">
      <div className="tvhead">
        <div className="tvtitle">
          <b>{title}</b>
          {shown && (
            <span className="ohlc" style={{ color: up ? '#26a69a' : '#ef5350' }}>
              O{fmtMcap(shown.open)} H{fmtMcap(shown.high)} L{fmtMcap(shown.low)} C{fmtMcap(shown.close)} {fmtMcap(chgAbs)} ({change >= 0 ? '+' : ''}{change.toFixed(2)}%)
            </span>
          )}
          <span className="volabel">Volume {vol >= 1000 ? (vol / 1000).toFixed(2) + 'K' : vol.toFixed(1)} SOL</span>
        </div>
        <div className="tfs" role="tablist">
          {TF.map((t) => (
            <button key={t.s} role="tab" aria-selected={tf === t.s} className={tf === t.s ? 'on' : ''} onClick={() => setTf(t.s)}>
              {t.l}
            </button>
          ))}
        </div>
      </div>
      <div ref={box} style={{ height }} />
      {err && <div className="hint warn" style={{ padding: '0 10px 8px' }}>{err}</div>}
      {!trades.length && !bars.length && !err && (
        <div className="hint" style={{ padding: '0 10px 8px' }}>Loading every trade from the first swap. The live candle grows as new trades land.</div>
      )}
    </div>
  );
}
