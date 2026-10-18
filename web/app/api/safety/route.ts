import { NextRequest } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import { json, fail, rateLimited, ipOf } from '@/lib/api';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { isMint } from '@/lib/dex';
import { assess, type SafetyInput } from '@/lib/safety';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const cache = new Map<string, { at: number; body: unknown }>();
const TTL = 120_000;

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(env.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(7000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}
const offCurve = (a: string) => { try { return !PublicKey.isOnCurve(new PublicKey(a).toBytes()); } catch { return false; } };

/** Warning icons for one coin from public chain data: mint / freeze authority, holder concentration, developer holding, scam wording. */
export async function GET(req: NextRequest) {
  if (rateLimited(`sf:${ipOf(req)}`, 90, 60_000)) return fail('slow down', 429);
  const mint = (req.nextUrl.searchParams.get('mint') || '').trim();
  if (!isMint(mint)) return fail('That is not a token address.');
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL) return json(hit.body);

  const inp: SafetyInput = { mintAuthority: null, freezeAuthority: null, known: false, top1Pct: null, top10Pct: null, devKnown: false, devPct: null, text: '' };
  let dev: string | null = null;
  try {
    let r = await db().from('art_charts').select('description,name,symbol,dev').eq('mint', mint).maybeSingle();
    if (r.error) r = await db().from('art_charts').select('description,name,symbol').eq('mint', mint).maybeSingle() as any;
    const row: any = r.data; if (row) { inp.text = [row.description, row.name].filter(Boolean).join(' '); dev = row.dev || null; }
  } catch { /* charts table optional here */ }

  let supply = 0, decimals = 6;
  try {
    const info = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const p = info?.value?.data?.parsed?.info;
    if (p) { inp.known = true; inp.mintAuthority = p.mintAuthority || null; inp.freezeAuthority = p.freezeAuthority || null; supply = Number(p.supply) || 0; decimals = Number(p.decimals) || 6; }
  } catch { /* stays unknown */ }

  if (supply > 0) {
    try {
      const big = await rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
      const list: { address: string; amount: string }[] = (big?.value || []).slice(0, 20);
      const accs = await rpc('getMultipleAccounts', [list.map((x) => x.address), { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      const holders: number[] = [];
      list.forEach((x, k) => { const owner = accs?.value?.[k]?.data?.parsed?.info?.owner; if (owner && !offCurve(owner)) holders.push(Number(x.amount)); });
      holders.sort((a, b) => b - a);
      inp.top1Pct = holders.length ? (holders[0] / supply) * 100 : 0;
      inp.top10Pct = (holders.slice(0, 10).reduce((a, b) => a + b, 0) / supply) * 100;
    } catch { /* stays unknown */ }
    if (dev) {
      inp.devKnown = true;
      try {
        const ta = await rpc('getTokenAccountsByOwner', [dev, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
        const amt = (ta?.value || []).reduce((a: number, v: any) => a + Number(v.account?.data?.parsed?.info?.tokenAmount?.amount || 0), 0);
        inp.devPct = (amt / supply) * 100;
      } catch { /* stays unknown */ }
    }
  }
  const body = { mint, flags: assess(inp), supplyDecimals: decimals, checkedAt: Date.now() };
  cache.set(mint, { at: Date.now(), body }); if (cache.size > 600) cache.delete(cache.keys().next().value as string);
  return json(body);
}
