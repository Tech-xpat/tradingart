'use client';
import { useEffect, type ReactNode } from 'react';

export type Plan = {
  id: string; name: string; sizeUsd: number; minAgeSec: number; maxAgeSec: number | null; takeProfitPct: number; stopLossPct: number;
  maxHoldMin: number; scanEverySec: number; maxTradesDay: number; minLiqUsd: number; minVol1hUsd: number; minBuys1h: number; requireRising: boolean;
};
export type Settings = { paused: boolean; live: boolean; max_position_sol: number; max_daily_loss_pct: number; max_concurrent: number; plans: Plan[]; active_plan: string | null };
export type Me = {
  wallet: string; telegramLinked: boolean; liveEnabled: boolean; solUsd: number | null;
  vault: { address: string; balanceSol: number | null } | null;
  settings: Settings;
  consent: { limits: { mode: string; maxPositionSol: number; maxDailyLossPct: number; maxConcurrent: number }; created_at: string } | null;
  withdrawals: { id: string; amount_lamports: string | null; status: string; tx_sig: string | null; error: string | null; created_at: string }[];
  limits: { maxPositionSol: { min: number; max: number }; maxDailyLossPct: { min: number; max: number }; maxConcurrent: { min: number; max: number }; minVaultSolForLive: number; minSizeUsd: number; defaultSizeUsd: number };
};
export type Pos = { mint: string; openedAt: number; sizeSol: number; lastPnl: number | null; status: string; takeProfitPct: number; stopLossPct: number; mode?: string };
export type Trades = { paper: { open: Pos[]; daily: any }; live: { open: Pos[]; daily: any }; trades: any[] };

export const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
export const sol = (n: number | null | undefined, d = 4) => (n == null ? '–' : n.toFixed(d));
export const signed = (n: number, d = 4) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}`;
export const usd = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(a < 10 ? 2 : 0)}`;
};
export const ago = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
};

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) }, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

export function Sheet({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className={`sheet ${wide ? 'wide' : ''}`} role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><h2>{title}</h2><button className="x" aria-label="Close" onClick={onClose}>×</button></div>
        {children}
      </div>
    </div>
  );
}

export function Slider({ label, value, min, max, step, v, onChange, disabled }: { label: string; value: string; min: number; max: number; step: number; v: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <div className="slider">
      <div><span>{label}</span><b>{value}</b></div>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={v} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
