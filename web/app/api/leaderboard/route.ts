import { authed, json } from '@/lib/api';
import { db, must } from '@/lib/db';
import { solUsd } from '@/lib/price';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PERIODS: Record<string, number | null> = { '24h': 86400e3, '7d': 7 * 86400e3, all: null };

/** Opt-in leaderboard: only traders who switched on their public profile, ranked by realised profit. */
export const GET = authed({ limit: [60, 60_000] }, async ({ req, session }) => {
  const u = new URL(req.url);
  const live = u.searchParams.get('mode') !== 'paper';
  const periodKey = u.searchParams.get('period') || '7d';
  const ms = periodKey in PERIODS ? PERIODS[periodKey] : PERIODS['7d'];
  const sb = db();
  const pros = must(await sb.from('art_settings').select('user_id,handle,follow_user_id').eq('public_profile', true).limit(500), 'profiles') as any[];
  const ids = pros.filter((p) => p.handle).map((p) => p.user_id);
  const followers: Record<string, number> = {};
  const followRows = ids.length ? must(await sb.from('art_settings').select('follow_user_id').in('follow_user_id', ids), 'followers') : [];
  for (const f of followRows as any[]) followers[f.follow_user_id] = (followers[f.follow_user_id] || 0) + 1;
  let q = sb.from('art_trades').select('user_id,created_at,realized_sol,cost_sol').in('user_id', ids.length ? ids : ['none']).eq('paper', !live).order('created_at', { ascending: true }).limit(20000);
  if (ms) q = q.gte('created_at', new Date(Date.now() - ms).toISOString());
  const rows = ids.length ? (must(await q, 'trades') as any[]) : [];
  const by: Record<string, { pnl: number; cost: number; wins: number; n: number; curve: number[] }> = {};
  for (const t of rows) {
    if (t.realized_sol == null) continue;
    const a = (by[t.user_id] ||= { pnl: 0, cost: 0, wins: 0, n: 0, curve: [] });
    a.pnl += Number(t.realized_sol); a.cost += Number(t.cost_sol) || 0; a.n += 1; if (t.realized_sol > 0) a.wins += 1;
    a.curve.push(Math.round(a.pnl * 1e6) / 1e6);
  }
  const rate = await solUsd();
  const board = pros.filter((p) => p.handle && by[p.user_id]).map((p) => {
    const a = by[p.user_id];
    return {
      handle: p.handle, me: p.user_id === session.userId, followers: followers[p.user_id] || 0,
      pnlSol: a.pnl, pnlUsd: rate ? a.pnl * rate : null, roiPct: a.cost > 0 ? (a.pnl / a.cost) * 100 : null,
      winRate: a.n ? (a.wins / a.n) * 100 : null, trades: a.n, curve: a.curve.slice(-40),
    };
  }).sort((x, y) => y.pnlSol - x.pnlSol).slice(0, 50).map((r, i) => ({ rank: i + 1, ...r }));
  return json({ mode: live ? 'live' : 'paper', period: periodKey, board, updatedAt: Date.now() });
});
