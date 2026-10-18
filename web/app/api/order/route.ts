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
  const stale = row.status === 'pending' && Date.now() - Date.parse(row.created_at) > 20_000;
  let why = row.result;
  if (stale) {
    why = 'The robot did not pick this up.';
    try {
      const w = must(await db().from('art_worker').select('beat,version').eq('id', 'main').maybeSingle(), 'worker');
      const age = w ? (Date.now() - Date.parse(w.beat)) / 1000 : null;
      const [maj, min] = String(w?.version || '0.0').split('.').map(Number);
      if (!w || age === null || age > 90) why = 'The robot service is offline (no sign of life for a while). Check Railway: it must be running.';
      else if (maj < 4 || (maj === 4 && min < 2)) why = `The robot service is still running an old version (${w.version}). Redeploy Railway so it picks up manual buys (needs 4.2 or newer).`;
      else why = 'The robot service is online but has not picked this up yet. Check the Railway logs for "orderTick".';
    } catch { /* keep the generic text */ }
  }
  return json({ status: row.status, result: why, paper: row.paper, stale });
});
