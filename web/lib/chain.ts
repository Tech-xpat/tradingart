import { env } from './env';

/** SOL balance of an address via JSON-RPC (server side). Returns null if the RPC is unreachable. */
export async function solBalance(address: string): Promise<number | null> {
  try {
    const res = await fetch(env.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(6000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address, { commitment: 'confirmed' }] }) });
    const j = await res.json();
    return typeof j?.result?.value === 'number' ? j.result.value / 1e9 : null;
  } catch { return null; }
}
