/**
 * Read what a transaction REALLY did to the wallet, straight from its on-chain meta.
 * No quotes, no estimates: lamport and token balances before vs after.
 */
const { rpc } = require('./rpc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function keyStr(k) {
  if (!k) return '';
  if (typeof k === 'string') return k;
  const pk = k.pubkey || k;
  return typeof pk === 'string' ? pk : pk.toBase58();
}

function accountKeys(tx) {
  return (tx.transaction.message.accountKeys || []).map(keyStr);
}

/**
 * Pure function. tx is a parsed transaction (getParsedTransaction, maxSupportedTransactionVersion 0).
 * Returns the wallet's exact SOL change (fees included) and exact change of `mint`.
 */
function computeFill(tx, owner, mint) {
  if (!tx || !tx.meta || !tx.transaction) return null;
  const meta = tx.meta;
  const keys = accountKeys(tx);
  const idx = keys.indexOf(owner);

  let solDeltaLamports = null;
  if (idx >= 0 && meta.preBalances && meta.postBalances) {
    solDeltaLamports = BigInt(meta.postBalances[idx]) - BigInt(meta.preBalances[idx]);
  }

  let decimals = null;
  const sum = (arr) => {
    let total = 0n;
    for (const b of arr || []) {
      if (b.owner === owner && b.mint === mint) {
        total += BigInt(b.uiTokenAmount.amount);
        decimals = b.uiTokenAmount.decimals;
      }
    }
    return total;
  };
  const tokenDeltaRaw = sum(meta.postTokenBalances) - sum(meta.preTokenBalances);

  return {
    failed: meta.err != null,
    err: meta.err || null,
    solDeltaLamports,
    tokenDeltaRaw,
    decimals,
    feeLamports: BigInt(meta.fee || 0),
  };
}

/** Fetch the tx (waiting for the RPC to index it) and compute the fill. null if it never shows up. */
async function readFill(signature, owner, mint, { tries = 12, delayMs = 700 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const tx = await rpc((c) =>
        c.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
      );
      if (tx) return computeFill(tx, owner, mint);
    } catch (_) {
      /* keep trying */
    }
    await sleep(delayMs);
  }
  return null;
}

module.exports = { computeFill, readFill, keyStr, accountKeys };
