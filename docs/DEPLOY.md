# ART: deploying to production

Two things run: the **web app** (Next.js, on Vercel) and the **worker** (the robot, on Railway or any always-on host). Both talk to one **Supabase** project. Do the steps in this order.

## 0. Accounts you need
- GitHub (to hold the code), Supabase, Vercel, Railway (or a VPS), a Telegram bot from @BotFather, a paid Solana RPC (Helius, QuickNode, Triton or similar), and a domain name.
- Optional: a free Reown (WalletConnect) account for the project ID.

## 1. Database (Supabase)
1. Create a project. Open SQL Editor and run `supabase_art.sql`. Upgrading an existing database: also run `alter table public.art_settings add column if not exists size_usd double precision;`.
2. Settings > API: copy the project URL and the **service_role** key. Only the web server and the worker ever use it. Never put it in browser code.
3. Turn on daily backups (paid plan) because the vault keys live in this database.

## 2. Keys
In `worker/`: `npm i && npm run gen-seal-key`.
- Secret half -> worker only, as `VAULT_SEAL_SECRET`. Store a copy in a password manager. If it is lost, every vault is unrecoverable.
- Public half -> web app, as `VAULT_SEAL_PUBLIC`.
- `SESSION_SECRET` for the web app: `openssl rand -base64 48`.

## 3. Telegram bot
Message @BotFather, `/newbot`, copy the token (`TELEGRAM_BOT_TOKEN`). Your own chat id (message @userinfobot) is `ADMIN_CHAT_ID`. The username without @ is `NEXT_PUBLIC_TG_BOT` for the web app.

## 4. Worker (Railway)
1. New project from the GitHub repo, root directory `worker`. `railway.json` is included.
2. Variables: everything in `worker/.env.example`. Keep `LIVE_TRADING_ENABLED=false` for now. Put the paid RPC first in `RPC_URLS`.
3. Run **one** worker instance only. Two would double-trade.
4. Check the logs show the engine started and Telegram is polling.

## 5. Web app (Vercel)
1. Import the repo, root directory `web`.
2. Variables: everything in `web/.env.example`. `NEXT_PUBLIC_APP_DOMAIN` is your final domain without `https://`. Set `NEXT_PUBLIC_*` values before the first build, because they are baked in at build time.
3. Add your domain in Vercel and point DNS at it. HTTPS is automatic.
4. The rate limiter is in memory. For more than one server instance, replace it with a shared store (Upstash Redis).

## 6. WalletConnect project ID (optional, 5 minutes)
Phantom, Solflare, Backpack, Coinbase, Ledger and Android wallets already work without it. The project ID adds WalletConnect, which lets Trust Wallet, Exodus, Rainbow and 300+ mobile wallets connect by QR or deep link.
1. Go to cloud.reown.com (formerly WalletConnect Cloud), sign up, create a project of type "App".
2. Copy the **Project ID**.
3. Add allowed domain: your site's domain.
4. In Vercel set `NEXT_PUBLIC_WC_PROJECT_ID` to it and redeploy.

## 7. Test on paper, with real data (1-2 weeks)
Everyone is on paper while both live switches are off. Paper uses real market data and the real strategy rules, with simulated fills (2% friction). Compare results with your Telegram bot's history. Fix anything odd before real money.

## 8. Before turning live on
- Run the web tests and end-to-end tests (README), and do a **real-wallet test on devnet or with 0.05 SOL**: connect, sign in, create vault, deposit, start, stop and sell all, withdraw to your wallet and to a second address.
- Get a lawyer's view for Nigeria and for every country your users are in. Holding and trading user funds can count as custody or a regulated activity.
- Have someone independent review the worker code that signs and the withdrawal path.
- Add terms of use, a risk notice and a privacy policy page.
- Set platform caps low at first: `CAP_MAX_POSITION_SOL`, `CAP_MAX_SIZE_USD`, `CAP_MAX_CONCURRENT`.
- Set up alerts: uptime monitor on the site, error alerts from Railway, and Telegram admin alerts (`ADMIN_CHAT_ID`).
- Invite a small group (5-10 people) with small deposits first.

## 9. Going live
Set `LIVE_TRADING_ENABLED=true` on the worker and `LIVE_ENABLED=true` on the web app, redeploy both. Each user then also needs a vault, signed limits, and at least 0.05 SOL in the vault before the Live switch works.

## Ongoing
- Watch RPC cost and limits as users grow. Public RPCs will not carry many users.
- Keep `VAULT_SEAL_SECRET` backups and Supabase backups. Rotate `SESSION_SECRET` only when needed (it signs everyone out).
- Update dependencies monthly and re-run all tests.
