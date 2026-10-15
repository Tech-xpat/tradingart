/**
 * Live new-token feed (PumpPortal websocket). Keeps a short ring buffer of freshly launched and freshly
 * migrated mints so the scanner can look at coins that are only seconds or minutes old.
 * Auto-reconnects. Never throws into the caller.
 */
const WebSocket = require('ws');
const logger = require('../utils/logger');
const config = require('../config');

const KEEP_MS = 6 * 60 * 60 * 1000;
const MAX_KEEP = 1500;
const mints = new Map(); // mint -> { at, kind: 'new'|'migrated', name, symbol }
let ws = null, backoff = 1000, closed = false, timer = null;

function remember(mint, kind, extra) {
  if (!mint || typeof mint !== 'string') return;
  const prev = mints.get(mint);
  mints.set(mint, { at: prev ? prev.at : Date.now(), kind: prev && kind === 'new' ? prev.kind : kind, name: (extra && extra.name) || (prev && prev.name) || null, symbol: (extra && extra.symbol) || (prev && prev.symbol) || null });
  if (mints.size > MAX_KEEP) { const old = [...mints.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, mints.size - MAX_KEEP); for (const [k] of old) mints.delete(k); }
}

function onMessage(raw) {
  let m; try { m = JSON.parse(String(raw)); } catch (_) { return; }
  if (!m || typeof m !== 'object' || !m.mint) return;
  if (m.txType === 'create') remember(m.mint, 'new', m);
  else if (m.txType === 'migrate') remember(m.mint, 'migrated', m);
}

function connect() {
  if (closed || !config.STREAM_ENABLED) return;
  try { ws = new WebSocket(config.STREAM_URL); } catch (e) { return retry(e.message); }
  ws.on('open', () => {
    backoff = 1000;
    try { ws.send(JSON.stringify({ method: 'subscribeNewToken' })); ws.send(JSON.stringify({ method: 'subscribeMigration' })); } catch (_) {}
    logger.info('new-token stream connected');
  });
  ws.on('message', onMessage);
  ws.on('error', (e) => logger.warn(`new-token stream error: ${e.message}`));
  ws.on('close', () => retry('closed'));
}
function retry(why) {
  if (closed) return;
  clearTimeout(timer);
  timer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 60000);
  if (why !== 'closed') logger.warn(`new-token stream retry: ${why}`);
}

function start() { closed = false; connect(); }
function stop() { closed = true; clearTimeout(timer); try { ws && ws.terminate(); } catch (_) {} }

/** Mints first seen between minAgeSec and maxAgeSec ago (maxAgeSec null = no upper bound), newest first. */
function recent(minAgeSec, maxAgeSec, limit = 60) {
  const now = Date.now(), out = [];
  for (const [mint, v] of mints) {
    const age = (now - v.at) / 1000;
    if (age < minAgeSec || (maxAgeSec != null && age > maxAgeSec) || now - v.at > KEEP_MS) continue;
    out.push({ mint, at: v.at });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit).map((x) => x.mint);
}
function _feed(msg) { onMessage(JSON.stringify(msg)); } // tests

module.exports = { start, stop, recent, _feed, size: () => mints.size };
