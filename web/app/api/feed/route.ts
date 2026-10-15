import { NextRequest } from 'next/server';
import { json, fail, rateLimited, ipOf } from '@/lib/api';
import { solUsd } from '@/lib/price';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let cache: { at: number; items: any[] } = { at: 0, items: [] };

/** Fallback feed for the Tokens tab when the live socket is unreachable: newest Solana token profiles on DexScreener + the SOL price. */
export async function GET(req: NextRequest) {
  if (rateLimited(`feed:${ipOf(req)}`, 30, 60_000)) return fail('slow down', 429);
  try {
    if (Date.now() - cache.at > 10_000) {
      const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', { signal: AbortSignal.timeout(7000) });
      if (!res.ok) throw new Error(`feed ${res.status}`);
      const arr = (await res.json()) as any[];
      cache = { at: Date.now(), items: (Array.isArray(arr) ? arr : []).filter((x) => x?.chainId === 'solana' && x?.tokenAddress).slice(0, 40).map((x) => ({ mint: x.tokenAddress, icon: x.icon || null, description: x.description || null })) };
    }
    return json({ items: cache.items, solUsd: await solUsd() });
  } catch (e: any) { return fail(e?.message || 'feed unavailable', 502); }
}
