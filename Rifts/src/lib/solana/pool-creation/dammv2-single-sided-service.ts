/**
 * DAMMV2 (CP-AMM) Single-Sided Pool Creation Service
 * Creates new Meteora DAMMV2 pools with single-sided liquidity (only tokenA required)
 *
 * Key characteristics:
 * - Only tokenA is deposited, tokenB amount is 0
 * - Price range: initSqrtPrice to MAX_SQRT_PRICE
 * - initSqrtPrice MUST equal minSqrtPrice (SDK requirement for single-sided A)
 * - Uses preparePoolCreationSingleSide() for liquidity calculation
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
  getMint,
  getAssociatedTokenAddress,
  getAccount,
} from '@solana/spl-token';
import BN from 'bn.js';

// ============ CONSTANTS ============

// DAMMV2 (CP-AMM) Program ID
export const DAMMV2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');

// SOL/WSOL mint
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// Known Meteora DAMMV2 configs (different fee tiers create different pools for same pair)
// Pool address = PDA(config, tokenA, tokenB)
export const METEORA_CONFIGS = [
  new PublicKey('FzvMYBQ29z2J21QPsABpJYYxQBEKGsxA6w6J2HYceFj8'), // 0.25% fee
  new PublicKey('7BJfgt3ahTtCfXkPMRbS6YneR92JuwsU1dyayhmNBL11'), // 1% fee
  new PublicKey('82p7sVzQWZfCrmStPhsG8BYKwheQkUiXSs2wiqdhwNxr'), // Another config
];

// ============ TYPES ============

export interface DAMMV2SingleSidedParams {
  tokenAMint: string | PublicKey;  // Base token (the token being deposited)
  tokenBMint: string | PublicKey;  // Quote token (usually SOL/WSOL)
  tokenAAmount: number;            // Amount of token A to deposit (only this token is deposited)
  initialPrice: number;            // Initial price (tokenB per tokenA, e.g., SOL per rift)
  maxPrice?: number;               // Optional max price for concentrated liquidity (uses createCustomPool if set)
  feeBps?: number;                 // Fee in basis points (default: 25 = 0.25%)
  wallet: {
    publicKey: PublicKey;
    signTransaction: (tx: Transaction) => Promise<Transaction>;
    signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
    sendTransaction?: (tx: Transaction, connection: Connection) => Promise<string>;
  };
  connection: Connection;
  onProgress?: (step: number, message: string) => void;
}

export interface DAMMV2SingleSidedResult {
  success: boolean;
  poolAddress?: string;
  positionNft?: string;
  signature?: string;
  error?: string;
}

// ============ UTILITIES ============

/**
 * Create a proxied connection for browser environments
 */
function createProxiedConnection(fallbackConnection: Connection): Connection {
  if (typeof window !== 'undefined') {
    try {
      const { createProxiedConnection } = require('@/lib/solana/rpc-client');
      return createProxiedConnection();
    } catch {
      return fallbackConnection;
    }
  }
  return fallbackConnection;
}

/**
 * Detect which token program a mint uses (TOKEN_PROGRAM or TOKEN_2022)
 */
async function detectTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  try {
    const accountInfo = await connection.getAccountInfo(mint);
    if (!accountInfo) {
      console.log(`[DAMMV2-SS] Could not find mint account, defaulting to TOKEN_2022`);
      return TOKEN_2022_PROGRAM_ID;
    }

    if (accountInfo.owner.equals(TOKEN_PROGRAM_ID)) {
      return TOKEN_PROGRAM_ID;
    } else if (accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return TOKEN_2022_PROGRAM_ID;
    }
    return TOKEN_2022_PROGRAM_ID;
  } catch (error) {
    console.error(`[DAMMV2-SS] Failed to detect token program:`, error);
    return TOKEN_2022_PROGRAM_ID;
  }
}

/**
 * Confirm transaction using polling (avoids WebSocket issues)
 */
async function confirmTransactionPolling(
  connection: Connection,
  signature: string,
  maxRetries = 30
): Promise<void> {
  console.log('[DAMMV2-SS] Confirming tx via polling:', signature.slice(0, 20) + '...');

  for (let i = 0; i < maxRetries; i++) {
    try {
      const status = await connection.getSignatureStatus(signature);

      if (status?.value?.err) {
        const errorStr = JSON.stringify(status.value.err);
        console.error('[DAMMV2-SS] Transaction failed with error:', errorStr);

        // Try to get more details
        try {
          const tx = await connection.getTransaction(signature, {
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
        } catch {
          // Ignore fetch errors
        }

        throw new Error(`Transaction failed: ${errorStr}`);
      }

      if (status?.value?.confirmationStatus === 'confirmed' ||
          status?.value?.confirmationStatus === 'finalized') {
        console.log('[DAMMV2-SS] Transaction confirmed:', status.value.confirmationStatus);
        return;
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Transaction failed')) {
        throw error;
      }
      console.log('[DAMMV2-SS] Polling error (retrying):', errorMessage);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error('Transaction confirmation timeout');
}

// ============ MAIN SERVICE CLASS ============

export class DAMMV2SingleSidedService {
  private connection: Connection;
  private cpAmm: any = null;

  constructor(connection: Connection) {
    this.connection = createProxiedConnection(connection);
  }

  /**
   * Update the connection
   */
  updateConnection(newConnection: Connection): void {
    this.connection = createProxiedConnection(newConnection);
    this.cpAmm = null; // Reset SDK to use new connection
  }

  /**
   * Initialize the CP-AMM SDK
   */
  private async initSdk(): Promise<void> {
    if (!this.cpAmm) {
      const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
      this.cpAmm = new CpAmm(this.connection);
    }
  }

  /**
   * Create a new DAMMV2 pool with single-sided liquidity
   * Only tokenA is deposited, tokenB amount is 0
   *
   * Key requirements:
   * - initSqrtPrice MUST equal minSqrtPrice (SDK requirement)
   * - Price range goes from initSqrtPrice to MAX_SQRT_PRICE
   * - Uses preparePoolCreationSingleSide() for proper liquidity calculation
   */
  async createPool(params: DAMMV2SingleSidedParams): Promise<DAMMV2SingleSidedResult> {
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

    // Note: maxPrice is available but config-based pools use the config's price range.
    // For custom price ranges, use DAMMV2LiquidityService.createPoolWithSingleSidedLiquidity() instead.
    // Config-based pools ignore maxPrice and use full range from config min to config max.
    if (maxPrice && maxPrice > initialPrice) {
      console.log('[DAMMV2-SS] Note: maxPrice provided but config-based pools use config price range. Consider using DAMMV2LiquidityService for custom ranges.');
    }

    try {
      onProgress?.(1, 'Initializing single-sided pool creation...');

      // Validate input
      if (tokenAAmount <= 0 || isNaN(tokenAAmount)) {
        throw new Error(`Invalid tokenAAmount: ${tokenAAmount}. Must be a positive number.`);
      }

      // Initialize SDK
      await this.initSdk();

      // Import SDK helpers
      const {
        CpAmm,
        getSqrtPriceFromPrice,
        derivePoolAddress,
      } = await import('@meteora-ag/cp-amm-sdk');

      // Convert mints to PublicKey
      const tokenA = typeof tokenAMint === 'string' ? new PublicKey(tokenAMint) : tokenAMint;
      const tokenB = typeof tokenBMint === 'string' ? new PublicKey(tokenBMint) : tokenBMint;

      console.log('[DAMMV2-SS] Creating single-sided pool:', {
        tokenA: tokenA.toBase58(),
        tokenB: tokenB.toBase58(),
        tokenAAmount,
        initialPrice,
        feeBps,
      });

      onProgress?.(2, 'Detecting token programs...');

      // Detect token programs
      const tokenAProgram = await detectTokenProgram(this.connection, tokenA);
      const tokenBProgram = await detectTokenProgram(this.connection, tokenB);

      console.log('[DAMMV2-SS] Token programs:', {
        tokenA: tokenAProgram.toBase58(),
        tokenB: tokenBProgram.toBase58(),
      });

      onProgress?.(3, 'Fetching available pool configs...');

      // For single-sided pools with multiple pools per pair:
      // Pool address = PDA(config, tokenA, tokenB) - different configs = different pools
      // Fetch ALL configs from the program to maximize pool creation options

      let selectedConfig: PublicKey | null = null;
      let poolAddress: PublicKey | null = null;

      // Fetch all available configs from the Meteora program
      const allConfigs = await this.cpAmm.getAllConfigs();
      console.log(`[DAMMV2-SS] Found ${allConfigs.length} total configs on-chain`);

      // Check each config to find one without an existing pool
      let checkedCount = 0;
      for (const { publicKey: config } of allConfigs) {
        try {
          const derivedPool = derivePoolAddress(config, tokenA, tokenB);

          const exists = await this.cpAmm.isPoolExist(derivedPool);
          checkedCount++;

          if (!exists) {
            selectedConfig = config;
            poolAddress = derivedPool;
            console.log(`[DAMMV2-SS] Found available config after checking ${checkedCount}: ${config.toBase58()}`);
            break;
          }

          // Log progress every 10 configs
          if (checkedCount % 10 === 0) {
            console.log(`[DAMMV2-SS] Checked ${checkedCount}/${allConfigs.length} configs...`);
          }
        } catch (configError) {
          // Skip configs that error (might have incompatible settings)
          continue;
        }
      }

      if (!selectedConfig || !poolAddress) {
        throw new Error(
          `All ${allConfigs.length} pool configs already have pools for this token pair. ` +
          'This is extremely rare - consider using DLMM for additional pools.'
        );
      }

      console.log('[DAMMV2-SS] Selected config for pool creation:', selectedConfig.toBase58());

      // Get decimals and mint info
      let tokenADecimals = 9;
      let tokenBDecimals = 9;
      let mintAInfo: Awaited<ReturnType<typeof getMint>> | null = null;

      try {
        mintAInfo = await getMint(this.connection, tokenA, 'confirmed', tokenAProgram);
        const mintBInfo = await getMint(this.connection, tokenB, 'confirmed', tokenBProgram);
        tokenADecimals = mintAInfo.decimals;
        tokenBDecimals = mintBInfo.decimals;
      } catch {
        console.log('[DAMMV2-SS] Could not fetch decimals, using default 9');
      }

      console.log('[DAMMV2-SS] Token decimals:', { tokenADecimals, tokenBDecimals });

      onProgress?.(4, 'Checking token balance...');

      // Check user's token A balance (handle Token-2022 transfer fees)
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

        console.log('[DAMMV2-SS] User token A balance:', {
          account: userTokenAAccount.toBase58(),
          balanceLamports: userBalanceLamports,
          balance: userBalance,
          requiredAmount: tokenAAmount,
        });

        // If user has less than requested (due to transfer fees), use actual balance
        if (userBalance < tokenAAmount) {
          console.log('[DAMMV2-SS] User has less than requested (likely due to transfer fees). Using actual balance:', userBalance);
          actualTokenAAmount = userBalance;
        }

        // Final check: ensure user has enough tokens
        if (actualTokenAAmount <= 0) {
          throw new Error(`No token balance found. Please ensure your tokens have been wrapped first.`);
        }
      } catch (balanceError: unknown) {
        const errorMessage = balanceError instanceof Error ? balanceError.message : String(balanceError);
        if (errorMessage.includes('No token balance')) {
          throw balanceError;
        }
        console.log('[DAMMV2-SS] Could not fetch token A balance:', errorMessage);
        throw new Error(`Token account not found. Please ensure you have wrapped tokens in your wallet.`);
      }

      console.log('[DAMMV2-SS] Using actual tokenAAmount:', actualTokenAAmount);

      onProgress?.(5, 'Fetching config parameters...');

      // Fetch the config state to get its price range
      const cpAmm = new CpAmm(this.connection);
      const configState = await cpAmm.fetchConfigState(selectedConfig);

      console.log('[DAMMV2-SS] Config state:', {
        sqrtMinPrice: configState.sqrtMinPrice.toString(),
        sqrtMaxPrice: configState.sqrtMaxPrice.toString(),
        poolCreatorAuthority: configState.poolCreatorAuthority?.toBase58(),
      });

      // For config-based pools, we must use the config's price range
      // The pool will use sqrtMinPrice to sqrtMaxPrice from the config
      const configMinSqrtPrice = new BN(configState.sqrtMinPrice.toString());
      const configMaxSqrtPrice = new BN(configState.sqrtMaxPrice.toString());

      // Calculate initial sqrt price for our desired price
      // Price is in terms of token B per token A (e.g., SOL per rift token)
      const initSqrtPrice = getSqrtPriceFromPrice(String(initialPrice), tokenADecimals, tokenBDecimals);

      console.log('[DAMMV2-SS] Price calculation:', {
        initialPrice,
        initSqrtPrice: initSqrtPrice.toString(),
        configMinSqrtPrice: configMinSqrtPrice.toString(),
        configMaxSqrtPrice: configMaxSqrtPrice.toString(),
      });

      // Ensure initSqrtPrice is within config bounds
      if (initSqrtPrice.lt(configMinSqrtPrice)) {
        throw new Error(`Initial price too low. Minimum supported price for this config.`);
      }
      if (initSqrtPrice.gt(configMaxSqrtPrice)) {
        throw new Error(`Initial price too high. Maximum supported price for this config.`);
      }

      // Convert token amount to lamports
      const tokenAAmountBN = new BN(Math.floor(actualTokenAAmount * Math.pow(10, tokenADecimals)));

      // Get epoch info for transfer fee calculation (Token-2022)
      const epochInfo = await this.connection.getEpochInfo();

      // Calculate actual amount after transfer fee (for Token-2022)
      let actualAmountIn = tokenAAmountBN;
      if (mintAInfo) {
        const { calculateTransferFeeIncludedAmount } = await import('@meteora-ag/cp-amm-sdk');
        const { transferFee } = calculateTransferFeeIncludedAmount(
          tokenAAmountBN,
          mintAInfo,
          epochInfo.epoch
        );
        actualAmountIn = tokenAAmountBN.sub(transferFee);
      }

      // For TRUE single-sided with config-based pools:
      // - initSqrtPrice MUST equal configMinSqrtPrice
      // - This means all liquidity is above current price (backed by tokenA only)
      // - tokenB portion is empty since sqrtMin == sqrtInit
      // - Price starts at the config's minimum and can only go UP

      // Use config's minimum price as initial price for true single-sided
      // This is the KEY insight: when initSqrtPrice == sqrtMinPrice, only tokenA is needed
      const finalInitSqrtPrice = configMinSqrtPrice;

      console.log('[DAMMV2-SS] Using config minSqrtPrice for true single-sided:', {
        configMinSqrtPrice: configMinSqrtPrice.toString(),
        configMaxSqrtPrice: configMaxSqrtPrice.toString(),
        userDesiredPrice: initialPrice,
        userDesiredSqrtPrice: initSqrtPrice.toString(),
        actualInitSqrtPrice: finalInitSqrtPrice.toString(),
        NOTE: 'For single-sided config pools, price starts at config minimum. First trade sets market price.',
      });

      // Calculate liquidity from tokenA for the range: configMinSqrtPrice to configMaxSqrtPrice
      // Since initSqrtPrice == configMinSqrtPrice, all liquidity comes from tokenA
      //
      // The SDK's getLiquidityDeltaFromAmountA does: amountA * lower * upper / (upper - lower)
      // This can overflow for large amounts because the intermediate product is huge.
      //
      // We use BigInt to safely compute: L = amountA * lower * upper / (upper - lower)
      // BigInt handles arbitrary precision without overflow.

      const safeLiquidityDelta = (() => {
        const amountBI = BigInt(actualAmountIn.toString());
        const lowerBI = BigInt(finalInitSqrtPrice.toString());
        const upperBI = BigInt(configMaxSqrtPrice.toString());
        const denominator = upperBI - lowerBI;

        // Calculate: amountA * lower * upper / (upper - lower)
        const numerator = amountBI * lowerBI * upperBI;
        const result = numerator / denominator;

        return new BN(result.toString());
      })();

      const liquidityDelta = safeLiquidityDelta;

      console.log('[DAMMV2-SS] Calculated single-sided liquidity:', {
        tokenAAmount: actualAmountIn.toString(),
        liquidityDelta: liquidityDelta.toString(),
        initSqrtPrice: finalInitSqrtPrice.toString(),
      });

      // For true single-sided, tokenB = 0 (but SDK may require minimal amount for wrapping)
      const finalTokenBAmount = new BN(0);

      onProgress?.(6, 'Building pool creation transaction...');

      // Generate position NFT keypair
      const positionNft = Keypair.generate();

      console.log('[DAMMV2-SS] Creating pool with createPool (config-based):', {
        config: selectedConfig.toBase58(),
        poolAddress: poolAddress.toBase58(),
        tokenAAmount: tokenAAmountBN.toString(),
        tokenBAmount: finalTokenBAmount.toString(),
        initSqrtPrice: finalInitSqrtPrice.toString(),
        liquidityDelta: liquidityDelta.toString(),
      });

      // Create the pool - true single-sided with price at config minimum
      // Pool address = PDA(config, tokenA, tokenB) - allows multiple pools per pair
      const tx = await cpAmm.createPool({
        payer: wallet.publicKey,
        creator: wallet.publicKey,
        config: selectedConfig,
        positionNft: positionNft.publicKey,
        tokenAMint: tokenA,
        tokenBMint: tokenB,
        tokenAAmount: tokenAAmountBN,
        tokenBAmount: finalTokenBAmount,
        initSqrtPrice: finalInitSqrtPrice,
        liquidityDelta,
        activationPoint: null,
        tokenAProgram,
        tokenBProgram,
        isLockLiquidity: false,
      });

      // Add compute budget instructions
      const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 400_000,
      });
      const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 100_000,
      });

      tx.instructions.unshift(priorityFeeIx);
      tx.instructions.unshift(computeBudgetIx);

      // Set fee payer and blockhash
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;

      // Partial sign with position NFT keypair
      tx.partialSign(positionNft);

      onProgress?.(7, 'Please sign the transaction...');

      // Sign with wallet
      const signedTx = await wallet.signTransaction(tx);

      onProgress?.(8, 'Sending transaction...');

      // Send transaction
      const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });

      console.log('[DAMMV2-SS] Transaction sent:', signature);

      onProgress?.(9, 'Confirming transaction...');

      // Confirm transaction
      await confirmTransactionPolling(this.connection, signature);

      console.log('[DAMMV2-SS] Pool created successfully:', {
        poolAddress: poolAddress.toBase58(),
        positionNft: positionNft.publicKey.toBase58(),
        signature,
      });

      onProgress?.(10, 'Pool created successfully!');

      return {
        success: true,
        poolAddress: poolAddress.toBase58(),
        positionNft: positionNft.publicKey.toBase58(),
        signature,
      };

    } catch (error) {
      console.error('[DAMMV2-SS] Error creating pool:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============ SINGLETON EXPORT ============

let serviceInstance: DAMMV2SingleSidedService | null = null;

export function getDAMMV2SingleSidedService(connection: Connection): DAMMV2SingleSidedService {
  if (!serviceInstance) {
    serviceInstance = new DAMMV2SingleSidedService(connection);
  } else {
    serviceInstance.updateConnection(connection);
  }
  return serviceInstance;
}

/**
 * Convenience function to create a single-sided DAMMV2 pool
 */
export async function createDAMMV2SingleSidedPool(
  params: DAMMV2SingleSidedParams
): Promise<DAMMV2SingleSidedResult> {
  const service = getDAMMV2SingleSidedService(params.connection);
  return service.createPool(params);
}
