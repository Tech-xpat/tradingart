import { authed, json, fail } from '@/lib/api';
import { db, must } from '@/lib/db';
import { copyId, planFor, withCopied } from '@/lib/copy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Copy a leader's active plan.
 *  { handle }               save a copy in my plans (my safety limits and signed consent are untouched)
 *  { handle, auto: true }   save it, switch it on, and keep it in sync whenever the leader changes plan
 *  { stop: true }           stop auto-copy (the saved plan stays)
 */
export const POST = authed({ write: true, limit: [30, 60_000] }, async ({ req, session }) => {
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== 'object') return fail('bad request');
  const sb = db();
  if (b.stop) {
    must(await sb.from('art_settings').update({ follow_user_id: null, updated_at: new Date().toISOString() }).eq('user_id', session.userId), 'update');
    return json({ ok: true });
  }
  const handle = String(b.handle || '').toLowerCase();
  const lead = must(await sb.from('art_settings').select('user_id,plans,active_plan,handle,public_profile').eq('handle', handle).eq('public_profile', true).maybeSingle(), 'leader');
  if (!lead) return fail('That trader is not on the leaderboard.', 404);
  if (lead.user_id === session.userId) return fail('That is your own profile.');
  const copied = planFor(lead.user_id, lead.handle, lead);
  if (!copied) return fail('That trader has no plan to copy.');
  const mine = must(await sb.from('art_settings').select('plans,active_plan').eq('user_id', session.userId).single(), 'settings');
  const plans = withCopied(Array.isArray(mine.plans) ? mine.plans : [], copied);
  if (!plans) return fail('You have 10 plans already. Delete one first.');
  const patch: Record<string, unknown> = { plans, updated_at: new Date().toISOString() };
  if (b.auto) { patch.active_plan = copyId(lead.user_id); patch.follow_user_id = lead.user_id; }
  must(await sb.from('art_settings').update(patch).eq('user_id', session.userId), 'update');
  return json({ ok: true, plan: copied, auto: !!b.auto });
});
