import type { SupabaseClient } from '@supabase/supabase-js';
import { sanitizePlan, MAX_PLANS } from '@/lib/planrules';

/** The id of the plan a follower holds for a given leader. Stable, so re-copying replaces instead of piling up. */
export const copyId = (leaderId: string) => `cp-${leaderId.replace(/-/g, '').slice(0, 10)}`;

export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

/** A leader's currently switched-on plan, turned into a plan the follower can hold. */
export function planFor(leaderId: string, handle: string, leaderSettings: any) {
  const list: any[] = Array.isArray(leaderSettings?.plans) ? leaderSettings.plans : [];
  const src = list.find((p) => p.id === leaderSettings?.active_plan) || list[0];
  if (!src) return null;
  const clean = sanitizePlan(src);
  return { ...clean, id: copyId(leaderId), name: `@${handle}`.slice(0, 24) };
}

/** Put (or refresh) the copied plan in a follower's plan list. Returns null when the list is full. */
export function withCopied(plans: any[], copied: any) {
  const i = plans.findIndex((p) => p.id === copied.id);
  if (i >= 0) return plans.map((p, j) => (j === i ? copied : p));
  if (plans.length >= MAX_PLANS) return null;
  return [...plans, copied];
}

/** After a leader changes plans / active plan, refresh every follower's copy. */
export async function propagate(sb: SupabaseClient, leaderId: string) {
  const { data: lead } = await sb.from('art_settings').select('plans,active_plan,handle,public_profile').eq('user_id', leaderId).single();
  if (!lead || !lead.public_profile || !lead.handle) return 0;
  const copied = planFor(leaderId, lead.handle, lead);
  if (!copied) return 0;
  const { data: fol } = await sb.from('art_settings').select('user_id,plans').eq('follow_user_id', leaderId);
  let n = 0;
  for (const f of fol || []) {
    const next = withCopied(Array.isArray(f.plans) ? f.plans : [], copied);
    if (!next) continue;
    await sb.from('art_settings').update({ plans: next, updated_at: new Date().toISOString() }).eq('user_id', f.user_id);
    n += 1;
  }
  return n;
}
