'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as charting from '@/lib/charting';
import { getLocalTrades } from '@/lib/liveTokens';

type Bar = number[]; // [t, o, h, l, c, volSol, buys, sells]; prices are market cap in SOL
type Draw = { id: string; kind: 'line' | 'h' | 'rect'; a: { t: number; p: number }; b: { t: number; p: number } };
type Tool = 'move' | 'line' | 'h' | 'rect';
export type Tiers = { s5: Bar[]; m1: Bar[]; m5: Bar[] };

const TF = [{ s: 5, l: '5s' }, { s: 15, l: '15s' }, { s: 60, l: '1m' }, { s: 300, l: '5m' }, { s: 900, l: '15m' }, { s: 3600, l: '1h' }, { s: 14400, l: '4h' }, { s: 86400, l: '1D' }];
const GREEN = '#C6FF3D', RED = '#ff5c6c', GOLD = '#FFD23F', BLUE = '#7dd3fc';
const PAD_R = 62, PAD_T = 10, VOL_H = 48, AXIS_H = 18;

const fmtUsd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(n < 10 ? 2 : 0)}`);
const fmtT = (t: number, span: number) => { const d = new Date(t * 1000); const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; return span > 2 * 86400 ? `${d.getMonth() + 1}/${d.getDate()}` : span > 6 * 3600 ? `${d.getDate()} ${hm}` : span < 300 ? `${hm}:${String(d.getSeconds()).padStart(2, '0')}` : hm; };

/** The best stored resolution for a candle size. */
function baseFor(tf: number, t: Tiers): Bar[] {
  if (tf >= 300 && t.m5.length) return t.m5;
  if (tf >= 60 && t.m1.length) return t.m1;
  return t.s5;
}
/** Server candles are the record; this browser's own candles are newer for the last few seconds, so they refine the latest bucket. */
function combine(server: Bar[], local: Bar[]): Bar[] {
  if (!local.length) return server; if (!server.length) return local;
  const lastT = server[server.length - 1][0]; const out = server.map((b) => b.slice());
  for (const l of local) {
    if (l[0] < lastT) continue;
    if (l[0] === lastT) { const x = out[out.length - 1]; x[2] = Math.max(x[2], l[2]); x[3] = Math.min(x[3], l[3]); x[4] = l[4]; x[5] = Math.max(x[5], l[5]); x[6] = Math.max(x[6], l[6]); x[7] = Math.max(x[7], l[7]); }
    else out.push(l.slice());
  }
  return out;
}

/**
 * Our own interactive chart: pan and zoom from seconds to days, candles with volume, linear or log scale, market cap in
 * dollars or SOL, your own trend lines / horizontal lines / boxes (saved per coin, draggable), the pattern engine's marks,
 * and an animation of every buy and sell as it happens.
 */
export default function Chart({ mint, tiers, solUsd, height = 340 }: { mint: string; tiers: Tiers; solUsd: number | null; height?: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [tf, setTf] = useState(15);
  const [tool, setTool] = useState<Tool>('move');
  const [log, setLog] = useState(false);
  const [unit, setUnit] = useState<'usd' | 'sol'>('usd');
  const [pat, setPat] = useState('double_bottom');
  const [draws, setDraws] = useState<Draw[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [readout, setReadout] = useState('');
  const [tape, setTape] = useState<{ id: number; side: string; sol: number; mcapSol: number }[]>([]);

  const k = unit === 'usd' && solUsd ? solUsd : 1;
  const fmt = useCallback((p: number) => (unit === 'usd' && solUsd ? fmtUsd(p * solUsd) : `${p >= 100 ? p.toFixed(0) : p.toFixed(2)} SOL`), [unit, solUsd]);

  const all = useMemo(() => charting.resample(baseFor(tf, tiers), tf) as Bar[], [tiers, tf]);
  const allRef = useRef<Bar[]>([]); allRef.current = all;
  const found = useMemo(() => charting.detect(pat, all, { tolerancePct: 6, minDropPct: 25, bouncePct: 8, confirmPct: 2, trigger: 'confirm', lookbackBars: 120, volMult: 4 }), [all, pat]);

  /* saved drawings (per coin, in this browser) */
  useEffect(() => { try { setDraws(JSON.parse(localStorage.getItem(`art:draw:${mint}`) || '[]')); } catch { setDraws([]); } setSel(null); }, [mint]);
  const saveDraws = (d: Draw[]) => { setDraws(d); try { localStorage.setItem(`art:draw:${mint}`, JSON.stringify(d)); } catch { /* storage blocked */ } };
  const drawsRef = useRef<Draw[]>([]); drawsRef.current = draws;

  /* view: right edge time and visible span, in seconds; kept in refs so dragging never re-renders React */
  const view = useRef({ tR: 0, span: 0, fit: true });
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<null | { mode: 'pan' | 'new' | 'end' | 'move'; id?: string; end?: 'a' | 'b'; startX: number; startTR: number; last?: { t: number; p: number } }>(null);
  const pending = useRef<Draw | null>(null);
  const bubbles = useRef<{ x0: number; t: number; side: string; r: number; p: number; born: number }[]>([]);
  const seen = useRef(0);
  const sizeRef = useRef({ W: 0, H: height });
  const yr = useRef({ lo: 0, hi: 1 });

  useEffect(() => { // new candle size or coin: refit to the latest bars
    const bars = allRef.current; const last = bars.length ? bars[bars.length - 1][0] : Date.now() / 1000;
    view.current = { tR: last + tf * 4, span: tf * Math.min(90, Math.max(30, bars.length || 60)), fit: true };
  }, [tf, mint]);
  useEffect(() => { // while following the live edge, keep the right edge on the newest candle
    if (!view.current.fit || !all.length) return; view.current.tR = all[all.length - 1][0] + tf * 4;
  }, [all, tf]);
  useEffect(() => { seen.current = (getLocalTrades(mint).slice(-1)[0] || { id: 0 }).id; bubbles.current = []; }, [mint]);

  const X = (t: number) => ((t - (view.current.tR - view.current.span)) / view.current.span) * (sizeRef.current.W - PAD_R);
  const T = (x: number) => view.current.tR - view.current.span + (x / (sizeRef.current.W - PAD_R)) * view.current.span;
  const plotH = () => sizeRef.current.H - VOL_H - PAD_T - AXIS_H;
  const Y = (p: number) => { const { lo, hi } = yr.current; const f = log ? (Math.log(p) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) : (p - lo) / (hi - lo); return PAD_T + (1 - f) * plotH(); };
  const P = (y: number) => { const { lo, hi } = yr.current; const f = 1 - (y - PAD_T) / plotH(); return log ? Math.exp(Math.log(lo) + f * (Math.log(hi) - Math.log(lo))) : lo + f * (hi - lo); };

  /* one animation loop: redraws every frame (cheap) so bubbles and the live pulse move smoothly */
  useEffect(() => {
    let raf = 0, tapeAt = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const c = cv.current; if (!c) return;
      const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = height;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      sizeRef.current = { W, H };
      const g = c.getContext('2d'); if (!g || !W) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      const bars = allRef.current, v = view.current, plotW = W - PAD_R, pH = plotH();
      const tL = v.tR - v.span;
      const vis = bars.filter((b) => b[0] + tf >= tL && b[0] <= v.tR);
      if (!vis.length) { g.fillStyle = '#8a8f98'; g.font = '12px ui-monospace, monospace'; g.fillText('No candles in view. Drag to move, or pick another candle size.', 12, 28); return; }
      let lo = Infinity, hi = -Infinity, vmax = 0;
      for (const b of vis) { lo = Math.min(lo, b[3]); hi = Math.max(hi, b[2]); vmax = Math.max(vmax, b[5]); }
      if (hi <= lo) { hi = lo * 1.02; lo *= 0.98; }
      const padv = (hi - lo) * 0.08; lo = Math.max(lo - padv, hi * 1e-4); hi += padv; yr.current = { lo, hi };
      // grid + price axis
      g.font = '10px ui-monospace, monospace'; g.lineWidth = 1;
      for (let i = 0; i <= 5; i++) { const p = log ? Math.exp(Math.log(lo) + ((Math.log(hi) - Math.log(lo)) * i) / 5) : lo + ((hi - lo) * i) / 5, y = Y(p); g.strokeStyle = '#14171e'; g.beginPath(); g.moveTo(0, y); g.lineTo(plotW, y); g.stroke(); g.fillStyle = '#8a8f98'; g.fillText(fmt(p), plotW + 4, y + 3); }
      // time axis
      const stepT = [5, 15, 30, 60, 300, 900, 1800, 3600, 7200, 21600, 43200, 86400, 172800].find((s) => (v.span / s) <= 7) || 172800;
      for (let t = Math.ceil(tL / stepT) * stepT; t < v.tR; t += stepT) { const x = X(t); g.strokeStyle = '#11141a'; g.beginPath(); g.moveTo(x, PAD_T); g.lineTo(x, H - AXIS_H); g.stroke(); g.fillStyle = '#6b7079'; g.fillText(fmtT(t, v.span), Math.max(2, x - 14), H - 5); }
      // candles + volume
      const bw = Math.max(1.5, (tf / v.span) * plotW * 0.72);
      for (const b of vis) {
        const up = b[4] >= b[1], col = up ? GREEN : RED, x = X(b[0] + tf / 2);
        g.strokeStyle = col; g.fillStyle = col;
        g.beginPath(); g.moveTo(x, Y(b[2])); g.lineTo(x, Y(b[3])); g.stroke();
        const yO = Y(b[1]), yC = Y(b[4]); g.fillRect(x - bw / 2, Math.min(yO, yC), bw, Math.max(1, Math.abs(yO - yC)));
        const vh = vmax ? (b[5] / vmax) * (VOL_H - 6) : 0; g.globalAlpha = 0.3; g.fillRect(x - bw / 2, H - AXIS_H - vh, bw, vh); g.globalAlpha = 1;
      }
      // pattern marks
      if (found && found.match && found.levels) {
        g.setLineDash([4, 4]);
        const hl = (p: number, col: string, label: string) => { if (!(p > lo && p < hi)) return; const y = Y(p); g.strokeStyle = col; g.fillStyle = col; g.beginPath(); g.moveTo(0, y); g.lineTo(plotW, y); g.stroke(); g.fillText(label, 4, y - 3); };
        if (found.levels.neckline) hl(found.levels.neckline, GOLD, 'neckline');
        [found.levels.low1, found.levels.low2].forEach((l: number | undefined, i: number) => { if (l) hl(l, BLUE, `bottom ${i + 1}`); });
        g.setLineDash([]);
      }
      // your drawings
      const list = pending.current ? [...drawsRef.current, pending.current] : drawsRef.current;
      for (const d of list) {
        const on = d.id === sel, col = on ? '#fff' : GOLD; g.strokeStyle = col; g.fillStyle = col; g.lineWidth = on ? 2 : 1.5;
        const ax = X(d.a.t), ay = Y(d.a.p), bx = X(d.b.t), by = Y(d.b.p);
        if (d.kind === 'h') { g.beginPath(); g.moveTo(0, ay); g.lineTo(plotW, ay); g.stroke(); g.fillText(fmt(d.a.p), 4, ay - 3); }
        else if (d.kind === 'line') { g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke(); const dx = bx - ax; if (Math.abs(dx) > 2) { const sl = (by - ay) / dx; g.setLineDash([3, 5]); g.beginPath(); g.moveTo(bx, by); g.lineTo(plotW, by + sl * (plotW - bx)); g.stroke(); g.setLineDash([]); } }
        else { g.globalAlpha = 0.12; g.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)); g.globalAlpha = 1; g.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)); }
        if (d.kind !== 'h' || on) { for (const [x, y] of d.kind === 'h' ? [[plotW - 10, ay]] : [[ax, ay], [bx, by]]) { g.beginPath(); g.arc(x, y, on ? 5 : 3, 0, 7); g.fill(); } }
        g.lineWidth = 1;
      }
      // live price line + pulse
      const last = bars[bars.length - 1], ly = Y(last[4]);
      if (ly > PAD_T && ly < H - AXIS_H) {
        const up = last[4] >= last[1]; g.strokeStyle = up ? GREEN : RED; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(0, ly); g.lineTo(plotW, ly); g.stroke(); g.setLineDash([]);
        g.fillStyle = up ? GREEN : RED; g.fillRect(plotW, ly - 8, PAD_R, 16); g.fillStyle = '#0b0d10'; g.fillText(fmt(last[4]), plotW + 4, ly + 3);
        const lx = X(last[0] + tf / 2); if (lx > 0 && lx < plotW) { const pr = 3 + 3 * (0.5 + 0.5 * Math.sin(now / 250)); g.globalAlpha = 0.4; g.fillStyle = up ? GREEN : RED; g.beginPath(); g.arc(lx, Y(last[4]), pr + 2, 0, 7); g.fill(); g.globalAlpha = 1; g.beginPath(); g.arc(lx, Y(last[4]), 2.5, 0, 7); g.fill(); }
      }
      // buy / sell animation: every trade pops out as a bubble that drifts up (buy) or down (sell) and fades
      const trades = getLocalTrades(mint);
      for (const tr of trades) if (tr.id > seen.current) { bubbles.current.push({ x0: 0, t: tr.t, side: tr.side, r: 3 + Math.min(16, Math.sqrt(tr.sol) * 7), p: tr.mcapSol, born: now }); seen.current = tr.id; }
      bubbles.current = bubbles.current.filter((b) => now - b.born < 1800);
      for (const b of bubbles.current) {
        const age = (now - b.born) / 1800, lx = X(last[0] + tf / 2), y = Y(b.p) + (b.side === 'buy' ? -1 : 1) * age * 26;
        if (lx < 0 || lx > plotW) continue;
        g.globalAlpha = (1 - age) * 0.75; g.fillStyle = b.side === 'buy' ? GREEN : RED; g.beginPath(); g.arc(lx + age * 10, y, b.r * (0.6 + age * 0.6), 0, 7); g.fill();
      }
      g.globalAlpha = 1;
      // crosshair
      const pt = pointer.current;
      if (pt && pt.x < plotW && !drag.current) { g.strokeStyle = '#3a3f4a'; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(pt.x, PAD_T); g.lineTo(pt.x, H - AXIS_H); g.moveTo(0, pt.y); g.lineTo(plotW, pt.y); g.stroke(); g.setLineDash([]); g.fillStyle = '#2a2f3a'; g.fillRect(plotW, pt.y - 8, PAD_R, 16); g.fillStyle = '#e8eaee'; g.fillText(fmt(P(pt.y)), plotW + 4, pt.y + 3); }
      if (now - tapeAt > 400) { tapeAt = now; const tl = getLocalTrades(mint); setTape(tl.slice(-12).reverse()); if (pt && pt.x < plotW) { const t = T(pt.x), b = bars.find((x) => t >= x[0] && t < x[0] + tf); setReadout(b ? `${fmtT(b[0], v.span < 300 ? 0 : v.span)} · O ${fmt(b[1])} H ${fmt(b[2])} L ${fmt(b[3])} C ${fmt(b[4])} · ${b[5].toFixed(2)} SOL · ${b[6]} buys / ${b[7]} sells` : `${fmt(P(pt.y))}`); } else if (last) setReadout(`${bars.length} candles · last ${fmt(last[4])}`); }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [tf, log, unit, solUsd, found, sel, height, mint, fmt]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ───── pointer, wheel and pinch ───── */
  const rect = () => cv.current!.getBoundingClientRect();
  const local = (e: { clientX: number; clientY: number }) => { const r = rect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const hit = (x: number, y: number) => {
    for (const d of [...drawsRef.current].reverse()) {
      const ax = X(d.a.t), ay = Y(d.a.p), bx = X(d.b.t), by = Y(d.b.p);
      if (d.kind === 'h') { if (Math.abs(y - ay) < 9) return { d, part: 'move' as const }; continue; }
      if (Math.hypot(x - ax, y - ay) < 14) return { d, part: 'a' as const };
      if (Math.hypot(x - bx, y - by) < 14) return { d, part: 'b' as const };
      if (d.kind === 'line') { const L = Math.hypot(bx - ax, by - ay) || 1, dist = Math.abs((by - ay) * x - (bx - ax) * y + bx * ay - by * ax) / L; if (dist < 8 && x >= Math.min(ax, bx) - 8 && x <= Math.max(ax, bx) + 8) return { d, part: 'move' as const }; }
      else if (x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return { d, part: 'move' as const };
    }
    return null;
  };
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; span: number } | null>(null);
  const uid = () => Math.random().toString(36).slice(2, 9);

  const onDown = (e: React.PointerEvent) => {
    const p = local(e); pts.current.set(e.pointerId, p); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (pts.current.size === 2) { const [a, b] = [...pts.current.values()]; pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), span: view.current.span }; drag.current = null; pending.current = null; return; }
    const h = hit(p.x, p.y);
    if (h) { setSel(h.d.id); drag.current = { mode: h.part === 'move' ? 'move' : 'end', id: h.d.id, end: h.part === 'move' ? undefined : h.part, startX: p.x, startTR: 0, last: { t: T(p.x), p: P(p.y) } }; return; }
    if (tool === 'h') { saveDraws([...drawsRef.current, { id: uid(), kind: 'h', a: { t: T(p.x), p: P(p.y) }, b: { t: T(p.x), p: P(p.y) } }]); setTool('move'); return; }
    if (tool === 'line' || tool === 'rect') {
      if (pending.current) { const d = { ...pending.current, b: { t: T(p.x), p: P(p.y) } }; pending.current = null; saveDraws([...drawsRef.current, d]); setSel(d.id); setTool('move'); return; }
      pending.current = { id: uid(), kind: tool, a: { t: T(p.x), p: P(p.y) }, b: { t: T(p.x), p: P(p.y) } }; drag.current = { mode: 'new', startX: p.x, startTR: 0 }; return;
    }
    setSel(null); view.current.fit = false;
    drag.current = { mode: 'pan', startX: p.x, startTR: view.current.tR };
  };
  const onMove = (e: React.PointerEvent) => {
    const p = local(e); pointer.current = p;
    if (pts.current.has(e.pointerId)) pts.current.set(e.pointerId, p);
    if (pts.current.size === 2 && pinch.current) { const [a, b] = [...pts.current.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); view.current.fit = false; view.current.span = clampSpan(pinch.current.span * (pinch.current.d / Math.max(10, d))); return; }
    if (!drag.current && pending.current) { pending.current = { ...pending.current, b: { t: T(p.x), p: P(p.y) } }; return; }
    const d = drag.current; if (!d) return;
    if (d.mode === 'pan') { view.current.tR = clampTR(d.startTR - ((p.x - d.startX) / (sizeRef.current.W - PAD_R)) * view.current.span); }
    else if (d.mode === 'new' && pending.current) pending.current = { ...pending.current, b: { t: T(p.x), p: P(p.y) } };
    else if (d.mode === 'end' && d.id) saveDrawsLive(drawsRef.current.map((x) => (x.id === d.id ? { ...x, [d.end!]: { t: T(p.x), p: P(p.y) } } : x)));
    else if (d.mode === 'move' && d.id && d.last) { const nt = T(p.x), np = P(p.y), dt = nt - d.last.t, dp = np - d.last.p; d.last = { t: nt, p: np }; saveDrawsLive(drawsRef.current.map((x) => (x.id === d.id ? { ...x, a: { t: x.a.t + dt, p: x.a.p + dp }, b: { t: x.b.t + dt, p: x.b.p + dp } } : x))); }
  };
  const onUp = (e: React.PointerEvent) => {
    pts.current.delete(e.pointerId); if (pts.current.size < 2) pinch.current = null;
    const d = drag.current;
    if (d && d.mode === 'new' && pending.current) { const p = local(e); if (Math.abs(p.x - d.startX) > 8 || Math.abs(Y(pending.current.a.p) - p.y) > 8) { const dr = { ...pending.current, b: { t: T(p.x), p: P(p.y) } }; pending.current = null; saveDraws([...drawsRef.current, dr]); setSel(dr.id); setTool('move'); } }
    if (d && (d.mode === 'end' || d.mode === 'move')) saveDraws(drawsRef.current);
    drag.current = null;
  };
  const saveDrawsLive = (d: Draw[]) => { drawsRef.current = d; setDraws(d); };
  const clampSpan = (s: number) => Math.max(tf * 8, Math.min(tf * 1500, s));
  const clampTR = (t: number) => { const bars = allRef.current; if (!bars.length) return t; const first = bars[0][0], last = bars[bars.length - 1][0]; return Math.max(first + view.current.span * 0.2, Math.min(last + view.current.span * 0.5, t)); };
  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault(); const c = cv.current; if (!c) return; const r = c.getBoundingClientRect(); const x = e.clientX - r.left;
    const tAt = T(x); const f = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0012);
    view.current.fit = false; const span = clampSpan(view.current.span * f); const frac = x / (sizeRef.current.W - PAD_R);
    view.current.span = span; view.current.tR = clampTR(tAt + (1 - frac) * span);
  }, [tf]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const c = cv.current; if (!c) return; c.addEventListener('wheel', onWheel, { passive: false }); return () => c.removeEventListener('wheel', onWheel); }, [onWheel]);

  const zoom = (f: number) => { view.current.fit = false; view.current.span = clampSpan(view.current.span * f); };
  const live = () => { const b = allRef.current; view.current.fit = true; if (b.length) view.current.tR = b[b.length - 1][0] + tf * 4; };
  const delSel = () => { if (sel) { saveDraws(draws.filter((d) => d.id !== sel)); setSel(null); } };
  const buys = tape.filter((t) => t.side === 'buy').reduce((s, t) => s + t.sol, 0), sells = tape.filter((t) => t.side === 'sell').reduce((s, t) => s + t.sol, 0);
  const covers = all.length ? `${all.length} candles · from ${fmtT(all[0][0], 0)}${all[0][0] < Date.now() / 1000 - 86400 ? ' (earlier days)' : ''}` : 'no candles yet';

  return (
    <div className="chartbox own">
      <div className="chead">
        <div className="tfs" role="tablist" aria-label="Candle size">{TF.map((t) => <button key={t.s} role="tab" aria-selected={tf === t.s} className={tf === t.s ? 'on' : ''} onClick={() => setTf(t.s)}>{t.l}</button>)}</div>
        <div className="tfs">
          <button onClick={() => zoom(0.6)} aria-label="Zoom in">＋</button><button onClick={() => zoom(1.6)} aria-label="Zoom out">－</button>
          <button onClick={live} aria-label="Jump to live">Live</button>
        </div>
      </div>
      <div className="chead">
        <div className="tfs" role="toolbar" aria-label="Drawing tools">
          <button className={tool === 'move' ? 'on' : ''} onClick={() => { setTool('move'); pending.current = null; }} aria-label="Move chart">✥ Move</button>
          <button className={tool === 'line' ? 'on' : ''} onClick={() => setTool('line')} aria-label="Draw trend line">╱ Line</button>
          <button className={tool === 'h' ? 'on' : ''} onClick={() => setTool('h')} aria-label="Draw horizontal line">— Level</button>
          <button className={tool === 'rect' ? 'on' : ''} onClick={() => setTool('rect')} aria-label="Draw box">▭ Box</button>
          <button disabled={!sel} onClick={delSel} aria-label="Delete selected drawing">🗑</button>
          <button disabled={!draws.length} onClick={() => { saveDraws([]); setSel(null); }} aria-label="Clear drawings">Clear</button>
        </div>
        <div className="tfs">
          <button className={unit === 'usd' ? 'on' : ''} disabled={!solUsd} onClick={() => setUnit(unit === 'usd' ? 'sol' : 'usd')} aria-label="Switch dollars and SOL">{unit === 'usd' ? '$' : 'SOL'}</button>
          <button className={log ? 'on' : ''} onClick={() => setLog(!log)} aria-label="Log scale">log</button>
        </div>
      </div>
      <canvas ref={cv} style={{ width: '100%', height, display: 'block', touchAction: 'none', cursor: tool === 'move' ? 'grab' : 'crosshair' }} aria-label="Price chart"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={() => { pointer.current = null; }} />
      <div className="cfoot mono">{readout || covers}</div>
      <div className="chead" style={{ marginTop: 6 }}>
        <select aria-label="Show pattern" value={pat} onChange={(e) => setPat(e.target.value)}>
          <option value="double_bottom">Mark double bottom</option><option value="breakout">Mark breakout</option><option value="dip_buy">Mark dip + bounce</option><option value="volume_spike">Mark volume spike</option>
        </select>
        <span className="cfoot mono">{found?.match ? `● ${found.reason}` : 'no pattern right now'}</span>
      </div>
      <div className="tape" aria-label="Live trades">
        <div className="pressure" title="Share of the last trades that were buys"><i style={{ width: `${buys + sells ? Math.round((buys / (buys + sells)) * 100) : 50}%` }} /></div>
        {tape.length === 0 ? <div className="cfoot mono">{`Waiting for trades… ${covers}`}</div> : tape.map((t) => <div key={t.id} className={`trade ${t.side}`}><b>{t.side === 'buy' ? 'BUY' : 'SELL'}</b><span>{t.sol.toFixed(2)} SOL</span><span>{fmt(t.mcapSol)}</span></div>)}
      </div>
    </div>
  );
}
