const test = require('node:test');
const assert = require('node:assert');
const nacl = require('tweetnacl');
const { newSealKeypair, sealSecret, unsealSecret } = require('../src/vault/seal');

test('seal then unseal returns the same 64-byte secret key', () => {
  const k = newSealKeypair();
  const vault = nacl.sign.keyPair();
  const sealed = sealSecret(vault.secretKey, k.publicKey);
  assert.deepStrictEqual(Object.keys(sealed).sort(), ['ct', 'epk', 'n', 'v']);
  assert.deepStrictEqual(Buffer.from(unsealSecret(sealed, k.secretKey)), Buffer.from(vault.secretKey));
});
test('the public key alone cannot open a sealed vault, and a wrong key fails', () => {
  const k = newSealKeypair(), other = newSealKeypair();
  const sealed = sealSecret(nacl.sign.keyPair().secretKey, k.publicKey);
  assert.throws(() => unsealSecret(sealed, other.secretKey));
  assert.throws(() => unsealSecret(sealed, k.publicKey)); // public key is not the secret
});
test('tampering with the ciphertext is detected', () => {
  const k = newSealKeypair();
  const sealed = sealSecret(nacl.sign.keyPair().secretKey, k.publicKey);
  const ct = Buffer.from(sealed.ct, 'base64'); ct[5] ^= 1;
  assert.throws(() => unsealSecret({ ...sealed, ct: ct.toString('base64') }, k.secretKey));
});
test('every seal uses a fresh ephemeral key and nonce', () => {
  const k = newSealKeypair(); const sk = nacl.sign.keyPair().secretKey;
  const a = sealSecret(sk, k.publicKey), b = sealSecret(sk, k.publicKey);
  assert.notStrictEqual(a.epk, b.epk); assert.notStrictEqual(a.n, b.n); assert.notStrictEqual(a.ct, b.ct);
});
