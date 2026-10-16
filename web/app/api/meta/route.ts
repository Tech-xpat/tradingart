import { NextRequest } from 'next/server';
import { json, fail, rateLimited, ipOf } from '@/lib/api';
import { candidates, fetchFirst, ipfsPath } from '@/lib/ipfs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Token metadata (image, description) for a new launch. The launch event only carries a link to a JSON file on IPFS;
 * browsers hit gateway rate limits and CORS, so we read it here, trying several gateways, and cache the answer.
 */
const cache = new Map<string, { at: number; v: any }>();
const text = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : null);

export async function GET(req: NextRequest) {
  if (rateLimited(`meta:${ipOf(req)}`, 300, 60_000)) return fail('slow down', 429);
  const uri = req.nextUrl.searchParams.get('uri') || '';
  if (!uri || uri.length > 400 || !candidates(uri).length) return fail('bad uri');
  const hit = cache.get(uri);
  if (hit && Date.now() - hit.at < 3600_000) return json(hit.v);
  const empty = { image: null, description: null, name: null, symbol: null };
  const got = await fetchFirst(uri, { accept: 'application/json', maxBytes: 200_000, maxTries: 5 });
  if (!got) return json(empty); // a miss is not cached: the next ask may succeed
  let v: any = empty;
  try {
    const j = JSON.parse(got.buf.toString('utf8'));
    const img = typeof j.image === 'string' ? j.image : null;
    const path = img ? ipfsPath(img) : null; // keep the image as a plain https link the thumbnail route can read
    v = { image: path ? `https://ipfs.io${path}` : (img && /^https:\/\//.test(img) ? img : null), description: text(j.description, 280), name: text(j.name, 40), symbol: text(j.symbol, 16) };
  } catch { /* not JSON */ }
  cache.set(uri, { at: Date.now(), v });
  if (cache.size > 2000) for (const k of cache.keys()) { cache.delete(k); if (cache.size < 1500) break; }
  return json(v);
}
