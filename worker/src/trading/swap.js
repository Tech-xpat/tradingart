/**
 * Swaps through PumpPortal's FREE local-transaction API: it builds the swap, we sign it with
 * our own key and send it through our own (free) RPCs. No API key, no Helius, no Jupiter.
 * pool:'auto' routes pump.fun curve, PumpSwap, Raydium and similar pools.
 *
 * Every function here only moves a transaction; what actually happened is read from the
 * chain afterwards (see src/solana/fills.js).
 */
const { VersionedTransaction } = require('@solana/web3.js');
const config = require('../config');
const { rpc, broadcast, signatureOf } = require('../solana/rpc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask PumpPortal for an unsigned swap tx. Nothing is sent. */
async function buildTx(wallet, body) {
  const res = await fetch(config.PUMPPORTAL_TRADE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: wallet.publicKey.toBase58(), pool: 'auto', ...body }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status !== 200) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(`pumpportal ${res.status}: ${text}`);
  }
  return VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
}

/** Current status of a signature: { ok:true } | { ok:false, onchain:true, err } | null (unknown yet) */
async function statusOf(signature) {
  const res = await rpc((c) => c.getSignatureStatuses([signature], { searchTransactionHistory: true }));
  const st = res.value[0];
  if (!st) return null;
  if (st.err) return { ok: false, onchain: true, err: st.err };
  if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return { ok: true };
  return null;
}

/** Plain-words reason for a failed simulation. */
function explainSim(err, logs) {
  const text = (logs || []).join(' ');
  const code = err && err.InstructionError && err.InstructionError[1] && err.InstructionError[1].Custom;
  if (/insufficient lamports|insufficient funds|InsufficientFunds/i.test(text + JSON.stringify(err))) return { fatal: true, why: 'the vault does not have enough SOL for this buy plus fees and account rent. Deposit more SOL or lower the trade size' };
  if (err === 'InsufficientFundsForRent' || (err && err.InsufficientFundsForRent)) return { fatal: true, why: 'the vault would drop below the minimum SOL Solana requires. Deposit more SOL or lower the trade size' };
  if (code === 6002 || code === 6003 || /TooMuchSolRequired|TooLittleSolReceived|slippage/i.test(text)) return { fatal: false, why: 'the price moved past the allowed slippage' };
  if (code === 6005 || /BondingCurveComplete/i.test(text)) return { fatal: false, why: 'the coin just left pump.fun for a regular pool' };
  const tail = (logs || []).filter((l) => /fail|error|insufficient/i.test(l)).slice(-1)[0] || '';
  return { fatal: false, why: `rejected by the network: ${JSON.stringify(err)} ${tail}`.slice(0, 220) };
}

/**
 * Ask the network to dry-run the signed tx BEFORE sending it, so a doomed buy fails in a second with its real reason
 * instead of timing out as "never landed". If the check itself cannot run (RPC trouble), we just send.
 */
async function preflight(tx) {
  let res;
  try { res = await rpc((c) => c.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' })); } catch (_) { return null; }
  const v = res && res.value;
  if (!v || !v.err) return null;
  if (v.err === 'BlockhashNotFound') return null; // the node just has not seen the blockhash yet
  return explainSim(v.err, v.logs);
}

/**
 * Sign, send (and keep re-sending) until the chain says confirmed or failed.
 * Throws an Error carrying .signature. .onchainError=true means it landed and FAILED.
 * .timedOut=true means we do not know yet: the tx might still land.
 */
async function landTx(tx, wallet, timeoutMs, opts = {}) {
  tx.sign([wallet]);
  const raw = tx.serialize();
  const signature = signatureOf(tx);
  if (opts.preflight) {
    const bad = await preflight(tx);
    if (bad) { const err = new Error(`buy rejected before sending: ${bad.why}`); err.notSent = true; err.fatal = bad.fatal; throw err; }
  }
  try {
    await broadcast(raw);
  } catch (e) {
    const err = new Error(`send failed: ${e.message}`);
    err.signature = signature;
    err.notSent = true;
    throw err;
  }

  const started = Date.now();
  let lastSend = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(400);
    try {
      const st = await statusOf(signature);
      if (st && st.ok) return signature;
      if (st && !st.ok) {
        const err = new Error(`tx failed on-chain: ${JSON.stringify(st.err)} (${signature})`);
        err.signature = signature;
        err.onchainError = true;
        throw err;
      }
    } catch (e) {
      if (e.onchainError) throw e;
    }
    if (Date.now() - lastSend >= config.REBROADCAST_MS) {
      lastSend = Date.now();
      broadcast(raw).catch(() => {});
    }
  }
  const err = new Error(`not confirmed within ${Math.round(timeoutMs / 1000)}s (${signature})`);
  err.signature = signature;
  err.timedOut = true;
  throw err;
}

/**
 * After a timeout: a Solana tx is only valid ~60-90s, so keep checking for up to maxMs.
 * Returns { ok:true } | { ok:false, reason }.
 */
async function waitForSignature(signature, maxMs = 75000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    try {
      const st = await statusOf(signature);
      if (st && st.ok) return { ok: true };
      if (st && !st.ok) return { ok: false, reason: `failed on-chain ${JSON.stringify(st.err)}` };
    } catch (_) {}
    await sleep(1500);
  }
  return { ok: false, reason: 'never landed (tx expired)' };
}

const solAmount = (sol) => Number(Number(sol).toFixed(6));

/** Buy `sol` SOL worth of `mint`. Resolves to the confirmed signature. */
function buyParams(attempt = 1) {
  return {
    slippage: Math.min(config.BUY_SLIPPAGE_PCT + config.BUY_SLIPPAGE_STEP_PCT * (attempt - 1), config.BUY_SLIPPAGE_MAX_PCT),
    priorityFee: Number((config.BUY_PRIORITY_FEE_SOL * attempt).toFixed(6)),
  };
}

async function buy(wallet, mint, sol, attempt = 1) {
  const p = buyParams(attempt);
  const tx = await buildTx(wallet, {
    action: 'buy',
    mint,
    amount: solAmount(sol),
    denominatedInSol: 'true',
    slippage: p.slippage,
    priorityFee: p.priorityFee,
  });
  return landTx(tx, wallet, config.BUY_CONFIRM_TIMEOUT_MS, { preflight: true });
}

function sellParams(attempt = 1) {
  return {
    slippage: Math.min(config.SELL_SLIPPAGE_PCT + config.SELL_SLIPPAGE_STEP_PCT * (attempt - 1), config.SELL_SLIPPAGE_MAX_PCT),
    priorityFee: Number((config.SELL_PRIORITY_FEE_SOL * attempt).toFixed(6)),
  };
}

/** Sell 100% of the wallet's balance of `mint` (PumpPortal reads the balance when it builds). */
async function sellAll(wallet, mint, attempt = 1) {
  const p = sellParams(attempt);
  const tx = await buildTx(wallet, {
    action: 'sell',
    mint,
    amount: '100%',
    denominatedInSol: 'false',
    slippage: p.slippage,
    priorityFee: p.priorityFee,
  });
  return landTx(tx, wallet, config.SELL_CONFIRM_TIMEOUT_MS);
}

async function routeCheck(wallet, mint, sol) {
  await buildTx(wallet, {
    action: 'buy',
    mint,
    amount: solAmount(sol),
    denominatedInSol: 'true',
    slippage: config.BUY_SLIPPAGE_PCT,
    priorityFee: config.BUY_PRIORITY_FEE_SOL,
  });
  return true;
}

module.exports = { buildTx, landTx, waitForSignature, statusOf, buy, buyParams, preflight, explainSim, sellAll, sellParams, routeCheck };
