/**
 * DLMM (Dynamic Liquidity Market Maker) Liquidity Service
 * Enables concentrated liquidity with bin-based price ranges on Meteora DLMM
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
  TransactionInstruction
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction
} from '@solana/spl-token';
import BN from 'bn.js';
import bs58 from 'bs58';
import { debugLog, debugError } from '@/utils/debug';

// DLMM Program ID
const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

// Jito tip accounts for bundle priority
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bVmkdzGHkWCkxHmq9b5S1C',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
];

// Strategy types for DLMM liquidity distribution
export enum StrategyType {
  Spot = 0,    // Uniform distribution across range
  BidAsk = 1,  // Concentrated around current price
  Curve = 2    // Concentrated curve
}

// Activation types for pools
export enum ActivationType {
  Slot = 0,
  Timestamp = 1
}

export interface DLMMAddLiquidityParams {
  poolAddress?: string; // If exists, add to existing pool
  // For new pool creation
  tokenXMint: string;   // Base token (usually the rift token)
  tokenYMint: string;   // Quote token (usually SOL/WSOL)
  binStep: number;      // Price granularity (1-400, common: 1, 5, 10, 20, 50, 100)
  feeBps?: number;      // Fee in basis points (default: 100 = 1%)
  // Liquidity params
  tokenXAmount: number; // Amount of token X to add
  tokenYAmount: number; // Amount of token Y to add
  // Strategy params
  strategy: StrategyType;
  rangeInterval?: number; // Number of bins on each side of active bin (default: 10)
  // Single-sided liquidity
  singleSided?: boolean; // If true, provide only token X (for selling) or token Y (for buying)
  // MCap-based bin range (optional - overrides rangeInterval when provided)
  mcapRange?: {
    minMcap: number;      // Minimum market cap (price = mcap / supply)
    maxMcap: number;      // Maximum market cap
    tokenSupply: number;  // Total token supply for price calculation
    useMcapMode: boolean; // Whether to use MCap mode for bin calculation
    currentRiftPriceUSD?: number; // Current rift price in USD (for price conversion)
    currentSolPriceUSD?: number;  // Current SOL price in USD (for price conversion)
  };
  // Wallet
  wallet: {
    publicKey: PublicKey;
    signTransaction: (tx: Transaction) => Promise<Transaction>;
    signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
    sendTransaction?: (tx: Transaction, connection: Connection) => Promise<string>;
  };
  connection: Connection;
  // Initial price for new pools (tokenY per tokenX, e.g., 0.001 SOL per rRIFT)
  initialPrice?: number;
}

export interface DLMMPoolInfo {
  address: string;
  tokenXMint: string;
  tokenYMint: string;
  binStep: number;
  activeBin: number;
  currentPrice: number;
  feeBps: number;
  reserveX: number;
  reserveY: number;
}

export interface DLMMPosition {
  address: string;
  poolAddress: string;
  binIds: number[];
  liquidity: string;
  tokenXAmount: number;
  tokenYAmount: number;
}

export class DLMMLiquidityService {
  private connection: Connection;
  private dlmmSdk: any = null;

  constructor(connection: Connection) {
    // Create a proper connection for DLMM operations
    // The passed connection might be a proxy that causes WebSocket issues
    this.connection = this.createDlmmConnection(connection);
  }

  /**
   * Create a connection suitable for DLMM operations
   * Uses actual RPC URL to avoid WebSocket proxy issues
   */
  private createDlmmConnection(fallbackConnection: Connection): Connection {
    // In browser, use the proxied connection with CSP-safe websocket
    if (typeof window !== 'undefined') {
      const { createProxiedConnection } = require('@/lib/solana/rpc-client');
      return createProxiedConnection();
    }
    // On server, use the fallback connection as-is
    return fallbackConnection;
  }

  /**
   * Update the connection (useful when connection changes or for singleton pattern)
   */
  updateConnection(newConnection: Connection): void {
    this.connection = this.createDlmmConnection(newConnection);
  }

  /**
   * Confirm transaction using polling (no WebSocket required)
   * This avoids CSP issues with WebSocket connections
   */
  private async confirmTransactionPolling(signature: string, maxRetries = 30): Promise<void> {
    debugLog('[DLMM] Confirming tx via polling:', signature.slice(0, 20) + '...');

    for (let i = 0; i < maxRetries; i++) {
      try {
        const status = await this.connection.getSignatureStatus(signature);

        if (status?.value?.confirmationStatus === 'confirmed' ||
            status?.value?.confirmationStatus === 'finalized') {
          debugLog('[DLMM] Transaction confirmed:', status.value.confirmationStatus);
          return;
        }

        if (status?.value?.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
        }
      } catch (error: any) {
        if (error.message?.includes('Transaction failed')) {
          throw error;
        }
        // Ignore polling errors and retry
      }

      // Wait 1 second before next poll
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new Error('Transaction confirmation timeout');
  }

  /**
   * Wait for Jito bundle to be confirmed on-chain
   * Polls the bundle status API until confirmed or timeout
   */
  private async waitForBundleConfirmation(bundleId: string, timeoutMs: number = 30000): Promise<boolean> {
    debugLog('[DLMM] Waiting for bundle confirmation:', bundleId.slice(0, 20) + '...');

    const startTime = Date.now();
    const pollInterval = 2000; // Poll every 2 seconds
    let lastStatus = '';

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(`/api/jito-bundle?bundleId=${bundleId}`);
        const result = await response.json();

        debugLog('[DLMM] Bundle status poll:', {
          bundleId: bundleId.slice(0, 20) + '...',
          status: result.status,
          landed: result.landed,
          slot: result.slot,
          elapsed: Math.round((Date.now() - startTime) / 1000) + 's'
        });

        if (result.status !== lastStatus) {
          lastStatus = result.status;
          debugLog('[DLMM] Bundle status changed to:', result.status);
        }

        if (result.landed) {
          debugLog('[DLMM] ✓ Bundle landed on-chain! Slot:', result.slot);
          return true;
        }

        // Check for terminal failure states
        if (result.status === 'Failed' || result.status === 'Invalid') {
          debugLog('[DLMM] ✗ Bundle failed with status:', result.status);
          debugLog('[DLMM] Bundle failure details:', JSON.stringify(result));
          return false;
        }

        // If status is still pending or unknown, keep polling
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (error) {
        debugLog('[DLMM] Error polling bundle status:', error);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    debugLog('[DLMM] ⚠️ Bundle confirmation timeout after', timeoutMs / 1000, 'seconds');
    debugLog('[DLMM] Last known status:', lastStatus || 'unknown');
    return false;
  }

  /**
   * Initialize DLMM SDK
   */
  private async initializeDLMM(): Promise<void> {
    if (this.dlmmSdk) return;

    try {
      const DLMM = await import('@meteora-ag/dlmm');
      this.dlmmSdk = DLMM.default || DLMM;
      debugLog('[DLMM] SDK initialized');
    } catch (error) {
      debugError('[DLMM] Failed to initialize SDK:', error);
      throw new Error('DLMM SDK not available');
    }
  }

  /**
   * Get all preset parameters for pool creation
   */
  async getPresetParameters(): Promise<any> {
    await this.initializeDLMM();

    const presets = await this.dlmmSdk.getAllPresetParameters(this.connection);
    debugLog('[DLMM] Available presets:', presets);
    return presets;
  }

  /**
   * Calculate the active bin ID from a given price
   * @param price The price (tokenY per tokenX)
   * @param binStep The bin step
   * @returns The bin ID
   */
  calculateActiveBinFromPrice(price: number, binStep: number, tokenXDecimals: number, tokenYDecimals: number): number {
    // DLMM price = (1 + binStep/10000)^binId * 10^(tokenXDecimals - tokenYDecimals)
    // To solve for binId: binId = log(price * 10^(tokenYDecimals - tokenXDecimals)) / log(1 + binStep/10000)
    const decimalFactor = Math.pow(10, tokenYDecimals - tokenXDecimals);
    const adjustedPrice = price * decimalFactor;
    const binId = Math.round(Math.log(adjustedPrice) / Math.log(1 + binStep / 10000));
    debugLog('[DLMM] calculateActiveBinFromPrice:', { price, binStep, tokenXDecimals, tokenYDecimals, decimalFactor, adjustedPrice, binId });
    return binId;
  }

  /**
   * Calculate price from bin ID
   */
  calculatePriceFromBin(binId: number, binStep: number, tokenXDecimals: number, tokenYDecimals: number): number {
    const decimalFactor = Math.pow(10, tokenXDecimals - tokenYDecimals);
    return Math.pow(1 + binStep / 10000, binId) * decimalFactor;
  }

  /**
   * Check if a DLMM pool exists for the given token pair
   */
  async findPool(tokenXMint: string, tokenYMint: string, binStep?: number): Promise<DLMMPoolInfo | null> {
    await this.initializeDLMM();

    try {
      // Use DLMM API to find existing pools
      const response = await fetch(`https://dlmm-api.meteora.ag/pair/all`);
      if (!response.ok) {
        debugLog('[DLMM] API not available, returning null');
        return null;
      }

      const pairs = await response.json();

      // Find matching pair
      const match = pairs.find((p: any) => {
        const matchesTokens = (
          (p.mint_x === tokenXMint && p.mint_y === tokenYMint) ||
          (p.mint_x === tokenYMint && p.mint_y === tokenXMint)
        );
        if (binStep) {
          return matchesTokens && p.bin_step === binStep;
        }
        return matchesTokens;
      });

      if (match) {
        return {
          address: match.address,
          tokenXMint: match.mint_x,
          tokenYMint: match.mint_y,
          binStep: match.bin_step,
          activeBin: match.active_id,
          currentPrice: parseFloat(match.current_price),
          feeBps: match.base_fee_percentage * 100,
          reserveX: parseFloat(match.reserve_x) || 0,
          reserveY: parseFloat(match.reserve_y) || 0
        };
      }

      return null;
    } catch (error) {
      debugError('[DLMM] Error finding pool:', error);
      return null;
    }
  }

  /**
   * Get pool creation instructions without sending (for bundling)
   */
  async getPoolCreationInstructions(params: {
    tokenXMint: string;
    tokenYMint: string;
    binStep: number;
    feeBps: number;
    initialPrice: number;
    walletPubkey: PublicKey;
  }): Promise<{
    success: boolean;
    instructions?: TransactionInstruction[];
    poolAddress?: string;
    activeBinId?: number;
    error?: string;
  }> {
    await this.initializeDLMM();

    const { tokenXMint, tokenYMint, binStep, feeBps, initialPrice, walletPubkey } = params;
    const tokenX = new PublicKey(tokenXMint);
    const tokenY = new PublicKey(tokenYMint);

    try {
      // For bundled transactions, the rift mint doesn't exist yet
      // New rift mints always use 9 decimals (Token-2022 standard)
      const tokenXDecimals = 9;
      const tokenYDecimals = tokenYMint === NATIVE_MINT.toBase58() ? 9 : 9;

      debugLog('[DLMM-IX] Using decimals:', { tokenX: tokenXDecimals, tokenY: tokenYDecimals });

      // Calculate active bin ID from initial price
      const activeBinId = initialPrice
        ? this.calculateActiveBinFromPrice(initialPrice, binStep, tokenXDecimals, tokenYDecimals)
        : 0;

      debugLog('[DLMM-IX] Calculated active bin:', activeBinId, 'from price:', initialPrice);

      // Derive pool address using SDK's function for customizable permissionless pairs
      const { deriveCustomizablePermissionlessLbPair } = await import('@meteora-ag/dlmm');
      const [poolAddress] = deriveCustomizablePermissionlessLbPair(tokenX, tokenY, DLMM_PROGRAM_ID);

      debugLog('[DLMM-IX] Expected pool address (SDK derived):', poolAddress.toBase58());

      // Create the pool transaction using SDK
      const createPoolTx = await this.dlmmSdk.createCustomizablePermissionlessLbPair2(
        this.connection,
        new BN(binStep),
        tokenX,
        tokenY,
        new BN(activeBinId),
        new BN(feeBps),
        ActivationType.Timestamp,
        false, // hasAlphaVault
        walletPubkey,
        undefined, // activationPoint
        false // creatorPoolOnOffControl
      );

      // Extract instructions (skip compute budget, we'll add our own)
      const instructions = createPoolTx.instructions;

      debugLog('[DLMM-IX] Got', instructions.length, 'pool creation instructions');

      return {
        success: true,
        instructions,
        poolAddress: poolAddress.toBase58(),
        activeBinId
      };
    } catch (error: any) {
      debugError('[DLMM-IX] Error getting pool instructions:', error);
      return {
        success: false,
        error: error?.message || 'Failed to get pool creation instructions'
      };
    }
  }

  /**
   * Create a new DLMM pool and add initial liquidity
   * @param onProgress Optional callback to report progress (step: 1=pool creation start, 2=pool created, 3=add liq start, 4=complete)
   */
  async createPoolAndAddLiquidity(params: DLMMAddLiquidityParams, onProgress?: (step: number, message: string) => void): Promise<{
    signature: string;
    poolAddress: string;
    positionAddress: string;
  }> {
    await this.initializeDLMM();

    const {
      tokenXMint,
      tokenYMint,
      binStep,
      feeBps = 100, // 1% default
      tokenXAmount,
      tokenYAmount,
      strategy,
      rangeInterval = 10,
      singleSided = false,
      mcapRange,
      wallet,
      initialPrice
    } = params;

    const tokenX = new PublicKey(tokenXMint);
    const tokenY = new PublicKey(tokenYMint);

    debugLog('[DLMM] Creating pool:', {
      tokenX: tokenXMint,
      tokenY: tokenYMint,
      binStep,
      feeBps,
      tokenXAmount,
      tokenYAmount,
      mcapRange,
      singleSided,
      strategy,
      initialPrice
    });

    try {
      // Get token decimals
      const { getMint } = await import('@solana/spl-token');

      let tokenXDecimals = 9;
      let tokenYDecimals = 9;

      // Try Token-2022 first for tokenX
      try {
        const mintX = await getMint(this.connection, tokenX, 'confirmed', TOKEN_2022_PROGRAM_ID);
        tokenXDecimals = mintX.decimals;
      } catch {
        try {
          const mintX = await getMint(this.connection, tokenX, 'confirmed', TOKEN_PROGRAM_ID);
          tokenXDecimals = mintX.decimals;
        } catch {
          debugLog('[DLMM] Could not fetch tokenX decimals, using 9');
        }
      }

      // Token Y (usually SOL)
      if (tokenYMint === NATIVE_MINT.toBase58()) {
        tokenYDecimals = 9;
      } else {
        try {
          const mintY = await getMint(this.connection, tokenY, 'confirmed', TOKEN_2022_PROGRAM_ID);
          tokenYDecimals = mintY.decimals;
        } catch {
          try {
            const mintY = await getMint(this.connection, tokenY, 'confirmed', TOKEN_PROGRAM_ID);
            tokenYDecimals = mintY.decimals;
          } catch {
            debugLog('[DLMM] Could not fetch tokenY decimals, using 9');
          }
        }
      }

      // Calculate active bin ID from initial price
      const activeBinId = initialPrice
        ? this.calculateActiveBinFromPrice(initialPrice, binStep, tokenXDecimals, tokenYDecimals)
        : 0;

      debugLog('[DLMM] Calculated active bin:', activeBinId, 'from price:', initialPrice);

      // Use SDK to find existing pools for this token pair
      // This is the most reliable way since PDA derivation varies
      let poolAlreadyExists = false;
      let poolAddress: PublicKey | undefined;

      debugLog('[DLMM] Checking for existing pool via SDK...');

      // Use the SDK's dedicated method to check if customizable permissionless pool exists
      // This is much faster than fetching all pairs
      try {
        // Try both token orderings since DLMM sorts tokens internally
        let existingPairKey = await this.dlmmSdk.getCustomizablePermissionlessLbPairIfExists(
          this.connection,
          tokenX,
          tokenY
        );

        if (!existingPairKey) {
          // Try reversed order
          existingPairKey = await this.dlmmSdk.getCustomizablePermissionlessLbPairIfExists(
            this.connection,
            tokenY,
            tokenX
          );
        }

        if (existingPairKey) {
          poolAlreadyExists = true;
          poolAddress = existingPairKey;
          debugLog('[DLMM] Found existing pool:', existingPairKey.toBase58());
        }
      } catch (e: any) {
        debugLog('[DLMM] Pool existence check failed:', e?.message?.slice(0, 100));
      }

      if (poolAlreadyExists && poolAddress) {
        debugLog('[DLMM] Pool already exists at:', poolAddress.toBase58(), '- skipping creation');
        onProgress?.(2, 'Pool already exists');
        // poolAddress is already set from the search above
      } else {
        debugLog('[DLMM] Pool does not exist, creating new pool...');
        onProgress?.(1, 'Creating DLMM pool...');

        // Derive the pool address using SDK's function for customizable permissionless pairs
        // This is different from regular pairs - it doesn't include binStep in the derivation
        const { deriveCustomizablePermissionlessLbPair } = await import('@meteora-ag/dlmm');
        const [newPoolAddress] = deriveCustomizablePermissionlessLbPair(tokenX, tokenY, DLMM_PROGRAM_ID);

        debugLog('[DLMM] Expected new pool address (SDK derived):', newPoolAddress.toBase58());

        try {
          // Create the pool transaction
          const createPoolTx = await this.dlmmSdk.createCustomizablePermissionlessLbPair2(
            this.connection,
            new BN(binStep),
            tokenX,
            tokenY,
            new BN(activeBinId),
            new BN(feeBps),
            ActivationType.Timestamp,
            false, // hasAlphaVault
            wallet.publicKey,
            undefined, // activationPoint
            false // creatorPoolOnOffControl
          );

          // Add compute budget
          const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
            units: 400_000
          });
          const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 100_000
          });

          createPoolTx.instructions.unshift(computeBudgetIx, priorityFeeIx);

          // Let wallet populate blockhash; set fee payer only
          createPoolTx.feePayer = wallet.publicKey;
          // Ensure recent blockhash is set before handing to wallet (Phantom requires it)
          if (!createPoolTx.recentBlockhash) {
            const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
            createPoolTx.recentBlockhash = blockhash;
          }

          // Pre-simulate via RPC proxy to catch issues before prompting wallet
          try {
            const simTx = Transaction.from(
              createPoolTx.serialize({ requireAllSignatures: false, verifySignatures: false })
            );
            const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
            simTx.recentBlockhash = blockhash;
            const simEncoded = simTx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
            // Use console.log so it appears even in production builds
            console.log('[DLMM] Pre-simulating pool creation (sigVerify: false)...', {
              programs: simTx.instructions.map(ix => ix.programId.toBase58()),
              feePayer: simTx.feePayer?.toBase58?.(),
              blockhash,
            });
            const simResp = await fetch('/api/rpc-http', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'sim_dlmm_pool',
                method: 'simulateTransaction',
                params: [
                  simEncoded,
                  {
                    encoding: 'base64',
                    sigVerify: false,
                    commitment: 'processed',
                    replaceRecentBlockhash: true,
                  },
                ],
              }),
            });
            const simJson = await simResp.json();
          if (simJson.error) {
            debugLog('[DLMM] ❌ Pool sim RPC error:', simJson.error);
            throw new Error(simJson.error.message || 'Pool simulation RPC error');
          }
            if (simJson.result?.value?.err) {
              debugLog('[DLMM] ❌ Pool sim failed:', simJson.result.value.err, simJson.result.value.logs);
              throw new Error(`Pool simulation failed: ${JSON.stringify(simJson.result.value.err)}`);
            }
            debugLog('[DLMM] ✅ Pool simulation passed, units:', simJson.result?.value?.unitsConsumed);
          } catch (simErr: any) {
            debugLog('[DLMM] Pool simulation error:', simErr?.message || simErr);
            throw simErr;
          }

          let poolSignature: string;
          if (wallet.sendTransaction) {
            poolSignature = await wallet.sendTransaction(createPoolTx, this.connection);
          } else {
            const signedPoolTx = await wallet.signTransaction(createPoolTx);
            poolSignature = await this.connection.sendRawTransaction(signedPoolTx.serialize(), {
              skipPreflight: false,
              preflightCommitment: 'confirmed'
            });
            debugLog('[DLMM] Wallet lacks sendTransaction, used sign+sendRawTransaction for pool creation');
          }

          debugLog('[DLMM] Pool creation tx sent:', poolSignature);
          await this.confirmTransactionPolling(poolSignature);

          poolAddress = newPoolAddress;
          debugLog('[DLMM] Pool created at:', poolAddress.toBase58());
          onProgress?.(2, 'Pool created successfully');
        } catch (createError: any) {
          // Check if pool already exists (account already in use error)
          const errorMsg = createError?.message || createError?.toString() || '';
          if (errorMsg.includes('already in use') || errorMsg.includes('0x0')) {
            debugLog('[DLMM] Pool creation failed - pool already exists, extracting address from error...');

            // Try to extract pool address from error message
            // Error format: "Allocate: account Address { address: XXXX, base: None } already in use"
            const addressMatch = errorMsg.match(/address:\s*([A-HJ-NP-Za-km-z1-9]{32,44})/);
            if (addressMatch && addressMatch[1]) {
              try {
                poolAddress = new PublicKey(addressMatch[1]);
                debugLog('[DLMM] Extracted existing pool address from error:', poolAddress.toBase58());
              } catch {
                debugError('[DLMM] Failed to parse pool address from error');
              }
            }

            // If we couldn't extract from error, try SDK search
            if (!poolAddress) {
              try {
                const allPairs = await this.dlmmSdk.getLbPairs(this.connection);
                const matchingPair = allPairs.find((p: any) => {
                  const pairTokenX = p.tokenX?.mint?.toBase58() || p.lbPair?.tokenXMint?.toBase58();
                  const pairTokenY = p.tokenY?.mint?.toBase58() || p.lbPair?.tokenYMint?.toBase58();
                  const pairBinStep = p.lbPair?.binStep;

                  return (
                    ((pairTokenX === tokenXMint && pairTokenY === tokenYMint) ||
                     (pairTokenX === tokenYMint && pairTokenY === tokenXMint)) &&
                    pairBinStep === binStep
                  );
                });

                if (matchingPair) {
                  poolAddress = matchingPair.publicKey;
                  debugLog('[DLMM] Found existing pool via SDK search:', matchingPair.publicKey.toBase58());
                  onProgress?.(2, 'Found existing pool');
                } else {
                  throw new Error('Pool exists but could not be found via SDK');
                }
              } catch (searchError: any) {
                debugError('[DLMM] Failed to find existing pool:', searchError);
                throw createError; // Re-throw original error
              }
            }
          } else {
            throw createError; // Re-throw if not "already in use" error
          }
        }
      }

      // Ensure we have a pool address
      if (!poolAddress) {
        throw new Error('Failed to create or find pool address');
      }

      // Now add liquidity to the pool
      onProgress?.(3, 'Adding liquidity...');

      // Retry fetching pool with delays (RPC propagation can take a few seconds)
      // For customizable permissionless pairs, the SDK's getCustomizablePermissionlessLbPairIfExists
      // is more reliable than our manual PDA derivation
      let dlmmPool: any = null;
      let actualPoolAddress: PublicKey | null = poolAddress;
      const maxRetries = 15;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          debugLog('[DLMM] Fetching pool (attempt', attempt, 'of', maxRetries + ')...');

          // First try to find the pool address using SDK's method (more reliable for customizable pairs)
          if (attempt > 1) {
            // Try to find the actual pool address using SDK
            const foundAddress = await this.dlmmSdk.getCustomizablePermissionlessLbPairIfExists(
              this.connection,
              tokenX,
              tokenY
            );
            if (foundAddress) {
              actualPoolAddress = foundAddress;
              debugLog('[DLMM] Found pool via SDK lookup:', foundAddress.toBase58());
            } else {
              // Try reversed order
              const foundAddressReversed = await this.dlmmSdk.getCustomizablePermissionlessLbPairIfExists(
                this.connection,
                tokenY,
                tokenX
              );
              if (foundAddressReversed) {
                actualPoolAddress = foundAddressReversed;
                debugLog('[DLMM] Found pool via SDK lookup (reversed):', foundAddressReversed.toBase58());
              }
            }
          }

          // Try to create DLMM instance with the pool address
          dlmmPool = await this.dlmmSdk.create(this.connection, actualPoolAddress);
          debugLog('[DLMM] Pool fetched successfully at:', actualPoolAddress?.toBase58());
          poolAddress = actualPoolAddress!; // Update poolAddress to the actual one
          break;
        } catch (fetchErr: any) {
          if (attempt === maxRetries) {
            debugError('[DLMM] Failed to fetch pool after', maxRetries, 'attempts:', fetchErr.message);
            throw fetchErr;
          }
          debugLog('[DLMM] Pool not found yet, waiting 2s before retry...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      if (!dlmmPool) {
        throw new Error('Failed to fetch pool after creation');
      }

      // Get active bin and pool info
      const activeBin = await dlmmPool.getActiveBin();

      // Get actual token decimals from the pool
      // Use the fetched decimals from earlier (tokenXDecimals, tokenYDecimals)
      // These were already fetched correctly above
      const poolTokenXDecimals = tokenXDecimals;
      const poolTokenYDecimals = tokenYDecimals;

      debugLog('[DLMM] Active bin info:', {
        binId: activeBin.binId,
        price: activeBin.price,
        pricePerToken: activeBin.pricePerToken
      });

      debugLog('[DLMM] Pool decimals:', {
        tokenX: poolTokenXDecimals,
        tokenY: poolTokenYDecimals,
        tokenXMint: dlmmPool.tokenX.publicKey.toBase58(),
        tokenYMint: dlmmPool.tokenY.publicKey.toBase58()
      });

      // For single-sided liquidity:
      // - Selling tokenX (typical for meme token launches): bins ABOVE active bin, only tokenX provided
      // - Buying tokenX (accumulating): bins BELOW active bin, only tokenY provided
      let minBinId: number;
      let maxBinId: number;
      let effectiveXAmount = tokenXAmount;
      let effectiveYAmount = tokenYAmount;

      // Check if we should use MCap-based bin calculation
      // Maximum bins per transaction - reduced to stay under 10KB realloc limit
      // Each bin requires ~152 bytes, so 50 bins ≈ 7.6KB < 10KB limit
      const MAX_BINS_PER_TX = 50;
      // Jito max bundle size is 5 transactions
      const MAX_TXS_PER_BUNDLE = 4;

      // Store the full requested range (before any clamping) for Jito bundling
      let requestedMinBinId: number;
      let requestedMaxBinId: number;
      let needsMultipleTxs = false;

      // Use MCap range when provided (works for both new and existing pools)
      const shouldUseMcapRange = mcapRange && mcapRange.useMcapMode && mcapRange.tokenSupply > 0 && mcapRange.minMcap > 0 && mcapRange.maxMcap > 0;

      if (shouldUseMcapRange) {
        debugLog('[DLMM] Using MCap-based range', poolAlreadyExists ? '(existing pool)' : '(new pool)');

        // IMPORTANT: MCap values from DLMMConfigPanel are in SOL, not USD!
        // The panel calculates: minPriceSol * tokenSupply = minMcap (in SOL)
        // So we need to divide by supply to get back to SOL per token
        const minPriceSOL = mcapRange.minMcap / mcapRange.tokenSupply; // SOL per rift
        const maxPriceSOL = mcapRange.maxMcap / mcapRange.tokenSupply; // SOL per rift

        // Check pool's actual token order
        const poolTokenXMint = dlmmPool.tokenX.publicKey.toBase58();
        const poolTokenYMint = dlmmPool.tokenY.publicKey.toBase58();
        const inputTokenXMint = tokenX.toBase58();
        const inputTokenYMint = tokenY.toBase58();
        const WSOL_MINT = 'So11111111111111111111111111111111111111112';

        debugLog('[DLMM] Token order check:', {
          inputX: inputTokenXMint,
          inputY: inputTokenYMint,
          poolX: poolTokenXMint,
          poolY: poolTokenYMint,
          riftIsX: poolTokenXMint !== WSOL_MINT,
          solIsX: poolTokenXMint === WSOL_MINT
        });

        // Prices are already in SOL terms from DLMMConfigPanel
        // For rift/SOL pool: price = "SOL per rift" (which is what we have)
        // For SOL/rift pool: price = "rift per SOL" (need to invert)
        let minPrice: number;
        let maxPrice: number;

        if (poolTokenXMint === WSOL_MINT) {
          // Pool is SOL/rift (SOL=X, rift=Y): price = "rift per SOL"
          // We have SOL per rift, so invert: rift per SOL = 1 / (SOL per rift)
          minPrice = 1 / minPriceSOL; // rift per SOL
          maxPrice = 1 / maxPriceSOL; // rift per SOL
        } else {
          // Pool is rift/SOL (rift=X, SOL=Y): price = "SOL per rift"
          // We already have SOL per rift, use directly
          minPrice = minPriceSOL; // SOL per rift
          maxPrice = maxPriceSOL; // SOL per rift
        }

        debugLog('[DLMM] Price conversion:', {
          poolTokenOrder: poolTokenXMint === WSOL_MINT ? 'SOL/rift (price=rift per SOL)' : 'rift/SOL (price=SOL per rift)',
          minPriceSOL,
          maxPriceSOL,
          initialPrice,
          minPrice,
          maxPrice,
          formula: poolTokenXMint === WSOL_MINT
            ? `rift/SOL = 1 / (SOL/rift) = 1 / ${minPriceSOL} = ${minPrice}`
            : `SOL/rift = ${minPriceSOL} (already in correct units)`
        });

        // Calculate bin IDs from prices using pool's actual decimals
        // NOTE: Position bins are stored in the formula reference frame, NOT the SDK's offset frame
        // The SDK's activeBin.binId has an internal offset, but positions use formula bins
        minBinId = this.calculateActiveBinFromPrice(minPrice, binStep, poolTokenXDecimals, poolTokenYDecimals);
        maxBinId = this.calculateActiveBinFromPrice(maxPrice, binStep, poolTokenXDecimals, poolTokenYDecimals);

        // Ensure minBinId < maxBinId
        if (minBinId > maxBinId) {
          [minBinId, maxBinId] = [maxBinId, minBinId];
        }

        // Verify bins by converting back to prices
        const verifyMinPrice = this.calculatePriceFromBin(minBinId, binStep, poolTokenXDecimals, poolTokenYDecimals);
        const verifyMaxPrice = this.calculatePriceFromBin(maxBinId, binStep, poolTokenXDecimals, poolTokenYDecimals);

        debugLog('[DLMM] MCap mode: minMcap=', mcapRange.minMcap, 'maxMcap=', mcapRange.maxMcap, 'supply=', mcapRange.tokenSupply);
        debugLog('[DLMM] MCap-derived prices (adjusted): min=', minPrice, 'max=', maxPrice);
        debugLog('[DLMM] MCap-derived bins:', minBinId, 'to', maxBinId, '(', maxBinId - minBinId + 1, 'bins)');
        debugLog('[DLMM] Bin verification - bins', minBinId, 'to', maxBinId, 'represent prices:', verifyMinPrice, 'to', verifyMaxPrice);

        // When using MCap mode, we want the exact price range specified, not adjusted for single-sided
        // The MCap range represents the target market price range, so we should NOT shift bins
        // even if only one token is provided (single-sided)
        // The user explicitly set the price range they want, so respect it
        if (singleSided) {
          debugLog('[DLMM] Single-sided deposit in MCap mode: keeping exact bin range', minBinId, 'to', maxBinId);
          debugLog('[DLMM] Note: Single-sided liquidity in MCap mode will only fill bins that match the token provided');
          effectiveYAmount = 0;
          // DO NOT adjust minBinId for MCap mode - use the exact range specified
        }

        // Store the full requested range
        requestedMinBinId = minBinId;
        requestedMaxBinId = maxBinId;
        needsMultipleTxs = (requestedMaxBinId - requestedMinBinId + 1) > MAX_BINS_PER_TX;

        debugLog('[DLMM] Full requested range:', requestedMinBinId, 'to', requestedMaxBinId,
          '(', requestedMaxBinId - requestedMinBinId + 1, 'bins)');
        debugLog('[DLMM] Needs multiple transactions:', needsMultipleTxs);
      } else if (singleSided) {
        // Single-sided: provide only tokenX (selling mode)
        // Place bins above current price so the token gets sold as price rises
        minBinId = activeBin.binId + 1;
        maxBinId = activeBin.binId + rangeInterval;
        effectiveYAmount = 0; // No quote token for single-sided selling
        debugLog('[DLMM] Single-sided mode: selling tokenX, bins', minBinId, 'to', maxBinId);

        // Store the full requested range
        requestedMinBinId = minBinId;
        requestedMaxBinId = maxBinId;
        needsMultipleTxs = false; // Default ranges are small
      } else {
        // Two-sided: distribute around active bin
        minBinId = activeBin.binId - rangeInterval;
        maxBinId = activeBin.binId + rangeInterval;

        // Store the full requested range
        requestedMinBinId = minBinId;
        requestedMaxBinId = maxBinId;
        needsMultipleTxs = false; // Default ranges are small
      }

      // Prepare amounts - but first check actual balance for Token-2022 mints (may have transfer fees)
      let requestedXAmount = new BN(Math.floor(effectiveXAmount * Math.pow(10, tokenXDecimals)));
      const totalYAmount = new BN(Math.floor(effectiveYAmount * Math.pow(10, tokenYDecimals)));

      // For Token-2022 tokens with transfer fees, the user may have less than expected
      // Check actual balance and use that if it's less than requested
      try {
        const userTokenXAta = await getAssociatedTokenAddress(
          tokenX,
          wallet.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        );
        const { getAccount } = await import('@solana/spl-token');
        const tokenAccount = await getAccount(this.connection, userTokenXAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
        const actualBalance = new BN(tokenAccount.amount.toString());

        if (actualBalance.lt(requestedXAmount)) {
          debugLog('[DLMM] Adjusting amount due to transfer fees. Requested:', requestedXAmount.toString(), 'Actual balance:', actualBalance.toString());
          // Use 99.5% of actual balance to leave room for any additional fees
          requestedXAmount = actualBalance.muln(995).divn(1000);
        }
      } catch (balanceErr: any) {
        debugLog('[DLMM] Could not check token balance, using requested amount:', balanceErr.message);
      }

      const totalXAmount = requestedXAmount;

      debugLog('[DLMM] Liquidity amounts:', {
        tokenX: totalXAmount.toString(),
        tokenY: totalYAmount.toString(),
        binRange: `${requestedMinBinId} to ${requestedMaxBinId}`,
        singleSided,
        needsMultipleTxs
      });

      // ComputeBudget program ID for checking if instructions already exist
      const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';

      // If we need multiple transactions, use Jito bundling
      if (needsMultipleTxs) {
        debugLog('[DLMM] Using Jito bundle for large bin range');
        onProgress?.(3, 'Preparing Jito bundle for large range...');

        // Calculate number of chunks needed
        const totalBins = requestedMaxBinId - requestedMinBinId + 1;
        const numChunks = Math.ceil(totalBins / MAX_BINS_PER_TX);
        debugLog('[DLMM] Splitting into', numChunks, 'chunks of', MAX_BINS_PER_TX, 'bins each');

        // Calculate amount per chunk (split proportionally)
        const xAmountPerChunk = totalXAmount.divn(numChunks);
        const yAmountPerChunk = totalYAmount.divn(numChunks);

        // Get a single blockhash for ALL transactions (required for Jito bundles)
        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
        debugLog('[DLMM] Got blockhash for bundle:', blockhash.slice(0, 20) + '...');

        // IMPORTANT: Create Token Y (WSOL) ATA if it doesn't exist
        // DLMM requires both user_token_x and user_token_y accounts even for single-sided deposits
        const userTokenYAta = await getAssociatedTokenAddress(
          tokenY,
          wallet.publicKey,
          false,
          TOKEN_PROGRAM_ID // WSOL uses standard SPL Token program
        );

        let createTokenYAtaIx: any = null;
        const userTokenYAtaInfo = await this.connection.getAccountInfo(userTokenYAta);
        if (userTokenYAtaInfo) {
          debugLog('[DLMM] User Token Y ATA exists:', userTokenYAta.toBase58());
        } else {
          debugLog('[DLMM] User Token Y ATA does not exist, will create:', userTokenYAta.toBase58());
          createTokenYAtaIx = createAssociatedTokenAccountInstruction(
            wallet.publicKey, // payer
            userTokenYAta, // ata
            wallet.publicKey, // owner
            tokenY, // mint (WSOL)
            TOKEN_PROGRAM_ID
          );
        }

        // Also check Token X ATA (rift token - Token-2022)
        const userTokenXAta = await getAssociatedTokenAddress(
          tokenX,
          wallet.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        );

        let createTokenXAtaIx: any = null;
        const userTokenXAtaInfo = await this.connection.getAccountInfo(userTokenXAta);
        if (userTokenXAtaInfo) {
          debugLog('[DLMM] User Token X ATA exists:', userTokenXAta.toBase58());
        } else {
          debugLog('[DLMM] User Token X ATA does not exist, will create:', userTokenXAta.toBase58());
          createTokenXAtaIx = createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            userTokenXAta,
            wallet.publicKey,
            tokenX,
            TOKEN_2022_PROGRAM_ID
          );
        }

        // Prepare all position transactions
        const allTransactions: Transaction[] = [];
        const allPositionKeypairs: Keypair[] = [];

        for (let i = 0; i < numChunks; i++) {
          const chunkMinBin = requestedMinBinId + (i * MAX_BINS_PER_TX);
          const chunkMaxBin = Math.min(chunkMinBin + MAX_BINS_PER_TX - 1, requestedMaxBinId);

          // Adjust amounts for last chunk to use remaining amounts
          const isLastChunk = i === numChunks - 1;
          const chunkXAmount = isLastChunk
            ? totalXAmount.sub(xAmountPerChunk.muln(numChunks - 1))
            : xAmountPerChunk;
          const chunkYAmount = isLastChunk
            ? totalYAmount.sub(yAmountPerChunk.muln(numChunks - 1))
            : yAmountPerChunk;

          debugLog('[DLMM] Chunk', i + 1, 'of', numChunks, '- bins:', chunkMinBin, 'to', chunkMaxBin,
            'X:', chunkXAmount.toString(), 'Y:', chunkYAmount.toString());

          // Create position keypair for this chunk
          const positionKeypair = Keypair.generate();
          allPositionKeypairs.push(positionKeypair);

          // Create position and add liquidity transaction for this chunk
          const chunkTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: positionKeypair.publicKey,
            user: wallet.publicKey,
            totalXAmount: chunkXAmount,
            totalYAmount: chunkYAmount,
            strategy: {
              maxBinId: chunkMaxBin,
              minBinId: chunkMinBin,
              strategyType: strategy,
              ...(singleSided ? { singleSidedX: true } : {})
            },
            slippage: 100 // 1% slippage
          });

          const tx = Array.isArray(chunkTx) ? chunkTx[0] : chunkTx;
          tx.recentBlockhash = blockhash;
          tx.feePayer = wallet.publicKey;

          // Check if compute budget instructions already exist
          const hasComputeBudget = tx.instructions.some((ix: any) =>
            ix.programId?.toBase58() === COMPUTE_BUDGET_PROGRAM_ID
          );

          if (!hasComputeBudget) {
            const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
              units: 1_400_000
            });
            const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
              microLamports: 100_000 // Lower for bundle since we pay tip
            });
            tx.instructions.unshift(computeBudgetIx, priorityFeeIx);
          }

          // Add ATA creation instructions to the FIRST transaction only
          if (i === 0) {
            // Insert ATA creation instructions after compute budget but before other instructions
            const insertIndex = tx.instructions.findIndex((ix: any) =>
              ix.programId?.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID
            );
            if (createTokenYAtaIx) {
              debugLog('[DLMM] Adding Token Y ATA creation to first transaction');
              tx.instructions.splice(insertIndex, 0, createTokenYAtaIx);
            }
            if (createTokenXAtaIx) {
              debugLog('[DLMM] Adding Token X ATA creation to first transaction');
              tx.instructions.splice(insertIndex, 0, createTokenXAtaIx);
            }
          }

          // Add Jito tip to the last transaction of EACH bundle
          // Each bundle needs its own tip to be prioritized by Jito validators
          const positionInBundle = i % MAX_TXS_PER_BUNDLE;
          const isLastInBundle = (positionInBundle === MAX_TXS_PER_BUNDLE - 1) || (i === numChunks - 1);

          if (isLastInBundle) {
            // Use a different tip account for each bundle to avoid any duplicate detection
            const bundleIndex = Math.floor(i / MAX_TXS_PER_BUNDLE);
            const tipAccountIndex = bundleIndex % JITO_TIP_ACCOUNTS.length;
            const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[tipAccountIndex]);
            const tipIx = SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: tipAccount,
              lamports: 1_000_000, // 0.001 SOL tip per bundle
            });
            tx.instructions.push(tipIx);
            debugLog('[DLMM] Added Jito tip (0.001 SOL) to transaction', i, '(last in bundle', bundleIndex + 1, '), tipAccount:', tipAccount.toBase58().slice(0, 20) + '...');
          }

          allTransactions.push(tx);
        }

        // Get a FRESH blockhash right before signing to maximize validity window
        const freshBlockhashInfo = await this.connection.getLatestBlockhash('confirmed');
        const freshBlockhash = freshBlockhashInfo.blockhash;
        debugLog('[DLMM] Got fresh blockhash for signing:', freshBlockhash.slice(0, 20) + '...');

        // Update all transactions with fresh blockhash BEFORE any signing
        for (const tx of allTransactions) {
          tx.recentBlockhash = freshBlockhash;
        }

        // Partially sign all transactions with position keypairs
        for (let i = 0; i < allTransactions.length; i++) {
          allTransactions[i].partialSign(allPositionKeypairs[i]);
        }

        // Sign ALL transactions at once - required for Jito bundling
        onProgress?.(3, `Please approve all ${numChunks} transactions in bundle...`);
        debugLog('[DLMM] Requesting batch signature for', allTransactions.length, 'transactions');

        if (!wallet.signAllTransactions) {
          throw new Error('Your wallet does not support signAllTransactions. Please use a wallet that supports batch signing (e.g., Phantom, Backpack) for Jito bundling.');
        }

        debugLog('[DLMM] Using signAllTransactions (single popup)');
        const signedTxs = await wallet.signAllTransactions(allTransactions);
        debugLog('[DLMM] All', signedTxs.length, 'transactions signed in one click');

        // Simulate all transactions BEFORE sending to Jito to catch errors early
        debugLog('[DLMM] Simulating', signedTxs.length, 'transactions before Jito submission...');
        for (let i = 0; i < signedTxs.length; i++) {
          try {
            // Use legacy simulateTransaction API for Transaction objects (not VersionedTransaction)
            const simResult = await this.connection.simulateTransaction(signedTxs[i]);

            if (simResult.value.err) {
              debugLog('[DLMM] ❌ Transaction', i + 1, 'simulation FAILED:', JSON.stringify(simResult.value.err));
              debugLog('[DLMM] Simulation logs:', simResult.value.logs?.slice(-10));
              throw new Error(`Transaction ${i + 1} would fail: ${JSON.stringify(simResult.value.err)}`);
            } else {
              debugLog('[DLMM] ✓ Transaction', i + 1, 'simulation passed, units:', simResult.value.unitsConsumed);
            }
          } catch (simErr: any) {
            if (simErr.message?.includes('would fail')) throw simErr;
            debugLog('[DLMM] ⚠️ Transaction', i + 1, 'simulation error (non-fatal):', simErr.message);
          }
        }

        // Serialize all transactions (Jito expects base58 encoding)
        const serializedTxs = signedTxs.map(tx =>
          bs58.encode(tx.serialize())
        );
        debugLog('[DLMM] Serialized', serializedTxs.length, 'transactions (base58)');

        // Log transaction details for debugging
        for (let i = 0; i < signedTxs.length; i++) {
          const tx = signedTxs[i];
          debugLog('[DLMM] TX', i + 1, 'details:', {
            numSignatures: tx.signatures.length,
            numInstructions: tx.instructions.length,
            recentBlockhash: tx.recentBlockhash?.slice(0, 20) + '...',
            feePayer: tx.feePayer?.toBase58().slice(0, 20) + '...',
            serializedSize: serializedTxs[i].length + ' chars (base58)',
          });
        }

        // Split into bundles of MAX_TXS_PER_BUNDLE (Jito limit is 5 txs per bundle)
        const numBundles = Math.ceil(serializedTxs.length / MAX_TXS_PER_BUNDLE);
        debugLog('[DLMM] Sending', numBundles, 'bundles of up to', MAX_TXS_PER_BUNDLE, 'transactions each');

        // Prepare all bundle payloads
        const bundlePayloads: string[][] = [];
        for (let i = 0; i < numBundles; i++) {
          const start = i * MAX_TXS_PER_BUNDLE;
          const end = Math.min(start + MAX_TXS_PER_BUNDLE, serializedTxs.length);
          bundlePayloads.push(serializedTxs.slice(start, end));
        }

        // Helper function to send transactions via direct RPC (final fallback)
        const sendSequentialFallback = async (reason: string): Promise<{
          signature: string;
          poolAddress: string;
          positionAddress: string;
        }> => {
          debugLog('[DLMM] ⚠️', reason, '- using direct RPC...');
          onProgress?.(5, `${reason}, sending via direct RPC...`);

          const successfulSignatures: string[] = [];
          let lastError: string | null = null;

          for (let i = 0; i < signedTxs.length; i++) {
            try {
              debugLog('[DLMM] Sending transaction', i + 1, 'of', signedTxs.length, 'via RPC...');
              onProgress?.(5, `Sending transaction ${i + 1}/${signedTxs.length} via RPC...`);

              const currentTx = signedTxs[i];
              const blockheight = await this.connection.getBlockHeight('confirmed');

              const signature = await this.connection.sendRawTransaction(
                currentTx.serialize(),
                {
                  skipPreflight: false,
                  preflightCommitment: 'confirmed',
                  maxRetries: 3,
                }
              );

              debugLog('[DLMM] Transaction', i + 1, 'sent, signature:', signature.slice(0, 20) + '...');

              const confirmResult = await this.connection.confirmTransaction(
                {
                  signature,
                  blockhash: currentTx.recentBlockhash!,
                  lastValidBlockHeight: blockheight + 150,
                },
                'confirmed'
              );

              if (confirmResult.value.err) {
                debugLog('[DLMM] ❌ Transaction', i + 1, 'confirmed but failed:', confirmResult.value.err);
                lastError = `Transaction ${i + 1} failed: ${JSON.stringify(confirmResult.value.err)}`;
              } else {
                debugLog('[DLMM] ✓ Transaction', i + 1, 'confirmed successfully');
                successfulSignatures.push(signature);
              }
            } catch (txErr: any) {
              debugLog('[DLMM] ❌ Transaction', i + 1, 'error:', txErr.message);
              lastError = `Transaction ${i + 1} error: ${txErr.message}`;

              if (txErr.message?.includes('blockhash') || txErr.message?.includes('expired')) {
                debugLog('[DLMM] Blockhash expired, cannot continue with pre-signed transactions');
                throw new Error(`Transaction blockhash expired. Please try again. Successful txs: ${successfulSignatures.length}/${signedTxs.length}`);
              }
            }
          }

          if (successfulSignatures.length === 0) {
            throw new Error(`All transactions failed via fallback. Last error: ${lastError}`);
          }

          if (successfulSignatures.length < signedTxs.length) {
            debugLog('[DLMM] ⚠️ Only', successfulSignatures.length, 'of', signedTxs.length, 'transactions succeeded');
            onProgress?.(5, `${successfulSignatures.length}/${signedTxs.length} transactions confirmed`);
          } else {
            debugLog('[DLMM] ✓ All', successfulSignatures.length, 'transactions confirmed via RPC fallback');
            onProgress?.(5, `All ${successfulSignatures.length} transactions confirmed!`);
          }

          return {
            signature: successfulSignatures[0],
            poolAddress: poolAddress.toBase58(),
            positionAddress: allPositionKeypairs[0].publicKey.toBase58()
          };
        };

        // Helper function to send via Jito bundles (used as fallback)
        const sendViaJitoBundles = async (): Promise<{
          signature: string;
          poolAddress: string;
          positionAddress: string;
        } | null> => {
          try {
            onProgress?.(4, `Trying Jito bundles...`);
            debugLog('[DLMM] Sending', numBundles, 'bundles via Jito...');

            const bundleIds: string[] = [];

            for (let i = 0; i < bundlePayloads.length; i++) {
              const bundleTxs = bundlePayloads[i];
              debugLog('[DLMM] Sending bundle', i + 1, 'of', bundlePayloads.length, 'with', bundleTxs.length, 'transactions');

              const bundleResponse = await fetch('/api/jito-bundle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transactions: bundleTxs })
              });

              const bundleResult = await bundleResponse.json();
              debugLog('[DLMM] Bundle', i + 1, 'response:', bundleResult);

              if (!bundleResult.success || !bundleResult.bundleId) {
                debugLog('[DLMM] Bundle', i + 1, 'failed:', bundleResult.error);
                return null; // Jito failed, return null to try next fallback
              }

              debugLog('[DLMM] ✓ Bundle', i + 1, 'sent successfully, ID:', bundleResult.bundleId);
              bundleIds.push(bundleResult.bundleId);

              if (i < bundlePayloads.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
              }
            }

            debugLog('[DLMM] ✓ All', bundleIds.length, 'bundles sent');
            onProgress?.(5, `Waiting for Jito bundle to land...`);

            const lastBundleId = bundleIds[bundleIds.length - 1];
            const bundleLanded = await this.waitForBundleConfirmation(lastBundleId, 30000);

            if (!bundleLanded) {
              debugLog('[DLMM] Jito bundle did not land');
              return null;
            }

            debugLog('[DLMM] ✓ Jito bundle confirmed on-chain');
            onProgress?.(5, `Bundle confirmed on-chain!`);

            return {
              signature: bundleIds[0],
              poolAddress: poolAddress.toBase58(),
              positionAddress: allPositionKeypairs[0].publicKey.toBase58()
            };
          } catch (jitoErr: any) {
            debugLog('[DLMM] Jito error:', jitoErr.message);
            return null;
          }
        };

        // PRIMARY: Try Helius sender first (better landing rates, smart retries)
        try {
          onProgress?.(3, `Sending ${signedTxs.length} transactions via Helius...`);
          debugLog('[DLMM] PRIMARY: Sending', signedTxs.length, 'transactions via Helius...');

          const base64Txs = signedTxs.map(tx => tx.serialize().toString('base64'));

          const heliusResponse = await fetch('/api/helius-send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              transactions: base64Txs,
              sequential: true,
              skipPreflight: false,
              maxRetries: 3
            })
          });

          const heliusResult = await heliusResponse.json();
          debugLog('[DLMM] Helius response:', heliusResult);

          if (heliusResult.success && heliusResult.signatures?.length === signedTxs.length) {
            debugLog('[DLMM] ✓ All transactions sent via Helius');
            onProgress?.(5, `All ${heliusResult.signatures.length} transactions confirmed via Helius!`);
            return {
              signature: heliusResult.signatures[0],
              poolAddress: poolAddress.toBase58(),
              positionAddress: allPositionKeypairs[0].publicKey.toBase58()
            };
          }

          if (heliusResult.signatures?.length > 0) {
            // Partial success - return what we got
            debugLog('[DLMM] ⚠️ Helius partial:', heliusResult.successCount, '/', signedTxs.length);
            onProgress?.(5, `${heliusResult.successCount}/${signedTxs.length} confirmed via Helius`);
            return {
              signature: heliusResult.signatures[0],
              poolAddress: poolAddress.toBase58(),
              positionAddress: allPositionKeypairs[0].publicKey.toBase58()
            };
          }

          // Helius failed completely, try Jito
          debugLog('[DLMM] Helius failed, trying Jito fallback...', heliusResult.errors);
        } catch (heliusErr: any) {
          debugLog('[DLMM] Helius error:', heliusErr.message, '- trying Jito fallback...');
        }

        // FALLBACK 1: Try Jito bundles
        const jitoResult = await sendViaJitoBundles();
        if (jitoResult) {
          return jitoResult;
        }

        // FALLBACK 2: Direct RPC submission
        debugLog('[DLMM] Both Helius and Jito failed, using direct RPC...');
        return await sendSequentialFallback('Helius and Jito unavailable');
      }

      // Single transaction path (for small bin ranges)
      debugLog('[DLMM] Using single transaction for bin range');

      // IMPORTANT: Create Token ATAs if they don't exist (same as Jito bundle path)
      // DLMM requires both user_token_x and user_token_y accounts even for single-sided deposits
      const singleTxTokenYAta = await getAssociatedTokenAddress(
        tokenY,
        wallet.publicKey,
        false,
        TOKEN_PROGRAM_ID // WSOL uses standard SPL Token program
      );
      const singleTxTokenXAta = await getAssociatedTokenAddress(
        tokenX,
        wallet.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );

      let singleTxCreateAtaInstructions: any[] = [];

      const singleTxTokenYAtaInfo = await this.connection.getAccountInfo(singleTxTokenYAta);
      if (singleTxTokenYAtaInfo) {
        debugLog('[DLMM-Single] User Token Y ATA exists:', singleTxTokenYAta.toBase58());
      } else {
        debugLog('[DLMM-Single] User Token Y ATA does not exist, will create:', singleTxTokenYAta.toBase58());
        singleTxCreateAtaInstructions.push(createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          singleTxTokenYAta,
          wallet.publicKey,
          tokenY,
          TOKEN_PROGRAM_ID
        ));
      }

      const singleTxTokenXAtaInfo = await this.connection.getAccountInfo(singleTxTokenXAta);
      if (singleTxTokenXAtaInfo) {
        debugLog('[DLMM-Single] User Token X ATA exists:', singleTxTokenXAta.toBase58());
      } else {
        debugLog('[DLMM-Single] User Token X ATA does not exist, will create:', singleTxTokenXAta.toBase58());
        singleTxCreateAtaInstructions.push(createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          singleTxTokenXAta,
          wallet.publicKey,
          tokenX,
          TOKEN_2022_PROGRAM_ID
        ));
      }

      // Create position keypair
      const positionKeypair = Keypair.generate();

      // Create position and add liquidity
      const buildLiqTx = async (minBin: number, maxBin: number) => {
        return await dlmmPool.initializePositionAndAddLiquidityByStrategy({
          positionPubKey: positionKeypair.publicKey,
          user: wallet.publicKey,
          totalXAmount,
          totalYAmount,
          strategy: {
            maxBinId: maxBin,
            minBinId: minBin,
            strategyType: strategy,
            ...(singleSided ? { singleSidedX: true } : {})
          },
          slippage: 100 // 1% slippage
        });
      };

      let addLiquidityTx: any;
      try {
        addLiquidityTx = await buildLiqTx(requestedMinBinId, requestedMaxBinId);
      } catch (liqErr: any) {
        const msg = liqErr?.message || liqErr?.toString() || '';
        if (msg.includes('InvalidRealloc') || msg.toLowerCase().includes('realloc')) {
          // Fallback: shrink bin range to keep account realloc small
          const fallbackMin = activeBin.binId;
          const fallbackMax = activeBin.binId + Math.max(1, Math.min(rangeInterval, 2));
          debugLog('[DLMM] Realloc error; falling back to narrow bin range', fallbackMin, fallbackMax);
          addLiquidityTx = await buildLiqTx(fallbackMin, fallbackMax);
        } else {
          throw liqErr;
        }
      }

      // Add compute budget to liquidity tx (only if not already present)
      const txToSign = Array.isArray(addLiquidityTx) ? addLiquidityTx[0] : addLiquidityTx;

      // Check if compute budget instructions already exist
      const hasComputeBudget = txToSign.instructions.some((ix: any) =>
        ix.programId?.toBase58() === COMPUTE_BUDGET_PROGRAM_ID
      );

      if (!hasComputeBudget) {
        const liqComputeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
          units: 400_000
        });
        const liqPriorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 100_000
        });
        txToSign.instructions.unshift(liqComputeBudgetIx, liqPriorityFeeIx);
        debugLog('[DLMM] Added compute budget to liquidity tx');
      } else {
        debugLog('[DLMM] Compute budget already present in liquidity tx');
      }

      // Insert ATA creation instructions after compute budget (before DLMM instructions)
      if (singleTxCreateAtaInstructions.length > 0) {
        // Find insert position (after compute budget instructions)
        let insertIdx = 0;
        for (let i = 0; i < txToSign.instructions.length; i++) {
          if (txToSign.instructions[i].programId?.toBase58() === COMPUTE_BUDGET_PROGRAM_ID) {
            insertIdx = i + 1;
          } else {
            break; // Stop at first non-compute-budget instruction
          }
        }
        txToSign.instructions.splice(insertIdx, 0, ...singleTxCreateAtaInstructions);
        debugLog('[DLMM-Single] Inserted', singleTxCreateAtaInstructions.length, 'ATA creation instructions at index', insertIdx);
      }

      // Let wallet populate blockhash; set fee payer only
      txToSign.feePayer = wallet.publicKey;

      // Pre-simulate via RPC proxy to catch issues before prompting wallet
      const simulateLiquidityTx = async (tx: Transaction) => {
        const simTx = Transaction.from(
          tx.serialize({ requireAllSignatures: false, verifySignatures: false })
        );
        simTx.partialSign(positionKeypair);
        const { blockhash: liqBlockhash } = await this.connection.getLatestBlockhash('confirmed');
        simTx.recentBlockhash = liqBlockhash;
        const simEncoded = simTx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
        console.log('[DLMM] Pre-simulating add-liquidity tx (sigVerify: false)...', {
          programs: simTx.instructions.map(ix => ix.programId.toBase58()),
          feePayer: simTx.feePayer?.toBase58?.(),
          blockhash: liqBlockhash,
        });
        const simResp = await fetch('/api/rpc-http', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'sim_dlmm_liq',
            method: 'simulateTransaction',
            params: [
              simEncoded,
              {
                encoding: 'base64',
                sigVerify: false,
                commitment: 'processed',
                replaceRecentBlockhash: true,
              },
            ],
          }),
        });
        const simJson = await simResp.json();
        if (simJson.error) {
          console.log('[DLMM] ❌ Liquidity sim RPC error:', simJson.error);
          throw new Error(simJson.error.message || 'Liquidity simulation RPC error');
        }
        if (simJson.result?.value?.err) {
          console.log('[DLMM] ❌ Liquidity sim failed:', simJson.result.value.err, simJson.result.value.logs);
          throw new Error(`Liquidity simulation failed: ${JSON.stringify(simJson.result.value.err)}`);
        }
        console.log('[DLMM] ✅ Liquidity simulation passed, units:', simJson.result?.value?.unitsConsumed);
      };

      try {
        await simulateLiquidityTx(txToSign);
      } catch (simErr: any) {
        const msg = simErr?.message || simErr?.toString() || '';
        if (msg.includes('InvalidRealloc') || msg.toLowerCase().includes('realloc')) {
          // Fallback: rebuild with a very narrow bin range around active bin to reduce realloc size
          const fallbackMin = activeBin.binId;
          const fallbackMax = activeBin.binId + 1;
          debugLog('[DLMM] Liquidity sim realloc error; retrying with tiny range', fallbackMin, fallbackMax);
          const retryTxRaw = await buildLiqTx(fallbackMin, fallbackMax);
          const retryTx = Array.isArray(retryTxRaw) ? retryTxRaw[0] : retryTxRaw;
          retryTx.feePayer = wallet.publicKey;
          const hasComputeRetry = retryTx.instructions.some((ix: any) => ix.programId?.toBase58() === COMPUTE_BUDGET_PROGRAM_ID);
          if (!hasComputeRetry) {
            const liqComputeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
            const liqPriorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 });
            retryTx.instructions.unshift(liqComputeBudgetIx, liqPriorityFeeIx);
          }
          await simulateLiquidityTx(retryTx);
          // Replace txToSign contents with the retry transaction
          txToSign.instructions = retryTx.instructions;
          txToSign.recentBlockhash = retryTx.recentBlockhash;
          txToSign.feePayer = retryTx.feePayer;
        } else {
          console.log('[DLMM] Liquidity simulation error:', msg);
          throw simErr;
        }
      }

      // Sign and send liquidity transaction via wallet (fallback to sign+raw if needed)
      txToSign.partialSign(positionKeypair);
      let liquiditySignature: string;
      if (wallet.sendTransaction) {
        liquiditySignature = await wallet.sendTransaction(txToSign, this.connection);
      } else {
        const signedLiquidityTx = await wallet.signTransaction(txToSign);
        liquiditySignature = await this.connection.sendRawTransaction(signedLiquidityTx.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed'
        });
        debugLog('[DLMM] Wallet lacks sendTransaction, used sign+sendRawTransaction for liquidity');
      }

      debugLog('[DLMM] Liquidity added, tx:', liquiditySignature);
      await this.confirmTransactionPolling(liquiditySignature);

      onProgress?.(4, 'Liquidity added successfully');

      return {
        signature: liquiditySignature,
        poolAddress: poolAddress.toBase58(),
        positionAddress: positionKeypair.publicKey.toBase58()
      };
    } catch (error) {
      debugError('[DLMM] Error creating pool:', error);
      throw error;
    }
  }

  /**
   * Add liquidity to an existing DLMM pool
   */
  async addLiquidity(params: DLMMAddLiquidityParams): Promise<{
    signature: string;
    positionAddress: string;
  }> {
    await this.initializeDLMM();

    if (!params.poolAddress) {
      throw new Error('Pool address required for adding liquidity');
    }

    const {
      poolAddress,
      tokenXAmount,
      tokenYAmount,
      strategy,
      rangeInterval = 10,
      singleSided = false,
      mcapRange,
      wallet
    } = params;

    debugLog('[DLMM] Adding liquidity to pool:', poolAddress, { singleSided });

    try {
      const poolPubkey = new PublicKey(poolAddress);
      const dlmmPool = await this.dlmmSdk.create(this.connection, poolPubkey);

      // Get token decimals from mint accounts
      const tokenXMint = dlmmPool.tokenX.publicKey;
      const tokenYMint = dlmmPool.tokenY.publicKey;

      let tokenXDecimals = dlmmPool.tokenX?.decimal ?? dlmmPool.tokenX?.decimals;
      let tokenYDecimals = dlmmPool.tokenY?.decimal ?? dlmmPool.tokenY?.decimals;

      // If decimals not available from pool object, fetch from mint accounts
      if (tokenXDecimals === undefined || tokenYDecimals === undefined) {
        debugLog('[DLMM] Fetching decimals from mint accounts...');
        const [mintXInfo, mintYInfo] = await Promise.all([
          this.connection.getParsedAccountInfo(tokenXMint),
          this.connection.getParsedAccountInfo(tokenYMint)
        ]);

        if (tokenXDecimals === undefined && mintXInfo.value?.data && 'parsed' in mintXInfo.value.data) {
          tokenXDecimals = mintXInfo.value.data.parsed.info.decimals;
        }
        if (tokenYDecimals === undefined && mintYInfo.value?.data && 'parsed' in mintYInfo.value.data) {
          tokenYDecimals = mintYInfo.value.data.parsed.info.decimals;
        }
        debugLog('[DLMM] Fetched decimals - tokenX:', tokenXDecimals, 'tokenY:', tokenYDecimals);
      }

      // Get active bin
      const activeBin = await dlmmPool.getActiveBin();

      // For single-sided liquidity:
      // - Selling tokenX: bins ABOVE active bin, only tokenX provided
      // - Buying tokenX: bins BELOW active bin, only tokenY provided
      let minBinId: number;
      let maxBinId: number;
      let effectiveXAmount = tokenXAmount;
      let effectiveYAmount = tokenYAmount;

      // Check if we should use MCap-based bin calculation
      const binStep = dlmmPool.lbPair?.binStep || 10;
      debugLog('[DLMM] mcapRange:', mcapRange);
      debugLog('[DLMM] binStep:', binStep, 'tokenXDecimals:', tokenXDecimals, 'tokenYDecimals:', tokenYDecimals);

      if (mcapRange && mcapRange.useMcapMode && mcapRange.tokenSupply > 0 && mcapRange.minMcap > 0 && mcapRange.maxMcap > 0) {
        // Calculate prices from MCap: price = mcap / supply
        const minPrice = mcapRange.minMcap / mcapRange.tokenSupply;
        const maxPrice = mcapRange.maxMcap / mcapRange.tokenSupply;

        debugLog('[DLMM] MCap mode (existing pool): minMcap=', mcapRange.minMcap, 'maxMcap=', mcapRange.maxMcap, 'supply=', mcapRange.tokenSupply);
        debugLog('[DLMM] Calculated prices: minPrice=', minPrice, 'maxPrice=', maxPrice);

        // Calculate bin IDs from prices
        minBinId = this.calculateActiveBinFromPrice(minPrice, binStep, tokenXDecimals, tokenYDecimals);
        maxBinId = this.calculateActiveBinFromPrice(maxPrice, binStep, tokenXDecimals, tokenYDecimals);

        debugLog('[DLMM] MCap-derived bins:', minBinId, 'to', maxBinId);

        // Ensure minBinId < maxBinId
        if (minBinId > maxBinId) {
          [minBinId, maxBinId] = [maxBinId, minBinId];
        }

        if (singleSided) {
          if (minBinId < activeBin.binId) {
            minBinId = activeBin.binId + 1;
          }
          effectiveYAmount = 0;
          debugLog('[DLMM] Single-sided MCap mode: adjusted minBin to', minBinId);
        }
      } else if (singleSided) {
        // Single-sided: provide only tokenX (selling mode)
        minBinId = activeBin.binId + 1;
        maxBinId = activeBin.binId + rangeInterval;
        effectiveYAmount = 0;
        debugLog('[DLMM] Single-sided mode: selling tokenX, bins', minBinId, 'to', maxBinId);
      } else {
        // Two-sided: distribute around active bin
        minBinId = activeBin.binId - rangeInterval;
        maxBinId = activeBin.binId + rangeInterval;
      }

      const totalBins = maxBinId - minBinId + 1;
      debugLog('[DLMM] Active bin:', activeBin.binId, 'Range:', minBinId, '-', maxBinId, '(', totalBins, 'bins)');

      // Maximum bins per transaction - reduced to stay under 10KB realloc limit
      const MAX_BINS_PER_TX = 50;
      const MAX_TXS_PER_BUNDLE = 4;

      // Check if we need multiple transactions (large bin range)
      const needsMultipleTxs = totalBins > MAX_BINS_PER_TX;

      // IMPORTANT: Create Token ATAs if they don't exist
      // DLMM requires both user_token_x and user_token_y accounts even for single-sided deposits
      // Determine token programs - Token-2022 for rift tokens, standard SPL for WSOL
      const WSOL_MINT = 'So11111111111111111111111111111111111111112';
      const tokenXProgram = tokenXMint.toBase58() === WSOL_MINT ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
      const tokenYProgram = tokenYMint.toBase58() === WSOL_MINT ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

      const addLiqTokenXAta = await getAssociatedTokenAddress(
        tokenXMint,
        wallet.publicKey,
        false,
        tokenXProgram
      );
      const addLiqTokenYAta = await getAssociatedTokenAddress(
        tokenYMint,
        wallet.publicKey,
        false,
        tokenYProgram
      );

      let addLiqCreateAtaInstructions: any[] = [];

      const addLiqTokenXAtaInfo = await this.connection.getAccountInfo(addLiqTokenXAta);
      if (addLiqTokenXAtaInfo) {
        debugLog('[DLMM-AddLiq] User Token X ATA exists:', addLiqTokenXAta.toBase58());
      } else {
        debugLog('[DLMM-AddLiq] User Token X ATA does not exist, will create:', addLiqTokenXAta.toBase58());
        addLiqCreateAtaInstructions.push(createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          addLiqTokenXAta,
          wallet.publicKey,
          tokenXMint,
          tokenXProgram
        ));
      }

      const addLiqTokenYAtaInfo = await this.connection.getAccountInfo(addLiqTokenYAta);
      if (addLiqTokenYAtaInfo) {
        debugLog('[DLMM-AddLiq] User Token Y ATA exists:', addLiqTokenYAta.toBase58());
      } else {
        debugLog('[DLMM-AddLiq] User Token Y ATA does not exist, will create:', addLiqTokenYAta.toBase58());
        addLiqCreateAtaInstructions.push(createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          addLiqTokenYAta,
          wallet.publicKey,
          tokenYMint,
          tokenYProgram
        ));
      }

      if (needsMultipleTxs) {
        debugLog('[DLMM] Large bin range detected, using Jito bundle for', totalBins, 'bins');

        // Calculate number of chunks needed
        const numChunks = Math.ceil(totalBins / MAX_BINS_PER_TX);
        debugLog('[DLMM] Splitting into', numChunks, 'chunks of', MAX_BINS_PER_TX, 'bins each');

        // Calculate total amounts in lamports
        const totalXAmountBN = new BN(Math.floor(effectiveXAmount * Math.pow(10, tokenXDecimals)));
        const totalYAmountBN = new BN(Math.floor(effectiveYAmount * Math.pow(10, tokenYDecimals)));

        // Distribute amounts across chunks
        const xAmountPerChunk = totalXAmountBN.div(new BN(numChunks));
        const yAmountPerChunk = totalYAmountBN.div(new BN(numChunks));

        // Build all transactions
        const allTransactions: Transaction[] = [];
        const allPositionKeypairs: Keypair[] = [];

        for (let i = 0; i < numChunks; i++) {
          const chunkMinBin = minBinId + (i * MAX_BINS_PER_TX);
          const chunkMaxBin = Math.min(chunkMinBin + MAX_BINS_PER_TX - 1, maxBinId);

          // For last chunk, use remaining amounts
          const isLastChunk = i === numChunks - 1;
          const chunkXAmount = isLastChunk
            ? totalXAmountBN.sub(xAmountPerChunk.mul(new BN(numChunks - 1)))
            : xAmountPerChunk;
          const chunkYAmount = isLastChunk
            ? totalYAmountBN.sub(yAmountPerChunk.mul(new BN(numChunks - 1)))
            : yAmountPerChunk;

          debugLog('[DLMM] Chunk', i + 1, 'of', numChunks, '- bins:', chunkMinBin, 'to', chunkMaxBin,
            'X:', chunkXAmount.toString(), 'Y:', chunkYAmount.toString());

          const positionKeypair = Keypair.generate();
          allPositionKeypairs.push(positionKeypair);

          const chunkTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: positionKeypair.publicKey,
            user: wallet.publicKey,
            totalXAmount: chunkXAmount,
            totalYAmount: chunkYAmount,
            strategy: {
              maxBinId: chunkMaxBin,
              minBinId: chunkMinBin,
              strategyType: strategy,
              ...(singleSided ? { singleSidedX: true } : {})
            },
            slippage: 100
          });

          const tx = Array.isArray(chunkTx) ? chunkTx[0] : chunkTx;

          // Add compute budget only if not already present
          const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
          const hasComputeBudget = tx.instructions.some((ix: any) =>
            ix.programId?.toBase58() === COMPUTE_BUDGET_PROGRAM_ID
          );

          if (!hasComputeBudget) {
            const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
            const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 });
            tx.instructions.unshift(computeBudgetIx, priorityFeeIx);
          } else {
            debugLog('[DLMM] Compute budget already present in chunk', i + 1);
          }

          // Add ATA creation instructions to the first transaction only (if SDK didn't add them)
          if (i === 0 && addLiqCreateAtaInstructions.length > 0) {
            const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
            const existingAtaIx = tx.instructions.filter((ix: any) => ix.programId?.toBase58() === ATA_PROGRAM_ID);

            if (existingAtaIx.length > 0) {
              debugLog('[DLMM-AddLiq] SDK already added', existingAtaIx.length, 'ATA instructions, skipping');
            } else {
              // Find insert position (after compute budget instructions)
              let insertIdx = 0;
              for (let j = 0; j < tx.instructions.length; j++) {
                if (tx.instructions[j].programId?.toBase58() === COMPUTE_BUDGET_PROGRAM_ID) {
                  insertIdx = j + 1;
                } else {
                  break;
                }
              }
              tx.instructions.splice(insertIdx, 0, ...addLiqCreateAtaInstructions);
              debugLog('[DLMM-AddLiq] Inserted', addLiqCreateAtaInstructions.length, 'ATA creation instructions into first bundle tx');
            }
          }

          // Add Jito tip to the last transaction of EACH bundle
          // Each bundle needs its own tip to be prioritized by Jito validators
          const positionInBundle = i % MAX_TXS_PER_BUNDLE;
          const isLastInBundle = (positionInBundle === MAX_TXS_PER_BUNDLE - 1) || (i === numChunks - 1);

          if (isLastInBundle) {
            // Use a different tip account for each bundle to avoid any duplicate detection
            const bundleIndex = Math.floor(i / MAX_TXS_PER_BUNDLE);
            const tipAccountIndex = bundleIndex % JITO_TIP_ACCOUNTS.length;
            const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[tipAccountIndex]);
            const tipIx = SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: tipAccount,
              lamports: 1_000_000, // 0.001 SOL tip per bundle
            });
            tx.instructions.push(tipIx);
            debugLog('[DLMM] Added Jito tip to transaction', i + 1, '(last in bundle', bundleIndex + 1, ')');
          }

          tx.feePayer = wallet.publicKey;
          allTransactions.push(tx);
        }

        // Get fresh blockhash and update all transactions
        const freshBlockhashInfo = await this.connection.getLatestBlockhash('confirmed');
        const freshBlockhash = freshBlockhashInfo.blockhash;
        debugLog('[DLMM] Got fresh blockhash:', freshBlockhash.slice(0, 20) + '...');

        for (const tx of allTransactions) {
          tx.recentBlockhash = freshBlockhash;
        }

        // Partially sign with position keypairs
        for (let i = 0; i < allTransactions.length; i++) {
          allTransactions[i].partialSign(allPositionKeypairs[i]);
        }

        // Sign all transactions at once
        debugLog('[DLMM] Requesting batch signature for', allTransactions.length, 'transactions');
        if (!wallet.signAllTransactions) {
          throw new Error('Wallet does not support signAllTransactions');
        }

        const signedTxs = await wallet.signAllTransactions(allTransactions);
        debugLog('[DLMM] All', signedTxs.length, 'transactions signed');

        // Serialize transactions
        const serializedTxs = signedTxs.map(tx => bs58.encode(tx.serialize()));

        // Prepare bundle payloads
        const numBundles = Math.ceil(serializedTxs.length / MAX_TXS_PER_BUNDLE);
        const bundlePayloads: string[][] = [];
        for (let i = 0; i < numBundles; i++) {
          const start = i * MAX_TXS_PER_BUNDLE;
          const end = Math.min(start + MAX_TXS_PER_BUNDLE, serializedTxs.length);
          bundlePayloads.push(serializedTxs.slice(start, end));
        }

        // Helper function for direct RPC fallback (final fallback)
        const sendSequentialFallback = async (reason: string): Promise<{
          signature: string;
          positionAddress: string;
        }> => {
          debugLog('[DLMM-AddLiq] ⚠️', reason, '- using direct RPC...');

          const successfulSignatures: string[] = [];
          let lastError: string | null = null;

          for (let i = 0; i < signedTxs.length; i++) {
            try {
              debugLog('[DLMM-AddLiq] Sending transaction', i + 1, 'of', signedTxs.length, 'via RPC...');

              const currentTx = signedTxs[i];
              const blockheight = await this.connection.getBlockHeight('confirmed');

              const signature = await this.connection.sendRawTransaction(
                currentTx.serialize(),
                { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }
              );

              debugLog('[DLMM-AddLiq] Transaction', i + 1, 'sent, signature:', signature.slice(0, 20) + '...');

              const confirmResult = await this.connection.confirmTransaction(
                { signature, blockhash: currentTx.recentBlockhash!, lastValidBlockHeight: blockheight + 150 },
                'confirmed'
              );

              if (confirmResult.value.err) {
                debugLog('[DLMM-AddLiq] ❌ Transaction', i + 1, 'failed:', confirmResult.value.err);
                lastError = `Transaction ${i + 1} failed: ${JSON.stringify(confirmResult.value.err)}`;
              } else {
                debugLog('[DLMM-AddLiq] ✓ Transaction', i + 1, 'confirmed');
                successfulSignatures.push(signature);
              }
            } catch (txErr: any) {
              debugLog('[DLMM-AddLiq] ❌ Transaction', i + 1, 'error:', txErr.message);
              lastError = `Transaction ${i + 1} error: ${txErr.message}`;

              if (txErr.message?.includes('blockhash') || txErr.message?.includes('expired')) {
                throw new Error(`Blockhash expired. Successful: ${successfulSignatures.length}/${signedTxs.length}`);
              }
            }
          }

          if (successfulSignatures.length === 0) {
            throw new Error(`All transactions failed. ${lastError}`);
          }

          debugLog('[DLMM-AddLiq] ✓ Fallback complete:', successfulSignatures.length, '/', signedTxs.length, 'succeeded');
          return {
            signature: successfulSignatures[0],
            positionAddress: allPositionKeypairs[0].publicKey.toBase58()
          };
        };

        // Helper function to send via Jito bundles (used as fallback)
        const sendViaJitoBundles = async (): Promise<{
          signature: string;
          positionAddress: string;
        } | null> => {
          try {
            debugLog('[DLMM-AddLiq] Trying Jito bundles...');

            const bundleIds: string[] = [];

            for (let i = 0; i < bundlePayloads.length; i++) {
              const bundleTxs = bundlePayloads[i];
              debugLog('[DLMM-AddLiq] Sending bundle', i + 1, 'of', bundlePayloads.length);

              const bundleResponse = await fetch('/api/jito-bundle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transactions: bundleTxs })
              });

              const bundleResult = await bundleResponse.json();

              if (!bundleResult.success || !bundleResult.bundleId) {
                debugLog('[DLMM-AddLiq] Bundle', i + 1, 'failed:', bundleResult.error);
                return null;
              }

              bundleIds.push(bundleResult.bundleId);

              if (i < bundlePayloads.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
              }
            }

            debugLog('[DLMM-AddLiq] ✓ All', bundleIds.length, 'bundles sent');

            const lastBundleId = bundleIds[bundleIds.length - 1];
            const bundleLanded = await this.waitForBundleConfirmation(lastBundleId, 30000);

            if (!bundleLanded) {
              debugLog('[DLMM-AddLiq] Jito bundle did not land');
              return null;
            }

            debugLog('[DLMM-AddLiq] ✓ Jito bundle confirmed');
            return {
              signature: bundleIds[0],
              positionAddress: allPositionKeypairs[0].publicKey.toBase58()
            };
          } catch (jitoErr: any) {
            debugLog('[DLMM-AddLiq] Jito error:', jitoErr.message);
            return null;
          }
        };

        // PRIMARY: Try Helius sender first
        try {
          debugLog('[DLMM-AddLiq] PRIMARY: Sending', signedTxs.length, 'transactions via Helius...');

          const base64Txs = signedTxs.map(tx => tx.serialize().toString('base64'));

          const heliusResponse = await fetch('/api/helius-send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              transactions: base64Txs,
              sequential: true,
              skipPreflight: false,
              maxRetries: 3
            })
          });

          const heliusResult = await heliusResponse.json();
          debugLog('[DLMM-AddLiq] Helius response:', heliusResult);

          if (heliusResult.success && heliusResult.signatures?.length === signedTxs.length) {
            debugLog('[DLMM-AddLiq] ✓ All transactions sent via Helius');
            return {
              signature: heliusResult.signatures[0],
              positionAddress: allPositionKeypairs[0].publicKey.toBase58()
            };
          }

          if (heliusResult.signatures?.length > 0) {
            debugLog('[DLMM-AddLiq] ⚠️ Helius partial:', heliusResult.successCount, '/', signedTxs.length);
            return {
              signature: heliusResult.signatures[0],
              positionAddress: allPositionKeypairs[0].publicKey.toBase58()
            };
          }

          debugLog('[DLMM-AddLiq] Helius failed, trying Jito...', heliusResult.errors);
        } catch (heliusErr: any) {
          debugLog('[DLMM-AddLiq] Helius error:', heliusErr.message, '- trying Jito...');
        }

        // FALLBACK 1: Try Jito bundles
        const jitoResult = await sendViaJitoBundles();
        if (jitoResult) {
          return jitoResult;
        }

        // FALLBACK 2: Direct RPC
        debugLog('[DLMM-AddLiq] Both Helius and Jito failed, using direct RPC...');
        return await sendSequentialFallback('Helius and Jito unavailable');
      }

      // Single transaction path (small bin range)
      const totalXAmount = new BN(Math.floor(effectiveXAmount * Math.pow(10, tokenXDecimals)));
      const totalYAmount = new BN(Math.floor(effectiveYAmount * Math.pow(10, tokenYDecimals)));

      const positionKeypair = Keypair.generate();

      const addLiquidityTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        user: wallet.publicKey,
        totalXAmount,
        totalYAmount,
        strategy: {
          maxBinId,
          minBinId,
          strategyType: strategy,
          ...(singleSided ? { singleSidedX: true } : {})
        },
        slippage: 100 // 1% slippage
      });

      const txToSign = Array.isArray(addLiquidityTx) ? addLiquidityTx[0] : addLiquidityTx;

      // Check if SDK already added compute budget instructions
      const COMPUTE_BUDGET_ID = 'ComputeBudget111111111111111111111111111111';
      const hasComputeBudget = txToSign.instructions.some(
        (ix: any) => ix.programId?.toBase58() === COMPUTE_BUDGET_ID
      );

      if (!hasComputeBudget) {
        const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
          units: 400_000
        });
        const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 100_000
        });
        txToSign.instructions.unshift(computeBudgetIx, priorityFeeIx);
        debugLog('[DLMM-AddLiq-Single] Added compute budget instructions');
      } else {
        debugLog('[DLMM-AddLiq-Single] SDK already has compute budget, skipping');
      }

      // Check if SDK already added ATA creation instructions
      const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
      const existingAtaInstructions = txToSign.instructions.filter(
        (ix: any) => ix.programId?.toBase58() === ATA_PROGRAM_ID
      );

      if (existingAtaInstructions.length > 0) {
        debugLog('[DLMM-AddLiq-Single] SDK already added', existingAtaInstructions.length, 'ATA instructions, skipping our additions');
      } else if (addLiqCreateAtaInstructions.length > 0) {
        // Find position after compute budget instructions
        let insertIdx = 0;
        for (let i = 0; i < txToSign.instructions.length; i++) {
          if (txToSign.instructions[i].programId?.toBase58() === COMPUTE_BUDGET_ID) {
            insertIdx = i + 1;
          } else {
            break;
          }
        }
        txToSign.instructions.splice(insertIdx, 0, ...addLiqCreateAtaInstructions);
        debugLog('[DLMM-AddLiq-Single] Inserted', addLiqCreateAtaInstructions.length, 'ATA creation instructions at index', insertIdx);
      }

      // Set recentBlockhash and feePayer before signing
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      txToSign.recentBlockhash = blockhash;
      txToSign.feePayer = wallet.publicKey;

      txToSign.partialSign(positionKeypair);

      const signedTx = await wallet.signTransaction(txToSign);
      const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      });

      debugLog('[DLMM] Liquidity tx sent:', signature);
      await this.confirmTransactionPolling(signature);

      return {
        signature,
        positionAddress: positionKeypair.publicKey.toBase58()
      };
    } catch (error) {
      debugError('[DLMM] Error adding liquidity:', error);
      throw error;
    }
  }

  /**
   * Get user positions for a DLMM pool
   */
  async getUserPositions(poolAddress: string, userPubkey: PublicKey): Promise<DLMMPosition[]> {
    await this.initializeDLMM();

    try {
      const poolPubkey = new PublicKey(poolAddress);
      const dlmmPool = await this.dlmmSdk.create(this.connection, poolPubkey);

      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(userPubkey);

      return userPositions.map((pos: any) => ({
        address: pos.publicKey.toBase58(),
        poolAddress,
        binIds: pos.positionData.positionBinData.map((b: any) => b.binId),
        liquidity: pos.positionData.totalLiquidity?.toString() || '0',
        tokenXAmount: pos.positionData.totalXAmount || 0,
        tokenYAmount: pos.positionData.totalYAmount || 0
      }));
    } catch (error) {
      debugError('[DLMM] Error getting positions:', error);
      return [];
    }
  }

  /**
   * Get all user DLMM positions across all pools
   */
  async getAllUserPositions(userPubkey: PublicKey): Promise<Map<string, DLMMPosition[]>> {
    await this.initializeDLMM();

    try {
      const allPositions = await this.dlmmSdk.getAllLbPairPositionsByUser(
        this.connection,
        userPubkey
      );

      const result = new Map<string, DLMMPosition[]>();

      allPositions.forEach((positions: any, poolAddress: string) => {
        result.set(poolAddress, positions.lbPairPositionsData.map((pos: any) => ({
          address: pos.publicKey.toBase58(),
          poolAddress,
          binIds: pos.positionData.positionBinData.map((b: any) => b.binId),
          liquidity: pos.positionData.totalLiquidity?.toString() || '0',
          tokenXAmount: pos.positionData.totalXAmount || 0,
          tokenYAmount: pos.positionData.totalYAmount || 0
        })));
      });

      return result;
    } catch (error) {
      debugError('[DLMM] Error getting all positions:', error);
      return new Map();
    }
  }

  /**
   * Remove liquidity from a DLMM position
   * Uses Dialect API (same as Meteora UI) for single-tx experience, falls back to SDK
   */
  async removeLiquidity(
    poolAddress: string,
    positionAddress: string,
    percentageToRemove: number, // 0-100
    wallet: {
      publicKey: PublicKey;
      signTransaction: (tx: Transaction) => Promise<Transaction>;
      signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
    },
    onProgress?: (current: number, total: number, status: string) => void
  ): Promise<string> {
    // SDK-based removal with Jito bundle for multi-TX positions
    debugLog('[DLMM] Starting SDK-based removal...');
    await this.initializeDLMM();

    try {
      const poolPubkey = new PublicKey(poolAddress);
      const positionPubkey = new PublicKey(positionAddress);

      const dlmmPool = await this.dlmmSdk.create(this.connection, poolPubkey);

      // Get position info
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
      debugLog('[DLMM] Found', userPositions.length, 'positions for user');

      const position = userPositions.find((p: any) => p.publicKey.equals(positionPubkey));

      if (!position) {
        debugLog('[DLMM] Position not found. Available positions:', userPositions.map((p: any) => p.publicKey.toString()));
        throw new Error('Position not found');
      }

      debugLog('[DLMM] Position found:', position.publicKey.toString());
      debugLog('[DLMM] Position data keys:', Object.keys(position.positionData || {}));
      debugLog('[DLMM] Position bin data:', position.positionData?.positionBinData);

      // Handle different position data structures from the SDK
      let binIds: number[];
      if (position.positionData?.positionBinData && position.positionData.positionBinData.length > 0) {
        binIds = position.positionData.positionBinData.map((b: any) => b.binId);
      } else if (position.positionBinData && position.positionBinData.length > 0) {
        binIds = position.positionBinData.map((b: any) => b.binId);
      } else {
        // Try to get bin IDs from the position's lowerBinId and upperBinId
        debugLog('[DLMM] No positionBinData, checking for lowerBinId/upperBinId');
        debugLog('[DLMM] Full position object:', JSON.stringify(position, (key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        , 2));

        const lowerBinId = position.positionData?.lowerBinId || position.lowerBinId;
        const upperBinId = position.positionData?.upperBinId || position.upperBinId;

        if (lowerBinId !== undefined && upperBinId !== undefined) {
          // Generate bin IDs from lower to upper
          binIds = [];
          for (let i = lowerBinId; i <= upperBinId; i++) {
            binIds.push(i);
          }
          debugLog('[DLMM] Generated binIds from range:', lowerBinId, 'to', upperBinId);
        } else {
          throw new Error('Cannot determine bin IDs for position');
        }
      }

      // Get the bin range from position data
      const lowerBinId = position.positionData?.lowerBinId ?? binIds[0];
      const upperBinId = position.positionData?.upperBinId ?? binIds[binIds.length - 1];

      debugLog('[DLMM] Position bin range:', lowerBinId, 'to', upperBinId, '(', binIds.length, 'bins)');

      // Calculate BPS to remove (10000 = 100%)
      const bpsToRemove = new BN(Math.floor(percentageToRemove * 100));
      debugLog('[DLMM] BPS to remove:', bpsToRemove.toString(), '(', percentageToRemove, '%)');

      // Try the range-based API first (fromBinId/toBinId/bps) - this handles large ranges in one tx
      debugLog('[DLMM] Attempting range-based removeLiquidity API...');

      let removeTx: any;
      try {
        // New API: uses fromBinId, toBinId, bps (single BN value, not array)
        removeTx = await dlmmPool.removeLiquidity({
          position: positionPubkey,
          user: wallet.publicKey,
          fromBinId: lowerBinId,
          toBinId: upperBinId,
          bps: bpsToRemove,
          shouldClaimAndClose: percentageToRemove === 100
        });
        debugLog('[DLMM] Range-based API returned:', removeTx ? 'object' : 'null');
      } catch (rangeErr: any) {
        debugLog('[DLMM] Range-based API failed:', rangeErr.message);

        // Fallback to array-based API with binIds
        debugLog('[DLMM] Trying array-based API...');
        removeTx = await dlmmPool.removeLiquidity({
          position: positionPubkey,
          user: wallet.publicKey,
          binIds: binIds,
          liquiditiesBpsToRemove: new Array(binIds.length).fill(bpsToRemove),
          shouldClaimAndClose: percentageToRemove === 100
        });
        debugLog('[DLMM] Array-based API returned:', removeTx ? 'object' : 'null');
      }

      debugLog('[DLMM] removeTx type:', typeof removeTx);
      debugLog('[DLMM] removeTx isArray:', Array.isArray(removeTx));
      if (removeTx && typeof removeTx === 'object') {
        debugLog('[DLMM] removeTx keys:', Object.keys(removeTx));
      }

      if (!removeTx || (Array.isArray(removeTx) && removeTx.length === 0)) {
        throw new Error('removeLiquidity returned no transactions');
      }

      // Handle different return types from the SDK
      let transactions: Transaction[] = [];

      if (Array.isArray(removeTx)) {
        transactions = removeTx;
        debugLog('[DLMM] Got array of', transactions.length, 'transactions');
      } else if (removeTx.transaction) {
        transactions = [removeTx.transaction];
      } else if (removeTx.instructions) {
        transactions = [removeTx];
      } else {
        debugLog('[DLMM] Using removeTx as-is');
        transactions = [removeTx];
      }

      const totalTxs = transactions.length;

      debugLog('[DLMM] Processing', totalTxs, 'transactions for', binIds.length, 'bins');

      // ComputeBudget program ID for checking if instructions already exist
      const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';

      // Get a single blockhash for ALL transactions (required for Jito bundles)
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      debugLog('[DLMM] Got blockhash for bundle:', blockhash.slice(0, 20) + '...');

      // If multiple transactions, use Jito bundle for atomic execution
      if (totalTxs > 1) {
        debugLog('[DLMM] Using Jito bundle for', totalTxs, 'transactions');
        onProgress?.(0, totalTxs, `Preparing ${totalTxs} transactions for bundle...`);

        // Prepare all transactions with same blockhash
        const preparedTxs: Transaction[] = [];
        for (let i = 0; i < transactions.length; i++) {
          const tx = transactions[i];
          debugLog('[DLMM] Preparing transaction', i + 1, 'of', totalTxs);

          if (tx.instructions && Array.isArray(tx.instructions)) {
            tx.recentBlockhash = blockhash;
            tx.feePayer = wallet.publicKey;

            // Check if compute budget instructions already exist
            const hasComputeBudget = tx.instructions.some((ix: any) =>
              ix.programId?.toBase58() === COMPUTE_BUDGET_PROGRAM_ID
            );

            if (!hasComputeBudget) {
              const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
                units: 1_400_000
              });
              const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: 100_000 // Lower for bundle since we pay tip
              });
              tx.instructions.unshift(computeBudgetIx, priorityFeeIx);
            }

            // Add Jito tip to the LAST transaction only
            if (i === transactions.length - 1) {
              const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
              const tipIx = SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: tipAccount,
                lamports: 1_000_000, // 0.001 SOL tip (competitive for Jito auction)
              });
              tx.instructions.push(tipIx);
              debugLog('[DLMM] Added Jito tip (0.001 SOL) to last transaction');
            }

            preparedTxs.push(tx);
          } else {
            debugLog('[DLMM] VersionedTransaction detected at index', i);
            preparedTxs.push(tx);
          }
        }

        // Sign ALL transactions at once (single Phantom popup)
        onProgress?.(0, totalTxs, `Please approve all ${totalTxs} transactions...`);
        debugLog('[DLMM] Requesting batch signature for', preparedTxs.length, 'transactions');

        let signedTxs: Transaction[];
        if (wallet.signAllTransactions) {
          // Use signAllTransactions for single-click approval
          debugLog('[DLMM] Using signAllTransactions (single popup)');
          signedTxs = await wallet.signAllTransactions(preparedTxs);
          debugLog('[DLMM] All', signedTxs.length, 'transactions signed in one click');
        } else {
          // Fallback to individual signing
          debugLog('[DLMM] signAllTransactions not available, signing individually');
          signedTxs = [];
          for (let i = 0; i < preparedTxs.length; i++) {
            onProgress?.(i + 1, totalTxs, `Signing transaction ${i + 1} of ${totalTxs}...`);
            const signedTx = await wallet.signTransaction(preparedTxs[i]);
            signedTxs.push(signedTx);
          }
        }

        // Serialize all transactions for bundle
        const serializedTxs = signedTxs.map(tx =>
          Buffer.from(tx.serialize()).toString('base64')
        );
        debugLog('[DLMM] Serialized', serializedTxs.length, 'transactions for bundle');

        // Send bundle via Jito
        onProgress?.(totalTxs, totalTxs, `Sending bundle to Jito...`);
        try {
          const bundleResponse = await fetch('/api/jito-bundle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transactions: serializedTxs })
          });

          const bundleResult = await bundleResponse.json();
          debugLog('[DLMM] Jito bundle response:', bundleResult);

          if (bundleResult.success && bundleResult.bundleId) {
            debugLog('[DLMM] ✓ Bundle sent successfully, ID:', bundleResult.bundleId);
            onProgress?.(totalTxs, totalTxs, `Bundle sent! Waiting for confirmation...`);

            // Poll for bundle confirmation
            const bundleLanded = await this.waitForBundleConfirmation(bundleResult.bundleId, 30000);

            if (!bundleLanded) {
              debugLog('[DLMM] ⚠️ Bundle did not land via Jito, falling back to sequential RPC submission...');
              onProgress?.(totalTxs, totalTxs, `Bundle didn't land, sending directly...`);

              // Fallback: Send transactions sequentially via normal RPC
              const successfulSignatures: string[] = [];
              let lastError: string | null = null;

              for (let i = 0; i < signedTxs.length; i++) {
                try {
                  debugLog('[DLMM] Sending transaction', i + 1, 'of', signedTxs.length, 'via RPC...');
                  onProgress?.(i + 1, totalTxs, `Sending TX ${i + 1}/${signedTxs.length} via RPC...`);

                  const currentTx = signedTxs[i];
                  const blockheight = await this.connection.getBlockHeight('confirmed');

                  const signature = await this.connection.sendRawTransaction(
                    currentTx.serialize(),
                    {
                      skipPreflight: false,
                      preflightCommitment: 'confirmed',
                      maxRetries: 3,
                    }
                  );

                  debugLog('[DLMM] Transaction', i + 1, 'sent, signature:', signature.slice(0, 20) + '...');

                  const confirmResult = await this.connection.confirmTransaction(
                    {
                      signature,
                      blockhash: currentTx.recentBlockhash!,
                      lastValidBlockHeight: blockheight + 150,
                    },
                    'confirmed'
                  );

                  if (confirmResult.value.err) {
                    debugLog('[DLMM] ❌ Transaction', i + 1, 'failed:', confirmResult.value.err);
                    lastError = `Transaction ${i + 1} failed: ${JSON.stringify(confirmResult.value.err)}`;
                  } else {
                    debugLog('[DLMM] ✓ Transaction', i + 1, 'confirmed');
                    successfulSignatures.push(signature);
                  }
                } catch (txErr: any) {
                  debugLog('[DLMM] ❌ Transaction', i + 1, 'error:', txErr.message);
                  lastError = `Transaction ${i + 1} error: ${txErr.message}`;

                  if (txErr.message?.includes('blockhash') || txErr.message?.includes('expired')) {
                    debugLog('[DLMM] Blockhash expired, cannot continue');
                    throw new Error(`Blockhash expired. Successful: ${successfulSignatures.length}/${signedTxs.length}`);
                  }
                }
              }

              if (successfulSignatures.length === 0) {
                throw new Error(`All transactions failed via fallback. ${lastError}`);
              }

              debugLog('[DLMM] ✓ Fallback complete:', successfulSignatures.length, '/', signedTxs.length, 'succeeded');
              return successfulSignatures[0];
            } else {
              debugLog('[DLMM] ✓ Bundle confirmed on-chain');
              onProgress?.(totalTxs, totalTxs, `Bundle confirmed!`);
            }

            return bundleResult.bundleId;
          } else {
            debugLog('[DLMM] Jito bundle failed:', bundleResult.error);
            throw new Error(bundleResult.error || 'Bundle submission failed');
          }
        } catch (bundleErr: any) {
          debugLog('[DLMM] Jito bundle error:', bundleErr.message);
          debugLog('[DLMM] Falling back to sequential submission...');
          // Fall through to sequential submission below
        }
      }

      // Sequential submission (for single TX or if bundle fails)
      const signatures: string[] = [];
      onProgress?.(0, totalTxs, totalTxs > 1 ? 'Bundle failed, sending sequentially...' : 'Sending transaction...');

      for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        debugLog('[DLMM] Processing transaction', i + 1, 'of', totalTxs);
        onProgress?.(i + 1, totalTxs, `Signing transaction ${i + 1} of ${totalTxs}...`);

        // Get fresh blockhash for sequential submission
        const freshBlockhash = (await this.connection.getLatestBlockhash('confirmed')).blockhash;

        if (tx.instructions && Array.isArray(tx.instructions)) {
          tx.recentBlockhash = freshBlockhash;
          tx.feePayer = wallet.publicKey;

          const hasComputeBudget = tx.instructions.some((ix: any) =>
            ix.programId?.toBase58() === COMPUTE_BUDGET_PROGRAM_ID
          );

          if (!hasComputeBudget) {
            const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
              units: 1_400_000
            });
            const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
              microLamports: 500_000
            });
            tx.instructions.unshift(computeBudgetIx, priorityFeeIx);
          }
        }

        const signedTx = await wallet.signTransaction(tx);
        debugLog('[DLMM] Transaction signed');

        // SIMULATE FIRST to catch errors before sending
        onProgress?.(i + 1, totalTxs, `Simulating transaction ${i + 1} of ${totalTxs}...`);
        try {
          debugLog('[DLMM] Simulating transaction before sending...');
          const simulationResult = await this.connection.simulateTransaction(signedTx as any, {
            commitment: 'confirmed',
            sigVerify: false
          });

          if (simulationResult.value.err) {
            debugLog('[DLMM] ❌ SIMULATION FAILED:', JSON.stringify(simulationResult.value.err));
            debugLog('[DLMM] Simulation logs:', simulationResult.value.logs?.join('\n'));
            throw new Error(`Transaction simulation failed: ${JSON.stringify(simulationResult.value.err)}\nLogs: ${simulationResult.value.logs?.slice(-5).join('\n')}`);
          }
          debugLog('[DLMM] ✓ Simulation passed, units used:', simulationResult.value.unitsConsumed);
          debugLog('[DLMM] Simulation logs (last 3):', simulationResult.value.logs?.slice(-3).join('\n'));
        } catch (simErr: any) {
          debugLog('[DLMM] Simulation error:', simErr.message);
          // Don't throw - try to send anyway in case simulation is broken
          debugLog('[DLMM] Continuing despite simulation error...');
        }

        onProgress?.(i + 1, totalTxs, `Sending transaction ${i + 1} of ${totalTxs}...`);

        // Try sending via Laserstream first for faster submission
        let signature: string;
        try {
          const serializedTx = Buffer.from(signedTx.serialize()).toString('base64');
          debugLog('[DLMM] Sending via Laserstream, serialized length:', serializedTx.length);

          const laserstreamResponse = await fetch('/api/laserstream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'sendTransaction',
              params: [serializedTx, {
                skipPreflight: false, // Enable preflight to catch errors
                preflightCommitment: 'confirmed',
                maxRetries: 5,
                encoding: 'base64'
              }]
            })
          });

          const responseText = await laserstreamResponse.text();
          debugLog('[DLMM] Laserstream response status:', laserstreamResponse.status);
          debugLog('[DLMM] Laserstream response:', responseText.slice(0, 500));

          if (laserstreamResponse.ok) {
            const result = JSON.parse(responseText);
            if (result.result) {
              signature = result.result;
              debugLog('[DLMM] ✓ Transaction sent via Laserstream:', signature);
            } else if (result.error) {
              debugLog('[DLMM] ❌ Laserstream RPC error:', JSON.stringify(result.error));
              throw new Error(result.error.message || JSON.stringify(result.error));
            } else {
              throw new Error('No result from Laserstream');
            }
          } else {
            debugLog('[DLMM] ❌ Laserstream HTTP error:', laserstreamResponse.status, responseText);
            throw new Error(`Laserstream HTTP ${laserstreamResponse.status}: ${responseText}`);
          }
        } catch (laserstreamErr: any) {
          debugLog('[DLMM] Laserstream send failed:', laserstreamErr.message);
          // Fallback to regular RPC with preflight enabled
          debugLog('[DLMM] Trying fallback RPC with preflight...');
          try {
            signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
              skipPreflight: false, // Enable preflight to see errors
              preflightCommitment: 'confirmed',
              maxRetries: 5
            });
            debugLog('[DLMM] ✓ Transaction sent via fallback RPC:', signature);
          } catch (rpcErr: any) {
            debugLog('[DLMM] ❌ Fallback RPC also failed:', rpcErr.message);
            // Try one more time with skipPreflight in case preflight is the issue
            debugLog('[DLMM] Last attempt with skipPreflight...');
            signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
              skipPreflight: true,
              preflightCommitment: 'confirmed',
              maxRetries: 5
            });
            debugLog('[DLMM] Transaction sent (skipPreflight):', signature);
          }
        }

        debugLog('[DLMM] Transaction sent:', signature);
        signatures.push(signature);

        // Wait for confirmation using Laserstream (faster than default RPC)
        onProgress?.(i + 1, totalTxs, `Confirming transaction ${i + 1} of ${totalTxs}...`);
        try {
          // Poll for confirmation using Laserstream proxy for speed
          let confirmed = false;
          const maxAttempts = 30; // 30 seconds max
          for (let attempt = 0; attempt < maxAttempts && !confirmed; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
            try {
              // Try Laserstream first for faster confirmation
              const laserstreamResponse = await fetch('/api/laserstream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 1,
                  method: 'getSignatureStatuses',
                  params: [[signature], { searchTransactionHistory: true }]
                })
              });

              if (laserstreamResponse.ok) {
                const result = await laserstreamResponse.json();
                const status = result?.result?.value?.[0];
                if (status?.confirmationStatus === 'confirmed' ||
                    status?.confirmationStatus === 'finalized') {
                  confirmed = true;
                  debugLog('[DLMM] Transaction confirmed via Laserstream');
                } else if (status?.err) {
                  debugLog('[DLMM] Transaction failed:', status.err);
                  throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
                }
              } else {
                // Fallback to regular connection
                const status = await this.connection.getSignatureStatus(signature);
                if (status?.value?.confirmationStatus === 'confirmed' ||
                    status?.value?.confirmationStatus === 'finalized') {
                  confirmed = true;
                  debugLog('[DLMM] Transaction confirmed via fallback RPC');
                } else if (status?.value?.err) {
                  throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
                }
              }
            } catch (pollErr: any) {
              // Ignore polling errors, keep trying
              if (attempt === maxAttempts - 1) {
                debugLog('[DLMM] Polling timeout, continuing anyway');
              }
            }
          }
          if (confirmed) {
            onProgress?.(i + 1, totalTxs, `Transaction ${i + 1} of ${totalTxs} confirmed ✓`);
          } else {
            onProgress?.(i + 1, totalTxs, `Transaction ${i + 1} sent, continuing...`);
          }
        } catch (confirmErr: any) {
          debugLog('[DLMM] Confirmation issue:', confirmErr.message);
          // Re-throw if it's an actual transaction error
          if (confirmErr.message.includes('Transaction failed')) {
            throw confirmErr;
          }
          // Continue anyway for timeout issues - tx may still land
        }
      }

      if (signatures.length === 0) {
        throw new Error('No transactions were signed and sent');
      }

      debugLog('[DLMM] Complete. Total signatures:', signatures.length);
      return signatures[0];
    } catch (error) {
      debugError('[DLMM] Error removing liquidity:', error);
      throw error;
    }
  }

  /**
   * Get pending fees from DLMM positions for a user
   */
  async getPendingFees(
    poolAddress: string,
    userPubkey: PublicKey
  ): Promise<{ tokenX: number; tokenY: number; hasClaimable: boolean }> {
    await this.initializeDLMM();

    try {
      const poolPubkey = new PublicKey(poolAddress);
      const dlmmPool = await this.dlmmSdk.create(this.connection, poolPubkey);

      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(userPubkey);

      if (userPositions.length === 0) {
        return { tokenX: 0, tokenY: 0, hasClaimable: false };
      }

      // Sum up fees from all positions
      let totalFeeX = 0;
      let totalFeeY = 0;

      // Get token decimals from the pool
      const tokenXDecimals = dlmmPool.tokenX?.decimal || 6;
      const tokenYDecimals = dlmmPool.tokenY?.decimal || 9;

      for (const position of userPositions) {
        // positionData contains feeX and feeY in raw lamport amounts
        const posData = position.positionData;

        // Try different ways the SDK might expose fee data
        const feeX = posData?.feeX || posData?.totalFeeXPending || 0;
        const feeY = posData?.feeY || posData?.totalFeeYPending || 0;

        // Convert BN/bigint to number
        const feeXNum = typeof feeX === 'object' && feeX.toNumber ? feeX.toNumber() : Number(feeX);
        const feeYNum = typeof feeY === 'object' && feeY.toNumber ? feeY.toNumber() : Number(feeY);

        totalFeeX += feeXNum;
        totalFeeY += feeYNum;
      }

      // Convert from raw lamports to UI amounts
      const tokenXAmount = totalFeeX / Math.pow(10, tokenXDecimals);
      const tokenYAmount = totalFeeY / Math.pow(10, tokenYDecimals);

      debugLog('[DLMM] Pending fees:', {
        tokenX: tokenXAmount,
        tokenY: tokenYAmount,
        rawX: totalFeeX,
        rawY: totalFeeY,
        positions: userPositions.length
      });

      return {
        tokenX: tokenXAmount,
        tokenY: tokenYAmount,
        hasClaimable: totalFeeX > 0 || totalFeeY > 0
      };
    } catch (error) {
      debugError('[DLMM] Error getting pending fees:', error);
      return { tokenX: 0, tokenY: 0, hasClaimable: false };
    }
  }

  /**
   * Claim fees from a DLMM position
   */
  async claimFees(
    poolAddress: string,
    wallet: {
      publicKey: PublicKey;
      signTransaction: (tx: Transaction) => Promise<Transaction>;
    }
  ): Promise<string[]> {
    await this.initializeDLMM();

    try {
      const poolPubkey = new PublicKey(poolAddress);
      const dlmmPool = await this.dlmmSdk.create(this.connection, poolPubkey);

      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);

      if (userPositions.length === 0) {
        throw new Error('No positions found');
      }

      const claimTxs = await dlmmPool.claimAllSwapFee({
        owner: wallet.publicKey,
        positions: userPositions
      });

      // claimAllSwapFee may return empty array or array with null transactions if no fees
      if (!claimTxs || claimTxs.length === 0) {
        debugLog('[DLMM] No fees to claim (empty transactions array)');
        return [];
      }

      // Filter out null/undefined transactions
      const validTxs = claimTxs.filter((tx: any) => tx != null);
      if (validTxs.length === 0) {
        debugLog('[DLMM] No fees to claim (all transactions were null)');
        return [];
      }

      const signatures: string[] = [];

      for (const claimTx of validTxs) {
        // Set recentBlockhash and feePayer before signing
        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
        claimTx.recentBlockhash = blockhash;
        claimTx.feePayer = wallet.publicKey;

        const signedTx = await wallet.signTransaction(claimTx);
        const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed'
        });
        await this.confirmTransactionPolling(signature);
        signatures.push(signature);
      }

      return signatures;
    } catch (error) {
      debugError('[DLMM] Error claiming fees:', error);
      throw error;
    }
  }

  /**
   * Get pool info from address
   */
  async getPoolInfo(poolAddress: string): Promise<DLMMPoolInfo | null> {
    await this.initializeDLMM();

    try {
      const poolPubkey = new PublicKey(poolAddress);
      const dlmmPool = await this.dlmmSdk.create(this.connection, poolPubkey);

      const activeBin = await dlmmPool.getActiveBin();

      // Get fee info with null safety - SDK structure may vary
      let feeBps = 0;
      try {
        const feeInfo = dlmmPool.getFeeInfo?.();
        if (feeInfo?.baseFeeRate) {
          feeBps = parseFloat(feeInfo.baseFeeRate.toString()) / 100;
        } else if (dlmmPool.lbPair?.baseFactor) {
          // Fallback: calculate from baseFactor if available
          feeBps = dlmmPool.lbPair.baseFactor / 100;
        }
      } catch {
        // Fee info not available, use 0
      }

      // Safely extract reserve amounts - could be BN, bigint, or number
      const getAmount = (val: any): number => {
        if (!val) return 0;
        if (typeof val === 'number') return val;
        if (typeof val === 'bigint') return Number(val);
        if (typeof val.toNumber === 'function') return val.toNumber();
        if (typeof val.toString === 'function') return parseFloat(val.toString()) || 0;
        return 0;
      };

      return {
        address: poolAddress,
        tokenXMint: dlmmPool.tokenX?.publicKey?.toBase58() || '',
        tokenYMint: dlmmPool.tokenY?.publicKey?.toBase58() || '',
        binStep: dlmmPool.lbPair?.binStep || 0,
        activeBin: activeBin?.binId || 0,
        currentPrice: activeBin?.price ? parseFloat(dlmmPool.fromPricePerLamport(activeBin.price)) : 0,
        feeBps,
        reserveX: getAmount(dlmmPool.tokenX?.amount),
        reserveY: getAmount(dlmmPool.tokenY?.amount)
      };
    } catch (error) {
      debugError('[DLMM] Error getting pool info:', error);
      return null;
    }
  }
}

// Create singleton instance
let dlmmServiceInstance: DLMMLiquidityService | null = null;

export function getDLMMService(connection: Connection): DLMMLiquidityService {
  if (!dlmmServiceInstance) {
    dlmmServiceInstance = new DLMMLiquidityService(connection);
  } else {
    // Always update connection to ensure we use the provided one
    // This fixes issues where the singleton was created with a different connection type
    dlmmServiceInstance.updateConnection(connection);
  }
  return dlmmServiceInstance;
}

export const dlmmLiquidityService = {
  async createPoolAndAddLiquidity(params: DLMMAddLiquidityParams, onProgress?: (step: number, message: string) => void) {
    const service = getDLMMService(params.connection);
    return service.createPoolAndAddLiquidity(params, onProgress);
  },

  async getPoolCreationInstructions(params: {
    connection: Connection;
    tokenXMint: string;
    tokenYMint: string;
    binStep: number;
    feeBps: number;
    initialPrice: number;
    walletPubkey: PublicKey;
  }) {
    const service = getDLMMService(params.connection);
    return service.getPoolCreationInstructions({
      tokenXMint: params.tokenXMint,
      tokenYMint: params.tokenYMint,
      binStep: params.binStep,
      feeBps: params.feeBps,
      initialPrice: params.initialPrice,
      walletPubkey: params.walletPubkey,
    });
  },

  async addLiquidity(params: DLMMAddLiquidityParams) {
    const service = getDLMMService(params.connection);
    return service.addLiquidity(params);
  },

  async findPool(connection: Connection, tokenXMint: string, tokenYMint: string, binStep?: number) {
    const service = getDLMMService(connection);
    return service.findPool(tokenXMint, tokenYMint, binStep);
  },

  async getPoolInfo(connection: Connection, poolAddress: string) {
    const service = getDLMMService(connection);
    return service.getPoolInfo(poolAddress);
  },

  async getUserPositions(connection: Connection, poolAddress: string, userPubkey: PublicKey) {
    const service = getDLMMService(connection);
    return service.getUserPositions(poolAddress, userPubkey);
  },

  async getAllUserPositions(connection: Connection, userPubkey: PublicKey) {
    const service = getDLMMService(connection);
    return service.getAllUserPositions(userPubkey);
  },

  async removeLiquidity(
    connection: Connection,
    poolAddress: string,
    positionAddress: string,
    percentageToRemove: number,
    wallet: any,
    onProgress?: (current: number, total: number, status: string) => void
  ) {
    const service = getDLMMService(connection);
    return service.removeLiquidity(poolAddress, positionAddress, percentageToRemove, wallet, onProgress);
  },

  async claimFees(connection: Connection, poolAddress: string, wallet: any) {
    const service = getDLMMService(connection);
    return service.claimFees(poolAddress, wallet);
  },

  async getPendingFees(connection: Connection, poolAddress: string, userPubkey: PublicKey) {
    const service = getDLMMService(connection);
    return service.getPendingFees(poolAddress, userPubkey);
  }
};
