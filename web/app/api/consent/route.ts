import { NextRequest } from 'next/server';
import { authed, json, fail } from '@/lib/api';
import { db, must } from '@/lib/db';
import { makeNonce, checkNonce } from '@/lib/nonce';
import { parseProof, proofOk } from '@/lib/proof';
import { consentMessage, parseConsent, CONSENT_VERSION } from '@/lib/messages';
import { parseLimits } from '@/lib/limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function vaultOf(userId: string) {
  return must(await db().from('art_vaults').select('address').eq('user_id', userId).maybeSingle(), 'vault');
}

/** The exact consent text for the limits the user picked. They sign THIS in their wallet. */
export const GET = authed({ limit: [30, 60_000] }, async ({ req, session }) => {
  const q = req.nextUrl.searchParams;
  const limits = parseLimits({ mode: q.get('mode'), maxPositionSol: q.get('maxPositionSol'), maxDailyLossPct: q.get('maxDailyLossPct'), maxConcurrent: q.get('maxConcurrent') });
  if (!limits) return fail('limits out of range');
  const vault = await vaultOf(session.userId);
  if (!vault) return fail('create your vault first');
  const { nonce } = makeNonce('consent', session.wallet, 15 * 60 * 1000);
  return json({ message: consentMessage({ wallet: session.wallet, vault: vault.address, ...limits, nonce, issuedAt: new Date().toISOString() }) });
});

export const POST = authed({ write: true, limit: [10, 60_000] }, async ({ req, session }) => {
  const body = await req.json().catch(() => null);
  const message = body?.message, proof = parseProof(body?.proof);
  if (typeof message !== 'string' || !proof) return fail('bad request');
  const m = parseConsent(message);
  const vault = await vaultOf(session.userId);
  if (!vault) return fail('create your vault first');
  if (m.wallet !== session.wallet || m.vault !== vault.address) return fail('message does not match your account');
  if (!checkNonce('consent', session.wallet, String(m.nonce))) return fail('request expired, try again');
  const limits = parseLimits(m as any);
  if (!limits) return fail('limits out of range');
  const issued = Date.parse(String(m.issuedAt));
  if (!Number.isFinite(issued) || Date.now() - issued > 20 * 60 * 1000) return fail('request expired, try again');
  if (message !== consentMessage({ wallet: session.wallet, vault: vault.address, ...limits, nonce: String(m.nonce), issuedAt: String(m.issuedAt) })) return fail('message was altered');
  if (!proofOk(session.wallet, message, proof)) return fail('signature did not verify', 401);

  const sb = db();
  // insert FIRST: a replayed or invalid request must never revoke the consent the user already has
  const ins = await sb.from('art_consents').insert({ user_id: session.userId, version: CONSENT_VERSION, message, signature: proof.signature, sig_kind: proof.kind, limits }).select('id').single();
  if (ins.error) return fail(ins.error.code === '23505' ? 'this signature was already used' : 'could not save consent', 409);
  // the new consent replaces any earlier one
  await sb.from('art_consents').update({ revoked_at: new Date().toISOString() }).eq('user_id', session.userId).is('revoked_at', null).neq('id', ins.data.id);
  must(await sb.from('art_settings').update({ mode: limits.mode, max_position_sol: limits.maxPositionSol, max_daily_loss_pct: limits.maxDailyLossPct, max_concurrent: limits.maxConcurrent, updated_at: new Date().toISOString() }).eq('user_id', session.userId), 'settings');
  return json({ ok: true, limits });
});
