import { NextRequest } from 'next/server';
import { json, fail, rateLimited, ipOf, siteDomain } from '@/lib/api';
import { makeNonce } from '@/lib/nonce';
import { isAddress } from '@/lib/proof';
import { signInMessage } from '@/lib/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Step 1 of sign-in: the server writes the exact text the wallet will show. */
export async function GET(req: NextRequest) {
  if (rateLimited(`nonce:${ipOf(req)}`, 30, 60_000)) return fail('slow down', 429);
  const wallet = req.nextUrl.searchParams.get('wallet');
  if (!isAddress(wallet)) return fail('bad wallet');
  const { nonce, expiresAt } = makeNonce('signin', wallet, 5 * 60 * 1000);
  const issuedAt = new Date().toISOString();
  return json({ message: signInMessage({ domain: siteDomain(req), wallet, nonce, issuedAt, expiresAt }) });
}
