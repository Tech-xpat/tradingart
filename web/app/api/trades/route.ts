import { authed, json } from '@/lib/api';
import { db, must } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authed({ limit: [90, 60_000] }, async ({ session }) => {
  const sb = db();
  const [state, trades] = await Promise.all([
    sb.from('art_state').select('key,value').eq('user_id', session.userId).in('key', ['paper:positions', 'live:positions', 'paper:daily', 'live:daily']),
    sb.from('art_trades').select('id,created_at,paper,mode,mint,exit_reason,cost_sol,proceeds_sol,realized_sol,pct,hold_sec,sell_sig,buy_sig').eq('user_id', session.userId).order('created_at', { ascending: false }).limit(30),
  ]);
  const by: Record<string, any> = {};
  for (const r of must(state, 'state')) by[r.key] = r.value;
  const open = (k: string) => (Array.isArray(by[k]) ? by[k] : []).map((p: any) => ({ mint: p.mint, openedAt: p.openedAt, sizeSol: p.sizeSol, lastPnl: p.lastPnl, status: p.status, takeProfitPct: p.takeProfitPct, stopLossPct: p.stopLossPct, buySig: p.buySig }));
  return json({
    paper: { open: open('paper:positions'), daily: by['paper:daily'] || null },
    live: { open: open('live:positions'), daily: by['live:daily'] || null },
    trades: must(trades, 'trades'),
  });
});
