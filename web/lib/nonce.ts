import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { env } from './env';

/**
 * Stateless one-time-ish nonces: random . expiry . HMAC(purpose, wallet, random, expiry).
 * They bind a signature request to ONE wallet and ONE purpose (sign-in / consent / withdraw) and expire fast.
 * Replay inside the window is blocked where it matters by unique indexes on the stored signed message.
 */
export type Purpose = 'signin' | 'consent' | 'withdraw';
const mac = (purpose: Purpose, wallet: string, rnd: string, exp: number) =>
  createHmac('sha256', env.sessionSecret).update(`${purpose}|${wallet}|${rnd}|${exp}`).digest('base64url').slice(0, 32);

export function makeNonce(purpose: Purpose, wallet: string, ttlMs = 10 * 60 * 1000) {
  const rnd = randomBytes(12).toString('base64url');
  const exp = Date.now() + ttlMs;
  return { nonce: `${rnd}.${exp}.${mac(purpose, wallet, rnd, exp)}`, expiresAt: new Date(exp).toISOString() };
}
export function checkNonce(purpose: Purpose, wallet: string, nonce: string): boolean {
  const [rnd, expS, tag] = String(nonce || '').split('.');
  const exp = Number(expS);
  if (!rnd || !tag || !Number.isFinite(exp) || exp < Date.now()) return false;
  const want = mac(purpose, wallet, rnd, exp);
  const a = Buffer.from(tag), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
