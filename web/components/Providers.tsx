'use client';
import { useMemo, type ReactNode } from 'react';
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
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
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
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
