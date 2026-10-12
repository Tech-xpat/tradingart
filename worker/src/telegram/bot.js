/** Telegram: each user links their chat to their wallet account with a one-time code from the dashboard. */
const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../utils/logger');
const { PRESETS } = require('../plans');

function start(engine) {
  if (!config.TELEGRAM_BOT_TOKEN) { logger.warn('TELEGRAM_BOT_TOKEN missing: no Telegram'); return { send() {}, adminNotify() {} }; }
  const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
  const send = (chatId, text) => bot.sendMessage(chatId, text, { disable_web_page_preview: true }).catch((e) => logger.warn('telegram send:', e.message));
  const adminNotify = (text) => { if (config.ADMIN_CHAT_ID) send(config.ADMIN_CHAT_ID, text); };
  const reply = (msg, text) => send(msg.chat.id, text);
  const db = engine.db;

  const menu = '/status · /report · /pause · /resume · /mode easy|medium|hard · /sellall · /unlink';

  bot.onText(/^\/(start|help)/, (m) => reply(m, `ART · African Robot Trader\n\nLink your account: open the ART dashboard, press "Link Telegram", then send:\n/link YOURCODE\n\nAfter linking: ${menu}`));

  bot.onText(/^\/link\s+(\S+)/, async (m, x) => {
    try {
      const uid = await db.linkChat(String(x[1]).toUpperCase(), m.chat.id, m.from && m.from.username);
      reply(m, uid ? `✅ Linked. ${menu}` : '❌ That code is wrong or expired. Make a new one in the dashboard.');
    } catch (e) { reply(m, `Could not link: ${e.message}`); }
  });

  // everything below needs a linked account
  async function withUser(msg, fn) {
    try {
      const user = await db.userByChat(msg.chat.id);
      if (!user) return reply(msg, 'This chat is not linked yet. Open the ART dashboard, press "Link Telegram", then send /link CODE.');
      await fn(user);
    } catch (e) { reply(msg, `Error: ${e.message}`); }
  }
  const settingsOf = async (uid) => (await db.settingsFor([uid]))[0];

  bot.onText(/^\/status/, (m) => withUser(m, async (u) => {
    const s = await settingsOf(u.id); const a = engine.accounts.get(u.id);
    reply(m, `Mode ${s.mode} · ${s.paused ? '⏸ paused' : '▶️ running'} · ${s.live && config.LIVE_TRADING_ENABLED ? 'LIVE' : 'PAPER'}\nLimits: ${s.max_position_sol} SOL/trade · ${s.max_daily_loss_pct}% daily loss · ${s.max_concurrent} open\nOpen trades: ${a ? a.openCount() : 0}`);
  }));
  bot.onText(/^\/report|^\/pnl/, (m) => withUser(m, async (u) => {
    const a = engine.accounts.get(u.id);
    if (!a) return reply(m, 'No activity yet.');
    const lines = [];
    for (const [k, b] of Object.entries(a.books)) {
      const h = b.history.slice(0, 5);
      lines.push(`${k.toUpperCase()} · today ${b.daily.realizedSol >= 0 ? '+' : ''}${(b.daily.realizedSol || 0).toFixed(4)} SOL · ${b.daily.tradesToday || 0} trades · open ${b.open.size}`);
      for (const t of h) lines.push(`  ${t.realizedSol == null ? '⚪' : t.realizedSol >= 0 ? '🟢' : '🔴'} ${t.mint.slice(0, 6)}… ${t.reason} ${t.pct == null ? '?' : t.pct.toFixed(1) + '%'}`);
    }
    reply(m, lines.join('\n'));
  }));
  bot.onText(/^\/pause/, (m) => withUser(m, async (u) => { await db.updateSettings(u.id, { paused: true }); reply(m, '⏸ Paused. No new trades. Open trades still follow their take-profit / stop-loss.'); }));
  bot.onText(/^\/resume/, (m) => withUser(m, async (u) => { await db.updateSettings(u.id, { paused: false }); reply(m, '▶️ Running.'); }));
  bot.onText(/^\/mode\s+(\w+)/, (m, x) => withUser(m, async (u) => {
    const mode = x[1].toLowerCase();
    if (!PRESETS[mode]) return reply(m, 'Use /mode easy, medium or hard.');
    await db.updateSettings(u.id, { mode }); reply(m, `Mode set to ${mode}.`);
  }));
  bot.onText(/^\/sellall/, (m) => withUser(m, async (u) => { await db.updateSettings(u.id, { paused: true, panic_at: new Date().toISOString() }); reply(m, '🛑 Paused and closing all open trades.'); }));
  bot.onText(/^\/unlink/, (m) => withUser(m, async (u) => { await db.unlinkChat(u.id); reply(m, 'Unlinked.'); }));
  bot.onText(/^\/stats/, async (m) => {
    if (String(m.chat.id) !== String(config.ADMIN_CHAT_ID)) return;
    try { const s = await db.adminStats(); reply(m, `users ${s.users} · running ${s.running} · live ${s.live} · trades ${s.trades} · accounts in memory ${engine.accounts.size}`); } catch (e) { reply(m, e.message); }
  });

  bot.on('polling_error', (e) => logger.warn('telegram polling:', e.message));
  return { send, adminNotify, stop: () => bot.stopPolling() };
}

module.exports = { start };
