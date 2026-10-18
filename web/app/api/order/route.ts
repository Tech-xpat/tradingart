import { authed, json, fail } from '@/lib/api';
import { db, must } from '@/lib/db';
import { isMint } from '@/lib/dex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

/**
 * A manual buy from the coin chart. This only records the request; the robot service executes it inside the safety limits
 * the user signed (max per trade, concurrent trades, daily loss), in paper or live mode according to the user's setting.
 */
export const POST = authed({ write: true, limit: [10, 60_000] }, async ({ req, session }) => {
  const b = await req.json().catch(() => null);
  const mint = String(b?.mint || '').trim();
  if (!isMint(mint)) return fail('That is not a token address.');
  const size = num(b?.sizeSol);
  if (!(size >= 0.001 && size <= 100)) return fail('Enter an amount of at least 0.001 SOL.');
  const tp = b?.tpPct == null || b.tpPct === '' ? null : num(b.tpPct), sl = b?.slPct == null || b.slPct === '' ? null : num(b.slPct), hold = b?.holdMin == null || b.holdMin === '' ? null : num(b.holdMin);
  if ((tp !== null && !(tp > 0 && tp <= 10000)) || (sl !== null && !(sl > 0 && sl < 100)) || (hold !== null && !(hold >= 0.5 && hold <= 1440))) return fail('Check the take profit, stop loss and hold time.');
  const sb = db();
  const open = must(await sb.from('art_orders').select('id').eq('user_id', session.userId).in('status', ['pending', 'processing']).limit(1), 'orders');
  if (open.length) return fail('Your last order is still being processed. Wait a few seconds.', 409);
  const r = await sb.from('art_orders').insert({ user_id: session.userId, mint, size_sol: size, tp_pct: tp, sl_pct: sl, hold_min: hold }).select('id').single();
  if (r.error) return fail('Orders are not set up yet. Run the latest supabase_art.sql in Supabase.', 503);
  return json({ ok: true, id: r.data.id });
});

/** Status of an order (only the owner can see it). */
export const GET = authed({ limit: [120, 60_000] }, async ({ req, session }) => {
  const id = req.nextUrl.searchParams.get('id') || '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fail('bad id');
  const row = must(await db().from('art_orders').select('status,result,paper,created_at').eq('id', id).eq('user_id', session.userId).maybeSingle(), 'order');
  if (!row) return fail('not found', 404);
  const stale = row.status === 'pending' && Date.now() - Date.parse(row.created_at) > 45_000;
  return json({ status: row.status, result: stale ? 'The robot did not pick this up. Check that the robot service shows online in the Robot tab.' : row.result, paper: row.paper, stale });
});
