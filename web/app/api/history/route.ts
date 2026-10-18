import { NextRequest } from 'next/server';
import { json, fail, rateLimited, ipOf } from '@/lib/api';
import { isMint } from '@/lib/dex';
import { fetchTrades } from '@/lib/pumpchain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const cache = new Map<string, { at: number; v: any }>();

/** Older trades of a coin, straight from the chain (public data). Page backwards with `before`. */
export async function GET(req: NextRequest) {
  if (rateLimited(`hist:${ipOf(req)}`, 20, 60_000)) return fail('slow down', 429);
  const mint = (req.nextUrl.searchParams.get('mint') || '').trim(), before = (req.nextUrl.searchParams.get('before') || '').trim();
  if (!isMint(mint)) return fail('That is not a token address.');
  if (before && !/^[A-Za-z0-9]{60,100}$/.test(before)) return fail('bad cursor');
  const key = `${mint}:${before}`, hit = cache.get(key); if (hit && Date.now() - hit.at < 15_000) return json(hit.v);
  try {
    const r = await fetchTrades(mint, { before: before || undefined, limit: 40 });
    cache.set(key, { at: Date.now(), v: r }); if (cache.size > 200) cache.delete(cache.keys().next().value as string);
    return json(r);
  } catch (e: any) { return fail(`The network node did not return the history (${String(e?.message || e).slice(0, 80)}). Add a better SOLANA_RPC_URL on Vercel if this keeps happening.`, 502); }
}
