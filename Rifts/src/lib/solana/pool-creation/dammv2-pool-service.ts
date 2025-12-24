/**
 * DAMMV2 (CP-AMM) Two-Sided Pool Creation Service
 * Creates new Meteora DAMMV2 pools with two-sided liquidity (both tokens required)
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
} from '@solana/spl-token';
import BN from 'bn.js';

// ============ CONSTANTS ============

// DAMMV2 (CP-AMM) Program ID
export const DAMMV2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');

// Known Meteora DAMMV2 configs (different fee tiers create different pools for same pair)
// Pool address = PDA(config, tokenA, tokenB)
export const METEORA_CONFIG = new PublicKey('FzvMYBQ29z2J21QPsABpJYYxQBEKGsxA6w6J2HYceFj8'); // 0.25% base fee
export const METEORA_CONFIGS = [
  new PublicKey('FzvMYBQ29z2J21QPsABpJYYxQBEKGsxA6w6J2HYceFj8'), // 0.25% fee
  new PublicKey('7BJfgt3ahTtCfXkPMRbS6YneR92JuwsU1dyayhmNBL11'), // 1% fee
  new PublicKey('82p7sVzQWZfCrmStPhsG8BYKwheQkUiXSs2wiqdhwNxr'), // Another config
];

// SOL/WSOL mint
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// ============ TYPES ============

export interface DAMMV2PoolCreateParams {
  tokenAMint: string | PublicKey;  // Base token (quote side - usually SOL/WSOL)
  tokenBMint: string | PublicKey;  // Quote token (rift token)
  tokenAAmount: number;            // Amount of token A to deposit
  tokenBAmount: number;            // Amount of token B to deposit
  initialPrice?: number;           // Initial price (tokenB per tokenA). If not provided, calculated from amounts
  feeBps?: number;                 // Fee in basis points (default: 25 = 0.25%)
  wallet: {
    publicKey: PublicKey;
    signTransaction?: (tx: Transaction) => Promise<Transaction>;
    signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
    sendTransaction?: (tx: Transaction, connection: Connection) => Promise<string>;
  };
  connection: Connection;
  onProgress?: (step: number, message: string) => void;
}

export interface DAMMV2PoolCreateResult {
  success: boolean;
  poolAddress?: string;
  positionNft?: string;
  signature?: string;
  error?: string;
}

// ============ UTILITIES ============

/**
 * Parse Solana simulation errors into user-friendly messages
 */
function parseSimulationError(err: any, logs?: string[]): string {
  // Check logs first for specific error patterns
  if (logs && logs.length > 0) {
    const logStr = logs.join(' ').toLowerCase();
    if (logStr.includes('insufficient lamports')) {
      return 'Insufficient SOL balance. You need more SOL to cover account rent deposits (~0.03 SOL) plus transaction fees.';
    }
  }

  // Handle InstructionError format: { InstructionError: [index, { Custom: code }] }
  if (err?.InstructionError) {
    const [instructionIndex, errorDetail] = err.InstructionError;

    // Handle custom program errors
    if (errorDetail?.Custom !== undefined) {
      const customCode = errorDetail.Custom;

      // System Program error code 1 = insufficient lamports for rent
      // This is the most common error during pool creation
      if (customCode === 1) {
        return 'Insufficient SOL balance. You need more SOL to cover account rent deposits (~0.03 SOL) plus transaction fees.';
      }

      // SPL Token program errors
      const splTokenErrors: Record<number, string> = {
        0: 'Insufficient SOL for rent-exempt account',
        2: 'Invalid token mint',
        3: 'Token account mint mismatch',
        4: 'Token account owner mismatch',
        5: 'Token has fixed supply',
        6: 'Account already initialized',
        7: 'Account frozen',
        8: 'Insufficient allowance',
      };

      // Check SPL Token errors
      if (splTokenErrors[customCode]) {
        return splTokenErrors[customCode];
      }

      return `Program error code ${customCode}`;
    }

    // Handle string error types
    if (typeof errorDetail === 'string') {
      const errorMessages: Record<string, string> = {
        'AccountNotFound': 'Required account not found - check token accounts exist',
        'InsufficientFunds': 'Insufficient SOL balance for transaction',
        'InvalidAccountData': 'Invalid account data',
        'InvalidAccountOwner': 'Invalid account owner',
      };
      return errorMessages[errorDetail] || errorDetail;
    }
  }

  // Check raw error string for patterns
  const errStr = JSON.stringify(err).toLowerCase();
  if (errStr.includes('insufficient lamports') || errStr.includes('insufficient funds')) {
    return 'Insufficient SOL balance. You need more SOL to cover account rent deposits (~0.03 SOL) plus transaction fees.';
  }

  // Fallback to JSON string
  return JSON.stringify(err);
}

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
      console.log(`[DAMMV2-POOL] Could not find mint account, defaulting to TOKEN_2022`);
      return TOKEN_2022_PROGRAM_ID;
    }

    if (accountInfo.owner.equals(TOKEN_PROGRAM_ID)) {
      return TOKEN_PROGRAM_ID;
    } else if (accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return TOKEN_2022_PROGRAM_ID;
    }
    return TOKEN_2022_PROGRAM_ID;
  } catch (error) {
    console.error(`[DAMMV2-POOL] Failed to detect token program:`, error);
    return TOKEN_2022_PROGRAM_ID;
  }
}

/**
 * Calculate sqrt price from regular price (for DAMMV2 pools)
 */
function getSqrtPriceFromPrice(
  price: number,
  tokenADecimals: number,
  tokenBDecimals: number
): BN {
  const decimalDiff = tokenBDecimals - tokenADecimals;
  const adjustedPrice = price * Math.pow(10, decimalDiff);
  const sqrtPrice = Math.sqrt(adjustedPrice);

  // Q64 fixed-point representation
  const Q64_STRING = '18446744073709551616';
  const scaledPrice = BigInt(Math.floor(sqrtPrice * 1e18));
  const Q64_BIGINT = BigInt(Q64_STRING);
  const resultBigInt = (scaledPrice * Q64_BIGINT) / BigInt(1e18);

  return new BN(resultBigInt.toString());
}

/**
 * Confirm transaction using polling (avoids WebSocket issues)
 */
async function confirmTransactionPolling(
  connection: Connection,
  signature: string,
  maxRetries = 30
): Promise<void> {
  console.log('[DAMMV2-POOL] Confirming tx via polling:', signature.slice(0, 20) + '...');

  for (let i = 0; i < maxRetries; i++) {
    try {
      const status = await connection.getSignatureStatus(signature);

      if (status?.value?.err) {
        const errorStr = JSON.stringify(status.value.err);
        console.error('[DAMMV2-POOL] Transaction failed with error:', errorStr);

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
        console.log('[DAMMV2-POOL] Transaction confirmed:', status.value.confirmationStatus);
        return;
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Transaction failed')) {
        throw error;
      }
      console.log('[DAMMV2-POOL] Polling error (retrying):', errorMessage);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error('Transaction confirmation timeout');
}

/**
 * Simulate transaction via RPC proxy
 */
async function simulateTransaction(
  connection: Connection,
  tx: Transaction
): Promise<void> {
  if (typeof window === 'undefined') {
    // Server-side: use direct simulation
    const simulation = await connection.simulateTransaction(tx);
    if (simulation.value.err) {
      throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }
    return;
  }

  // Client-side: use RPC proxy
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const simTx = Transaction.from(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false })
  );
  simTx.recentBlockhash = blockhash;

  const simEncoded = simTx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

  const simResp = await fetch('/api/rpc-http', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'sim_dammv2_pool',
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
    console.log('[DAMMV2-POOL] Simulation RPC error:', simJson.error);
    throw new Error(simJson.error.message || 'Pool simulation RPC error');
  }

  if (simJson.result?.value?.err) {
    console.log('[DAMMV2-POOL] Simulation failed:', simJson.result.value.err, simJson.result.value.logs);
    throw new Error(`Pool creation failed: ${parseSimulationError(simJson.result.value.err, simJson.result.value.logs)}`);
  }

  console.log('[DAMMV2-POOL] Simulation passed, units:', simJson.result?.value?.unitsConsumed);
}

// ============ MAIN SERVICE CLASS ============

export class DAMMV2PoolService {
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
   * Create a new DAMMV2 pool with two-sided liquidity
   * Both tokenA and tokenB amounts must be provided
   *
   * Uses createPool() with configs, allowing multiple pools per token pair
   * Each config produces a different pool address: PDA(config, tokenA, tokenB)
   */
  async createPool(params: DAMMV2PoolCreateParams): Promise<DAMMV2PoolCreateResult> {
    const {
      tokenAMint,
      tokenBMint,
      tokenAAmount,
      tokenBAmount,
      initialPrice,
      wallet,
      onProgress,
    } = params;

    try {
      onProgress?.(1, 'Initializing pool creation...');

      // Initialize SDK
      await this.initSdk();

      // Convert mints to PublicKey
      const tokenA = typeof tokenAMint === 'string' ? new PublicKey(tokenAMint) : tokenAMint;
      const tokenB = typeof tokenBMint === 'string' ? new PublicKey(tokenBMint) : tokenBMint;

      console.log('[DAMMV2-POOL] Creating two-sided pool:', {
        tokenA: tokenA.toBase58(),
        tokenB: tokenB.toBase58(),
        tokenAAmount,
        tokenBAmount,
      });

      // Import derivePoolAddress
      const { derivePoolAddress } = await import('@meteora-ag/cp-amm-sdk');

      onProgress?.(2, 'Fetching available pool configs...');

      // Fetch ALL configs from the program to maximize pool creation options
      const allConfigs = await this.cpAmm.getAllConfigs();
      console.log(`[DAMMV2-POOL] Found ${allConfigs.length} total configs on-chain`);

      // Find a config that doesn't have a pool yet for this pair
      let selectedConfig: PublicKey | null = null;
      let checkedCount = 0;
      for (const { publicKey: config } of allConfigs) {
        try {
          const derivedPool = derivePoolAddress(config, tokenA, tokenB);
          const exists = await this.cpAmm.isPoolExist(derivedPool);
          checkedCount++;

          if (!exists) {
            selectedConfig = config;
            console.log(`[DAMMV2-POOL] Found available config after checking ${checkedCount}: ${config.toBase58()}`);
            break;
          }

          // Log progress every 10 configs
          if (checkedCount % 10 === 0) {
            console.log(`[DAMMV2-POOL] Checked ${checkedCount}/${allConfigs.length} configs...`);
          }
        } catch (checkErr) {
          // Skip configs that error
          continue;
        }
      }

      if (!selectedConfig) {
        return {
          success: false,
          error: `All ${allConfigs.length} pool configs already have pools for this token pair.`,
        };
      }

      onProgress?.(3, 'Detecting token programs...');

      // Detect token programs
      const tokenAProgram = await detectTokenProgram(this.connection, tokenA);
      const tokenBProgram = await detectTokenProgram(this.connection, tokenB);

      console.log('[DAMMV2-POOL] Token programs:', {
        tokenA: tokenAProgram.toBase58(),
        tokenB: tokenBProgram.toBase58(),
      });

      // Get decimals
      const tokenAMintInfo = await getMint(this.connection, tokenA, 'confirmed', tokenAProgram);
      const tokenBMintInfo = await getMint(this.connection, tokenB, 'confirmed', tokenBProgram);
      const tokenADecimals = tokenAMintInfo.decimals;
      const tokenBDecimals = tokenBMintInfo.decimals;

      console.log('[DAMMV2-POOL] Decimals:', { tokenADecimals, tokenBDecimals });

      // Calculate initial price (tokenB per tokenA)
      // If not provided, derive from amounts
      const price = initialPrice ?? (tokenBAmount / tokenAAmount);
      const initSqrtPrice = getSqrtPriceFromPrice(price, tokenADecimals, tokenBDecimals);

      // Convert amounts to lamports
      const tokenAAmountLamports = Math.floor(tokenAAmount * Math.pow(10, tokenADecimals));
      const tokenBAmountLamports = Math.floor(tokenBAmount * Math.pow(10, tokenBDecimals));

      console.log('[DAMMV2-POOL] Price and amounts:', {
        price,
        initSqrtPrice: initSqrtPrice.toString(),
        tokenAAmountLamports,
        tokenBAmountLamports,
      });

      onProgress?.(4, 'Calculating liquidity...');

      const tokenAAmountBN = new BN(tokenAAmountLamports);
      const tokenBAmountBN = new BN(tokenBAmountLamports);

      // Import SDK helpers
      const { MIN_SQRT_PRICE, MAX_SQRT_PRICE } = await import('@meteora-ag/cp-amm-sdk');

      // Use preparePoolCreationParams to calculate liquidity delta from amounts
      // This uses full range (MIN to MAX) for maximum flexibility
      const { liquidityDelta, initSqrtPrice: calculatedSqrtPrice } = this.cpAmm.preparePoolCreationParams({
        tokenAAmount: tokenAAmountBN,
        tokenBAmount: tokenBAmountBN,
        minSqrtPrice: MIN_SQRT_PRICE,
        maxSqrtPrice: MAX_SQRT_PRICE,
      });

      // Use the SDK-calculated sqrt price for consistency
      const finalSqrtPrice = calculatedSqrtPrice || initSqrtPrice;

      console.log('[DAMMV2-POOL] Two-sided liquidity calculation:', {
        tokenAAmount: tokenAAmountBN.toString(),
        tokenBAmount: tokenBAmountBN.toString(),
        initSqrtPrice: finalSqrtPrice.toString(),
        liquidityDelta: liquidityDelta.toString(),
        selectedConfig: selectedConfig.toBase58(),
      });

      onProgress?.(5, 'Building pool creation transaction...');

      // Generate position NFT keypair
      const positionNftMint = Keypair.generate();

      // Use createPool with config - this allows multiple pools per pair
      // Pool address = PDA(config, tokenA, tokenB)
      const createPoolTx = await this.cpAmm.createPool({
        payer: wallet.publicKey,
        creator: wallet.publicKey,
        config: selectedConfig,
        positionNft: positionNftMint.publicKey,
        tokenAMint: tokenA,
        tokenBMint: tokenB,
        tokenAAmount: tokenAAmountBN,
        tokenBAmount: tokenBAmountBN,
        initSqrtPrice: finalSqrtPrice,
        liquidityDelta,
        activationPoint: null,
        tokenAProgram,
        tokenBProgram,
        isLockLiquidity: false,
      });

      // Derive pool address
      const poolAddress = derivePoolAddress(selectedConfig, tokenA, tokenB);

      // Add compute budget instructions
      createPoolTx.instructions.unshift(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })
      );

      // Set fee payer and blockhash
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      createPoolTx.recentBlockhash = blockhash;
      createPoolTx.feePayer = wallet.publicKey;

      // Partial sign with position NFT keypair
      createPoolTx.partialSign(positionNftMint);

      onProgress?.(6, 'Simulating transaction...');

      // Simulate before sending
      await simulateTransaction(this.connection, createPoolTx);

      onProgress?.(7, 'Please sign the transaction...');

      // Send transaction
      let signature: string;
      if (wallet.sendTransaction) {
        signature = await wallet.sendTransaction(createPoolTx, this.connection);
      } else if (wallet.signTransaction) {
        const signedTx = await wallet.signTransaction(createPoolTx);
        signature = await this.connection.sendRawTransaction(signedTx.serialize());
      } else {
        throw new Error('Wallet does not support transaction signing');
      }

      console.log('[DAMMV2-POOL] Transaction sent:', signature);

      onProgress?.(8, 'Confirming transaction...');

      // Confirm transaction
      await confirmTransactionPolling(this.connection, signature);

      const poolAddressStr = poolAddress.toBase58();
      const positionNftStr = positionNftMint.publicKey.toBase58();

      console.log('[DAMMV2-POOL] Pool created successfully:', {
        poolAddress: poolAddressStr,
        positionNft: positionNftStr,
        config: selectedConfig.toBase58(),
        signature,
      });

      onProgress?.(9, 'Pool created successfully!');

      return {
        success: true,
        poolAddress: poolAddressStr,
        positionNft: positionNftStr,
        signature,
      };

    } catch (error) {
      console.error('[DAMMV2-POOL] Error creating pool:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if a pool already exists for the given token pair
   * Returns the first existing pool found, or indicates if any config has space for a new pool
   */
  async poolExists(tokenAMint: string | PublicKey, tokenBMint: string | PublicKey): Promise<{
    exists: boolean;
    poolAddress?: string;
    canCreateMore: boolean;
  }> {
    try {
      await this.initSdk();

      const tokenA = typeof tokenAMint === 'string' ? new PublicKey(tokenAMint) : tokenAMint;
      const tokenB = typeof tokenBMint === 'string' ? new PublicKey(tokenBMint) : tokenBMint;

      const { derivePoolAddress } = await import('@meteora-ag/cp-amm-sdk');

      // Fetch all configs from the program
      const allConfigs = await this.cpAmm.getAllConfigs();

      let firstExistingPool: string | undefined;
      let canCreateMore = false;

      for (const { publicKey: config } of allConfigs) {
        try {
          const derivedPool = derivePoolAddress(config, tokenA, tokenB);
          const exists = await this.cpAmm.isPoolExist(derivedPool);

          if (exists) {
            if (!firstExistingPool) {
              firstExistingPool = derivedPool.toBase58();
            }
          } else {
            canCreateMore = true;
          }
        } catch {
          // Config might not work, consider it available
          canCreateMore = true;
        }
      }

      return {
        exists: !!firstExistingPool,
        poolAddress: firstExistingPool,
        canCreateMore,
      };
    } catch {
      return { exists: false, canCreateMore: true };
    }
  }

  /**
   * Get all existing pools for a token pair across all configs
   */
  async getAllPoolsForPair(tokenAMint: string | PublicKey, tokenBMint: string | PublicKey): Promise<string[]> {
    try {
      await this.initSdk();

      const tokenA = typeof tokenAMint === 'string' ? new PublicKey(tokenAMint) : tokenAMint;
      const tokenB = typeof tokenBMint === 'string' ? new PublicKey(tokenBMint) : tokenBMint;

      const { derivePoolAddress } = await import('@meteora-ag/cp-amm-sdk');

      // Fetch all configs from the program
      const allConfigs = await this.cpAmm.getAllConfigs();

      const existingPools: string[] = [];

      for (const { publicKey: config } of allConfigs) {
        try {
          const derivedPool = derivePoolAddress(config, tokenA, tokenB);
          const exists = await this.cpAmm.isPoolExist(derivedPool);
          if (exists) {
            existingPools.push(derivedPool.toBase58());
          }
        } catch {
          // Ignore errors for individual configs
        }
      }

      return existingPools;
    } catch {
      return [];
    }
  }
}

// ============ SINGLETON EXPORT ============

let serviceInstance: DAMMV2PoolService | null = null;

export function getDAMMV2PoolService(connection: Connection): DAMMV2PoolService {
  if (!serviceInstance) {
    serviceInstance = new DAMMV2PoolService(connection);
  } else {
    serviceInstance.updateConnection(connection);
  }
  return serviceInstance;
}

/**
 * Convenience function to create a two-sided DAMMV2 pool
 */
export async function createDAMMV2Pool(
  params: DAMMV2PoolCreateParams
): Promise<DAMMV2PoolCreateResult> {
  const service = getDAMMV2PoolService(params.connection);
  return service.createPool(params);
}
