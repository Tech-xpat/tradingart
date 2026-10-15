import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { fail, rateLimited, ipOf } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Tiny token thumbnails. Token art is often a multi-megabyte image on IPFS; the list only needs a 64px square.
 * We fetch it once, shrink it to ~2 KB WebP and let the CDN / browser keep it for a week.
 * Only known image hosts are allowed so this can never be used as an open proxy.
 */
const HOSTS = [/(^|\.)ipfs\.io$/, /(^|\.)cloudflare-ipfs\.com$/, /(^|\.)dweb\.link$/, /(^|\.)nftstorage\.link$/, /(^|\.)w3s\.link$/, /(^|\.)pinata\.cloud$/, /(^|\.)dexscreener\.com$/, /(^|\.)pump\.fun$/, /(^|\.)arweave\.net$/, /(^|\.)irys\.xyz$/, /(^|\.)ipfs\.sphere\.so$/];
const MAX_BYTES = 6 * 1024 * 1024;

export async function GET(req: NextRequest) {
  if (rateLimited(`img:${ipOf(req)}`, 400, 60_000)) return fail('slow down', 429);
  const raw = req.nextUrl.searchParams.get('u') || '';
  const w = Math.min(160, Math.max(24, Number(req.nextUrl.searchParams.get('w')) || 64));
  let u: URL;
  try { u = new URL(raw); } catch { return fail('bad url'); }
  if (u.protocol !== 'https:' || !HOSTS.some((h) => h.test(u.hostname))) return fail('host not allowed', 403);
  try {
    const r = await fetch(u.toString(), { signal: AbortSignal.timeout(6000), redirect: 'error', headers: { accept: 'image/*' } });
    if (!r.ok) return fail('image unavailable', 404);
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_BYTES) return fail('image too large', 413);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) return fail('image too large', 413);
    const out = await sharp(buf, { limitInputPixels: 40e6, animated: false }).resize(w, w, { fit: 'cover' }).webp({ quality: 55, effort: 3 }).toBuffer();
    return new Response(new Uint8Array(out), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=604800, s-maxage=604800, immutable', 'X-Content-Type-Options': 'nosniff' } });
  } catch {
    return fail('image unavailable', 404);
  }
}
