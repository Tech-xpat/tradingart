import { authed, json, fail } from '@/lib/api';
import { db, must } from '@/lib/db';
import { solUsd } from '@/lib/price';
import { sanitizePlan } from '@/lib/planrules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One public trader: money made, the progress map (equity curve + open trades with their live moves), and the plan they trade. */
export const GET = authed({ limit: [60, 60_000] }, async ({ req, session }) => {
  const u = new URL(req.url);
  const handle = String(u.searchParams.get('handle') || '').toLowerCase();
  const live = u.searchParams.get('mode') !== 'paper';
  const sb = db();
  const p = must(await sb.from('art_settings').select('user_id,handle,plans,active_plan').eq('handle', handle).eq('public_profile', true).maybeSingle(), 'profile');
  if (!p) return fail('Trader not found.', 404);
  const [trades, state, folls, mine] = await Promise.all([
    sb.from('art_trades').select('created_at,mint,realized_sol,cost_sol,pct,hold_sec,exit_reason').eq('user_id', p.user_id).eq('paper', !live).order('created_at', { ascending: true }).limit(2000),
    sb.from('art_state').select('value').eq('user_id', p.user_id).eq('key', live ? 'live:positions' : 'paper:positions'),
    sb.from('art_settings').select('user_id').eq('follow_user_id', p.user_id),
    sb.from('art_settings').select('follow_user_id').eq('user_id', session.userId).single(),
  ]);
  const rows = (must(trades, 'trades') as any[]).filter((t) => t.realized_sol != null);
  let cum = 0, cost = 0, wins = 0;
  const curve = rows.map((t) => { cum += Number(t.realized_sol); cost += Number(t.cost_sol) || 0; if (t.realized_sol > 0) wins += 1; return [new Date(t.created_at).getTime(), Math.round(cum * 1e6) / 1e6]; });
  const day = Date.now() - 86400e3;
  const today = rows.filter((t) => new Date(t.created_at).getTime() >= day).reduce((a, t) => a + Number(t.realized_sol), 0);
  const list: any[] = Array.isArray(p.plans) ? p.plans : [];
  const src = list.find((x) => x.id === p.active_plan) || list[0];
  const open = (must(state, 'state')[0]?.value || []) as any[];
  const rate = await solUsd();
  return json({
    handle: p.handle, me: p.user_id === session.userId, mode: live ? 'live' : 'paper',
    following: must(mine, 'me').follow_user_id === p.user_id,
    followers: must(folls, 'followers').length,
    stats: { pnlSol: cum, pnlUsd: rate ? cum * rate : null, todaySol: today, roiPct: cost > 0 ? (cum / cost) * 100 : null, winRate: rows.length ? (wins / rows.length) * 100 : null, trades: rows.length },
    curve: curve.slice(-300),
    open: open.map((x) => ({ mint: x.mint, openedAt: x.openedAt, lastPnl: x.lastPnl, trail: (x.trail || []).slice(-60), takeProfitPct: x.takeProfitPct, stopLossPct: x.stopLossPct })),
    recent: rows.slice(-20).reverse().map((t) => ({ at: t.created_at, mint: t.mint, realizedSol: t.realized_sol, pct: t.pct, holdSec: t.hold_sec, reason: t.exit_reason })),
    plan: src ? sanitizePlan(src) : null,
  });
});
