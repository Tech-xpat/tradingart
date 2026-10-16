/**
 * Withdrawals. The web app only RECORDS the user's signed request; the worker re-verifies everything and is
 * the only component that can move vault funds. The destination is inside the message the owner signed, so
 * nothing (not the web app, not the database) can change it afterwards.
 */
const { VersionedTransaction, TransactionMessage, SystemProgram, PublicKey } = require('@solana/web3.js');
const { parseWithdraw } = require('../vault/messages');
const { verifyProof } = require('../vault/verify');
const { rpc } = require('../solana/rpc');

const FEE_LAMPORTS = 5000n;
const RENT_MIN = 890880n; // a system account may hold 0 or at least this much; anything in between is refused by the network
const MAX_AGE_MS = 20 * 60 * 1000;

/** Pure check. Returns { ok:true, lamports:bigint|null } or { ok:false, reason }. */
function validateWithdrawal({ req, user, vault, now = Date.now() }) {
  if (!user || !vault) return { ok: false, reason: 'no vault for this user' };
  const m = parseWithdraw(req.message);
  if (m.wallet !== user.wallet) return { ok: false, reason: 'message wallet does not match the account' };
  if (!m.to || m.to !== req.to_address) return { ok: false, reason: 'destination does not match what the owner signed' };
  try { if (new PublicKey(m.to).toBytes().length !== 32) throw new Error('len'); } catch (_) { return { ok: false, reason: 'destination is not a valid Solana address' }; }
  if (m.to === vault.address) return { ok: false, reason: 'destination cannot be the vault itself' };
  if (m.vault !== vault.address) return { ok: false, reason: 'message vault does not match' };
  const issued = Date.parse(m.issuedAt);
  const created = Date.parse(req.created_at);
  if (!Number.isFinite(issued) || Math.abs(created - issued) > MAX_AGE_MS || now - created > 6 * 60 * 60 * 1000) return { ok: false, reason: 'signature is too old, sign again' };
  if (!verifyProof(user.wallet, req.message, { kind: req.sig_kind, signature: req.signature })) return { ok: false, reason: 'signature does not verify' };
  let lamports = null;
  if (m.amount !== 'ALL') {
    const sol = Number(String(m.amount).replace(' SOL', ''));
    if (!(sol > 0) || !Number.isFinite(sol)) return { ok: false, reason: 'bad amount' };
    lamports = BigInt(Math.round(sol * 1e9));
    if (req.amount_lamports != null && BigInt(req.amount_lamports) !== lamports) return { ok: false, reason: 'amount does not match the signed message' };
  }
  return { ok: true, lamports, to: m.to };
}

async function sendSol(signer, toAddress, lamports, deps) {
  const { blockhash } = await rpc((c) => c.getLatestBlockhash('confirmed'));
  const msg = new TransactionMessage({
    payerKey: signer.publicKey, recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(toAddress), lamports })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  return deps.swap.landTx(tx, signer, 30000);
}

/** Run one claimed withdrawal. Never throws: always writes a final status. */
async function processWithdrawal(req, { db, deps, getSigner, hasOpenPositions }) {
  const fail = (status, error) => db.finishWithdrawal(req.id, { status, error });
  try {
    const user = (await db.users([req.user_id])).get(req.user_id);
    const vault = (await db.vaults([req.user_id])).get(req.user_id);
    const v = validateWithdrawal({ req, user, vault: vault && { address: vault.address } });
    if (!v.ok) return fail('rejected', v.reason);
    if (await hasOpenPositions(req.user_id)) return fail('rejected', 'close open trades first (Stop and sell all), then withdraw');
    const bal = await deps.chain.getSolLamports(vault.address);
    let lamports = v.lamports == null ? bal - FEE_LAMPORTS : v.lamports;
    if (lamports <= 0n) return fail('rejected', 'nothing to withdraw');
    if (lamports + FEE_LAMPORTS > bal) return fail('rejected', 'amount is more than the vault balance (network fee included)');
    const left = bal - lamports - FEE_LAMPORTS;
    // the network refuses a transfer that leaves a tiny non-zero balance; never send more than the owner signed, so say so
    if (left > 0n && left < RENT_MIN) return fail('rejected', 'that would leave less than 0.00089 SOL in the vault, which Solana does not allow. Withdraw a little less, or withdraw everything (leave the amount blank).');
    const signer = await getSigner(req.user_id, vault);
    const sig = await sendSol(signer, v.to, lamports, deps);
    return db.finishWithdrawal(req.id, { status: 'done', tx_sig: sig, amount_lamports: String(lamports) });
  } catch (e) {
    return fail('failed', String((e && e.message) || e).slice(0, 300));
  }
}

module.exports = { validateWithdrawal, processWithdrawal, FEE_LAMPORTS, RENT_MIN };
