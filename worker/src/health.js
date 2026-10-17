/**
 * What the robot can actually reach right now. Probed every minute and written into the heartbeat, so the website can
 * show a plain "ready / not ready" checklist instead of the robot silently not trading.
 */
const config = require('./config');
const logger = require('./utils/logger');
const stream = require('./scanner/stream');
const collector = require('./data/collector');
const { rpc } = require('./solana/rpc');

let snap = { at: 0 };

async function probe() {
  const out = { at: Date.now(), version: config.VERSION };
  const t0 = Date.now();
  try { await rpc((c) => c.getLatestBlockhash()); out.rpc = { ok: true, ms: Date.now() - t0 }; }
  catch (e) { out.rpc = { ok: false, error: String(e.message).slice(0, 80) }; }
  const t1 = Date.now();
  try {
    // any HTTP answer means the trade builder is reachable (an empty request is refused with a 4xx, which is fine)
    const r = await fetch(config.PUMPPORTAL_TRADE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000) });
    out.tradeApi = { ok: r.status < 500, status: r.status, ms: Date.now() - t1 };
  } catch (e) { out.tradeApi = { ok: false, error: String(e.message).slice(0, 80) }; }
  const st = stream.status();
  out.feed = { ok: st.connected && st.lastMsgAgeSec != null && st.lastMsgAgeSec < 120, connected: st.connected, lastMsgAgeSec: st.lastMsgAgeSec };
  out.coins = collector.trackedMints().length;
  out.ownDataOnly = process.env.OWN_DATA_ONLY === 'true';
  snap = out;
  return out;
}
const snapshot = () => snap;
let timer = null;
function start() { probe().catch((e) => logger.warn('health probe:', e.message)); timer = setInterval(() => probe().catch(() => {}), 60000); timer.unref(); }
module.exports = { start, probe, snapshot };
