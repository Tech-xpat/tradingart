'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TokenView } from './dex';
import * as charting from './charting';

/**
 * Live Solana token feed for the Tokens tab.
 *  - Primary: PumpPortal websocket (new launches, migrations, per-token trades), straight from the browser.
 *  - Market data: DexScreener through our /api/tokens proxy, refreshed every few seconds for what is on screen.
 *  - Fallback: if the socket cannot connect, the New list is filled from DexScreener's latest token profiles.
 * Three lists, 20 each, saved in the browser so they are still there after a refresh: New, Final stretch (bonding curve nearly full), Migrated.
 */
export type Tok = {
  mint: string; name: string | null; symbol: string | null; uri: string | null; image: string | null; description: string | null;
  createdAt: number; kind: 'new' | 'migrated'; migratedAt: number | null;
  mcapSol: number | null; progress: number | null; volSol: number; buys: number; sells: number; lastAt: number; dex: TokenView | null;
  own?: { c5: number; c1h: number } | null; thumb?: boolean; fromServer?: boolean;
};
export type FeedStatus = 'connecting' | 'live' | 'fallback';

export const LIST_SIZE = 20;
export const STREAM = process.env.NEXT_PUBLIC_STREAM_URL || 'wss://pumpportal.fun/api/data';

/** Candles this browser has built itself from the live trades it saw (market cap in SOL). The token page merges these with the robot's recorded candles. */
const localBars = new Map<string, number[][]>();
export const getLocalBars = (mint: string): number[][] => localBars.get(mint) || [];
/** The latest individual trades per coin (for the chart's buy/sell animation and the trade tape). */
export type LiveTrade = { id: number; t: number; side: 'buy' | 'sell'; sol: number; mcapSol: number; who?: string; sig?: string };
const localTrades = new Map<string, LiveTrade[]>();
let tradeSeq = 0;
export const getLocalTrades = (mint: string): LiveTrade[] => localTrades.get(mint) || [];
const seenSigs = new Set<string>();
export function recordTrade(m: any) {
  if (!m || typeof m.mint !== 'string') return;
  if (typeof m.signature === 'string') { if (seenSigs.has(m.signature)) return; seenSigs.add(m.signature); if (seenSigs.size > 4000) seenSigs.delete(seenSigs.values().next().value as string); } // two sockets can carry the same trade
  const tx = m.txType; if (tx !== 'create' && tx !== 'buy' && tx !== 'sell') return;
  let p = Number(m.marketCapSol);
  if (!(p > 0)) { const sol = Number(m.solAmount), tok = Number(m.tokenAmount); p = sol > 0 && tok > 0 ? (sol / tok) * 1e9 : NaN; }
  if (!(p > 0)) return;
  let b = localBars.get(m.mint); if (!b) { if (localBars.size > 400) localBars.delete(localBars.keys().next().value as string); b = []; localBars.set(m.mint, b); }
  charting.addTrade(b, { t: Date.now() / 1000, p, v: Number(m.solAmount) || 0, side: tx === 'create' ? 'buy' : tx }, 5, 720);
  let l = localTrades.get(m.mint); if (!l) { if (localTrades.size > 120) localTrades.delete(localTrades.keys().next().value as string); l = []; localTrades.set(m.mint, l); }
  l.push({ id: ++tradeSeq, t: Date.now(), side: tx === 'sell' ? 'sell' : 'buy', sol: Number(m.solAmount) || 0, mcapSol: p, who: typeof m.traderPublicKey === 'string' ? `${m.traderPublicKey.slice(0, 4)}…${m.traderPublicKey.slice(-4)}` : undefined, sig: typeof m.signature === 'string' ? m.signature.slice(0, 10) : undefined }); if (l.length > 80) l.shift();
}
const CACHE_KEY = 'art:tokens:v2';
const CACHE_MAX_AGE = 24 * 3600 * 1000;
const STREAM_URL = process.env.NEXT_PUBLIC_STREAM_URL || 'wss://pumpportal.fun/api/data';
const FINAL_STRETCH = 0.6;
const MAX_TRACKED = 160;

/** Bonding-curve progress from the virtual SOL reserve (starts ~30, graduates ~115). Approximate by nature. */
export const curveProgress = (vSol: number) => Math.max(0, Math.min(1, (vSol - 30) / 85));

function blank(mint: string): Tok {
  return { mint, name: null, symbol: null, uri: null, image: null, description: null, createdAt: Date.now(), kind: 'new', migratedAt: null, mcapSol: null, progress: null, volSol: 0, buys: 0, sells: 0, lastAt: Date.now(), dex: null };
}

export function useLiveTokens() {
  const store = useRef(new Map<string, Tok>());
  const subbed = useRef(new Set<string>());
  const ws = useRef<WebSocket | null>(null);
  const dirty = useRef(false);
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const [solUsd, setSolUsd] = useState<number | null>(null);
  const failures = useRef(0);
  const metaQ = useRef<string[]>([]); const metaBusy = useRef(0); const metaTries = useRef(new Map<string, number>());

  const touch = () => { dirty.current = true; };

  /* what was on screen last time comes back right after mount (not during server render, so hydration stays clean) */
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]') as Tok[];
      const cutoff = Date.now() - CACHE_MAX_AGE;
      for (const t of Array.isArray(saved) ? saved : []) if (t && typeof t.mint === 'string' && (t.lastAt || 0) > cutoff && !store.current.has(t.mint)) store.current.set(t.mint, { ...blank(t.mint), ...t });
      if (store.current.size) { dirty.current = true; setTick((n) => n + 1); for (const t of store.current.values()) if (t.uri && !t.image) metaQ.current.push(t.mint); pumpMeta(); }
    } catch { /* no saved list yet, or storage is blocked */ }
  }, []);
  const upsert = (mint: string, fn: (t: Tok) => void) => { let t = store.current.get(mint); if (!t) { t = blank(mint); store.current.set(mint, t); } fn(t); t.lastAt = Date.now(); touch(); return t; };

  const pumpMeta = useCallback(() => {
    while (metaBusy.current < 4 && metaQ.current.length) {
      const mint = metaQ.current.shift()!; const t = store.current.get(mint);
      if (!t || !t.uri || t.image) continue;
      metaBusy.current += 1;
      // the server reads the metadata file (several IPFS gateways, cached); the browser alone is rate limited
      fetch(`/api/meta?uri=${encodeURIComponent(t.uri)}`, { signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.json() : null)).then((j) => {
        if (!j) return;
        if (!j.image && !j.description) { const n = (metaTries.current.get(mint) || 0) + 1; metaTries.current.set(mint, n); if (n < 4) setTimeout(() => { metaQ.current.push(mint); pumpMeta(); }, 4000 * n); return; }
        upsert(mint, (x) => { x.image = (typeof j.image === 'string' ? j.image : null) || x.image; x.description = (typeof j.description === 'string' ? j.description : x.description) || null; if (!x.name && j.name) x.name = String(j.name); if (!x.symbol && j.symbol) x.symbol = String(j.symbol); });
      }).catch(() => {}).finally(() => { metaBusy.current -= 1; pumpMeta(); });
    }
  }, []);

  const subscribeTrades = (mints: string[]) => {
    const s = ws.current; if (!s || s.readyState !== 1) return;
    const fresh = mints.filter((m) => !subbed.current.has(m)); if (!fresh.length) return;
    fresh.forEach((m) => subbed.current.add(m));
    try { s.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: fresh })); } catch { /* retried on reconnect */ }
  };
  const evict = () => {
    const all = [...store.current.values()];
    if (all.length <= MAX_TRACKED * 2) return;
    const keep = new Set(all.filter((t) => t.kind === 'migrated').sort((a, b) => (b.migratedAt || 0) - (a.migratedAt || 0)).slice(0, 40).map((t) => t.mint));
    all.filter((t) => t.kind === 'new').sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_TRACKED).forEach((t) => keep.add(t.mint));
    const drop = all.filter((t) => !keep.has(t.mint)).map((t) => t.mint);
    const s = ws.current;
    if (drop.length) {
      const was = drop.filter((m) => subbed.current.has(m));
      if (was.length && s && s.readyState === 1) { try { s.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: was })); } catch { /* ignore */ } }
      drop.forEach((m) => { store.current.delete(m); subbed.current.delete(m); });
    }
  };

  const onMessage = useCallback((raw: unknown) => {
    let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
    if (!m || typeof m !== 'object' || typeof m.mint !== 'string') return;
    recordTrade(m);
    if (m.txType === 'create') {
      upsert(m.mint, (t) => {
        t.name = m.name || t.name; t.symbol = m.symbol || t.symbol; t.uri = typeof m.uri === 'string' && m.uri.length < 400 ? m.uri : t.uri; t.createdAt = Date.now();
        if (typeof m.marketCapSol === 'number') t.mcapSol = m.marketCapSol;
        if (typeof m.vSolInBondingCurve === 'number') t.progress = curveProgress(m.vSolInBondingCurve);
        if (typeof m.solAmount === 'number') { t.volSol += m.solAmount; t.buys += 1; }
      });
      if (m.uri) { metaQ.current.push(m.mint); pumpMeta(); }
      subscribeTrades([m.mint]); evict();
    } else if (m.txType === 'migrate') {
      upsert(m.mint, (t) => { t.kind = 'migrated'; t.migratedAt = Date.now(); t.progress = 1; });
    } else if (m.txType === 'buy' || m.txType === 'sell') {
      const t = store.current.get(m.mint); if (!t) return;
      upsert(m.mint, (x) => {
        if (typeof m.marketCapSol === 'number') x.mcapSol = m.marketCapSol;
        if (typeof m.vSolInBondingCurve === 'number' && x.kind === 'new') x.progress = curveProgress(m.vSolInBondingCurve);
        if (typeof m.solAmount === 'number') x.volSol += m.solAmount;
        if (m.txType === 'buy') x.buys += 1; else x.sells += 1;
      });
    }
  }, [pumpMeta]);

  /* socket with backoff; after 3 failures to connect we fall back to polling and keep retrying quietly */
  useEffect(() => {
    let closed = false, timer: ReturnType<typeof setTimeout> | null = null, backoff = 1500;
    const connect = () => {
      if (closed) return;
      let s: WebSocket;
      try { s = new WebSocket(STREAM_URL); } catch { failures.current += 1; if (failures.current >= 3) setStatus('fallback'); timer = setTimeout(connect, 15000); return; }
      ws.current = s; let opened = false;
      s.onopen = () => {
        opened = true; failures.current = 0; backoff = 1500; setStatus('live'); subbed.current.clear();
        s.send(JSON.stringify({ method: 'subscribeNewToken' })); s.send(JSON.stringify({ method: 'subscribeMigration' }));
        subscribeTrades([...store.current.values()].filter((t) => t.kind === 'new').map((t) => t.mint).slice(0, MAX_TRACKED));
      };
      s.onmessage = (e) => onMessage(e.data);
      s.onclose = () => {
        if (closed) return;
        if (!opened) { failures.current += 1; if (failures.current >= 3) setStatus('fallback'); } else setStatus('connecting');
        timer = setTimeout(connect, failures.current >= 3 ? 30000 : backoff); backoff = Math.min(backoff * 2, 20000);
      };
      s.onerror = () => { try { s.close(); } catch { /* ignore */ } };
    };
    connect();
    return () => { closed = true; if (timer) clearTimeout(timer); try { ws.current?.close(); } catch { /* ignore */ } };
  }, [onMessage]);

  /* fallback: the newest DexScreener profiles fill the New list */
  useEffect(() => {
    if (status !== 'fallback') return;
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch('/api/feed'); const j = await r.json(); if (stop || !r.ok) return;
        if (typeof j.solUsd === 'number') setSolUsd(j.solUsd);
        for (const it of (j.items || []) as { mint: string; icon: string | null; description: string | null }[]) {
          if (!store.current.has(it.mint)) upsert(it.mint, (t) => { t.image = it.icon; t.description = it.description; });
        }
      } catch { /* try again next time */ }
    };
    poll(); const id = setInterval(poll, 20000);
    return () => { stop = true; clearInterval(id); };
  }, [status]);

  /* the robot's own records: every coin it has seen launch, with numbers, picture and chart already saved */
  useEffect(() => {
    let stop = false;
    const go = async () => {
      try {
        const r = await fetch('/api/board', { cache: 'no-store' }); if (!r.ok) return; const j = await r.json(); if (stop) return;
        if (typeof j.solUsd === 'number') setSolUsd(j.solUsd);
        const apply = (rows: any[]) => {
          for (const x of rows || []) {
            if (!x || typeof x.mint !== 'string') continue;
            let t = store.current.get(x.mint); if (!t) { t = blank(x.mint); store.current.set(x.mint, t); }
            t.fromServer = true;
            t.name = x.name || t.name; t.symbol = x.symbol || t.symbol; t.uri = x.uri || t.uri;
            if (x.image) t.image = x.image; if (x.description) t.description = x.description; if (x.thumb) t.thumb = true;
            if (x.createdAt) t.createdAt = x.createdAt;
            if (typeof x.mcapSol === 'number') t.mcapSol = x.mcapSol;
            if (typeof x.vSol === 'number') t.progress = x.migrated ? 1 : curveProgress(x.vSol);
            if (x.migrated) { t.kind = 'migrated'; t.migratedAt = x.migratedAt || t.migratedAt || Date.now(); } else if (t.kind !== 'migrated') t.kind = 'new';
            if (x.stats) { t.volSol = x.stats.volSol1h || 0; t.buys = x.stats.buys1h || 0; t.sells = x.stats.sells1h || 0; t.own = { c5: x.stats.c5 || 0, c1h: x.stats.c1h || 0 }; }
            if (x.updatedAt) t.lastAt = Math.max(t.lastAt, x.updatedAt);
            if (!x.thumb && !t.image && t.uri) { metaQ.current.push(x.mint); }
          }
        };
        apply(j.new); apply(j.stretch); apply(j.migrated);
        touch(); pumpMeta();
      } catch { /* the live socket still works */ }
    };
    go(); const id = setInterval(go, 5000);
    return () => { stop = true; clearInterval(id); };
  }, [pumpMeta]);

  /* save the lists (newest first, trimmed) every few seconds and when the tab is hidden */
  useEffect(() => {
    const save = () => {
      try {
        const all = [...store.current.values()];
        const keep = [
          ...all.filter((t) => t.kind === 'new').sort((a, b) => b.createdAt - a.createdAt).slice(0, 80),
          ...all.filter((t) => t.kind === 'migrated').sort((a, b) => (b.migratedAt || 0) - (a.migratedAt || 0)).slice(0, 40),
        ];
        localStorage.setItem(CACHE_KEY, JSON.stringify(keep));
      } catch { /* storage full or blocked: the live feed still works */ }
    };
    const id = setInterval(save, 4000);
    const hide = () => { if (document.visibilityState === 'hidden') save(); };
    document.addEventListener('visibilitychange', hide); window.addEventListener('pagehide', save);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', save); };
  }, []);

  /* repaint at most every 700 ms, however fast the socket is */
  useEffect(() => { const id = setInterval(() => { if (dirty.current) { dirty.current = false; setTick((n) => n + 1); } }, 700); return () => clearInterval(id); }, []);

  const lists = useMemo(() => {
    void tick;
    const all = [...store.current.values()];
    const live = all.filter((t) => t.kind === 'new');
    const stretch = live.filter((t) => (t.progress ?? 0) >= FINAL_STRETCH).sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0)).slice(0, LIST_SIZE);
    const inStretch = new Set(stretch.map((t) => t.mint));
    const fresh = live.filter((t) => !inStretch.has(t.mint) && (t.progress ?? 0) < FINAL_STRETCH).sort((a, b) => b.createdAt - a.createdAt).slice(0, LIST_SIZE);
    const migrated = all.filter((t) => t.kind === 'migrated').sort((a, b) => (b.migratedAt || 0) - (a.migratedAt || 0)).slice(0, LIST_SIZE);
    return { new: fresh, stretch, migrated };
  }, [tick]);

  /* enrich what is on screen with real market data (image, volume, price change, liquidity) */
  const shown = useMemo(() => [...lists.new, ...lists.stretch, ...lists.migrated].map((t) => t.mint).join(','), [lists]);
  const shownRef = useRef(''); shownRef.current = shown;
  useEffect(() => {
    let stop = false;
    const go = async () => {
      const mints = shownRef.current.split(',').filter(Boolean).slice(0, 60); if (!mints.length) return;
      try {
        const r = await fetch(`/api/tokens?mints=${mints.join(',')}`); const j = await r.json(); if (stop || !r.ok) return;
        if (typeof j.solUsd === 'number') setSolUsd(j.solUsd);
        for (const [mint, v] of Object.entries(j.tokens || {}) as [string, TokenView][]) upsert(mint, (t) => { t.dex = v; if (!t.name) t.name = v.name; if (!t.symbol) t.symbol = v.symbol; if (!t.image) t.image = v.imageUrl; });
      } catch { /* ignore */ }
    };
    const first = setTimeout(go, 1500); const id = setInterval(go, 10000);
    return () => { stop = true; clearTimeout(first); clearInterval(id); };
  }, []);

  const find = useCallback((mint: string) => store.current.get(mint) || null, []);
  return { status, lists, solUsd, find, tick };
}
