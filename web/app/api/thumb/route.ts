import { NextRequest } from 'next/server';
import { fail, rateLimited, ipOf } from '@/lib/api';
import { db } from '@/lib/db';
import { isMint } from '@/lib/dex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A coin's small picture, made once by the robot and kept in our database. No IPFS gateways are touched when you load the page. */
export async function GET(req: NextRequest) {
  if (rateLimited(`thumb:${ipOf(req)}`, 600, 60_000)) return fail('slow down', 429);
  const mint = req.nextUrl.searchParams.get('mint') || '';
  if (!isMint(mint)) return fail('bad mint', 400);
  const { data } = await db().from('art_charts').select('thumb').eq('mint', mint).maybeSingle();
  if (!data?.thumb) return fail('not ready', 404);
  return new Response(Buffer.from(data.thumb, 'base64'), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400, s-maxage=86400, immutable', 'X-Content-Type-Options': 'nosniff' } });
}
