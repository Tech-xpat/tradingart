# Start small and cheap: GitHub + Vercel + Supabase + one always-on server

Goal: a few users, paper mode first, free RPCs. Everything below can be done from a phone browser, or from Termux for the git steps.

## What costs what (check current prices, they change)
| Part | Where | Cost to start |
|---|---|---|
| Database | Supabase free plan | free |
| Website (`web/`) | Vercel (or Netlify / Cloudflare Pages) | free tier. Vercel's free Hobby plan is meant for non-commercial use, so move to a paid plan once ART earns money |
| Robot (`worker/`) | Railway, a small VPS, Fly.io | not free. It must run 24/7, so expect about $5 a month. Free hosts that sleep (like Render free web services) will stop the robot |
| RPC | Helius / QuickNode / Alchemy free plan + the public Solana RPC as backup | free to start |
| Telegram bot | BotFather | free |
| WalletConnect ID | cloud.reown.com | free |

## Free RPC setup
- Make a free account at Helius (or QuickNode / Alchemy) and create a mainnet API key.
- Worker (`RPC_URLS`, comma separated, first one is used first): `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY,https://api.mainnet-beta.solana.com`
- Web `SOLANA_RPC_URL` (server side, keeps the key private): the same Helius URL.
- Web `NEXT_PUBLIC_SOLANA_RPC_URL` (this one is visible in the browser, so never put a private key there): `https://api.mainnet-beta.solana.com`
- Free plans have request limits. Paper mode with a few users is fine. When you go live or add users, watch the usage page and upgrade the plan. Late or failed transactions are the most expensive problem in live trading, and the free public RPC is the weakest at landing them.

## Step 1. Put the code on GitHub
1. On github.com create a **private** repository named `art` (no README).
2. Unzip `ART.zip`. On Termux:
   ```
   pkg install git unzip
   unzip ART.zip && cd art
   git init && git add . && git commit -m "ART first version"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/art.git
   git push -u origin main
   ```
   Git asks for your username and a **personal access token** (GitHub > Settings > Developer settings > Personal access tokens, repo scope) as the password.
3. Check that `.env` files are NOT in the repo (only `.env.example`). Never commit secrets.

## Step 2. Database
Supabase > New project > SQL Editor > paste `supabase_art.sql` > Run. Then Settings > API: copy the Project URL and the `service_role` key.

## Step 3. Make the keys
On any computer or Termux with Node 20: `cd worker && npm i && npm run gen-seal-key`. Save the secret in a password manager. Make `SESSION_SECRET` with `openssl rand -base64 48`.

## Step 4. Telegram bot
@BotFather > `/newbot` > copy the token. Message @userinfobot to get your chat id.

## Step 5. Deploy the worker (Railway)
1. railway.app > New Project > Deploy from GitHub > pick `art`.
2. Service Settings > Root Directory: `worker`.
3. Variables: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `VAULT_SEAL_SECRET`, `TELEGRAM_BOT_TOKEN`, `ADMIN_CHAT_ID`, `RPC_URLS`, `LIVE_TRADING_ENABLED=false`.
4. Deploy. Logs should show the engine and Telegram started. Keep exactly one instance.

## Step 4b. Deploy the website (Vercel)
1. vercel.com > Add New > Project > import `art`. Root Directory: `web`.
2. Environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SESSION_SECRET`, `VAULT_SEAL_PUBLIC`, `NEXT_PUBLIC_APP_DOMAIN` (your domain without https, for example `art-yourname.vercel.app` first), `SOLANA_RPC_URL`, `NEXT_PUBLIC_SOLANA_RPC_URL`, `NEXT_PUBLIC_TG_BOT`, `LIVE_ENABLED=false`, and `NEXT_PUBLIC_WC_PROJECT_ID` if you have one.
3. Deploy. If you change the domain later, update `NEXT_PUBLIC_APP_DOMAIN` and redeploy (it is built in).
4. Add your own domain under Settings > Domains if you have one.

## Step 6. Smoke test (paper mode)
1. Open the site, connect your wallet, sign in, create the vault, sign limits, press Start.
2. Watch Railway logs and the Activity feed. In Telegram link the account with the code.
3. Leave it for 1 to 2 weeks and compare with your old bot.

## Step 7. A first real-money test (only after the legal and code review in DEPLOY.md)
Set `LIVE_TRADING_ENABLED=true` on Railway and `LIVE_ENABLED=true` on Vercel, redeploy both. Deposit about 0.05 to 0.1 SOL from your own wallet, start, stop and sell all, withdraw to your wallet, then to a second address. Only then invite a few people with small deposits.

## If something fails
- Sign-in says forbidden: `NEXT_PUBLIC_APP_DOMAIN` does not match the address in the browser. Fix it and redeploy.
- Vault creation fails: `VAULT_SEAL_PUBLIC` missing or wrong.
- Robot never trades: check Railway logs, `RPC_URLS`, and that the user pressed Start and signed limits.
- Rate limit errors in logs: the free RPC is full. Add another free key to `RPC_URLS` or upgrade.
