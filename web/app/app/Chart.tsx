'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as charting from '@/lib/charting';

type Bar = number[]; // [t, o, h, l, c, volSol, buys, sells] — prices are market cap in SOL
const TF = [{ s: 5, l: '5s' }, { s: 15, l: '15s' }, { s: 60, l: '1m' }, { s: 300, l: '5m' }];
const fmt = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`);

/** Our own candlestick chart (canvas). Shows market cap in USD, volume, and the pattern engine's marks when it sees one. */
export default function Chart({ bars, solUsd, height = 300 }: { bars: Bar[]; solUsd: number | null; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [tf, setTf] = useState(15);
  const [hover, setHover] = useState<number | null>(null);
  const [pat, setPat] = useState<string>('double_bottom');
  const k = solUsd || 0;
  const data = useMemo(() => charting.resample(bars, tf).slice(-90) as Bar[], [bars, tf]);
  const found = useMemo(() => {
    const full = charting.resample(bars, tf) as Bar[];
    const r = charting.detect(pat, full, { tolerancePct: 6, minDropPct: 25, bouncePct: 8, confirmPct: 2, trigger: 'confirm', lookbackBars: 120, volMult: 4 });
    return { r, offset: Math.max(0, full.length - 90) };
  }, [bars, tf, pat]);

  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = height;
    cv.width = W * dpr; cv.height = H * dpr;
    const c = cv.getContext('2d'); if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    if (!data.length) return;
    const padR = 56, padT = 8, volH = 46, plotH = H - volH - padT - 16, plotW = W - padR;
    const mul = k || 1;
    let lo = Infinity, hi = -Infinity, vmax = 0;
    for (const b of data) { lo = Math.min(lo, b[3]); hi = Math.max(hi, b[2]); vmax = Math.max(vmax, b[5]); }
    if (hi === lo) { hi *= 1.01; lo *= 0.99; }
    const y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * plotH;
    const step = plotW / Math.max(data.length, 30), bw = Math.max(1.5, step * 0.7);
    const X = (i: number) => i * step + step / 2;
    c.font = '10px ui-monospace, monospace'; c.fillStyle = '#8a8f98'; c.strokeStyle = '#1b1e26'; c.lineWidth = 1;
    for (let g = 0; g <= 4; g++) { const p = lo + ((hi - lo) * g) / 4, yy = y(p); c.beginPath(); c.moveTo(0, yy); c.lineTo(plotW, yy); c.stroke(); c.fillText(k ? fmt(p * mul) : `${p.toFixed(1)} SOL`, plotW + 4, yy + 3); }
    data.forEach((b, i) => {
      const up = b[4] >= b[1], col = up ? '#C6FF3D' : '#ff5c6c', x = X(i);
      c.strokeStyle = col; c.fillStyle = col;
      c.beginPath(); c.moveTo(x, y(b[2])); c.lineTo(x, y(b[3])); c.stroke();
      const top = y(Math.max(b[1], b[4])), h = Math.max(1, Math.abs(y(b[1]) - y(b[4])));
      c.fillRect(x - bw / 2, top, bw, h);
      const vh = vmax ? (b[5] / vmax) * volH : 0; c.globalAlpha = 0.35; c.fillRect(x - bw / 2, H - 14 - vh, bw, vh); c.globalAlpha = 1;
    });
    const r = found.r;
    if (r && r.match && r.levels) {
      c.setLineDash([4, 4]); c.lineWidth = 1;
      const line = (p: number, col: string, label: string) => { if (p < lo || p > hi) return; const yy = y(p); c.strokeStyle = col; c.beginPath(); c.moveTo(0, yy); c.lineTo(plotW, yy); c.stroke(); c.fillStyle = col; c.fillText(label, 4, yy - 3); };
      if (r.levels.neckline) line(r.levels.neckline, '#FFD23F', 'neckline');
      const lows = [r.levels.low1, r.levels.low2].filter(Boolean) as number[];
      lows.forEach((l, i) => line(l, '#7dd3fc', `bottom ${i + 1}`));
      c.setLineDash([]);
      (r.idx || []).forEach((ix: number) => { const j = ix - found.offset; if (j >= 0 && j < data.length) { c.fillStyle = '#FFD23F'; c.beginPath(); c.arc(X(j), y(data[j][3]) + 6, 3, 0, 7); c.fill(); } });
    }
    if (hover != null && data[hover]) { const x = X(hover); c.strokeStyle = '#555'; c.setLineDash([2, 3]); c.beginPath(); c.moveTo(x, padT); c.lineTo(x, H - 14); c.stroke(); c.setLineDash([]); }
  }, [data, k, height, hover, found]);

  const h = hover != null ? data[hover] : null;
  const last = data[data.length - 1];
  return (
    <div className="chartbox own">
      <div className="chead">
        <div className="tfs" role="tablist" aria-label="Candle size">{TF.map((t) => <button key={t.s} role="tab" aria-selected={tf === t.s} className={tf === t.s ? 'on' : ''} onClick={() => setTf(t.s)}>{t.l}</button>)}</div>
        <select aria-label="Show pattern" value={pat} onChange={(e) => setPat(e.target.value)}>
          <option value="double_bottom">Mark double bottom</option><option value="breakout">Mark breakout</option><option value="dip_buy">Mark dip + bounce</option><option value="volume_spike">Mark volume spike</option>
        </select>
      </div>
      <canvas ref={ref} style={{ width: '100%', height, display: 'block', touchAction: 'pan-y' }} aria-label="Price chart"
        onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const W = r.width, step = (W - 56) / Math.max(data.length, 30); const i = Math.floor((e.clientX - r.left) / step); setHover(i >= 0 && i < data.length ? i : null); }}
        onPointerLeave={() => setHover(null)} />
      <div className="cfoot mono">
        {h ? `O ${fmt(h[1] * (k || 1))} · H ${fmt(h[2] * (k || 1))} · L ${fmt(h[3] * (k || 1))} · C ${fmt(h[4] * (k || 1))} · ${h[5].toFixed(2)} SOL · ${h[6]}b/${h[7]}s`
          : last ? `${data.length} candles · last ${fmt(last[4] * (k || 1))}${found.r?.match ? ` · ${found.r.reason}` : ''}` : ''}
      </div>
    </div>
  );
}
