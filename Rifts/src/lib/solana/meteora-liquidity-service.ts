/**
 * Meteora Liquidity Management Service
 * Based on working add-liquidity-full.js and remove-liquidity-WORKING.js scripts
 */

import { Connection, PublicKey, Keypair, Transaction, SystemProgram, ComputeBudgetProgram, Signer } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction
} from '@solana/spl-token';
import BN from 'bn.js';
import { debugLog, debugError } from '@/utils/debug';

// Meteora CP-AMM SDK types (minimal interface)
interface CpAmm {
  getUserPositionByPool(poolAddress: PublicKey, user: PublicKey): Promise<any[]>;
  getPositionsByUser(user: PublicKey): Promise<Array<{ positionNftAccount: PublicKey; position: PublicKey; positionState: any }>>;
  fetchPoolState(poolAddress: PublicKey): Promise<any>;
  fetchPositionState(positionAddress: PublicKey): Promise<any>;
  getAllVestingsByPosition(positionAddress: PublicKey): Promise<any[]>;
  getDepositQuote(params: any): any; // Returns DepositQuote synchronously
  createPosition(params: any): Promise<Transaction>;
  addLiquidity(params: any): Promise<Transaction>;
  createPositionAndAddLiquidity(params: any): Promise<Transaction>;
  removeLiquidity(params: any): Promise<Transaction>;
  removeAllLiquidity(params: any): Promise<Transaction>;
  claimPositionFee(params: any): Promise<Transaction>; // TxBuilder = Promise<Transaction>
}

const METEORA_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');

/**
 * Detect which token program a mint uses by checking the account owner
 * This works for both SPL Token and Token-2022 mints
 */
async function detectTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  try {
    const accountInfo = await connection.getAccountInfo(mint);
    if (!accountInfo) {
      debugLog(`⚠️ Could not find mint account ${mint.toBase58().slice(0, 8)}..., defaulting to TOKEN_2022`);
      return TOKEN_2022_PROGRAM_ID;
    }

    // The owner of the mint account is the token program
    const owner = accountInfo.owner;

    if (owner.equals(TOKEN_PROGRAM_ID)) {
      debugLog(`🔧 Mint ${mint.toBase58().slice(0, 8)}... uses SPL Token`);
      return TOKEN_PROGRAM_ID;
    } else if (owner.equals(TOKEN_2022_PROGRAM_ID)) {
      debugLog(`🔧 Mint ${mint.toBase58().slice(0, 8)}... uses Token-2022`);
      return TOKEN_2022_PROGRAM_ID;
    } else {
      debugLog(`⚠️ Unknown token program for ${mint.toBase58().slice(0, 8)}...: ${owner.toBase58()}, defaulting to TOKEN_2022`);
      return TOKEN_2022_PROGRAM_ID;
    }
  } catch (error) {
    debugError(`Failed to detect token program for ${mint.toBase58()}:`, error);
    return TOKEN_2022_PROGRAM_ID;
  }
}

/**
 * Helper to fetch pool state with retry logic
 * Handles the case where a pool was just created and hasn't been indexed yet
 */
async function fetchPoolStateWithRetry(
  cpAmm: CpAmm,
  poolPubkey: PublicKey,
  maxRetries: number = 5,
  initialDelayMs: number = 1000
): Promise<any> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const poolState = await cpAmm.fetchPoolState(poolPubkey);
      if (poolState) {
        if (attempt > 0) {
          debugLog(`✅ Pool state fetched successfully on attempt ${attempt + 1}`);
        }
        return poolState;
      }
    } catch (error: any) {
      lastError = error;
      const errorMessage = error?.message || String(error);

      // Invalid account discriminator means the account exists but is not a valid pool - don't retry
      if (errorMessage.includes('Invalid account discriminator')) {
        throw error;
      }

      // Check if this is a "not found" error that might resolve with time
      const isNotFoundError =
        errorMessage.includes('not found') ||
        errorMessage.includes('Pool account') ||
        errorMessage.includes('Invariant Violation');

      if (isNotFoundError && attempt < maxRetries - 1) {
        const delayMs = initialDelayMs * Math.pow(2, attempt); // Exponential backoff
        debugLog(`⏳ Pool not found yet, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      // For non-retryable errors, throw immediately
      throw error;
    }
  }

  // All retries exhausted
  throw lastError || new Error(`Failed to fetch pool state after ${maxRetries} attempts`);
}

export interface AddLiquidityParams {
  poolAddress: string;
  wsolAmount: number; // in SOL (or underlying token amount if useUnderlyingToken is true)
  riftAmount: number; // in tokens
  useUnderlyingToken?: boolean; // If true, wsolAmount represents underlying token amount instead of SOL
  underlyingMint?: string; // Required when useUnderlyingToken is true - the mint address of the underlying token
  wallet: {
    publicKey: PublicKey;
    signTransaction: (tx: Transaction) => Promise<Transaction>;
    sendTransaction?: (tx: Transaction, connection: Connection) => Promise<string>;
  };
  connection: Connection;
}

export interface RemoveLiquidityParams {
  poolAddress: string;
  wallet: {
    publicKey: PublicKey;
    signTransaction: (tx: Transaction) => Promise<Transaction>;
    sendTransaction?: (tx: Transaction, connection: Connection) => Promise<string>;
  };
  connection: Connection;
}

export interface LiquidityPosition {
  address: string;
  nftMint: string;
  nftAccount: string;
  unlockedLiquidity: string;
  poolAddress: string;
}

export interface DepositQuoteResult {
  wsolNeeded: number; // in SOL
  riftNeeded: number; // in tokens
  liquidityDelta: string;
  poolRatio: number; // RIFT per SOL
}

export class MeteoraLiquidityService {
  private connection: Connection;
  private cpAmm: CpAmm | null = null;
  private poolStateCache: Map<string, any> = new Map();
  private poolDecimalsCache: Map<string, { tokenADecimals: number; tokenBDecimals: number }> = new Map();
  private vaultBalanceCache: Map<string, { vaultABalance: number; vaultBBalance: number }> = new Map();

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Confirm transaction using polling (no WebSocket required)
   * This avoids CSP/proxy issues with WebSocket connections
   */
  private async confirmTransactionPolling(signature: string, maxRetries = 30): Promise<void> {
    debugLog('[METEORA] Confirming tx via polling:', signature.slice(0, 20) + '...');

    for (let i = 0; i < maxRetries; i++) {
      try {
        const status = await this.connection.getSignatureStatus(signature);

        if (status?.value?.confirmationStatus === 'confirmed' ||
            status?.value?.confirmationStatus === 'finalized') {
          debugLog('[METEORA] Transaction confirmed:', status.value.confirmationStatus);
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
   * Prefetch pool state/decimals/vault balances to speed up modal open & quote fetches.
   */
  async prefetchPoolSnapshot(poolAddress: string): Promise<void> {
    try {
      await this.initializeCpAmm();
      if (!this.cpAmm) return;

      const poolPubkey = new PublicKey(poolAddress);

      // Check if pool account exists first to avoid "Invalid account discriminator" errors
      const poolAccountInfo = await this.connection.getAccountInfo(poolPubkey);
      debugLog(`[PREFETCH] Pool ${poolAddress.slice(0, 8)}... account info:`, {
        exists: !!poolAccountInfo,
        owner: poolAccountInfo?.owner.toBase58(),
        dataLength: poolAccountInfo?.data.length
      });

      if (!poolAccountInfo) {
        debugLog('[PREFETCH] Pool account does not exist, skipping prefetch');
        return;
      }

      // Try to fetch pool state, catch invalid discriminator errors
      let poolState;
      try {
        poolState = await this.cpAmm.fetchPoolState(poolPubkey);
        debugLog(`[PREFETCH] Successfully fetched pool state for ${poolAddress.slice(0, 8)}...`);
      } catch (error: any) {
        if (error?.message?.includes('Invalid account discriminator')) {
          debugLog(`[PREFETCH] Pool ${poolAddress.slice(0, 8)}... has invalid discriminator, skipping (not a CP-AMM pool)`);
          return;
        }
        throw error;
      }

      this.poolStateCache.set(poolAddress, poolState);

      const { getMintDecimals } = await import('@/lib/supabase/client');
      let tokenADecimals = await getMintDecimals(poolState.tokenAMint.toBase58());
      let tokenBDecimals = await getMintDecimals(poolState.tokenBMint.toBase58());

      if (tokenADecimals === null || tokenBDecimals === null) {
        const { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
        if (tokenADecimals === null) {
          try {
            const mintA = await getMint(this.connection, poolState.tokenAMint, 'processed', TOKEN_2022_PROGRAM_ID);
            tokenADecimals = mintA.decimals;
          } catch {
            const mintA = await getMint(this.connection, poolState.tokenAMint, 'processed', TOKEN_PROGRAM_ID);
            tokenADecimals = mintA.decimals;
          }
        }
        if (tokenBDecimals === null) {
          try {
            const mintB = await getMint(this.connection, poolState.tokenBMint, 'processed', TOKEN_2022_PROGRAM_ID);
            tokenBDecimals = mintB.decimals;
          } catch {
            const mintB = await getMint(this.connection, poolState.tokenBMint, 'processed', TOKEN_PROGRAM_ID);
            tokenBDecimals = mintB.decimals;
          }
        }
      }

      if (tokenADecimals !== null && tokenBDecimals !== null) {
        this.poolDecimalsCache.set(poolAddress, { tokenADecimals, tokenBDecimals });
      }

      const vaultA = await this.connection.getTokenAccountBalance(poolState.tokenAVault);
      const vaultB = await this.connection.getTokenAccountBalance(poolState.tokenBVault);
      this.vaultBalanceCache.set(poolAddress, {
        vaultABalance: parseFloat(vaultA.value.uiAmountString || '0'),
        vaultBBalance: parseFloat(vaultB.value.uiAmountString || '0'),
      });
    } catch (error) {
      debugError('[PREFETCH] Failed to prefetch pool snapshot:', error);
    }
  }

  /**
   * Initialize Meteora SDK
   */
  private async initializeCpAmm(): Promise<void> {
    if (this.cpAmm) return;

    try {
      // Dynamically import Meteora SDK
      const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
      this.cpAmm = new CpAmm(this.connection);
      debugLog('✅ Meteora SDK initialized');
    } catch (error) {
      debugError('Failed to initialize Meteora SDK:', error);
      throw new Error('Meteora SDK not available');
    }
  }

  /**
   * Get deposit quote from RIFT amount - shows exact SOL needed
   */
  async getDepositQuoteFromRift(poolAddress: string, riftAmount: number): Promise<DepositQuoteResult> {
    await this.initializeCpAmm();
    if (!this.cpAmm) throw new Error('CP-AMM not initialized');

    try {
      const cachedState = this.poolStateCache.get(poolAddress);
      const poolState = cachedState || await this.cpAmm.fetchPoolState(new PublicKey(poolAddress));
      if (!cachedState) this.poolStateCache.set(poolAddress, poolState);

      // Detect which side is SOL/WSOL - tokenA might be rRIFT, not SOL!
      const isTokenASol = poolState.tokenAMint.equals(NATIVE_MINT);
      const isTokenBSol = poolState.tokenBMint.equals(NATIVE_MINT);

      debugLog(`[QUOTE-RIFT] Pool token layout: tokenA=${poolState.tokenAMint.toBase58().slice(0,8)}... (isSOL: ${isTokenASol}), tokenB=${poolState.tokenBMint.toBase58().slice(0,8)}... (isSOL: ${isTokenBSol})`);

      // ⚡ OPTIMIZATION: Use Supabase cache for mint decimals
      const { getMintDecimals } = await import('@/lib/supabase/client');

      const cachedDecimals = this.poolDecimalsCache.get(poolAddress);
      let tokenADecimals = cachedDecimals?.tokenADecimals ?? await getMintDecimals(poolState.tokenAMint.toBase58());
      let tokenBDecimals = cachedDecimals?.tokenBDecimals ?? await getMintDecimals(poolState.tokenBMint.toBase58());

      // Fallback to RPC if not cached (batch both calls)
      if (tokenADecimals === null || tokenBDecimals === null) {
        // FIXED: Use proper Token-2022 mint deserialization
        const { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');

        if (tokenADecimals === null) {
          try {
            const mintA = await getMint(this.connection, poolState.tokenAMint, 'processed', TOKEN_2022_PROGRAM_ID);
            tokenADecimals = mintA.decimals;
          } catch {
            // Fallback to SPL Token
            try {
              const mintA = await getMint(this.connection, poolState.tokenAMint, 'processed', TOKEN_PROGRAM_ID);
              tokenADecimals = mintA.decimals;
            } catch {
              tokenADecimals = 9; // Default to 9 for SOL
            }
          }
        }

        if (tokenBDecimals === null) {
          try {
            const mintB = await getMint(this.connection, poolState.tokenBMint, 'processed', TOKEN_2022_PROGRAM_ID);
            tokenBDecimals = mintB.decimals;
          } catch {
            // Fallback to SPL Token
            try {
              const mintB = await getMint(this.connection, poolState.tokenBMint, 'processed', TOKEN_PROGRAM_ID);
              tokenBDecimals = mintB.decimals;
            } catch {
              tokenBDecimals = 9; // Default to 9
            }
          }
        }
      }

      if (tokenADecimals === null || tokenBDecimals === null) {
        throw new Error('Failed to fetch mint decimals');
      }

      // Determine correct decimals based on which side is SOL
      const solDecimals = isTokenASol ? tokenADecimals : tokenBDecimals;
      const riftDecimals = isTokenASol ? tokenBDecimals : tokenADecimals;

      const riftAmountLamports = Math.floor(riftAmount * Math.pow(10, riftDecimals));

      // isTokenA should be true if rRIFT is tokenA (i.e., SOL is tokenB), false if rRIFT is tokenB
      const depositQuote = await this.cpAmm.getDepositQuote({
        inAmount: new BN(riftAmountLamports),
        isTokenA: !isTokenASol, // Provide rRIFT side - true if tokenA is rRIFT (SOL is B), false if tokenB is rRIFT (SOL is A)
        minSqrtPrice: poolState.sqrtMinPrice,
        maxSqrtPrice: poolState.sqrtMaxPrice,
        sqrtPrice: poolState.sqrtPrice
      });

      // Output is SOL, input consumed is rRIFT
      const wsolNeeded = depositQuote.outputAmount;
      const riftNeeded = depositQuote.consumedInputAmount;

      // Get current pool balances to calculate ratio (rRIFT per SOL)
      let vaultABalance = this.vaultBalanceCache.get(poolAddress)?.vaultABalance;
      let vaultBBalance = this.vaultBalanceCache.get(poolAddress)?.vaultBBalance;
      if (vaultABalance === undefined || vaultBBalance === undefined) {
        const vaultA = await this.connection.getTokenAccountBalance(poolState.tokenAVault);
        const vaultB = await this.connection.getTokenAccountBalance(poolState.tokenBVault);
        vaultABalance = parseFloat(vaultA.value.uiAmountString || '0');
        vaultBBalance = parseFloat(vaultB.value.uiAmountString || '0');
        this.vaultBalanceCache.set(poolAddress, { vaultABalance, vaultBBalance });
      }

      // Calculate ratio as rRIFT per SOL regardless of pool token order
      const poolRatio = isTokenASol
        ? vaultBBalance / vaultABalance  // tokenA=SOL, tokenB=rRIFT: rRIFT/SOL
        : vaultABalance / vaultBBalance; // tokenA=rRIFT, tokenB=SOL: rRIFT/SOL

      debugLog(`[QUOTE-RIFT] Pool ratio: ${poolRatio.toFixed(4)} rRIFT per SOL (vaultA: ${vaultABalance}, vaultB: ${vaultBBalance})`);

      return {
        wsolNeeded: wsolNeeded.toNumber() / Math.pow(10, solDecimals),
        riftNeeded: riftNeeded.toNumber() / Math.pow(10, riftDecimals),
        liquidityDelta: depositQuote.liquidityDelta.toString(),
        poolRatio
      };
    } catch (error) {
      debugError('Failed to get deposit quote from RIFT:', error);
      if (error instanceof Error && error.message.includes('Assertion failed')) {
        throw new Error('Amount too large for current pool liquidity. Try a smaller amount or add liquidity in multiple transactions.');
      }
      throw error;
    }
  }

  /**
   * Get deposit quote from SOL amount - shows exact RIFT needed
   */
  async getDepositQuoteFromSol(poolAddress: string, solAmount: number): Promise<DepositQuoteResult> {
    await this.initializeCpAmm();
    if (!this.cpAmm) throw new Error('CP-AMM not initialized');

    try {
      const cachedState = this.poolStateCache.get(poolAddress);
      const poolState = cachedState || await this.cpAmm.fetchPoolState(new PublicKey(poolAddress));
      if (!cachedState) this.poolStateCache.set(poolAddress, poolState);

      // Detect which side is SOL/WSOL - tokenA might be rRIFT, not SOL!
      const isTokenASol = poolState.tokenAMint.equals(NATIVE_MINT);
      const isTokenBSol = poolState.tokenBMint.equals(NATIVE_MINT);

      debugLog(`[QUOTE] Pool token layout: tokenA=${poolState.tokenAMint.toBase58().slice(0,8)}... (isSOL: ${isTokenASol}), tokenB=${poolState.tokenBMint.toBase58().slice(0,8)}... (isSOL: ${isTokenBSol})`);

      // ⚡ OPTIMIZATION: Use Supabase cache for mint decimals
      const { getMintDecimals } = await import('@/lib/supabase/client');

      const cachedDecimals = this.poolDecimalsCache.get(poolAddress);
      let tokenADecimals = cachedDecimals?.tokenADecimals ?? await getMintDecimals(poolState.tokenAMint.toBase58());
      let tokenBDecimals = cachedDecimals?.tokenBDecimals ?? await getMintDecimals(poolState.tokenBMint.toBase58());

      // Fallback to RPC if not cached (batch both calls)
      if (tokenADecimals === null || tokenBDecimals === null) {
        // FIXED: Use proper Token-2022 mint deserialization
        const { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');

        if (tokenADecimals === null) {
          try {
            const mintA = await getMint(this.connection, poolState.tokenAMint, 'processed', TOKEN_2022_PROGRAM_ID);
            tokenADecimals = mintA.decimals;
          } catch {
            // Fallback to SPL Token
            try {
              const mintA = await getMint(this.connection, poolState.tokenAMint, 'processed', TOKEN_PROGRAM_ID);
              tokenADecimals = mintA.decimals;
            } catch {
              tokenADecimals = 9; // Default to 9 for SOL
            }
          }
        }

        if (tokenBDecimals === null) {
          try {
            const mintB = await getMint(this.connection, poolState.tokenBMint, 'processed', TOKEN_2022_PROGRAM_ID);
            tokenBDecimals = mintB.decimals;
          } catch {
            // Fallback to SPL Token
            try {
              const mintB = await getMint(this.connection, poolState.tokenBMint, 'processed', TOKEN_PROGRAM_ID);
              tokenBDecimals = mintB.decimals;
            } catch {
              tokenBDecimals = 9; // Default to 9
            }
          }
        }
      }

      if (tokenADecimals === null || tokenBDecimals === null) {
        throw new Error('Failed to fetch mint decimals');
      }

      // Determine correct decimals based on which side is SOL
      const solDecimals = isTokenASol ? tokenADecimals : tokenBDecimals;
      const riftDecimals = isTokenASol ? tokenBDecimals : tokenADecimals;

      const solAmountLamports = Math.floor(solAmount * Math.pow(10, solDecimals));

      // isTokenA should be true if SOL is tokenA, false if SOL is tokenB
      const depositQuote = await this.cpAmm.getDepositQuote({
        inAmount: new BN(solAmountLamports),
        isTokenA: isTokenASol, // Provide SOL side - true if tokenA is SOL, false if tokenB is SOL
        minSqrtPrice: poolState.sqrtMinPrice,
        maxSqrtPrice: poolState.sqrtMaxPrice,
        sqrtPrice: poolState.sqrtPrice
      });

      // Output is the other side (rRIFT), input consumed is SOL
      const riftNeeded = depositQuote.outputAmount;
      const wsolNeeded = depositQuote.consumedInputAmount;

      // Get current pool balances to calculate ratio (rRIFT per SOL)
      let vaultABalance = this.vaultBalanceCache.get(poolAddress)?.vaultABalance;
      let vaultBBalance = this.vaultBalanceCache.get(poolAddress)?.vaultBBalance;
      if (vaultABalance === undefined || vaultBBalance === undefined) {
        const vaultA = await this.connection.getTokenAccountBalance(poolState.tokenAVault);
        const vaultB = await this.connection.getTokenAccountBalance(poolState.tokenBVault);
        vaultABalance = parseFloat(vaultA.value.uiAmountString || '0');
        vaultBBalance = parseFloat(vaultB.value.uiAmountString || '0');
        this.vaultBalanceCache.set(poolAddress, { vaultABalance, vaultBBalance });
      }

      // Calculate ratio as rRIFT per SOL regardless of pool token order
      const poolRatio = isTokenASol
        ? vaultBBalance / vaultABalance  // tokenA=SOL, tokenB=rRIFT: rRIFT/SOL
        : vaultABalance / vaultBBalance; // tokenA=rRIFT, tokenB=SOL: rRIFT/SOL

      debugLog(`[QUOTE] Pool ratio: ${poolRatio.toFixed(4)} rRIFT per SOL (vaultA: ${vaultABalance}, vaultB: ${vaultBBalance})`);

      return {
        wsolNeeded: wsolNeeded.toNumber() / Math.pow(10, solDecimals),
        riftNeeded: riftNeeded.toNumber() / Math.pow(10, riftDecimals),
        liquidityDelta: depositQuote.liquidityDelta.toString(),
        poolRatio
      };
    } catch (error) {
      debugError('Failed to get deposit quote from SOL:', error);
      if (error instanceof Error && error.message.includes('Assertion failed')) {
        throw new Error('Amount too large for current pool liquidity. Try a smaller amount or add liquidity in multiple transactions.');
      }
      throw error;
    }
  }

  /**
   * Get deposit quote - wrapper that uses RIFT amount by default
   * @deprecated Use getDepositQuoteFromRift or getDepositQuoteFromSol
   */
  async getDepositQuote(poolAddress: string, riftAmount: number): Promise<DepositQuoteResult> {
    return this.getDepositQuoteFromRift(poolAddress, riftAmount);
  }

  /**
   * Add liquidity to a Meteora pool
   * Based on add-liquidity-full.js working script
   */
  async addLiquidity(params: AddLiquidityParams): Promise<string> {
    await this.initializeCpAmm();
    if (!this.cpAmm) throw new Error('CP-AMM not initialized');

    debugLog('🌊 Adding liquidity to Meteora pool:', params.poolAddress);
    const startTime = Date.now();

    try {
      const poolPubkey = new PublicKey(params.poolAddress);
      const poolState = await this.cpAmm.fetchPoolState(poolPubkey);

      // ⚡ OPTIMIZATION: Use Supabase cache for mint decimals instead of RPC
      debugLog('⚡ [ADD-LIQ OPTIMIZATION] Fetching mint decimals from cache...');
      const tMints = Date.now();

      const { getMintDecimals } = await import('@/lib/supabase/client');

      // Try Supabase cache first, fallback to RPC if needed
      let tokenADecimals = await getMintDecimals(poolState.tokenAMint.toBase58());
      let tokenBDecimals = await getMintDecimals(poolState.tokenBMint.toBase58());

      // Fallback to RPC if not in cache
      if (tokenADecimals === null || tokenBDecimals === null) {
        debugLog('⚡ Fetching missing decimals from RPC with Token-2022 support...');
        // FIXED: Use proper Token-2022 mint deserialization
        const { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');

        if (tokenADecimals === null) {
          try {
            const mintA = await getMint(this.connection, poolState.tokenAMint, 'processed', TOKEN_2022_PROGRAM_ID);
            tokenADecimals = mintA.decimals;
          } catch {
            // Fallback to SPL Token
            try {
              const mintA = await getMint(this.connection, poolState.tokenAMint, 'processed', TOKEN_PROGRAM_ID);
              tokenADecimals = mintA.decimals;
            } catch {
              tokenADecimals = 9; // Default to 9 for SOL
            }
          }
        }

        if (tokenBDecimals === null) {
          try {
            const mintB = await getMint(this.connection, poolState.tokenBMint, 'processed', TOKEN_2022_PROGRAM_ID);
            tokenBDecimals = mintB.decimals;
          } catch {
            // Fallback to SPL Token
            try {
              const mintB = await getMint(this.connection, poolState.tokenBMint, 'processed', TOKEN_PROGRAM_ID);
              tokenBDecimals = mintB.decimals;
            } catch {
              tokenBDecimals = 9; // Default to 9
            }
          }
        }
      }

      if (tokenADecimals === null || tokenBDecimals === null) {
        throw new Error('Failed to fetch mint decimals');
      }

      debugLog(`⏱️ [ADD-LIQ TIMING] getMintDecimals took: ${Date.now() - tMints}ms`);

      // Step 1: Detect token order in the pool (wSOL can be Token A or Token B!)
      const WSOL_MINT = 'So11111111111111111111111111111111111111112';
      const tokenAIsWsol = poolState.tokenAMint.toBase58() === WSOL_MINT;
      const tokenBIsWsol = poolState.tokenBMint.toBase58() === WSOL_MINT;

      debugLog('🔍 Token order detection:');
      debugLog(`   Token A: ${poolState.tokenAMint.toBase58()} (isWSOL: ${tokenAIsWsol})`);
      debugLog(`   Token B: ${poolState.tokenBMint.toBase58()} (isWSOL: ${tokenBIsWsol})`);

      // Determine which token is the rift token based on pool configuration
      const riftIsTokenA = !tokenAIsWsol && tokenBIsWsol; // Rift is A if A is not wSOL and B is wSOL
      const riftIsTokenB = tokenAIsWsol && !tokenBIsWsol; // Rift is B if A is wSOL and B is not wSOL

      if (!riftIsTokenA && !riftIsTokenB) {
        debugLog('⚠️ Warning: Could not determine token order, pool may not contain wSOL');
      }

      debugLog(`   Rift token position: ${riftIsTokenA ? 'Token A' : 'Token B'}`);

      // Get correct decimals based on token position
      const riftDecimals = riftIsTokenA ? tokenADecimals : tokenBDecimals;
      const wsolDecimals = riftIsTokenA ? tokenBDecimals : tokenADecimals;

      // Step 1: Get deposit quote FIRST to know exact amounts needed
      debugLog('🔄 Getting deposit quote...');

      // Apply 1% reduction to input amount to leave room for on-chain rounding differences
      // This ensures the actual on-chain transfer won't exceed the user's balance
      const riftAmountLamportsRaw = Math.floor(params.riftAmount * Math.pow(10, riftDecimals));
      const riftAmountLamports = Math.floor(riftAmountLamportsRaw * 0.99); // 1% reduction for rounding buffer
      debugLog(`🔧 Input amount: ${riftAmountLamportsRaw} → ${riftAmountLamports} lamports (1% buffer applied)`);

      const depositQuote = await this.cpAmm.getDepositQuote({
        inAmount: new BN(riftAmountLamports),
        isTokenA: riftIsTokenA, // Provide rift token (could be A or B depending on pool)
        minSqrtPrice: poolState.sqrtMinPrice,
        maxSqrtPrice: poolState.sqrtMaxPrice,
        sqrtPrice: poolState.sqrtPrice
      });

      // Output is the OTHER token (wSOL), input consumed is the rift token
      let wsolNeeded = depositQuote.outputAmount;
      let riftNeeded = depositQuote.consumedInputAmount;

      debugLog('📋 Quote from SDK:');
      debugLog('  wSOL needed:', (wsolNeeded.toNumber() / Math.pow(10, wsolDecimals)).toFixed(wsolDecimals));
      debugLog('  RIFT needed:', (riftNeeded.toNumber() / Math.pow(10, riftDecimals)).toFixed(riftDecimals));

      // Check pool reserves to detect if this is truly single-sided or has balanced liquidity
      const [vaultAInfo, vaultBInfo] = await Promise.all([
        this.connection.getTokenAccountBalance(poolState.tokenAVault),
        this.connection.getTokenAccountBalance(poolState.tokenBVault)
      ]);
      const vaultABalance = parseFloat(vaultAInfo.value.uiAmountString || '0');
      const vaultBBalance = parseFloat(vaultBInfo.value.uiAmountString || '0');
      debugLog(`📊 Pool reserves: vaultA=${vaultABalance}, vaultB=${vaultBBalance}`);

      // Dust threshold - amounts below this are considered effectively zero (0.0001 SOL = 100,000 lamports)
      const DUST_THRESHOLD = 0.0001;
      const wsolVaultBalance = riftIsTokenA ? vaultBBalance : vaultABalance;
      const riftVaultBalance = riftIsTokenA ? vaultABalance : vaultBBalance;
      const hasSignificantWsol = wsolVaultBalance > DUST_THRESHOLD;
      const hasSignificantRift = riftVaultBalance > DUST_THRESHOLD;

      // If trying single-sided deposit but pool has SIGNIFICANT reserves on both sides, show helpful error
      if (wsolNeeded.isZero() && hasSignificantWsol && hasSignificantRift) {
        debugLog(`⚠️ Pool has ${wsolVaultBalance} wSOL in reserve - balanced deposit required`);
        throw new Error(
          `This pool has liquidity on both sides (wSOL: ${wsolVaultBalance.toFixed(4)}). ` +
          `You must provide both tokens in ratio. Please add some SOL to your deposit, or use DLMM for true single-sided deposits.`
        );
      }

      // Log that this is a valid single-sided pool
      if (!hasSignificantWsol) {
        debugLog(`✅ Single-sided pool detected (wSOL: ${wsolVaultBalance} < dust threshold)`);
      }

      // CRITICAL FIX: If SDK returns 0 for wSOL but pool has SIGNIFICANT wSOL reserves,
      // calculate the actual wSOL needed based on pool ratio to prevent slippage error.
      // The on-chain program uses integer math and will calculate 1+ lamports needed.
      // NOTE: Skip this for single-sided pools (dust wSOL only) - they don't require wSOL.
      if (wsolNeeded.isZero() && hasSignificantWsol) {
        // Calculate wSOL needed based on pool ratio: wSOL = rift * (wsolReserve / riftReserve)
        const riftReserveLamports = riftIsTokenA
          ? vaultABalance * Math.pow(10, riftDecimals)
          : vaultBBalance * Math.pow(10, riftDecimals);
        const wsolReserveLamports = riftIsTokenA
          ? vaultBBalance * Math.pow(10, wsolDecimals)
          : vaultABalance * Math.pow(10, wsolDecimals);

        if (riftReserveLamports > 0) {
          // Calculate proportional wSOL, add 10% buffer and round up to ensure we have enough
          const calculatedWsol = Math.ceil(riftNeeded.toNumber() * (wsolReserveLamports / riftReserveLamports) * 1.1);
          // Ensure minimum of 1000 lamports (0.000001 SOL) to handle any rounding
          const minWsolLamports = Math.max(calculatedWsol, 1000);
          wsolNeeded = new BN(minWsolLamports);
          debugLog(`🔧 Adjusted wSOL needed from 0 to ${minWsolLamports} lamports (pool ratio calculation)`);
        }
      }

      // Step 1.5: VERIFY that this pool has the correct tokens!
      debugLog('🔍 Pool verification:');
      debugLog(`   Pool address: ${params.poolAddress}`);
      debugLog(`   Token A mint: ${poolState.tokenAMint.toBase58()}`);
      debugLog(`   Token B mint: ${poolState.tokenBMint.toBase58()}`);

      // WSOL_MINT already defined above for token order detection

      if (params.useUnderlyingToken && params.underlyingMint) {
        // Verify this pool has the underlying token (not wSOL)
        const hasUnderlyingToken =
          poolState.tokenAMint.toBase58() === params.underlyingMint ||
          poolState.tokenBMint.toBase58() === params.underlyingMint;

        const hasWSOL =
          poolState.tokenAMint.toBase58() === WSOL_MINT ||
          poolState.tokenBMint.toBase58() === WSOL_MINT;

        if (!hasUnderlyingToken) {
          throw new Error(`ERROR: This pool does not contain the underlying token (${params.underlyingMint}). Please select the correct pool.`);
        }

        if (hasWSOL) {
          throw new Error(`ERROR: This pool contains wSOL, not the underlying token. You selected the RIFTS tab but this is the SOL pool!`);
        }

        debugLog('✅ Pool verified: Contains underlying token, not wSOL');
      } else if (!params.useUnderlyingToken) {
        // Verify this pool has wSOL (not underlying token)
        const hasWSOL =
          poolState.tokenAMint.toBase58() === WSOL_MINT ||
          poolState.tokenBMint.toBase58() === WSOL_MINT;

        if (!hasWSOL) {
          throw new Error(`ERROR: This pool does not contain wSOL. You selected the SOL tab but this is the underlying token pool!`);
        }

        debugLog('✅ Pool verified: Contains wSOL');
      }

      // Step 2: Check token balance (SOL or underlying token)
      // Use wsolDecimals since we're checking how much wSOL/SOL is needed
      const solAmountNeeded = wsolNeeded.toNumber() / Math.pow(10, wsolDecimals);

      if (params.useUnderlyingToken) {
        // Check underlying token balance (not SOL)
        // IMPORTANT: We need to find which token in the pool is the underlying token
        // We can't assume it's Token A - we need to check both tokens

        // For now, we'll use walletService to check the balance by mint address
        // We need the underlying mint to be passed as a parameter
        if (!params.underlyingMint) {
          throw new Error('underlyingMint is required when useUnderlyingToken is true');
        }

        const { getAssociatedTokenAddress } = await import('@solana/spl-token');

        // FIXED: Detect the token program for the underlying mint (could be SPL or Token-2022)
        const underlyingMintPubkey = new PublicKey(params.underlyingMint);
        const underlyingMintInfo = await this.connection.getAccountInfo(underlyingMintPubkey);
        const underlyingTokenProgram = underlyingMintInfo?.owner?.equals(TOKEN_2022_PROGRAM_ID)
          ? TOKEN_2022_PROGRAM_ID
          : TOKEN_PROGRAM_ID;

        debugLog(`🔧 Underlying token ${params.underlyingMint.slice(0, 8)}... uses ${underlyingTokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'TOKEN_2022_PROGRAM_ID' : 'TOKEN_PROGRAM_ID'}`);

        const underlyingAta = await getAssociatedTokenAddress(
          underlyingMintPubkey,
          params.wallet.publicKey,
          false,
          underlyingTokenProgram
        );

        debugLog('🔍 Underlying token balance check:');
        debugLog(`   Underlying mint: ${params.underlyingMint}`);
        debugLog(`   User ATA: ${underlyingAta.toBase58()}`);

        // Handle case where token account doesn't exist yet (user hasn't received this token)
        const underlyingBalance = await this.connection.getTokenAccountBalance(underlyingAta).catch((err) => {
          debugLog(`   ⚠️ Failed to get balance: ${err.message}`);
          return { value: { uiAmount: 0, uiAmountString: '0' } };
        });
        const availableUnderlying = parseFloat(underlyingBalance.value.uiAmountString || '0');

        debugLog('💰 Balance check:');
        debugLog(`   Need: ${solAmountNeeded.toFixed(9)} tokens`);
        debugLog(`   Have: ${availableUnderlying.toFixed(9)} tokens`);

        if (solAmountNeeded > availableUnderlying) {
          throw new Error(`Insufficient underlying token balance. Need ${solAmountNeeded.toFixed(9)}, have ${availableUnderlying.toFixed(9)}`);
        }

        debugLog('✅ Sufficient underlying token balance available');
      } else {
        // Check SOL balance
        const walletBalance = await this.connection.getBalance(params.wallet.publicKey);
        const availableSol = walletBalance / 1e9;

        debugLog('💰 SOL balance check:');
        debugLog(`   Need: ${solAmountNeeded.toFixed(9)} SOL`);
        debugLog(`   Have: ${availableSol.toFixed(9)} SOL`);

        // Leave 0.01 SOL for transaction fees
        if (solAmountNeeded > availableSol - 0.01) {
          throw new Error(`Insufficient SOL balance. Need ${solAmountNeeded.toFixed(9)} SOL, have ${availableSol.toFixed(9)} SOL. (Need to leave ~0.01 SOL for transaction fees)`);
        }

        debugLog('✅ Sufficient SOL balance available');
      }

      // Step 2.5: Check rift token balance
      const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
      const riftMint = riftIsTokenA ? poolState.tokenAMint : poolState.tokenBMint;
      // Detect rift token program (rift tokens use Token-2022)
      const riftMintInfo = await this.connection.getAccountInfo(riftMint);
      const riftTokenProgram = riftMintInfo?.owner?.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;
      const riftAta = getAssociatedTokenAddressSync(riftMint, params.wallet.publicKey, false, riftTokenProgram);

      debugLog('💎 Rift token balance check:');
      const riftBalance = await this.connection.getTokenAccountBalance(riftAta).catch((err) => {
        debugLog(`   ⚠️ No rift token account found: ${err.message}`);
        return { value: { uiAmount: 0, uiAmountString: '0', amount: '0' } };
      });
      const riftBalanceLamportsStr = riftBalance.value.amount || '0';
      const riftBalanceBN = new BN(riftBalanceLamportsStr);
      const riftBalanceUi = parseFloat(riftBalance.value.uiAmountString || '0');
      const riftNeededUi = riftNeeded.toNumber() / Math.pow(10, riftDecimals);

      debugLog(`   Need: ${riftNeededUi.toFixed(riftDecimals)} rift (${riftNeeded.toString()} lamports)`);
      debugLog(`   Have: ${riftBalanceUi.toFixed(riftDecimals)} rift (${riftBalanceLamportsStr} lamports)`);

      if (riftNeeded.gt(riftBalanceBN)) {
        throw new Error(`Insufficient rift token balance. Need ${riftNeededUi.toFixed(6)} rift, have ${riftBalanceUi.toFixed(6)} rift.`);
      }

      // For single-sided deposits: ensure riftNeeded * 1.01 (threshold) won't exceed balance
      // This prevents "insufficient funds" errors when the program tries to transfer up to the threshold
      const isSingleSidedCheck = wsolNeeded.isZero() || wsolNeeded.lte(new BN(1000));
      let recalculatedQuote = depositQuote; // Will be updated if we need to reduce amount
      if (isSingleSidedCheck) {
        // Max safe amount = balance / 1.01 (so threshold stays within balance)
        const maxSafeAmount = riftBalanceBN.mul(new BN(100)).div(new BN(101));
        if (riftNeeded.gt(maxSafeAmount)) {
          debugLog(`⚠️ Reducing riftNeeded from ${riftNeeded.toString()} to ${maxSafeAmount.toString()} (keeps threshold within balance)`);
          riftNeeded = maxSafeAmount;

          // CRITICAL: Recalculate the quote with the reduced amount
          // The liquidityDelta must match the actual amount we're depositing
          debugLog('🔄 Recalculating deposit quote for reduced amount...');
          recalculatedQuote = await this.cpAmm.getDepositQuote({
            inAmount: riftNeeded,
            isTokenA: riftIsTokenA,
            minSqrtPrice: poolState.sqrtMinPrice,
            maxSqrtPrice: poolState.sqrtMaxPrice,
            sqrtPrice: poolState.sqrtPrice
          });
          debugLog(`📋 Recalculated quote - liquidityDelta: ${recalculatedQuote.liquidityDelta.toString()}`);
        }
      }

      debugLog('✅ Sufficient rift token balance available');

      // Step 3: Close any existing wSOL account so SDK will add fresh wrapping
      const wsolAta = await getAssociatedTokenAddress(
        NATIVE_MINT,
        params.wallet.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      const wsolInfo = await this.connection.getAccountInfo(wsolAta);

      if (wsolInfo) {
        debugLog('⚠️  Closing existing wSOL account so SDK will add fresh wrapping...');

        const closeWsolTx = new Transaction().add(
          createCloseAccountInstruction(
            wsolAta,
            params.wallet.publicKey,
            params.wallet.publicKey,
            [],
            TOKEN_PROGRAM_ID
          )
        );

        closeWsolTx.feePayer = params.wallet.publicKey;

        // ⚡ OPTIMIZATION: Use server-side cached blockhash
        debugLog('⚡ Fetching blockhash from cache...');
        const tBlockhash1 = Date.now();
        let blockhash1: string;
        try {
          const response = await fetch('/api/blockhash');
          const data = await response.json();
          blockhash1 = data.blockhash || (await this.connection.getLatestBlockhash()).blockhash;
          debugLog(`⏱️ [ADD-LIQ TIMING] blockhash #1 took: ${Date.now() - tBlockhash1}ms (cached: ${data.cached})`);
        } catch {
          blockhash1 = (await this.connection.getLatestBlockhash()).blockhash;
          debugLog(`⏱️ [ADD-LIQ TIMING] blockhash #1 took: ${Date.now() - tBlockhash1}ms (RPC fallback)`);
        }
        closeWsolTx.recentBlockhash = blockhash1;

        let closeSig: string;
        if (params.wallet.sendTransaction) {
          closeSig = await params.wallet.sendTransaction(closeWsolTx, this.connection);
        } else {
          const signedCloseTx = await params.wallet.signTransaction(closeWsolTx);
          closeSig = await this.connection.sendRawTransaction(signedCloseTx.serialize());
        }

        debugLog('✅ Closed wSOL account, tx:', closeSig);
        debugLog('⏳ Waiting for confirmation...');

        // Poll for confirmation
        let confirmed = false;
        for (let i = 0; i < 20; i++) {
          await new Promise(resolve => setTimeout(resolve, 500));
          const status = await this.connection.getSignatureStatus(closeSig);
          if (status?.value?.confirmationStatus === 'confirmed' || status?.value?.confirmationStatus === 'finalized') {
            confirmed = true;
            debugLog('✅ wSOL account closed - SDK will now add fresh wrapping');
            break;
          }
        }

        if (!confirmed) {
          debugLog('⚠️  Close taking longer, proceeding anyway...');
        }
      } else {
        debugLog('✅ No existing wSOL account - SDK will add wrapping');
      }

      // Step 4: Calculate thresholds
      // FIXED: Token order depends on pool configuration
      // If rift is Token A: riftNeeded is A, wsolNeeded is B
      // If rift is Token B: wsolNeeded is A, riftNeeded is B
      //
      // maxAmountTokenA/B: MAXIMUM user is willing to spend (2x buffer for safety)
      // tokenAAmountThreshold/B: MINIMUM acceptable (with 5% slippage tolerance)
      //
      // IMPORTANT: For single-sided deposits, we need to allow a small dust amount
      // even when the quote says 0, because the on-chain program might calculate
      // tiny amounts needed and fail slippage checks if max is strictly 0
      const SINGLE_SIDED_DUST_ALLOWANCE = new BN(100000); // 0.0001 SOL in lamports

      // For single-sided deposits, SDK uses maxTokenA/B as actual transfer amounts,
      // so we use 1x for the rift side (already reduced by 1% buffer)
      // and allow dust on the wSOL side
      const isSingleSidedDeposit = wsolNeeded.isZero() || wsolNeeded.lte(new BN(1000));

      let maxTokenA: BN;
      let maxTokenB: BN;

      if (isSingleSidedDeposit) {
        // Single-sided: use exact amounts, SDK uses these as transfer amounts
        if (riftIsTokenA) {
          maxTokenA = riftNeeded;  // Exact rift amount (already 1% reduced)
          maxTokenB = SINGLE_SIDED_DUST_ALLOWANCE; // Allow tiny wSOL
        } else {
          maxTokenA = SINGLE_SIDED_DUST_ALLOWANCE; // Allow tiny wSOL
          maxTokenB = riftNeeded;  // Exact rift amount (already 1% reduced)
        }
        debugLog(`🔧 Single-sided deposit: using exact rift amount, dust allowance for wSOL`);
      } else {
        // Two-sided deposit: use 2x buffer
        maxTokenA = riftIsTokenA
          ? riftNeeded.mul(new BN(200)).div(new BN(100))
          : wsolNeeded.mul(new BN(200)).div(new BN(100));
        maxTokenB = riftIsTokenA
          ? wsolNeeded.mul(new BN(200)).div(new BN(100))
          : riftNeeded.mul(new BN(200)).div(new BN(100));
      }

      // CRITICAL FIX: The on-chain CP-AMM program checks:
      //   require!(total_amount_a <= token_a_amount_threshold, ExceededSlippage)
      //   require!(total_amount_b <= token_b_amount_threshold, ExceededSlippage)
      //
      // So tokenAAmountThreshold and tokenBAmountThreshold are MAXIMUM amounts, not minimums!
      // The thresholds need to be HIGHER than max amounts to account for:
      // 1. On-chain fees that get added to the deposit
      // 2. Rounding differences between SDK and on-chain calculations
      // Add 1% buffer to thresholds to cover fees + rounding
      let tokenAThreshold = maxTokenA.mul(new BN(101)).div(new BN(100));  // 1% buffer for fees
      let tokenBThreshold = maxTokenB.mul(new BN(101)).div(new BN(100));  // 1% buffer for fees

      // CRITICAL: For single-sided deposits, cap the rift token threshold at the user's actual balance
      // This prevents the program from trying to transfer more than the user has
      if (isSingleSidedDeposit) {
        if (riftIsTokenA && tokenAThreshold.gt(riftBalanceBN)) {
          debugLog(`⚠️ Capping tokenAThreshold from ${tokenAThreshold.toString()} to user balance ${riftBalanceBN.toString()}`);
          tokenAThreshold = riftBalanceBN;
        } else if (!riftIsTokenA && tokenBThreshold.gt(riftBalanceBN)) {
          debugLog(`⚠️ Capping tokenBThreshold from ${tokenBThreshold.toString()} to user balance ${riftBalanceBN.toString()}`);
          tokenBThreshold = riftBalanceBN;
        }
      }

      debugLog('📊 Liquidity thresholds:');
      debugLog(`   maxTokenA: ${maxTokenA.toString()} (${riftIsTokenA ? 'rift' : 'wSOL'})`);
      debugLog(`   maxTokenB: ${maxTokenB.toString()} (${riftIsTokenA ? 'wSOL' : 'rift'})`);
      debugLog(`   tokenAThreshold: ${tokenAThreshold.toString()} (max acceptable)`);
      debugLog(`   tokenBThreshold: ${tokenBThreshold.toString()} (max acceptable)`);

      // FIXED: Detect which token program to use for each mint
      // CRITICAL: Check WSOL FIRST - it always uses SPL Token, even if passed as underlyingMint
      const WSOL_MINT_STR = 'So11111111111111111111111111111111111111112';
      const getTokenProgram = (mint: PublicKey): PublicKey => {
        const mintStr = mint.toBase58();
        // WSOL ALWAYS uses SPL Token - check this FIRST!
        if (mintStr === WSOL_MINT_STR) {
          debugLog(`🔧 Token ${mintStr.slice(0, 8)}... uses TOKEN_PROGRAM_ID (wSOL)`);
          return TOKEN_PROGRAM_ID;
        }
        // Other underlying tokens (pump.fun tokens, etc.) use Token-2022
        if (params.underlyingMint && mintStr === params.underlyingMint) {
          debugLog(`🔧 Token ${mintStr.slice(0, 8)}... uses TOKEN_2022_PROGRAM_ID (underlying)`);
          return TOKEN_2022_PROGRAM_ID;
        }
        // Default to Token-2022 for rift tokens
        debugLog(`🔧 Token ${mintStr.slice(0, 8)}... defaulting to TOKEN_2022_PROGRAM_ID`);
        return TOKEN_2022_PROGRAM_ID;
      };

      const tokenAProgram = getTokenProgram(poolState.tokenAMint);
      const tokenBProgram = getTokenProgram(poolState.tokenBMint);

      // Step 5: Check if user has existing position - if so, add to it instead of creating new
      debugLog('🔍 Checking for existing positions...');
      const existingPositions = await this.cpAmm.getUserPositionByPool(poolPubkey, params.wallet.publicKey);

      let depositTx: Transaction;
      let positionNftMint: Keypair | null = null;

      if (existingPositions && existingPositions.length > 0) {
        // User has existing position - add liquidity to it
        const existingPos = existingPositions[0]; // Use first position
        debugLog('✅ Found existing position:', existingPos.position.toBase58());
        debugLog('🔨 Adding liquidity to existing position...');

        depositTx = await this.cpAmm.addLiquidity({
          owner: params.wallet.publicKey,
          pool: poolPubkey,
          position: existingPos.position,
          positionNftAccount: existingPos.positionNftAccount,
          liquidityDelta: recalculatedQuote.liquidityDelta,
          maxAmountTokenA: maxTokenA,
          maxAmountTokenB: maxTokenB,
          tokenAAmountThreshold: tokenAThreshold, // Max acceptable amount (program checks: actual <= threshold)
          tokenBAmountThreshold: tokenBThreshold, // Max acceptable amount (program checks: actual <= threshold)
          tokenAMint: poolState.tokenAMint,
          tokenBMint: poolState.tokenBMint,
          tokenAVault: poolState.tokenAVault,
          tokenBVault: poolState.tokenBVault,
          tokenAProgram,
          tokenBProgram,
        });
      } else {
        // No existing position - create new one
        debugLog('📝 No existing position, creating new one...');
        positionNftMint = Keypair.generate();
        debugLog('🎫 Position NFT:', positionNftMint.publicKey.toBase58());

        depositTx = await this.cpAmm.createPositionAndAddLiquidity({
          payer: params.wallet.publicKey,
          owner: params.wallet.publicKey,
          pool: poolPubkey,
          positionNft: positionNftMint.publicKey,
          liquidityDelta: recalculatedQuote.liquidityDelta,
          maxAmountTokenA: maxTokenA,
          maxAmountTokenB: maxTokenB,
          tokenAAmountThreshold: tokenAThreshold, // Max acceptable amount (program checks: actual <= threshold)
          tokenBAmountThreshold: tokenBThreshold, // Max acceptable amount (program checks: actual <= threshold)
          tokenAMint: poolState.tokenAMint,
          tokenBMint: poolState.tokenBMint,
          tokenAVault: poolState.tokenAVault,
          tokenBVault: poolState.tokenBVault,
          tokenAProgram,
          tokenBProgram,
        });
      }

      // 🔧 FIX: Replace SDK's ATA creation instructions with correct token programs
      // The SDK creates ATAs with wrong token program for WSOL (uses Token-2022 instead of SPL Token)
      console.log('🔧 [ATA-FIX] Starting ATA token program fix...');
      const { createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');

      // ASSOCIATED_TOKEN_PROGRAM_ID constant
      const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

      // Calculate correct ATA addresses with proper token programs
      const correctTokenAAta = getAssociatedTokenAddressSync(poolState.tokenAMint, params.wallet.publicKey, false, tokenAProgram);
      const correctTokenBAta = getAssociatedTokenAddressSync(poolState.tokenBMint, params.wallet.publicKey, false, tokenBProgram);

      console.log(`🔧 [ATA-FIX] Token programs: A=${tokenAProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL'}, B=${tokenBProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL'}`);
      console.log(`🔧 [ATA-FIX] Correct ATAs: A=${correctTokenAAta.toBase58().slice(0,8)}, B=${correctTokenBAta.toBase58().slice(0,8)}`);
      console.log(`🔧 [ATA-FIX] Instructions before fix: ${depositTx.instructions.length}`);

      // Remove ALL ATA creation instructions from SDK (they may use wrong token program)
      const beforeRemoval = depositTx.instructions.length;
      depositTx.instructions = depositTx.instructions.filter((ix: any) => {
        const programIdStr = ix.programId?.toBase58?.() || String(ix.programId);
        if (programIdStr === ATA_PROGRAM_ID.toBase58()) {
          console.log('🔧 [ATA-FIX] 🗑️ Removing SDK ATA instruction');
          return false; // Remove it
        }
        return true; // Keep it
      });
      console.log(`🔧 [ATA-FIX] Removed ${beforeRemoval - depositTx.instructions.length} SDK ATA instructions`);

      // Pre-create ATAs with correct token programs if needed
      const tokenAAccountInfo = await this.connection.getAccountInfo(correctTokenAAta);
      if (!tokenAAccountInfo) {
        console.log(`🔧 [ATA-FIX] 📝 Adding tokenA ATA instruction with ${tokenAProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL Token'}`);
        depositTx.instructions.unshift(
          createAssociatedTokenAccountIdempotentInstruction(
            params.wallet.publicKey, correctTokenAAta, params.wallet.publicKey, poolState.tokenAMint, tokenAProgram
          )
        );
      } else {
        console.log(`🔧 [ATA-FIX] ✅ tokenA ATA already exists`);
      }

      const tokenBAccountInfo = await this.connection.getAccountInfo(correctTokenBAta);
      if (!tokenBAccountInfo) {
        console.log(`🔧 [ATA-FIX] 📝 Adding tokenB ATA instruction with ${tokenBProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL Token'}`);
        depositTx.instructions.unshift(
          createAssociatedTokenAccountIdempotentInstruction(
            params.wallet.publicKey, correctTokenBAta, params.wallet.publicKey, poolState.tokenBMint, tokenBProgram
          )
        );
      } else {
        console.log(`🔧 [ATA-FIX] ✅ tokenB ATA already exists`);
      }

      console.log(`🔧 [ATA-FIX] Instructions after fix: ${depositTx.instructions.length}`);

      // 🔧 FIX: For single-sided deposits, we need to manually fund the wSOL ATA
      // The SDK doesn't add a SOL transfer when quote shows 0 wSOL needed,
      // but we calculated that a small amount is actually required
      const needsWsolFunding = depositQuote.outputAmount.isZero() && wsolNeeded.gtn(0);
      if (needsWsolFunding) {
        const wsolAta = riftIsTokenA ? correctTokenBAta : correctTokenAAta;
        console.log(`🔧 [WSOL-FIX] Single-sided deposit: adding ${wsolNeeded.toString()} lamports SOL transfer to wSOL ATA`);

        // Add System transfer to move SOL to wSOL ATA
        const { SystemProgram } = await import('@solana/web3.js');
        const transferIx = SystemProgram.transfer({
          fromPubkey: params.wallet.publicKey,
          toPubkey: wsolAta,
          lamports: wsolNeeded.toNumber(),
        });

        // Add SyncNative to sync the transferred SOL to wSOL
        const { createSyncNativeInstruction } = await import('@solana/spl-token');
        const syncNativeIx = createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID);

        // Insert these BEFORE the AddLiquidity instruction but AFTER ATA creation
        // Find the index of the AddLiquidity instruction (CP-AMM program)
        const cpAmmProgramId = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
        const addLiqIndex = depositTx.instructions.findIndex((ix: any) => {
          const programIdStr = ix.programId?.toBase58?.() || String(ix.programId);
          return programIdStr === cpAmmProgramId;
        });

        if (addLiqIndex !== -1) {
          // Insert before AddLiquidity
          depositTx.instructions.splice(addLiqIndex, 0, transferIx, syncNativeIx);
          console.log(`🔧 [WSOL-FIX] Added SOL transfer + SyncNative before AddLiquidity (index ${addLiqIndex})`);
        } else {
          // Fallback: add at end before AddLiquidity would be
          depositTx.instructions.push(transferIx, syncNativeIx);
          console.log(`🔧 [WSOL-FIX] Added SOL transfer + SyncNative (fallback)`);
        }
      }

      // Add compute budget
      depositTx.instructions.unshift(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2000 })
      );

      debugLog(`📦 Total ${depositTx.instructions.length} instructions (including compute budget)`);

      // Set a fresh blockhash for simulation; wallet may override when sending
      depositTx.feePayer = params.wallet.publicKey;
      const { blockhash: blockhash2 } = await this.connection.getLatestBlockhash('confirmed');
      depositTx.recentBlockhash = blockhash2;
      try {
        const simTx = Transaction.from(
          depositTx.serialize({ requireAllSignatures: false, verifySignatures: false })
        );
        simTx.feePayer = params.wallet.publicKey;
        simTx.recentBlockhash = blockhash2;
        // Populate signer keys (no signatures yet) so simulation has the correct layout
        const signerPks = positionNftMint
          ? [params.wallet.publicKey, positionNftMint.publicKey]
          : [params.wallet.publicKey];
        simTx.setSigners(...signerPks);
        if (positionNftMint) {
          simTx.partialSign(positionNftMint);
        }

        debugLog('[SIM] Tx debug', {
          instructions: simTx.instructions.length,
          feePayer: simTx.feePayer?.toBase58?.(),
          blockhash: simTx.recentBlockhash,
          signerSlots: simTx.signatures?.length,
          programs: simTx.instructions.map(ix => ix.programId.toBase58()),
        });

        // Run simulation via RPC proxy (manual fetch) to avoid client-encoding quirks
        debugLog('[SIM] Pre-simulating add-liquidity tx (sigVerify: false)...');
        const simEncoded = simTx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
        const simResponse = await fetch('/api/rpc-http', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'sim_add_liq',
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

        const simJson = await simResponse.json();
        if (simJson.error) {
          debugLog('[SIM] ❌ Simulation RPC error:', simJson.error);
          throw new Error(simJson.error.message || 'Simulation RPC error');
        }

        const simValue = simJson.result?.value;
        if (simValue?.err) {
          debugLog('[SIM] ❌ Simulation failed before wallet prompt:', simValue.err, simValue.logs);
          throw new Error(`Simulation failed: ${JSON.stringify(simValue.err)}`);
        }
        debugLog('[SIM] ✅ Pre-simulation passed, units:', simValue?.unitsConsumed);
      } catch (simErr: any) {
        debugLog('[SIM] Pre-simulation error details:', {
          message: simErr?.message || String(simErr),
          stack: simErr?.stack,
          name: simErr?.name,
          cause: simErr?.cause,
        });
        debugLog('[SIM] Pre-simulation error, aborting before wallet prompt');
        throw simErr;
      }

      // Sign with position NFT mint first (only for new positions)
      if (positionNftMint) {
        depositTx.partialSign(positionNftMint);
      }

      debugLog('📡 Requesting wallet signature...');

      // Let wallet populate blockhash/lastValidBlockHeight and send
      debugLog('📡 Sending transaction via wallet.sendTransaction...');
      if (!params.wallet?.sendTransaction) {
        throw new Error('Wallet does not support sendTransaction');
      }
      const depositSig = await params.wallet.sendTransaction(depositTx, this.connection);

      debugLog('✅ Deposit transaction sent:', depositSig);
      if (positionNftMint) {
        debugLog('   New Position NFT:', positionNftMint.publicKey.toBase58());
      } else {
        debugLog('   Added to existing position');
      }

      const totalTime = Date.now() - startTime;
      debugLog(`⏱️ [ADD-LIQ TIMING] ✅ Total add liquidity time: ${totalTime}ms`);

      return depositSig;

    } catch (error) {
      debugError('❌ Failed to add liquidity:', error);
      throw error;
    }
  }

  /**
   * Remove liquidity from a Meteora pool
   * Based on remove-liquidity-WORKING.js script
   */
  async removeLiquidity(params: RemoveLiquidityParams): Promise<string> {
    await this.initializeCpAmm();
    if (!this.cpAmm) throw new Error('CP-AMM not initialized');

    debugLog('🌊 Removing liquidity from Meteora pool:', params.poolAddress);

    try {
      const poolPubkey = new PublicKey(params.poolAddress);

      // Step 1: Ensure wSOL account exists (required for receiving SOL)
      const wsolAta = await getAssociatedTokenAddress(
        NATIVE_MINT,
        params.wallet.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      const wsolInfo = await this.connection.getAccountInfo(wsolAta);

      if (!wsolInfo) {
        debugLog('⚠️  Creating wSOL account for receiving liquidity...');
        const createWsolTx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            params.wallet.publicKey,
            wsolAta,
            params.wallet.publicKey,
            NATIVE_MINT,
            TOKEN_PROGRAM_ID
          )
        );

        createWsolTx.feePayer = params.wallet.publicKey;

        // ⚡ OPTIMIZATION: Use server-side cached blockhash
        debugLog('⚡ Fetching blockhash from cache...');
        const tBlockhash = Date.now();
        let blockhash: string;
        try {
          const response = await fetch('/api/blockhash');
          const data = await response.json();
          blockhash = data.blockhash || (await this.connection.getLatestBlockhash()).blockhash;
          debugLog(`⏱️ [REMOVE-LIQ TIMING] blockhash took: ${Date.now() - tBlockhash}ms (cached: ${data.cached})`);
        } catch {
          blockhash = (await this.connection.getLatestBlockhash()).blockhash;
          debugLog(`⏱️ [REMOVE-LIQ TIMING] blockhash took: ${Date.now() - tBlockhash}ms (RPC fallback)`);
        }
        createWsolTx.recentBlockhash = blockhash;

        // Use wallet's sendTransaction to properly handle signing and sending
        let sig: string;
        if (params.wallet.sendTransaction) {
          sig = await params.wallet.sendTransaction(createWsolTx, this.connection);
        } else {
          const signedTx = await params.wallet.signTransaction(createWsolTx);
          sig = await this.connection.sendRawTransaction(signedTx.serialize());
        }

        // Don't wait for confirmation - let it process in background
        debugLog('✅ Sent wSOL account creation tx:', sig);
        debugLog('   (Processing in background)...');

        // Wait a bit for transaction to propagate
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // Step 2: Get user positions
      const poolState = await this.cpAmm.fetchPoolState(poolPubkey);
      const userPositions = await this.cpAmm.getUserPositionByPool(poolPubkey, params.wallet.publicKey);

      if (userPositions.length === 0) {
        throw new Error('No positions found in this pool');
      }

      const position = userPositions[0];
      debugLog('✅ Found position:', position.position.toBase58());

      const positionState = await this.cpAmm.fetchPositionState(position.position);
      debugLog('   Unlocked liquidity:', positionState.unlockedLiquidity.toString());

      // Step 3: Get vestings (if any)
      let vestings: any[] = [];
      try {
        vestings = await this.cpAmm.getAllVestingsByPosition(position.position);
      } catch (e) {
        vestings = [];
      }

      // Step 4: Build remove liquidity transaction
      // Detect token programs by querying the mint accounts
      const [tokenAProgram, tokenBProgram] = await Promise.all([
        detectTokenProgram(this.connection, poolState.tokenAMint),
        detectTokenProgram(this.connection, poolState.tokenBMint)
      ]);

      const removeParams = {
        owner: params.wallet.publicKey,
        pool: poolPubkey,
        position: position.position,
        positionNftAccount: position.positionNftAccount,
        tokenAAmountThreshold: new BN(0),
        tokenBAmountThreshold: new BN(0),
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAProgram,
        tokenBProgram,
        vestings: vestings.length > 0 ? vestings.map(v => ({ account: v.publicKey })) : []
      };

      debugLog('🔨 Building remove liquidity transaction...');

      // SDK returns Transaction directly, not TxBuilder
      const removeTx = await this.cpAmm.removeAllLiquidity(removeParams);

      debugLog('✅ SDK returned Transaction with', removeTx.instructions.length, 'instructions');

      // Add compute budget
      removeTx.instructions.unshift(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2000 })
      );

      removeTx.feePayer = params.wallet.publicKey;
      removeTx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

      // Sign and send using wallet's sendTransaction
      let sig: string;
      if (params.wallet.sendTransaction) {
        sig = await params.wallet.sendTransaction(removeTx, this.connection);
      } else {
        const signedTx = await params.wallet.signTransaction(removeTx);
        sig = await this.connection.sendRawTransaction(signedTx.serialize(), {
          skipPreflight: false,
          maxRetries: 3
        });
      }

      debugLog('📡 Sent remove liquidity transaction:', sig);
      debugLog('   (Processing in background)...');

      debugLog('✅ Liquidity removed successfully!');
      return sig;

    } catch (error) {
      debugError('❌ Failed to remove liquidity:', error);
      throw error;
    }
  }

  /**
   * Remove specific liquidity positions from a pool
   */
  async removeSpecificPositions(params: {
    poolAddress: string;
    positionAddresses: string[]; // Array of position addresses to remove
    wallet: {
      publicKey: PublicKey;
      signTransaction: (transaction: Transaction) => Promise<Transaction>;
      sendTransaction?: (transaction: Transaction, connection: Connection) => Promise<string>;
    };
    connection: Connection;
  }): Promise<string[]> {
    await this.initializeCpAmm();
    if (!this.cpAmm) throw new Error('Failed to initialize CpAmm');

    const signatures: string[] = [];
    const poolPubkey = new PublicKey(params.poolAddress);

    try {
      debugLog('🌊 Removing specific positions from pool...');
      debugLog(`   Pool: ${params.poolAddress}`);
      debugLog(`   Positions to remove: ${params.positionAddresses.length}`);

      // Fetch pool state once
      const poolState = await this.cpAmm.fetchPoolState(poolPubkey);

      // Detect token programs by querying the mint accounts
      const [tokenAProgram, tokenBProgram] = await Promise.all([
        detectTokenProgram(this.connection, poolState.tokenAMint),
        detectTokenProgram(this.connection, poolState.tokenBMint)
      ]);

      // Get all user positions
      const allPositions = await this.cpAmm.getUserPositionByPool(poolPubkey, params.wallet.publicKey);

      // Filter to only the positions we want to remove
      const positionsToRemove = allPositions.filter((pos: any) =>
        params.positionAddresses.includes(pos.position.toBase58())
      );

      if (positionsToRemove.length === 0) {
        throw new Error('None of the specified positions were found');
      }

      debugLog(`✅ Found ${positionsToRemove.length} positions to remove`);

      // Remove each position
      for (const position of positionsToRemove) {
        debugLog(`\n🔄 Removing position ${position.position.toBase58()}...`);

        const positionState = await this.cpAmm.fetchPositionState(position.position);
        debugLog('   Unlocked liquidity:', positionState.unlockedLiquidity.toString());

        // Get vestings (if any)
        let vestings: any[] = [];
        try {
          vestings = await this.cpAmm.getAllVestingsByPosition(position.position);
        } catch (e) {
          vestings = [];
        }

        // Build remove liquidity transaction
        const removeParams = {
          owner: params.wallet.publicKey,
          pool: poolPubkey,
          position: position.position,
          positionNftAccount: position.positionNftAccount,
          tokenAAmountThreshold: new BN(0),
          tokenBAmountThreshold: new BN(0),
          tokenAMint: poolState.tokenAMint,
          tokenBMint: poolState.tokenBMint,
          tokenAVault: poolState.tokenAVault,
          tokenBVault: poolState.tokenBVault,
          tokenAProgram,
          tokenBProgram,
          vestings: vestings.length > 0 ? vestings.map(v => ({ account: v.publicKey })) : []
        };

        debugLog('🔨 Building remove liquidity transaction...');

        const removeTx = await this.cpAmm.removeAllLiquidity(removeParams);

        debugLog('✅ SDK returned Transaction with', removeTx.instructions.length, 'instructions');

        // Add compute budget
        removeTx.instructions.unshift(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2000 })
        );

        removeTx.feePayer = params.wallet.publicKey;
        removeTx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

        // Sign and send using wallet's sendTransaction
        let sig: string;
        if (params.wallet.sendTransaction) {
          sig = await params.wallet.sendTransaction(removeTx, this.connection);
        } else {
          const signedTx = await params.wallet.signTransaction(removeTx);
          sig = await this.connection.sendRawTransaction(signedTx.serialize(), {
            skipPreflight: false,
            maxRetries: 3
          });
        }

        debugLog('✅ Position removed! Signature:', sig);
        signatures.push(sig);
      }

      debugLog(`\n✅ All ${signatures.length} positions removed successfully!`);
      return signatures;

    } catch (error) {
      debugError('❌ Failed to remove positions:', error);
      throw error;
    }
  }

  /**
   * Remove a percentage of total liquidity from user's positions
   */
  async removeLiquidityByPercentage(params: {
    poolAddress: string;
    percentage: number; // 0-100
    wallet: {
      publicKey: PublicKey;
      signTransaction: (transaction: Transaction) => Promise<Transaction>;
      sendTransaction?: (transaction: Transaction, connection: Connection) => Promise<string>;
    };
    connection: Connection;
  }): Promise<{ signatures: string[]; removedLiquidity: string; withdrawnTokenA: number; withdrawnTokenB: number }> {
    await this.initializeCpAmm();
    if (!this.cpAmm) throw new Error('Failed to initialize CpAmm');

    if (params.percentage < 0 || params.percentage > 100) {
      throw new Error('Percentage must be between 0 and 100');
    }

    const signatures: string[] = [];
    const poolPubkey = new PublicKey(params.poolAddress);

    try {
      debugLog('🌊 Removing liquidity by percentage...');
      debugLog(`   Pool: ${params.poolAddress}`);
      debugLog(`   Percentage: ${params.percentage}%`);

      // Step 1: Fetch pool state and all user positions
      const poolState = await this.cpAmm.fetchPoolState(poolPubkey);

      debugLog(`\n🏊 Pool State Debug:`);
      debugLog(`   tokenAMint: ${poolState.tokenAMint.toBase58()}`);
      debugLog(`   tokenBMint: ${poolState.tokenBMint.toBase58()}`);
      debugLog(`   tokenAVault: ${poolState.tokenAVault.toBase58()}`);
      debugLog(`   tokenBVault: ${poolState.tokenBVault.toBase58()}`);
      debugLog(`   liquidity: ${poolState.liquidity.toString()}`);
      debugLog(`   sqrtPrice: ${poolState.sqrtPrice.toString()}`);
      debugLog(`   sqrtMinPrice: ${poolState.sqrtMinPrice.toString()}`);
      debugLog(`   sqrtMaxPrice: ${poolState.sqrtMaxPrice.toString()}`);

      // Get vault balances
      try {
        const [vaultABalance, vaultBBalance] = await Promise.all([
          this.connection.getTokenAccountBalance(poolState.tokenAVault),
          this.connection.getTokenAccountBalance(poolState.tokenBVault)
        ]);
        debugLog(`   Vault A balance: ${vaultABalance.value.uiAmount} (raw: ${vaultABalance.value.amount})`);
        debugLog(`   Vault B balance: ${vaultBBalance.value.uiAmount} (raw: ${vaultBBalance.value.amount})`);
      } catch (e) {
        debugLog(`   ⚠️ Could not fetch vault balances: ${e}`);
      }

      // Detect token programs by querying the mint accounts
      const [tokenAProgram, tokenBProgram] = await Promise.all([
        detectTokenProgram(this.connection, poolState.tokenAMint),
        detectTokenProgram(this.connection, poolState.tokenBMint)
      ]);

      const allPositions = await this.cpAmm.getUserPositionByPool(poolPubkey, params.wallet.publicKey);

      if (allPositions.length === 0) {
        throw new Error('No positions found in this pool');
      }

      // Step 2: Calculate total liquidity and target amount to remove
      let totalLiquidity = new BN(0);
      const positionsWithLiquidity = [];

      for (const pos of allPositions) {
        const positionState = await this.cpAmm.fetchPositionState(pos.position);
        debugLog(`\n📊 Position ${pos.position.toBase58().slice(0, 8)}... state:`);
        debugLog(`   unlockedLiquidity: ${positionState.unlockedLiquidity.toString()}`);
        debugLog(`   vestedLiquidity: ${positionState.vestedLiquidity?.toString() || '0'}`);
        debugLog(`   permanentLockedLiquidity: ${positionState.permanentLockedLiquidity?.toString() || '0'}`);
        debugLog(`   pool: ${positionState.pool.toBase58()}`);
        debugLog(`   nftMint: ${positionState.nftMint.toBase58()}`);
        totalLiquidity = totalLiquidity.add(positionState.unlockedLiquidity);
        positionsWithLiquidity.push({
          position: pos.position,
          positionNftAccount: pos.positionNftAccount,
          liquidity: positionState.unlockedLiquidity,
          positionState
        });
      }

      debugLog(`   Total liquidity: ${totalLiquidity.toString()}`);

      const targetToRemove = totalLiquidity.mul(new BN(params.percentage)).div(new BN(100));
      debugLog(`   Target to remove: ${targetToRemove.toString()} (${params.percentage}%)`);

      // Get user's token balances BEFORE removal - use correct program for Token-2022
      const { getAssociatedTokenAddress, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } = await import('@solana/spl-token');

      // Get ATAs with correct token programs
      const userTokenA = getAssociatedTokenAddressSync(
        poolState.tokenAMint,
        params.wallet.publicKey,
        false,
        tokenAProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const userTokenB = getAssociatedTokenAddressSync(
        poolState.tokenBMint,
        params.wallet.publicKey,
        false,
        tokenBProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      debugLog(`   User Token A ATA: ${userTokenA.toBase58()} (Program: ${tokenAProgram.toBase58().slice(0, 8)}...)`);
      debugLog(`   User Token B ATA: ${userTokenB.toBase58()} (Program: ${tokenBProgram.toBase58().slice(0, 8)}...)`);

      // Check if ATAs exist, create if needed
      const ataCreationInstructions: any[] = [];

      const tokenAAccountInfo = await this.connection.getAccountInfo(userTokenA);
      if (!tokenAAccountInfo) {
        debugLog(`   ⚠️ Token A ATA doesn't exist, will create it`);
        ataCreationInstructions.push(
          createAssociatedTokenAccountInstruction(
            params.wallet.publicKey,  // payer
            userTokenA,               // ata
            params.wallet.publicKey,  // owner
            poolState.tokenAMint,     // mint
            tokenAProgram,            // token program
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }

      const tokenBAccountInfo = await this.connection.getAccountInfo(userTokenB);
      if (!tokenBAccountInfo) {
        debugLog(`   ⚠️ Token B ATA doesn't exist, will create it`);
        ataCreationInstructions.push(
          createAssociatedTokenAccountInstruction(
            params.wallet.publicKey,
            userTokenB,
            params.wallet.publicKey,
            poolState.tokenBMint,
            tokenBProgram,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }

      const balanceABefore = await this.connection.getTokenAccountBalance(userTokenA).catch(() => ({ value: { uiAmount: 0 } }));
      const balanceBBefore = await this.connection.getTokenAccountBalance(userTokenB).catch(() => ({ value: { uiAmount: 0 } }));

      debugLog(`\n💰 User balances BEFORE:`);
      debugLog(`   Token A: ${balanceABefore.value.uiAmount}`);
      debugLog(`   Token B: ${balanceBBefore.value.uiAmount}`);

      let remainingToRemove = targetToRemove;

      // Step 3: Remove liquidity from positions until we reach the target
      for (const posData of positionsWithLiquidity) {
        if (remainingToRemove.isZero()) break;

        const positionLiquidity = posData.liquidity;

        // Decide whether to remove all or partial
        const shouldRemoveAll = positionLiquidity.lte(remainingToRemove);
        const amountToRemove = shouldRemoveAll ? positionLiquidity : remainingToRemove;

        debugLog(`\n🔄 Processing position ${posData.position.toBase58()}...`);
        debugLog(`   Position liquidity: ${positionLiquidity.toString()}`);
        debugLog(`   Will remove: ${amountToRemove.toString()} (${shouldRemoveAll ? 'ALL' : 'PARTIAL'})`);

        // Calculate expected withdrawal amounts using SDK quote
        try {
          const withdrawQuote = (this.cpAmm as any).getWithdrawQuote({
            liquidityDelta: amountToRemove,
            sqrtPrice: poolState.sqrtPrice,
            minSqrtPrice: poolState.sqrtMinPrice,
            maxSqrtPrice: poolState.sqrtMaxPrice
          });
          debugLog(`   📈 Withdraw Quote:`);
          debugLog(`      Expected Token A: ${withdrawQuote.outAmountA.toString()} raw units`);
          debugLog(`      Expected Token B: ${withdrawQuote.outAmountB.toString()} raw units`);
        } catch (e) {
          debugLog(`   ⚠️ Could not calculate withdraw quote: ${e}`);
        }

        // Get vestings
        let vestings: any[] = [];
        try {
          vestings = await this.cpAmm.getAllVestingsByPosition(posData.position);
        } catch (e) {
          vestings = [];
        }

        const baseParams = {
          owner: params.wallet.publicKey,
          pool: poolPubkey,
          position: posData.position,
          positionNftAccount: posData.positionNftAccount,
          tokenAAmountThreshold: new BN(0),
          tokenBAmountThreshold: new BN(0),
          tokenAMint: poolState.tokenAMint,
          tokenBMint: poolState.tokenBMint,
          tokenAVault: poolState.tokenAVault,
          tokenBVault: poolState.tokenBVault,
          tokenAProgram,
          tokenBProgram,
          vestings: vestings.length > 0 ? vestings.map(v => ({ account: v.publicKey })) : []
        };

        let removeTx: Transaction;

        if (shouldRemoveAll) {
          // Remove all liquidity from this position
          removeTx = await this.cpAmm.removeAllLiquidity(baseParams);
          debugLog('   Using removeAllLiquidity');
        } else {
          // Remove partial liquidity from this position
          removeTx = await this.cpAmm.removeLiquidity({
            ...baseParams,
            liquidityDelta: amountToRemove
          });
          debugLog('   Using removeLiquidity with liquidityDelta:', amountToRemove.toString());
        }

        debugLog('✅ Transaction built with', removeTx.instructions.length, 'instructions');

        // Debug: Log all instruction accounts
        debugLog('\n📋 Transaction Instructions Debug:');
        removeTx.instructions.forEach((ix, idx) => {
          debugLog(`   Instruction ${idx}: Program ${ix.programId.toBase58().slice(0, 8)}...`);
          debugLog(`   Keys (${ix.keys.length}):`);
          ix.keys.forEach((key, keyIdx) => {
            debugLog(`     [${keyIdx}] ${key.pubkey.toBase58()} (write: ${key.isWritable}, sign: ${key.isSigner})`);
          });
          // Log data length and first few bytes
          debugLog(`   Data length: ${ix.data.length} bytes`);
          if (ix.data.length > 0) {
            debugLog(`   Data (first 32 bytes): ${Buffer.from(ix.data.slice(0, 32)).toString('hex')}`);
          }
        });

        // Add ATA creation instructions if needed (only on first position)
        if (ataCreationInstructions.length > 0 && signatures.length === 0) {
          debugLog(`   Adding ${ataCreationInstructions.length} ATA creation instruction(s)`);
          removeTx.instructions.unshift(...ataCreationInstructions);
        }

        // Add compute budget
        removeTx.instructions.unshift(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }), // Increased for ATA creation
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 })
        );

        removeTx.feePayer = params.wallet.publicKey;
        removeTx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

        // Sign and send
        let sig: string;
        if (params.wallet.sendTransaction) {
          sig = await params.wallet.sendTransaction(removeTx, this.connection);
        } else {
          const signedTx = await params.wallet.signTransaction(removeTx);
          sig = await this.connection.sendRawTransaction(signedTx.serialize(), {
            skipPreflight: false,
            maxRetries: 3
          });
        }

        debugLog('✅ Position processed! Signature:', sig);
        signatures.push(sig);

        // Update remaining
        remainingToRemove = remainingToRemove.sub(amountToRemove);
      }

      const actualRemoved = targetToRemove.sub(remainingToRemove);
      debugLog(`\n✅ Removed ${actualRemoved.toString()} liquidity (${params.percentage}% of total)`);
      debugLog(`   Transactions: ${signatures.length}`);

      // Get user's token balances AFTER removal
      const balanceAAfter = await this.connection.getTokenAccountBalance(userTokenA).catch(() => ({ value: { uiAmount: 0 } }));
      const balanceBAfter = await this.connection.getTokenAccountBalance(userTokenB).catch(() => ({ value: { uiAmount: 0 } }));

      const withdrawnTokenA = (balanceAAfter.value.uiAmount || 0) - (balanceABefore.value.uiAmount || 0);
      const withdrawnTokenB = (balanceBAfter.value.uiAmount || 0) - (balanceBBefore.value.uiAmount || 0);

      debugLog(`\n💰 User balances AFTER:`);
      debugLog(`   Token A: ${balanceAAfter.value.uiAmount} (+${withdrawnTokenA})`);
      debugLog(`   Token B: ${balanceBAfter.value.uiAmount} (+${withdrawnTokenB})`);

      return {
        signatures,
        removedLiquidity: actualRemoved.toString(),
        withdrawnTokenA,
        withdrawnTokenB
      };

    } catch (error) {
      debugError('❌ Failed to remove liquidity by percentage:', error);
      throw error;
    }
  }

  /**
   * Get detailed position information including estimated token amounts
   */
  async getDetailedPositions(params: {
    poolAddress: string;
    userPublicKey: PublicKey | string;
  }): Promise<Array<{
    address: string;
    unlockedLiquidity: string;
    estimatedTokenA: number;
    estimatedTokenB: number;
    percentageOfTotal: number;
  }> | null> {
    await this.initializeCpAmm();
    if (!this.cpAmm) return null;

    try {
      const poolPubkey = new PublicKey(params.poolAddress);
      const userPubkey = typeof params.userPublicKey === 'string' ? new PublicKey(params.userPublicKey) : params.userPublicKey;

      // Get pool state with retry logic (handles newly created pools that haven't been indexed yet)
      const poolState = await fetchPoolStateWithRetry(this.cpAmm, poolPubkey);
      const allPositions = await this.cpAmm.getUserPositionByPool(poolPubkey, userPubkey);

      if (allPositions.length === 0) return null;

      // Get pool reserves
      const vaultABalance = await this.connection.getTokenAccountBalance(poolState.tokenAVault);
      const vaultBBalance = await this.connection.getTokenAccountBalance(poolState.tokenBVault);

      const reserveA = new BN(vaultABalance.value.amount);
      const reserveB = new BN(vaultBBalance.value.amount);

      // Get POOL's total liquidity (not just user's positions!)
      const poolTotalLiquidity = poolState.liquidity;

      // Calculate total user liquidity
      let totalUserLiquidity = new BN(0);
      const positionStates = [];

      for (const pos of allPositions) {
        const positionState = await this.cpAmm.fetchPositionState(pos.position);
        totalUserLiquidity = totalUserLiquidity.add(positionState.unlockedLiquidity);
        positionStates.push({ pos, state: positionState });
      }

      debugLog(`📊 Detailed positions for pool ${params.poolAddress}:`);
      debugLog(`   Pool total liquidity: ${poolTotalLiquidity.toString()}`);
      debugLog(`   Total user liquidity: ${totalUserLiquidity.toString()}`);
      debugLog(`   Pool reserves A: ${reserveA.toString()}`);
      debugLog(`   Pool reserves B: ${reserveB.toString()}`);

      const detailedPositions = [];

      for (const { pos, state } of positionStates) {
        const posLiquidity = state.unlockedLiquidity;

        // Calculate percentage of POOL's total liquidity (not just user's positions)
        const percentageOfPool = poolTotalLiquidity.isZero()
          ? 0
          : (posLiquidity.mul(new BN(10000)).div(poolTotalLiquidity).toNumber() / 100);

        // Use SDK's getWithdrawQuote for accurate estimates
        let tokenAAmount = 0;
        let tokenBAmount = 0;

        try {
          const withdrawQuote = (this.cpAmm as any).getWithdrawQuote({
            liquidityDelta: posLiquidity,
            sqrtPrice: poolState.sqrtPrice,
            minSqrtPrice: poolState.sqrtMinPrice,
            maxSqrtPrice: poolState.sqrtMaxPrice
          });
          tokenAAmount = parseFloat(withdrawQuote.outAmountA.toString()) / Math.pow(10, vaultABalance.value.decimals);
          tokenBAmount = parseFloat(withdrawQuote.outAmountB.toString()) / Math.pow(10, vaultBBalance.value.decimals);
        } catch (e) {
          // Fallback to proportional calculation if SDK quote fails
          const fraction = posLiquidity.mul(new BN(1000000)).div(poolTotalLiquidity);
          const estimatedA = reserveA.mul(fraction).div(new BN(1000000));
          const estimatedB = reserveB.mul(fraction).div(new BN(1000000));
          tokenAAmount = parseFloat(estimatedA.toString()) / Math.pow(10, vaultABalance.value.decimals);
          tokenBAmount = parseFloat(estimatedB.toString()) / Math.pow(10, vaultBBalance.value.decimals);
        }

        debugLog(`\n   Position ${pos.position.toBase58()}:`);
        debugLog(`     Liquidity: ${posLiquidity.toString()}`);
        debugLog(`     % of pool: ${percentageOfPool.toFixed(10)}%`);
        debugLog(`     Est. Token A: ${tokenAAmount.toFixed(9)}`);
        debugLog(`     Est. Token B: ${tokenBAmount.toFixed(9)}`);

        detailedPositions.push({
          address: pos.position.toBase58(),
          unlockedLiquidity: posLiquidity.toString(),
          estimatedTokenA: tokenAAmount,
          estimatedTokenB: tokenBAmount,
          percentageOfTotal: percentageOfPool
        });
      }

      return detailedPositions;
    } catch (error) {
      debugError('Failed to get detailed positions:', error);
      return null;
    }
  }

  /**
   * Estimate token amounts user will receive when removing liquidity by percentage
   * Uses actual pool state and position data for accurate estimates
   */
  async estimateWithdrawalByPercentage(params: {
    poolAddress: string;
    userPublicKey: PublicKey | string;
    percentage: number; // 0-100
  }): Promise<{ tokenA: number; tokenB: number; totalLiquidity: string; positionCount: number } | null> {
    await this.initializeCpAmm();
    if (!this.cpAmm) return null;

    try {
      const poolPubkey = new PublicKey(params.poolAddress);
      const userPubkey = typeof params.userPublicKey === 'string' ? new PublicKey(params.userPublicKey) : params.userPublicKey;

      // Check if pool account exists first to avoid "Invalid account discriminator" errors
      const poolAccountInfo = await this.connection.getAccountInfo(poolPubkey);
      if (!poolAccountInfo) {
        debugLog('Pool account does not exist, skipping withdrawal estimation');
        return null;
      }

      // Try to fetch pool state - if it fails with "Invalid account discriminator", it's likely a DLMM pool
      let poolState;
      try {
        poolState = await fetchPoolStateWithRetry(this.cpAmm, poolPubkey);
      } catch (error: any) {
        if (error?.message?.includes('Invalid account discriminator')) {
          debugLog('Pool is not a CP-AMM pool (likely DLMM), skipping withdrawal estimation');
          return null;
        }
        throw error;
      }

      // Get user positions and total liquidity
      const allPositions = await this.cpAmm.getUserPositionByPool(poolPubkey, userPubkey);
      if (allPositions.length === 0) return null;

      let totalUserLiquidity = new BN(0);
      for (const pos of allPositions) {
        const positionState = await this.cpAmm.fetchPositionState(pos.position);
        totalUserLiquidity = totalUserLiquidity.add(positionState.unlockedLiquidity);
      }

      // Calculate liquidity to remove
      const liquidityToRemove = totalUserLiquidity.mul(new BN(params.percentage)).div(new BN(100));

      debugLog(`Estimating withdrawal for ${params.percentage}%:`);
      debugLog(`  Pool total liquidity: ${poolState.liquidity.toString()}`);
      debugLog(`  Total user liquidity: ${totalUserLiquidity.toString()}`);
      debugLog(`  Liquidity to remove: ${liquidityToRemove.toString()}`);

      // Get the current pool reserves for fallback
      const vaultABalance = await this.connection.getTokenAccountBalance(poolState.tokenAVault);
      const vaultBBalance = await this.connection.getTokenAccountBalance(poolState.tokenBVault);

      debugLog(`  Pool reserves A: ${vaultABalance.value.amount}`);
      debugLog(`  Pool reserves B: ${vaultBBalance.value.amount}`);

      // Use SDK's getWithdrawQuote for accurate estimates
      let tokenAAmount = 0;
      let tokenBAmount = 0;

      try {
        const withdrawQuote = (this.cpAmm as any).getWithdrawQuote({
          liquidityDelta: liquidityToRemove,
          sqrtPrice: poolState.sqrtPrice,
          minSqrtPrice: poolState.sqrtMinPrice,
          maxSqrtPrice: poolState.sqrtMaxPrice
        });
        tokenAAmount = parseFloat(withdrawQuote.outAmountA.toString()) / Math.pow(10, vaultABalance.value.decimals);
        tokenBAmount = parseFloat(withdrawQuote.outAmountB.toString()) / Math.pow(10, vaultBBalance.value.decimals);
        debugLog(`  SDK Withdraw Quote - Token A: ${withdrawQuote.outAmountA.toString()}, Token B: ${withdrawQuote.outAmountB.toString()}`);
      } catch (e) {
        // Fallback: proportional calculation using pool's total liquidity
        const poolTotalLiquidity = poolState.liquidity;
        const reserveA = new BN(vaultABalance.value.amount);
        const reserveB = new BN(vaultBBalance.value.amount);
        const fraction = liquidityToRemove.mul(new BN(1000000)).div(poolTotalLiquidity);
        const estimatedTokenA = reserveA.mul(fraction).div(new BN(1000000));
        const estimatedTokenB = reserveB.mul(fraction).div(new BN(1000000));
        tokenAAmount = parseFloat(estimatedTokenA.toString()) / Math.pow(10, vaultABalance.value.decimals);
        tokenBAmount = parseFloat(estimatedTokenB.toString()) / Math.pow(10, vaultBBalance.value.decimals);
        debugLog(`  Fallback estimate - Token A: ${tokenAAmount}, Token B: ${tokenBAmount}`);
      }

      debugLog(`  Final Estimated Token A: ${tokenAAmount}`);
      debugLog(`  Final Estimated Token B: ${tokenBAmount}`);

      return {
        tokenA: tokenAAmount,
        tokenB: tokenBAmount,
        totalLiquidity: totalUserLiquidity.toString(),
        positionCount: allPositions.length
      };
    } catch (error) {
      debugError('Failed to estimate withdrawal:', error);
      return null;
    }
  }

  /**
   * Get user's liquidity positions for a pool
   */
  async getUserPositions(poolAddress: string, userPublicKey: PublicKey | string): Promise<LiquidityPosition[]> {
    await this.initializeCpAmm();
    if (!this.cpAmm) {
      console.log('[METEORA-POSITIONS] SDK not initialized');
      return [];
    }

    try {
      const poolPubkey = new PublicKey(poolAddress);
      // Ensure userPublicKey is a PublicKey object
      const userPubkey = typeof userPublicKey === 'string' ? new PublicKey(userPublicKey) : userPublicKey;

      console.log('[METEORA-POSITIONS] Fetching positions for:', {
        pool: poolAddress,
        user: userPubkey.toBase58()
      });

      const userPositions = await this.cpAmm.getUserPositionByPool(poolPubkey, userPubkey);

      console.log('[METEORA-POSITIONS] Found', userPositions?.length || 0, 'positions');

      const positions: LiquidityPosition[] = [];

      for (const pos of userPositions) {
        console.log('[METEORA-POSITIONS] Processing position:', pos.position.toBase58());
        const positionState = await this.cpAmm.fetchPositionState(pos.position);

        positions.push({
          address: pos.position.toBase58(),
          nftMint: positionState.nftMint.toBase58(),
          nftAccount: pos.positionNftAccount.toBase58(),
          unlockedLiquidity: positionState.unlockedLiquidity.toString(),
          poolAddress: poolAddress
        });
      }

      console.log('[METEORA-POSITIONS] Returning', positions.length, 'positions');
      return positions;

    } catch (error) {
      console.error('[METEORA-POSITIONS] Failed to get user positions:', error);
      debugError('Failed to get user positions:', error);
      return [];
    }
  }

  /**
   * Get user's liquidity positions across multiple pools
   */
  async getUserPositionsFromMultiplePools(poolAddresses: string[], userPublicKey: PublicKey | string): Promise<LiquidityPosition[]> {
    if (!poolAddresses || poolAddresses.length === 0) {
      return [];
    }

    console.log('[METEORA-MULTI-POOLS] Checking', poolAddresses.length, 'pool(s) for positions');

    // Fetch positions from all pools in parallel
    const positionPromises = poolAddresses.map(poolAddress =>
      this.getUserPositions(poolAddress, userPublicKey)
    );

    const positionArrays = await Promise.all(positionPromises);

    // Flatten the array of arrays into a single array
    const allPositions = positionArrays.flat();

    console.log('[METEORA-MULTI-POOLS] Total positions found across all pools:', allPositions.length);

    return allPositions;
  }

  /**
   * Get ALL user's CP-AMM positions across ALL pools, optionally filtered by rift token
   * This finds positions even if the pool isn't stored in the rift's meteoraPools array
   */
  async getAllUserPositionsForRift(userPublicKey: PublicKey | string, riftMint?: string): Promise<LiquidityPosition[]> {
    await this.initializeCpAmm();
    if (!this.cpAmm) return [];

    const userPubkey = typeof userPublicKey === 'string' ? new PublicKey(userPublicKey) : userPublicKey;

    try {
      console.log('[METEORA-ALL-POSITIONS] Fetching ALL user positions using SDK getPositionsByUser...');

      // Use SDK's getPositionsByUser - gets all positions for user across all pools
      const userPositions = await this.cpAmm!.getPositionsByUser(userPubkey);
      console.log('[METEORA-ALL-POSITIONS] SDK returned', userPositions.length, 'positions');

      if (userPositions.length === 0) {
        console.log('[METEORA-ALL-POSITIONS] No positions found');
        return [];
      }

      // Convert to our format - filter by riftMint if provided
      const positions: LiquidityPosition[] = [];

      for (const pos of userPositions) {
        try {
          const poolAddress = pos.positionState.pool.toBase58();

          // If riftMint filter is provided, check if pool contains this token
          if (riftMint) {
            const poolState = await this.cpAmm!.fetchPoolState(pos.positionState.pool);
            const tokenAMint = poolState.tokenAMint.toBase58();
            const tokenBMint = poolState.tokenBMint.toBase58();

            // Skip if pool doesn't contain the rift token
            if (tokenAMint !== riftMint && tokenBMint !== riftMint) {
              continue;
            }
          }

          positions.push({
            address: pos.position.toBase58(),
            poolAddress: poolAddress,
            nftMint: pos.positionState.nftMint.toBase58(),
            nftAccount: pos.positionNftAccount.toBase58(),
            unlockedLiquidity: pos.positionState.unlockedLiquidity.toString()
          });

          console.log('[METEORA-ALL-POSITIONS] Found position in pool:', poolAddress);
        } catch (posErr) {
          console.log('[METEORA-ALL-POSITIONS] Error processing position:', posErr);
        }
      }

      console.log('[METEORA-ALL-POSITIONS] Returning', positions.length, 'positions for rift');
      return positions;

    } catch (error) {
      console.error('[METEORA-ALL-POSITIONS] Failed to get all positions:', error);
      return [];
    }
  }

  /**
   * Claim accumulated swap fees from CP-AMM positions
   */
  async claimPositionFees(params: {
    poolAddress: string;
    wallet: {
      publicKey: PublicKey;
      signTransaction: (transaction: Transaction) => Promise<Transaction>;
    };
    connection: Connection;
  }): Promise<{ signatures: string[]; claimedTokenA: number; claimedTokenB: number }> {
    await this.initializeCpAmm();
    if (!this.cpAmm) throw new Error('Failed to initialize CpAmm');

    const poolPubkey = new PublicKey(params.poolAddress);
    const signatures: string[] = [];
    let totalClaimedA = 0;
    let totalClaimedB = 0;

    try {
      debugLog('[CLAIM-FEE] Claiming position fees from pool:', params.poolAddress);

      // Step 1: Fetch pool state and user positions
      const poolState = await this.cpAmm.fetchPoolState(poolPubkey);

      // Detect token programs by querying the mint accounts
      const [tokenAProgram, tokenBProgram] = await Promise.all([
        detectTokenProgram(this.connection, poolState.tokenAMint),
        detectTokenProgram(this.connection, poolState.tokenBMint)
      ]);

      const allPositions = await this.cpAmm.getUserPositionByPool(poolPubkey, params.wallet.publicKey);

      if (allPositions.length === 0) {
        throw new Error('No positions found in this pool');
      }

      debugLog(`[CLAIM-FEE] Found ${allPositions.length} position(s)`);

      // Step 2: Claim fees from each position
      for (const pos of allPositions) {
        try {
          const positionState = await this.cpAmm.fetchPositionState(pos.position);

          // Check if there are fees to claim
          const feeOwedA = positionState.feeAOwed || new BN(0);
          const feeOwedB = positionState.feeBOwed || new BN(0);

          if (feeOwedA.isZero() && feeOwedB.isZero()) {
            debugLog(`[CLAIM-FEE] Position ${pos.position.toBase58().slice(0, 8)}... has no fees to claim`);
            continue;
          }

          debugLog(`[CLAIM-FEE] Claiming from position ${pos.position.toBase58().slice(0, 8)}... (feeA: ${feeOwedA.toString()}, feeB: ${feeOwedB.toString()})`);

          // Build claim fee transaction (TxBuilder = Promise<Transaction>)
          const claimTx = await this.cpAmm.claimPositionFee({
            owner: params.wallet.publicKey,
            pool: poolPubkey,
            position: pos.position,
            positionNftAccount: pos.positionNftAccount,
            tokenAMint: poolState.tokenAMint,
            tokenBMint: poolState.tokenBMint,
            tokenAVault: poolState.tokenAVault,
            tokenBVault: poolState.tokenBVault,
            tokenAProgram,
            tokenBProgram
          });

          // Get latest blockhash and set fee payer
          const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
          claimTx.recentBlockhash = blockhash;
          claimTx.feePayer = params.wallet.publicKey;

          // Add compute budget
          claimTx.instructions.unshift(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })
          );

          // Sign and send
          const signedTx = await params.wallet.signTransaction(claimTx);
          const sig = await this.connection.sendRawTransaction(signedTx.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed'
          });

          await this.confirmTransactionPolling(sig);
          signatures.push(sig);

          // Track claimed amounts
          totalClaimedA += feeOwedA.toNumber() / 1e9;
          totalClaimedB += feeOwedB.toNumber() / 1e9;

          debugLog(`[CLAIM-FEE] Claimed fees, tx: ${sig}`);

        } catch (posError) {
          debugError(`[CLAIM-FEE] Error claiming from position:`, posError);
        }
      }

      if (signatures.length === 0) {
        throw new Error('No fees available to claim from any position');
      }

      debugLog(`[CLAIM-FEE] Successfully claimed from ${signatures.length} position(s)`);
      debugLog(`[CLAIM-FEE] Total claimed: ${totalClaimedA} Token A, ${totalClaimedB} Token B`);

      return {
        signatures,
        claimedTokenA: totalClaimedA,
        claimedTokenB: totalClaimedB
      };

    } catch (error) {
      debugError('[CLAIM-FEE] Failed to claim position fees:', error);
      throw error;
    }
  }

  /**
   * Get pending fees for all positions in a pool
   */
  async getPendingFees(params: {
    poolAddress: string;
    userPublicKey: PublicKey | string;
  }): Promise<{ tokenA: number; tokenB: number; hasClaimable: boolean }> {
    await this.initializeCpAmm();
    if (!this.cpAmm) throw new Error('Failed to initialize CpAmm');

    const poolPubkey = new PublicKey(params.poolAddress);
    const userPubkey = typeof params.userPublicKey === 'string'
      ? new PublicKey(params.userPublicKey)
      : params.userPublicKey;

    let totalFeeA = 0;
    let totalFeeB = 0;

    try {
      const allPositions = await this.cpAmm.getUserPositionByPool(poolPubkey, userPubkey);

      for (const pos of allPositions) {
        const positionState = await this.cpAmm.fetchPositionState(pos.position);

        const feeOwedA = positionState.feeAOwed || new BN(0);
        const feeOwedB = positionState.feeBOwed || new BN(0);

        totalFeeA += feeOwedA.toNumber() / 1e9;
        totalFeeB += feeOwedB.toNumber() / 1e9;
      }

      return {
        tokenA: totalFeeA,
        tokenB: totalFeeB,
        hasClaimable: totalFeeA > 0 || totalFeeB > 0
      };

    } catch (error) {
      debugError('[GET-FEES] Failed to get pending fees:', error);
      return { tokenA: 0, tokenB: 0, hasClaimable: false };
    }
  }

  /**
   * Create DAMM V2 (CP-AMM) pool with single-sided liquidity
   * Based on Meteora DAMM V2 documentation
   */
  async createDammV2Pool(params: {
    tokenAMint: PublicKey | string;
    tokenBMint: PublicKey | string;
    tokenAAmount: number; // Initial single-sided deposit amount
    initialPrice: number; // Initial price (tokenB per tokenA) - UNUSED for single-sided (must equal minPrice)
    minPrice?: number; // Minimum price for the range (defaults to absolute min)
    maxPrice?: number; // Maximum price for the range (defaults to absolute max)
    wallet: {
      publicKey: PublicKey;
      signTransaction: (tx: Transaction) => Promise<Transaction>;
      signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
    };
    connection: Connection;
  }): Promise<{
    poolAddress: string;
    positionAddress: string;
    signature: string;
  }> {
    await this.initializeCpAmm();
    if (!this.cpAmm) throw new Error('CP-AMM not initialized');

    try {
      debugLog('[DAMM-V2] 🚀 Creating DAMM V2 pool with single-sided liquidity...');

      const tokenAMintPubkey = typeof params.tokenAMint === 'string' ? new PublicKey(params.tokenAMint) : params.tokenAMint;
      const tokenBMintPubkey = typeof params.tokenBMint === 'string' ? new PublicKey(params.tokenBMint) : params.tokenBMint;

      // Detect token programs
      const tokenAProgram = await detectTokenProgram(params.connection, tokenAMintPubkey);
      const tokenBProgram = await detectTokenProgram(params.connection, tokenBMintPubkey);

      debugLog(`[DAMM-V2] Token A: ${tokenAMintPubkey.toBase58().slice(0, 8)}... (${tokenAProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL Token'})`);
      debugLog(`[DAMM-V2] Token B: ${tokenBMintPubkey.toBase58().slice(0, 8)}... (${tokenBProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL Token'})`);

      // Get token decimals
      const { getMint } = await import('@solana/spl-token');
      const tokenAMintInfo = await getMint(params.connection, tokenAMintPubkey, 'confirmed', tokenAProgram);
      const tokenBMintInfo = await getMint(params.connection, tokenBMintPubkey, 'confirmed', tokenBProgram);

      const tokenADecimals = tokenAMintInfo.decimals;
      const tokenBDecimals = tokenBMintInfo.decimals;

      debugLog(`[DAMM-V2] Token A decimals: ${tokenADecimals}, Token B decimals: ${tokenBDecimals}`);
      debugLog(`[DAMM-V2] Initial price: ${params.initialPrice} (Token B per Token A)`);
      debugLog(`[DAMM-V2] Single-sided deposit: ${params.tokenAAmount} Token A`);

      // Import helper functions from SDK
      const { getSqrtPriceFromPrice, derivePoolAddress, derivePositionAddress } = await import('@meteora-ag/cp-amm-sdk');

      // Use public Meteora config for DAMM V2
      // Config index 0: 0.25% base fee (2500000), dynamic fee enabled, collect fee mode 0
      const DAMM_V2_PUBLIC_CONFIG = new PublicKey('8CNy9goNQNLM4wtgRw528tUQGMKD3vSuFRZY2gLGLLvF');
      const configAddress = DAMM_V2_PUBLIC_CONFIG;

      // Calculate price range in sqrt format
      // Absolute min/max values for the entire AMM
      const ABSOLUTE_MIN_SQRT_PRICE = new BN('4295048016');
      const ABSOLUTE_MAX_SQRT_PRICE = new BN('79226673515401279992447579055');

      // Use custom range if provided, otherwise use full range
      let MIN_SQRT_PRICE: BN;
      let MAX_SQRT_PRICE: BN;

      if (params.minPrice) {
        MIN_SQRT_PRICE = getSqrtPriceFromPrice(
          params.minPrice.toString(),
          tokenADecimals,
          tokenBDecimals
        );
        debugLog(`[DAMM-V2] Custom min price: ${params.minPrice} → sqrt: ${MIN_SQRT_PRICE.toString()}`);
      } else {
        MIN_SQRT_PRICE = ABSOLUTE_MIN_SQRT_PRICE;
        debugLog(`[DAMM-V2] Using absolute minimum sqrt price: ${MIN_SQRT_PRICE.toString()}`);
      }

      if (params.maxPrice) {
        MAX_SQRT_PRICE = getSqrtPriceFromPrice(
          params.maxPrice.toString(),
          tokenADecimals,
          tokenBDecimals
        );
        debugLog(`[DAMM-V2] Custom max price: ${params.maxPrice} → sqrt: ${MAX_SQRT_PRICE.toString()}`);
      } else {
        MAX_SQRT_PRICE = ABSOLUTE_MAX_SQRT_PRICE;
        debugLog(`[DAMM-V2] Using absolute maximum sqrt price: ${MAX_SQRT_PRICE.toString()}`);
      }

      // For single-sided pools, initSqrtPrice MUST equal minSqrtPrice
      // This is a requirement from the Meteora SDK documentation
      const initSqrtPrice = MIN_SQRT_PRICE;

      debugLog(`[DAMM-V2] Using sqrt price for single-sided: ${initSqrtPrice.toString()}`);
      debugLog('[DAMM-V2] Note: Single-sided pools require initSqrtPrice = minSqrtPrice');

      // Get token amount in lamports
      const tokenAAmountLamports = new BN(Math.floor(params.tokenAAmount * Math.pow(10, tokenADecimals)));

      // For Token-2022, we need to provide the Mint object and current epoch
      // The SDK uses this for transfer fee calculations
      let tokenAInfo: { mint: any; currentEpoch: number } | undefined = undefined;
      if (tokenAProgram.equals(TOKEN_2022_PROGRAM_ID)) {
        debugLog('[DAMM-V2] Preparing Token-2022 info for transfer fee calculations...');
        // Use this.connection which is the proper Connection instance
        const currentEpoch = await this.connection.getEpochInfo();
        tokenAInfo = {
          mint: tokenAMintInfo, // The Mint object from getMint()
          currentEpoch: currentEpoch.epoch
        };
        debugLog(`[DAMM-V2] Current epoch: ${currentEpoch.epoch}`);
      }

      // Use preparePoolCreationSingleSide for single-sided pool initialization
      // This method is specifically designed for pools initialized with only one token
      const singleSideParams = {
        tokenAAmount: tokenAAmountLamports,
        initSqrtPrice: initSqrtPrice, // Must equal minSqrtPrice
        minSqrtPrice: MIN_SQRT_PRICE,
        maxSqrtPrice: MAX_SQRT_PRICE,
        // Include tokenAInfo if Token-2022 (required for transfer fee calculations)
        ...(tokenAInfo ? { tokenAInfo } : {})
      };

      debugLog('[DAMM-V2] Preparing single-sided pool creation...');
      debugLog('[DAMM-V2] Params:', JSON.stringify({
        tokenAAmount: tokenAAmountLamports.toString(),
        initSqrtPrice: initSqrtPrice.toString(),
        hasTokenAInfo: !!tokenAInfo,
        currentEpoch: tokenAInfo?.currentEpoch
      }));
      const liquidityDelta = (this.cpAmm as any).preparePoolCreationSingleSide(singleSideParams);

      debugLog(`[DAMM-V2] Single-sided preparation result:`);
      debugLog(`  - Token A amount (GROSS - user will send): ${tokenAAmountLamports.toString()}`);
      debugLog(`  - Liquidity delta: ${liquidityDelta.toString()}`);
      debugLog(`  - Init sqrt price: ${initSqrtPrice.toString()}`);

      // tokenAAmountLamports is the GROSS amount (what user sends)
      // The SDK's preparePoolCreationSingleSide with tokenAInfo already calculated liquidityDelta
      // based on the NET amount that will arrive in the pool
      let tokenAAmountIncludingFees = tokenAAmountLamports;
      if (tokenAProgram.equals(TOKEN_2022_PROGRAM_ID)) {
        const { calculateTransferFeeExcludedAmount } = await import('@meteora-ag/cp-amm-sdk');
        // Calculate NET amount for logging (what arrives in pool after fees)
        const feeResult = calculateTransferFeeExcludedAmount(
          tokenAAmountLamports,
          tokenAMintInfo,
          tokenAInfo!.currentEpoch
        );
        debugLog(`[DAMM-V2] Transfer fee details:`);
        debugLog(`  - Amount user will send (GROSS): ${tokenAAmountLamports.toString()}`);
        debugLog(`  - Transfer fee: ${feeResult.transferFee.toString()}`);
        debugLog(`  - Amount arriving in pool (NET): ${feeResult.amount.toString()}`);
        // tokenAAmountIncludingFees IS tokenAAmountLamports - user sends exactly what they specified
      }

      // Check user's Token A balance and adjust deposit amount if needed
      const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
      const userTokenAAccount = getAssociatedTokenAddressSync(
        tokenAMintPubkey,
        params.wallet.publicKey,
        false,
        tokenAProgram
      );

      let actualTokenAAmount = tokenAAmountLamports;
      let actualTokenAAmountIncludingFees = tokenAAmountIncludingFees;
      let adjustedLiquidityDelta = liquidityDelta;

      try {
        const tokenAccountInfo = await params.connection.getTokenAccountBalance(userTokenAAccount);
        const userBalance = new BN(tokenAccountInfo.value.amount);
        debugLog(`[DAMM-V2] User Token A balance: ${userBalance.toString()} (${tokenAccountInfo.value.uiAmount} tokens)`);
        debugLog(`[DAMM-V2] Requested Token A amount (including fees): ${tokenAAmountIncludingFees.toString()}`);

        // If user doesn't have enough, use their full balance
        if (userBalance.lt(tokenAAmountIncludingFees)) {
          debugLog(`[DAMM-V2] User balance insufficient for requested amount. Adjusting to use full balance...`);

          // For Token-2022 with transfer fees, the on-chain program calculates the transfer amount
          // from liquidityDelta, then uses transfer_checked which takes NET + fee from user.
          //
          // Strategy: Use user's full balance as GROSS, calculate correct NET that will arrive,
          // and calculate liquidityDelta from that NET (without passing tokenAInfo to avoid
          // SDK's quirky double-calculation)
          debugLog(`[DAMM-V2] Checking Token-2022: isToken2022=${tokenAProgram.equals(TOKEN_2022_PROGRAM_ID)}, hasTokenAInfo=${!!tokenAInfo}`);

          if (tokenAProgram.equals(TOKEN_2022_PROGRAM_ID) && tokenAInfo) {
            const { calculateTransferFeeExcludedAmount } = await import('@meteora-ag/cp-amm-sdk');

            // User will send their full balance (GROSS)
            // Calculate NET that arrives in pool after transfer fee
            const feeResult = calculateTransferFeeExcludedAmount(userBalance, tokenAMintInfo, tokenAInfo.currentEpoch);
            const netAmount = feeResult.amount;
            const feeAmount = feeResult.transferFee;

            debugLog(`[DAMM-V2] Token-2022 fee calculation:`);
            debugLog(`  - User balance (GROSS): ${userBalance.toString()}`);
            debugLog(`  - Transfer fee: ${feeAmount.toString()}`);
            debugLog(`  - Net arriving in pool: ${netAmount.toString()}`);

            actualTokenAAmount = netAmount;
            actualTokenAAmountIncludingFees = userBalance; // User's full balance as GROSS
          } else {
            // For SPL tokens without fees, GROSS = NET
            actualTokenAAmount = userBalance;
            actualTokenAAmountIncludingFees = userBalance;
            debugLog(`[DAMM-V2] Using user's full balance (no fee): ${actualTokenAAmount.toString()}`);
          }

          // Recalculate liquidity delta using the NET amount WITHOUT tokenAInfo
          // This ensures the liquidityDelta matches what the on-chain program expects:
          // The program will calculate transfer amount from liquidityDelta = NET amount needed,
          // then transfer_checked will pull NET + fee (= GROSS = user's full balance) from user
          const adjustedSingleSideParams = {
            tokenAAmount: actualTokenAAmount, // NET amount (what arrives in pool)
            initSqrtPrice: initSqrtPrice,
            minSqrtPrice: MIN_SQRT_PRICE,
            maxSqrtPrice: MAX_SQRT_PRICE
            // NOTE: Do NOT pass tokenAInfo here - we already calculated NET correctly
          };
          adjustedLiquidityDelta = (this.cpAmm as any).preparePoolCreationSingleSide(adjustedSingleSideParams);
          debugLog(`[DAMM-V2] Recalculated liquidity delta: ${adjustedLiquidityDelta.toString()}`);
          debugLog(`[DAMM-V2] tokenAAmount passed (NET): ${actualTokenAAmount.toString()}`);
          debugLog(`[DAMM-V2] actualTokenAAmountIncludingFees (GROSS): ${actualTokenAAmountIncludingFees.toString()}`);
        }
      } catch (err: any) {
        if (err.message?.includes('Insufficient token balance')) throw err;
        debugLog(`[DAMM-V2] Warning: Could not check token balance: ${err.message}`);
      }

      debugLog('[DAMM-V2] Creating SINGLE-SIDED pool (only Token A)');

      // Generate position NFT mint
      const positionNftMint = Keypair.generate();
      debugLog(`[DAMM-V2] Position NFT mint: ${positionNftMint.publicKey.toBase58()}`);

      // Create pool transaction
      debugLog('[DAMM-V2] Building createPool transaction...');

      // Log exactly what we're passing to the SDK
      const sdkParams = {
        payer: params.wallet.publicKey,
        creator: params.wallet.publicKey,
        config: configAddress,
        positionNft: positionNftMint.publicKey,
        tokenAMint: tokenAMintPubkey,
        tokenBMint: tokenBMintPubkey,
        activationPoint: null,
        tokenAAmount: actualTokenAAmountIncludingFees,
        tokenBAmount: new BN(0),
        initSqrtPrice: initSqrtPrice,
        liquidityDelta: adjustedLiquidityDelta,
        tokenAProgram,
        tokenBProgram
      };

      debugLog('[DAMM-V2] SDK createPool params:');
      debugLog(`  - tokenAAmount: ${sdkParams.tokenAAmount.toString()}`);
      debugLog(`  - tokenBAmount: ${sdkParams.tokenBAmount.toString()}`);
      debugLog(`  - liquidityDelta: ${sdkParams.liquidityDelta.toString()}`);
      debugLog(`  - initSqrtPrice: ${sdkParams.initSqrtPrice.toString()}`);
      debugLog(`  - tokenAProgram: ${sdkParams.tokenAProgram.toBase58()}`);
      debugLog(`  - tokenBProgram: ${sdkParams.tokenBProgram.toBase58()}`);

      // For single-sided deposit: provide only Token A, set Token B to 0
      const createPoolTxBuilder = await (this.cpAmm as any).createPool(sdkParams);

      debugLog('[DAMM-V2] TxBuilder created, checking type...');
      debugLog('[DAMM-V2] TxBuilder type:', typeof createPoolTxBuilder);
      debugLog('[DAMM-V2] TxBuilder keys:', Object.keys(createPoolTxBuilder));

      // The SDK returns a TxBuilder which has methods to get the transaction
      // Try different methods to get the transaction
      let tx: Transaction;
      if (typeof createPoolTxBuilder.build === 'function') {
        debugLog('[DAMM-V2] Using build() method...');
        tx = await createPoolTxBuilder.build();
      } else if (typeof createPoolTxBuilder.transaction === 'function') {
        debugLog('[DAMM-V2] Using transaction() method...');
        tx = await createPoolTxBuilder.transaction();
      } else if (createPoolTxBuilder instanceof Transaction) {
        debugLog('[DAMM-V2] Already a Transaction object...');
        tx = createPoolTxBuilder;
      } else {
        debugLog('[DAMM-V2] Unknown TxBuilder format, treating as transaction...');
        tx = createPoolTxBuilder as Transaction;
      }

      // Add compute budget
      tx.instructions.unshift(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })
      );

      // Set fee payer and recent blockhash
      tx.feePayer = params.wallet.publicKey;
      const latestBlockhash = await params.connection.getLatestBlockhash();
      tx.recentBlockhash = latestBlockhash.blockhash;

      // Debug: Log transaction instructions to see what SDK built
      debugLog(`[DAMM-V2] Transaction has ${tx.instructions.length} instructions:`);
      tx.instructions.forEach((ix, i) => {
        debugLog(`  [${i}] Program: ${ix.programId.toBase58().slice(0, 8)}... Keys: ${ix.keys.length}, Data: ${ix.data.length} bytes`);
        // Check if it's a Token-2022 transfer instruction
        if (ix.programId.toBase58() === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') {
          debugLog(`    ^ Token-2022 instruction, data hex: ${Buffer.from(ix.data).toString('hex').slice(0, 40)}...`);
          // TransferChecked instruction: byte 0 = 12 (instruction type), bytes 1-8 = amount (u64 LE)
          if (ix.data[0] === 12 && ix.data.length >= 9) {
            const amount = Buffer.from(ix.data.slice(1, 9)).readBigUInt64LE();
            debugLog(`    ^ TransferChecked amount: ${amount.toString()}`);
          }
        }
      });

      debugLog('[DAMM-V2] Signing and sending transaction...');

      // Sign with position NFT keypair and wallet
      tx.partialSign(positionNftMint);
      const signedTx = await params.wallet.signTransaction(tx);

      const signature = await params.connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
        maxRetries: 3
      });

      debugLog(`[DAMM-V2] Transaction sent: ${signature}`);
      debugLog('[DAMM-V2] Confirming transaction...');

      // Use polling instead of WebSocket to avoid CSP/proxy issues
      await this.confirmTransactionPolling(signature);

      debugLog(`[DAMM-V2] ✅ Pool created successfully!`);

      // Derive pool address
      const poolAddress = derivePoolAddress(
        configAddress,
        tokenAMintPubkey,
        tokenBMintPubkey
      );

      // Derive position address using SDK function
      const positionAddress = derivePositionAddress(positionNftMint.publicKey);

      debugLog(`[DAMM-V2] Pool address: ${poolAddress.toBase58()}`);
      debugLog(`[DAMM-V2] Position address: ${positionAddress.toBase58()}`);

      return {
        poolAddress: poolAddress.toBase58(),
        positionAddress: positionAddress.toBase58(),
        signature
      };

    } catch (error) {
      debugError('[DAMM-V2] Failed to create pool:', error);
      throw error;
    }
  }
}

// Export singleton
const meteoraEndpoint =
  typeof window !== 'undefined'
    ? `${window.location.origin}/api/rpc-http`
    : require('./rpc-endpoints').getHeliusHttpRpcUrl();

export const meteoraLiquidityService = new MeteoraLiquidityService(
  new Connection(meteoraEndpoint, 'confirmed')
);
