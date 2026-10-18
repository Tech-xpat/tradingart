'use client';
import { useCallback, useMemo, type ReactNode } from 'react';
import type { WalletError } from '@solana/wallet-adapter-base';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import {
  PhantomWalletAdapter, SolflareWalletAdapter, CoinbaseWalletAdapter, TrustWalletAdapter, LedgerWalletAdapter,
  TorusWalletAdapter, Coin98WalletAdapter, BitgetWalletAdapter, WalletConnectWalletAdapter,
} from '@solana/wallet-adapter-wallets';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { SolanaMobileWalletAdapter, createDefaultAddressSelector, createDefaultAuthorizationResultCache, createDefaultWalletNotFoundHandler } from '@solana-mobile/wallet-adapter-mobile';
import '@solana/wallet-adapter-react-ui/styles.css';

/**
 * Wallet coverage:
 *  - Every wallet that implements the Solana Wallet Standard is detected automatically (Phantom, Solflare, Backpack,
 *    Glow, Coinbase, Brave, MetaMask-Solana, Nightly, Jupiter, ...): that is "all browser wallets", no list to maintain.
 *  - Explicit adapters below add "install / open" entries and legacy wallets.
 *  - Mobile Wallet Adapter covers Android wallet apps; WalletConnect (optional) covers Trust, Exodus, Rainbow and others on iOS.
 */
export default function Providers({ children }: { children: ReactNode }) {
  // all browser-side Solana calls go through our own server (public nodes refuse browser requests, which broke deposits)
  const endpoint = useMemo(() => (typeof window !== 'undefined' ? `${window.location.origin}/api/rpc` : 'https://localhost/api/rpc'), []);
  const wallets = useMemo(() => {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://localhost';
    const list: any[] = [
      new SolanaMobileWalletAdapter({
        addressSelector: createDefaultAddressSelector(),
        appIdentity: { name: 'ART · African Robot Trader', uri: origin, icon: '/icon.svg' },
        authorizationResultCache: createDefaultAuthorizationResultCache(),
        cluster: 'mainnet-beta',
        onWalletNotFound: createDefaultWalletNotFoundHandler(),
      }),
      new PhantomWalletAdapter(), new SolflareWalletAdapter(), new CoinbaseWalletAdapter(), new TrustWalletAdapter(),
      new LedgerWalletAdapter(), new Coin98WalletAdapter(), new BitgetWalletAdapter(), new TorusWalletAdapter(),
    ];
    const wc = process.env.NEXT_PUBLIC_WC_PROJECT_ID;
    if (wc) {
      list.push(new WalletConnectWalletAdapter({
        network: WalletAdapterNetwork.Mainnet,
        options: { projectId: wc, metadata: { name: 'ART · African Robot Trader', description: 'Robot trading for Africa', url: origin, icons: [`${origin}/icon.svg`] } },
      }));
    }
    return list;
  }, []);
  // surface the wallet's real error text on the page instead of failing silently
  const onError = useCallback((e: WalletError) => {
    const msg = String(e?.message || e?.name || 'Wallet error');
    if (/user rejected|rejected the request|declined|cancel/i.test(msg)) return;
    try { window.dispatchEvent(new CustomEvent('art:wallet-error', { detail: msg })); } catch { /* ignore */ }
  }, []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect onError={onError}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
