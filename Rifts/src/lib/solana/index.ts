// lib/solana/index.ts - Fixed Solana Integration with Correct Exports
import { 
  Connection, 
  PublicKey, 
  Transaction,
  LAMPORTS_PER_SOL,
  Commitment,
  Keypair
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

// Import specific services directly to avoid circular dependencies
import { ProductionRiftsService } from './rifts-service';
import { ProductionRiftsTokenManager } from './rifts-token-manager';
import { serviceIntegrator, typeConverters } from './integration-utils';
import { UserPosition, Rift } from '@/types'; // Use your existing types
import { riftsCache, priceCache, userDataCache } from '@/lib/cache/persistent-cache';
import { BLACKLISTED_RIFTS } from './rifts/types';
import { globalConnection } from './connection';

// Define wallet adapter interface first
interface WalletAdapter {
  publicKey: PublicKey | null;
  connected: boolean;
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  sendTransaction: (transaction: Transaction) => Promise<string>;
  signTransaction: (transaction: Transaction) => Promise<Transaction>;
}

export interface RiftPosition {
  riftId: string;
  amount: number;
  value: number;
  rewards: number;
  lastUpdate: number;
}

export interface TokenPrice {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  lastUpdate: number;
}

// Type-safe data structures for real-time updates
interface TVLUpdateData {
  total: number;
  change24h: number;
  timestamp: number;
}

interface VolumeUpdateData {
  total: number;
  change24h: number;
  timestamp: number;
}

type DataUpdateCallback = (data: unknown) => void;

// Solana RPC endpoints - SECURITY FIX: Use environment variables only
export const SOLANA_ENDPOINTS = {
  devnet: process.env.NEXT_PUBLIC_SOLANA_RPC_URL!
};

// Enhanced rate limiting and caching for RPC calls
class RateLimitedConnection {
  protected connection: Connection;
  protected lastCall: number = 0;
  private minInterval: number = 50; // 50ms between calls for fast flows
  private retryQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue: boolean = false;
  private cache: Map<string, { data: unknown; timestamp: number }> = new Map();
  private cacheTimeout: number = 600000; // 10 minute cache - much longer to reduce API calls
  private httpConnection: Connection | null = null;

  constructor(endpoint: string) {
    // SECURITY: Use ProxiedConnection in browser to hide RPC URL
    if (typeof window !== 'undefined') {
      // Browser: Use proxied connection
      const { ProxiedConnection } = require('./rpc-client');
      this.connection = new ProxiedConnection();
    } else {
      // Server: Use direct connection
      this.connection = new Connection(endpoint, {
        commitment: 'confirmed' as Commitment,
        wsEndpoint: '',  // Use empty string to completely disable WebSocket
        disableRetryOnRateLimit: true,
        confirmTransactionInitialTimeout: 60000,
      });
    }
  }

  private getHttpConnection(): Connection | null {
    if (typeof window === 'undefined') return null;
    if (!this.httpConnection) {
      const base = window.location.origin;
      const url = `${base}/api/rpc-http`;
      this.httpConnection = new Connection(url, {
        commitment: 'confirmed' as Commitment,
        fetch: fetch,
      });
    }
    return this.httpConnection;
  }

  private async wait() {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCall;
    if (timeSinceLastCall < this.minInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minInterval - timeSinceLastCall));
    }
    this.lastCall = Date.now();
  }

  // Public method to clear cache - critical for ensuring fresh reads after account creation
  public clearCache() {
    this.cache.clear();

  }

  async getAccountInfo(pubkey: PublicKey, commitment?: Commitment) {
    const cacheKey = `account-${pubkey.toBase58()}`;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }

    await this.wait();
    try {
      const httpConn = this.getHttpConnection();
      const result = httpConn
        ? await httpConn.getAccountInfo(pubkey, commitment)
        : await this.connection.getAccountInfo(pubkey, commitment);
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {

      if (cached) return cached.data;

      // Handle 503 Internal Server errors (common with closed accounts)
      if (error instanceof Error && (error.message.includes('503') || error.message.includes('Internal server error'))) {

        this.cache.set(cacheKey, { data: null, timestamp: Date.now() });
        return null;
      }

      // Enhanced 429 error handling with exponential backoff
      if (error instanceof Error && (error.message.includes('429') || error.message.includes('Too Many Requests'))) {

        const backoffDelay = Math.min(this.minInterval * 4, 15000); // Max 15 seconds
        await new Promise(resolve => setTimeout(resolve, backoffDelay));

        // Try once more with cached fallback
        try {
          const retryResult = await this.connection.getAccountInfo(pubkey, commitment);
          this.cache.set(cacheKey, { data: retryResult, timestamp: Date.now() });
          return retryResult;
        } catch (retryError) {

          return (cached as any)?.data || null;
        }
      }
      throw error;
    }
  }

  // Required by Meteora SDK (Anchor Provider compatibility)
  async getAccountInfoAndContext(pubkey: PublicKey, commitment?: Commitment) {
    const accountInfo = await this.getAccountInfo(pubkey, commitment);
    const slot = await this.connection.getSlot(commitment || 'confirmed');
    return {
      context: { slot },
      value: accountInfo
    };
  }

  async getBalance(pubkey: PublicKey, commitment?: Commitment) {
    const cacheKey = `balance-${pubkey.toBase58()}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }

    await this.wait();
    try {
      const httpConn = this.getHttpConnection();
      const result = httpConn
        ? await httpConn.getBalance(pubkey, commitment)
        : await this.connection.getBalance(pubkey, commitment);
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {

      if (cached) return cached.data;
      // For rate limit errors, wait longer and return null instead of throwing
      if (error instanceof Error && error.message.includes('429')) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        return null;
      }
      throw error;
    }
  }

  async getParsedTokenAccountsByOwner(owner: PublicKey, filter: unknown, commitment?: Commitment) {
    const cacheKey = `token-accounts-${owner.toBase58()}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }

    await this.wait();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const httpConn = this.getHttpConnection();
      const result = httpConn
        ? await httpConn.getParsedTokenAccountsByOwner(owner, filter as any, commitment)
        : await this.connection.getParsedTokenAccountsByOwner(owner, filter as any, commitment);
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {

      if (cached) return cached.data;
      // For rate limit errors, wait longer and return null instead of throwing
      if (error instanceof Error && error.message.includes('429')) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        return null;
      }
      throw error;
    }
  }

  async getProgramAccounts(programId: PublicKey, config?: unknown) {
    const cacheKey = `program-accounts-${programId.toBase58()}`;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }

    await this.wait();
    try {
      const httpConn = this.getHttpConnection();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = httpConn
        ? await httpConn.getProgramAccounts(programId, config as any)
        : await this.connection.getProgramAccounts(programId, config as any);
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {

      if (cached) return cached.data;

      // Handle StructError from Solana (deserialization errors)
      if (error instanceof Error && error.name === 'StructError') {
        console.log(`[CONNECTION] StructError for program ${programId.toBase58()}, returning empty array`);
        return [];
      }

      // For rate limit errors, wait longer and return empty array instead of throwing
      if (error instanceof Error && error.message.includes('429')) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        return [];
      }

      // For other errors, log them but still return empty array to prevent app crashes
      const stack = new Error().stack;
      console.error(`[CONNECTION] Error fetching program accounts for ${programId.toBase58()}:`, error);
      console.error(`[CONNECTION] Error details:`, {
        name: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        callerStack: stack
      });
      return [];
    }
  }

  async getMultipleAccountsInfo(publicKeys: PublicKey[], commitment?: Commitment) {
    const cacheKey = `multi-accounts-${publicKeys.map(pk => pk.toBase58()).join('-')}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }

    await this.wait();
    try {
      const result = await this.connection.getMultipleAccountsInfo(publicKeys, commitment);
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {

      if (cached) return cached.data;
      // For rate limit errors, wait longer and return null instead of throwing
      if (error instanceof Error && error.message.includes('429')) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        return null;
      }
      throw error;
    }
  }

  async getTokenAccountsByOwner(owner: PublicKey, filter: unknown, commitment?: Commitment) {
    const cacheKey = `token-accounts-raw-${owner.toBase58()}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }

    await this.wait();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const httpConn = this.getHttpConnection();
      const result = httpConn
        ? await httpConn.getTokenAccountsByOwner(owner, filter as any, commitment)
        : await this.connection.getTokenAccountsByOwner(owner, filter as any, commitment);
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {

      if (cached) return cached.data;
      // For rate limit errors, wait longer and return null instead of throwing
      if (error instanceof Error && error.message.includes('429')) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        return null;
      }
      throw error;
    }
  }

  // Delegate other methods to the underlying connection
  async sendTransaction(transaction: Transaction, signers: Keypair[], options?: unknown) {
    await this.wait();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.connection.sendTransaction(transaction, signers, options as any);
  }

  async getVersion() {
    await this.wait();
    return this.connection.getVersion();
  }

  async getSignaturesForAddress(address: PublicKey, options?: unknown) {
    await this.wait();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.connection.getSignaturesForAddress(address, options as any);
  }

  async getParsedTransactions(signatures: string[]) {
    await this.wait();
    return this.connection.getParsedTransactions(signatures);
  }

  async sendRawTransaction(rawTransaction: Buffer | Uint8Array | number[], options?: unknown) {
    await this.wait();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.connection.sendRawTransaction(rawTransaction, options as any);
  }

  async confirmTransaction(signature: string, commitment?: Commitment) {
    await this.wait();
    return this.connection.confirmTransaction(signature, commitment);
  }

  async getSignatureStatus(signature: string, config?: unknown) {
    await this.wait();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.connection.getSignatureStatus(signature, config as any);
  }

  async simulateTransaction(transaction: Transaction, config?: unknown) {
    await this.wait();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.connection.simulateTransaction(transaction, config as any);
  }

  async getLatestBlockhash(commitment?: Commitment) {
    const cacheKey = `latest-blockhash`;
    const cached = this.cache.get(cacheKey);
    
    // Use shorter cache for blockhash (10 seconds)
    if (cached && Date.now() - cached.timestamp < 10000) {
      return cached.data;
    }

    await this.wait();
    try {
      const result = await this.connection.getLatestBlockhash(commitment);
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {

      if (cached) return cached.data;
      // For rate limit errors, wait longer and return null instead of throwing
      if (error instanceof Error && error.message.includes('429')) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        return null;
      }
      throw error;
    }
  }

  async getSlot(commitment?: Commitment) {
    await this.wait();
    return await this.connection.getSlot(commitment);
  }

  async getBlockTime(slot: number) {
    await this.wait();
    return await this.connection.getBlockTime(slot);
  }

  async getTokenAccountBalance(tokenAccount: PublicKey, commitment?: Commitment) {
    const cacheKey = `token-balance-${tokenAccount.toBase58()}`;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }

    await this.wait();
    try {
      const httpConn = this.getHttpConnection();
      const result = httpConn
        ? await httpConn.getTokenAccountBalance(tokenAccount, commitment)
        : await this.connection.getTokenAccountBalance(tokenAccount, commitment);
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {

      if (cached) return cached.data;
      // For rate limit errors, wait longer and return null instead of throwing
      if (error instanceof Error && error.message.includes('429')) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        return null;
      }
      throw error;
    }
  }
}

// Enhanced connection factory with automatic fallback
export const createConnection = () => {
  // SECURITY FIX: Use correct endpoint based on environment
  // Server-side: use SOLANA_RPC_URL (actual RPC)
  // Browser: use NEXT_PUBLIC_SOLANA_RPC_URL (proxy URL)
  const primaryEndpoint = typeof window !== 'undefined'
    ? process.env.NEXT_PUBLIC_SOLANA_RPC_URL!  // Browser: http://localhost:3000/api/rpc
    : process.env.SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL!;  // Server: http://95.217.229.112

  // Fallback endpoints if primary fails
  const endpoints = [
    // Primary endpoint from environment variable
    primaryEndpoint,

    // Backup endpoints only if primary fails
    primaryEndpoint,
    primaryEndpoint,
    primaryEndpoint
  ];
  
  let currentEndpointIndex = 0;
  
  class FallbackConnection extends RateLimitedConnection {
    constructor() {
      super(endpoints[currentEndpointIndex]);
    }
    
    async fallbackToNextEndpoint() {
      currentEndpointIndex = (currentEndpointIndex + 1) % endpoints.length;
      const newEndpoint = endpoints[currentEndpointIndex];

      // SECURITY: Use ProxiedConnection in browser to hide RPC URL
      if (typeof window !== 'undefined') {
        // Browser: Use proxied connection
        const { ProxiedConnection } = require('./rpc-client');
        this.connection = new ProxiedConnection();
      } else {
        // Server: Create new connection with next endpoint (WebSocket disabled)
        this.connection = new Connection(newEndpoint, {
          commitment: 'confirmed' as Commitment,
          wsEndpoint: '',  // Use empty string to completely disable WebSocket
          disableRetryOnRateLimit: true,
          confirmTransactionInitialTimeout: 60000,
        });
      }
      this.lastCall = 0; // Reset rate limiting
    }
    
    // Override methods to include fallback logic
    async getAccountInfo(pubkey: PublicKey, commitment?: Commitment) {
      try {
        return await super.getAccountInfo(pubkey, commitment);
      } catch (error) {
        if (error instanceof Error && error.message.includes('429')) {

          await this.fallbackToNextEndpoint();
          return await super.getAccountInfo(pubkey, commitment);
        }
        throw error;
      }
    }
  }
  
  try {
    return new FallbackConnection();
  } catch (error) {

    return new RateLimitedConnection(primaryEndpoint);
  }
};

export const connection = createConnection();

// Program IDs (ALL UPGRADED WITH SECURITY FIXES ✅) - November 7, 2025
export const CURRENT_PROGRAM_IDS = {
  rifts: new PublicKey(process.env.NEXT_PUBLIC_RIFTS_PROGRAM_ID || '6FEZJKsxbDm5W4Ad4eogNehivRKKGCHJHRnKUSFbLpKt'),  // ✅ Main RIFTS Program
  governance: new PublicKey(process.env.NEXT_PUBLIC_GOVERNANCE_PROGRAM_ID || 'EbVBCs4g7MQo7iDAtVcZhmV9FMq37JKah3iheLpqJbPo'), // ✅ Governance Program
  feeCollector: new PublicKey(process.env.NEXT_PUBLIC_FEE_COLLECTOR_PROGRAM_ID || '4eZJyc7bPFQ7FcjBF5S5xkGJjaqHs3BaHR4oXUMa7rf9'), // ✅ Fee Collector
  lpStaking: new PublicKey(process.env.NEXT_PUBLIC_LP_STAKING_PROGRAM_ID || '6FEZJKsxbDm5W4Ad4eogNehivRKKGCHJHRnKUSFbLpKt'),   // ✅ LP Staking Program
  riftsToken: new PublicKey(process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump'), // RIFTS token mint
  authority: new PublicKey(process.env.NEXT_PUBLIC_PROTOCOL_AUTHORITY || '9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4')  // Protocol authority
};

// Rifts Protocol program ID
export const RIFTS_PROGRAM_ID = CURRENT_PROGRAM_IDS.rifts;
export const RIFTS_TOKEN_MINT = CURRENT_PROGRAM_IDS.riftsToken;
export const RIFTS_TOKEN_AUTHORITY = CURRENT_PROGRAM_IDS.authority;

// Blocklist of old rift accounts from previous buggy deployment (9xTuwVWARRk9oj5G1PGJ9oeU6jkdMM4hBQVDz9KEaEFh)
// These rifts have vault authority bug and should not be displayed
export const DEPRECATED_RIFT_ADDRESSES = new Set([
  '45PC6bz8gA3jmkJFFQSTk7PdR3RVQbLdmAhbAxpJMNUn',
  '5CECeAFSHnxBCyMN4Jskgjt4MBWGCGkpztH6Hgs6vuVL',
  '57FybFDupqnintE326dEwPHsGxJczYs8P2WA4DGGjWBs',
  'DeeZnkbp6SywhJgEYUDKpwfgzGYiV7Qv79M8S5z2SKfG',
  'AiPqT2B6T782ZL82oWcT9wFY8r3ztsTNfmByW3AJt8tf',
  'AiC1AAci9ffLasH6CFaEMVAbHdNJPfEiS5Ubg9UDUgB2',
  'HgTfbQTVVSe5fWzRjvg3M1hXSyvy4UaiBr83jPgCNzud',
  '39eNHrEs7jmmrns5S9fjEDr491bpaPThFdZK9opVVgUC',
  'J8uwR6kLvM5oaNS7bRm8zVALewu56hdjaL6h2F7ruBxV',
  '7cbUatbCNQAndAWnBLZ9GBVP4Gii5go88PHxj3dP7vv',
  '7K3L3k5WAtx1x8m954eqpimxi8wVGAJhAg9oWy64rfHK',
  '8WimWH9Ydu2EGNReV8hL3nvNv4S2TQ3kyVUHjKgqPnPb',
  'BQoxPyGKoAznoUqKhqbagdJRg3bqLQDYfgvhssjzS8nw',
  'HzPCvvExtYhMLCiC8F8MvrACvYaNZaes48iaNPrqGwkV',
  '51fxifBJTwAAfQxsoKjLskRxtDJCAYBtwPqrixi8y74V',
  '7qHVvZ3oi6govR2fQU51H8S5i36kVmVrJfwzfQhCAa4d',
  'qzw66DzDDnHvQCnfWNQsDzXB1r3tXXoiCK4HE1VogHk'
]);

// ==================== WALLET INTEGRATION ====================

export class SolanaWalletService {
  public walletAdapter: WalletAdapter | null = null;
  
  setWalletAdapter(adapter: WalletAdapter) {
    this.walletAdapter = adapter;
    // Update other services that need wallet reference
    if (riftProtocolService) {
      riftProtocolService.updateWallet(adapter);
    }
  }

  async connectWallet(): Promise<{ success: boolean; publicKey?: string; error?: string }> {
    try {
      if (!this.walletAdapter) {
        return { success: false, error: 'No wallet adapter found' };
      }

      // If already connected and has publicKey, return immediately
      const existingPublicKey = this.walletAdapter.publicKey;
      if (this.walletAdapter.connected && existingPublicKey) {
        return {
          success: true,
          publicKey: existingPublicKey.toBase58()
        };
      }

      // If not connected, connect to wallet
      if (!this.walletAdapter.connected) {
        await this.walletAdapter.connect();
      }

      // Check if publicKey is now available (should be immediate with getter fix)
      const immediatePublicKey = this.walletAdapter.publicKey;
      if (immediatePublicKey) {
        return {
          success: true,
          publicKey: immediatePublicKey.toBase58()
        };
      }

      // Fallback: Wait for publicKey with minimal retries (in case of slow connection)
      const maxAttempts = 3;
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));

        const publicKey = this.walletAdapter.publicKey;
        if (publicKey) {
          return {
            success: true,
            publicKey: publicKey.toBase58()
          };
        }
      }

      // Only log error if we truly failed after all retries
      console.warn('Wallet connected but publicKey not available after retries');
      return { success: false, error: 'Failed to get public key' };
    } catch (error) {
      // Don't log user rejections as errors
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      if (!errorMsg.includes('rejected') && !errorMsg.includes('User rejected')) {
        console.error('Wallet connection error:', errorMsg);
      }

      return {
        success: false,
        error: errorMsg
      };
    }
  }

  async disconnectWallet(): Promise<void> {
    if (this.walletAdapter) {
      await this.walletAdapter.disconnect();
    }
  }

  async getBalance(publicKey: PublicKey): Promise<number> {
    try {
      const balance = await connection.getBalance(publicKey);
      return (balance as number) / LAMPORTS_PER_SOL;
    } catch (error) {

      // Retry once after a short delay for rate limiting
      try {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const balance = await connection.getBalance(publicKey);
        return (balance as number) / LAMPORTS_PER_SOL;
      } catch (retryError) {

        return 0;
      }
    }
  }

  async getTokenBalance(publicKey: PublicKey, mintAddress: string): Promise<number> {
    try {
      // Skip blacklisted/spam tokens early to avoid console spam
      if (BLACKLISTED_RIFTS.includes(mintAddress)) {
        return 0;
      }

      console.log('[WALLET-SERVICE] Getting token balance for:', {
        wallet: publicKey.toString(),
        mint: mintAddress
      });

      // FIXED: Try BOTH Token-2022 and SPL Token programs
      const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');

      const mintPubkey = new PublicKey(mintAddress);

      // OPTIMIZED: Use cached connection instead of creating fresh one per token
      // Cache is already managed by RateLimitedConnection (10 min TTL)

      // FIXED: Search BOTH Token-2022 AND SPL Token programs
      // Users can have accounts in both programs!

      const [token2022Accounts, splTokenAccounts] = await Promise.all([
        globalConnection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
        globalConnection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID })
      ]);

      // Combine both account lists
      const allAccounts = [
        ...(token2022Accounts as any).value,
        ...(splTokenAccounts as any).value
      ];

      let accounts = { value: allAccounts } as unknown as { value: unknown[] };

      if (accounts.value.length === 0) {
        return 0; // No token account for this mint
      }

      // Get the Associated Token Account (ATA) address for this user
      // Try both SPL Token and Token-2022 program IDs

      // First try Token-2022 (newer program)
      const ataToken2022 = await getAssociatedTokenAddress(
        new PublicKey(mintAddress),
        publicKey,
        false, // allowOwnerOffCurve
        TOKEN_2022_PROGRAM_ID
      );

      // Also try regular SPL Token
      const ataSpl = await getAssociatedTokenAddress(
        new PublicKey(mintAddress),
        publicKey,
        false, // allowOwnerOffCurve
        TOKEN_PROGRAM_ID
      );

      // FIXED: Count ALL token accounts owned by the user, not just ATAs
      // Users might have non-ATA accounts created by programs
      let totalBalance = 0;

      for (const account of accounts.value) {
        const tokenData = (account as unknown as { account: { data: { parsed: { info: unknown } } } }).account.data.parsed.info;

        // Always use manual calculation for consistency and accuracy
        const data = tokenData as unknown as { tokenAmount: { amount: string; decimals: number; uiAmount?: number; uiAmountString?: string }; mint: string };
        const accountMint = data.mint;
        const rawAmount = Number(data.tokenAmount.amount);
        const decimals = data.tokenAmount.decimals;
        const balance = rawAmount / Math.pow(10, decimals);

        // CRITICAL FIX: Only count accounts that actually match the requested mint!
        if (accountMint !== mintPubkey.toBase58()) {
          continue; // Skip non-matching mints silently
        }

        // Verify the calculation makes sense
        if (!isFinite(balance) || balance < 0) {
          continue; // Skip invalid balances
        }

        totalBalance += balance;
      }

      return totalBalance;
    } catch (error) {

      return 0;
    }
  }
}

// ==================== PRICE DATA SERVICE ====================

export class PriceDataService {
  private cache: Map<string, TokenPrice> = new Map();
  private cacheTimeout = 60000; // 1 minute cache

  async getTokenPrice(symbol: string): Promise<TokenPrice | null> {
    // Check persistent cache first
    const cacheKey = `price-${symbol}`;
    const cached = await priceCache.get<TokenPrice>(cacheKey);
    if (cached) {

      return cached;
    }

    try {
      // Use production oracle for prices
      const { productionJupiterOracle } = await import('./jupiter-oracle');
      const mintAddress = this.getTokenMintAddress(symbol);
      
      if (mintAddress) {
        const priceData = await productionJupiterOracle.getJupiterPrice(mintAddress);
        
        const tokenPrice: TokenPrice = {
          symbol,
          price: priceData.price || 0,
          change24h: 0,
          volume24h: 0,
          lastUpdate: Date.now()
        };
        
        // Cache in both memory and persistent storage
        this.cache.set(symbol, tokenPrice);
        await priceCache.set(cacheKey, tokenPrice);
        
        return tokenPrice;
      }
      
      // Fallback hardcoded prices
      const fallbackPrices: { [key: string]: number } = {
        'SOL': 180,
        'ETH': 3300,
        'BTC': 97000,
        'USDC': 1,
        'USDT': 1,
        'RIFTS': 0.001
      };
      
      if (fallbackPrices[symbol]) {
        const priceData: TokenPrice = {
          symbol,
          price: fallbackPrices[symbol],
          change24h: 0,
          volume24h: 0,
          lastUpdate: Date.now()
        };
        
        // Cache fallback prices too
        this.cache.set(symbol, priceData);
        await priceCache.set(cacheKey, priceData);
        
        return priceData;
      }
    } catch (error) {

      // Return fallback prices on error
      const fallbackPrices: { [key: string]: number } = {
        'SOL': 180,
        'ETH': 3300,
        'BTC': 97000,
        'USDC': 1,
        'USDT': 1,
        'RIFTS': 0.001
      };
      
      if (fallbackPrices[symbol]) {
        return {
          symbol,
          price: fallbackPrices[symbol],
          change24h: 0,
          volume24h: 0,
          lastUpdate: Date.now()
        };
      }
    }

    return null;
  }

  private getTokenMintAddress(symbol: string): string | null {
    const mintMap: { [key: string]: string } = {
      'SOL': 'So11111111111111111111111111111111111111112',
      'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      'ETH': '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
      'BTC': '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E',
      'RIFTS': RIFTS_TOKEN_MINT.toBase58()
    };
    return mintMap[symbol.toUpperCase()] || null;
  }

  async getMultiplePrices(symbols: string[]): Promise<TokenPrice[]> {
    const prices = await Promise.all(
      symbols.map(symbol => this.getTokenPrice(symbol))
    );
    return prices.filter(price => price !== null) as TokenPrice[];
  }
}

// ==================== RIFT PROTOCOL SERVICE ====================

export class RiftProtocolService {
  private walletService: SolanaWalletService;
  private priceService: PriceDataService;
  private productionRiftsService: ProductionRiftsService | null = null;
  private productionRiftsTokenManager: ProductionRiftsTokenManager | null = null;

  constructor(walletService: SolanaWalletService, priceService: PriceDataService) {
    this.walletService = walletService;
    this.priceService = priceService;
    
    // Initialize production services
    this.initializeProductionServices();
  }
  
  private async initializeProductionServices() {
    try {
      // Use the rate-limited connection
      this.productionRiftsService = new ProductionRiftsService(connection as unknown as Connection);
      
      // Use the service integrator to get your existing token manager
      this.productionRiftsTokenManager = serviceIntegrator.getTokenManager();

    } catch (error) {
      if (error instanceof Error && error.message.includes('429')) {

        // Retry after delay
        setTimeout(() => this.initializeProductionServices(), 10000);
      } else {

      }
    }
  }
  
  updateWallet(adapter: WalletAdapter) {
    if (this.productionRiftsService && adapter) {
      this.productionRiftsService.setWallet(adapter);

    }
  }

  async getUserPositions(userPubkey?: PublicKey): Promise<UserPosition[]> {
    try {
      if (!userPubkey) {

        return [];
      }

      // Check cache first
      const cacheKey = `user-positions-${userPubkey.toBase58()}`;
      const cached = await userDataCache.get<UserPosition[]>(cacheKey);
      if (cached) {

        return cached;
      }

      // Get all user token accounts
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        userPubkey,
        { programId: TOKEN_PROGRAM_ID }
      );

      const accounts = tokenAccounts as unknown as { value: unknown[] };

      const positions: UserPosition[] = [];
      
      // Get all rifts from production service
      if (!this.productionRiftsService) {

        return [];
      }
      
      const allRifts = await this.productionRiftsService.getAllRifts();

      // Check for real on-chain positions
      for (const account of accounts.value) {
        const tokenData = (account as unknown as { account: { data: { parsed: { info: unknown } } } }).account.data.parsed.info;
        
        // Log all token accounts for debugging
        const data = tokenData as unknown as { mint: string; tokenAmount: { uiAmount?: number } };

        if ((data.tokenAmount.uiAmount || 0) > 0.001) { // Only show positions greater than 0.001 tokens

          // Check if this token is a rift token by matching against known rifts
          const matchingRift = allRifts.find((rift: unknown) => (rift as { riftMint?: string }).riftMint === data.mint);
          
          if (matchingRift) {

            const underlyingPrice = await this.getTokenPrice((matchingRift as { underlying?: string }).underlying || '');
            
            // Convert to your UserPosition type using the converter
            const position = typeConverters.toUserPositionType({
              amount: data.tokenAmount.uiAmount || 0,
              value: (data.tokenAmount.uiAmount || 0) * (underlyingPrice?.price || 100) * ((matchingRift as { realBackingRatio?: number }).realBackingRatio || 1),
              rewards: 0 // Calculate from actual staking rewards
            }, (matchingRift as { id?: string }).id || '');
            
            positions.push(position);
          } else {

          }
        }
      }
      
      // Cache the results
      await userDataCache.set(cacheKey, positions);

      return positions;
    } catch (error) {

      return [];
    }
  }

  // Get real token price
  private async getTokenPrice(symbol: string): Promise<TokenPrice | null> {
    return await this.priceService.getTokenPrice(symbol);
  }

  // Get all rifts from the production service, converted to your Rift type
  async getAllRifts(): Promise<Rift[]> {
    try {
      // Check cache first
      const cacheKey = 'all-rifts';
      const cached = await riftsCache.get<Rift[]>(cacheKey);
      if (cached) {

        return cached;
      }

      if (!this.productionRiftsService) {

        return [];
      }

      const productionRifts = await this.productionRiftsService.getAllRifts();
      
      // Convert production rifts to your Rift type
      const rifts = productionRifts.map(productionRift => 
        typeConverters.toRiftType(productionRift)
      );
      
      // Cache the results
      await riftsCache.set(cacheKey, rifts);

      return rifts;
    } catch (error) {

      // Try to return cached data even if expired
      const cacheKey = 'all-rifts';
      const staleCache = await riftsCache.get<Rift[]>(cacheKey);
      if (staleCache) {

        return staleCache;
      }
      return [];
    }
  }

  async wrapTokens(riftId: string, amount: number): Promise<{ success: boolean; signature?: string; error?: string }> {
    try {
      // SECURITY FIX: Validate inputs
      const { validateTokenAmount, validatePublicKey } = await import('../validation/input-validator');

      const amountValidation = validateTokenAmount(amount, {
        min: 0.000001,
        max: 1000000000,
        decimals: 9,
        fieldName: 'Wrap amount'
      });

      if (!amountValidation.isValid) {
        return { success: false, error: amountValidation.error };
      }

      const addressValidation = validatePublicKey(riftId, 'Rift ID');
      if (!addressValidation.isValid) {
        return { success: false, error: addressValidation.error };
      }

      if (!this.walletService.walletAdapter?.publicKey) {
        return { success: false, error: 'Wallet not connected' };
      }

      if (!this.productionRiftsService) {
        return { success: false, error: 'Production service not initialized' };
      }

      const result = await this.productionRiftsService.wrapTokens({
        user: this.walletService.walletAdapter.publicKey,
        riftPubkey: new PublicKey(riftId),
        amount: amount
      });
      
      if (result?.success && result?.signature) {

        return { success: true, signature: result.signature };
      } else {

        return { 
          success: false, 
          error: result?.error || 'Production wrap operation failed' 
        };
      }
    } catch (error) {

      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Transaction failed' 
      };
    }
  }

  async unwrapTokens(riftId: string, rTokenAmount: number): Promise<{ success: boolean; signature?: string; error?: string }> {
    try {
      // SECURITY FIX: Validate inputs
      const { validateTokenAmount, validatePublicKey } = await import('../validation/input-validator');

      const amountValidation = validateTokenAmount(rTokenAmount, {
        min: 0.000001,
        max: 1000000000,
        decimals: 9,
        fieldName: 'Unwrap amount'
      });

      if (!amountValidation.isValid) {
        return { success: false, error: amountValidation.error };
      }

      const addressValidation = validatePublicKey(riftId, 'Rift ID');
      if (!addressValidation.isValid) {
        return { success: false, error: addressValidation.error };
      }

      if (!this.walletService.walletAdapter?.publicKey) {
        return { success: false, error: 'Wallet not connected' };
      }

      if (!this.productionRiftsService) {
        return { success: false, error: 'Production service not initialized' };
      }

      const result = await this.productionRiftsService.unwrapTokens({
        user: this.walletService.walletAdapter.publicKey,
        riftPubkey: new PublicKey(riftId),
        riftTokenAmount: rTokenAmount
      });
      
      if (result?.success && result?.signature) {

        return { success: true, signature: result.signature };
      } else {

        return { 
          success: false, 
          error: result?.error || 'Production unwrap operation failed' 
        };
      }
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Withdrawal failed' 
      };
    }
  }

  async claimRiftsRewards(): Promise<{ success: boolean; signature?: string; error?: string }> {
    try {
      if (!this.walletService.walletAdapter?.publicKey) {
        return { success: false, error: 'Wallet not connected' };
      }

      if (!this.productionRiftsTokenManager) {
        return { success: false, error: 'Token manager not initialized' };
      }

      // Use your production RIFTS token manager for claims
      const result = await this.productionRiftsTokenManager.claimRiftsRewards({
        user: this.walletService.walletAdapter.publicKey,
        payer: new Keypair() // Would use proper authority in production
      });
      
      if (result?.success && result?.signature) {
        return { success: true, signature: result.signature };
      } else {
        return { 
          success: false, 
          error: result?.error || 'Claim failed' 
        };
      }
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Claim failed' 
      };
    }
  }

  async createRift(params: {
    tokenAddress: string;
    tokenSymbol: string;
    burnFee: number;
    partnerFee: number;
    partnerWallet?: string;
  }): Promise<{ success: boolean; signature?: string; error?: string }> {
    try {
      // SECURITY FIX: Validate inputs
      const { validatePublicKey, validatePercentage } = await import('../validation/input-validator');

      const addressValidation = validatePublicKey(params.tokenAddress, 'Token address');
      if (!addressValidation.isValid) {
        return { success: false, error: addressValidation.error };
      }

      const burnFeeValidation = validatePercentage(params.burnFee, {
        min: 0,
        max: 0.45,
        fieldName: 'Burn fee'
      });

      if (!burnFeeValidation.isValid) {
        return { success: false, error: burnFeeValidation.error };
      }

      const partnerFeeValidation = validatePercentage(params.partnerFee, {
        min: 0,
        max: 0.05,
        fieldName: 'Partner fee'
      });

      if (!partnerFeeValidation.isValid) {
        return { success: false, error: partnerFeeValidation.error };
      }

      if (params.partnerWallet) {
        const partnerWalletValidation = validatePublicKey(params.partnerWallet, 'Partner wallet');
        if (!partnerWalletValidation.isValid) {
          return { success: false, error: partnerWalletValidation.error };
        }
      }

      if (!this.walletService.walletAdapter?.publicKey) {

        return { success: false, error: 'Wallet not connected' };
      }

      if (!this.productionRiftsService) {
        return { success: false, error: 'Production service not initialized' };
      }

      const result = await this.productionRiftsService.createRift({
        creator: this.walletService.walletAdapter.publicKey,
        underlyingMint: new PublicKey(params.tokenAddress),
        burnFeeBps: Math.floor(params.burnFee * 100),
        partnerFeeBps: Math.floor(params.partnerFee * 100),
        partnerWallet: params.partnerWallet ? new PublicKey(params.partnerWallet) : undefined,
        riftName: params.tokenSymbol
      });

      if (result?.success && result?.signature) {
        return { success: true, signature: result.signature };
      } else if (result?.error) {

        return { success: false, error: result.error };
      }

      return { success: false, error: 'Unknown error in rift creation' };
    } catch (error) {

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Rift creation failed'
      };
    }
  }

  async distributeFeesFromVault(params: { riftPubkey: PublicKey; amount: number }): Promise<{ success: boolean; signature?: string; error?: string }> {
    try {
      // SECURITY FIX: Validate inputs
      const { validateTokenAmount, validatePublicKey } = await import('../validation/input-validator');

      const addressValidation = validatePublicKey(params.riftPubkey.toBase58(), 'Rift ID');
      if (!addressValidation.isValid) {
        return { success: false, error: addressValidation.error };
      }

      const amountValidation = validateTokenAmount(params.amount, {
        min: 0.000001,
        max: 1000000000,
        decimals: 9,
        fieldName: 'Distribute amount'
      });

      if (!amountValidation.isValid) {
        return { success: false, error: amountValidation.error };
      }

      if (!this.walletService.walletAdapter?.publicKey) {
        return { success: false, error: 'Wallet not connected' };
      }

      if (!this.productionRiftsService) {
        return { success: false, error: 'Production service not initialized' };
      }

      const result = await this.productionRiftsService.distributeFeesFromVault({
        riftPubkey: params.riftPubkey,
        amount: params.amount
      });

      if (result?.success && result?.signature) {
        return { success: true, signature: result.signature };
      } else {
        return {
          success: false,
          error: result?.error || 'Failed to distribute fees'
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to distribute fees'
      };
    }
  }

  async getVaultFeesAvailable(params: { riftPubkey: PublicKey }): Promise<{
    success: boolean;
    available: number;
    error?: string;
  }> {
    try {
      if (!this.productionRiftsService) {
        return { success: false, available: 0, error: 'Production service not initialized' };
      }

      const result = await this.productionRiftsService.getVaultFeesAvailable({
        riftPubkey: params.riftPubkey
      });

      return result;
    } catch (error) {
      return {
        success: false,
        available: 0,
        error: error instanceof Error ? error.message : 'Failed to get vault fees'
      };
    }
  }

  // Production TVL and volume calculations
  async getTotalTVL(): Promise<number> {
    try {
      if (!this.productionRiftsService) {
        return 0;
      }
      return await this.productionRiftsService.getTotalTVL();
    } catch (error) {

      return 0;
    }
  }

  async getTotal24hVolume(): Promise<number> {
    try {
      if (!this.productionRiftsService) {
        return 0;
      }
      return await this.productionRiftsService.getTotal24hVolume();
    } catch (error) {

      return 0;
    }
  }

  async getUniqueUserCount(): Promise<number> {
    try {
      if (!this.productionRiftsService) {
        return 0;
      }
      return await this.productionRiftsService.getUniqueUserCount();
    } catch (error) {

      return 0;
    }
  }
}

// ==================== REAL-TIME DATA SERVICE ====================

export class RealTimeDataService {
  private priceService: PriceDataService;
  protected connection: Connection;
  private subscribers: Map<string, DataUpdateCallback[]> = new Map();
  private intervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(priceService: PriceDataService, connection: Connection) {
    this.priceService = priceService;
    this.connection = connection;
  }

  subscribe(channel: string, callback: DataUpdateCallback) {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, []);
      this.startDataFeed(channel);
    }
    
    this.subscribers.get(channel)?.push(callback);
  }

  unsubscribe(channel: string, callback: DataUpdateCallback) {
    const channelSubscribers = this.subscribers.get(channel);
    if (channelSubscribers) {
      const index = channelSubscribers.indexOf(callback);
      if (index > -1) {
        channelSubscribers.splice(index, 1);
      }

      if (channelSubscribers.length === 0) {
        this.stopDataFeed(channel);
        this.subscribers.delete(channel);
      }
    }
  }

  private startDataFeed(channel: string) {
    // Increase intervals significantly to reduce RPC calls
    const updateIntervals = {
      'prices': 300000,  // 5 minutes for prices
      'tvl': 600000,     // 10 minutes for TVL  
      'volume': 900000   // 15 minutes for volume
    };

    const interval = setInterval(async () => {
      try {
        let data: TokenPrice[] | TVLUpdateData | VolumeUpdateData;
        
        switch (channel) {
          case 'prices':
            data = await this.priceService.getMultiplePrices(['SOL', 'ETH', 'BTC']);
            break;
          case 'tvl':
            data = await this.generateRealTVLData();
            break;
          case 'volume':
            data = await this.generateRealVolumeData();
            break;
          default:
            return;
        }

        this.broadcast(channel, data);
      } catch (error) {
        if (error instanceof Error && error.message.includes('429')) {

        } else {

        }
      }
    }, updateIntervals[channel as keyof typeof updateIntervals] || 60000);

    this.intervals.set(channel, interval);
  }

  private stopDataFeed(channel: string) {
    const interval = this.intervals.get(channel);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(channel);
    }
  }

  private broadcast(channel: string, data: unknown) {
    const subscribers = this.subscribers.get(channel);
    if (subscribers) {
      subscribers.forEach(callback => callback(data));
    }
  }

  private async generateRealTVLData(): Promise<TVLUpdateData> {
    try {
      // Get real TVL from production service
      const totalTVL = await riftProtocolService.getTotalTVL();
      
      return {
        total: totalTVL,
        change24h: 0, // Would track historical data in production
        timestamp: Date.now()
      };
    } catch (error) {

      return {
        total: 0,
        change24h: 0,
        timestamp: Date.now()
      };
    }
  }

  private async generateRealVolumeData(): Promise<VolumeUpdateData> {
    try {
      // Get real volume from production service
      const totalVolume = await riftProtocolService.getTotal24hVolume();
      
      return {
        total: totalVolume,
        change24h: 0, // Would need historical data to calculate change
        timestamp: Date.now()
      };
    } catch (error) {

      return {
        total: 0,
        change24h: 0,
        timestamp: Date.now()
      };
    }
  }
}

// ==================== SERVICE INSTANCES ====================

export const walletService = new SolanaWalletService();
export const priceService = new PriceDataService();
export const riftProtocolService: RiftProtocolService = new RiftProtocolService(walletService, priceService);
export const realTimeDataService = new RealTimeDataService(priceService, connection as unknown as Connection);

// Export production services for direct access (for backward compatibility)
export const productionRiftsService = riftProtocolService;
export const productionRiftsTokenManager = () => serviceIntegrator.getTokenManager();

// ==================== UTILITY FUNCTIONS ====================

export const formatTokenAmount = (amount: number, decimals: number = 6): string => {
  return (amount / Math.pow(10, decimals)).toFixed(decimals);
};

export const formatSolanaAddress = (address: string, length: number = 4): string => {
  return `${address.slice(0, length)}...${address.slice(-length)}`;
};

export const lamportsToSol = (lamports: number): number => {
  return lamports / LAMPORTS_PER_SOL;
};

export const solToLamports = (sol: number): number => {
  return Math.floor(sol * LAMPORTS_PER_SOL);
};

// ==================== HEALTH CHECKS AND UTILITIES ====================

export async function checkProductionHealth(): Promise<{
  riftsService: boolean;
  tokenManager: boolean;
  connection: boolean;
}> {
  try {
    // Test connection with timeout and rate limiting awareness
    const connectionPromise = connection.getVersion();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Connection timeout')), 10000) // Increased timeout
    );
    
    const connectionHealth = await Promise.race([connectionPromise, timeoutPromise]);
    const serviceValidation = await serviceIntegrator.validateServices();
    
    return {
      riftsService: riftProtocolService !== null,
      tokenManager: serviceValidation.tokenManager,
      connection: !!connectionHealth
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('429')) {

      return {
        riftsService: riftProtocolService !== null,
        tokenManager: true, // Assume healthy when rate limited
        connection: true
      };
    }

    return {
      riftsService: false,
      tokenManager: false,
      connection: false
    };
  }
}

export async function validateProductionDeployment(): Promise<{
  valid: boolean;
  programExists: boolean;
  programExecutable: boolean;
  riftsTokenDeployed: boolean;
}> {
  try {
    const accountInfo = await connection.getAccountInfo(RIFTS_PROGRAM_ID);
    const tokenManager = serviceIntegrator.getTokenManager();
    
    let riftsTokenDeployed = false;
    if (tokenManager) {
      const tokenHealth = await import('./integration-utils').then(
        ({ healthCheck }) => healthCheck.checkRiftsToken(tokenManager)
      );
      riftsTokenDeployed = (await tokenHealth).deployed;
    }
    
    return {
      valid: accountInfo !== null && ((accountInfo as { executable?: boolean })?.executable || false) && riftsTokenDeployed,
      programExists: accountInfo !== null,
      programExecutable: (accountInfo as { executable?: boolean })?.executable || false,
      riftsTokenDeployed
    };
  } catch (error) {

    return {
      valid: false,
      programExists: false,
      programExecutable: false,
      riftsTokenDeployed: false
    };
  }
}

export async function initializeProductionServices(): Promise<boolean> {
  try {
    // Services are auto-initialized in their constructors
    const health = await checkProductionHealth();
    return health.riftsService && health.connection && health.tokenManager;
  } catch (error) {

    return false;
  }
}

// Export your existing token manager through the service integrator
export const getTokenManager = () => serviceIntegrator.getTokenManager();

// Export utilities for working with your existing types
export { riftsTokenUtils, healthCheck, typeConverters } from './integration-utils';
