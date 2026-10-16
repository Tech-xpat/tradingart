import test from 'node:test';
import assert from 'node:assert';
import { hostAllowed, ipfsPath, candidates } from '../lib/ipfs';
import { riskOf } from '../lib/risk';

const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

test('the hosts pump.fun art really lives on are allowed (including mypinata and cf-ipfs), strangers are not', () => {
  for (const h of ['ipfs.io', 'cf-ipfs.com', 'pump.mypinata.cloud', 'gateway.pinata.cloud', 'dd.dexscreener.com', 'images.pump.fun', 'arweave.net', 'nftstorage.link']) assert.ok(hostAllowed(h), h);
  for (const h of ['evil.example.com', 'ipfs.io.evil.com', 'localhost', '169.254.169.254', 'notipfs.io']) assert.ok(!hostAllowed(h), h);
});

test('ipfs:// links, path gateways and subdomain gateways all resolve to the same /ipfs path', () => {
  assert.strictEqual(ipfsPath(`ipfs://${CID}`), `/ipfs/${CID}`);
  assert.strictEqual(ipfsPath(`https://ipfs.io/ipfs/${CID}`), `/ipfs/${CID}`);
  assert.strictEqual(ipfsPath(`https://pump.mypinata.cloud/ipfs/${CID}?img-width=256`), `/ipfs/${CID}`);
  const B = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  assert.strictEqual(ipfsPath(`https://${B}.ipfs.dweb.link/pic.png`), `/ipfs/${B}/pic.png`);
  assert.strictEqual(ipfsPath('https://example.com/a.png'), null);
});

test('candidates: original link first (if allowed), then public gateways; unknown hosts yield nothing', () => {
  const c = candidates(`https://pump.mypinata.cloud/ipfs/${CID}`);
  assert.strictEqual(c[0], `https://pump.mypinata.cloud/ipfs/${CID}`); assert.ok(c.length >= 5 && c.some((u) => u.startsWith('https://ipfs.io/')));
  assert.deepStrictEqual(candidates('https://evil.example.com/ipfs/' + CID).filter((u) => u.includes('evil')), []);
  assert.deepStrictEqual(candidates('http://ipfs.io/a.png'), [], 'http is never fetched');
  assert.ok(candidates(`ipfs://${CID}`).length >= 5);
});

test('risk bar: deep, busy, older tokens read safer than brand-new thin ones', () => {
  const base: any = { mint: 'm', name: 'n', symbol: 's', uri: null, image: null, description: null, createdAt: Date.now(), kind: 'new', migratedAt: null, mcapSol: 30, progress: 0.02, volSol: 0.5, buys: 1, sells: 0, lastAt: Date.now(), dex: null };
  const fresh = riskOf(base, 150);
  const solid = riskOf({ ...base, createdAt: Date.now() - 3 * 3600e3, dex: { liquidityUsd: 80000, marketCapUsd: 400000, volume: { h1: 60000 }, txns1h: { buys: 120, sells: 70 }, websites: ['https://x.io'], socials: [], pairCreatedAt: Date.now() - 3 * 3600e3 } }, 150);
  assert.strictEqual(fresh.level, 'high'); assert.strictEqual(solid.level, 'low'); assert.ok(solid.score > fresh.score);
  const wash = riskOf({ ...base, dex: { liquidityUsd: 80000, marketCapUsd: 10000, volume: { h1: 900000 }, txns1h: { buys: 300, sells: 300 }, websites: [], socials: [], pairCreatedAt: Date.now() } }, 150);
  assert.ok(wash.reasons.some((r) => /wash/.test(r)), 'volume far above size is flagged');
});
