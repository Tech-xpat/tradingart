import { NextRequest } from 'next/server';
import { json, fail, rateLimited, ipOf } from '@/lib/api';
import { isMint, tokenViews } from '@/lib/dex';
import { solUsd } from '@/lib/price';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Market data for up to 60 mints at once (used to keep the live token lists fresh). Public, rate limited. */
export async function GET(req: NextRequest) {
  if (rateLimited(`tokens:${ipOf(req)}`, 90, 60_000)) return fail('slow down', 429);
  const mints = [...new Set((req.nextUrl.searchParams.get('mints') || '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (!mints.length || mints.length > 60 || !mints.every(isMint)) return fail('give 1 to 60 token addresses');
  try { return json({ tokens: await tokenViews(mints), solUsd: await solUsd() }); } catch (e: any) { return fail(e?.message || 'market data unavailable', 502); }
}
