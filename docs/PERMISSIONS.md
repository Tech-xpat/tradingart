# ART: what a wallet signs, and what it never does

## 1. Connecting a wallet
Connecting shares only your public address. It gives ART no power over your funds.
Supported: every Solana Wallet Standard wallet (auto-detected), Phantom, Solflare, Coinbase, Trust, Ledger, Coin98, Bitget, Torus, Android Mobile Wallet Adapter, and WalletConnect if `NEXT_PUBLIC_WC_PROJECT_ID` is set. EVM-only wallets cannot sign for Solana.

## 2. Sign-in (free, no fees)
You sign a plain-text message with your wallet (`signMessage`). It contains a one-time nonce and the domain. Wallets that cannot sign messages (some Ledger setups) sign an unsent, memo-only transaction instead. It is never broadcast and cannot move funds.

## 3. Trading consent (signed once, revocable)
You sign a message that states the limits: max SOL per trade, max daily loss %, max concurrent positions, and mode. The server and worker both re-verify it. Limits can only be tightened without a new signature.

## 4. Funding
Native SOL has no "approve" step. After one deposit approval the robot trades the vault balance without asking again. You send SOL from your wallet to your personal **vault address** shown in the dashboard. The robot can only trade what is in the vault. Your connected wallet's other funds are never touched.

## 5. Withdrawals
You sign "send X SOL to this address". The address is inside the signed text (your connected wallet by default, or any Solana address you paste), so nothing can change it after you sign. The worker re-verifies and pays. It refuses while live positions are open. Transfers cannot be reversed, so check the address.

## 6. What is not possible
- No token delegation or unlimited approvals on your main wallet.
- The web app can never read the vault key (it is sealed to the worker's key).
- Live trading is off unless both `LIVE_ENABLED` (web) and `LIVE_TRADING_ENABLED` (worker) are on, and you have a vault, a signed consent and at least 0.05 SOL.

## Honest caveat
The vault is custodial in practice: whoever runs the worker holds the opening key. Get legal advice (Nigeria SEC and elsewhere) and a security review before accepting real deposits. Nothing here promises profit.
