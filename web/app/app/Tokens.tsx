'use client';
import { useEffect, useMemo, useState } from 'react';
import Chart from './Chart';
import * as charting from '@/lib/charting';
import { useLiveTokens, LIST_SIZE, curveProgress, getLocalBars, getLocalTrades, recordTrade, STREAM, type Tok, type FeedStatus } from '@/lib/liveTokens';
import type { TokenView } from '@/lib/dex';
import { riskOf, type Risk } from '@/lib/risk';
import { api, Sheet, ago, usd, short, type Me, type Plan, AGENT_DEFAULT } from './shared';

const STATUS_TEXT: Record<FeedStatus, string> = { connecting: 'Connecting…', live: 'Live', fallback: 'Backup feed' };

const price = (p: number | null) => (p == null ? '–' : p < 0.0001 ? `$${p.toExponential(1)}` : p < 0.01 ? `$${p.toPrecision(3)}` : p < 1 ? `$${p.toFixed(4)}` : `$${p.toFixed(2)}`);

/** What a card shows, preferring real market data when we have it and the live stream otherwise. */
function view(t: Tok, solUsd: number | null) {
  const mcap = t.dex?.marketCapUsd ?? (t.mcapSol != null && solUsd ? t.mcapSol * solUsd : null);
  const vol = t.dex ? t.dex.volume.h1 : (solUsd ? t.volSol * solUsd : null);
  const txns = t.dex ? t.dex.txns1h.buys + t.dex.txns1h.sells : t.buys + t.sells;
  const created = t.dex?.pairCreatedAt || t.createdAt;
  const px = t.dex?.priceUsd ?? (mcap != null ? mcap / 1e9 : null); // pump.fun tokens have a 1B supply
  return { mcap, vol, txns, created, change: t.dex?.change.h1 ?? t.own?.c1h ?? null, liq: t.dex?.liquidityUsd ?? null, px };
}

/**
 * Small picture. First choice is the thumbnail our robot saved (instant, no gateways); otherwise the shrunk link through our
 * server. A picture that fails is retried a few times with growing pauses, because IPFS gateways are slow, not gone.
 */
const thumb = (u: string | null, w = 64) => (u && /^https:\/\//.test(u) ? `/api/img?w=${w}&u=${encodeURIComponent(u)}` : null);
const RETRY = [3000, 9000, 25000, 60000, 150000];
function Avatar({ t, big }: { t: { mint?: string; thumb?: boolean; image: string | null; symbol: string | null; name: string | null }; big?: boolean }) {
  const [attempt, setAttempt] = useState(0); // how many times the picture failed so far
  const [failed, setFailed] = useState(false); // currently showing initials while we wait to retry
  useEffect(() => { setAttempt(0); setFailed(false); }, [t.image, t.thumb]);
  useEffect(() => {
    if (!failed || attempt > RETRY.length) return;
    const id = setTimeout(() => setFailed(false), RETRY[attempt - 1] ?? 150000);
    return () => clearTimeout(id);
  }, [failed, attempt]);
  const own = t.mint && t.thumb ? `/api/thumb?mint=${t.mint}${attempt ? `&r=${attempt}` : ''}` : null;
  const link = thumb(t.image, big ? 128 : 64);
  const src = own || (link ? `${link}${attempt ? `&r=${attempt}` : ''}` : null);
  return (
    <div className={`avatar ${big ? 'big' : ''}`} aria-hidden>
      <span>{(t.symbol || t.name || '?').slice(0, 2).toUpperCase()}</span>
      {src && !failed && attempt <= RETRY.length && <img key={src} src={src} alt="" width={big ? 58 : 36} height={big ? 58 : 36} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => { setAttempt((n) => n + 1); setFailed(true); }} />}
    </div>
  );
}

function RiskBar({ risk }: { risk: Risk }) {
  return (
    <div className={`risk ${risk.level}`} title={`${risk.label} (${risk.score}/100). A quick estimate from liquidity, activity, buyers vs sellers, age and size. It cannot prove a token is safe.\n${risk.reasons.join('\n')}`}>
      <div className="riskbar" role="meter" aria-label={`Safety score ${risk.score} of 100`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={risk.score}><i style={{ width: `${Math.max(6, risk.score)}%` }} /></div>
      <span>{risk.label}</span>
    </div>
  );
}

function Card({ t, solUsd, now, onOpen }: { t: Tok; solUsd: number | null; now: number; onOpen: (m: string) => void }) {
  const v = view(t, solUsd);
  const risk = riskOf(t, solUsd, now);
  return (
    <button className="tkcard" onClick={() => onOpen(t.mint)} aria-label={`Open ${t.name || t.mint}`}>
      <Avatar t={t} />
      <div className="tkname"><b>{t.name || 'New token'}</b><span>{t.symbol ? `$${t.symbol}` : ''}</span></div>
      <div className="tkage">{ago(now - (t.kind === 'migrated' && t.migratedAt ? t.migratedAt : v.created))}</div>
      <div className="tkstats">
        <span>Price <b>{price(v.px)}</b></span>
        <span>MC <b>{usd(v.mcap)}</b></span>
        <span>Vol <b>{usd(v.vol)}</b></span>
        <span>Liq <b>{usd(v.liq)}</b></span>
        {v.change != null && <span className={v.change >= 0 ? 'up' : 'dn'}>{v.change >= 0 ? '+' : ''}{v.change.toFixed(1)}%</span>}
      </div>
      <RiskBar risk={risk} />
      {t.kind === 'new' && t.progress != null && <div className="curve"><span>Curve {Math.round(t.progress * 100)}%</span><div className="meter" title={`About ${(t.progress * 100).toFixed(0)}% of the way to migration`}><i style={{ width: `${Math.round(t.progress * 100)}%` }} /></div></div>}
    </button>
  );
}

function Column({ title, hint, items, solUsd, now, onOpen, on, empty }: { title: string; hint: string; items: Tok[]; solUsd: number | null; now: number; onOpen: (m: string) => void; on: boolean; empty: string }) {
  return (
    <section className={`col ${on ? 'on' : ''}`} aria-label={title}>
      <div className="colhead"><span>{title}</span><small>{hint}</small></div>
      {items.length === 0 ? <div className="coladd"><i className="dots"><u /><u /><u /></i><div>{empty}</div></div> : items.map((t) => <Card key={t.mint} t={t} solUsd={solUsd} now={now} onOpen={onOpen} />)}
    </section>
  );
}

type Tr = { t: number; side: 'buy' | 'sell'; sol: number; mcapSol: number; who?: string; sig?: string };
type ChartRow = { trades?: any[];  name: string | null; symbol: string | null; firstSeen: string | null; mcapSol: number | null; vSol: number | null; migrated: boolean; bars: number[][]; bars1m: number[][]; bars5m: number[][]; updatedAt: string };

/** A trader, inside the app: what they did on THIS coin (from the trades we recorded) plus public on-chain facts about the wallet. */
function TraderPanel({ addr, trades, solUsd, onClose }: { addr: string; trades: Tr[]; solUsd: number | null; onClose: () => void }) {
  const [w, setW] = useState<{ sol: number | null; tokens: number; holdings: { mint: string; amount: number }[]; recent: { t: number | null; ok: boolean }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { let stop = false; setW(null); setErr(null); api<any>(`/api/wallet?addr=${addr}`).then((r) => { if (!stop) setW(r); }, (e) => { if (!stop) setErr(e?.message || 'Could not load this wallet'); }); return () => { stop = true; }; }, [addr]);
  const mine = trades.filter((x) => x.who === addr);
  const bought = mine.filter((x) => x.side === 'buy').reduce((a, x) => a + x.sol, 0), sold = mine.filter((x) => x.side === 'sell').reduce((a, x) => a + x.sol, 0);
  const net = sold - bought;
  return (
    <div className="trader">
      <div className="histhead"><b className="mono">{short(addr)}</b><button className="btn btn-ghost sm" onClick={onClose}>Close</button></div>
      <div className="grid4">
        <div className="cell"><span>Bought here</span><b>{bought.toFixed(2)} SOL</b></div>
        <div className="cell"><span>Sold here</span><b>{sold.toFixed(2)} SOL</b></div>
        <div className="cell"><span>Net on this coin</span><b className={net >= 0 ? 'up' : 'dn'}>{net >= 0 ? '+' : ''}{net.toFixed(2)} SOL</b></div>
        <div className="cell"><span>Trades here</span><b>{mine.length}</b></div>
      </div>
      {err ? <p className="hint warn">{err}</p> : !w ? <p className="hint">Reading the wallet…</p> : (
        <div className="grid4">
          <div className="cell"><span>Wallet balance</span><b>{w.sol != null ? `${w.sol.toFixed(2)} SOL` : '–'}{w.sol != null && solUsd ? ` · ${usd(w.sol * solUsd)}` : ''}</b></div>
          <div className="cell"><span>Tokens held</span><b>{w.tokens}</b></div>
          <div className="cell"><span>Last activity</span><b>{w.recent[0]?.t ? ago(Date.now() - w.recent[0].t) + ' ago' : '–'}</b></div>
          <div className="cell"><span>Last 12 txs</span><b>{w.recent.filter((x) => x.ok).length} ok · {w.recent.filter((x) => !x.ok).length} failed</b></div>
        </div>
      )}
      <p className="hint">Public blockchain data. Past results of a wallet do not predict what it will do next.</p>
    </div>
  );
}

/** "Watch with my robot": a one-coin plan. The robot's chart agent looks for the pattern and enters even while you are away. */
function WatchPanel({ mint, symbol, mcapUsd, me, onSaved, goRobot, onClose }: { mint: string; symbol: string | null | undefined; mcapUsd: number | null; me: Me | null; onSaved: () => Promise<unknown>; goRobot: () => void; onClose: () => void }) {
  const lim = me?.limits;
  const active = me?.settings.plans.find((p) => p.id === me.settings.active_plan) || me?.settings.plans[0];
  const [pattern, setPattern] = useState<NonNullable<Plan['agent']>['pattern']>('double_bottom');
  const [tfSec, setTf] = useState(15);
  const [size, setSize] = useState(String(active?.sizeUsd ?? lim?.defaultSizeUsd ?? 7));
  const [tp, setTp] = useState(String(active?.takeProfitPct ?? 40));
  const [sl, setSl] = useState(String(active?.stopLossPct ?? 20));
  const [hold, setHold] = useState(String(active?.maxHoldMin ?? 20));
  const [mcMin, setMin] = useState('0');
  const [mcMax, setMax] = useState(mcapUsd ? String(Math.round((mcapUsd * 4) / 1000) * 1000 || 100000) : '100000');
  const [trigger, setTrigger] = useState<'confirm' | 'neckline'>('confirm');
  const [makeActive, setMakeActive] = useState(true);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const plans = me?.settings.plans || [];
  const save = async () => {
    if (!me) return; setBusy(true); setMsg(null);
    try {
      const id = `w${Date.now().toString(36)}`;
      const plan: Plan = { id, name: `Watch ${symbol ? '$' + symbol : short(mint)}`.slice(0, 24), sizeUsd: Number(size), minAgeSec: 0, maxAgeSec: null, takeProfitPct: Number(tp), stopLossPct: Number(sl), maxHoldMin: Number(hold), scanEverySec: 5, maxTradesDay: 5, minLiqUsd: 0, minVol1hUsd: 0, minBuys1h: 0, requireRising: false,
        agent: { ...AGENT_DEFAULT, enabled: true, pattern, tfSec, mcapMinUsd: Number(mcMin) || 0, mcapMaxUsd: mcMax.trim() === '' ? null : Number(mcMax), trigger, onlyMint: mint } };
      await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ plans: [...plans, plan], activePlan: makeActive ? id : me.settings.active_plan }) });
      await onSaved();
      setMsg({ ok: true, t: makeActive ? `Done. Your robot now watches this coin for a ${pattern.replace('_', ' ')} and enters by itself, even while you are away.` : 'Saved as a plan. Switch to it on the Robot tab when you want it running.' });
    } catch (e: any) { setMsg({ ok: false, t: e?.message || 'Could not save' }); } finally { setBusy(false); }
  };
  if (!me) return (
    <div className="watchbox"><b>Watch this coin with your robot</b><p className="hint">Connect your wallet and sign in first, then come back. The robot trades from your own vault under the limits you signed.</p><div className="row"><button className="btn btn-gold sm" onClick={() => { onClose(); goRobot(); }}>Go to Robot</button><button className="btn btn-ghost sm" onClick={onClose}>Close</button></div></div>
  );
  return (
    <div className="watchbox">
      <b>Watch this coin with your robot</b>
      <p className="hint">{me.settings.live ? 'Live mode is on: this will use real money from your vault.' : 'Practice mode: simulated fills until you switch to live on the Robot tab.'} The robot enters when the pattern shows, even if you are away, and sells by your take profit, stop loss and time limit.</p>
      <div className="fgrid">
        <div><span className="lbl">Pattern</span><select className="field" aria-label="Watch pattern" value={pattern} onChange={(e) => setPattern(e.target.value as any)}><option value="double_bottom">Double bottom</option><option value="breakout">Breakout</option><option value="dip_buy">Dip then bounce</option><option value="volume_spike">Volume spike</option></select></div>
        <div><span className="lbl">Candle size</span><select className="field" aria-label="Watch candle size" value={tfSec} onChange={(e) => setTf(Number(e.target.value))}><option value={5}>5 seconds</option><option value={15}>15 seconds</option><option value={60}>1 minute</option><option value={300}>5 minutes</option></select></div>
        <div><span className="lbl">Amount to buy (USD)</span><input className="field" inputMode="decimal" aria-label="Watch amount" value={size} onChange={(e) => setSize(e.target.value)} /></div>
        <div><span className="lbl">Enter only if mcap between ($)</span><div className="row"><input className="field" inputMode="decimal" aria-label="Watch mcap from" value={mcMin} onChange={(e) => setMin(e.target.value)} /><input className="field" inputMode="decimal" aria-label="Watch mcap to" value={mcMax} onChange={(e) => setMax(e.target.value)} /></div></div>
        <div><span className="lbl">Take profit (%)</span><input className="field" inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} /></div>
        <div><span className="lbl">Stop loss (%)</span><input className="field" inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} /></div>
        <div><span className="lbl">Sell after at most (min)</span><input className="field" inputMode="decimal" value={hold} onChange={(e) => setHold(e.target.value)} /></div>
        {pattern === 'double_bottom' && <div><span className="lbl">Enter when</span><select className="field" value={trigger} onChange={(e) => setTrigger(e.target.value as any)}><option value="confirm">price turns up (earlier)</option><option value="neckline">middle peak breaks (safer)</option></select></div>}
      </div>
      <label className="check"><input type="checkbox" checked={makeActive} onChange={(e) => setMakeActive(e.target.checked)} />Make this my active plan now (the robot runs one plan at a time)</label>
      {plans.length >= 10 && <p className="hint warn">You already have 10 plans. Delete one on the Robot tab first.</p>}
      {msg && <div className={`note ${msg.ok ? 'ok' : 'err'}`} role="status">{msg.t}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn btn-gold" disabled={busy || plans.length >= 10 || !(Number(size) >= (lim?.minSizeUsd ?? 1))} onClick={save}>{busy ? 'Saving…' : 'Start watching'}</button>
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function TokenSheet({ mint, seed, solUsd, me, onSaved, goRobot, onClose }: { mint: string; seed: Tok | null; solUsd: number | null; me: Me | null; onSaved: () => Promise<unknown>; goRobot: () => void; onClose: () => void }) {
  const [watch, setWatch] = useState(false);
  const [trader, setTrader] = useState<string | null>(null);
  const [older, setOlder] = useState<Tr[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined); // undefined = not started, null = reached the beginning
  const [loadingOld, setLoadingOld] = useState(false); const [oldErr, setOldErr] = useState<string | null>(null);
  const [filled, setFilled] = useState(0);
  const [ch, setCh] = useState<ChartRow | null>(null);
  const [tv, setTv] = useState<TokenView | null>(seed?.dex || null);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let stop = false;
    const go = async () => {
      try { const r = await api<{ chart: ChartRow | null }>(`/api/chart?mint=${mint}`); if (!stop) { setCh(r.chart); setErr(null); } } catch (e: any) { if (!stop) setErr(e?.message || 'Could not load'); }
      if (!stop) setLoaded(true);
    };
    go(); const id = setInterval(go, 3000);
    return () => { stop = true; clearInterval(id); };
  }, [mint]);
  // A coin our robot never watched has no recorded chart: read its latest trades from the chain once, then reload the chart.
  useEffect(() => {
    if (!loaded || (ch && ch.bars.length >= 8)) return; let stop = false;
    fetch(`/api/backfill?mint=${mint}`, { method: 'POST' }).then((r) => r.json()).then((j) => { if (!stop && j && j.ok && j.count) { setFilled((x) => x + 1); api<{ chart: ChartRow | null }>(`/api/chart?mint=${mint}`).then((r) => { if (!stop) setCh(r.chart); }, () => {}); } }).catch(() => {});
    return () => { stop = true; };
  }, [loaded, mint]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadOlder = async () => {
    setLoadingOld(true); setOldErr(null);
    try {
      const last = older.length ? older[older.length - 1] : null;
      const before = cursor ?? undefined;
      const r = await api<{ trades: { sig: string; t: number; side: 'buy' | 'sell'; sol: number; mcapSol: number; who: string }[]; next: string | null }>(`/api/history?mint=${mint}${before ? `&before=${before}` : ''}`);
      setOlder((o) => [...o, ...r.trades.map((x) => ({ t: x.t, side: x.side, sol: x.sol, mcapSol: x.mcapSol, who: x.who, sig: x.sig.slice(0, 10) }))]); setCursor(r.next); void last;
    } catch (e: any) { setOldErr(e?.message || 'Could not load'); } finally { setLoadingOld(false); }
  };
  // The page also listens to this one token's trades directly, so a chart always starts filling the moment the sheet opens.
  const [n, setN] = useState(0);
  useEffect(() => {
    let s: WebSocket | null = null, closed = false, retry: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      if (closed) return;
      try {
        s = new WebSocket(STREAM);
        s.onopen = () => { try { s!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] })); } catch { /* ignore */ } };
        s.onmessage = (e) => { try { const m = JSON.parse(String(e.data)); if (m && m.mint === mint) recordTrade(m); } catch { /* ignore */ } };
        s.onclose = () => { if (!closed) retry = setTimeout(open, 2000); };
        s.onerror = () => { try { s?.close(); } catch { /* ignore */ } };
      } catch { retry = setTimeout(open, 4000); }
    };
    open();
    const id = setInterval(() => { if (!closed) setN((x) => x + 1); }, 1000);
    return () => { closed = true; if (retry) clearTimeout(retry); clearInterval(id); try { s?.close(); } catch { /* ignore */ } };
  }, [mint]);
  const tiers = useMemo(() => {
    const loc = getLocalBars(mint);
    return { s5: charting.mergeBars(loc, ch?.bars || []) as number[][], m1: (ch?.bars1m || []) as number[][], m5: (ch?.bars5m || []) as number[][] };
  }, [mint, ch, n]); // eslint-disable-line react-hooks/exhaustive-deps
  const bars = tiers.s5;
  const trades = useMemo<Tr[]>(() => {
    const srv: Tr[] = (ch?.trades || []).map((x: any[]) => ({ t: Number(x[0]), side: x[1] === 's' ? 'sell' : 'buy', sol: Number(x[2]) || 0, mcapSol: Number(x[3]) || 0, who: x[4] || undefined, sig: x[5] || undefined }));
    const loc: Tr[] = getLocalTrades(mint).map((x) => ({ t: x.t, side: x.side, sol: x.sol, mcapSol: x.mcapSol, who: x.who, sig: x.sig }));
    const seen = new Set<string>(); const out: Tr[] = [];
    for (const x of [...loc, ...srv, ...older].sort((a, b) => b.t - a.t)) { const k = x.sig ? x.sig : `${Math.round(x.t / 1000)}:${x.sol}:${x.side}`; if (seen.has(k)) continue; seen.add(k); out.push(x); if (out.length >= 400) break; }
    return out;
  }, [mint, ch, n, older]); // eslint-disable-line react-hooks/exhaustive-deps
  const recent = trades.slice(0, 40); const bs = recent.filter((x) => x.side === 'buy').reduce((a, x) => a + x.sol, 0), ss = recent.filter((x) => x.side === 'sell').reduce((a, x) => a + x.sol, 0);
  const replay = useMemo(() => (ch?.trades || []).slice(-40).reverse().map((x: any[]) => ({ side: x[1], sol: Number(x[2]) || 0, mcapSol: Number(x[3]) || 0, t: Number(x[0]) })), [ch?.trades?.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Tokens we have no recorded candles for (older than the robot's watch list) get plain market numbers from our server instead.
  useEffect(() => {
    if (!loaded || ch) return;
    let stop = false;
    api<{ token: TokenView }>(`/api/token?mint=${mint}`).then((r) => { if (!stop) setTv(r.token); }, () => {});
    return () => { stop = true; };
  }, [loaded, ch, mint]);
  const name = ch?.name || tv?.name || seed?.name || 'Token', symbol = ch?.symbol || tv?.symbol || seed?.symbol;
  const image = tv?.imageUrl || seed?.image || null;
  const st = useMemo(() => {
    if (!bars.length) return null;
    const last = bars[bars.length - 1], now = Math.floor(Date.now() / 1000);
    const at = (sec: number) => { const cut = now - sec; for (const b of bars) if (b[0] >= cut) return b[1]; return bars[0][1]; };
    let vol = 0, buys = 0, sells = 0; for (const b of bars) if (b[0] >= now - 3600) { vol += b[5]; buys += b[6]; sells += b[7]; }
    const m = (p: number) => (solUsd ? p * solUsd : null);
    return { mcap: m(last[4]), c5: (last[4] / at(300) - 1) * 100, c1h: (last[4] / at(3600) - 1) * 100, vol: m(vol), buys, sells, high: m(Math.max(...bars.map((b) => b[2]))), low: m(Math.min(...bars.map((b) => b[3]))) };
  }, [bars, solUsd]);
  return (
    <Sheet title={`${name}${symbol ? ` · $${symbol}` : ''}`} onClose={onClose} wide>
      <div className="thead">
        <Avatar big t={{ mint, thumb: seed?.thumb, image, symbol: symbol || null, name }} />
        <div style={{ minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all' }}>{mint}</div>
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn btn-ghost sm" onClick={() => { navigator.clipboard?.writeText(mint); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy address'}</button>
          </div>
        </div>
      </div>
      <div className="row" style={{ margin: '4px 0 10px' }}>
        <button className="btn btn-gold sm" onClick={() => setWatch((w) => !w)} aria-expanded={watch}>🤖 Watch with my robot</button>
      </div>
      {watch && <WatchPanel mint={mint} symbol={symbol} mcapUsd={st?.mcap ?? tv?.marketCapUsd ?? null} me={me} onSaved={onSaved} goRobot={goRobot} onClose={() => setWatch(false)} />}
      {seed?.description && <p>{seed.description}</p>}
      {st ? (
        <div className="grid4">
          <div className="cell"><span>Market cap</span><b>{usd(st.mcap)}</b></div>
          <div className="cell"><span>Volume 1h</span><b>{usd(st.vol)}</b></div>
          <div className="cell"><span>Change 5m</span><b className={st.c5 >= 0 ? 'up' : 'dn'}>{st.c5.toFixed(1)}%</b></div>
          <div className="cell"><span>Change 1h</span><b className={st.c1h >= 0 ? 'up' : 'dn'}>{st.c1h.toFixed(1)}%</b></div>
          <div className="cell"><span>Buys / sells 1h</span><b>{st.buys} / {st.sells}</b></div>
          <div className="cell"><span>High · Low</span><b>{usd(st.high)} · {usd(st.low)}</b></div>
          <div className="cell"><span>Stage</span><b>{ch?.migrated ? 'Migrated' : `Curve ${ch?.vSol != null ? Math.round(curveProgress(ch.vSol) * 100) : '–'}%`}</b></div>
          <div className="cell"><span>Age</span><b>{ch?.firstSeen ? ago(Date.now() - Date.parse(ch.firstSeen)) : seed ? ago(Date.now() - seed.createdAt) : '–'}</b></div>
        </div>
      ) : tv ? (
        <div className="grid4">
          <div className="cell"><span>Market cap</span><b>{usd(tv.marketCapUsd)}</b></div>
          <div className="cell"><span>Liquidity</span><b>{usd(tv.liquidityUsd)}</b></div>
          <div className="cell"><span>Volume 24h</span><b>{usd(tv.volume.h24)}</b></div>
          <div className="cell"><span>Change 1h</span><b className={tv.change.h1 >= 0 ? 'up' : 'dn'}>{tv.change.h1.toFixed(1)}%</b></div>
        </div>
      ) : null}
      {bars.length > 0 ? <Chart mint={mint} tiers={tiers} solUsd={solUsd} replay={replay} />
        : <div className="coladd">{!loaded ? 'Loading chart…' : err || 'Listening for trades on this token. The chart starts the moment the next trade happens, and keeps building while you watch.'}</div>}
      {bars.length > 0 && bars.length < 12 && <p className="hint">Only {bars.length} candle{bars.length === 1 ? '' : 's'} so far. Our charts are built from live trades, so a token we have just started watching has no earlier history.</p>}
      <div className="hist" aria-label="Trade history">
        <div className="histhead"><b>Trades by everyone</b><span className="mono">{trades.length ? `${recent.filter((x) => x.side === 'buy').length} buys · ${recent.filter((x) => x.side === 'sell').length} sells (last ${recent.length})` : 'waiting for the first trade'}</span></div>
        <div className="pressure" title="Share of recent SOL that was buying"><i style={{ width: `${bs + ss ? Math.round((bs / (bs + ss)) * 100) : 50}%` }} /></div>
        {trader && <TraderPanel addr={trader} trades={trades} solUsd={solUsd} onClose={() => setTrader(null)} />}
        <div className="hrow hh"><span>Time</span><span>Type</span><span>SOL</span><span>Market cap</span><span>Trader</span></div>
        <div className="hbody">{trades.map((x, i) => <div key={`${x.sig || x.t}-${i}`} className={`hrow ${x.side}`}><span>{new Date(x.t).toLocaleTimeString([], { hour12: false })}</span><b>{x.side === 'buy' ? 'BUY' : 'SELL'}</b><span>{x.sol.toFixed(2)}</span><span>{solUsd ? usd(x.mcapSol * solUsd) : `${x.mcapSol.toFixed(1)} SOL`}</span>{x.who ? <button className="who" onClick={() => setTrader(x.who!)} aria-label={`Open trader ${short(x.who)}`}>{short(x.who)}</button> : <span>–</span>}</div>)}</div>
      </div>
      <div className="row" style={{ margin: '6px 0 2px' }}>
        <button className="btn btn-ghost sm" disabled={loadingOld || cursor === null} onClick={loadOlder}>{loadingOld ? 'Reading the chain…' : cursor === null ? 'Reached the first trade' : older.length ? 'Load older trades' : 'Load full history from the chain'}</button>
        {oldErr && <span className="hint warn">{oldErr}</span>}
        {filled > 0 && <span className="hint">Chart rebuilt from the coin's on-chain trades.</span>}
      </div>
      <p className="hint">Candles are built by our own robot from live trades. New tokens are extremely risky; a token shown here is not a recommendation.</p>
    </Sheet>
  );
}

export default function TokensTab({ me, onSaved, goRobot }: { me: Me | null; onSaved: () => Promise<unknown>; goRobot: () => void }) {
  const feed = useLiveTokens();
  const [sub, setSub] = useState<'new' | 'stretch' | 'migrated'>('new');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    const m = q.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)) { setMsg('Paste a full Solana token address (the contract address).'); return; }
    setMsg(null); setOpen(m);
  };
  const L = feed.lists;
  return (
    <>
      <div className="tk-bar">
        <form className="search" onSubmit={search}>
          <input className="field mono" placeholder="Search by contract address…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Contract address" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
          <button className="btn btn-gold sm" type="submit">Search</button>
        </form>
        <span className={`feedstat ${feed.status}`} title={feed.status === 'fallback' ? 'The live socket could not connect, so this list refreshes every 20 seconds from our server.' : ''}><i />{STATUS_TEXT[feed.status]}</span>
      </div>
      {msg && <div className="note err" role="alert">{msg}</div>}
      {feed.boardErr === 'setup' && <div className="note err" role="alert">The robot's coin records are not set up yet. Run the latest <b>supabase_art.sql</b> in Supabase, then refresh. Until then you only see what this browser catches live.</div>}
      {([['🔥 Trending now', 'most trades in the last hour · swipe →', feed.hot], ['⚡ Surge', 'biggest 5-minute gains with real activity · swipe →', feed.surge]] as const).map(([title, hint, list]) => list.length > 0 && (
        <div key={title}>
          <div className="trendhead">{title} <small className="mono" style={{ color: 'var(--muted)', textTransform: 'none', fontWeight: 500 }}>{hint}</small></div>
          <div className="trend" role="list" aria-label={title}>
            {list.map((h) => (
              <button key={h.mint} role="listitem" className="tchip" onClick={() => setOpen(h.mint)} aria-label={`Open ${title} ${h.symbol || h.name || h.mint}`}>
                <Avatar t={{ mint: h.mint, thumb: h.thumb, image: h.image, symbol: h.symbol, name: h.name }} />
                <b>{h.symbol ? `$${h.symbol}` : h.name || 'Token'}</b>
                <small>{feed.solUsd && h.mcapSol ? usd(h.mcapSol * feed.solUsd) : '–'} · <span className={h.c5 >= 0 ? 'up' : 'dn'}>{h.c5 >= 0 ? '+' : ''}{h.c5.toFixed(0)}%</span> · {h.trades} tx</small>
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="subtabs" role="tablist">
        <button role="tab" aria-selected={sub === 'new'} className={sub === 'new' ? 'on' : ''} onClick={() => setSub('new')}>New<u>{L.new.length}</u></button>
        <button role="tab" aria-selected={sub === 'stretch'} className={sub === 'stretch' ? 'on' : ''} onClick={() => setSub('stretch')}>Final stretch<u>{L.stretch.length}</u></button>
        <button role="tab" aria-selected={sub === 'migrated'} className={sub === 'migrated' ? 'on' : ''} onClick={() => setSub('migrated')}>Migrated<u>{L.migrated.length}</u></button>
      </div>
      <div className="cols">
        <Column title="New" hint={`latest ${LIST_SIZE} launches`} items={L.new} solUsd={feed.solUsd} now={now} onOpen={setOpen} on={sub === 'new'} empty="Waiting for the next launch…" />
        <Column title="Final stretch" hint="past half way to migrating" items={L.stretch} solUsd={feed.solUsd} now={now} onOpen={setOpen} on={sub === 'stretch'} empty={feed.topProgress != null ? `Nothing past half way up the curve yet. The robot is watching every launch; the closest coin is at ${Math.round(feed.topProgress * 100)}%. Coins appear here the moment they pass 50%.` : "Coins past half way up the curve show up here as the robot watches them climb."} />
        <Column title="Migrated" hint="just graduated" items={L.migrated} solUsd={feed.solUsd} now={now} onOpen={setOpen} on={sub === 'migrated'} empty="Waiting for the next migration…" />
      </div>
      {open && <TokenSheet mint={open} seed={feed.find(open)} solUsd={feed.solUsd} me={me} onSaved={onSaved} goRobot={goRobot} onClose={() => setOpen(null)} />}
    </>
  );
}
