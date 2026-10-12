import { NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { json, fail, rateLimited, ipOf, sameOrigin } from '@/lib/api';
import { db, must } from '@/lib/db';
import { checkNonce } from '@/lib/nonce';
import { parseProof, proofOk, isAddress } from '@/lib/proof';
import { parseSignIn, signInMessage } from '@/lib/messages';
import { COOKIE, cookieOptions, createSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Step 2: the signed text comes back. Proves the caller controls the wallet. Moves no funds. */
export async function POST(req: NextRequest) {
  try {
    if (!sameOrigin(req)) return fail('bad origin', 403);
    if (rateLimited(`verify:${ipOf(req)}`, 20, 60_000)) return fail('slow down', 429);
    const body = await req.json().catch(() => null);
    const wallet = body?.wallet, message = body?.message, proof = parseProof(body?.proof);
    if (!isAddress(wallet) || typeof message !== 'string' || !proof) return fail('bad request');

    const m = parseSignIn(message);
    if (m.wallet !== wallet) return fail('wallet mismatch');
    if (m.domain !== env.domain) return fail('wrong domain');
    if (!checkNonce('signin', wallet, m.nonce)) return fail('sign-in expired, try again');
    if (!(Date.parse(m.expiresAt) > Date.now())) return fail('sign-in expired, try again');
    // the text must be exactly what the server would have produced: no extra lines smuggled in
    if (message !== signInMessage({ domain: env.domain, wallet, nonce: m.nonce, issuedAt: m.issuedAt, expiresAt: m.expiresAt })) return fail('message was altered');
    if (!proofOk(wallet, message, proof)) return fail('signature did not verify', 401);

    const sb = db();
    let user = must(await sb.from('art_users').select('id,wallet').eq('wallet', wallet).maybeSingle(), 'user lookup');
    if (!user) {
      user = must(await sb.from('art_users').insert({ wallet }).select('id,wallet').single(), 'user create');
      must(await sb.from('art_settings').insert({ user_id: user!.id }), 'settings create');
    }
    const token = await createSession({ userId: user!.id, wallet });
    const res = json({ ok: true });
    res.cookies.set(COOKIE, token, cookieOptions());
    return res;
  } catch (e: any) {
    console.error('verify', e?.message || e);
    return fail('server error', 500);
  }
}
