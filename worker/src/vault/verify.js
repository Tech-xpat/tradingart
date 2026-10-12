/**
 * Verifying "the owner of wallet X really signed this text".
 *
 * Two proof kinds, because not every wallet can sign arbitrary messages (some Ledger setups only sign
 * transactions):
 *   kind 'message': signMessage(utf8 text) -> 64-byte ed25519 signature (base64)
 *   kind 'tx':      an UNSENT transaction whose only instruction is a Memo carrying the text, fee payer =
 *                   the wallet, signed with signTransaction. It has a dummy blockhash and is never broadcast,
 *                   so it can never move funds.
 *
 * This file is byte-identical in web/lib/verify.js and worker/src/vault/verify.js (a test enforces it).
 */
const nacl = require('tweetnacl');
const bs58mod = require('bs58');
const bs58 = bs58mod.default || bs58mod;
const { Transaction, VersionedTransaction, PublicKey } = require('@solana/web3.js');

const MEMO_PROGRAM_IDS = ['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'];
const b64 = (s) => new Uint8Array(Buffer.from(String(s), 'base64'));

function verifyMessage(wallet, message, signatureB64) {
  try {
    const pub = new PublicKey(wallet).toBytes();
    const sig = b64(signatureB64);
    if (sig.length !== 64) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pub);
  } catch (_) {
    return false;
  }
}

/** txB64 = the signed, serialized transaction. True only if: signed by `wallet`, exactly one Memo ix == message, no other ix. */
function verifyMemoTx(wallet, message, txB64) {
  try {
    const raw = Buffer.from(String(txB64), 'base64');
    const walletKey = new PublicKey(wallet);
    let msgBytes, sigs, keys, ixs;
    try {
      const vt = VersionedTransaction.deserialize(new Uint8Array(raw));
      msgBytes = vt.message.serialize();
      sigs = vt.signatures;
      keys = vt.message.staticAccountKeys;
      ixs = vt.message.compiledInstructions.map((i) => ({ program: keys[i.programIdIndex].toBase58(), data: Buffer.from(i.data) }));
      if (vt.message.addressTableLookups && vt.message.addressTableLookups.length) return false;
    } catch (_) {
      const t = Transaction.from(raw);
      msgBytes = t.serializeMessage();
      sigs = t.signatures.map((s) => s.signature);
      keys = t.compileMessage().accountKeys;
      ixs = t.instructions.map((i) => ({ program: i.programId.toBase58(), data: Buffer.from(i.data) }));
    }
    if (!keys.length || keys[0].toBase58() !== walletKey.toBase58()) return false; // fee payer must be the wallet
    if (ixs.length !== 1 || !MEMO_PROGRAM_IDS.includes(ixs[0].program)) return false;
    if (ixs[0].data.toString('utf8') !== message) return false;
    const sig = sigs[0];
    if (!sig || sig.length !== 64) return false;
    return nacl.sign.detached.verify(new Uint8Array(msgBytes), new Uint8Array(sig), walletKey.toBytes());
  } catch (_) {
    return false;
  }
}

/** proof = { kind: 'message'|'tx', signature } (signature = base64 sig, or base64 signed tx for 'tx') */
function verifyProof(wallet, message, proof) {
  if (!proof || typeof proof.signature !== 'string') return false;
  if (proof.kind === 'tx') return verifyMemoTx(wallet, message, proof.signature);
  return verifyMessage(wallet, message, proof.signature);
}

module.exports = { verifyMessage, verifyMemoTx, verifyProof, MEMO_PROGRAM_IDS, bs58 };
