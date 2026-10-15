import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';

process.env.SESSION_SECRET = 'x'.repeat(40);
process.env.NEXT_PUBLIC_APP_DOMAIN = 'art.test';

import { makeNonce, checkNonce } from '../lib/nonce';
import { parseLimits } from '../lib/limits';
import { sealSecret, newSealKeypair } from '../lib/seal';
import { signInMessage, parseSignIn } from '../lib/messages';

test('lib/seal, lib/verify and lib/messages are byte-identical to the worker copies', () => {
  for (const f of ['seal.js', 'verify.js', 'messages.js']) {
    const web = readFileSync(join(__dirname, '../lib', f), 'utf8');
    const worker = readFileSync(join(__dirname, '../../worker/src/vault', f), 'utf8');
    assert.strictEqual(web, worker, `${f} drifted between web and worker`);
  }
});

test('lib/planrules is byte-identical to the worker copy', () => {
  assert.strictEqual(readFileSync(join(__dirname, '../lib/planrules.js'), 'utf8'), readFileSync(join(__dirname, '../../worker/src/planrules.js'), 'utf8'));
});

test('nonce binds to purpose and wallet and expires', () => {
  const { nonce } = makeNonce('signin', 'WalletA');
  assert.ok(checkNonce('signin', 'WalletA', nonce));
  assert.ok(!checkNonce('signin', 'WalletB', nonce), 'other wallet');
  assert.ok(!checkNonce('withdraw', 'WalletA', nonce), 'other purpose');
  assert.ok(!checkNonce('signin', 'WalletA', nonce.replace(/.$/, 'x')), 'tampered tag');
  const old = makeNonce('signin', 'WalletA', -1000).nonce;
  assert.ok(!checkNonce('signin', 'WalletA', old), 'expired');
  assert.ok(!checkNonce('signin', 'WalletA', ''), 'empty');
});

test('limits validation rejects out-of-range and bad modes', () => {
  assert.ok(parseLimits({ mode: 'easy', maxPositionSol: 0.05, maxDailyLossPct: 20, maxConcurrent: 1 }));
  assert.ok(parseLimits({ mode: 'custom', maxPositionSol: 12, maxDailyLossPct: 20, maxConcurrent: 4 }), 'custom mode, bigger sizes allowed');
  assert.strictEqual(parseLimits({ mode: 'easy', maxPositionSol: 5000, maxDailyLossPct: 20, maxConcurrent: 1 }), null);
  assert.strictEqual(parseLimits({ mode: 'easy', maxPositionSol: 0.05, maxDailyLossPct: 99, maxConcurrent: 1 }), null);
  assert.strictEqual(parseLimits({ mode: 'easy', maxPositionSol: 0.05, maxDailyLossPct: 20, maxConcurrent: 1.5 }), null);
  assert.strictEqual(parseLimits({ mode: 'yolo', maxPositionSol: 0.05, maxDailyLossPct: 20, maxConcurrent: 1 }), null);
  assert.strictEqual(parseLimits({ mode: 'easy', maxPositionSol: 'abc', maxDailyLossPct: 20, maxConcurrent: 1 }), null);
});

test('sign-in message round trips and carries the domain', () => {
  const m = signInMessage({ domain: 'art.test', wallet: 'W', nonce: 'n', issuedAt: 'i', expiresAt: 'e' });
  assert.deepStrictEqual(parseSignIn(m), { domain: 'art.test', wallet: 'W', nonce: 'n', issuedAt: 'i', expiresAt: 'e' });
  assert.ok(m.includes('does not move funds'));
});

test('web can seal but its public key cannot open (only the worker secret can)', () => {
  const k = newSealKeypair();
  const sealed = sealSecret(new Uint8Array(64).fill(7), k.publicKey);
  assert.ok(sealed.ct && sealed.epk && sealed.n);
  const { unsealSecret } = require('../../worker/src/vault/seal');
  assert.deepStrictEqual(Buffer.from(unsealSecret(sealed, k.secretKey)), Buffer.alloc(64, 7));
  assert.throws(() => unsealSecret(sealed, k.publicKey));
});
