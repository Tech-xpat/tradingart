require('dotenv').config();

const num = (name, fb) => { const v = process.env[name]; if (v == null || v === '') return fb; const n = Number(v); return Number.isFinite(n) ? n : fb; };
const bool = (name, fb) => { const v = process.env[name]; if (v == null || v === '') return fb; return !/^(false|0|no|off)$/i.test(String(v).trim()); };
const list = (name) => String(process.env[name] || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

const DEFAULT_RPC_URLS = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];
const rpcFromEnv = list('RPC_URLS').concat(list('RPC_URL'));

module.exports = {
  VERSION: '4.0.0',

  SUPABASE_URL: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',
  VAULT_SEAL_SECRET: process.env.VAULT_SEAL_SECRET || '',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || null,
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID || null,

  // SAFE DEFAULT: live trading is off unless this is explicitly true.
  LIVE_TRADING_ENABLED: bool('LIVE_TRADING_ENABLED', false),

  RPC_URLS: rpcFromEnv.length ? rpcFromEnv : DEFAULT_RPC_URLS,
  PUMPPORTAL_TRADE_URL: process.env.PUMPPORTAL_TRADE_URL || 'https://pumpportal.fun/api/trade-local',
  SOL_MINT: 'So11111111111111111111111111111111111111112',

  // platform hard caps
  CAP_MAX_POSITION_SOL: num('CAP_MAX_POSITION_SOL', 0.25),
  CAP_MAX_SIZE_USD: num('CAP_MAX_SIZE_USD', 100),
  CAP_MAX_DAILY_LOSS_PCT: num('CAP_MAX_DAILY_LOSS_PCT', 50),
  CAP_MAX_CONCURRENT: num('CAP_MAX_CONCURRENT', 3),
  MIN_VAULT_SOL: num('MIN_VAULT_SOL', 0.05),
  MIN_POSITION_SOL: num('MIN_POSITION_SOL', 0.01),
  SOL_FEE_RESERVE: num('SOL_FEE_RESERVE', 0.03),

  // execution (same behaviour as the single-user bot)
  BUY_SLIPPAGE_PCT: num('BUY_SLIPPAGE_PCT', 15),
  BUY_PRIORITY_FEE_SOL: num('BUY_PRIORITY_FEE_SOL', 0.0003),
  SELL_SLIPPAGE_PCT: num('SELL_SLIPPAGE_PCT', 30),
  SELL_SLIPPAGE_STEP_PCT: num('SELL_SLIPPAGE_STEP_PCT', 10),
  SELL_SLIPPAGE_MAX_PCT: num('SELL_SLIPPAGE_MAX_PCT', 55),
  SELL_PRIORITY_FEE_SOL: num('SELL_PRIORITY_FEE_SOL', 0.0003),
  SELL_RETRIES: num('SELL_RETRIES', 6),
  STUCK_RETRY_MS: num('STUCK_RETRY_MS', 60000),
  BUY_CONFIRM_TIMEOUT_MS: num('BUY_CONFIRM_TIMEOUT_MS', 20000),
  SELL_CONFIRM_TIMEOUT_MS: num('SELL_CONFIRM_TIMEOUT_MS', 15000),
  REBROADCAST_MS: num('REBROADCAST_MS', 1000),

  // entry safety
  MIN_LIQUIDITY_USD: num('MIN_LIQUIDITY_USD', 3000),
  REQUIRE_NO_AUTHORITIES: bool('REQUIRE_NO_AUTHORITIES', true),
  EXIT_COST_PCT: num('EXIT_COST_PCT', 2),
  IGNORE_MINTS: list('IGNORE_MINTS'),

  // paper
  SCAN_RELAXED: bool('SCAN_RELAXED', false),
  PAPER_BALANCE_SOL: num('PAPER_BALANCE_SOL', 1),
  PAPER_FRICTION_PCT: num('PAPER_FRICTION_PCT', 2),

  // loops
  PRICE_POLL_MS: num('PRICE_POLL_MS', 8000),
  SYNC_MS: num('SYNC_MS', 20000),
  WITHDRAW_POLL_MS: num('WITHDRAW_POLL_MS', 5000),
};
