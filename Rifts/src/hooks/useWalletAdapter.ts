// hooks/useWalletAdapter.ts - Reown AppKit Solana Wallet Adapter
'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
// IMPORTANT: Import appkit config FIRST to ensure createAppKit is called before hooks
import '@/config/appkit';
import { useAppKit, useAppKitAccount, useAppKitProvider, useDisconnect } from '@reown/appkit/react';
import { useAppKitConnection } from '@reown/appkit-adapter-solana/react';
import type { Provider } from '@reown/appkit-adapter-solana';
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import {
  walletService,
  riftProtocolService,
  formatSolanaAddress
} from '@/lib/solana';

// Define RiftPosition type locally to avoid import issues
interface RiftPosition {
  riftId: string;
  amount: number;
  value: number;
  rewards: number;
  lastUpdate: number;
}

interface WalletState {
  connected: boolean;
  connecting: boolean;
  publicKey: string;
  balance: number;
  positions: RiftPosition[];
  error: string | null;
}

export const useRealWallet = () => {
  const { open } = useAppKit();
  const { address, isConnected, status } = useAppKitAccount();
  const { disconnect: appKitDisconnect } = useDisconnect();
  const { walletProvider } = useAppKitProvider<Provider>('solana');
  const { connection } = useAppKitConnection();

  const [walletState, setWalletState] = useState<WalletState>({
    connected: false,
    connecting: false,
    publicKey: '',
    balance: 0,
    positions: [],
    error: null
  });

  // Memoize PublicKey to avoid creating new object on every render
  const publicKeyObj = useMemo(() => {
    if (!address) return null;
    try {
      return new PublicKey(address);
    } catch {
      return null;
    }
  }, [address]);

  // Update wallet state when connection changes
  useEffect(() => {
    if (isConnected && address) {
      // Store connection state
      if (typeof window !== 'undefined') {
        localStorage.setItem('walletConnected', 'true');
      }

      // Set connected state immediately
      setWalletState(prev => {
        // Avoid unnecessary updates
        if (prev.connected && prev.publicKey === address) {
          return prev;
        }
        return {
          ...prev,
          connected: true,
          connecting: false,
          publicKey: address,
          error: null
        };
      });

      // Update wallet service
      if (walletProvider && publicKeyObj) {
        const adapter = {
          publicKey: publicKeyObj,
          connected: true,
          connecting: false,
          connect: async () => {},
          disconnect: appKitDisconnect,
          sendTransaction: async (tx: Transaction) => {
            const sig = await walletProvider.sendTransaction(tx, connection!);
            return sig;
          },
          signTransaction: async (tx: Transaction) => {
            const signed = await walletProvider.signTransaction(tx);
            return signed as Transaction;
          }
        };
        walletService.setWalletAdapter(adapter as any);
      }

    } else if (!isConnected && status !== 'connecting') {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('walletConnected');
      }
      setWalletState(prev => {
        // Avoid unnecessary updates
        if (!prev.connected && !prev.publicKey) {
          return prev;
        }
        return {
          connected: false,
          connecting: false,
          publicKey: '',
          balance: 0,
          positions: [],
          error: null
        };
      });
    }
  }, [isConnected, address, status, walletProvider, connection, publicKeyObj, appKitDisconnect]);

  // Fetch balance when connected (separate effect to avoid re-triggering main effect)
  useEffect(() => {
    if (!isConnected || !publicKeyObj || !connection) return;

    let cancelled = false;
    (async () => {
      try {
        const lamports = await connection.getBalance(publicKeyObj);
        if (!cancelled) {
          setWalletState(prev => ({ ...prev, balance: lamports / 1e9 }));
        }
      } catch {
        // ignore balance errors
      }
    })();

    return () => { cancelled = true; };
  }, [isConnected, publicKeyObj, connection]);

  // Fetch positions when connected (separate effect)
  useEffect(() => {
    if (!isConnected || !publicKeyObj) return;

    let cancelled = false;
    (async () => {
      try {
        const positions = await riftProtocolService.getUserPositions(publicKeyObj);
        if (!cancelled) {
          setWalletState(prev => ({ ...prev, positions: positions as unknown as RiftPosition[] }));
        }
      } catch {
        // ignore position errors
      }
    })();

    return () => { cancelled = true; };
  }, [isConnected, publicKeyObj]);

  // Update connecting state
  useEffect(() => {
    setWalletState(prev => {
      if (prev.connecting === (status === 'connecting')) {
        return prev; // Avoid unnecessary updates
      }
      return {
        ...prev,
        connecting: status === 'connecting'
      };
    });
  }, [status]);

  // Connect function - opens AppKit modal
  const connect = useCallback(async () => {
    try {
      setWalletState(prev => ({ ...prev, error: null }));

      if (isConnected) {
        return;
      }

      // Open the AppKit modal
      await open();
    } catch (error) {
      setWalletState(prev => ({
        ...prev,
        connecting: false,
        error: error instanceof Error ? error.message : 'Failed to connect wallet'
      }));
    }
  }, [isConnected, open]);

  // Disconnect function
  const disconnect = useCallback(async () => {
    try {
      await appKitDisconnect();

      // Clear localStorage
      if (typeof window !== 'undefined') {
        localStorage.removeItem('walletConnected');
        localStorage.removeItem('walletName');
      }

      setWalletState({
        connected: false,
        connecting: false,
        publicKey: '',
        balance: 0,
        positions: [],
        error: null
      });
    } catch (error) {
      // Silent fail
    }
  }, [appKitDisconnect]);

  // Refresh balance
  const refreshBalance = useCallback(async () => {
    if (publicKeyObj && connection) {
      try {
        const balance = await connection.getBalance(publicKeyObj) / 1e9;
        setWalletState(prev => ({ ...prev, balance }));
      } catch (error) {
        // Silent fail
      }
    }
  }, [publicKeyObj, connection]);

  // Refresh positions
  const refreshPositions = useCallback(async () => {
    if (publicKeyObj) {
      try {
        const positions = await riftProtocolService.getUserPositions(publicKeyObj);
        setWalletState(prev => ({ ...prev, positions: positions as unknown as RiftPosition[] }));
      } catch (error) {
        // Silent fail
      }
    }
  }, [publicKeyObj]);

  // Auto-refresh balance every 3 seconds when connected
  useEffect(() => {
    if (!isConnected || !publicKeyObj || !connection) return;

    let intervalId: NodeJS.Timeout | null = null;
    let cancelled = false;

    const doRefresh = async () => {
      try {
        const lamports = await connection.getBalance(publicKeyObj);
        if (!cancelled) {
          setWalletState(prev => ({ ...prev, balance: lamports / 1e9 }));
        }
      } catch {
        // Silent fail
      }
    };

    // Refresh immediately
    doRefresh();

    // Set up polling interval
    intervalId = setInterval(doRefresh, 3000);

    return () => {
      cancelled = true;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [isConnected, publicKeyObj, connection]);

  // Format public key for display
  const formattedPublicKey = walletState.publicKey ? formatSolanaAddress(walletState.publicKey) : '';

  // Send transaction wrapper
  const sendTransaction = useCallback(async (
    transaction: Transaction | VersionedTransaction,
    conn?: any,
    options?: { skipPreflight?: boolean }
  ) => {
    if (!walletProvider) {
      throw new Error('Wallet not connected');
    }

    const effectiveConnection = conn || connection;
    if (!effectiveConnection) {
      throw new Error('No connection available');
    }

    // Send via Reown wallet provider
    const signature = await walletProvider.sendTransaction(
      transaction,
      effectiveConnection,
      options
    );

    return signature;
  }, [walletProvider, connection]);

  // Sign transaction wrapper
  const signTransaction = useCallback(async (transaction: Transaction) => {
    if (!walletProvider) {
      throw new Error('Wallet not connected');
    }

    const signed = await walletProvider.signTransaction(transaction);
    return signed as Transaction;
  }, [walletProvider]);

  return {
    ...walletState,
    connect,
    disconnect,
    refreshBalance,
    refreshPositions,
    formattedPublicKey,
    isConnecting: walletState.connecting,
    sendTransaction,
    signTransaction,
    publicKeyObj,
    walletAdapterConnection: connection,
    walletProvider, // Expose the raw provider if needed
  };
};

// Re-export other hooks from the original file for backward compatibility
export { useRealTimeData, useRiftOperations, useTransactionToast } from './useWallet';
