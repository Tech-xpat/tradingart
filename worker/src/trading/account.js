/**
 * LIVE-ONLY trading account.
 * Paper trading removed completely. Every entry is real money from the vault.
 */
const config = require('../config');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toSol = (lamports) => Number(lamports) / 1e9;
const short = (mint) => `${mint.slice(0, 6)}…${mint.slice(-4)}`;
const scanUrl = (sig) => (sig ? `https://solscan.io/tx/${sig}` : '');

class Book {
  constructor(acct) {
    this.acct = acct;
    this.open = new Map();
    this.entering = false;
    this.monitoring = false;
    this.daily = { day: null, startSol: 0, realizedSol: 0, tradesToday: 0 };
    this.history = [];
    this.loaded = false;
  }

  get d() { return this.acct.deps; }
  key(name) { return `live:${name}`; }
  save(name, value) { return this.d.db.setState(this.acct.userId, this.key(name), value).catch((e) => { logger.error(`[${this.acct.tag}] save ${name}:`, e.message); }); }
  persistPositions() { return this.save('positions', [...this.open.values()].map((p) => ({ ...p }))); }
  persistDaily() { return this.save('daily', { ...this.daily }); }
  persistHistory() { return this.save('history', this.history.slice(0, 50)); }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    const { db, chain } = this.d;
    let saved = [];
    try { const s = await db.getState(this.acct.userId, this.key('positions')); saved = Array.isArray(s) ? s : []; } catch (e) { this.acct.notify(`⚠️ Could not load saved positions: ${e.message}`); }
    try { const x = await db.getState(this.acct.userId, this.key('daily')); if (x && typeof x === 'object') this.daily = { ...this.daily, ...x }; } catch (_) {}
    try { const h = await db.getState(this.acct.userId, this.key('history')); if (Array.isArray(h)) this.history = h; } catch (_) {}

    for (const p of saved) {
      if (!p || !p.mint) continue;
      try {
        if ((await chain.getTokenBalance(this.acct.vaultAddress, p.mint)).raw <= 0n) continue;
      } catch (e) {
        logger.warn(`[${this.acct.tag}] restore check ${short(p.mint)}: ${e.message}`);
      }
      this.open.set(p.mint, { ...p, status: p.status === 'selling' ? 'open' : p.status || 'open', priceMisses: 0 });
    }
  }

  ownerAddress() { return this.acct.vaultAddress; }

  async currentBalanceSol() {
    return this.d.chain.getSolBalance(this.acct.vaultAddress);
  }

  async rollDay() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.daily.day === day) return;
    this.daily.day = day;
    this.daily.realizedSol = 0;
    this.daily.tradesToday = 0;
    this.daily.startSol = await this.currentBalanceSol();
    this.persistDaily();
  }

  async isHalted() {
    await this.rollDay();
    if (!(this.daily.startSol > 0)) return false;
    return this.daily.realizedSol <= -(this.daily.startSol * this.acct.plan.maxDailyLossPct) / 100;
  }

  async sizeSol(overrideSol) {
    const plan = this.acct.plan;
    const bal = await this.currentBalanceSol();
    const usable = Math.max(0, bal - config.SOL_FEE_RESERVE);
    const solUsd = await this.d.scanner.fetchSolPriceUsd();
    let sol = overrideSol > 0 ? overrideSol : (Number(plan.sizeUsd) || 7) / solUsd;
    sol = Math.min(sol, Number(plan.maxPositionSol) || 0.05);
    sol = Math.min(sol, usable * 0.95);
    if (sol < config.MIN_POSITION_SOL) sol = 0;
    return Math.floor(sol * 1e6) / 1e6;
  }

  async liveBuy(mint, sol) {
    const { chain, swap, fills } = this.d;
    const signer = await this.acct.getSigner();
    const owner = this.acct.vaultAddress;
    const solBefore = await chain.getSolLamports(owner);
    let sig;
    const attempts = Math.max(1, config.BUY_ATTEMPTS || 1);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        sig = await swap.buy(signer, mint, sol, attempt);
        break;
      } catch (e) {
        let retryable = !!(e.notSent || e.onchainError || !e.signature);
        if (e.signature && !e.onchainError && !e.notSent) {
          const verdict = await swap.waitForSignature(e.signature, 75000);
          if (verdict.ok) { sig = e.signature; break; }
          let held = { raw: 0n };
          try { held = await chain.getTokenBalance(owner, mint); } catch (_) {}
          if (held.raw > 0n) { sig = e.signature; break; }
          retryable = true;
          e = new Error(`buy did not land: ${verdict.reason} (${e.signature})`);
        }
        if (e.fatal || !retryable || attempt >= attempts) throw e;
        logger.info(`[${this.acct.tag}] buy attempt ${attempt} failed (${String(e.message).slice(0, 90)}); retrying`);
      }
    }
    const fill = await fills.readFill(sig, owner, mint);
    if (fill && !fill.failed && fill.tokenDeltaRaw > 0n && fill.solDeltaLamports != null && fill.solDeltaLamports < 0n) {
      return { tokenRaw: fill.tokenDeltaRaw, decimals: fill.decimals, costLamports: -fill.solDeltaLamports, signature: sig, source: 'tx' };
    }
    let bal = { raw: 0n, decimals: null };
    for (let i = 0; i < 6 && bal.raw <= 0n; i++) {
      try { bal = await chain.getTokenBalance(owner, mint); } catch (_) {}
      if (bal.raw <= 0n) await sleep(700);
    }
    if (bal.raw <= 0n) throw new Error(`buy tx confirmed but no tokens found in the vault: ${scanUrl(sig)}`);
    const spent = solBefore - (await chain.getSolLamports(owner));
    return { tokenRaw: bal.raw, decimals: bal.decimals, costLamports: spent > 0n ? spent : BigInt(Math.round(sol * 1e9)), signature: sig, source: spent > 0n ? 'balance' : 'requested-amount' };
  }

  async tryEnter(mint, reason, opts = {}) {
    const plan = this.acct.plan;
    if (this.open.has(mint)) return { ok: false, why: 'you already hold this coin' };
    if (this.entering) return { ok: false, why: 'busy: another buy is still being sent' };
    if (this.open.size >= plan.maxConcurrent) return { ok: false, why: 'max concurrent' };
    await this.load();
    await this.rollDay();
    if (!opts.manual && this.daily.tradesToday >= plan.maxTradesDay) return { ok: false, why: `max trades/day reached (${this.daily.tradesToday}/${plan.maxTradesDay})` };
    this.entering = true;
    try {
      if (await this.isHalted()) return { ok: false, why: 'daily loss limit reached' };
      const { market, chain } = this.d;
      const mkt = await market.getTokenMarket(mint);
      if (!mkt) return { ok: false, why: 'no SOL-quoted market found' };

      const curveCoin = mkt.source === 'own';
      if (!curveCoin && mkt.liquidityUsd < config.MIN_LIQUIDITY_USD) return { ok: false, why: `liquidity $${Math.round(mkt.liquidityUsd)} < $${config.MIN_LIQUIDITY_USD}` };
      if (!curveCoin && config.MAX_POOL_SHARE_PCT > 0 && plan.sizeUsd > (mkt.liquidityUsd * config.MAX_POOL_SHARE_PCT) / 100) {
        return { ok: false, why: `size $${plan.sizeUsd} is more than ${config.MAX_POOL_SHARE_PCT}% of the pool` };
      }
      if (config.REQUIRE_NO_AUTHORITIES && !opts.manual && mkt.source !== 'own') {
        const mi = await chain.getMintInfo(mint);
        if (mi.mintAuthority || mi.freezeAuthority) return { ok: false, why: 'mint/freeze authority still active' };
      }

      const bal = await this.currentBalanceSol();
      if (bal < config.MIN_VAULT_SOL) return { ok: false, why: `vault balance ${bal.toFixed(4)} SOL below the ${config.MIN_VAULT_SOL} SOL minimum` };

      const sol = await this.sizeSol(opts.sizeSol);
      if (sol < config.MIN_POSITION_SOL) {
        return { ok: false, why: `size ${sol} SOL below minimum. Need balance + limits to cover ${config.MIN_POSITION_SOL} SOL + fees` };
      }

      logger.info(`[${this.acct.tag}] ENTER ${short(mint)} ${sol} SOL (${reason}) [LIVE]`);
      const fill = await this.liveBuy(mint, sol);
      const costSol = toSol(fill.costLamports);
      const tokensUi = Number(fill.tokenRaw) / 10 ** fill.decimals;
      const m = String(reason || '').match(/scanner:(\d+(?:\.\d+)?)/);

      const pos = {
        mint, openedAt: Date.now(), dryRun: false, status: 'open',
        costLamports: String(fill.costLamports), tokenRaw: String(fill.tokenRaw), decimals: fill.decimals,
        sizeSol: costSol, sizeUsd: plan.sizeUsd, entryPriceNative: costSol / tokensUi, fillSource: fill.source, buySig: fill.signature,
        reason, mode: plan.riskProfile, ageDays: mkt.ageDays ?? null, ageSec: mkt.ageSec ?? null,
        liquidityUsd: mkt.liquidityUsd ?? null, volume1h: mkt.volume1h ?? null,
        priceChange1h: mkt.priceChange1h ?? null, priceChange6h: mkt.priceChange6h ?? null, buys1h: mkt.buys1h ?? null,
        score: m ? Number(m[1]) : null,
        takeProfitPct: opts.tp > 0 ? opts.tp : plan.takeProfitPct,
        stopLossPct: opts.sl > 0 ? opts.sl : plan.stopLossPct,
        maxHoldMin: opts.holdMin > 0 ? opts.holdMin : plan.maxHoldMin,
        lastPnl: null, lastPrice: null, priceMisses: 0, stuckRounds: 0,
      };
      this.open.set(mint, pos);
      this.daily.tradesToday = (this.daily.tradesToday || 0) + 1;
      this.persistPositions();
      this.persistDaily();
      return { ok: true, pos };
    } catch (err) {
      logger.error(`[${this.acct.tag}] buy failed:`, err.message);
      return { ok: false, why: err.message };
    } finally {
      this.entering = false;
    }
  }

  markPnl(pos, priceNative) {
    const tokensUi = Number(pos.tokenRaw) / 10 ** pos.decimals;
    const value = tokensUi * priceNative * (1 - config.EXIT_COST_PCT / 100);
    const cost = Number(pos.costLamports) / 1e9;
    return ((value - cost) / cost) * 100;
  }

  trail(pos, pnl) {
    const now = Date.now();
    const t = (pos.trail ||= []);
    if (t.length && now - t[t.length - 1][0] < 4000) return;
    t.push([now, Math.round(pnl * 100) / 100]);
    if (t.length > 150) t.splice(0, t.length - 150);
  }

  async checkPosition(pos) {
    const tp = Number(pos.takeProfitPct) || 30;
    const sl = -Math.abs(Number(pos.stopLossPct) || 20);
    const maxHoldMs = (Number(pos.maxHoldMin) || 2) * 60 * 1000;
    let pnl = null;
    try {
      const mkt = await this.d.market.getTokenMarket(pos.mint);
      if (mkt) {
        pnl = this.markPnl(pos, mkt.priceNative);
        pos.lastPrice = mkt.priceNative;
        pos.lastPnl = pnl;
        pos.priceMisses = 0;
        this.trail(pos, pnl);
      } else pos.priceMisses += 1;
    } catch (_) { pos.priceMisses += 1; }

    if (pos.priceMisses === 6) this.acct.notify(`⚠️ No price for ${short(pos.mint)} for a while. Only max-hold can exit it.`);
    let reason = null;
    if (pnl != null && pnl >= tp) reason = 'take_profit';
    else if (pnl != null && pnl <= sl) reason = 'stop_loss';
    else if (Date.now() - pos.openedAt >= maxHoldMs) reason = 'max_hold';
    if (reason) this.exit(pos, reason).catch((e) => logger.error('exit crashed:', e.message));
  }

  async monitorTick() {
    if (this.monitoring) return;
    this.monitoring = true;
    try {
      for (const pos of [...this.open.values()]) {
        if (pos.status === 'selling') continue;
        if (pos.status === 'stuck') {
          if (Date.now() >= (pos.retryAt || 0)) this.exit(pos, pos.exitReason || 'retry').catch(() => {});
          continue;
        }
        await this.checkPosition(pos);
      }
      if (this.open.size && Date.now() - (this.lastPersist || 0) >= 3000) {
        this.lastPersist = Date.now();
        this.persistPositions();
      }
    } finally { this.monitoring = false; }
  }

  async liveSell(pos) {
    const { chain, swap, fills } = this.d;
    const signer = await this.acct.getSigner();
    const owner = this.acct.vaultAddress;
    const flat = async () => (await chain.getTokenBalance(owner, pos.mint)).raw <= 0n;
    const solBefore = await chain.getSolLamports(owner).catch(() => null);
    try { if (await flat()) return { proceedsLamports: null, sig: null, source: 'already-flat' }; } catch (_) {}

    let lastErr = null, landed = 0;
    for (let attempt = 1; attempt <= config.SELL_RETRIES; attempt++) {
      let sig = null;
      try {
        sig = await swap.sellAll(signer, pos.mint, attempt);
      } catch (e) {
        lastErr = e;
        if (e.signature && e.timedOut) {
          const v = await swap.waitForSignature(e.signature, 45000);
          if (v.ok) sig = e.signature;
        }
        if (!sig) {
          logger.warn(`[${this.acct.tag}] sell ${attempt}/${config.SELL_RETRIES} ${short(pos.mint)}: ${e.message}`);
          try { if (await flat()) return { proceedsLamports: null, sig: null, source: 'already-flat' }; } catch (_) {}
          await sleep(300);
          continue;
        }
      }
      landed += 1;
      let remaining = null;
      for (let i = 0; i < 3; i++) {
        try { remaining = (await chain.getTokenBalance(owner, pos.mint)).raw; } catch (_) { remaining = null; }
        if (remaining === 0n) break;
        await sleep(600);
      }
      if (remaining === 0n) {
        if (landed === 1) {
          const fill = await fills.readFill(sig, owner, pos.mint);
          if (fill && !fill.failed && fill.solDeltaLamports != null) return { proceedsLamports: fill.solDeltaLamports, sig, source: 'tx' };
        }
        const solAfter = await chain.getSolLamports(owner).catch(() => null);
        if (solBefore != null && solAfter != null) return { proceedsLamports: solAfter - solBefore, sig, source: 'balance' };
        return { proceedsLamports: null, sig, source: 'unknown' };
      }
    }
    throw new Error(`sell failed after ${config.SELL_RETRIES} attempts: ${lastErr ? lastErr.message : 'tokens still in vault'}`);
  }

  async finalizeClose(pos, reason, result) {
    const costSol = toSol(BigInt(pos.costLamports));
    let proceedsSol = null, realizedSol = null;
    if (result.proceedsLamports != null) {
      proceedsSol = toSol(result.proceedsLamports);
      realizedSol = proceedsSol - costSol;
      this.daily.realizedSol += realizedSol;
    }
    this.open.delete(pos.mint);
    const closedAt = Date.now();
    const pct = realizedSol != null ? (realizedSol / costSol) * 100 : null;

    this.history.unshift({
      mint: pos.mint, openedAt: pos.openedAt, closedAt, reason,
      costSol, proceedsSol, realizedSol, pct,
      buySig: pos.buySig, sellSig: result.sig,
      fillSource: pos.fillSource, sellSource: result.source,
      paper: false, mode: pos.mode
    });
    this.history = this.history.slice(0, 50);
    this.persistPositions();
    this.persistDaily();
    this.persistHistory();

    this.d.db.insertTrade({
      user_id: this.acct.userId, paper: false, mode: pos.mode, mint: pos.mint,
      entry_reason: pos.reason, exit_reason: reason,
      cost_sol: costSol, proceeds_sol: proceedsSol, realized_sol: realizedSol, pct,
      hold_sec: pos.openedAt ? Math.round((closedAt - pos.openedAt) / 1000) : null,
      buy_sig: pos.buySig, sell_sig: result.sig,
      features: {
        ageDays: pos.ageDays, liquidityUsd: pos.liquidityUsd, volume1h: pos.volume1h,
        priceChange1h: pos.priceChange1h, priceChange6h: pos.priceChange6h, buys1h: pos.buys1h,
        score: pos.score, sizeUsd: pos.sizeUsd, takeProfitPct: pos.takeProfitPct,
        stopLossPct: pos.stopLossPct, maxHoldMin: pos.maxHoldMin
      },
    }).catch((e) => logger.warn(`[${this.acct.tag}] trade log: ${e.message}`));

    const head = realizedSol == null ? '⚪' : realizedSol >= 0 ? '🟢' : '🔴';
    const money = realizedSol == null
      ? 'result unknown (check vault)'
      : `${realizedSol >= 0 ? '+' : ''}${realizedSol.toFixed(4)} SOL (${pct.toFixed(1)}%) from ${costSol.toFixed(4)} SOL in`;
    this.acct.notify(`${head} EXIT ${short(pos.mint)} · ${reason}\n${money}\nread from chain (${result.source})${result.sig ? `\n${scanUrl(result.sig)}` : ''}`);
  }

  async exit(pos, reason) {
    if (pos.status === 'selling') return;
    pos.status = 'selling';
    pos.exitReason = reason;
    try {
      const result = await this.liveSell(pos);
      await this.finalizeClose(pos, reason, result);
    } catch (err) {
      pos.status = 'stuck';
      pos.stuckRounds = (pos.stuckRounds || 0) + 1;
      pos.retryAt = Date.now() + config.STUCK_RETRY_MS;
      this.persistPositions();
      logger.error(`[${this.acct.tag}] sell failed ${short(pos.mint)} (round ${pos.stuckRounds}):`, err.message);
      if (pos.stuckRounds === 1 || pos.stuckRounds % 5 === 0) {
        this.acct.notify(`🚨 SELL FAILED ${short(pos.mint)} (round ${pos.stuckRounds})\n${err.message.slice(0, 160)}\nRetrying every ${Math.round(config.STUCK_RETRY_MS / 1000)}s.`);
      }
    }
  }

  exitAll(reason) {
    let n = 0;
    for (const pos of [...this.open.values()]) {
      if (pos.status !== 'selling') {
        this.exit(pos, reason).catch(() => {});
        n++;
      }
    }
    return n;
  }
}

class Account {
  constructor(o) {
    this.userId = o.userId;
    this.wallet = o.wallet;
    this.vaultAddress = o.vaultAddress || null;
    this.sealed = o.sealed || null;
    this.deps = o.deps;
    this.unseal = o.unseal;
    this._notify = o.notify || (() => {});
    this.tag = String(o.wallet).slice(0, 4) + '…' + String(o.wallet).slice(-3);
    this.book = new Book(this);                 // single live book only
    this._signer = null;
    this.lastPanicAt = o.settings && o.settings.panic_at ? new Date(o.settings.panic_at).getTime() : 0;
    this.update(o.settings, o.consent, { vaultAddress: o.vaultAddress, sealed: o.sealed });
  }

  notify(text) { try { this._notify(text); } catch (_) {} }

  update(settings, consent, vault) {
    this.settings = settings;
    this.consent = consent || null;
    if (vault && vault.vaultAddress && vault.vaultAddress !== this.vaultAddress) {
      this.vaultAddress = vault.vaultAddress;
      this.sealed = vault.sealed;
      this._signer = null;
    }
    const { effectivePlan } = require('../plans');
    const before = this.plan && this.plan.name + ':' + this.plan.scanEverySec;
    this.plan = effectivePlan(settings, this.consent);
    if (before && before !== this.plan.name + ':' + this.plan.scanEverySec) this.nextScanAt = 0;

    // LIVE ONLY. Requires vault + signed consent. Env flag is ignored.
    this.liveAllowed = !!(this.vaultAddress && this.consent);
  }

  liveBlock() {
    if (!this.vaultAddress) return 'no vault yet';
    if (!this.consent) return 'no signed limits yet';
    return null;
  }

  noteScan(info) {
    this.lastScan = { at: Date.now(), book: 'live', plan: this.plan.name, ...info, note: this.liveBlock() };
    const db = this.deps && this.deps.db;
    if (db && db.setState) db.setState(this.userId, 'status', this.lastScan).catch(() => {});
  }

  get paused() { return !!this.settings.paused; }
  entryBook() { return this.book; }
  hasOpen() { return this.book.open.size > 0; }
  openCount() { return this.book.open.size; }

  async getSigner() {
    if (this._signer) return this._signer;
    if (!this.sealed || !this.vaultAddress) throw new Error('no vault');
    const { Keypair } = require('@solana/web3.js');
    const secret = this.unseal(this.sealed);
    const kp = Keypair.fromSecretKey(secret);
    secret.fill(0);
    if (kp.publicKey.toBase58() !== this.vaultAddress) throw new Error('vault key does not match its address');
    this._signer = kp;
    return kp;
  }

  async load() { await this.book.load(); }

  async offer(mint, reason) {
    if (this.paused) return { ok: false, why: 'paused' };
    if (!this.liveAllowed) return { ok: false, why: this.liveBlock() || 'not ready for live' };
    await this.load();
    return this.book.tryEnter(mint, reason);
  }

  async manualBuy(mint, o = {}) {
    if (!this.liveAllowed) return { ok: false, why: this.liveBlock() || 'not ready for live', paper: false };
    await this.load();
    const res = await this.book.tryEnter(mint, 'manual', { manual: true, sizeSol: o.sizeSol, tp: o.tp, sl: o.sl, holdMin: o.holdMin });
    return { ...res, paper: false };
  }

  async monitorTick() { await this.book.monitorTick(); }

  handlePanic(panicAtMs) {
    if (!panicAtMs || panicAtMs <= this.lastPanicAt) return 0;
    this.lastPanicAt = panicAtMs;
    return this.book.exitAll('panic');
  }

  exitAll(reason) { return this.book.exitAll(reason); }

  positions() { return [...this.book.open.values()]; }

  dispose() { this._signer = null; }
}

module.exports = { Account, Book };
