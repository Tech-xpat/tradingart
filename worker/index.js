require('dotenv').config();
const config = require('./src/config');
const logger = require('./src/utils/logger');
const { connect, createDb } = require('./src/db/db');
const { unsealSecret } = require('./src/vault/seal');
const { Engine } = require('./src/engine');
const telegram = require('./src/telegram/bot');

console.log(`=== ART worker v${config.VERSION} ===`);
console.log(config.LIVE_TRADING_ENABLED ? 'LIVE trading ENABLED: users who chose live (and signed consent) trade real funds from their vaults' : 'LIVE trading DISABLED: every user is paper-trading');

async function main() {
  if (!config.VAULT_SEAL_SECRET) throw new Error('VAULT_SEAL_SECRET is required (npm run gen-seal-key)');
  const db = createDb(connect());
  const deps = {
    db,
    market: require('./src/analysis/dexscreener'),
    chain: require('./src/solana/chain'),
    swap: require('./src/trading/swap'),
    fills: require('./src/solana/fills'),
    scanner: require('./src/scanner/scanner'),
  };
  require('./src/scanner/stream').start();
  const engine = new Engine({ db, deps, unsealSecret: (sealed) => unsealSecret(sealed, config.VAULT_SEAL_SECRET) });
  const tg = telegram.start(engine);
  engine.send = tg.send; engine.adminNotify = tg.adminNotify;
  await engine.start();
  tg.adminNotify(`ART worker v${config.VERSION} started · live ${config.LIVE_TRADING_ENABLED ? 'ON' : 'off (paper only)'} · ${engine.accounts.size} active account(s)`);

  const stop = async (sig) => { logger.info(`${sig}: stopping`); require('./src/scanner/stream').stop(); await engine.stop(); if (tg.stop) tg.stop(); process.exit(0); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
process.on('unhandledRejection', (e) => logger.error('unhandledRejection:', (e && e.message) || e));
process.on('uncaughtException', (e) => logger.error('uncaughtException:', (e && e.message) || e));
main().catch((e) => { logger.error('fatal:', e.message || e); process.exit(1); });
