/**
 * The engine: keeps one Account per active user, scans per account on that account's plan, monitors open trades, runs withdrawals.
 */
const config = require('./config');
const logger = require('./utils/logger');
const { Account } = require('./trading/account');
const { processWithdrawal } = require('./trading/withdraw');
const { Keypair } = require('@solana/web3.js');

class Engine {
  /** o = { db, deps, unsealSecret(sealed)->Uint8Array, send(chatId,text), adminNotify(text) } */
  constructor(o) {
    this.db = o.db; this.deps = o.deps; this.unsealSecret = o.unsealSecret; this.send = o.send || (() => {}); this.adminNotify = o.adminNotify || (() => {});
    this.accounts = new Map();
    this.timers = [];
    this.scanning = false; this.syncing = false; this.monitoring = false; this.withdrawing = false;
  }

  notifier(userId) {
    return (text) => { const a = this.accounts.get(userId); if (a && a.chatId) this.send(a.chatId, text); };
  }

  async sync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const { db } = this;
      const running = await db.settingsRunning();
      const withOpen = await db.usersWithOpenPositions();
      const ids = new Set([...running.map((r) => r.user_id), ...withOpen]);
      for (const [id, a] of this.accounts) if (a.hasOpen()) ids.add(id);
      const list = [...ids];
      const [rows, users, vaults, consents] = await Promise.all([db.settingsFor(list), db.users(list), db.vaults(list), db.consents(list)]);
      const settingsBy = new Map(rows.map((r) => [r.user_id, r]));
      for (const id of list) {
        const settings = settingsBy.get(id), user = users.get(id);
        if (!settings || !user) continue;
        const vault = vaults.get(id) || null;
        let acct = this.accounts.get(id);
        if (!acct) {
          acct = new Account({ userId: id, wallet: user.wallet, vaultAddress: vault && vault.address, sealed: vault && vault.sealed, settings, consent: consents.get(id), deps: this.deps, unseal: this.unsealSecret, notify: this.notifier(id) });
          this.accounts.set(id, acct);
          acct.load().catch((e) => logger.warn(`load ${acct.tag}: ${e.message}`));
        } else acct.update(settings, consents.get(id), { vaultAddress: vault && vault.address, sealed: vault && vault.sealed });
        acct.chatId = user.tg_chat_id || null;
        if (settings.panic_at) {
          const n = acct.handlePanic(new Date(settings.panic_at).getTime());
          if (n) acct.notify(`🛑 Stop and sell all: closing ${n} open trade(s).`);
        }
      }
      for (const [id, a] of this.accounts) if (!ids.has(id) && !a.hasOpen()) { a.dispose(); this.accounts.delete(id); }
    } catch (e) { logger.error('sync:', e.message); } finally { this.syncing = false; }
  }

  activeAccounts() { return [...this.accounts.values()].filter((a) => !a.paused); }

  /** Each running account scans on ITS plan's schedule and applies ITS plan's filters. */
  async scanTick() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const a of this.activeAccounts()) {
        if (Date.now() < (a.nextScanAt || 0)) continue;
        a.nextScanAt = Date.now() + a.plan.scanEverySec * 1000 - 500;
        const pick = await this.deps.scanner.pickOne(a.plan, a.userId);
        if (!pick) continue;
        const why = `scanner:${pick.score.toFixed(0)}`;
        const res = await a.offer(pick.mint, why);
        if (res.ok) {
          const p = res.pos;
          a.notify(`🟢 ENTERED ${pick.mint.slice(0, 6)}…${pick.mint.slice(-4)} · ${p.dryRun ? 'PAPER' : 'LIVE'}\n${why} · plan ${a.plan.name}\nin: ${p.sizeSol.toFixed(4)} SOL → ${(Number(p.tokenRaw) / 10 ** p.decimals).toFixed(2)} tokens (${p.fillSource})\nTP +${p.takeProfitPct}% · SL −${p.stopLossPct}% · max hold ${p.maxHoldMin}m${p.buySig ? `\nhttps://solscan.io/tx/${p.buySig}` : ''}`);
        } else if (res.why && !/^(busy|paused|max concurrent|max trades)/.test(res.why)) logger.info(`[${a.tag}] skip ${pick.mint.slice(0, 8)}…: ${res.why}`);
      }
    } catch (e) { logger.error('scanTick:', e.message); } finally { this.scanning = false; }
  }

  async monitorTick() {
    if (this.monitoring) return;
    this.monitoring = true;
    try { for (const a of [...this.accounts.values()]) { try { await a.monitorTick(); } catch (e) { logger.warn(`monitor ${a.tag}: ${e.message}`); } } } finally { this.monitoring = false; }
  }

  async hasOpenPositions(userId) {
    // only LIVE trades block a withdrawal: paper trades hold no real funds
    const a = this.accounts.get(userId);
    if (a && a.books.live.open.size > 0) return true;
    const open = await this.db.usersWithOpenPositions({ liveOnly: true });
    return open.includes(userId);
  }

  async getSignerFor(userId, vault) {
    const a = this.accounts.get(userId);
    if (a && a.vaultAddress === vault.address) return a.getSigner();
    const secret = this.unsealSecret(vault.sealed);
    const kp = Keypair.fromSecretKey(secret); secret.fill(0);
    if (kp.publicKey.toBase58() !== vault.address) throw new Error('vault key does not match its address');
    return kp;
  }

  async withdrawTick() {
    if (this.withdrawing) return;
    this.withdrawing = true;
    try {
      for (const req of await this.db.pendingWithdrawals()) {
        if (!(await this.db.claimWithdrawal(req.id))) continue;
        await processWithdrawal(req, { db: this.db, deps: this.deps, getSigner: (u, v) => this.getSignerFor(u, v), hasOpenPositions: (u) => this.hasOpenPositions(u) });
        const a = this.accounts.get(req.user_id);
        if (a) a.notify('💸 Withdrawal request processed. Check the dashboard for the result.');
      }
    } catch (e) { logger.error('withdrawTick:', e.message); } finally { this.withdrawing = false; }
  }

  async start() {
    // A withdrawal left "processing" by a crash may or may not have been sent: never retry blindly.
    try { for (const r of await this.db.stuckWithdrawals()) await this.db.finishWithdrawal(r.id, { status: 'failed', error: 'worker restarted mid-send; check your wallet and vault balance before requesting again' }); } catch (e) { logger.warn('stuck withdrawals:', e.message); }
    await this.sync();
    this.timers.push(setInterval(() => this.sync(), config.SYNC_MS));
    this.timers.push(setInterval(() => this.scanTick(), 5000));
    this.timers.push(setInterval(() => this.monitorTick(), config.PRICE_POLL_MS));
    this.timers.push(setInterval(() => this.withdrawTick(), config.WITHDRAW_POLL_MS));
    logger.info(`engine started: ${this.accounts.size} active account(s), live trading ${config.LIVE_TRADING_ENABLED ? 'ENABLED' : 'disabled (everyone is paper)'}`);
  }

  async stop() { this.timers.forEach(clearInterval); this.timers = []; }
}

module.exports = { Engine };
