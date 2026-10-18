import { NextRequest } from 'next/server';
import { json, fail, rateLimited, ipOf } from '@/lib/api';
import { db } from '@/lib/db';
import { isMint } from '@/lib/dex';
import { fetchTrades, type ChainTrade } from '@/lib/pumpchain';
import * as charting from '@/lib/charting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const tried = new Map<string, number>();

/**
 * Gives any coin a chart even if our robot never watched it launch: reads its latest trades from the chain, turns them
 * into candles, and saves them so the next open is instant. Coins our robot already tracks are left alone.
 */
export async function POST(req: NextRequest) {
  if (rateLimited(`bf:${ipOf(req)}`, 12, 60_000)) return fail('slow down', 429);
  const mint = (req.nextUrl.searchParams.get('mint') || '').trim();
  if (!isMint(mint)) return fail('That is not a token address.');
  if (Date.now() - (tried.get(mint) || 0) < 60_000) return json({ ok: true, skipped: 'recently tried' });
  tried.set(mint, Date.now()); if (tried.size > 500) tried.delete(tried.keys().next().value as string);
  const sb = db();
  const { data: row, error } = await sb.from('art_charts').select('mint,bars').eq('mint', mint).maybeSingle();
  if (error) return fail('Charts are not set up yet. Run the latest supabase_art.sql.', 503);
  if (row && Array.isArray(row.bars) && row.bars.length >= 8) return json({ ok: true, skipped: 'already recorded' });
  let trades: ChainTrade[] = [];
  try {
    const a = await fetchTrades(mint, { limit: 50 }); trades = a.trades;
    if (a.next && trades.length < 80) { const b = await fetchTrades(mint, { before: a.next, limit: 50 }); trades = [...trades, ...b.trades]; }
  } catch (e: any) { return fail(`Could not read this coin's history from the chain (${String(e?.message || e).slice(0, 80)}).`, 502); }
  if (!trades.length) return json({ ok: true, count: 0, note: 'No bonding-curve trades found. Coins that already moved to a pool have no curve history; the chart builds from live trades instead.' });
  const asc = [...trades].sort((x, y) => x.t - y.t);
  const bars: number[][] = [], m1: number[][] = [], m5: number[][] = [];
  for (const t of asc) { const tr = { t: t.t / 1000, p: t.mcapSol, v: t.sol, side: t.side }; charting.addTrade(bars, tr, 5, 720); charting.addTrade(m1, tr, 60, 360); charting.addTrade(m5, tr, 300, 864); }
  const last = asc[asc.length - 1], nowS = Date.now() / 1000;
  const ref = (sec: number) => { for (const b of bars) if (b[0] >= nowS - sec) return b[1]; return bars[0]?.[1] ?? null; };
  const chg = (r: number | null) => (r && r > 0 ? ((last.mcapSol - r) / r) * 100 : 0);
  const hour = asc.filter((t) => t.t / 1000 >= nowS - 3600);
  const fields: any = {
    mint, bars: bars.slice(-300), bars_1m: m1, bars_5m: m5,
    trades: asc.slice(-60).map((t) => [t.t, t.side === 'sell' ? 's' : 'b', +t.sol.toFixed(4), +t.mcapSol.toFixed(3), t.who, t.sig.slice(0, 10)]),
    mcap_sol: last.mcapSol, stats: { c5: +chg(ref(300)).toFixed(2), c1h: +chg(ref(3600)).toFixed(2), volSol1h: +hour.reduce((a, t) => a + t.sol, 0).toFixed(3), buys1h: hour.filter((t) => t.side === 'buy').length, sells1h: hour.filter((t) => t.side === 'sell').length, lastAt: last.t },
    updated_at: new Date(last.t).toISOString(), // the age of its newest trade, so an old coin never looks "trending"
  };
  if (!row) fields.first_seen = new Date(asc[0].t).toISOString();
  const w = await sb.from('art_charts').upsert(fields, { onConflict: 'mint' });
  if (w.error) return fail('Could not save the chart.', 500);
  return json({ ok: true, count: trades.length });
}
