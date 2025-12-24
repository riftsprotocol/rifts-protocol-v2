'use client';

import { FC, ReactNode, useEffect, useState } from 'react';
// Import appkit config to ensure createAppKit is called before any hooks
import { appKit } from '@/config/appkit';

interface WalletProviderProps {
  children: ReactNode;
}

export const WalletProvider: FC<WalletProviderProps> = ({ children }) => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // AppKit is already initialized via the import
    // Just mark as ready after hydration
    setReady(true);
  }, []);

  // Don't render children until client-side and AppKit is ready
  if (!ready || !appKit) {
    return null;
  }

  return <>{children}</>;
};
