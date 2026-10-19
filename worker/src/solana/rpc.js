/**
 * RPC pool. Sends go to every endpoint. Failures are logged per host.
 */
const { Connection } = require('@solana/web3.js');
const bs58mod = require('bs58');
const bs58 = bs58mod.default || bs58mod;
const config = require('../config');

const CALL_TIMEOUT_MS = 12000;

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return 'rpc'; }
}
function msgOf(e) { return String((e && e.message) || e || ''); }
function isRateLimit(e) { return /429|rate.?limit|too many requests/i.test(msgOf(e)); }
function isTransient(e) {
  return isRateLimit(e) || /fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|timeout|timed out|aborted|\b(401|403|500|502|503|504)\b|Bad Gateway|Service Unavailable|Forbidden/i.test(msgOf(e));
}
function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, reject) => { t = setTimeout(() => reject(new Error('rpc timeout')), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

const endpoints = (config.RPC_URLS || []).map((url) => ({
  url,
  label: hostOf(url),
  conn: new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true }),
  badUntil: 0,
  fails: 0,
}));

console.log(`[rpc] endpoints: ${endpoints.map((e) => e.label).join(', ') || 'NONE'}`);

let cursor = 0;

async function rpc(fn) {
  const n = endpoints.length;
  if (!n) throw new Error('no RPC endpoints configured');
  const start = cursor;
  cursor = (cursor + 1) % n;
  const order = [];
  for (let i = 0; i < n; i++) order.push(endpoints[(start + i) % n]);
  const t = Date.now();
  const healthy = order.filter((e) => e.badUntil <= t);
  const tryList = healthy.length ? healthy.concat(order.filter((e) => e.badUntil > t)) : order;
  let lastErr;
  for (const ep of tryList) {
    try {
      const out = await withTimeout(Promise.resolve(fn(ep.conn)), CALL_TIMEOUT_MS);
      ep.fails = 0;
      return out;
    } catch (e) {
      lastErr = e;
      if (!isTransient(e)) throw e;
      ep.fails += 1;
      ep.badUntil = Date.now() + (isRateLimit(e) ? 30000 : 10000);
    }
  }
  throw lastErr || new Error('no RPC endpoints configured');
}

async function broadcast(rawTx) {
  const results = await Promise.allSettled(
    endpoints.map((ep) => ep.conn.sendRawTransaction(rawTx, {
      skipPreflight: false,
      maxRetries: 5,
      preflightCommitment: 'processed',
    }).then((sig) => ({ host: ep.label, sig })))
  );
  const ok = results.find((r) => r.status === 'fulfilled');
  const fails = results
    .map((r, i) => (r.status === 'rejected' ? `${endpoints[i].label}: ${msgOf(r.reason).slice(0, 180)}` : null))
    .filter(Boolean);
  if (fails.length) console.log(`[rpc] broadcast reject ${fails.join(' | ')}`);
  if (ok) {
    console.log(`[rpc] broadcast ok via ${ok.value.host}`);
    return ok.value.sig;
  }
  throw results[0].reason;
}

function signatureOf(tx) {
  return bs58.encode(tx.signatures[0]);
}

function status() {
  return endpoints.map((e) => ({ host: e.label, fails: e.fails, parked: e.badUntil > Date.now() }));
}

function getConnection() {
  const t = Date.now();
  return (endpoints.find((e) => e.badUntil <= t) || endpoints[0]).conn;
}

module.exports = { rpc, broadcast, signatureOf, status, getConnection, endpoints, isTransient, isRateLimit };
