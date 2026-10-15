import { authed, json, fail } from '@/lib/api';
import { db, must } from '@/lib/db';
import { env, LIMITS } from '@/lib/env';
import { solBalance } from '@/lib/chain';
import { sanitizePlan, MAX_PLANS } from '@/lib/planrules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const num = (v: unknown) => (v === undefined ? undefined : Number(v));

/**
 * Change robot settings. Rules, enforced here AND again by the worker:
 *  - safety limits can only be tightened below what the user signed (a looser limit needs a new signature)
 *  - plans (entry/exit rules, trade size) are the user's own and need no signature: spending is still capped by the signed limits
 *  - LIVE needs: live switch on, a vault, a signed consent and a funded vault
 */
export const PATCH = authed({ write: true, limit: [40, 60_000] }, async ({ req, session }) => {
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== 'object') return fail('bad request');
  const sb = db();
  const cur = must(await sb.from('art_settings').select('*').eq('user_id', session.userId).single(), 'settings');
  const consentRow = must(await sb.from('art_consents').select('limits').eq('user_id', session.userId).is('revoked_at', null).order('created_at', { ascending: false }).limit(1), 'consent')[0];
  const consent = consentRow?.limits as { mode: string; maxPositionSol: number; maxDailyLossPct: number; maxConcurrent: number } | undefined;

  const patch: Record<string, unknown> = {};
  const lim = (key: string, col: string, r: { min: number; max: number }, signed?: number) => {
    const v = num(b[key]); if (v === undefined) return null;
    if (!Number.isFinite(v) || v < r.min || v > r.max) return `${key} out of range`;
    if (signed !== undefined && v > signed) return `${key} is higher than the limit you signed. Sign a new consent to raise it.`;
    patch[col] = v; return null;
  };
  const err = lim('maxPositionSol', 'max_position_sol', LIMITS.maxPositionSol, consent?.maxPositionSol)
    || lim('maxDailyLossPct', 'max_daily_loss_pct', LIMITS.maxDailyLossPct, consent?.maxDailyLossPct)
    || lim('maxConcurrent', 'max_concurrent', LIMITS.maxConcurrent, consent?.maxConcurrent);
  if (err) return fail(err);
  if (b.paused !== undefined) patch.paused = !!b.paused;

  // plans: the whole list is replaced; every plan is sanitised; ids are kept or minted
  if (b.plans !== undefined) {
    if (!Array.isArray(b.plans) || b.plans.length < 1 || b.plans.length > MAX_PLANS) return fail(`Keep between 1 and ${MAX_PLANS} plans.`);
    const seen = new Set<string>();
    const plans = b.plans.map((p: any, i: number) => {
      const clean = sanitizePlan(p && typeof p === 'object' ? p : {});
      let id = String(clean.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || `p${Date.now().toString(36)}${i}`;
      while (seen.has(id)) id = `${id}x`;
      seen.add(id);
      return { ...clean, id };
    });
    patch.plans = plans;
    const wanted = String(b.activePlan ?? cur.active_plan ?? '');
    patch.active_plan = plans.some((p: any) => p.id === wanted) ? wanted : plans[0].id;
  } else if (b.activePlan !== undefined) {
    const list = Array.isArray(cur.plans) ? cur.plans : [];
    if (!list.some((p: any) => p.id === b.activePlan)) return fail('unknown plan');
    patch.active_plan = String(b.activePlan);
  }

  if (b.live !== undefined) {
    if (b.live) {
      if (!env.liveEnabled) return fail('Live trading is not open yet. Paper mode only.');
      if (!consent) return fail('Sign your trading consent first.');
      const vault = must(await sb.from('art_vaults').select('address').eq('user_id', session.userId).maybeSingle(), 'vault');
      if (!vault) return fail('Create your vault first.');
      const bal = await solBalance(vault.address);
      if (bal === null) return fail('Could not read the vault balance. Try again.');
      if (bal < LIMITS.minVaultSolForLive) return fail(`Fund the vault with at least ${LIMITS.minVaultSolForLive} SOL first.`);
    }
    patch.live = !!b.live;
  }
  if (!Object.keys(patch).length) return fail('nothing to change');
  patch.updated_at = new Date().toISOString();
  must(await sb.from('art_settings').update(patch).eq('user_id', session.userId), 'update');
  return json({ ok: true, settings: { ...cur, ...patch } });
});
