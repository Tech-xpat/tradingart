import { NextRequest } from 'next/server';
import { json, fail, rateLimited, ipOf } from '@/lib/api';
import { env } from '@/lib/env';
import { isMint } from '@/lib/dex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

/**
 * Public on-chain facts about any wallet, read from our own Solana node connection: SOL balance, how many tokens it
 * holds, and its latest transactions. All of this is public blockchain data; nothing here is private.
 */
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EUFH7dfvRyvSDvAS7YxAL'];
const cache = new Map<string, { at: number; v: any }>();
async function rpc(method: string, params: unknown[]) {
  const res = await fetch(env.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(7000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json(); if (j.error) throw new Error(j.error.message || 'rpc error'); return j.result;
}

export async function GET(req: NextRequest) {
  if (rateLimited(`wallet:${ipOf(req)}`, 30, 60_000)) return fail('slow down', 429);
  const addr = (req.nextUrl.searchParams.get('addr') || '').trim();
  if (!isMint(addr)) return fail('That is not a wallet address.');
  const hit = cache.get(addr); if (hit && Date.now() - hit.at < 20_000) return json(hit.v);
  try {
    const [bal, sigs, ...accts] = await Promise.allSettled([
      rpc('getBalance', [addr, { commitment: 'confirmed' }]),
      rpc('getSignaturesForAddress', [addr, { limit: 12 }]),
      ...TOKEN_PROGRAMS.map((p) => rpc('getTokenAccountsByOwner', [addr, { programId: p }, { encoding: 'jsonParsed' }])),
    ]);
    const holdings: { mint: string; amount: number }[] = [];
    for (const a of accts) if (a.status === 'fulfilled') for (const x of a.value?.value || []) { const i = x.account?.data?.parsed?.info; const amt = Number(i?.tokenAmount?.uiAmount || 0); if (i?.mint && amt > 0) holdings.push({ mint: i.mint, amount: amt }); }
    const v = {
      sol: bal.status === 'fulfilled' ? (bal.value?.value ?? 0) / 1e9 : null,
      tokens: holdings.length, holdings: holdings.slice(0, 8),
      recent: sigs.status === 'fulfilled' ? (sigs.value || []).map((s: any) => ({ t: s.blockTime ? s.blockTime * 1000 : null, ok: !s.err })) : [],
    };
    if (v.sol == null && !v.recent.length) return fail('The network did not answer. Try again in a moment.', 502);
    cache.set(addr, { at: Date.now(), v }); if (cache.size > 300) cache.delete(cache.keys().next().value as string);
    return json(v);
  } catch (e: any) { return fail(e?.message || 'wallet lookup failed', 502); }
}
