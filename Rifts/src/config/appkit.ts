'use client';

import { createAppKit } from '@reown/appkit/react';
import { SolanaAdapter } from '@reown/appkit-adapter-solana/react';
import { solana } from '@reown/appkit/networks';
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  TrustWalletAdapter,
} from '@solana/wallet-adapter-wallets';

// Project ID from WalletConnect Cloud
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '';

// Initialize AppKit immediately on client side (module-level singleton)
function initAppKit() {
  if (typeof window === 'undefined') {
    return null;
  }

  if (!projectId) {
    console.warn('Missing NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID');
  }

  // Create Solana adapter with wallet adapters
  const solanaAdapter = new SolanaAdapter({
    wallets: [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new TrustWalletAdapter(),
    ],
  });

  // Custom Solana mainnet with your RPC endpoint
  const solanaMainnet = {
    ...solana,
    rpcUrl: `${window.location.origin}/api/rpc-http`,
  };

  // Metadata for the app
  const metadata = {
    name: 'RIFTS Protocol',
    description: 'RIFTS Protocol - Decentralized Liquidity Infrastructure',
    url: window.location.origin,
    icons: [`${window.location.origin}/logo.png`],
  };

  // Create the AppKit instance
  return createAppKit({
    adapters: [solanaAdapter],
    networks: [solanaMainnet],
    projectId,
    metadata,
    themeMode: 'dark',
    features: {
      analytics: true,
      email: false,
      socials: [],
    },
    themeVariables: {
      '--w3m-accent': '#8B5CF6',
      '--w3m-border-radius-master': '8px',
      '--w3m-font-family': 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    },
  });
}

// Create singleton immediately when module loads on client
export const appKit = initAppKit();
export { projectId };
