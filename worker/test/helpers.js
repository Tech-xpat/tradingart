const nacl = require('tweetnacl');
const bs58mod = require('bs58'); const bs58 = bs58mod.default || bs58mod;
const { Transaction, TransactionInstruction, PublicKey, SystemProgram } = require('@solana/web3.js');

function wallet() { const kp = nacl.sign.keyPair(); return { kp, address: bs58.encode(kp.publicKey) }; }
function signMsg(w, text) { return Buffer.from(nacl.sign.detached(new TextEncoder().encode(text), w.kp.secretKey)).toString('base64'); }
/** What the browser does for wallets that cannot signMessage: sign an unsent memo-only tx. */
function signMemoTx(w, text, { extraIx = false, payer } = {}) {
  const tx = new Transaction();
  tx.feePayer = new PublicKey(payer || w.address);
  tx.recentBlockhash = '11111111111111111111111111111111';
  tx.add(new TransactionInstruction({ keys: [], programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), data: Buffer.from(text, 'utf8') }));
  if (extraIx) tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(w.address), toPubkey: new PublicKey(w.address), lamports: 1 }));
  const msg = tx.serializeMessage();
  tx.addSignature(new PublicKey(w.address), Buffer.from(nacl.sign.detached(new Uint8Array(msg), w.kp.secretKey)));
  return tx.serialize({ requireAllSignatures: false }).toString('base64');
}
module.exports = { wallet, signMsg, signMemoTx, bs58 };
