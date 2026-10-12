/** The three modes (same numbers as the original bot) and how a user's own limits tighten them. */
const config = require('./config');

const PRESETS = {
  easy:   { name: 'Easy',   sizeUsd: 5, takeProfitPct: 30,  stopLossPct: 20, maxHoldMin: 2, scanIntervalMin: 5,  maxTradesDay: 7,  maxPositionSol: 0.1 },
  medium: { name: 'Medium', sizeUsd: 10, takeProfitPct: 60,  stopLossPct: 30, maxHoldMin: 5, scanIntervalMin: 10, maxTradesDay: 15, maxPositionSol: 0.15 },
  hard:   { name: 'Hard',   sizeUsd: 20, takeProfitPct: 100, stopLossPct: 45, maxHoldMin: 8, scanIntervalMin: 30, maxTradesDay: 20, maxPositionSol: 0.25 },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * settings = row of art_settings; consent = limits the user signed ({maxPositionSol,maxDailyLossPct,maxConcurrent}) or null.
 * Effective limit = min(mode preset, user setting, signed consent, platform cap). A user can only tighten, never loosen.
 */
function effectivePlan(settings, consent) {
  const mode = PRESETS[settings.mode] ? settings.mode : 'medium';
  const p = PRESETS[mode];
  const lim = (userV, consentV, cap, fb) => {
    const vals = [Number(userV), consent ? Number(consentV) : Infinity, cap].filter((v) => Number.isFinite(v) && v > 0);
    return vals.length ? Math.min(...vals) : fb;
  };
  return {
    riskProfile: mode,
    // each mode has a minimum trade size in USD; the user can raise it (never below the mode's minimum).
    // Spending is still capped by maxPositionSol below, which is what the user signed.
    sizeUsd: clamp(Number(settings.size_usd) || p.sizeUsd, p.sizeUsd, config.CAP_MAX_SIZE_USD), takeProfitPct: p.takeProfitPct, stopLossPct: p.stopLossPct, maxHoldMin: p.maxHoldMin,
    scanIntervalMin: p.scanIntervalMin, maxTradesDay: p.maxTradesDay,
    maxPositionSol: clamp(lim(settings.max_position_sol, consent && consent.maxPositionSol, Math.min(p.maxPositionSol, config.CAP_MAX_POSITION_SOL), 0.05), 0.001, config.CAP_MAX_POSITION_SOL),
    maxDailyLossPct: clamp(lim(settings.max_daily_loss_pct, consent && consent.maxDailyLossPct, config.CAP_MAX_DAILY_LOSS_PCT, 20), 1, config.CAP_MAX_DAILY_LOSS_PCT),
    maxConcurrent: Math.max(1, Math.floor(lim(settings.max_concurrent, consent && consent.maxConcurrent, config.CAP_MAX_CONCURRENT, 1))),
  };
}

module.exports = { PRESETS, effectivePlan };
