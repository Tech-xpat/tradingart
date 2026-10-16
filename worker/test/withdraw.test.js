const test = require('node:test');
const assert = require('node:assert');
const { wallet, signMsg, signMemoTx } = require('./helpers');
const m = require('../src/vault/messages');
const { validateWithdrawal, processWithdrawal } = require('../src/trading/withdraw');

function mk(over = {}) {
  const owner = wallet(), vault = wallet(), attacker = wallet();
  const now = new Date();
  const text = m.withdrawMessage({ wallet: owner.address, vault: vault.address, amount: over.amount || '0.5 SOL', to: over.to, nonce: 'n' + Math.random(), issuedAt: now.toISOString() });
  const req = { message: text, signature: signMsg(owner, text), sig_kind: 'message', to_address: over.to || owner.address, created_at: now.toISOString(), amount_lamports: null, ...over.req };
  return { owner, vault, attacker, req, user: { wallet: owner.address }, v: { address: vault.address }, text, now };
}

test('a correctly signed withdrawal to the owner validates', () => {
  const t = mk(); const r = validateWithdrawal({ req: t.req, user: t.user, vault: t.v });
  assert.ok(r.ok); assert.strictEqual(r.lamports, 500000000n);
});
test('ALL means null lamports (worker computes balance minus fee)', () => {
  const t = mk({ amount: 'ALL' }); const r = validateWithdrawal({ req: t.req, user: t.user, vault: t.v });
  assert.ok(r.ok); assert.strictEqual(r.lamports, null);
});
test('a destination edited in the DB row after signing is rejected', () => {
  const t = mk(); const r = validateWithdrawal({ req: { ...t.req, to_address: t.attacker.address }, user: t.user, vault: t.v });
  assert.ok(!r.ok); assert.match(r.reason, /does not match/);
});
test('a message that names a different destination is rejected', () => {
  const t = mk();
  const text = t.text.replace(`To: ${t.owner.address}`, `To: ${t.attacker.address}`);
  const r = validateWithdrawal({ req: { ...t.req, message: text, signature: signMsg(t.owner, text) }, user: t.user, vault: t.v });
  assert.ok(!r.ok);
});
test('signature by someone else is rejected', () => {
  const t = mk(); const r = validateWithdrawal({ req: { ...t.req, signature: signMsg(t.attacker, t.text) }, user: t.user, vault: t.v });
  assert.ok(!r.ok); assert.match(r.reason, /verify/);
});
test('wrong vault in the message is rejected', () => {
  const t = mk(); const r = validateWithdrawal({ req: t.req, user: t.user, vault: { address: t.attacker.address } });
  assert.ok(!r.ok);
});
test('old signatures are rejected', () => {
  const t = mk(); const old = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const r = validateWithdrawal({ req: { ...t.req, created_at: old }, user: t.user, vault: t.v });
  assert.ok(!r.ok);
});
test('amount edited in the DB row differs from the signed amount', () => {
  const t = mk(); const r = validateWithdrawal({ req: { ...t.req, amount_lamports: '900000000' }, user: t.user, vault: t.v });
  assert.ok(!r.ok);
});
test('tx-kind proof works too', () => {
  const t = mk(); const r = validateWithdrawal({ req: { ...t.req, sig_kind: 'tx', signature: signMemoTx(t.owner, t.text) }, user: t.user, vault: t.v });
  assert.ok(r.ok);
});

test('the owner may sign a withdrawal to ANY valid Solana address, and that address is what gets paid', () => {
  const other = wallet(); const t = mk({ to: other.address });
  const r = validateWithdrawal({ req: t.req, user: t.user, vault: t.v });
  assert.ok(r.ok, r.reason); assert.strictEqual(r.to, other.address);
});
test('a withdrawal to a malformed address is rejected', () => {
  const t = mk({ to: 'not-an-address' }); const r = validateWithdrawal({ req: t.req, user: t.user, vault: t.v });
  assert.ok(!r.ok); assert.match(r.reason, /valid Solana address/);
});
test('a withdrawal to the vault itself is rejected', () => {
  const t0 = mk(); const t = mk({ to: t0.vault.address }); // different vault object, so build explicitly
  const text = m.withdrawMessage({ wallet: t.owner.address, vault: t.vault.address, amount: '0.5 SOL', to: t.vault.address, nonce: 'z', issuedAt: t.now.toISOString() });
  const r = validateWithdrawal({ req: { ...t.req, message: text, signature: signMsg(t.owner, text), to_address: t.vault.address }, user: t.user, vault: t.v });
  assert.ok(!r.ok); assert.match(r.reason, /vault itself/);
});

test('a withdrawal that would strand a dust balance is refused with a clear reason, never sent', async () => {
  const t = mk({ amount: '0.5 SOL' });
  let finished = null, sent = false;
  const db = { users: async () => new Map([['u', { wallet: t.owner.address }]]), vaults: async () => new Map([['u', { address: t.v.address }]]), finishWithdrawal: async (id, p) => { finished = p; } };
  const deps = { chain: { getSolLamports: async () => 500_000_000n + 5000n + 100_000n }, swap: { landTx: async () => { sent = true; return 'sig'; } } };
  await processWithdrawal({ ...t.req, id: 'w1', user_id: 'u' }, { db, deps, getSigner: async () => { throw new Error('should not sign'); }, hasOpenPositions: async () => false });
  assert.strictEqual(finished.status, 'rejected'); assert.match(finished.error, /0\.00089/); assert.strictEqual(sent, false);
});
