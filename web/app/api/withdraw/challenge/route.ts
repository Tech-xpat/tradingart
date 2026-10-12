import { authed, json, fail } from '@/lib/api';
import { db, must } from '@/lib/db';
import { makeNonce } from '@/lib/nonce';
import { withdrawMessage } from '@/lib/messages';
import { PublicKey } from '@solana/web3.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authed({ limit: [20, 60_000] }, async ({ req, session }) => {
  const raw = (req.nextUrl.searchParams.get('amount') || '').trim().toUpperCase();
  let amount: string;
  if (raw === 'ALL') amount = 'ALL';
  else {
    const sol = Number(raw);
    if (!(sol > 0) || sol > 100000 || !Number.isFinite(sol)) return fail('bad amount');
    amount = `${Math.round(sol * 1e9) / 1e9} SOL`;
  }
  const vault = must(await db().from('art_vaults').select('address').eq('user_id', session.userId).maybeSingle(), 'vault');
  if (!vault) return fail('no vault');
  const to = (req.nextUrl.searchParams.get('to') || '').trim() || session.wallet;
  let valid = false;
  try { valid = new PublicKey(to).toBytes().length === 32; } catch { valid = false; }
  if (!valid) return fail('That is not a valid Solana address.');
  if (to === vault.address) return fail('You cannot send to the vault itself.');
  const { nonce } = makeNonce('withdraw', session.wallet, 15 * 60 * 1000);
  return json({ message: withdrawMessage({ wallet: session.wallet, vault: vault.address, amount, to, nonce, issuedAt: new Date().toISOString() }) });
});
