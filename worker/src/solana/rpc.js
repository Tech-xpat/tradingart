/**
 * Free-RPC pool with failover.
 *
 * Public Solana RPCs rate-limit hard, so every read goes through rpc(fn): it tries the
 * next endpoint when one is rate-limited / down and parks the bad one for a while.
 * Sends go to every endpoint at once (same signed tx, so it can only land once).
 */
const { Connection } = require('@solana/web3.js');
const bs58mod = require('bs58');
const bs58 = bs58mod.default || bs58mod;
const config = require('../config');

const CALL_TIMEOUT_MS = 12000;

const endpoints = config.RPC_URLS.map((url) => ({
  url,
  label: hostOf(url),
  conn: new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true }),
  badUntil: 0,
  fails: 0,
}));

let cursor = 0;

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return 'rpc';
  }
}

function msgOf(e) {
  return String((e && e.message) || e || '');
}

function isRateLimit(e) {
  return /429|rate.?limit|too many requests/i.test(msgOf(e));
}

function isTransient(e) {
  return (
    isRateLimit(e) ||
    /fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|timeout|timed out|aborted|\b(401|403|500|502|503|504)\b|Bad Gateway|Service Unavailable|Forbidden/i.test(
      msgOf(e)
    )
  );
}

function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error('rpc timeout')), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

/** Run fn(connection) on the first healthy endpoint; fail over on transient errors. */
async function rpc(fn) {
  const n = endpoints.length;
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

/** Send the same signed tx through every endpoint. Returns the signature. */
async function broadcast(rawTx) {
  const results = await Promise.allSettled(
    endpoints.map((ep) => ep.conn.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 }))
  );
  const ok = results.find((r) => r.status === 'fulfilled');
  if (ok) return ok.value;
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
