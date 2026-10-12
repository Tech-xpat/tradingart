import { LIMITS, MODES, Mode } from './env';

export type Limits = { mode: Mode; maxPositionSol: number; maxDailyLossPct: number; maxConcurrent: number };

const inRange = (v: number, r: { min: number; max: number }) => Number.isFinite(v) && v >= r.min && v <= r.max;
/** Round the way the message prints them, so signed text and stored numbers can never disagree. */
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function parseLimits(src: Record<string, unknown>): Limits | null {
  const mode = String(src.mode);
  const maxPositionSol = r6(Number(src.maxPositionSol)), maxDailyLossPct = Math.round(Number(src.maxDailyLossPct) * 100) / 100, maxConcurrent = Number(src.maxConcurrent);
  if (!(MODES as readonly string[]).includes(mode)) return null;
  if (!inRange(maxPositionSol, LIMITS.maxPositionSol) || !inRange(maxDailyLossPct, LIMITS.maxDailyLossPct)) return null;
  if (!Number.isInteger(maxConcurrent) || !inRange(maxConcurrent, LIMITS.maxConcurrent)) return null;
  return { mode: mode as Mode, maxPositionSol, maxDailyLossPct, maxConcurrent };
}
