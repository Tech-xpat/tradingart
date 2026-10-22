'use client';
import { useEffect, useRef, useState } from 'react';

type Tr = { t: number; side: 'buy' | 'sell'; sol: number; mcapSol: number; who?: string };

const GREEN = '#26a69a';
const RED = '#ef5350';
const msOf = (t: number) => (t > 1e12 ? t : t * 1000);

/** One point per trade. Every buy and sell moves the line. No candle bucketing. */
export default function TvChart({ trades, solUsd, height = 440 }: { mint: string; bars?: number[][]; trades: Tr[]; solUsd: number | null; height?: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const view = useRef({ x0: 0, span: 0, follow: true });
  const drag = useRef<{ x: number; x0: number } | null>(null);
  const [followLive, setFollowLive] = useState(true);
  const [hover, setHover] = useState('');
  const [count, setCount] = useState(0);
  const k = solUsd && solUsd > 0 ? solUsd : 1;
  const pts = useRef<{ t: number; p: number; side: 'buy' | 'sell'; sol: number }[]>([]);

  useEffect(() => {
    const rows = [...trades]
      .map((t) => ({ t: msOf(t.t), p: (t.mcapSol || 0) * k, side: t.side, sol: t.sol || 0 }))
      .filter((t) => t.t > 0 && t.p > 0)
      .sort((a, b) => a.t - b.t);
    // same millisecond still counts: nudge so every trade is its own tick
    for (let i = 1; i < rows.length; i++) if (rows[i].t <= rows[i - 1].t) rows[i].t = rows[i - 1].t + 1;
    pts.current = rows;
    setCount(rows.length);
    if (view.current.follow || view.current.span <= 0) {
      const last = rows.length ? rows[rows.length - 1].t : Date.now();
      const first = rows.length ? rows[Math.max(0, rows.length - 180)].t : last - 60_000;
      view.current.span = Math.max(8_000, last - first);
      view.current.x0 = last - view.current.span;
    }
  }, [trades, k]);

  useEffect(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const c = cv.current; if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = height;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      const g = c.getContext('2d'); if (!g || !W) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#0b0e14'; g.fillRect(0, 0, W, H);
      const rows = pts.current;
      const padL = 8, padR = 72, padT = 12, padB = 22;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      if (!rows.length) { g.fillStyle = '#787b86'; g.font = '12px ui-monospace, monospace'; g.fillText('Waiting for the first trade. Every buy and sell will tick the line.', 12, 28); return; }
      const v = view.current;
      if (v.follow) { const last = rows[rows.length - 1].t; v.x0 = last - v.span; }
      const x1 = v.x0 + v.span;
      const vis = rows.filter((r) => r.t >= v.x0 && r.t <= x1);
      const src = vis.length ? vis : rows.slice(-2);
      let lo = Infinity, hi = -Infinity;
      for (const r of src) { lo = Math.min(lo, r.p); hi = Math.max(hi, r.p); }
      if (!(hi > lo)) { hi = lo * 1.01; lo *= 0.99; }
      const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
      const X = (t: number) => padL + ((t - v.x0) / v.span) * plotW;
      const Y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * plotH;
      const fmt = (p: number) => (solUsd ? (p >= 1e6 ? `$${(p / 1e6).toFixed(2)}M` : p >= 1e3 ? `$${(p / 1e3).toFixed(1)}k` : `$${p.toFixed(0)}`) : `${p >= 100 ? p.toFixed(0) : p.toFixed(2)} SOL`);
      g.font = '10px ui-monospace, monospace';
      for (let i = 0; i <= 4; i++) {
        const p = lo + ((hi - lo) * i) / 4, y = Y(p);
        g.strokeStyle = '#1e222d'; g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke();
        g.fillStyle = '#787b86'; g.fillText(fmt(p), padL + plotW + 6, y + 3);
      }
      g.beginPath();
      let started = false;
      for (const r of rows) {
        if (r.t < v.x0 - v.span || r.t > x1 + v.span) continue;
        const x = X(r.t), y = Y(r.p);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      g.strokeStyle = '#d1d4dc'; g.lineWidth = 1.4; g.stroke();
      for (const r of src) {
        const x = X(r.t), y = Y(r.p);
        const rad = Math.max(2.5, Math.min(11, 2.5 + Math.sqrt(r.sol) * 3.2));
        g.fillStyle = r.side === 'buy' ? GREEN : RED;
        g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
      }
      const last = rows[rows.length - 1];
      const ly = Y(last.p), lx = X(last.t);
      g.strokeStyle = last.side === 'buy' ? GREEN : RED; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(padL, ly); g.lineTo(padL + plotW, ly); g.stroke(); g.setLineDash([]);
      const pulse = 4 + 3 * (0.5 + 0.5 * Math.sin(Date.now() / 180));
      g.globalAlpha = 0.35; g.beginPath(); g.arc(lx, ly, pulse + 3, 0, 7); g.fillStyle = last.side === 'buy' ? GREEN : RED; g.fill(); g.globalAlpha = 1;
      g.fillStyle = last.side === 'buy' ? GREEN : RED; g.fillRect(padL + plotW, ly - 8, padR, 16);
      g.fillStyle = '#0b0e14'; g.fillText(fmt(last.p), padL + plotW + 4, ly + 3);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [height, count, solUsd]);

  const localX = (e: React.PointerEvent) => e.clientX - cv.current!.getBoundingClientRect().left;
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const v = view.current; const rows = pts.current; if (!rows.length) return;
    v.follow = false; setFollowLive(false);
    const f = e.deltaY > 0 ? 1.15 : 0.87;
    v.span = Math.max(4_000, Math.min(6 * 3600_000, v.span * f));
    const last = rows[rows.length - 1].t;
    if (v.x0 + v.span > last + 2_000) { v.x0 = last - v.span; v.follow = true; setFollowLive(true); }
  };
  const onDown = (e: React.PointerEvent) => { view.current.follow = false; setFollowLive(false); drag.current = { x: localX(e), x0: view.current.x0 }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); };
  const onMove = (e: React.PointerEvent) => {
    const rows = pts.current; const c = cv.current; if (!c || !rows.length) return;
    const x = localX(e); const W = c.clientWidth; const plotW = W - 80;
    if (drag.current) {
      const dx = x - drag.current.x;
      view.current.x0 = drag.current.x0 - (dx / plotW) * view.current.span;
      const last = rows[rows.length - 1].t;
      view.current.follow = view.current.x0 + view.current.span >= last - 500;
      setFollowLive(view.current.follow);
      return;
    }
    const t = view.current.x0 + ((x - 8) / plotW) * view.current.span;
    let best = rows[0], bd = Infinity;
    for (const r of rows) { const d = Math.abs(r.t - t); if (d < bd) { bd = d; best = r; } }
    const when = new Date(best.t).toLocaleTimeString([], { hour12: false });
    setHover(`${when}  ${best.side === 'buy' ? 'BUY' : 'SELL'}  ${best.sol.toFixed(3)} SOL  ${solUsd ? '$' + Math.round(best.p).toLocaleString() : best.p.toFixed(2) + ' SOL mcap'}`);
  };
  const follow = () => { view.current.follow = true; setFollowLive(true); };

  const last = pts.current[pts.current.length - 1];
  return (
    <div className="tvwidget" aria-label="Tick chart">
      <div className="tvhead">
        <b>Every trade</b>
        <span>{count} ticks · green buy · red sell</span>
        <span className="grow" />
        {!followLive ? <button type="button" onClick={follow}>Follow live</button> : <span>live</span>}
      </div>
      <canvas ref={cv} style={{ width: '100%', height, display: 'block', touchAction: 'none' }} onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} />
      <div className="hint" style={{ padding: '4px 10px 8px' }}>{hover || (last ? `Last tick ${last.side === 'buy' ? 'BUY' : 'SELL'} ${last.sol.toFixed(3)} SOL` : 'Each market trade is one tick. Nothing is grouped into candles.')}</div>
    </div>
  );
}
