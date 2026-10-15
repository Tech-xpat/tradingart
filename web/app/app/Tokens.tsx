'use client';
import { useEffect, useState } from 'react';
import { useLiveTokens, LIST_SIZE, type Tok, type FeedStatus } from '@/lib/liveTokens';
import type { TokenView } from '@/lib/dex';
import { api, Sheet, ago, usd } from './shared';

const STATUS_TEXT: Record<FeedStatus, string> = { connecting: 'Connecting…', live: 'Live', fallback: 'Backup feed' };

/** What a card shows, preferring real market data when we have it and the live stream otherwise. */
function view(t: Tok, solUsd: number | null) {
  const mcap = t.dex?.marketCapUsd ?? (t.mcapSol != null && solUsd ? t.mcapSol * solUsd : null);
  const vol = t.dex ? t.dex.volume.h1 : (solUsd ? t.volSol * solUsd : null);
  const txns = t.dex ? t.dex.txns1h.buys + t.dex.txns1h.sells : t.buys + t.sells;
  const created = t.dex?.pairCreatedAt || t.createdAt;
  return { mcap, vol, txns, created, change: t.dex?.change.h1 ?? null, liq: t.dex?.liquidityUsd ?? null };
}

function Avatar({ t }: { t: { image: string | null; symbol: string | null; name: string | null } }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [t.image]);
  return (
    <div className="avatar" aria-hidden>
      {t.image && !bad ? <img src={t.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBad(true)} /> : (t.symbol || t.name || '?').slice(0, 2).toUpperCase()}
    </div>
  );
}

function Card({ t, solUsd, now, onOpen }: { t: Tok; solUsd: number | null; now: number; onOpen: (m: string) => void }) {
  const v = view(t, solUsd);
  return (
    <button className="tkcard" onClick={() => onOpen(t.mint)} aria-label={`Open ${t.name || t.mint}`}>
      <Avatar t={t} />
      <div className="tkname"><b>{t.name || 'New token'}</b><span>{t.symbol ? `$${t.symbol}` : ''}</span></div>
      <div className="tkage">{ago(now - (t.kind === 'migrated' && t.migratedAt ? t.migratedAt : v.created))}</div>
      <div className="tkdesc">{t.description || ''}</div>
      <div className="tkstats">
        <span>MC <b>{usd(v.mcap)}</b></span>
        <span>Vol <b>{usd(v.vol)}</b></span>
        <span>Tx <b>{v.txns || '–'}</b></span>
        {v.liq != null && <span>Liq <b>{usd(v.liq)}</b></span>}
        {v.change != null && <span className={v.change >= 0 ? 'up' : 'dn'}>{v.change >= 0 ? '+' : ''}{v.change.toFixed(1)}%</span>}
      </div>
      {t.kind === 'new' && t.progress != null && <div className="meter" title={`About ${(t.progress * 100).toFixed(0)}% of the way to migration`}><i style={{ width: `${Math.round(t.progress * 100)}%` }} /></div>}
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

function TokenSheet({ mint, seed, onClose }: { mint: string; seed: Tok | null; onClose: () => void }) {
  const [tv, setTv] = useState<TokenView | null>(seed?.dex || null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let stop = false;
    const go = async () => { try { const r = await api<{ token: TokenView }>(`/api/token?mint=${mint}`); if (!stop) { setTv(r.token); setErr(null); } } catch (e: any) { if (!stop) setErr(e?.message || 'Could not load'); } };
    go(); const id = setInterval(go, 8000);
    return () => { stop = true; clearInterval(id); };
  }, [mint]);
  const name = tv?.name || seed?.name || 'Token', symbol = tv?.symbol || seed?.symbol;
  const image = tv?.imageUrl || seed?.image || null;
  const chart = tv ? `https://dexscreener.com/solana/${tv.pairAddress}?embed=1&theme=dark&trades=0&info=0&interval=1` : null;
  return (
    <Sheet title={`${name}${symbol ? ` · $${symbol}` : ''}`} onClose={onClose} wide>
      <div className="thead">
        <Avatar t={{ image, symbol: symbol || null, name }} />
        <div style={{ minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all' }}>{mint}</div>
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn btn-ghost sm" onClick={() => { navigator.clipboard?.writeText(mint); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy address'}</button>
          </div>
        </div>
      </div>
      {seed?.description && <p>{seed.description}</p>}
      {tv ? (
        <div className="grid4">
          <div className="cell"><span>Price</span><b>{tv.priceUsd != null ? (tv.priceUsd < 0.01 ? `$${tv.priceUsd.toPrecision(3)}` : `$${tv.priceUsd.toFixed(4)}`) : '–'}</b></div>
          <div className="cell"><span>Market cap</span><b>{usd(tv.marketCapUsd)}</b></div>
          <div className="cell"><span>Liquidity</span><b>{usd(tv.liquidityUsd)}</b></div>
          <div className="cell"><span>Volume 24h</span><b>{usd(tv.volume.h24)}</b></div>
          <div className="cell"><span>Change 5m</span><b className={tv.change.m5 >= 0 ? 'up' : 'dn'}>{tv.change.m5.toFixed(1)}%</b></div>
          <div className="cell"><span>Change 1h</span><b className={tv.change.h1 >= 0 ? 'up' : 'dn'}>{tv.change.h1.toFixed(1)}%</b></div>
          <div className="cell"><span>Buys / sells 1h</span><b>{tv.txns1h.buys} / {tv.txns1h.sells}</b></div>
          <div className="cell"><span>Age</span><b>{tv.pairCreatedAt ? ago(Date.now() - tv.pairCreatedAt) : '–'}</b></div>
        </div>
      ) : null}
      {chart ? <div className="chartbox"><iframe src={chart} title="Price chart" loading="lazy" referrerPolicy="no-referrer" /></div>
        : <div className="coladd">{err || 'Loading market data…'}{err ? ' The chart appears once the token has a trading pair.' : ''}</div>}
      <div className="links">
        <a className="btn btn-ghost sm" href={tv?.url || `https://dexscreener.com/solana/${mint}`} target="_blank" rel="noreferrer">DexScreener</a>
        <a className="btn btn-ghost sm" href={`https://solscan.io/token/${mint}`} target="_blank" rel="noreferrer">Solscan</a>
        <a className="btn btn-ghost sm" href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noreferrer">pump.fun</a>
        {tv?.socials.map((s) => <a key={s.url} className="btn btn-ghost sm" href={s.url} target="_blank" rel="noreferrer">{s.type}</a>)}
      </div>
      <p className="hint">New tokens are extremely risky. A token that is live here is not a recommendation.</p>
    </Sheet>
  );
}

export default function TokensTab() {
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
        <span className={`feedstat ${feed.status}`} title={feed.status === 'fallback' ? 'The live socket could not connect, so this list refreshes every 20 seconds from DexScreener.' : ''}><i />{STATUS_TEXT[feed.status]}</span>
      </div>
      {msg && <div className="note err" role="alert">{msg}</div>}
      <div className="subtabs" role="tablist">
        <button role="tab" aria-selected={sub === 'new'} className={sub === 'new' ? 'on' : ''} onClick={() => setSub('new')}>New<u>{L.new.length}</u></button>
        <button role="tab" aria-selected={sub === 'stretch'} className={sub === 'stretch' ? 'on' : ''} onClick={() => setSub('stretch')}>Final stretch<u>{L.stretch.length}</u></button>
        <button role="tab" aria-selected={sub === 'migrated'} className={sub === 'migrated' ? 'on' : ''} onClick={() => setSub('migrated')}>Migrated<u>{L.migrated.length}</u></button>
      </div>
      <div className="cols">
        <Column title="New" hint={`latest ${LIST_SIZE} launches`} items={L.new} solUsd={feed.solUsd} now={now} onOpen={setOpen} on={sub === 'new'} empty="Waiting for the next launch…" />
        <Column title="Final stretch" hint="bonding curve nearly full" items={L.stretch} solUsd={feed.solUsd} now={now} onOpen={setOpen} on={sub === 'stretch'} empty="Tokens close to migrating show up here as the feed watches them." />
        <Column title="Migrated" hint="just graduated" items={L.migrated} solUsd={feed.solUsd} now={now} onOpen={setOpen} on={sub === 'migrated'} empty="Waiting for the next migration…" />
      </div>
      {open && <TokenSheet mint={open} seed={feed.find(open)} onClose={() => setOpen(null)} />}
    </>
  );
}
