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
  get domain() { return String(process.env.NEXT_PUBLIC_APP_DOMAIN || 'localhost:3000').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); },
  get rpcUrl() { return process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'; },
  get liveEnabled() { return process.env.LIVE_ENABLED === 'true'; },
  get isProd() { return process.env.NODE_ENV === 'production'; },
};

export const LIMITS = {
  // Safety limits the user signs. Trade SIZE in USD is a plan setting with no maximum (the signed max per trade in SOL still caps spending).
  maxPositionSol: { min: 0.005, max: 1000 },
  maxDailyLossPct: { min: 1, max: 50 },
  maxConcurrent: { min: 1, max: 10 },
  minVaultSolForLive: 0.02,
  minSizeUsd: 1,
  defaultSizeUsd: 7,
};
// 'custom' is what new consents carry now (trading rules live in plans). The old three names stay valid for consents signed earlier.
export const MODES = ['custom', 'easy', 'medium', 'hard'] as const;
export type Mode = (typeof MODES)[number];
