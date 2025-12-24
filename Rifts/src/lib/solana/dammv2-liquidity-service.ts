/**
 * DAMMV2 (CP-AMM) Liquidity Service
 * Enables single-sided full-range liquidity positions on Meteora DAMMV2
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import BN from 'bn.js';
import { debugLog, debugError } from '@/utils/debug';

// DAMMV2 (CP-AMM) Program ID
const CP_AMM_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');

export interface DAMMV2AddLiquidityParams {
  poolAddress?: string; // If exists, add to existing pool
  // For new pool creation
  tokenAMint: string;   // Base token (usually the rift token)
  tokenBMint: string;   // Quote token (usually SOL/WSOL)
  // Liquidity params
  tokenAAmount: number; // Amount of token A to add (for single-sided, this is the only amount)
  tokenBAmount?: number; // Amount of token B (0 for single-sided)
  // Price params
  initialPrice: number; // Price of token A in terms of token B (e.g., 0.001 SOL per token)
  maxPrice?: number;    // Optional max price for concentrated liquidity (omit for full range to infinity)
  // Fee params
  feeBps?: number;      // Fee in basis points (default: 25 = 0.25%)
  // Wallet
  wallet: {
    publicKey: PublicKey;
    signTransaction: (tx: Transaction) => Promise<Transaction>;
    signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
    sendTransaction?: (tx: Transaction, connection: Connection) => Promise<string>;
  };
  connection: Connection;
  // Progress callback
  onProgress?: (step: number, message: string) => void;
}

export interface DAMMV2PoolInfo {
  address: string;
  tokenAMint: string;
  tokenBMint: string;
  sqrtPrice: string;
  currentPrice: number;
  feeBps: number;
  tokenAVault: string;
  tokenBVault: string;
}

export interface DAMMV2Position {
  address: string;
  poolAddress: string;
  nftMint: string;
  liquidity: string;
  tokenAAmount: number;
  tokenBAmount: number;
}

export class DAMMV2LiquidityService {
  private connection: Connection;
  private cpAmmSdk: any = null;

  constructor(connection: Connection) {
    this.connection = this.createConnection(connection);
  }

  /**
   * Create a connection suitable for DAMMV2 operations
   */
  private createConnection(fallbackConnection: Connection): Connection {
    if (typeof window !== 'undefined') {
      const { createProxiedConnection } = require('@/lib/solana/rpc-client');
      return createProxiedConnection();
    }
    return fallbackConnection;
  }

  /**
   * Update the connection
   */
  updateConnection(newConnection: Connection): void {
    this.connection = this.createConnection(newConnection);
  }

  /**
   * Initialize the CP-AMM SDK
   */
  private async initSdk(): Promise<void> {
    if (!this.cpAmmSdk) {
      const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
      this.cpAmmSdk = new CpAmm(this.connection);
    }
  }

  /**
   * Detect which token program a mint uses
   */
  private async detectTokenProgram(mint: PublicKey): Promise<PublicKey> {
    try {
      const accountInfo = await this.connection.getAccountInfo(mint);
      if (!accountInfo) {
        debugLog(`[DAMMV2] Could not find mint account, defaulting to TOKEN_2022`);
        return TOKEN_2022_PROGRAM_ID;
      }

      const owner = accountInfo.owner;
      if (owner.equals(TOKEN_PROGRAM_ID)) {
        return TOKEN_PROGRAM_ID;
      } else if (owner.equals(TOKEN_2022_PROGRAM_ID)) {
        return TOKEN_2022_PROGRAM_ID;
      }
      return TOKEN_2022_PROGRAM_ID;
    } catch (error) {
      debugError(`[DAMMV2] Failed to detect token program:`, error);
      return TOKEN_2022_PROGRAM_ID;
    }
  }

  /**
   * Confirm transaction using polling
   */
  private async confirmTransactionPolling(signature: string, maxRetries = 30): Promise<void> {
    debugLog('[DAMMV2] Confirming tx via polling:', signature.slice(0, 20) + '...');

    for (let i = 0; i < maxRetries; i++) {
      try {
        const status = await this.connection.getSignatureStatus(signature);

        // Check for error FIRST before checking confirmation status
        if (status?.value?.err) {
          const errorStr = JSON.stringify(status.value.err);
          debugError('[DAMMV2] Transaction failed with error:', errorStr);

          // Parse common errors for better messages
          if (errorStr.includes('InstructionError') && errorStr.includes('Custom')) {
            // Try to get more details from the transaction
            try {
              const tx = await this.connection.getTransaction(signature, {
                maxSupportedTransactionVersion: 0,
              });
              if (tx?.meta?.logMessages) {
                const errorLogs = tx.meta.logMessages.filter(log =>
                  log.toLowerCase().includes('error') ||
                  log.toLowerCase().includes('failed') ||
                  log.toLowerCase().includes('insufficient')
                );
                if (errorLogs.length > 0) {
                  throw new Error(`Transaction failed: ${errorLogs.join(', ')}`);
                }
              }
            } catch (e) {
              // Ignore fetch errors, use original error
            }
          }

          throw new Error(`Transaction failed: ${errorStr}`);
        }

        if (status?.value?.confirmationStatus === 'confirmed' ||
            status?.value?.confirmationStatus === 'finalized') {
          debugLog('[DAMMV2] Transaction confirmed:', status.value.confirmationStatus);
          return;
        }
      } catch (error: any) {
        if (error.message?.includes('Transaction failed')) {
          throw error;
        }
        // Other errors (network, etc) - continue retrying
        debugLog('[DAMMV2] Polling error (retrying):', error.message);
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new Error('Transaction confirmation timeout');
  }

  /**
   * Create a new DAMMV2 pool with single-sided liquidity (full range)
   */
  async createPoolWithSingleSidedLiquidity(
    params: DAMMV2AddLiquidityParams
  ): Promise<{ poolAddress: string; positionNft: string; signature: string }> {
    const {
      tokenAMint,
      tokenBMint,
      tokenAAmount,
      initialPrice,
      maxPrice, // Optional max price for concentrated liquidity
      feeBps = 25, // 0.25% default
      wallet,
      onProgress,
    } = params;

    await this.initSdk();

    const tokenA = new PublicKey(tokenAMint);
    const tokenB = new PublicKey(tokenBMint);

    debugLog('[DAMMV2] Creating pool with single-sided liquidity:', {
      tokenA: tokenAMint,
      tokenB: tokenBMint,
      tokenAAmount,
      tokenAAmountType: typeof tokenAAmount,
      initialPrice,
      feeBps,
    });

    // Validate tokenAAmount
    if (tokenAAmount <= 0 || isNaN(tokenAAmount)) {
      throw new Error(`Invalid tokenAAmount: ${tokenAAmount}. Must be a positive number.`);
    }

    onProgress?.(1, 'Preparing pool creation...');

    try {
      // Import SDK helpers
      const {
        CpAmm,
        MIN_SQRT_PRICE,
        MAX_SQRT_PRICE,
        getSqrtPriceFromPrice,
        getLiquidityDeltaFromAmountA,
        deriveCustomizablePoolAddress,
        ActivationType,
        CollectFeeMode,
        bpsToFeeNumerator,
      } = await import('@meteora-ag/cp-amm-sdk');

      // Get token programs and mint info
      const { getMint, getAssociatedTokenAddress, getAccount } = await import('@solana/spl-token');
      const tokenAProgram = await this.detectTokenProgram(tokenA);
      const tokenBProgram = await this.detectTokenProgram(tokenB);

      let tokenADecimals = 9;
      let tokenBDecimals = 9;
      let mintAInfo: Awaited<ReturnType<typeof getMint>> | null = null;

      try {
        mintAInfo = await getMint(this.connection, tokenA, 'confirmed', tokenAProgram);
        const mintBInfo = await getMint(this.connection, tokenB, 'confirmed', tokenBProgram);

        tokenADecimals = mintAInfo.decimals;
        tokenBDecimals = mintBInfo.decimals;
      } catch (e) {
        debugLog('[DAMMV2] Could not fetch decimals, using default 9');
      }

      // Check user's token A balance and use actual balance for pool creation
      // (Transfer fees mean user receives less than they wrapped)
      let actualTokenAAmount = tokenAAmount;
      try {
        const userTokenAAccount = await getAssociatedTokenAddress(
          tokenA,
          wallet.publicKey,
          false,
          tokenAProgram
        );
        const tokenAAccountInfo = await getAccount(this.connection, userTokenAAccount, 'confirmed', tokenAProgram);
        const userBalanceLamports = Number(tokenAAccountInfo.amount);
        const userBalance = userBalanceLamports / Math.pow(10, tokenADecimals);

        debugLog('[DAMMV2] User token A balance:', {
          account: userTokenAAccount.toBase58(),
          balanceLamports: userBalanceLamports,
          balance: userBalance,
          requiredAmount: tokenAAmount,
        });

        // If user has less than requested (due to transfer fees), use actual balance
        // This handles Token-2022 tokens with transfer fees
        if (userBalance < tokenAAmount) {
          debugLog('[DAMMV2] User has less than requested (likely due to transfer fees). Using actual balance:', userBalance);
          actualTokenAAmount = userBalance;
        }

        // Final check: ensure user has enough tokens
        if (actualTokenAAmount <= 0) {
          throw new Error(`No token balance found. Please ensure your tokens have been wrapped first.`);
        }
      } catch (balanceError: any) {
        if (balanceError.message?.includes('No token balance')) {
          throw balanceError;
        }
        // Account might not exist yet
        debugLog('[DAMMV2] Could not fetch token A balance (account may not exist):', balanceError.message);
        throw new Error(`Token account not found. Please ensure you have wrapped tokens (${tokenAMint}) in your wallet.`);
      }

      debugLog('[DAMMV2] Using actual tokenAAmount for pool creation:', actualTokenAAmount);

      debugLog('[DAMMV2] Token decimals:', { tokenADecimals, tokenBDecimals });

      // Calculate initial sqrt price from the desired price
      // Price is in terms of token B per token A (e.g., SOL per rift token)
      const initSqrtPrice = getSqrtPriceFromPrice(String(initialPrice), tokenADecimals, tokenBDecimals);

      debugLog('[DAMMV2] Calculated initSqrtPrice:', initSqrtPrice.toString());

      // For single-sided token A deposit:
      // - initSqrtPrice MUST equal minSqrtPrice (SDK requirement)
      // - The price range goes from initSqrtPrice to maxSqrtPrice
      // This means the pool starts at the desired price and can go up to maxPrice (or infinity if not specified)
      const minSqrtPrice = initSqrtPrice; // Single-sided A requires initSqrtPrice == minSqrtPrice

      // Calculate maxSqrtPrice from custom maxPrice or use MAX_SQRT_PRICE for full range
      const maxSqrtPrice = maxPrice && maxPrice > initialPrice
        ? getSqrtPriceFromPrice(String(maxPrice), tokenADecimals, tokenBDecimals)
        : MAX_SQRT_PRICE;

      debugLog('[DAMMV2] Max price config:', {
        maxPriceProvided: maxPrice,
        initialPrice,
        usingFullRange: !maxPrice || maxPrice <= initialPrice,
      });

      debugLog('[DAMMV2] Price range:', {
        minSqrtPrice: minSqrtPrice.toString(),
        maxSqrtPrice: maxSqrtPrice.toString(),
        initSqrtPrice: initSqrtPrice.toString(),
      });

      // Convert token amount to lamports (use actual balance, not requested amount)
      const tokenAAmountBN = new BN(Math.floor(actualTokenAAmount * Math.pow(10, tokenADecimals)));

      // Get epoch info for transfer fee calculation
      const epochInfo = await this.connection.getEpochInfo();

      // Calculate liquidity delta for single-sided deposit
      // For single-sided token A, we provide liquidity from initSqrtPrice to maxSqrtPrice
      const cpAmm = new CpAmm(this.connection);

      // Pass tokenAInfo to properly account for transfer fees (Token-2022 tokens with fees)
      const liquidityDelta = cpAmm.preparePoolCreationSingleSide({
        tokenAAmount: tokenAAmountBN,
        minSqrtPrice,
        maxSqrtPrice,
        initSqrtPrice,
        tokenAInfo: mintAInfo ? {
          mint: mintAInfo,
          currentEpoch: epochInfo.epoch,
        } : undefined,
      });

      debugLog('[DAMMV2] Calculated liquidityDelta:', liquidityDelta.toString());

      // Generate position NFT keypair
      const positionNft = Keypair.generate();

      onProgress?.(2, 'Building pool creation transaction...');

      // Calculate fee numerator from bps
      const feeNumerator = bpsToFeeNumerator(feeBps);

      // Create the pool with single-sided liquidity
      const createPoolTx = await cpAmm.createCustomPool({
        payer: wallet.publicKey,
        creator: wallet.publicKey,
        positionNft: positionNft.publicKey,
        tokenAMint: tokenA,
        tokenBMint: tokenB,
        tokenAAmount: tokenAAmountBN,
        tokenBAmount: new BN(0), // Single-sided, no token B
        sqrtMinPrice: minSqrtPrice,
        sqrtMaxPrice: maxSqrtPrice,
        liquidityDelta,
        initSqrtPrice,
        poolFees: {
          baseFee: {
            cliffFeeNumerator: feeNumerator,
            firstFactor: 0, // numberOfPeriod for feeScheduler, feeIncrementBps for rateLimiter
            secondFactor: [0, 0, 0, 0, 0, 0, 0, 0], // periodFrequency (8 bytes)
            thirdFactor: new BN(0), // reductionFactor for feeScheduler, referenceAmount for rateLimiter
            baseFeeMode: 0, // 0 = normal/flat fee mode
          },
          padding: [0, 0, 0], // 3 bytes padding
          dynamicFee: null,
        },
        hasAlphaVault: false,
        activationType: ActivationType.Timestamp,
        collectFeeMode: CollectFeeMode.OnlyB, // Collect fees only in token B (SOL)
        activationPoint: null,
        tokenAProgram,
        tokenBProgram,
        isLockLiquidity: false,
      });

      // createCustomPool returns { tx, pool, position } directly
      const { tx, pool: poolAddress, position } = createPoolTx;

      // Add compute budget
      const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 400_000,
      });
      const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 100_000,
      });

      tx.instructions.unshift(priorityFeeIx);
      tx.instructions.unshift(computeBudgetIx);

      // Get recent blockhash
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;

      // Sign with position NFT keypair
      tx.partialSign(positionNft);

      onProgress?.(3, 'Please sign the transaction...');

      // Sign with wallet
      const signedTx = await wallet.signTransaction(tx);

      onProgress?.(4, 'Sending transaction...');

      // Send transaction
      const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });

      debugLog('[DAMMV2] Transaction sent:', signature);

      // Confirm transaction
      await this.confirmTransactionPolling(signature);

      onProgress?.(5, 'Pool created successfully!');

      return {
        poolAddress: poolAddress.toBase58(),
        positionNft: positionNft.publicKey.toBase58(),
        signature,
      };
    } catch (error: any) {
      debugError('[DAMMV2] Error creating pool:', error);
      throw error;
    }
  }

  /**
   * Add single-sided liquidity to an existing DAMMV2 pool
   */
  async addSingleSidedLiquidity(
    params: DAMMV2AddLiquidityParams
  ): Promise<{ positionNft: string; signature: string }> {
    const {
      poolAddress,
      tokenAAmount,
      wallet,
      onProgress,
    } = params;

    if (!poolAddress) {
      throw new Error('Pool address required for adding liquidity');
    }

    await this.initSdk();

    debugLog('[DAMMV2] Adding single-sided liquidity to pool:', poolAddress);

    onProgress?.(1, 'Fetching pool state...');

    try {
      const {
        CpAmm,
        MIN_SQRT_PRICE,
        MAX_SQRT_PRICE,
        getLiquidityDeltaFromAmountA,
      } = await import('@meteora-ag/cp-amm-sdk');

      const cpAmm = new CpAmm(this.connection);
      const poolPubkey = new PublicKey(poolAddress);

      // Fetch pool state
      const poolState = await cpAmm.fetchPoolState(poolPubkey);

      if (!poolState) {
        throw new Error('Pool not found');
      }

      debugLog('[DAMMV2] Pool state:', {
        tokenAMint: poolState.tokenAMint.toBase58(),
        tokenBMint: poolState.tokenBMint.toBase58(),
        sqrtPrice: poolState.sqrtPrice.toString(),
      });

      // Get token decimals from pool
      const tokenAMint = poolState.tokenAMint;
      const tokenAProgram = await this.detectTokenProgram(tokenAMint);
      const tokenBProgram = await this.detectTokenProgram(poolState.tokenBMint);

      const { getMint } = await import('@solana/spl-token');
      const mintAInfo = await getMint(this.connection, tokenAMint, 'confirmed', tokenAProgram);
      const tokenADecimals = mintAInfo.decimals;

      // Convert amount to lamports
      const tokenAAmountBN = new BN(Math.floor(tokenAAmount * Math.pow(10, tokenADecimals)));

      // For full range, use min/max sqrt prices
      const minSqrtPrice = MIN_SQRT_PRICE;
      const maxSqrtPrice = MAX_SQRT_PRICE;

      // Get deposit quote for single-sided
      const depositQuote = cpAmm.getDepositQuote({
        inAmount: tokenAAmountBN,
        isTokenA: true,
        minSqrtPrice,
        maxSqrtPrice,
        sqrtPrice: poolState.sqrtPrice,
      });

      debugLog('[DAMMV2] Deposit quote:', {
        liquidityDelta: depositQuote.liquidityDelta.toString(),
        actualInputAmount: depositQuote.actualInputAmount.toString(),
      });

      // Generate position NFT
      const positionNft = Keypair.generate();

      onProgress?.(2, 'Building add liquidity transaction...');

      // Create position and add liquidity (TxBuilder is Promise<Transaction>)
      const tx = await cpAmm.createPositionAndAddLiquidity({
        owner: wallet.publicKey,
        pool: poolPubkey,
        positionNft: positionNft.publicKey,
        liquidityDelta: depositQuote.liquidityDelta,
        maxAmountTokenA: tokenAAmountBN,
        maxAmountTokenB: new BN(0),
        tokenAAmountThreshold: new BN(0),
        tokenBAmountThreshold: new BN(0),
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        tokenAProgram,
        tokenBProgram,
      });

      // Add compute budget
      const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 400_000,
      });
      const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 100_000,
      });

      tx.instructions.unshift(priorityFeeIx);
      tx.instructions.unshift(computeBudgetIx);

      // Get recent blockhash
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;

      // Sign with position NFT
      tx.partialSign(positionNft);

      onProgress?.(3, 'Please sign the transaction...');

      // Sign with wallet
      const signedTx = await wallet.signTransaction(tx);

      onProgress?.(4, 'Sending transaction...');

      // Send transaction
      const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });

      debugLog('[DAMMV2] Transaction sent:', signature);

      // Confirm transaction
      await this.confirmTransactionPolling(signature);

      onProgress?.(5, 'Liquidity added successfully!');

      return {
        positionNft: positionNft.publicKey.toBase58(),
        signature,
      };
    } catch (error: any) {
      debugError('[DAMMV2] Error adding liquidity:', error);
      throw error;
    }
  }

  /**
   * Get pool info
   */
  async getPoolInfo(poolAddress: string): Promise<DAMMV2PoolInfo | null> {
    await this.initSdk();

    try {
      const { CpAmm, getPriceFromSqrtPrice } = await import('@meteora-ag/cp-amm-sdk');
      const cpAmm = new CpAmm(this.connection);

      const poolPubkey = new PublicKey(poolAddress);
      const poolState = await cpAmm.fetchPoolState(poolPubkey);

      if (!poolState) {
        return null;
      }

      // Get decimals for price calculation
      const tokenAProgram = await this.detectTokenProgram(poolState.tokenAMint);
      const tokenBProgram = await this.detectTokenProgram(poolState.tokenBMint);

      const { getMint } = await import('@solana/spl-token');
      const mintAInfo = await getMint(this.connection, poolState.tokenAMint, 'confirmed', tokenAProgram);
      const mintBInfo = await getMint(this.connection, poolState.tokenBMint, 'confirmed', tokenBProgram);

      const currentPriceDecimal = getPriceFromSqrtPrice(
        poolState.sqrtPrice,
        mintAInfo.decimals,
        mintBInfo.decimals
      );

      return {
        address: poolAddress,
        tokenAMint: poolState.tokenAMint.toBase58(),
        tokenBMint: poolState.tokenBMint.toBase58(),
        sqrtPrice: poolState.sqrtPrice.toString(),
        currentPrice: currentPriceDecimal.toNumber(),
        feeBps: 25, // TODO: Extract from pool state if needed
        tokenAVault: poolState.tokenAVault.toBase58(),
        tokenBVault: poolState.tokenBVault.toBase58(),
      };
    } catch (error: any) {
      debugError('[DAMMV2] Error fetching pool info:', error);
      return null;
    }
  }
}

// Singleton instance
let dammv2ServiceInstance: DAMMV2LiquidityService | null = null;

export function getDAMMV2LiquidityService(connection: Connection): DAMMV2LiquidityService {
  if (!dammv2ServiceInstance) {
    dammv2ServiceInstance = new DAMMV2LiquidityService(connection);
  } else {
    dammv2ServiceInstance.updateConnection(connection);
  }
  return dammv2ServiceInstance;
}
