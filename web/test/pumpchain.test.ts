import test from 'node:test';
import assert from 'node:assert';
process.env.SESSION_SECRET = 'x'.repeat(40);
import { parseTrade, curveOf } from '../lib/pumpchain';

const MINT = 'So11111111111111111111111111111111111111112';
const curve = curveOf(MINT);
const tx = (over: any) => ({ blockTime: 1760000000, transaction: { signatures: ['SIG1'], message: { accountKeys: ['TraderWallet1111111111111111111111111111111', curve, 'Other'] } },
  meta: { err: null, preBalances: [5e9, 10e9, 1], postBalances: [4.4e9, 10.5e9, 1], preTokenBalances: [{ mint: MINT, owner: curve, uiTokenAmount: { uiAmount: 800000000 } }], postTokenBalances: [{ mint: MINT, owner: curve, uiTokenAmount: { uiAmount: 799000000 } }] }, ...over });

test('a buy: SOL into the curve, tokens out of it', () => {
  const t = parseTrade(tx({}), MINT, curve)!;
  assert.strictEqual(t.side, 'buy'); assert.ok(Math.abs(t.sol - 0.5) < 1e-9); assert.strictEqual(t.who, 'TraderWallet1111111111111111111111111111111');
  assert.ok(Math.abs(t.mcapSol - (0.5 / 1000000) * 1e9) < 1e-6, 'price = 0.5 SOL / 1M tokens, times the 1B supply');
  assert.strictEqual(t.t, 1760000000000);
});
test('a sell: SOL out of the curve, tokens back in', () => {
  const t = parseTrade(tx({ meta: { err: null, preBalances: [5e9, 10e9, 1], postBalances: [5.4e9, 9.6e9, 1], preTokenBalances: [{ mint: MINT, owner: curve, uiTokenAmount: { uiAmount: 799000000 } }], postTokenBalances: [{ mint: MINT, owner: curve, uiTokenAmount: { uiAmount: 799800000 } }] } }), MINT, curve)!;
  assert.strictEqual(t.side, 'sell'); assert.ok(Math.abs(t.sol - 0.4) < 1e-9);
});
test('failed transactions, other coins and non-trades are ignored', () => {
  assert.strictEqual(parseTrade(tx({ meta: { ...tx({}).meta, err: { InstructionError: [0, 'x'] } } }), MINT, curve), null);
  assert.strictEqual(parseTrade(tx({ transaction: { signatures: ['S'], message: { accountKeys: ['A', 'B'] } } }), MINT, curve), null);
  assert.strictEqual(parseTrade(tx({ meta: { err: null, preBalances: [1, 5e9], postBalances: [1, 6e9], preTokenBalances: [], postTokenBalances: [] } }), MINT, curve), null);
});
test('versioned transactions with lookup tables are read too', () => {
  const t = tx({}); (t.transaction.message as any).accountKeys = ['TraderWallet1111111111111111111111111111111', 'Other']; (t.meta as any).loadedAddresses = { writable: [curve], readonly: [] };
  t.meta.preBalances = [5e9, 1, 10e9]; t.meta.postBalances = [4.4e9, 1, 10.5e9];
  assert.strictEqual(parseTrade(t, MINT, curve)!.side, 'buy');
});
