import { authed, json, fail } from '@/lib/api';
import { db, must } from '@/lib/db';
import { env, LIMITS, MIN_SIZE_USD, MODES, modeRank } from '@/lib/env';
import { solBalance } from '@/lib/chain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const num = (v: unknown) => (v === undefined ? undefined : Number(v));

/**
 * Change robot settings. Rules, enforced here AND again by the worker:
 *  - limits can only be tightened below what the user signed (a looser limit needs a new signature)
 *  - a harder mode than the signed one needs a new signature
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
  if (b.mode !== undefined) {
    if (!(MODES as readonly string[]).includes(b.mode)) return fail('bad mode');
    if (consent && modeRank(b.mode) > modeRank(consent.mode)) return fail('That mode is riskier than the one you signed. Sign a new consent to use it.');
    patch.mode = b.mode;
  }
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
  // trade size in USD: never below the minimum of the (new) mode. Spending is still capped by the signed max-per-trade in SOL.
  const mode = (patch.mode ?? cur.mode) as keyof typeof MIN_SIZE_USD;
  const minUsd = MIN_SIZE_USD[mode];
  if (b.sizeUsd !== undefined) {
    const v = Number(b.sizeUsd);
    if (!Number.isFinite(v) || v < minUsd || v > LIMITS.maxSizeUsd) return fail(`Trade size must be between $${minUsd} and $${LIMITS.maxSizeUsd} in ${mode} mode.`);
    patch.size_usd = Math.round(v * 100) / 100;
  } else if (patch.mode && cur.size_usd != null && Number(cur.size_usd) < minUsd) patch.size_usd = null;
  if (b.paused !== undefined) patch.paused = !!b.paused;

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
