/**
 * Trading plans. A plan is a named set of entry/exit rules the user builds and switches between.
 * The user's safety limits (max SOL per trade, daily loss, concurrent trades) are separate: they live in
 * the settings row, are signed in the consent, and can only be tightened without a new signature.
 */
const config = require('./config');

const { sanitizePlan, defaultPlans, MAX_PLANS, STEADY, SNIPER } = require('./planrules');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The plan the user has switched on (falls back to the first, then to Steady). */
function activePlan(settings) {
  const list = Array.isArray(settings.plans) && settings.plans.length ? settings.plans : defaultPlans();
  const found = list.find((p) => p && p.id === settings.active_plan) || list[0];
  return sanitizePlan(found, STEADY);
}

/**
 * settings = row of art_settings; consent = limits the user signed ({maxPositionSol,maxDailyLossPct,maxConcurrent}) or null.
 * Safety limits: min(user setting, signed consent, platform cap). A user can only tighten, never loosen.
 * A platform cap of 0 means "no platform cap" (the signed limit still applies).
 */
function effectivePlan(settings, consent) {
  const plan = activePlan(settings);
  const lim = (userV, consentV, cap, fb) => {
    const vals = [Number(userV), consent ? Number(consentV) : Infinity, cap > 0 ? cap : Infinity].filter((v) => Number.isFinite(v) && v > 0);
    return vals.length ? Math.min(...vals) : fb;
  };
  const capSize = config.CAP_MAX_SIZE_USD > 0 ? config.CAP_MAX_SIZE_USD : Infinity;
  return {
    ...plan,
    riskProfile: plan.name,
    sizeUsd: Math.min(plan.sizeUsd, capSize),
    maxPositionSol: Math.max(0.001, lim(settings.max_position_sol, consent && consent.maxPositionSol, config.CAP_MAX_POSITION_SOL, 0.05)),
    maxDailyLossPct: clamp(lim(settings.max_daily_loss_pct, consent && consent.maxDailyLossPct, config.CAP_MAX_DAILY_LOSS_PCT, 20), 1, config.CAP_MAX_DAILY_LOSS_PCT || 100),
    maxConcurrent: Math.max(1, Math.floor(lim(settings.max_concurrent, consent && consent.maxConcurrent, config.CAP_MAX_CONCURRENT, 1))),
  };
}

module.exports = { effectivePlan, activePlan, sanitizePlan, defaultPlans, MAX_PLANS, STEADY, SNIPER };
