/**
 * Token scanner, run once per MODE (not once per user): the best candidate is then offered to every
 * active account in that mode, each of which applies its own limits.
 */
const logger = require('../utils/logger');
const market = require('../analysis/dexscreener');
const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_AGE_DAYS = 10;
const SEEN_TTL_MS = 6 * 60 * 60 * 1000;
const seenByMode = { easy: new Map(), medium: new Map(), hard: new Map() };

const BARS = {
  easy:   { minLiq: 8000,  minVol1h: 1500, minBuys1h: 5 },
  medium: { minLiq: 15000, minVol1h: 4000, minBuys1h: 12 },
  hard:   { minLiq: 30000, minVol1h: 8000, minBuys1h: 20 },
};

let solPrice = { v: 180, ts: 0 };
async function fetchSolPriceUsd() {
  if (Date.now() - solPrice.ts < 60000) return solPrice.v;
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      const pair = (data.pairs || []).find((p) => p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT');
      const px = Number(pair?.priceUsd || 0);
      if (px > 10) solPrice = { v: px, ts: Date.now() };
    }
  } catch (_) {}
  return solPrice.v;
}

async function getJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.ok ? await res.json() : null;
  } catch (e) {
    logger.warn(`fetch ${url.slice(0, 60)} failed: ${e.message}`);
    return null;
  }
}

async function fetchCandidates() {
  const mints = new Set();
  for (const url of ['https://api.dexscreener.com/token-boosts/latest/v1', 'https://api.dexscreener.com/token-profiles/latest/v1']) {
    const arr = await getJson(url);
    for (const it of Array.isArray(arr) ? arr : []) if (it.chainId === 'solana' && it.tokenAddress) mints.add(it.tokenAddress);
  }
  const s = await getJson('https://api.dexscreener.com/latest/dex/search?q=solana');
  for (const p of (s && s.pairs) || []) if (p.chainId === 'solana' && p.baseToken?.address) mints.add(p.baseToken.address);
  return [...mints].slice(0, 50);
}

function scoreChart(mkt, mode) {
  if (!mkt || !(mkt.priceNative > 0)) return -Infinity;
  const ageDays = mkt.ageDays || 0;
  if (ageDays < MIN_AGE_DAYS) return -Infinity;
  const liq = mkt.liquidityUsd || 0, vol1h = mkt.volume1h || 0, vol6h = mkt.volume6h || 0;
  const ch5 = mkt.priceChange5m || 0, ch1h = mkt.priceChange1h || 0, ch6h = mkt.priceChange6h || 0, ch24h = mkt.priceChange24h || 0;
  const buys1h = mkt.buys1h || 0, sells1h = mkt.sells1h || 0;
  if (!(ch1h > 0 || ch6h > 2)) return -Infinity;
  if (ch5 < -12 || ch24h < -40) return -Infinity;
  const b = BARS[mode] || BARS.medium;
  if (liq < b.minLiq) return -Infinity;
  if (vol1h < b.minVol1h && vol6h < b.minVol1h * 3) return -Infinity;
  if (buys1h < b.minBuys1h) return -Infinity;
  const buyPressure = sells1h > 0 ? buys1h / sells1h : buys1h > 0 ? 2 : 0;
  if (buyPressure < 0.7) return -Infinity;
  let score = 0;
  score += Math.min(ch5, 25) * 1.5; score += Math.min(ch1h, 40) * 2; score += Math.min(ch6h, 60);
  score += Math.log10(Math.max(liq, 1)) * 10; score += Math.log10(Math.max(vol1h, 1)) * 6;
  score += Math.min(buyPressure, 3) * 8; score += Math.min(ageDays, 60) * 0.3;
  return score;
}

async function pickOne(mode) {
  const seen = seenByMode[mode] || seenByMode.medium;
  const now = Date.now();
  for (const [m, ts] of seen) if (now - ts > SEEN_TTL_MS) seen.delete(m);
  const candidates = await fetchCandidates();
  if (!candidates.length) { logger.info(`scanner[${mode}]: no candidates this cycle`); return null; }
  const scored = [];
  for (const mint of candidates) {
    if (seen.has(mint) || config.IGNORE_MINTS.includes(mint)) continue;
    try {
      const mkt = await market.getTokenMarket(mint);
      if (!mkt) continue;
      const s = scoreChart(mkt, mode);
      if (s > -Infinity) scored.push({ mint, mkt, score: s });
    } catch (_) {}
    await sleep(120);
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) { logger.info(`scanner[${mode}]: ${candidates.length} candidates, none passed (age>=${MIN_AGE_DAYS}d + rising)`); return null; }
  const top = scored.slice(0, 5);
  const pick = top[Math.floor(Math.random() * top.length)];
  seen.set(pick.mint, Date.now());
  logger.info(`scanner[${mode}] pick ${pick.mint.slice(0, 8)}… score=${pick.score.toFixed(1)} liq=$${Math.round(pick.mkt.liquidityUsd)}`);
  return pick;
}

module.exports = { pickOne, scoreChart, fetchSolPriceUsd, MIN_AGE_DAYS };
