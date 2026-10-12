import { verifyProof } from './verify';

export type Proof = { kind: 'message' | 'tx'; signature: string };
export function parseProof(p: any): Proof | null {
  if (!p || (p.kind !== 'message' && p.kind !== 'tx') || typeof p.signature !== 'string' || p.signature.length > 8000) return null;
  return { kind: p.kind, signature: p.signature };
}
export const proofOk = (wallet: string, message: string, proof: Proof) => verifyProof(wallet, message, proof);
export const isAddress = (s: unknown): s is string => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
