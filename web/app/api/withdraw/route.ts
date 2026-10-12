import { authed, json, fail } from '@/lib/api';
import { db, must } from '@/lib/db';
import { checkNonce } from '@/lib/nonce';
import { parseProof, proofOk } from '@/lib/proof';
import { parseWithdraw, withdrawMessage } from '@/lib/messages';
import { PublicKey } from '@solana/web3.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Records a signed withdrawal request. This route can NOT move funds: only the worker holds the vault key.
 * The destination is part of the text the owner signed; the worker re-verifies the signature and that the
 * stored destination equals the signed one, so nothing can redirect the funds after signing.
 */
export const POST = authed({ write: true, limit: [8, 60_000] }, async ({ req, session }) => {
  const body = await req.json().catch(() => null);
  const message = body?.message, proof = parseProof(body?.proof);
  if (typeof message !== 'string' || !proof) return fail('bad request');
  const sb = db();
  const vault = must(await sb.from('art_vaults').select('address').eq('user_id', session.userId).maybeSingle(), 'vault');
  if (!vault) return fail('no vault');
  const m = parseWithdraw(message);
  if (m.wallet !== session.wallet || m.vault !== vault.address) return fail('message does not match your account');
  let toOk = false;
  try { toOk = !!m.to && new PublicKey(m.to).toBytes().length === 32 && m.to !== vault.address; } catch { toOk = false; }
  if (!toOk) return fail('destination is not a valid Solana address');
  if (!checkNonce('withdraw', session.wallet, String(m.nonce))) return fail('request expired, try again');
  const issued = Date.parse(String(m.issuedAt));
  if (!Number.isFinite(issued) || Date.now() - issued > 20 * 60 * 1000) return fail('request expired, try again');
  if (message !== withdrawMessage({ wallet: session.wallet, vault: vault.address, amount: String(m.amount), to: String(m.to), nonce: String(m.nonce), issuedAt: String(m.issuedAt) })) return fail('message was altered');
  if (!proofOk(session.wallet, message, proof)) return fail('signature did not verify', 401);

  let lamports: string | null = null;
  if (m.amount !== 'ALL') {
    const sol = Number(String(m.amount).replace(' SOL', ''));
    if (!(sol > 0)) return fail('bad amount');
    lamports = String(Math.round(sol * 1e9));
  }
  const live = must(await sb.from('art_state').select('value').eq('user_id', session.userId).eq('key', 'live:positions').maybeSingle(), 'positions');
  if (live && Array.isArray(live.value) && live.value.length) return fail('You have open live trades. Press "Stop and sell all", wait until they close, then withdraw.');
  const pending = must(await sb.from('art_withdrawals').select('id').eq('user_id', session.userId).in('status', ['pending', 'processing']).limit(1), 'pending');
  if (pending.length) return fail('A withdrawal is already being processed.');

  const ins = await sb.from('art_withdrawals').insert({ user_id: session.userId, to_address: m.to, amount_lamports: lamports, message, signature: proof.signature, sig_kind: proof.kind });
  if (ins.error) return fail(ins.error.code === '23505' ? 'this signature was already used' : 'could not save request', 409);
  return json({ ok: true });
});
