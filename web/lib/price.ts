/** SOL price in USD for display only (the worker fetches its own price for trading). Cached 30s; null if unreachable. */
let cache: { v: number | null; t: number } = { v: null, t: 0 };

export async function solUsd(): Promise<number | null> {
  if (Date.now() - cache.t < 30_000) return cache.v;
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    const j: any = await r.json();
    const pair = (j.pairs || []).filter((p: any) => p.chainId === 'solana' && p.baseToken?.symbol === 'SOL' && ['USDC', 'USDT'].includes(p.quoteToken?.symbol))
      .sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const v = Number(pair?.priceUsd);
    cache = { v: Number.isFinite(v) && v > 0 ? v : cache.v, t: Date.now() };
  } catch { cache = { v: cache.v, t: Date.now() }; }
  return cache.v;
}
