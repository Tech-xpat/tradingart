import type { Tok } from './liveTokens';

/**
 * A quick, explainable risk read for a token card. It is a heuristic built from numbers we can see (liquidity,
 * activity, buy/sell balance, age, size, socials). It is NOT proof a token is legitimate: it cannot see who holds
 * the supply or whether the team will sell. Higher score = lower risk.
 */
export type Risk = { score: number; level: 'low' | 'medium' | 'high'; label: string; reasons: string[] };

export function riskOf(t: Tok, solUsd: number | null, nowMs = Date.now()): Risk {
  const d = t.dex;
  const reasons: string[] = [];
  let s = 10;
  const add = (pts: number, why: string) => { s += pts; reasons.push(`${pts >= 0 ? '+' : ''}${pts} ${why}`); };

  const liq = d?.liquidityUsd ?? null;
  if (liq != null) {
    if (liq >= 50_000) add(25, 'deep liquidity'); else if (liq >= 15_000) add(18, 'good liquidity'); else if (liq >= 5_000) add(10, 'thin liquidity'); else add(0, 'very thin liquidity');
  } else if (t.progress != null) add(Math.round(t.progress * 15), 'bonding curve filling');

  const buys = d ? d.txns1h.buys : t.buys, sells = d ? d.txns1h.sells : t.sells, tx = buys + sells;
  if (tx >= 100) add(15, 'busy trading'); else if (tx >= 30) add(10, 'steady trading'); else if (tx >= 10) add(5, 'some trading'); else add(0, 'little trading');
  if (tx >= 10) { const bp = buys / tx; if (bp >= 0.55) add(15, 'more buyers than sellers'); else if (bp >= 0.45) add(8, 'balanced buyers and sellers'); else add(-8, 'sellers dominate'); }

  const mcap = d?.marketCapUsd ?? (t.mcapSol != null && solUsd ? t.mcapSol * solUsd : null);
  if (mcap != null) { if (mcap >= 100_000) add(10, 'larger market cap'); else if (mcap >= 30_000) add(5, 'mid market cap'); else add(0, 'small market cap'); }
  const vol = d ? d.volume.h1 : (solUsd ? t.volSol * solUsd : null);
  if (mcap && vol != null && mcap > 0) { const r = vol / mcap; if (r > 5) add(-10, 'volume far above size (wash trading?)'); else if (r >= 0.05) add(10, 'healthy volume for its size'); }

  const created = d?.pairCreatedAt || t.createdAt;
  const ageMin = (nowMs - created) / 60000;
  if (ageMin >= 60) add(10, 'older than an hour'); else if (ageMin >= 10) add(5, 'older than 10 minutes'); else add(0, 'brand new');
  if (d && (d.websites.length || d.socials.length)) add(10, 'has website or socials');

  const score = Math.max(0, Math.min(100, Math.round(s)));
  const level = score >= 70 ? 'low' : score >= 40 ? 'medium' : 'high';
  return { score, level, label: level === 'low' ? 'Lower risk' : level === 'medium' ? 'Medium risk' : 'High risk', reasons };
}
