/**
 * The engine: keeps one Account per active user, scans per account on that account's plan, monitors open trades, runs withdrawals.
 */
const config = require('./config');
const logger = require('./utils/logger');
const { Account } = require('./trading/account');
const { processWithdrawal } = require('./trading/withdraw');
const charting = require('./charting');
const collector = require('./data/collector');
const health = require('./health');
const { Keypair } = require('@solana/web3.js');

class Engine {
  /** o = { db, deps, unsealSecret(sealed)->Uint8Array, send(chatId,text), adminNotify(text) } */
  constructor(o) {
    this.db = o.db; this.deps = o.deps; this.unsealSecret = o.unsealSecret; this.send = o.send || (() => {}); this.adminNotify = o.adminNotify || (() => {});
    this.accounts = new Map();
    this.timers = [];
    this.scanning = false; this.agenting = false; this.syncing = false; this.monitoring = false; this.withdrawing = false;
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
      const waiting = db.pendingOrders ? (await db.pendingOrders().catch(() => [])).map((o) => o.user_id) : [];
      const ids = new Set([...running.map((r) => r.user_id), ...withOpen, ...waiting]);
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
        if (a.plan.agent && a.plan.agent.enabled) continue; // chart-watching plans are handled by agentTick
        if (Date.now() < (a.nextScanAt || 0)) continue;
        a.nextScanAt = Date.now() + a.plan.scanEverySec * 1000 - 500;
        const stats = {};
        const pick = await this.deps.scanner.pickOne(a.plan, a.userId, stats);
        if (!pick) { a.noteScan({ candidates: stats.candidates || 0, matched: 0, outcome: stats.candidates ? 'none matched your plan this round' : 'no new coins in your age window this round' }); continue; }
        const why = `scanner:${pick.score.toFixed(0)}`;
        const res = await a.offer(pick.mint, why);
        a.noteScan({ candidates: stats.candidates || 0, matched: stats.matched || 1, mint: pick.mint, outcome: res.ok ? 'entered a trade' : `found a match but skipped it: ${res.why}` });
        if (res.ok) {
          const p = res.pos;
          a.notify(`🟢 ENTERED ${pick.mint.slice(0, 6)}…${pick.mint.slice(-4)} · ${p.dryRun ? 'PAPER' : 'LIVE'}\n${why} · plan ${a.plan.name}\nin: ${p.sizeSol.toFixed(4)} SOL → ${(Number(p.tokenRaw) / 10 ** p.decimals).toFixed(2)} tokens (${p.fillSource})\nTP +${p.takeProfitPct}% · SL −${p.stopLossPct}% · max hold ${p.maxHoldMin}m${p.buySig ? `\nhttps://solscan.io/tx/${p.buySig}` : ''}`);
        } else if (res.why && !/^(busy|paused|max concurrent|max trades)/.test(res.why)) logger.info(`[${a.tag}] skip ${pick.mint.slice(0, 8)}…: ${res.why}`);
      }
    } catch (e) { logger.error('scanTick:', e.message); } finally { this.scanning = false; }
  }

  /**
   * Chart-watching agents. For every running account whose plan has the agent switched on: look at the live candles of
   * young coins, keep only coins inside the plan's age window and market-cap range, and enter when the chosen pattern
   * (double bottom, breakout, ...) is showing. Entries use the same limits, size and exits as any other plan.
   */
  async agentTick() {
    if (this.agenting) return;
    this.agenting = true;
    try {
      for (const a of this.activeAccounts()) {
        const ag = a.plan.agent;
        if (!ag || !ag.enabled) continue;
        if (Date.now() < (a.nextAgentAt || 0)) continue;
        a.nextAgentAt = Date.now() + Math.max(5, a.plan.scanEverySec) * 1000 - 500;
        const seen = (a.agentSeen ||= new Map());
        for (const [m, t] of seen) if (Date.now() - t > 30 * 60 * 1000) seen.delete(m);
        const held = new Set(a.positions().map((p) => p.mint));
        let checked = 0, found = null;
        const pool = ag.onlyMint ? [ag.onlyMint] : (ag.source && ag.source !== 'none' && (ag.pattern === 'momentum' || ag.source !== 'any') ? collector.hotMints(ag.source) : collector.trackedMints()); // a watcher plan looks at one coin; otherwise every young coin
        for (const mint of pool) {
          if (held.has(mint) || seen.has(mint)) continue;
          const mk = collector.marketFor(mint);
          if (!mk) continue;
          if (!ag.onlyMint && (mk.ageSec < a.plan.minAgeSec || (a.plan.maxAgeSec != null && mk.ageSec > a.plan.maxAgeSec))) continue;
          if (mk.marketCapUsd < ag.mcapMinUsd || (ag.mcapMaxUsd != null && mk.marketCapUsd > ag.mcapMaxUsd)) continue;
          checked += 1;
          const bars = charting.resample(collector.barsFor(mint), ag.tfSec);
          const r = charting.detect(ag.pattern, bars, ag);
          if (r.match) { found = { mint, r, mk }; break; }
        }
        if (!found) { a.noteScan({ candidates: checked, matched: 0, outcome: checked ? (ag.onlyMint ? 'watching your coin: no' : `watching ${checked} coin${checked === 1 ? '' : 's'} in your range: no`) + ` ${charting.PATTERN_LABELS[ag.pattern].toLowerCase()} yet` : 'no coins inside your age and market-cap range right now' }); continue; }
        seen.set(found.mint, Date.now());
        const why = `agent:${ag.pattern}`;
        const res = await a.offer(found.mint, why);
        a.noteScan({ candidates: checked, matched: 1, mint: found.mint, outcome: res.ok ? `entered on a ${found.r.reason}` : `saw a ${ag.pattern.replace('_', ' ')} but skipped it: ${res.why}` });
        if (res.ok) {
          const p = res.pos;
          a.notify(`🟢 ENTERED ${found.mint.slice(0, 6)}…${found.mint.slice(-4)} · ${p.dryRun ? 'PAPER' : 'LIVE'}\n${found.r.reason} · plan ${a.plan.name}\nin: ${p.sizeSol.toFixed(4)} SOL · mcap ≈ $${Math.round(found.mk.marketCapUsd)}\nTP +${p.takeProfitPct}% · SL −${p.stopLossPct}% · max hold ${p.maxHoldMin}m`);
        }
      }
    } catch (e) { logger.error('agentTick:', e.message); } finally { this.agenting = false; }
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

  /** Manual buys from the website's coin chart. */
  async orderTick() {
    if (this.ordering || !this.db.pendingOrders) return;
    this.ordering = true;
    try {
      const orders = await this.db.pendingOrders();
      if (!orders.length) return;
      logger.info(`orders waiting: ${orders.length}`);
      if (orders.some((o) => !this.accounts.has(o.user_id))) { this.ordering = false; await this.sync(); this.ordering = true; }
      for (const o of orders) {
        if (!(await this.db.claimOrder(o.id))) continue;
        const a = this.accounts.get(o.user_id);
        if (!a) { await this.db.finishOrder(o.id, { status: 'failed', result: 'your account is not ready (create your vault and sign your limits, or check the settings)' }); continue; }
        let res;
        try { res = await a.manualBuy(o.mint, { sizeSol: Number(o.size_sol), tp: Number(o.tp_pct) || 0, sl: Number(o.sl_pct) || 0, holdMin: Number(o.hold_min) || 0 }); }
        catch (err) { res = { ok: false, why: err.message }; }
        if (res.ok) {
          const p = res.pos;
          await this.db.finishOrder(o.id, { status: 'done', paper: !!res.paper, result: `bought ${p.sizeSol.toFixed(4)} SOL ${res.paper ? '(paper)' : '(live)'}. Exits: +${p.takeProfitPct}% / -${p.stopLossPct}% / ${p.maxHoldMin} min${p.buySig ? ` · ${p.buySig}` : ''}` });
          a.notify(`🟢 MANUAL BUY ${o.mint.slice(0, 6)}…${o.mint.slice(-4)} · ${res.paper ? 'PAPER' : 'LIVE'} · ${p.sizeSol.toFixed(4)} SOL`);
        } else await this.db.finishOrder(o.id, { status: 'failed', paper: !!res.paper, result: String(res.why || 'failed').slice(0, 300) });
      }
    } catch (err) { logger.error('orderTick:', err.message); } finally { this.ordering = false; }
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

  /** Tell the website we are alive and whether live trading is really on. Best effort: never blocks trading. */
  /** Keep candles flowing for coins we hold (they are exempt from eviction and always subscribed). */
  pinHeld() {
    try {
      const held = []; for (const a of this.accounts.values()) for (const p of a.positions()) held.push(p.mint);
      const collector = require('./data/collector'); collector.pin(held);
      const stream = require('./scanner/stream'); if (held.length) stream.subscribe(held);
    } catch (_) { /* optional */ }
  }

  async heartbeat() {
    if (!this.db.heartbeat) return;
    const row = { live_enabled: !!config.LIVE_TRADING_ENABLED, version: config.VERSION, accounts: this.accounts.size };
    try {
      try { await this.db.heartbeat({ ...row, checks: health.snapshot() }); }
      catch (e) { if (!/checks/i.test(String(e.message))) throw e; await this.db.heartbeat(row); } // column not added yet: still report that we are alive
      this.hbFailed = false; }
    catch (e) { if (!this.hbFailed) logger.warn(`heartbeat failed (run the art_worker SQL in supabase_art.sql): ${e.message}`); this.hbFailed = true; }
  }

  async start() {
    // A withdrawal left "processing" by a crash may or may not have been sent: never retry blindly.
    try { for (const r of await this.db.stuckWithdrawals()) await this.db.finishWithdrawal(r.id, { status: 'failed', error: 'worker restarted mid-send; check your wallet and vault balance before requesting again' }); } catch (e) { logger.warn('stuck withdrawals:', e.message); }
    await this.sync();
    try { health.start(); } catch (e) { logger.warn('health:', e.message); }
    this.heartbeat(); this.timers.push(setInterval(() => this.heartbeat(), 15000));
    this.timers.push(setInterval(() => this.pinHeld(), 10000));
    this.timers.push(setInterval(() => this.sync(), config.SYNC_MS));
    this.timers.push(setInterval(() => this.scanTick(), 5000));
    this.timers.push(setInterval(() => this.agentTick(), 3000));
    this.timers.push(setInterval(() => this.monitorTick(), config.PRICE_POLL_MS));
    this.timers.push(setInterval(() => this.withdrawTick(), config.WITHDRAW_POLL_MS));
    if (this.db.failStaleOrders) this.db.failStaleOrders().catch(() => {});
    this.timers.push(setInterval(() => this.orderTick(), 2000));
    logger.info(`engine started: ${this.accounts.size} active account(s), live trading ${config.LIVE_TRADING_ENABLED ? 'ENABLED' : 'disabled (everyone is paper)'}`);
  }

  async stop() { this.timers.forEach(clearInterval); this.timers = []; }
}

module.exports = { Engine };
