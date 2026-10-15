import { NextRequest } from 'next/server';
import { json, fail, rateLimited, ipOf } from '@/lib/api';
import { isMint, tokenViews } from '@/lib/dex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One token by contract address (the search box). */
export async function GET(req: NextRequest) {
  if (rateLimited(`token:${ipOf(req)}`, 40, 60_000)) return fail('slow down', 429);
  const mint = (req.nextUrl.searchParams.get('mint') || '').trim();
  if (!isMint(mint)) return fail('That is not a Solana token address.');
  try {
    const t = (await tokenViews([mint]))[mint];
    if (!t) return fail('No trading pair found for that address yet. A brand-new token can take a minute to appear.', 404);
    return json({ token: t });
  } catch (e: any) { return fail(e?.message || 'market data unavailable', 502); }
}
