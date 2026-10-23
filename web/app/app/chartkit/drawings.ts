/**
 * Drawing tools for the token chart: data model, geometry, hit testing and canvas rendering.
 * No chart library imports. The chart supplies a `Proj` that turns (time, price) into pixels and back.
 *
 * Prices are stored in BASE units (market cap in SOL), so a drawing stays put when the unit toggles between SOL and USD.
 * Times are epoch seconds and are mapped to the candle axis by index, so drawings survive timeframe changes and can sit in the future.
 */
export type Pt = { time: number; price: number };
export type DashStyle = 'solid' | 'dashed' | 'dotted';
export type DrawKind = 'trend' | 'hline' | 'hray' | 'vline' | 'rect' | 'channel' | 'fib' | 'measure' | 'arrow' | 'text' | 'brush' | 'long' | 'short';
export type ToolId = 'cursor' | 'trend' | 'ray' | 'extended' | 'hline' | 'hray' | 'vline' | 'channel' | 'rect' | 'fib' | 'measure' | 'arrow' | 'text' | 'brush' | 'long' | 'short';

export type Drawing = {
  id: string; kind: DrawKind; pts: Pt[];
  color: string; width: number; style: DashStyle; fill: number; // fill = 0..1 opacity for shapes
  text?: string; extL?: boolean; extR?: boolean; info?: boolean; locked?: boolean; hidden?: boolean;
};

export type ToolDef = { id: ToolId; kind: DrawKind; label: string; tip: string; need: number; preset?: Partial<Drawing>; icon: string; group: 'Lines' | 'Shapes' | 'Measure' | 'Other' };

const I = (inner: string) => inner; // icon bodies are drawn in a 24x24 box, stroke only
export const TOOLS: ToolDef[] = [
  { id: 'trend', kind: 'trend', label: 'Trend line', tip: 'Drag from one point to another', need: 2, group: 'Lines', icon: I('<path d="M4 19 20 5"/><circle cx="4" cy="19" r="2"/><circle cx="20" cy="5" r="2"/>') },
  { id: 'ray', kind: 'trend', label: 'Ray', tip: 'A line that keeps going to the right', need: 2, preset: { extR: true }, group: 'Lines', icon: I('<path d="M4 19 22 4"/><circle cx="4" cy="19" r="2"/><path d="m17 3 5 1-1 5"/>') },
  { id: 'extended', kind: 'trend', label: 'Extended line', tip: 'A line that goes on in both directions', need: 2, preset: { extL: true, extR: true }, group: 'Lines', icon: I('<path d="M2 21 22 3"/><circle cx="9" cy="15" r="2"/><circle cx="15" cy="9.6" r="2"/>') },
  { id: 'hline', kind: 'hline', label: 'Horizontal line', tip: 'Click to place a price level', need: 1, group: 'Lines', icon: I('<path d="M3 12h18"/><circle cx="12" cy="12" r="2"/>') },
  { id: 'hray', kind: 'hray', label: 'Horizontal ray', tip: 'A level that starts at your click and runs right', need: 1, group: 'Lines', icon: I('<path d="M5 12h17"/><circle cx="5" cy="12" r="2"/>') },
  { id: 'vline', kind: 'vline', label: 'Vertical line', tip: 'Click to mark a moment in time', need: 1, group: 'Lines', icon: I('<path d="M12 3v18"/><circle cx="12" cy="12" r="2"/>') },
  { id: 'channel', kind: 'channel', label: 'Parallel channel', tip: 'Two clicks for the trend, a third for the width', need: 3, group: 'Lines', icon: I('<path d="M3 15 17 5M7 20 21 10"/>') },
  { id: 'rect', kind: 'rect', label: 'Rectangle', tip: 'Drag a box over a zone', need: 2, preset: { fill: 0.16 }, group: 'Shapes', icon: I('<rect x="4" y="6" width="16" height="12" rx="1"/>') },
  { id: 'arrow', kind: 'arrow', label: 'Arrow', tip: 'Point at something', need: 2, group: 'Shapes', icon: I('<path d="M4 20 19 5M10 5h9v9"/>') },
  { id: 'brush', kind: 'brush', label: 'Brush', tip: 'Draw freehand', need: 2, group: 'Shapes', icon: I('<path d="M3 17c3-8 5 4 8-3s5-6 10-7"/>') },
  { id: 'text', kind: 'text', label: 'Text note', tip: 'Click to drop a note', need: 1, group: 'Shapes', icon: I('<path d="M5 6h14M12 6v13M9 19h6"/>') },
  { id: 'fib', kind: 'fib', label: 'Fib retracement', tip: 'Drag from the start of a move to its end', need: 2, preset: { fill: 0.06, extR: true }, group: 'Measure', icon: I('<path d="M3 5h18M3 10h18M3 15h18M3 20h18"/>') },
  { id: 'measure', kind: 'measure', label: 'Measure', tip: 'Drag to read the change, % and time', need: 2, preset: { fill: 0.18 }, group: 'Measure', icon: I('<path d="M3 17 17 3l4 4L7 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>') },
  { id: 'long', kind: 'long', label: 'Long position', tip: 'Drag from entry to target; stop is added for you', need: 2, preset: { fill: 0.2 }, group: 'Measure', icon: I('<path d="M4 4h16v8H4zM4 12h16v8H4z"/>') },
  { id: 'short', kind: 'short', label: 'Short position', tip: 'Drag from entry to target; stop is added for you', need: 2, preset: { fill: 0.2 }, group: 'Measure', icon: I('<path d="M4 4h16v8H4zM4 12h16v8H4z"/><path d="m9 15 3 3 3-3"/>') },
];
export const toolDef = (id: ToolId) => TOOLS.find((t) => t.id === id);
export const PALETTE = ['#f5b83d', '#22c55e', '#ef4444', '#38bdf8', '#a78bfa', '#f472b6', '#e6e9ee', '#94a3b8'];
export const FIB_LEVELS = [
  { v: 0, c: '#94a3b8' }, { v: 0.236, c: '#f87171' }, { v: 0.382, c: '#fb923c' }, { v: 0.5, c: '#4ade80' },
  { v: 0.618, c: '#2dd4bf' }, { v: 0.786, c: '#38bdf8' }, { v: 1, c: '#94a3b8' }, { v: 1.618, c: '#a78bfa' },
];

const DEFAULT_COLOR: Record<DrawKind, string> = { trend: '#f5b83d', hline: '#38bdf8', hray: '#38bdf8', vline: '#94a3b8', rect: '#a78bfa', channel: '#38bdf8', fib: '#e6e9ee', measure: '#38bdf8', arrow: '#f472b6', text: '#e6e9ee', brush: '#22c55e', long: '#22c55e', short: '#ef4444' };
export function needPts(kind: DrawKind): number { return kind === 'channel' || kind === 'long' || kind === 'short' ? 3 : kind === 'hline' || kind === 'hray' || kind === 'vline' || kind === 'text' ? 1 : 2; }

let seq = 0;
export function newDrawing(tool: ToolDef, p: Pt, over?: Partial<Drawing>): Drawing {
  const d: Drawing = { id: `d${Date.now().toString(36)}${(seq++).toString(36)}`, kind: tool.kind, pts: [p], color: DEFAULT_COLOR[tool.kind], width: 2, style: 'solid', fill: 0, ...tool.preset, ...over };
  if (tool.kind === 'text') d.text = 'Note';
  if (needPts(tool.kind) >= 2) d.pts = [p, { ...p }]; // the second point follows the pointer until it is placed
  return d;
}

/** Fill in points the user does not click: stop for positions, centred width point for channels. */
export function finalize(d: Drawing): Drawing {
  if (d.kind === 'long' || d.kind === 'short') {
    const [e, t] = d.pts;
    let tp = t.price;
    if (d.kind === 'long' && tp < e.price) tp = e.price + (e.price - tp);
    if (d.kind === 'short' && tp > e.price) tp = e.price - (tp - e.price);
    const stop = e.price - (tp - e.price);
    d.pts = [e, { time: t.time, price: tp }, { time: t.time, price: stop }];
  } else if (d.kind === 'channel' && d.pts.length === 2) {
    d.pts = [d.pts[0], d.pts[1], { time: (d.pts[0].time + d.pts[1].time) / 2, price: (d.pts[0].price + d.pts[1].price) / 2 - Math.abs(d.pts[1].price - d.pts[0].price) * 0.5 - d.pts[0].price * 0.02 }];
  }
  return d;
}

/** Keep derived points consistent after a move or handle drag (position stop shares the target's time; channel width point stays centred). */
export function normalize(d: Drawing): Drawing {
  if ((d.kind === 'long' || d.kind === 'short') && d.pts.length === 3) d.pts[2] = { time: d.pts[1].time, price: d.pts[2].price };
  if (d.kind === 'channel' && d.pts.length === 3) d.pts[2] = { time: (d.pts[0].time + d.pts[1].time) / 2, price: d.pts[2].price };
  return d;
}

// ───────────────────────── time <-> logical index ─────────────────────────

/** Where on the candle axis a time sits: a fractional index, extended past either end at one timeframe per bar. */
export function timeToLogical(t: number, times: number[], tf: number): number | null {
  const n = times.length; if (!n || !(tf > 0)) return null;
  if (t <= times[0]) return (t - times[0]) / tf;
  if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / tf;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
  return lo + (t - times[lo]) / (times[hi] - times[lo]);
}
export function logicalToTime(l: number, times: number[], tf: number): number | null {
  const n = times.length; if (!n || !(tf > 0) || !Number.isFinite(l)) return null;
  if (l <= 0) return times[0] + l * tf;
  if (l >= n - 1) return times[n - 1] + (l - (n - 1)) * tf;
  const i = Math.floor(l), f = l - i;
  return times[i] + (times[i + 1] - times[i]) * f;
}

// ───────────────────────── geometry ─────────────────────────

export type Proj = {
  w: number; h: number; tf: number;
  px: (p: Pt) => { x: number; y: number } | null;
  price: (basePrice: number) => string;
  time: (sec: number) => string;
};
export type Op =
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; w: number; dash: number[]; hit?: boolean }
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; sw?: number; dash?: number[]; hit?: 'edge' | 'area' }
  | { t: 'poly'; pts: number[][]; fill?: string; stroke?: string; sw?: number; hit?: 'area' | 'edge' }
  | { t: 'path'; pts: number[][]; color: string; w: number; hit?: boolean }
  | { t: 'text'; ax: number; align: 'left' | 'right' | 'center'; lines: string[]; color: string; bg?: string; size: number; bx: number; by: number; bw: number; bh: number; hit?: boolean };
export type Handle = { x: number; y: number; set: (d: Drawing, np: Pt) => void };

export const DASH: Record<DashStyle, number[]> = { solid: [], dashed: [8, 5], dotted: [2, 4] };

export function rgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(148,163,184,${a})`;
  let h = m[1]; if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function extend(x1: number, y1: number, x2: number, y2: number, w: number, h: number, l: boolean, r: boolean): [number, number, number, number] {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
  if (len < 1e-6) return [x1, y1, x2, y2];
  const far = (Math.max(w, h) * 4 + 1000) / len;
  return [l ? x1 - dx * far : x1, l ? y1 - dy * far : y1, r ? x2 + dx * far : x2, r ? y2 + dy * far : y2];
}

function label(x: number, y: number, lines: string[], color: string, o: { bg?: string; size?: number; align?: 'left' | 'right' | 'center'; base?: 'top' | 'bottom' | 'middle'; hit?: boolean } = {}): Op {
  const size = o.size ?? 11, w = Math.max(...lines.map((s) => s.length)) * size * 0.62 + 10, h = lines.length * size * 1.35 + 6;
  const bx = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
  const by = o.base === 'bottom' ? y - h : o.base === 'middle' ? y - h / 2 : y;
  return { t: 'text', ax: x, align: o.align ?? 'left', lines, color, bg: o.bg, size, bx, by, bw: w, bh: h, hit: o.hit };
}

const pctTxt = (a: number, b: number) => (a ? `${b >= a ? '+' : ''}${(((b - a) / a) * 100).toFixed(2)}%` : '–');
export function fmtDur(sec: number): string {
  const s = Math.abs(Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** Everything needed to draw one drawing and to click on it. Returns no ops when a point is off the chart. */
export function buildOps(d: Drawing, pr: Proj): { ops: Op[]; handles: Handle[] } {
  const ops: Op[] = [], handles: Handle[] = [];
  const pts = d.pts.map((p) => pr.px(p));
  if (!pts.length || pts.some((p) => !p)) return { ops, handles };
  const P = pts as { x: number; y: number }[];
  const dash = DASH[d.style], col = d.color, w = d.width;
  const set = (i: number) => (dd: Drawing, np: Pt) => { dd.pts[i] = np; };
  switch (d.kind) {
    case 'trend': {
      const [a, b] = P; const [x1, y1, x2, y2] = extend(a.x, a.y, b.x, b.y, pr.w, pr.h, !!d.extL, !!d.extR);
      ops.push({ t: 'line', x1, y1, x2, y2, color: col, w, dash, hit: true });
      if (d.info) {
        const bars = Math.round((d.pts[1].time - d.pts[0].time) / pr.tf);
        ops.push(label((a.x + b.x) / 2, (a.y + b.y) / 2 - 8, [`${pctTxt(d.pts[0].price, d.pts[1].price)} · ${Math.abs(bars)} bars`], '#e6e9ee', { bg: 'rgba(14,22,33,.85)', align: 'center', base: 'bottom' }));
      }
      handles.push({ x: a.x, y: a.y, set: set(0) }, { x: b.x, y: b.y, set: set(1) });
      break;
    }
    case 'hline': {
      const y = P[0].y;
      ops.push({ t: 'line', x1: 0, y1: y, x2: pr.w, y2: y, color: col, w, dash, hit: true });
      ops.push(label(pr.w - 4, y, [pr.price(d.pts[0].price)], '#0b0d10', { bg: col, align: 'right', base: 'middle' }));
      handles.push({ x: Math.min(pr.w * 0.18, pr.w - 40), y, set: (dd, np) => { dd.pts[0] = { ...dd.pts[0], price: np.price }; } });
      break;
    }
    case 'hray': {
      const { x, y } = P[0];
      ops.push({ t: 'line', x1: x, y1: y, x2: pr.w, y2: y, color: col, w, dash, hit: true });
      ops.push(label(pr.w - 4, y, [pr.price(d.pts[0].price)], '#0b0d10', { bg: col, align: 'right', base: 'middle' }));
      handles.push({ x, y, set: set(0) });
      break;
    }
    case 'vline': {
      const x = P[0].x;
      ops.push({ t: 'line', x1: x, y1: 0, x2: x, y2: pr.h, color: col, w, dash, hit: true });
      ops.push(label(x, pr.h - 4, [pr.time(d.pts[0].time)], '#0b0d10', { bg: col, align: 'center', base: 'bottom' }));
      handles.push({ x, y: Math.min(pr.h * 0.3, pr.h - 20), set: (dd, np) => { dd.pts[0] = { ...dd.pts[0], time: np.time }; } });
      break;
    }
    case 'rect': {
      const [a, b] = P, x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), rw = Math.abs(a.x - b.x), rh = Math.abs(a.y - b.y);
      ops.push({ t: 'rect', x, y, w: rw, h: rh, fill: d.fill > 0 ? rgba(col, d.fill) : undefined, stroke: col, sw: w, dash, hit: d.fill > 0 ? 'area' : 'edge' });
      handles.push(
        { x: a.x, y: a.y, set: set(0) }, { x: b.x, y: b.y, set: set(1) },
        { x: a.x, y: b.y, set: (dd, np) => { dd.pts[0] = { ...dd.pts[0], time: np.time }; dd.pts[1] = { ...dd.pts[1], price: np.price }; } },
        { x: b.x, y: a.y, set: (dd, np) => { dd.pts[1] = { ...dd.pts[1], time: np.time }; dd.pts[0] = { ...dd.pts[0], price: np.price }; } },
      );
      break;
    }
    case 'channel': {
      const [a, b, c] = P;
      if (!c) { // still placing the first two points: show the base line only
        const [x1, y1, x2, y2] = extend(a.x, a.y, b.x, b.y, pr.w, pr.h, !!d.extL, !!d.extR);
        ops.push({ t: 'line', x1, y1, x2, y2, color: col, w, dash });
        handles.push({ x: a.x, y: a.y, set: set(0) }, { x: b.x, y: b.y, set: set(1) });
        break;
      }
      const dx = b.x - a.x, yAtC = Math.abs(dx) < 1e-6 ? a.y : a.y + ((b.y - a.y) * (c.x - a.x)) / dx, off = c.y - yAtC;
      const [x1, y1, x2, y2] = extend(a.x, a.y, b.x, b.y, pr.w, pr.h, !!d.extL, !!d.extR);
      if (d.fill > 0) ops.push({ t: 'poly', pts: [[x1, y1], [x2, y2], [x2, y2 + off], [x1, y1 + off]], fill: rgba(col, d.fill), hit: 'area' });
      ops.push({ t: 'line', x1, y1, x2, y2, color: col, w, dash, hit: true });
      ops.push({ t: 'line', x1, y1: y1 + off, x2, y2: y2 + off, color: col, w, dash, hit: true });
      ops.push({ t: 'line', x1, y1: y1 + off / 2, x2, y2: y2 + off / 2, color: rgba(col, 0.55), w: 1, dash: [4, 4] });
      handles.push({ x: a.x, y: a.y, set: set(0) }, { x: b.x, y: b.y, set: set(1) },
        { x: c.x, y: c.y, set: (dd, np) => { dd.pts[2] = { time: (dd.pts[0].time + dd.pts[1].time) / 2, price: np.price }; } });
      break;
    }
    case 'fib': {
      const [a, b] = P, x0 = Math.min(a.x, b.x), x1 = d.extR ? pr.w : Math.max(a.x, b.x);
      const p0 = d.pts[0].price, p1 = d.pts[1].price;
      let prevY: number | null = null;
      FIB_LEVELS.forEach((lv, i) => {
        const price = p1 + (p0 - p1) * lv.v, q = pr.px({ time: d.pts[1].time, price });
        if (!q) return;
        if (prevY != null && d.fill > 0) ops.push({ t: 'rect', x: x0, y: Math.min(prevY, q.y), w: x1 - x0, h: Math.abs(q.y - prevY), fill: rgba(FIB_LEVELS[i - 1].c, d.fill) });
        prevY = q.y;
        ops.push({ t: 'line', x1: x0, y1: q.y, x2: x1, y2: q.y, color: lv.c, w: Math.max(1, w - 1), dash, hit: true });
        ops.push(label(x0 + 2, q.y - 1, [`${lv.v} (${pr.price(price)})`], lv.c, { size: 10, base: 'bottom' }));
      });
      ops.push({ t: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: rgba(col, 0.6), w: 1, dash: [4, 4] });
      handles.push({ x: a.x, y: a.y, set: set(0) }, { x: b.x, y: b.y, set: set(1) });
      break;
    }
    case 'measure': {
      const [a, b] = P, up = d.pts[1].price >= d.pts[0].price, c2 = up ? '#22c55e' : '#ef4444';
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), rw = Math.abs(a.x - b.x), rh = Math.abs(a.y - b.y);
      ops.push({ t: 'rect', x, y, w: rw, h: rh, fill: rgba(c2, Math.max(0.05, d.fill)), stroke: rgba(c2, 0.7), sw: 1, hit: 'area' });
      ops.push({ t: 'line', x1: a.x, y1: (a.y + b.y) / 2, x2: b.x, y2: (a.y + b.y) / 2, color: rgba(c2, 0.8), w: 1, dash: [] });
      ops.push({ t: 'line', x1: (a.x + b.x) / 2, y1: a.y, x2: (a.x + b.x) / 2, y2: b.y, color: rgba(c2, 0.8), w: 1, dash: [] });
      const bars = Math.round((d.pts[1].time - d.pts[0].time) / pr.tf), dt = d.pts[1].time - d.pts[0].time;
      const dp = d.pts[1].price - d.pts[0].price;
      ops.push(label((a.x + b.x) / 2, up ? y - 4 : y + rh + 4, [`${dp >= 0 ? '+' : '-'}${pr.price(Math.abs(dp))}  ${pctTxt(d.pts[0].price, d.pts[1].price)}`, `${Math.abs(bars)} bars · ${fmtDur(dt)}`], '#0b0d10', { bg: c2, align: 'center', base: up ? 'bottom' : 'top' }));
      handles.push({ x: a.x, y: a.y, set: set(0) }, { x: b.x, y: b.y, set: set(1) });
      break;
    }
    case 'arrow': {
      const [a, b] = P, ang = Math.atan2(b.y - a.y, b.x - a.x), s = 6 + w * 2;
      ops.push({ t: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: col, w, dash, hit: true });
      ops.push({ t: 'poly', pts: [[b.x, b.y], [b.x - s * Math.cos(ang - 0.45), b.y - s * Math.sin(ang - 0.45)], [b.x - s * Math.cos(ang + 0.45), b.y - s * Math.sin(ang + 0.45)]], fill: col });
      handles.push({ x: a.x, y: a.y, set: set(0) }, { x: b.x, y: b.y, set: set(1) });
      break;
    }
    case 'text': {
      const o = label(P[0].x, P[0].y, (d.text || 'Note').split('\n').slice(0, 4), col, { bg: 'rgba(14,22,33,.9)', size: 12, base: 'middle', hit: true });
      ops.push(o);
      handles.push({ x: P[0].x, y: P[0].y, set: set(0) });
      break;
    }
    case 'brush': {
      ops.push({ t: 'path', pts: P.map((p) => [p.x, p.y]), color: col, w, hit: true });
      break;
    }
    case 'long':
    case 'short': {
      const [e, t, s] = P; if (!t || !s) break;
      const x0 = Math.min(e.x, t.x), x1 = Math.max(e.x, t.x, x0 + 40), ww = x1 - x0;
      const ep = d.pts[0].price, tp = d.pts[1].price, sp = d.pts[2].price;
      ops.push({ t: 'rect', x: x0, y: Math.min(e.y, t.y), w: ww, h: Math.abs(e.y - t.y), fill: rgba('#22c55e', d.fill || 0.2), stroke: rgba('#22c55e', 0.8), sw: 1, hit: 'area' });
      ops.push({ t: 'rect', x: x0, y: Math.min(e.y, s.y), w: ww, h: Math.abs(e.y - s.y), fill: rgba('#ef4444', d.fill || 0.2), stroke: rgba('#ef4444', 0.8), sw: 1, hit: 'area' });
      ops.push({ t: 'line', x1: x0, y1: e.y, x2: x1, y2: e.y, color: '#e6e9ee', w: 1, dash: [] });
      const reward = Math.abs(tp - ep), risk = Math.abs(ep - sp), rr = risk > 0 ? reward / risk : 0;
      ops.push(label((x0 + x1) / 2, Math.min(e.y, t.y) - 3, [`Target ${pr.price(tp)} (${pctTxt(ep, tp)})`], '#0b0d10', { bg: '#22c55e', align: 'center', base: 'bottom' }));
      ops.push(label((x0 + x1) / 2, Math.max(e.y, s.y) + 3, [`Stop ${pr.price(sp)} (${pctTxt(ep, sp)})`], '#0b0d10', { bg: '#ef4444', align: 'center', base: 'top' }));
      ops.push(label((x0 + x1) / 2, e.y, [`R:R ${rr.toFixed(2)}`], '#e6e9ee', { bg: 'rgba(14,22,33,.9)', align: 'center', base: 'middle' }));
      handles.push({ x: e.x, y: e.y, set: (dd, np) => { dd.pts[0] = np; } },
        { x: t.x, y: t.y, set: (dd, np) => { dd.pts[1] = np; dd.pts[2] = { time: np.time, price: dd.pts[2].price }; } },
        { x: t.x, y: s.y, set: (dd, np) => { dd.pts[2] = { time: dd.pts[1].time, price: np.price }; } });
      break;
    }
  }
  // keep labels inside the chart instead of being cut off at an edge
  for (const o of ops) {
    if (o.t !== 'text') continue;
    const shift = Math.max(2 - o.bx, Math.min(0, pr.w - 2 - (o.bx + o.bw)));
    if (shift) { o.bx += shift; o.ax += shift; }
  }
  return { ops, handles };
}

// ───────────────────────── hit testing ─────────────────────────

export function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function inPoly(x: number, y: number, p: number[][]): boolean {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  }
  return c;
}
export function hitOps(ops: Op[], x: number, y: number, tol = 7): boolean {
  for (const o of ops) {
    if (o.t === 'line' && o.hit && distToSeg(x, y, o.x1, o.y1, o.x2, o.y2) <= tol) return true;
    if (o.t === 'rect' && o.hit) {
      const inside = x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h;
      if (o.hit === 'area' && inside) return true;
      if (o.hit === 'edge') {
        const outer = x >= o.x - tol && x <= o.x + o.w + tol && y >= o.y - tol && y <= o.y + o.h + tol;
        const inner = x > o.x + tol && x < o.x + o.w - tol && y > o.y + tol && y < o.y + o.h - tol;
        if (outer && !inner) return true;
      }
    }
    if (o.t === 'poly' && o.hit && inPoly(x, y, o.pts)) return true;
    if (o.t === 'path' && o.hit) { for (let i = 1; i < o.pts.length; i++) if (distToSeg(x, y, o.pts[i - 1][0], o.pts[i - 1][1], o.pts[i][0], o.pts[i][1]) <= tol) return true; }
    if (o.t === 'text' && o.hit && x >= o.bx - 3 && x <= o.bx + o.bw + 3 && y >= o.by - 3 && y <= o.by + o.bh + 3) return true;
  }
  return false;
}
export function hitHandle(handles: Handle[], x: number, y: number, tol = 10): number {
  let best = -1, bd = tol;
  handles.forEach((h, i) => { const dd = Math.hypot(h.x - x, h.y - y); if (dd <= bd) { bd = dd; best = i; } });
  return best;
}

// ───────────────────────── rendering ─────────────────────────

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
export function renderOps(ctx: CanvasRenderingContext2D, ops: Op[]) {
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const o of ops) {
    if (o.t === 'line') { ctx.setLineDash(o.dash); ctx.lineWidth = o.w; ctx.strokeStyle = o.color; ctx.beginPath(); ctx.moveTo(o.x1, o.y1); ctx.lineTo(o.x2, o.y2); ctx.stroke(); }
    else if (o.t === 'rect') {
      if (o.fill) { ctx.fillStyle = o.fill; ctx.fillRect(o.x, o.y, o.w, o.h); }
      if (o.stroke) { ctx.setLineDash(o.dash || []); ctx.lineWidth = o.sw || 1; ctx.strokeStyle = o.stroke; ctx.strokeRect(o.x, o.y, o.w, o.h); }
    } else if (o.t === 'poly') {
      ctx.beginPath(); o.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
      if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(); }
      if (o.stroke) { ctx.setLineDash([]); ctx.lineWidth = o.sw || 1; ctx.strokeStyle = o.stroke; ctx.stroke(); }
    } else if (o.t === 'path') {
      ctx.setLineDash([]); ctx.lineWidth = o.w; ctx.strokeStyle = o.color; ctx.beginPath(); o.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke();
    } else if (o.t === 'text') {
      ctx.setLineDash([]); ctx.font = `600 ${o.size}px ui-monospace, SFMono-Regular, Menlo, monospace`; ctx.textBaseline = 'top';
      const w = Math.max(...o.lines.map((s) => ctx.measureText(s).width)) + 10;
      const bx = o.align === 'right' ? o.ax - w : o.align === 'center' ? o.ax - w / 2 : o.ax;
      if (o.bg) { ctx.fillStyle = o.bg; pill(ctx, bx, o.by, w, o.bh, 4); ctx.fill(); }
      ctx.fillStyle = o.color; o.lines.forEach((s, i) => ctx.fillText(s, bx + 5, o.by + 3 + i * o.size * 1.35));
    }
  }
  ctx.setLineDash([]);
}
export function renderHandles(ctx: CanvasRenderingContext2D, handles: Handle[], color: string) {
  ctx.setLineDash([]);
  for (const h of handles) { ctx.beginPath(); ctx.arc(h.x, h.y, 5, 0, Math.PI * 2); ctx.fillStyle = '#0b0d10'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke(); }
}

// ───────────────────────── persistence ─────────────────────────

const KINDS: DrawKind[] = ['trend', 'hline', 'hray', 'vline', 'rect', 'channel', 'fib', 'measure', 'arrow', 'text', 'brush', 'long', 'short'];
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
/** Accept only well-formed drawings from storage; anything odd is dropped instead of crashing the chart. */
export function sanitize(raw: unknown): Drawing[] {
  if (!Array.isArray(raw)) return [];
  const out: Drawing[] = [];
  for (const r of raw.slice(0, 200)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (!KINDS.includes(o.kind as DrawKind) || !Array.isArray(o.pts)) continue;
    const pts = (o.pts as unknown[]).filter((p): p is Pt => !!p && typeof p === 'object' && finite((p as Pt).time) && finite((p as Pt).price)).map((p) => ({ time: p.time, price: p.price })).slice(0, 2000);
    const kind = o.kind as DrawKind;
    if (pts.length < needPts(kind)) continue;
    out.push({
      id: typeof o.id === 'string' ? o.id.slice(0, 40) : `d${out.length}${Date.now().toString(36)}`, kind, pts,
      color: typeof o.color === 'string' && /^#[0-9a-f]{3,6}$/i.test(o.color) ? o.color : DEFAULT_COLOR[kind],
      width: finite(o.width) ? Math.min(6, Math.max(1, Math.round(o.width))) : 2,
      style: o.style === 'dashed' || o.style === 'dotted' ? o.style : 'solid',
      fill: finite(o.fill) ? Math.min(1, Math.max(0, o.fill)) : 0,
      text: typeof o.text === 'string' ? o.text.slice(0, 120) : undefined,
      extL: !!o.extL, extR: !!o.extR, info: !!o.info, locked: !!o.locked, hidden: !!o.hidden,
    });
  }
  return out;
}
const key = (mint: string) => `art.chart.draw.v1.${mint}`;
export function loadDrawings(mint: string): Drawing[] {
  try { const s = typeof localStorage !== 'undefined' ? localStorage.getItem(key(mint)) : null; return s ? sanitize(JSON.parse(s)) : []; } catch { return []; }
}
export function saveDrawings(mint: string, list: Drawing[]) {
  try { if (list.length) localStorage.setItem(key(mint), JSON.stringify(list)); else localStorage.removeItem(key(mint)); } catch { /* storage full or blocked */ }
}
