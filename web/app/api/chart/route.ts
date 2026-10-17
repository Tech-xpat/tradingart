import { NextRequest } from 'next/server';
import { json, fail, rateLimited, ipOf } from '@/lib/api';
import { db } from '@/lib/db';
import { isMint } from '@/lib/dex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Our own candles for one token, as recorded by the worker from the live trade feed. No outside chart service. */
export async function GET(req: NextRequest) {
  if (rateLimited(`chart:${ipOf(req)}`, 90, 60_000)) return fail('slow down', 429);
  const mint = (req.nextUrl.searchParams.get('mint') || '').trim();
  if (!isMint(mint)) return fail('That is not a Solana token address.');
  const { data, error } = await db().from('art_charts').select('mint,name,symbol,uri,first_seen,mcap_sol,v_sol,migrated,bars,bars_1m,bars_5m,updated_at').eq('mint', mint).maybeSingle();
  if (error) return fail('Charts are not set up yet. Run the latest supabase_art.sql.', 503);
  if (!data) return json({ chart: null });
  return json({ chart: { mint: data.mint, name: data.name, symbol: data.symbol, uri: data.uri, firstSeen: data.first_seen, mcapSol: data.mcap_sol, vSol: data.v_sol, migrated: data.migrated, bars: data.bars || [], bars1m: data.bars_1m || [], bars5m: data.bars_5m || [], updatedAt: data.updated_at } });
}
