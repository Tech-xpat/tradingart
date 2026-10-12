'use client';
import { useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

export type Proof = { kind: 'message' | 'tx'; signature: string };
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const toB64 = (u8: Uint8Array) => { let s = ''; u8.forEach((b) => (s += String.fromCharCode(b))); return btoa(s); };
const rejected = (e: any) => /reject|denied|declin|cancel|closed/i.test(String(e?.message || e));

/**
 * Sign a plain-language text with the connected wallet.
 *  1. signMessage (nearly every wallet)
 *  2. fallback for wallets/Ledger setups that only sign transactions: an UNSENT, memo-only transaction.
 *     It carries a dummy blockhash and is never broadcast, so it cannot move funds. The server accepts it only if
 *     it holds exactly one Memo instruction with the same text and is signed by the claimed wallet.
 */
export function useSign() {
  const { publicKey, signMessage, signTransaction } = useWallet();
  return useCallback(async (text: string): Promise<Proof> => {
    if (!publicKey) throw new Error('Connect a wallet first');
    if (signMessage) {
      try {
        const sig = await signMessage(new TextEncoder().encode(text));
        return { kind: 'message', signature: toB64(sig) };
      } catch (e: any) {
        if (rejected(e) || !signTransaction) throw new Error(rejected(e) ? 'You declined the signature in your wallet.' : (e?.message || 'Signing failed'));
      }
    }
    if (!signTransaction) throw new Error('This wallet cannot sign messages. Try another wallet.');
    const tx = new Transaction({ feePayer: publicKey, recentBlockhash: '11111111111111111111111111111111' });
    tx.add(new TransactionInstruction({ keys: [], programId: MEMO, data: new TextEncoder().encode(text) as any }));
    try {
      const signed = await signTransaction(tx);
      return { kind: 'tx', signature: toB64(new Uint8Array(signed.serialize({ requireAllSignatures: false }))) };
    } catch (e: any) {
      throw new Error(rejected(e) ? 'You declined the signature in your wallet.' : (e?.message || 'Signing failed'));
    }
  }, [publicKey, signMessage, signTransaction]);
}
