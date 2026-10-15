/**
 * Pure plan rules: defaults and sanitising. No imports, so the web app and the worker can share this
 * file byte for byte (a test enforces that).
 */
const DAY = 86400;
const STEADY = { name: 'Steady', sizeUsd: 7, minAgeSec: 10 * DAY, maxAgeSec: null, takeProfitPct: 60, stopLossPct: 30, maxHoldMin: 5, scanEverySec: 60, maxTradesDay: 15, minLiqUsd: 8000, minVol1hUsd: 1500, minBuys1h: 5, requireRising: true };
const SNIPER = { name: 'Sniper', sizeUsd: 7, minAgeSec: 30, maxAgeSec: 30 * 60, takeProfitPct: 50, stopLossPct: 25, maxHoldMin: 3, scanEverySec: 20, maxTradesDay: 20, minLiqUsd: 4000, minVol1hUsd: 500, minBuys1h: 5, requireRising: false };

const MAX_PLANS = 10;
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Make any input a safe plan. Out-of-range numbers are pulled into range, never trusted. */
function sanitizePlan(p = {}, base = STEADY) {
  const minAgeSec = clamp(Math.round(num(p.minAgeSec, base.minAgeSec)), 0, 3650 * DAY);
  let maxAgeSec = p.maxAgeSec === undefined ? base.maxAgeSec : p.maxAgeSec;
  maxAgeSec = maxAgeSec == null || maxAgeSec === '' ? null : clamp(Math.round(num(maxAgeSec, 0)), 0, 3650 * DAY);
  if (maxAgeSec !== null && maxAgeSec <= minAgeSec) maxAgeSec = null;
  return {
    id: String(p.id || '').slice(0, 40) || undefined,
    name: String(p.name == null ? base.name : p.name).trim().slice(0, 24) || base.name,
    sizeUsd: clamp(Math.round(num(p.sizeUsd, base.sizeUsd) * 100) / 100, 1, 1e6),
    minAgeSec, maxAgeSec,
    takeProfitPct: clamp(num(p.takeProfitPct, base.takeProfitPct), 1, 10000),
    stopLossPct: clamp(num(p.stopLossPct, base.stopLossPct), 1, 95),
    maxHoldMin: clamp(num(p.maxHoldMin, base.maxHoldMin), 0.5, 1440),
    scanEverySec: clamp(Math.round(num(p.scanEverySec, base.scanEverySec)), 10, 3600),
    maxTradesDay: clamp(Math.round(num(p.maxTradesDay, base.maxTradesDay)), 1, 500),
    minLiqUsd: clamp(num(p.minLiqUsd, base.minLiqUsd), 0, 1e9),
    minVol1hUsd: clamp(num(p.minVol1hUsd, base.minVol1hUsd), 0, 1e9),
    minBuys1h: clamp(Math.round(num(p.minBuys1h, base.minBuys1h)), 0, 1e6),
    requireRising: p.requireRising === undefined ? !!base.requireRising : !!p.requireRising,
  };
}

function defaultPlans() { return [{ id: 'steady', ...STEADY }, { id: 'sniper', ...SNIPER }]; }

module.exports = { sanitizePlan, defaultPlans, MAX_PLANS, STEADY, SNIPER };
