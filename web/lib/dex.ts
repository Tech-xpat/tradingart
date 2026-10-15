/** DexScreener lookups for the Tokens tab (free, no key). Short in-memory cache so many viewers share one fetch. */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isMint = (s: unknown): s is string => typeof s === 'string' && BASE58.test(s);

export type TokenView = {
  mint: string; name: string | null; symbol: string | null; imageUrl: string | null;
  priceUsd: number | null; marketCapUsd: number | null; liquidityUsd: number | null;
  volume: { m5: number; h1: number; h6: number; h24: number };
  change: { m5: number; h1: number; h6: number; h24: number };
  txns1h: { buys: number; sells: number };
  pairAddress: string; dexId: string | null; pairCreatedAt: number | null; url: string | null;
  websites: string[]; socials: { type: string; url: string }[];
};

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const cache = new Map<string, { at: number; v: any }>();

function shape(p: any): TokenView {
  return {
    mint: p.baseToken?.address, name: p.baseToken?.name || null, symbol: p.baseToken?.symbol || null, imageUrl: p.info?.imageUrl || null,
    priceUsd: p.priceUsd != null ? n(p.priceUsd) : null, marketCapUsd: p.marketCap != null ? n(p.marketCap) : p.fdv != null ? n(p.fdv) : null, liquidityUsd: p.liquidity?.usd != null ? n(p.liquidity.usd) : null,
    volume: { m5: n(p.volume?.m5), h1: n(p.volume?.h1), h6: n(p.volume?.h6), h24: n(p.volume?.h24) },
    change: { m5: n(p.priceChange?.m5), h1: n(p.priceChange?.h1), h6: n(p.priceChange?.h6), h24: n(p.priceChange?.h24) },
    txns1h: { buys: n(p.txns?.h1?.buys), sells: n(p.txns?.h1?.sells) },
    pairAddress: p.pairAddress, dexId: p.dexId || null, pairCreatedAt: p.pairCreatedAt ? n(p.pairCreatedAt) : null, url: p.url || null,
    websites: (p.info?.websites || []).map((w: any) => w?.url).filter((u: unknown) => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 3),
    socials: (p.info?.socials || []).filter((s: any) => typeof s?.url === 'string' && /^https?:\/\//.test(s.url)).map((s: any) => ({ type: String(s.type || 'link'), url: s.url })).slice(0, 4),
  };
}

/** Best (deepest-liquidity) pair per requested mint. Missing mints are simply absent. */
export async function tokenViews(mints: string[]): Promise<Record<string, TokenView>> {
  const key = [...mints].sort().join(',');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 4000) return hit.v;
  const out: Record<string, TokenView> = {};
  const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(',')}`, { signal: AbortSignal.timeout(7000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`market data ${res.status}`);
  const pairs = (await res.json()) as any[];
  const best: Record<string, any> = {};
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const m = p?.baseToken?.address; if (!m || !mints.includes(m)) continue;
    if (!best[m] || n(p.liquidity?.usd) > n(best[m].liquidity?.usd)) best[m] = p;
  }
  for (const m of Object.keys(best)) out[m] = shape(best[m]);
  cache.set(key, { at: Date.now(), v: out });
  if (cache.size > 200) for (const [k, v] of cache) if (Date.now() - v.at > 30000) cache.delete(k);
  return out;
}
