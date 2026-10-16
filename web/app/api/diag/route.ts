import { NextRequest } from 'next/server';
import { json, rateLimited, ipOf } from '@/lib/api';
import { db } from '@/lib/db';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

/** Open /api/diag in a browser: a plain health check of everything the website depends on. No secrets, only yes/no and status codes. */
async function probe(url: string, init?: RequestInit) {
  const t = Date.now();
  try { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(5000), redirect: 'manual' }); return { ok: r.status < 400 || r.status === 301 || r.status === 302, status: r.status, ms: Date.now() - t }; }
  catch (e: any) { return { ok: false, status: 0, ms: Date.now() - t, error: String(e?.message || e).slice(0, 80) }; }
}

export async function GET(req: NextRequest) {
  if (rateLimited(`diag:${ipOf(req)}`, 20, 60_000)) return json({ error: 'slow down' }, 429);
  let sharpOk = false; try { const sharp = (await import('sharp')).default; await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).webp().toBuffer(); sharpOk = true; } catch { /* not available */ }
  const sb = db();
  const table = async (t: string, col = '*') => { const { error } = await sb.from(t).select(col).limit(1); return error ? `missing or unreadable: ${error.message.slice(0, 80)}` : 'ok'; };
  const [gw1, gw2, gw3, dex, pump, settingsCols, worker, beat] = await Promise.all([
    probe('https://ipfs.io/ipfs/bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku', { method: 'HEAD' }),
    probe('https://cf-ipfs.com/ipfs/bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku', { method: 'HEAD' }),
    probe('https://dweb.link/ipfs/bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku', { method: 'HEAD' }),
    probe('https://api.dexscreener.com/token-profiles/latest/v1'),
    probe('https://pumpportal.fun/'),
    table('art_settings', 'plans,active_plan,public_profile,handle,follow_user_id'),
    table('art_worker'),
    sb.from('art_worker').select('beat,live_enabled,version').eq('id', 'main').maybeSingle().then((r) => r.data, () => null),
  ]);
  const ageSec = beat ? Math.round((Date.now() - Date.parse((beat as any).beat)) / 1000) : null;
  return json({
    website: { LIVE_ENABLED: env.liveEnabled, domain: env.domain },
    thumbnails: { sharp: sharpOk, ipfsGateways: { 'ipfs.io': gw1, 'cf-ipfs.com': gw2, 'dweb.link': gw3 } },
    marketData: { dexscreener: dex, pumpportalSite: pump },
    database: { art_settings_columns: settingsCols, art_worker_table: worker },
    worker: beat ? { lastSeenSecondsAgo: ageSec, online: (ageSec ?? 9999) < 90, liveTradingEnabledOnWorker: (beat as any).live_enabled, version: (beat as any).version } : 'never reported in (or art_worker table missing)',
  });
}
