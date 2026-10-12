'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton, useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { useSign, type Proof } from '@/components/useSign';

type ModeKey = 'easy' | 'medium' | 'hard';
type Settings = { mode: 'easy' | 'medium' | 'hard'; paused: boolean; live: boolean; max_position_sol: number; max_daily_loss_pct: number; max_concurrent: number; size_usd: number | null };
type Me = {
  wallet: string; telegramLinked: boolean; liveEnabled: boolean; solUsd: number | null;
  vault: { address: string; balanceSol: number | null } | null;
  settings: Settings;
  consent: { limits: { mode: string; maxPositionSol: number; maxDailyLossPct: number; maxConcurrent: number }; created_at: string } | null;
  withdrawals: { id: string; amount_lamports: string | null; status: string; tx_sig: string | null; error: string | null; created_at: string }[];
  limits: { maxPositionSol: { min: number; max: number }; maxDailyLossPct: { min: number; max: number }; maxConcurrent: { min: number; max: number }; minVaultSolForLive: number; maxSizeUsd: number; minSizeUsd: Record<ModeKey, number> };
};
type Pos = { mint: string; openedAt: number; sizeSol: number; lastPnl: number | null; status: string; takeProfitPct: number; stopLossPct: number };
type Trades = { paper: { open: Pos[]; daily: any }; live: { open: Pos[]; daily: any }; trades: any[] };

const MODE_KEYS: ModeKey[] = ['easy', 'medium', 'hard'];
const MODES: Record<ModeKey, { name: string; line: string }> = {
  easy: { name: 'Easy', line: 'from $5 a trade · take profit +30% · stop −20% · hold 2 min' },
  medium: { name: 'Medium', line: 'from $10 a trade · take profit +60% · stop −30% · hold 5 min' },
  hard: { name: 'Hard', line: 'from $20 a trade · take profit +100% · stop −45% · hold 8 min' },
};
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const sol = (n: number | null | undefined, d = 4) => (n == null ? '–' : n.toFixed(d));
const signed = (n: number, d = 4) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}`;

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) }, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

/* ───────────────────────── Reactor: the big revolving button ───────────────────────── */

const SCAN_LINES = ['Scanning new launches', 'Checking liquidity', 'Filtering risky tokens', 'Watching open trades', 'Waiting for a clean entry'];

function Ticker({ running }: { running: boolean }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setI((n) => (n + 1) % SCAN_LINES.length), 2600);
    return () => clearInterval(t);
  }, [running]);
  return <span key={running ? i : 'x'} className="ticker">{running ? SCAN_LINES[i] : 'Standing by'}{running && <i className="dots"><u /><u /><u /></i>}</span>;
}

function Reactor({ running, label, small, aria, onClick, disabled, busy }: {
  running: boolean; label: string; small: string; aria: string; onClick: () => void; disabled?: boolean; busy?: boolean;
}) {
  return (
    <div className={`reactor ${running ? 'run' : 'idle'} ${busy ? 'busy' : ''}`}>
      <span className="ring r1" /><span className="ring r2" /><span className="ring r3" />
      <span className="ring orbit" />
      <span className="ring sweep" />
      <span className="ring ripple" /><span className="ring ripple b" />
      <button className="core" aria-label={aria} disabled={disabled} onClick={onClick}>
        <b>{label}</b>
        <small>{small}</small>
      </button>
    </div>
  );
}

/* ───────────────────────── Sheet (bottom drawer) ───────────────────────── */

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><h2>{title}</h2><button className="x" aria-label="Close" onClick={onClose}>×</button></div>
        {children}
      </div>
    </div>
  );
}

/* ───────────────────────── Page ───────────────────────── */

export default function Dashboard() {
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const sign = useSign();
  const [me, setMe] = useState<Me | null>(null);
  const [auth, setAuth] = useState<'checking' | 'out' | 'in'>('checking');
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const wallet58 = publicKey?.toBase58() || null;

  const say = (kind: 'ok' | 'err', text: string) => setFlash({ kind, text });
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setFlash(null);
    try { await fn(); } catch (e: any) { say('err', e?.message || 'Something went wrong'); } finally { setBusy(null); }
  };

  const refresh = useCallback(async () => {
    try { const m = await api<Me>('/api/me'); setMe(m); setAuth('in'); return m; } catch (e: any) { if (e.status === 401) { setMe(null); setAuth('out'); } return null; }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (auth !== 'in') return; const t = setInterval(refresh, 15000); return () => clearInterval(t); }, [auth, refresh]);

  const signedWallet = me?.wallet || null;
  const mismatch = auth === 'in' && connected && wallet58 && signedWallet && wallet58 !== signedWallet;

  const signIn = () => run('signin', async () => {
    if (!wallet58) throw new Error('Connect a wallet first');
    const { message } = await api<{ message: string }>(`/api/auth/nonce?wallet=${wallet58}`);
    const proof = await sign(message);
    await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ wallet: wallet58, message, proof }) });
    await refresh();
  });
  const signOut = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); setMe(null); setAuth('out'); };

  return (
    <div className="art">
      <div className="wrap">
        <div className="top">
          <a className="brand" href="/"><span className="mark" />ART</a>
          <div className="row">
            {auth === 'in' && <button className="btn btn-ghost sm" onClick={signOut}>Sign out</button>}
            <WalletMultiButton />
          </div>
        </div>

        {flash && <div className={`note ${flash.kind === 'err' ? 'err' : 'ok'}`} role="status">{flash.text}</div>}

        {mismatch && (
          <div className="note err">You are signed in as <span className="mono">{short(signedWallet!)}</span> but your wallet switched to <span className="mono">{short(wallet58!)}</span>.{' '}
            <button className="btn btn-ghost sm" onClick={async () => { await signOut(); }}>Sign out and switch</button></div>
        )}

        {auth === 'checking' && <div className="stage solo"><Reactor running={false} label="…" small="Loading" aria="Loading" onClick={() => {}} disabled /></div>}

        {auth === 'out' && (
          <div className="stage solo">
            <span className="eyebrow">African Robot Trader · Solana</span>
            <h1>Your robot,<br />your limits.</h1>
            {!connected ? (
              <Reactor running={false} label="Connect" small="Choose your wallet" aria="Connect wallet" onClick={() => setVisible(true)} />
            ) : (
              <Reactor running={false} label="Sign in" small={wallet58 ? short(wallet58) : ''} aria="Sign in" onClick={signIn} disabled={!!busy} busy={busy === 'signin'} />
            )}
            <p className="hero-note">
              {!connected
                ? 'Connect any Solana wallet. Connecting only shares your public address.'
                : <>Sign one message to prove this wallet is yours. <b>It does not move funds and gives ART no permission to spend anything.</b></>}
            </p>
            <details><summary>Which wallets work?</summary>
              <p style={{ marginTop: 10 }}>Anything that follows the Solana Wallet Standard is detected automatically: Phantom, Solflare, Backpack, Coinbase, Trust, Ledger and more. On Android, wallet apps connect through Mobile Wallet Adapter. On iPhone, open this page inside your wallet app&apos;s browser. Wallets that only support other chains (EVM-only) cannot sign for Solana.</p>
            </details>
          </div>
        )}

        {auth === 'in' && me && !mismatch && <Console me={me} refresh={refresh} run={run} busy={busy} say={say} sign={sign} />}

        <footer>Trading digital assets carries a high risk of loss. ART does not promise profit. The vault is a wallet that ART&apos;s trading service controls so it can trade while you are away; it is not a bank account and is not insured. Only fund what you can afford to lose.</footer>
      </div>
    </div>
  );
}

/* ───────────────────────── Control room ───────────────────────── */

function Console({ me, refresh, run, busy, say, sign }: {
  me: Me; refresh: () => Promise<Me | null>; run: (k: string, f: () => Promise<void>) => Promise<void>; busy: string | null;
  say: (k: 'ok' | 'err', t: string) => void; sign: (t: string) => Promise<Proof>;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const s = me.settings;
  const lim = me.limits;
  const settingsRef = useRef<HTMLDivElement>(null);

  const minUsd = lim.minSizeUsd;
  const [form, setForm] = useState({ mode: s.mode as ModeKey, maxPositionSol: s.max_position_sol, maxDailyLossPct: s.max_daily_loss_pct, maxConcurrent: s.max_concurrent, sizeUsd: Math.max(s.size_usd ?? 0, minUsd[s.mode]) });
  const [preview, setPreview] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | 'fund' | 'withdraw' | 'tg' | 'perm'>(null);
  const [tab, setTab] = useState<'open' | 'history'>('open');
  const [fundAmt, setFundAmt] = useState('0.1');
  const [wAmt, setWAmt] = useState('');
  const [wTo, setWTo] = useState('');
  const [wPreview, setWPreview] = useState<{ message: string } | null>(null);
  const [trades, setTrades] = useState<Trades | null>(null);
  const [tg, setTg] = useState<{ code: string; bot: string | null } | null>(null);
  const seeded = useRef(false);
  useEffect(() => {
    if (!seeded.current && me.consent) {
      seeded.current = true;
      setForm({ mode: s.mode, maxPositionSol: me.consent.limits.maxPositionSol, maxDailyLossPct: me.consent.limits.maxDailyLossPct, maxConcurrent: me.consent.limits.maxConcurrent, sizeUsd: Math.max(s.size_usd ?? 0, minUsd[s.mode]) });
    }
  }, [me.consent, s.mode, s.size_usd, minUsd]);

  const loadTrades = useCallback(async () => { try { setTrades(await api<Trades>('/api/trades')); } catch { /* shown on next poll */ } }, []);
  useEffect(() => { loadTrades(); const t = setInterval(loadTrades, 8000); return () => clearInterval(t); }, [loadTrades]);

  const hasVault = !!me.vault, hasConsent = !!me.consent;
  const bal = me.vault?.balanceSol ?? null;
  const funded = (bal ?? 0) >= lim.minVaultSolForLive;
  const liveReady = me.liveEnabled && hasVault && hasConsent && funded;
  const isLive = s.live && me.liveEnabled;
  const running = hasVault && hasConsent && !s.paused;
  const liveOpen = trades?.live.open.length || 0;
  const openList = trades ? (isLive ? trades.live.open : trades.paper.open) : [];
  const history = (trades?.trades || []).filter((t) => !!t.paper === !isLive);

  const today = useMemo(() => {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    return history.filter((t) => new Date(t.created_at) >= d0).reduce((a, t) => a + (Number(t.realized_sol) || 0), 0);
  }, [history]);

  const patch = (key: string, body: object, okText?: string) => run(key, async () => { await api('/api/settings', { method: 'PATCH', body: JSON.stringify(body) }); await refresh(); if (okText) say('ok', okText); });
  const createVault = () => run('vault', async () => { await api('/api/vault', { method: 'POST' }); await refresh(); say('ok', 'Vault created.'); });

  const q = useMemo(() => new URLSearchParams({ mode: form.mode, maxPositionSol: String(form.maxPositionSol), maxDailyLossPct: String(form.maxDailyLossPct), maxConcurrent: String(form.maxConcurrent) }).toString(), [form]);
  const reviewConsent = () => run('review', async () => { const r = await api<{ message: string }>(`/api/consent?${q}`); setPreview(r.message); });
  const signConsent = () => run('consent', async () => {
    if (!preview) return;
    const proof = await sign(preview);
    await api('/api/consent', { method: 'POST', body: JSON.stringify({ message: preview, proof }) });
    setPreview(null); await refresh(); say('ok', 'Consent signed and saved.');
  });

  const fund = () => run('fund', async () => {
    if (!publicKey || !me.vault) throw new Error('No vault');
    const amount = Number(fundAmt);
    if (!(amount > 0)) throw new Error('Enter an amount in SOL');
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: new PublicKey(me.vault.address), lamports: Math.round(amount * 1e9) }));
    const sig = await sendTransaction(tx, connection);
    setSheet(null);
    say('ok', `Sent. It shows in the vault after confirmation (${sig.slice(0, 8)}…).`);
    setTimeout(refresh, 6000); setTimeout(refresh, 15000);
  });

  const reviewWithdraw = () => run('wreview', async () => {
    const amt = wAmt.trim() === '' ? 'ALL' : wAmt.trim();
    const to = wTo.trim() || me.wallet;
    setWPreview(await api<{ message: string }>(`/api/withdraw/challenge?amount=${encodeURIComponent(amt)}&to=${encodeURIComponent(to)}`));
  });
  const signWithdraw = () => run('withdraw', async () => {
    if (!wPreview) return;
    const proof = await sign(wPreview.message);
    await api('/api/withdraw', { method: 'POST', body: JSON.stringify({ message: wPreview.message, proof }) });
    setWPreview(null); setWAmt(''); setWTo(''); setSheet(null); await refresh(); say('ok', 'Withdrawal requested. The worker sends it shortly.');
  });

  const linkTg = () => run('tg', async () => setTg(await api('/api/telegram', { method: 'POST' })));
  const panic = () => run('panic', async () => { await api('/api/panic', { method: 'POST' }); await refresh(); say('ok', 'Paused. Closing all open trades.'); });

  /* settings logic: tightening the mode needs no new signature; raising anything does */
  const c = me.consent?.limits;
  const rank = (m: string) => MODE_KEYS.indexOf(m as ModeKey);
  const needsSignature = !hasConsent || (c != null && (form.maxPositionSol !== c.maxPositionSol || form.maxDailyLossPct !== c.maxDailyLossPct || form.maxConcurrent !== c.maxConcurrent || rank(form.mode) > rank(c.mode)));
  const modeChangeOnly = hasConsent && !needsSignature && form.mode !== s.mode;
  const touch = () => setPreview(null);
  const price = me.solUsd ?? null;
  const solFor = (usd: number) => (price ? usd / price : null);
  const needSol = solFor(form.sizeUsd);
  const sizeSaved = Math.max(s.size_usd ?? 0, minUsd[s.mode]);
  const sizeDirty = hasVault && form.sizeUsd !== sizeSaved && form.mode === s.mode;
  const capSol = c ? c.maxPositionSol : form.maxPositionSol;
  const tooSmallCap = needSol != null && capSol + 1e-9 < needSol;
  const suggestPos = (usd: number) => { const n = solFor(usd); return n == null ? null : Math.min(lim.maxPositionSol.max, Math.max(lim.maxPositionSol.min, Math.ceil((n * 1.15) / 0.005) * 0.005)); };
  const seededPos = useRef(false);
  useEffect(() => {
    if (seededPos.current || hasConsent || price == null) return;
    seededPos.current = true;
    const sug = suggestPos(form.sizeUsd);
    if (sug != null) setForm((f) => ({ ...f, maxPositionSol: Number(sug.toFixed(3)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [price, hasConsent]);
  const pickMode = (k: ModeKey) => {
    const wasMin = form.sizeUsd === minUsd[form.mode];
    const size = wasMin ? minUsd[k] : Math.max(minUsd[k], form.sizeUsd);
    const sug = !hasConsent ? suggestPos(size) : null;
    setForm({ ...form, mode: k, sizeUsd: size, maxPositionSol: sug != null ? Number(sug.toFixed(3)) : form.maxPositionSol }); touch();
  };

  const phase = !hasVault ? 'vault' : !hasConsent ? 'limits' : s.paused ? 'ready' : 'running';
  const goLimits = () => settingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const reactor =
    phase === 'vault' ? { label: 'Vault', small: 'Create my vault', aria: 'Create my vault', onClick: createVault, busy: busy === 'vault' } :
    phase === 'limits' ? { label: 'Limits', small: 'Sign your limits', aria: 'Set my limits', onClick: goLimits, busy: false } :
    phase === 'ready' ? { label: 'Start', small: 'Tap to start', aria: 'Start robot', onClick: () => patch('toggle', { paused: false }, 'Robot started.'), busy: busy === 'toggle' } :
    { label: 'Pause', small: 'Robot is running', aria: 'Pause robot', onClick: () => patch('toggle', { paused: true }, 'Robot paused. Open trades still follow their exits.'), busy: busy === 'toggle' };

  return (
    <>
      <div className="console">
        {/* LEFT: stage */}
        <section className="stage">
          <div className="status-row">
            <span className={`pill ${isLive ? 'live' : 'paper'}`}><i className="led" />{isLive ? 'Live · real funds' : 'Paper · fake money'}</span>
            <span className="pill"><Ticker running={running} /></span>
          </div>

          <Reactor running={running} label={reactor.label} small={reactor.small} aria={reactor.aria} onClick={reactor.onClick} disabled={!!busy} busy={reactor.busy} />

          <div className="kpis">
            <div className="kpi"><span>Vault</span><b>{sol(bal)}<em>SOL</em></b></div>
            <div className="kpi"><span>Today</span><b className={today >= 0 ? 'up' : 'dn'}>{signed(today)}<em>SOL</em></b></div>
            <div className="kpi"><span>Open</span><b>{openList.length}<em>/ {s.max_concurrent}</em></b></div>
          </div>

          <div className="tiles">
            <button className="tile" disabled={!hasVault} onClick={() => setSheet('fund')}><i>＋</i>Deposit</button>
            <button className="tile" disabled={!hasVault} onClick={() => setSheet('withdraw')}><i>↗</i>Withdraw</button>
            <button className="tile" onClick={() => setSheet('tg')}><i>✈</i>Telegram{me.telegramLinked && <u className="dot" />}</button>
            <button className="tile" onClick={() => setSheet('perm')}><i>i</i>Permissions</button>
          </div>
        </section>

        {/* RIGHT: settings + feed */}
        <section className="side">
          <div className="panel" ref={settingsRef}>
            <div className="panel-head"><h2>Your limits, signed</h2>{hasConsent && <span className="tag">signed ✓</span>}</div>
            {!hasVault && <p className="hint">Create your vault with the big button first, then sign your limits here.</p>}

            <div className="seg" role="radiogroup" aria-label="Mode">
              {MODE_KEYS.map((k) => (
                <button key={k} role="radio" aria-checked={form.mode === k} className={form.mode === k ? 'on' : ''} disabled={!hasVault}
                  onClick={() => pickMode(k)}>{MODES[k].name}</button>
              ))}
            </div>
            <p className="hint">{MODES[form.mode].line}</p>

            <Slider label={`Trade size (min $${minUsd[form.mode]})`} value={`$${form.sizeUsd}${needSol != null ? ` ≈ ${needSol.toFixed(3)} SOL` : ''}`} min={minUsd[form.mode]} max={lim.maxSizeUsd} step={1} v={form.sizeUsd} disabled={!hasVault}
              onChange={(n) => { const sug = !hasConsent ? suggestPos(n) : null; setForm({ ...form, sizeUsd: n, maxPositionSol: sug != null ? Number(sug.toFixed(3)) : form.maxPositionSol }); touch(); }} />
            <Slider label="Max per trade" value={`${form.maxPositionSol} SOL`} min={lim.maxPositionSol.min} max={lim.maxPositionSol.max} step={0.005} v={form.maxPositionSol} disabled={!hasVault}
              onChange={(n) => { setForm({ ...form, maxPositionSol: Number(n.toFixed(3)) }); touch(); }} />
            <Slider label="Stop for the day at" value={`−${form.maxDailyLossPct}%`} min={lim.maxDailyLossPct.min} max={lim.maxDailyLossPct.max} step={1} v={form.maxDailyLossPct} disabled={!hasVault}
              onChange={(n) => { setForm({ ...form, maxDailyLossPct: n }); touch(); }} />
            <Slider label="Max open trades" value={`${form.maxConcurrent}`} min={lim.maxConcurrent.min} max={lim.maxConcurrent.max} step={1} v={form.maxConcurrent} disabled={!hasVault}
              onChange={(n) => { setForm({ ...form, maxConcurrent: n }); touch(); }} />

            {hasVault && tooSmallCap && <p className="hint warn">Your signed max per trade ({capSol} SOL) is below this trade size{needSol != null ? ` (≈ ${needSol.toFixed(3)} SOL)` : ''}. Trades will shrink to {capSol} SOL. Raise it and sign again to trade the full size.</p>}
            {sizeDirty && <div className="row" style={{ marginTop: 10 }}><button className="btn btn-ghost" disabled={!!busy} onClick={() => patch('size', { sizeUsd: form.sizeUsd }, `Trade size set to $${form.sizeUsd}.`)}>Save trade size ${form.sizeUsd}</button></div>}
            {hasVault && !preview && (
              <div className="row" style={{ marginTop: 14 }}>
                {modeChangeOnly ? (
                  <button className="btn btn-gold" disabled={!!busy} onClick={() => patch('mode', { mode: form.mode }, `Mode set to ${form.mode}.`)}>Apply {MODES[form.mode].name}</button>
                ) : (
                  <button className="btn btn-gold" disabled={!!busy || (hasConsent && !needsSignature)} onClick={reviewConsent}>{hasConsent ? 'Review new consent' : 'Review what I will sign'}</button>
                )}
                {hasConsent && !needsSignature && !modeChangeOnly && <span className="hint">Lowering limits needs no signature. Raising them does.</span>}
              </div>
            )}
            {preview && (
              <>
                <span className="lbl">This is exactly what your wallet will ask you to sign</span>
                <div className="msg">{preview}</div>
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn btn-gold" disabled={!!busy} onClick={signConsent}>{busy === 'consent' ? 'Waiting for your wallet…' : 'Sign with my wallet'}</button>
                  <button className="btn btn-ghost" onClick={() => setPreview(null)}>Cancel</button>
                </div>
              </>
            )}

            <div className="switch-row">
              <div>
                <b>Live trading</b>
                <span>{me.liveEnabled ? (liveReady || s.live ? 'Uses real funds from your vault.' : `${!hasVault ? 'Create a vault' : !hasConsent ? 'Sign your limits' : `Fund at least ${lim.minVaultSolForLive} SOL`} first.`) : 'Not open on this site yet. Everything runs on paper.'}</span>
              </div>
              <button className={`toggle ${isLive ? 'on' : ''}`} role="switch" aria-checked={isLive} aria-label="Live trading"
                disabled={!!busy || !me.liveEnabled || (!s.live && !liveReady)}
                onClick={() => patch('live', { live: !s.live }, s.live ? 'Back to paper mode.' : 'Live trading on. Real funds from your vault are in play.')}><i /></button>
            </div>
            {hasConsent && <button className="btn btn-danger wide" disabled={!!busy} onClick={panic}>Stop and sell all</button>}
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Activity</h2>
              <div className="tabs">
                <button className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>Open {openList.length > 0 && <u>{openList.length}</u>}</button>
                <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History</button>
              </div>
            </div>
            {!trades ? <p className="hint">Loading…</p> : tab === 'open' ? (
              openList.length === 0 ? (
                <div className="empty"><i className="dots big"><u /><u /><u /></i><span>{running ? 'Scanning. Trades appear here when the robot enters one.' : 'No open trades. Press Start to let the robot look for entries.'}</span></div>
              ) : openList.map((p) => (
                <div className="feed" key={p.mint}>
                  <div><b>{short(p.mint)}</b><span>{sol(p.sizeSol)} SOL · exits +{p.takeProfitPct}% / −{p.stopLossPct}%</span></div>
                  <strong className={p.lastPnl == null ? '' : p.lastPnl >= 0 ? 'up' : 'dn'}>{p.lastPnl == null ? '…' : `${p.lastPnl >= 0 ? '+' : ''}${p.lastPnl.toFixed(1)}%`}</strong>
                </div>
              ))
            ) : history.length === 0 ? (
              <div className="empty"><span>No closed trades yet in {isLive ? 'live' : 'paper'} mode.</span></div>
            ) : history.slice(0, 12).map((t) => (
              <div className="feed" key={t.id}>
                <div><b>{short(t.mint)}</b><span>{t.exit_reason || 'closed'} · {new Date(t.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
                <strong className={t.realized_sol == null ? '' : t.realized_sol >= 0 ? 'up' : 'dn'}>{t.realized_sol == null ? '?' : `${signed(t.realized_sol)} SOL`}</strong>
              </div>
            ))}
          </div>
        </section>
      </div>

      {sheet === 'fund' && me.vault && (
        <Sheet title="Deposit to your vault" onClose={() => setSheet(null)}>
          <p>Your wallet asks you to approve one transfer to your vault. After that, the robot trades with the vault balance and never asks you to approve a trade. You can also copy the vault address and send from any exchange. Leave a little for network fees. You can take it all back whenever you like.</p>
          <div className="addr"><span style={{ flex: 1 }}>{me.vault.address}</span><button className="btn btn-ghost sm" onClick={() => navigator.clipboard?.writeText(me.vault!.address)}>Copy</button></div>
          <span className="lbl">Amount in SOL</span>
          <div className="row">
            <input className="field" style={{ maxWidth: 180 }} inputMode="decimal" value={fundAmt} onChange={(e) => setFundAmt(e.target.value)} aria-label="Amount in SOL" />
            <button className="btn btn-gold" disabled={!!busy} onClick={fund}>{busy === 'fund' ? 'Check your wallet…' : 'Deposit from my wallet'}</button>
          </div>
        </Sheet>
      )}

      {sheet === 'withdraw' && (
        <Sheet title="Withdraw" onClose={() => { setSheet(null); setWPreview(null); }}>
          <p>Send funds from your vault to your connected wallet (<span className="mono">{short(me.wallet)}</span>) or to any Solana address you paste. You sign the exact destination, so nothing can change it afterwards. {liveOpen > 0 && <b>You have open live trades: press “Stop and sell all” first.</b>}</p>
          {!wPreview ? (
            <>
              <span className="lbl">Send to</span>
              <input className="field" placeholder={`My wallet (${short(me.wallet)}) or paste another Solana address`} value={wTo} onChange={(e) => setWTo(e.target.value)} aria-label="Destination address" />
              {wTo.trim() !== '' && wTo.trim() !== me.wallet && <p className="hint warn">Check every character. Transfers on Solana cannot be reversed.</p>}
              <span className="lbl">Amount</span>
              <div className="row"><input className="field" style={{ maxWidth: 220 }} placeholder="Amount in SOL, blank = all" inputMode="decimal" value={wAmt} onChange={(e) => setWAmt(e.target.value)} />
                <button className="btn btn-ghost" disabled={!!busy || liveOpen > 0} onClick={reviewWithdraw}>Review withdrawal</button></div>
            </>
          ) : (
            <>
              <span className="lbl">Your wallet will ask you to sign this</span>
              <div className="msg">{wPreview.message}</div>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn btn-gold" disabled={!!busy} onClick={signWithdraw}>{busy === 'withdraw' ? 'Waiting for your wallet…' : 'Sign and withdraw'}</button>
                <button className="btn btn-ghost" onClick={() => setWPreview(null)}>Cancel</button>
              </div>
            </>
          )}
          {me.withdrawals.length > 0 && me.withdrawals.slice(0, 6).map((w) => (
            <div className="feed" key={w.id}>
              <div><b>{w.amount_lamports ? `${(Number(w.amount_lamports) / 1e9).toFixed(4)} SOL` : 'All'}</b><span>{new Date(w.created_at).toLocaleString()}{w.error ? ` · ${w.error}` : ''}{w.tx_sig ? <> · <a href={`https://solscan.io/tx/${w.tx_sig}`} target="_blank" rel="noreferrer">view</a></> : null}</span></div>
              <strong className={w.status === 'done' ? 'up' : w.status === 'failed' || w.status === 'rejected' ? 'dn' : ''}>{w.status}</strong>
            </div>
          ))}
        </Sheet>
      )}

      {sheet === 'tg' && (
        <Sheet title="Telegram" onClose={() => setSheet(null)}>
          {me.telegramLinked ? (
            <div className="row"><span className="pill paper">Linked</span><button className="btn btn-ghost" disabled={!!busy} onClick={() => run('unlink', async () => { await api('/api/telegram', { method: 'DELETE' }); await refresh(); })}>Unlink</button></div>
          ) : tg ? (
            <p>Open {tg.bot ? <a href={`https://t.me/${tg.bot}`} target="_blank" rel="noreferrer">@{tg.bot}</a> : 'the ART bot'} and send: <b className="mono">/link {tg.code}</b> (valid 10 minutes)</p>
          ) : (
            <><p>Get entry and exit alerts and control the robot (/pause, /resume, /sellall) from Telegram.</p><button className="btn btn-gold" disabled={!!busy} onClick={linkTg}>Link Telegram</button></>
          )}
        </Sheet>
      )}

      {sheet === 'perm' && (
        <Sheet title="What you sign, and what it can do" onClose={() => setSheet(null)}>
          <div className="perm"><i>i</i><div><b>Connect</b><span>Shares your public address. Cannot move funds.</span></div></div>
          <div className="perm"><i>ii</i><div><b>Sign in</b><span>A message that proves you own the wallet. Moves nothing, grants nothing.</span></div></div>
          <div className="perm"><i>iii</i><div><b>Sign your limits</b><span>A message that sets the most the robot may risk. It lets ART&apos;s service trade <u>from your vault only</u>, never from your own wallet.</span></div></div>
          <div className="perm"><i>iv</i><div><b>Fund the vault</b><span>A normal transfer you approve in your wallet. The only time your own wallet sends SOL.</span></div></div>
          <div className="perm"><i>v</i><div><b>Withdraw</b><span>A message you sign. The vault then sends funds to the address you signed (your wallet or one you paste), and nowhere else.</span></div></div>
          <p style={{ marginTop: 12 }}>Solana has no “unlimited spending approval” on your main wallet, and ART never asks for one. To end ART&apos;s access completely: Stop and sell all, withdraw everything, sign out.</p>
        </Sheet>
      )}
    </>
  );
}

function Slider({ label, value, min, max, step, v, onChange, disabled }: { label: string; value: string; min: number; max: number; step: number; v: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <div className="slider">
      <div><span>{label}</span><b>{value}</b></div>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={v} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
