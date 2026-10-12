const test = require('node:test');
const assert = require('node:assert');
const { wallet, signMsg, signMemoTx } = require('./helpers');
const { verifyProof, verifyMessage, verifyMemoTx } = require('../src/vault/verify');
const m = require('../src/vault/messages');

test('signMessage proof: valid, wrong text, wrong wallet', () => {
  const a = wallet(), b = wallet(); const text = 'hello ART';
  const sig = signMsg(a, text);
  assert.ok(verifyMessage(a.address, text, sig));
  assert.ok(!verifyMessage(a.address, text + '!', sig));
  assert.ok(!verifyMessage(b.address, text, sig));
  assert.ok(!verifyMessage(a.address, text, 'AAAA'));
});
test('Ledger-style unsent memo transaction proof', () => {
  const a = wallet(), b = wallet(); const text = m.withdrawMessage({ wallet: a.address, vault: b.address, amount: 'ALL', nonce: 'n1', issuedAt: new Date().toISOString() });
  const tx = signMemoTx(a, text);
  assert.ok(verifyProof(a.address, text, { kind: 'tx', signature: tx }));
  assert.ok(!verifyProof(a.address, text + 'x', { kind: 'tx', signature: tx }), 'memo text must match');
  assert.ok(!verifyProof(b.address, text, { kind: 'tx', signature: tx }), 'must be signed by the claimed wallet');
});
test('a transaction with any extra instruction (it could move funds) is refused', () => {
  const a = wallet(); const text = 'x';
  assert.ok(!verifyMemoTx(a.address, text, signMemoTx(a, text, { extraIx: true })));
});
test('a memo tx whose fee payer is someone else is refused', () => {
  const a = wallet(), b = wallet(); const text = 'x';
  assert.ok(!verifyMemoTx(a.address, text, signMemoTx(b, text))); // valid tx, but signed by b, claimed as a
});
test('messages round-trip through their parsers', () => {
  const a = wallet(), v = wallet();
  const c = m.consentMessage({ wallet: a.address, vault: v.address, mode: 'easy', maxPositionSol: 0.05, maxDailyLossPct: 20, maxConcurrent: 1, nonce: 'abc', issuedAt: '2026-10-12T00:00:00.000Z' });
  assert.deepStrictEqual(m.parseConsent(c), { wallet: a.address, vault: v.address, mode: 'easy', maxPositionSol: 0.05, maxDailyLossPct: 20, maxConcurrent: 1, nonce: 'abc', issuedAt: '2026-10-12T00:00:00.000Z' });
  const w = m.withdrawMessage({ wallet: a.address, vault: v.address, amount: '0.5 SOL', nonce: 'q', issuedAt: 'T' });
  assert.deepStrictEqual(m.parseWithdraw(w), { wallet: a.address, vault: v.address, amount: '0.5 SOL', to: a.address, nonce: 'q', issuedAt: 'T' });
  const s = m.signInMessage({ domain: 'art.example', wallet: a.address, nonce: 'z', issuedAt: 'I', expiresAt: 'E' });
  assert.deepStrictEqual(m.parseSignIn(s), { domain: 'art.example', wallet: a.address, nonce: 'z', issuedAt: 'I', expiresAt: 'E' });
});
