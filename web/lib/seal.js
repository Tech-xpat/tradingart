/**
 * Sealed vault keys.
 *
 * The web app creates each user's vault keypair and seals the 64-byte secret key to the WORKER's
 * public key (X25519 via tweetnacl box, with a throwaway sender key). What lands in the database is
 * { v, epk, n, ct }. The web server holds only the worker PUBLIC key, so it can never open a vault;
 * only the worker, which holds VAULT_SEAL_SECRET, can.
 *
 * This file is byte-identical in web/lib/seal.js and worker/src/vault/seal.js (a test enforces it).
 */
const nacl = require('tweetnacl');

const VERSION = 1;
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s), 'base64'));

function newSealKeypair() {
  const kp = nacl.box.keyPair();
  return { publicKey: b64(kp.publicKey), secretKey: b64(kp.secretKey) };
}

function sealSecret(secretKey64, sealPublicB64) {
  const pub = unb64(sealPublicB64);
  if (pub.length !== nacl.box.publicKeyLength) throw new Error('bad seal public key');
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ct = nacl.box(Uint8Array.from(secretKey64), nonce, pub, eph.secretKey);
  eph.secretKey.fill(0);
  return { v: VERSION, epk: b64(eph.publicKey), n: b64(nonce), ct: b64(ct) };
}

function unsealSecret(sealed, sealSecretB64) {
  if (!sealed || sealed.v !== VERSION) throw new Error('unknown seal version');
  const sec = unb64(sealSecretB64);
  if (sec.length !== nacl.box.secretKeyLength) throw new Error('bad seal secret key');
  const out = nacl.box.open(unb64(sealed.ct), unb64(sealed.n), unb64(sealed.epk), sec);
  sec.fill(0);
  if (!out) throw new Error('could not open sealed vault key');
  return out;
}

module.exports = { newSealKeypair, sealSecret, unsealSecret };
