/** Server-side env, read lazily so `next build` works without secrets. */
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}
export const env = {
  get supabaseUrl() { return need('SUPABASE_URL'); },
  get supabaseKey() { return need('SUPABASE_SERVICE_KEY'); },
  get sessionSecret() { const s = need('SESSION_SECRET'); if (s.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters'); return s; },
  get sealPublic() { return need('VAULT_SEAL_PUBLIC'); },
  get domain() { return process.env.NEXT_PUBLIC_APP_DOMAIN || 'localhost:3000'; },
  get rpcUrl() { return process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'; },
  get liveEnabled() { return process.env.LIVE_ENABLED === 'true'; },
  get isProd() { return process.env.NODE_ENV === 'production'; },
};

export const LIMITS = {
  maxPositionSol: { min: 0.005, max: 0.25 },
  maxDailyLossPct: { min: 1, max: 50 },
  maxConcurrent: { min: 1, max: 3 },
  minVaultSolForLive: 0.05,
  maxSizeUsd: 100,
  minSizeUsd: { easy: 5, medium: 10, hard: 20 },
};
// Minimum trade size per mode, in USD. The user may raise it up to maxSizeUsd. The worker enforces the same numbers (CAP_MAX_SIZE_USD).
export const MIN_SIZE_USD = { easy: 5, medium: 10, hard: 20 } as const;
export const MODES = ['easy', 'medium', 'hard'] as const;
export type Mode = (typeof MODES)[number];
export const modeRank = (m: string) => MODES.indexOf(m as Mode);
