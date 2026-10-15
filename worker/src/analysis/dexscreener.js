const { SOL_MINT } = require('../config');

/**
 * Market snapshot from DexScreener (free, no key), with a short cache: many users hold or scan the same
 * mints, so one fetch serves all of them.
 */
const CACHE_TTL_MS = 5000;
const cache = new Map();

async function fetchMarket(mint) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const data = await res.json();
  const pairs = (data.pairs || []).filter(
    (p) => p.chainId === 'solana' && p.baseToken && p.baseToken.address === mint && p.quoteToken && p.quoteToken.address === SOL_MINT
  );
  if (!pairs.length) return null;
  const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  const priceNative = Number(best.priceNative || 0) || 0;
  if (!(priceNative > 0)) return null;
  const createdAt = Number(best.pairCreatedAt || 0) || 0;
  const tx = (best.txns && best.txns.h1) || {};
  return {
    marketCapUsd: Number(best.marketCap || best.fdv || 0) || 0,
    liquidityUsd: Number(best.liquidity?.usd || 0) || 0,
    priceUsd: Number(best.priceUsd || 0) || 0,
    priceNative,
    volume24h: Number(best.volume?.h24 || 0) || 0,
    volume1h: Number(best.volume?.h1 || 0) || 0,
    volume6h: Number(best.volume?.h6 || 0) || 0,
    priceChange5m: Number(best.priceChange?.m5 || 0) || 0,
    priceChange1h: Number(best.priceChange?.h1 || 0) || 0,
    priceChange6h: Number(best.priceChange?.h6 || 0) || 0,
    priceChange24h: Number(best.priceChange?.h24 || 0) || 0,
    pairCreatedAt: createdAt,
    ageSec: createdAt > 0 ? Math.max(0, (Date.now() - createdAt) / 1000) : 0,
    ageDays: createdAt > 0 ? (Date.now() - createdAt) / 86400000 : 0,
    buys1h: Number(tx.buys || 0) || 0,
    sells1h: Number(tx.sells || 0) || 0,
    pairUrl: best.url || null,
    dexId: best.dexId || null,
  };
}

async function getTokenMarket(mint) {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.value;
  const inflight = hit && hit.promise;
  if (inflight) return inflight;
  const promise = fetchMarket(mint).then((value) => { cache.set(mint, { ts: Date.now(), value }); return value; }, (e) => { cache.delete(mint); throw e; });
  cache.set(mint, { ts: 0, value: null, promise });
  return promise;
}

function sweep() { const t = Date.now(); for (const [k, v] of cache) if (t - v.ts > 60000 && !v.promise) cache.delete(k); }
setInterval(sweep, 60000).unref();

module.exports = { getTokenMarket };
