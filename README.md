# ART: African Robot Trader

- `web/`: Next.js 14 app (landing at `/`, wallet dashboard at `/app`, API routes).
- `worker/`: multi-user trading worker (De-Government strategy, per-user paper/live books, Telegram, withdrawals).
- `supabase_art.sql`: schema (all `art_*` tables, RLS on, service-role only).
- `docs/PERMISSIONS.md`: what wallets sign and approve.
- `docs/DEPLOY.md`: step-by-step production deployment, including the WalletConnect project ID.

## Setup
1. Run `supabase_art.sql` in the Supabase SQL editor.
2. Worker: `cd worker && npm i && npm run gen-seal-key`. Put the secret in the worker's `VAULT_SEAL_SECRET` only; the public key goes to the web app as `VAULT_SEAL_PUBLIC`.
3. Copy `worker/.env.example` to `.env` and fill it in (Supabase, RPC, Telegram token). Keep `LIVE_TRADING_ENABLED=false`. Deploy (Railway config included).
4. Web: copy `web/.env.example` to `.env.local`, fill in Supabase, `SESSION_SECRET`, `VAULT_SEAL_PUBLIC`, domain, RPC. Keep `LIVE_ENABLED=false`. `npm i && npm run build && npm start`.
5. Telegram: users press "Link Telegram" in the dashboard, then send `/link CODE` to the bot.
6. Test on paper first. Going live needs both switches plus the checks in the permissions doc.

## Tests
- Worker: `cd worker && npm test`
- Web: `cd web && npx tsx --test test/*.test.ts && npx tsc --noEmit && npx next build`
- End to end: `cd web && npx tsx --test e2e/e2e.test.ts`

## Notes
- `web/lib/{seal,verify,messages}.js` and `worker/src/vault/` copies must stay byte-identical (a test enforces it).
- The rate limiter is in memory (single instance). Use a shared store if you scale out.
- Rotating `SESSION_SECRET` logs everyone out. Losing `VAULT_SEAL_SECRET` makes every vault unrecoverable, so back it up.
- Not ported yet: `/review` and `/advice` self-learning (trade features are already saved in `art_trades.features`).
