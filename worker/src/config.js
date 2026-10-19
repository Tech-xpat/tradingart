require('dotenv').config();

const num = (name, fb) => {
  const v = process.env[name];
  if (v == null || v === '') return fb;
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};
const bool = (name, fb) => {
  const v = process.env[name];
  if (v == null || v === '') return fb;
  return !/^(false|0|no|off)$/i.test(String(v).trim());
};
const list = (name) =>
  String(process.env[name] || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const DEFAULT_RPC_URLS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
];
const rpcFromEnv = list('RPC_URLS').concat(list('RPC_URL'));

module.exports = {
  VERSION: '4.5.0-force-live',

  SUPABASE_URL: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',
  VAULT_SEAL_SECRET: process.env.VAULT_SEAL_SECRET || '',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || null,
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID || null,

  LIVE_TRADING_ENABLED: true,

  RPC_URLS: rpcFromEnv.length ? rpcFromEnv : DEFAULT_RPC_URLS,
  PUMPPORTAL_TRADE_URL:
    process.env.PUMPPORTAL_TRADE_URL || 'https://pumpportal.fun/api/trade-local',
  SOL_MINT: 'So11111111111111111111111111111111111111112',

  // ALL CAPS RELAXED
  CAP_MAX_POSITION_SOL: num('CAP_MAX_POSITION_SOL', 0),
  CAP_MAX_SIZE_USD: num('CAP_MAX_SIZE_USD', 0),
  CAP_MAX_DAILY_LOSS_PCT: num('CAP_MAX_DAILY_LOSS_PCT', 100),
  CAP_MAX_CONCURRENT: num('CAP_MAX_CONCURRENT', 20),

  MIN_VAULT_SOL: num('MIN_VAULT_SOL', 0.005),      // almost zero
  MIN_POSITION_SOL: num('MIN_POSITION_SOL', 0.005), // almost zero
  SOL_FEE_RESERVE: num('SOL_FEE_RESERVE', 0.008),

  // aggressive execution
  BUY_SLIPPAGE_PCT: num('BUY_SLIPPAGE_PCT', 45),
  BUY_SLIPPAGE_STEP_PCT: num('BUY_SLIPPAGE_STEP_PCT', 15),
  BUY_SLIPPAGE_MAX_PCT: num('BUY_SLIPPAGE_MAX_PCT', 90),
  BUY_ATTEMPTS: num('BUY_ATTEMPTS', 5),
  BUY_PRIORITY_FEE_SOL: num('BUY_PRIORITY_FEE_SOL', 0.008),
  SELL_SLIPPAGE_PCT: num('SELL_SLIPPAGE_PCT', 50),
  SELL_SLIPPAGE_STEP_PCT: num('SELL_SLIPPAGE_STEP_PCT', 15),
  SELL_SLIPPAGE_MAX_PCT: num('SELL_SLIPPAGE_MAX_PCT', 95),
  SELL_PRIORITY_FEE_SOL: num('SELL_PRIORITY_FEE_SOL', 0.001),
  SELL_RETRIES: num('SELL_RETRIES', 8),
  STUCK_RETRY_MS: num('STUCK_RETRY_MS', 45000),
  BUY_CONFIRM_TIMEOUT_MS: num('BUY_CONFIRM_TIMEOUT_MS', 35000),
  SELL_CONFIRM_TIMEOUT_MS: num('SELL_CONFIRM_TIMEOUT_MS', 25000),
  REBROADCAST_MS: num('REBROADCAST_MS', 400),

  // ALL SAFETY OFF
  MIN_LIQUIDITY_USD: num('MIN_LIQUIDITY_USD', 0),
  REQUIRE_NO_AUTHORITIES: bool('REQUIRE_NO_AUTHORITIES', false),
  EXIT_COST_PCT: num('EXIT_COST_PCT', 2),
  IGNORE_MINTS: list('IGNORE_MINTS'),

  PAPER_BALANCE_SOL: 0,
  PAPER_FRICTION_PCT: 0,

  MAX_POOL_SHARE_PCT: num('MAX_POOL_SHARE_PCT', 100), // allow anything
  STREAM_ENABLED: bool('STREAM_ENABLED', true),
  STREAM_URL: process.env.STREAM_URL || 'wss://pumpportal.fun/api/data',

  PRICE_POLL_MS: num('PRICE_POLL_MS', 6000),
  SYNC_MS: num('SYNC_MS', 15000),
  WITHDRAW_POLL_MS: num('WITHDRAW_POLL_MS', 4000),
};
