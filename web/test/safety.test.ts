import { test } from 'node:test';
import assert from 'node:assert';
import { assess, type SafetyInput } from '../lib/safety';

const base: SafetyInput = { mintAuthority: null, freezeAuthority: null, known: true, top1Pct: 3, top10Pct: 20, devKnown: true, devPct: 2, text: 'A friendly frog coin' };
const lv = (i: Partial<SafetyInput>) => Object.fromEntries(assess({ ...base, ...i }).map((f) => [f.key, f.level]));

test('a clean coin is all green', () => { assert.deepStrictEqual(lv({}), { mint: 'ok', freeze: 'ok', holders: 'ok', dev: 'ok', phish: 'ok' }); });
test('active authorities are red; unreadable settings are unknown, never green', () => {
  assert.strictEqual(lv({ mintAuthority: 'X' }).mint, 'bad'); assert.strictEqual(lv({ freezeAuthority: 'X' }).freeze, 'bad');
  assert.strictEqual(lv({ known: false }).mint, 'unknown'); assert.strictEqual(lv({ known: false }).freeze, 'unknown');
});
test('whales and a heavy dev bag escalate', () => {
  assert.strictEqual(lv({ top1Pct: 14, top10Pct: 30 }).holders, 'warn'); assert.strictEqual(lv({ top1Pct: 30, top10Pct: 50 }).holders, 'bad');
  assert.strictEqual(lv({ devPct: 8 }).dev, 'warn'); assert.strictEqual(lv({ devPct: 20 }).dev, 'bad');
  assert.match(assess({ ...base, devPct: 0 }).find((f) => f.key === 'dev')!.text, /none of the token/);
  assert.strictEqual(lv({ devKnown: false }).dev, 'unknown'); assert.strictEqual(lv({ top10Pct: null }).holders, 'unknown');
});
test('scam wording and bait links are flagged; empty text is unknown', () => {
  assert.strictEqual(lv({ text: 'FREE airdrop! connect wallet to claim now' }).phish, 'bad');
  assert.strictEqual(lv({ text: 'join https://bit.ly/abc' }).phish, 'bad');
  assert.strictEqual(lv({ text: '' }).phish, 'unknown');
});
