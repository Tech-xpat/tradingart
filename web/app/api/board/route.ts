import { NextRequest } from 'next/server';
import { json, fail, rateLimited, ipOf } from '@/lib/api';
import { db } from '@/lib/db';
import { solUsd } from '@/lib/price';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The Tokens lists, straight from the robot's own records: every coin it sees launch is here, with its numbers and a
 * chart already recorded. New / Final stretch / Migrated, kept on the server so they are the same on every device and
 * after every refresh.
 */
const COLS = 'mint,name,symbol,uri,created,first_seen,mcap_sol,v_sol,migrated,migrated_at,stats,image,description,has_thumb,updated_at';
const DAY = 24 * 3600e3;

export async function GET(req: NextRequest) {
  if (rateLimited(`board:${ipOf(req)}`, 60, 60_000)) return fail('slow down', 429);
  const sb = db(); const since = new Date(Date.now() - DAY).toISOString();
  const [fresh, stretch, mig] = await Promise.all([
    sb.from('art_charts').select(COLS).eq('migrated', false).eq('created', true).gte('first_seen', since).order('first_seen', { ascending: false }).limit(60),
    sb.from('art_charts').select(COLS).eq('migrated', false).eq('created', true).gte('v_sol', 30 + 85 * 0.6).gte('updated_at', since).order('v_sol', { ascending: false }).limit(30),
    sb.from('art_charts').select(COLS).eq('migrated', true).gte('updated_at', since).order('migrated_at', { ascending: false, nullsFirst: false }).limit(30),
  ]);
  const err = fresh.error || stretch.error || mig.error;
  if (err) return fail('The robot has not recorded coins yet (run the latest supabase_art.sql, then wait a minute).', 503);
  const row = (r: any) => ({ mint: r.mint, name: r.name, symbol: r.symbol, uri: r.uri, createdAt: Date.parse(r.first_seen) || null, mcapSol: r.mcap_sol, vSol: r.v_sol, migrated: r.migrated, migratedAt: r.migrated_at ? Date.parse(r.migrated_at) : null, stats: r.stats || null, image: r.image, description: r.description, thumb: !!r.has_thumb, updatedAt: Date.parse(r.updated_at) || null });
  return json({ new: (fresh.data || []).map(row), stretch: (stretch.data || []).map(row), migrated: (mig.data || []).map(row), solUsd: await solUsd().catch(() => null) });
}
