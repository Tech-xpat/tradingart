'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, Sheet, Spark, short, sol, signed, usd, ago, type Me, type Plan } from './shared';

type Row = { rank: number; handle: string; me: boolean; followers: number; pnlSol: number; pnlUsd: number | null; roiPct: number | null; winRate: number | null; trades: number; curve: number[] };
type Profile = {
  handle: string; me: boolean; mode: 'live' | 'paper'; following: boolean; followers: number;
  stats: { pnlSol: number; pnlUsd: number | null; todaySol: number; roiPct: number | null; winRate: number | null; trades: number };
  curve: [number, number][];
  open: { mint: string; openedAt: number; lastPnl: number | null; trail: [number, number][]; takeProfitPct: number; stopLossPct: number }[];
  recent: { at: string; mint: string; realizedSol: number; pct: number | null; holdSec: number | null; reason: string | null }[];
  plan: Omit<Plan, 'id' | 'name'> | null;
};

const dur = (s: number) => (s >= 86400 ? `${+(s / 86400).toFixed(2)}d` : s >= 3600 ? `${+(s / 3600).toFixed(2)}h` : s >= 60 ? `${+(s / 60).toFixed(2)}m` : `${s}s`);
const pct = (n: number | null | undefined) => (n == null ? '–' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`);
const cls = (n: number | null | undefined) => (n == null ? '' : n >= 0 ? 'up' : 'dn');

function ProfileSheet({ handle, mode, signedIn, onClose, onChanged, say }: { handle: string; mode: 'live' | 'paper'; signedIn: boolean; onClose: () => void; onChanged: () => void; say: (k: 'ok' | 'err', t: string) => void }) {
  const [p, setP] = useState<Profile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => { try { setP(await api<Profile>(`/api/profile?handle=${encodeURIComponent(handle)}&mode=${mode}`)); setErr(null); } catch (e: any) { setErr(e.message); } }, [handle, mode]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  const copy = async (auto: boolean) => {
    setBusy(auto ? 'auto' : 'copy');
    try {
      await api('/api/copy', { method: 'POST', body: JSON.stringify({ handle, auto }) });
      say('ok', auto ? `Auto-copy on. Your active plan now mirrors @${handle}.` : `Saved @${handle}'s plan to your plans.`);
      await load(); onChanged();
    } catch (e: any) { say('err', e.message); } finally { setBusy(null); }
  };
  const stop = async () => { setBusy('stop'); try { await api('/api/copy', { method: 'POST', body: JSON.stringify({ stop: true }) }); say('ok', 'Auto-copy stopped. The saved plan stays.'); await load(); onChanged(); } catch (e: any) { say('err', e.message); } finally { setBusy(null); } };
  const pl = p?.plan;
  return (
    <Sheet title={`@${handle}`} onClose={onClose} wide>
      {err && <p className="hint dn">{err}</p>}
      {!p && !err && <p className="hint">Loading…</p>}
      {p && (
        <div className="prof">
          <div className="pstats">
            <div><span>Profit ({p.mode})</span><b className={cls(p.stats.pnlSol)}>{signed(p.stats.pnlSol)} <em>SOL</em></b><small>{p.stats.pnlUsd != null ? `${p.stats.pnlUsd >= 0 ? '+' : '−'}${usd(Math.abs(p.stats.pnlUsd))}` : ''}</small></div>
            <div><span>Last 24h</span><b className={cls(p.stats.todaySol)}>{signed(p.stats.todaySol)}</b></div>
            <div><span>Win rate</span><b>{p.stats.winRate == null ? '–' : `${p.stats.winRate.toFixed(0)}%`}</b><small>{p.stats.trades} trades</small></div>
            <div><span>ROI</span><b className={cls(p.stats.roiPct)}>{pct(p.stats.roiPct)}</b><small>{p.followers} copying</small></div>
          </div>

          <h3>Progress map</h3>
          <div className="bigspark"><Spark values={p.curve.map((c) => c[1])} w={560} h={130} zero label="Total profit over time" /></div>

          {p.open.length > 0 && (<>
            <h3>Trading now</h3>
            {p.open.map((o) => (
              <div className="feed" key={o.mint}>
                <div><b>{short(o.mint)}</b><span>{ago(Date.now() - o.openedAt)} · exits +{o.takeProfitPct}% / −{o.stopLossPct}%</span></div>
                <Spark values={(o.trail || []).map((x) => x[1])} w={70} h={28} zero label={`Progress of ${short(o.mint)}`} />
                <strong className={cls(o.lastPnl)}>{pct(o.lastPnl)}</strong>
              </div>
            ))}
          </>)}

          <h3>Recent trades</h3>
          {p.recent.length === 0 ? <div className="empty">No closed trades yet.</div> : p.recent.slice(0, 10).map((t, i) => (
            <div className="feed" key={i}>
              <div><b>{short(t.mint)}</b><span>{t.reason || 'closed'}{t.holdSec != null ? ` · ${dur(t.holdSec)}` : ''} · {ago(Date.now() - new Date(t.at).getTime())} ago</span></div>
              <strong className={cls(t.realizedSol)}>{signed(t.realizedSol)} SOL</strong>
            </div>
          ))}

          {pl && (<>
            <h3>Their plan</h3>
            <div className="plangrid" aria-label="Plan settings">
              <span>Trade size</span><b>${pl.sizeUsd}</b>
              <span>Coin age</span><b>{dur(pl.minAgeSec)} to {pl.maxAgeSec == null ? 'any age' : dur(pl.maxAgeSec)}</b>
              <span>Take profit / Stop loss</span><b>+{pl.takeProfitPct}% / −{pl.stopLossPct}%</b>
              <span>Max hold</span><b>{pl.maxHoldMin >= 60 ? `${+(pl.maxHoldMin / 60).toFixed(2)}h` : `${pl.maxHoldMin}m`}</b>
              <span>Scan every</span><b>{dur(pl.scanEverySec)}</b>
              <span>Trades per day</span><b>{pl.maxTradesDay}</b>
              <span>Liquidity / 1h volume</span><b>{usd(pl.minLiqUsd)} / {usd(pl.minVol1hUsd)}</b>
              <span>Buys 1h · Rising only</span><b>{pl.minBuys1h} · {pl.requireRising ? 'yes' : 'no'}</b>
            </div>
          </>)}

          {!signedIn ? <p className="hint">Connect your wallet to copy this plan.</p> : p.me ? <p className="hint">This is your public profile.</p> : (
            <div className="copyrow">
              <button className="btn btn-ghost" disabled={!!busy || !pl} onClick={() => copy(false)} aria-label="Copy plan">{busy === 'copy' ? 'Saving…' : 'Copy plan'}</button>
              {p.following
                ? <button className="btn btn-gold" disabled={!!busy} onClick={stop} aria-label="Stop auto-copy">{busy === 'stop' ? '…' : 'Stop auto-copy'}</button>
                : <button className="btn btn-gold" disabled={!!busy || !pl} onClick={() => copy(true)} aria-label="Auto-copy">{busy === 'auto' ? 'Switching…' : 'Auto-copy'}</button>}
            </div>
          )}
          <p className="hint">Copying only brings over their entry/exit rules and trade size. Your own safety limits, vault and signed consent never change. Past profit is not a promise of future profit.</p>
        </div>
      )}
    </Sheet>
  );
}

export default function LeadersTab({ signedIn, me, refresh, say, goRobot }: { signedIn: boolean; me: Me | null; refresh: () => Promise<Me | null>; say: (k: 'ok' | 'err', t: string) => void; goRobot: () => void }) {
  const [mode, setMode] = useState<'live' | 'paper'>('live');
  const [period, setPeriod] = useState<'24h' | '7d' | 'all'>('7d');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const r = await api<{ board: Row[] }>(`/api/leaderboard?mode=${mode}&period=${period}`); setRows(r.board); setErr(null); } catch (e: any) { setErr(e.message); }
  }, [mode, period]);
  useEffect(() => { if (!signedIn) return; setRows(null); load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, [load, signedIn]);

  if (!signedIn) return <div className="panel"><div className="empty">Connect your wallet to see the leaderboard and copy top traders.</div></div>;
  return (
    <div className="leaders">
      <div className="lbbar">
        <div className="subtabs" role="tablist" aria-label="Mode">
          <button className={mode === 'live' ? 'on' : ''} role="tab" aria-selected={mode === 'live'} onClick={() => setMode('live')}>Live</button>
          <button className={mode === 'paper' ? 'on' : ''} role="tab" aria-selected={mode === 'paper'} onClick={() => setMode('paper')}>Paper</button>
        </div>
        <div className="subtabs" role="tablist" aria-label="Period">
          {(['24h', '7d', 'all'] as const).map((k) => <button key={k} className={period === k ? 'on' : ''} role="tab" aria-selected={period === k} onClick={() => setPeriod(k)}>{k === 'all' ? 'All time' : k}</button>)}
        </div>
      </div>
      {err && <p className="hint dn">{err}</p>}
      {!rows && !err && <p className="hint">Loading…</p>}
      {rows && rows.length === 0 && (
        <div className="panel"><div className="empty">No public traders with {mode} trades in this period yet.
          {me && !me.settings.public_profile && <> <button className="linkbtn" onClick={goRobot}>Put yourself on the board</button>.</>}</div></div>
      )}
      {rows && rows.map((r) => (
        <button key={r.handle} className={`lbrow ${r.me ? 'me' : ''}`} onClick={() => setOpen(r.handle)} aria-label={`Open @${r.handle}`}>
          <span className="rk">{r.rank}</span>
          <span className="who"><b>@{r.handle}{r.me ? ' (you)' : ''}</b><small>{r.trades} trades · {r.winRate == null ? '–' : `${r.winRate.toFixed(0)}% wins`}{r.followers ? ` · ${r.followers} copying` : ''}</small></span>
          <Spark values={r.curve} w={84} h={30} zero label={`@${r.handle} profit over time`} />
          <span className="amt"><b className={cls(r.pnlSol)}>{signed(r.pnlSol, 3)} SOL</b><small>{r.pnlUsd != null ? `${r.pnlUsd >= 0 ? '+' : '−'}${usd(Math.abs(r.pnlUsd))}` : pct(r.roiPct)}</small></span>
        </button>
      ))}
      {open && <ProfileSheet handle={open} mode={mode} signedIn={signedIn} onClose={() => setOpen(null)} onChanged={() => { refresh(); }} say={say} />}
    </div>
  );
}
