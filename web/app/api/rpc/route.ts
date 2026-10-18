import { NextRequest } from 'next/server';
import { json, fail, rateLimited, ipOf } from '@/lib/api';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

/**
 * Lets the browser talk to Solana through OUR node connection. Public Solana nodes refuse or throttle browser requests,
 * which is why deposits failed with "failed to get recent blockhash". Only the calls a wallet needs are allowed, so this
 * cannot be used as a free general-purpose RPC.
 */
const ALLOWED = new Set([
  'getLatestBlockhash', 'getRecentBlockhash', 'getBlockHeight', 'isBlockhashValid', 'getBalance', 'getAccountInfo', 'getMultipleAccounts',
  'getSignatureStatuses', 'getSignatureStatus', 'getTransaction', 'getParsedTransaction', 'sendTransaction', 'simulateTransaction',
  'getFeeForMessage', 'getMinimumBalanceForRentExemption', 'getSlot', 'getVersion', 'getGenesisHash', 'getEpochInfo', 'getTokenAccountsByOwner',
  'getParsedTokenAccountsByOwner', 'getTokenAccountBalance', 'getLatestBlockhashAndContext', 'getRecentPrioritizationFees',
]);

export async function POST(req: NextRequest) {
  if (rateLimited(`rpc:${ipOf(req)}`, 240, 60_000)) return fail('slow down', 429);
  const len = Number(req.headers.get('content-length') || 0);
  if (len > 20_000) return fail('too large', 413);
  const body = await req.json().catch(() => null);
  const calls = Array.isArray(body) ? body : body ? [body] : [];
  if (!calls.length || calls.length > 8 || !calls.every((c) => c && typeof c.method === 'string' && ALLOWED.has(c.method))) return fail('method not allowed', 403);
  try {
    const res = await fetch(env.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(15000), body: JSON.stringify(body) });
    const text = await res.text();
    return new Response(text, { status: res.status === 429 ? 429 : 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch {
    return json({ jsonrpc: '2.0', id: calls[0]?.id ?? 1, error: { code: -32000, message: 'Solana network unreachable from the server. Try again.' } });
  }
}
