/**
 * DLMM (Dynamic Liquidity Market Maker) Single-Sided Pool Creation Service
 * Creates new Meteora DLMM pools with single-sided concentrated liquidity
 *
 * Key characteristics:
 * - Bin-based price ranges (discrete price points)
 * - Customizable bin step (price granularity)
 * - Single-sided only: bins above active bin for selling tokenX
 * - No SOL deposited (tokenY = 0)
 * - MCap-based bin calculation support
 */

import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  ComputeBudgetProgram,
  Keypair,
  TransactionMessage,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getMint,
  getAssociatedTokenAddress,
  getAccount,
} from '@solana/spl-token';
import BN from 'bn.js';

// ============ CONSTANTS ============

// DLMM Program ID
export const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

// SOL/WSOL mint
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// ============ TYPES ============

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

export interface DLMMPoolCreateParams {
  tokenXMint: string | PublicKey;  // Base token (rift token to sell)
  tokenYMint: string | PublicKey;  // Quote token (SOL/WSOL)
  tokenXAmount: number;            // Amount of token X to deposit (single-sided)
  binStep: number;                 // Price granularity (1-400, common: 10, 50, 100)
  feeBps?: number;                 // Fee in basis points (default: 100 = 1%)
  strategy?: StrategyType;         // Liquidity distribution strategy (default: Spot)
  rangeInterval?: number;          // Number of bins above active bin (default: 10)
  initialPrice: number;            // Initial price (tokenY per tokenX, e.g., SOL per rift)
  mcapRange?: {                    // Optional MCap-based pricing
    minMcap: number;               // Minimum market cap in SOL
    maxMcap: number;               // Maximum market cap in SOL
    tokenSupply: number;           // Total token supply
  };
  forceCreateNew?: boolean;        // If true, throw error if pool already exists (don't add to existing)
  wallet: {
    publicKey: PublicKey;
    signTransaction: (tx: Transaction) => Promise<Transaction>;
    signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
    sendTransaction?: (tx: Transaction, connection: Connection) => Promise<string>;
  };
  connection: Connection;
  onProgress?: (step: number, message: string) => void;
}

export interface DLMMPoolCreateResult {
  success: boolean;
  poolAddress?: string;
  positionAddress?: string;
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
        9: 'Invalid number of signers',
        10: 'Invalid signer',
        11: 'Overflow in token operation',
        12: 'Authority required',
        13: 'Mint has no mint authority',
        14: 'Mint has no freeze authority',
      };

      // DLMM specific errors (codes 6000+)
      const dlmmErrors: Record<number, string> = {
        6000: 'Invalid bin index',
        6001: 'Invalid bin ID',
        6002: 'Invalid input data',
        6003: 'Price slippage exceeded',
        6004: 'Bin slippage exceeded',
        6005: 'Invalid composition factor',
        6006: 'Bin step not in preset list',
        6007: 'Zero liquidity - must deposit tokens',
        6008: 'Invalid position',
        6009: 'Bin array not found',
        6010: 'Invalid token mint for this pool',
        6011: 'Invalid account for single-sided deposit',
        6012: 'Insufficient liquidity in pool',
        6040: 'Price moved too much - retry transaction or increase slippage',
        6041: 'Bin range exceeded maximum allowed',
        6042: 'Invalid bin array bitmap extension',
      };

      // Check DLMM errors first (6000+)
      if (customCode >= 6000 && dlmmErrors[customCode]) {
        return dlmmErrors[customCode];
      }

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
        'ArithmeticOverflow': 'Calculation overflow - amount too large',
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
 * Detect which token program a mint uses
 */
async function detectTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  try {
    const accountInfo = await connection.getAccountInfo(mint);
    if (!accountInfo) {
      return TOKEN_2022_PROGRAM_ID;
    }
    if (accountInfo.owner.equals(TOKEN_PROGRAM_ID)) {
      return TOKEN_PROGRAM_ID;
    }
    return TOKEN_2022_PROGRAM_ID;
  } catch {
    return TOKEN_2022_PROGRAM_ID;
  }
}

/**
 * Calculate active bin ID from price
 * DLMM price formula: price = (1 + binStep/10000)^binId * 10^(tokenXDecimals - tokenYDecimals)
 */
function calculateActiveBinFromPrice(
  price: number,
  binStep: number,
  tokenXDecimals: number,
  tokenYDecimals: number
): number {
  // binId = log(price * 10^(tokenYDecimals - tokenXDecimals)) / log(1 + binStep/10000)
  const decimalFactor = Math.pow(10, tokenYDecimals - tokenXDecimals);
  const adjustedPrice = price * decimalFactor;
  const binId = Math.round(Math.log(adjustedPrice) / Math.log(1 + binStep / 10000));
  return binId;
}

/**
 * Calculate price from bin ID
 */
function calculatePriceFromBin(
  binId: number,
  binStep: number,
  tokenXDecimals: number,
  tokenYDecimals: number
): number {
  const decimalFactor = Math.pow(10, tokenXDecimals - tokenYDecimals);
  return Math.pow(1 + binStep / 10000, binId) * decimalFactor;
}

/**
 * Confirm transaction using polling
 */
async function confirmTransactionPolling(
  connection: Connection,
  signature: string,
  maxRetries = 30
): Promise<void> {
  console.log('[DLMM-POOL] Confirming tx via polling:', signature.slice(0, 20) + '...');

  let notFoundCount = 0;
  const MAX_NOT_FOUND = 10; // If not found after 10 checks, tx likely never submitted

  for (let i = 0; i < maxRetries; i++) {
    try {
      const status = await connection.getSignatureStatus(signature);

      if (status?.value?.err) {
        const errorStr = JSON.stringify(status.value.err);
        console.error('[DLMM-POOL] Transaction failed:', errorStr);
        throw new Error(`Transaction failed: ${errorStr}`);
      }

      if (status?.value?.confirmationStatus === 'confirmed' ||
          status?.value?.confirmationStatus === 'finalized') {
        console.log('[DLMM-POOL] Transaction confirmed:', status.value.confirmationStatus);
        return;
      }

      // Track how many times we get null (tx not found)
      if (!status?.value) {
        notFoundCount++;
        console.log(`[DLMM-POOL] Tx not found yet (${notFoundCount}/${MAX_NOT_FOUND})...`);

        // If tx not found after several checks, it likely was never submitted
        if (notFoundCount >= MAX_NOT_FOUND) {
          throw new Error('Transaction was not received by the network. Please try again.');
        }
      } else {
        // Reset if we get any status
        notFoundCount = 0;
        console.log(`[DLMM-POOL] Tx pending (attempt ${i + 1}/${maxRetries})...`);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Transaction failed') || errorMessage.includes('not received')) {
        throw error;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error('Transaction confirmation timeout - transaction may have expired');
}

/**
 * Simulate transaction via RPC proxy
 */
async function simulateTransaction(
  connection: Connection,
  tx: Transaction
): Promise<void> {
  if (typeof window === 'undefined') {
    const simulation = await connection.simulateTransaction(tx);
    if (simulation.value.err) {
      throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }
    return;
  }

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
    throw new Error(simJson.error.message || 'Pool simulation RPC error');
  }

  if (simJson.result?.value?.err) {
    throw new Error(`Pool creation failed: ${parseSimulationError(simJson.result.value.err)}`);
  }

  console.log('[DLMM-POOL] Simulation passed, units:', simJson.result?.value?.unitsConsumed);
}

// ============ MAIN SERVICE CLASS ============

export class DLMMPoolService {
  private connection: Connection;
  private dlmmSdk: any = null;

  constructor(connection: Connection) {
    this.connection = createProxiedConnection(connection);
  }

  /**
   * Update the connection
   */
  updateConnection(newConnection: Connection): void {
    this.connection = createProxiedConnection(newConnection);
    this.dlmmSdk = null;
  }

  /**
   * Initialize the DLMM SDK
   */
  private async initSdk(): Promise<void> {
    if (!this.dlmmSdk) {
      const DLMM = await import('@meteora-ag/dlmm');
      this.dlmmSdk = DLMM.default || DLMM;
      console.log('[DLMM-POOL] SDK initialized');
    }
  }

  /**
   * Create a new DLMM pool with single-sided liquidity
   * Only tokenX is deposited, bins are placed above active bin for selling
   */
  async createPool(params: DLMMPoolCreateParams): Promise<DLMMPoolCreateResult> {
    const {
      tokenXMint,
      tokenYMint,
      tokenXAmount,
      binStep,
      feeBps = 100, // 1% default
      strategy = StrategyType.Spot,
      rangeInterval = 10,
      initialPrice,
      mcapRange,
      forceCreateNew = false,
      wallet,
      onProgress,
    } = params;

    try {
      onProgress?.(1, 'Initializing DLMM pool creation...');

      // Initialize SDK
      await this.initSdk();

      // Convert mints to PublicKey
      const tokenX = typeof tokenXMint === 'string' ? new PublicKey(tokenXMint) : tokenXMint;
      const tokenY = typeof tokenYMint === 'string' ? new PublicKey(tokenYMint) : tokenYMint;

      console.log('[DLMM-POOL] Creating single-sided pool:', {
        tokenX: tokenX.toBase58(),
        tokenY: tokenY.toBase58(),
        tokenXAmount,
        binStep,
        feeBps,
        initialPrice,
      });

      onProgress?.(2, 'Fetching token information...');

      // Get token decimals
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
          console.log('[DLMM-POOL] Could not fetch tokenX decimals, using 9');
        }
      }

      // Token Y (usually SOL)
      if (tokenY.equals(NATIVE_MINT) || tokenY.toBase58() === WSOL_MINT.toBase58()) {
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
            console.log('[DLMM-POOL] Could not fetch tokenY decimals, using 9');
          }
        }
      }

      console.log('[DLMM-POOL] Token decimals:', { tokenXDecimals, tokenYDecimals });

      // Calculate active bin ID from initial price
      const activeBinId = calculateActiveBinFromPrice(initialPrice, binStep, tokenXDecimals, tokenYDecimals);
      console.log('[DLMM-POOL] Calculated active bin:', activeBinId, 'from price:', initialPrice);

      onProgress?.(3, 'Checking for existing pool...');

      // Check if pool already exists
      let poolAlreadyExists = false;
      let poolAddress: PublicKey | undefined;

      try {
        let existingPairKey = await this.dlmmSdk.getCustomizablePermissionlessLbPairIfExists(
          this.connection,
          tokenX,
          tokenY
        );

        if (!existingPairKey) {
          existingPairKey = await this.dlmmSdk.getCustomizablePermissionlessLbPairIfExists(
            this.connection,
            tokenY,
            tokenX
          );
        }

        if (existingPairKey) {
          poolAlreadyExists = true;
          poolAddress = existingPairKey;
          console.log('[DLMM-POOL] Found existing pool:', existingPairKey.toBase58());
        }
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.log('[DLMM-POOL] Pool existence check failed:', errorMessage.slice(0, 100));
      }

      // If forceCreateNew is true, always create a new pool (skip existence check)
      // The SDK's getPairPubkeyIfExists may find different pool types (permissioned vs customizable)
      // Meteora allows multiple customizable permissionless pools for the same token pair
      let needsPoolCreation: boolean;

      if (forceCreateNew) {
        console.log('[DLMM-POOL] forceCreateNew=true, will create new pool (ignoring existence check)');
        needsPoolCreation = true;
        poolAlreadyExists = false; // Override - we're forcing creation
        onProgress?.(4, 'Creating new DLMM pool...');
      } else if (poolAlreadyExists && poolAddress) {
        console.log('[DLMM-POOL] Pool exists, will add liquidity to existing pool');
        needsPoolCreation = false;
        onProgress?.(4, 'Pool exists, adding liquidity...');
      } else {
        needsPoolCreation = true;
        onProgress?.(4, 'Creating DLMM pool...');
      }

      // Derive the pool address (different derivation for forceCreateNew)
      let newPoolAddress: PublicKey;
      let presetParameterPubkey: PublicKey | undefined;

      if (forceCreateNew) {
        // For createLbPair2, we need to find an existing preset parameter that matches our binStep
        // Meteora pre-deploys preset parameters for specific binStep/baseFactor combinations
        // Multiple presets may exist for the same binStep (at different indexes)
        // We need to find one where a pool doesn't already exist for our token pair
        console.log('[DLMM-POOL] Fetching preset parameters for binStep:', binStep);

        try {
          // Get all preset parameters from chain
          const allPresets = await this.dlmmSdk.getAllPresetParameters(this.connection);
          console.log('[DLMM-POOL] Found presets:', {
            presetParameter: allPresets.presetParameter?.length || 0,
            presetParameter2: allPresets.presetParameter2?.length || 0
          });

          // Find ALL preset parameters that match our binStep
          // presetParameter2 is for createLbPair2
          const matchingPresets = (allPresets.presetParameter2 || []).filter(
            (preset: any) => preset.account.binStep === binStep
          );

          console.log('[DLMM-POOL] Found', matchingPresets.length, 'preset parameters for binStep', binStep);

          // Import derive function once
          const { deriveLbPairWithPresetParamWithIndexKey } = await import('@meteora-ag/dlmm');

          // Try each matching preset until we find one where a pool doesn't exist
          let foundUnusedPreset = false;
          for (const preset of matchingPresets) {
            const presetPubkey = preset.publicKey;
            const [derivedPoolAddr] = deriveLbPairWithPresetParamWithIndexKey(presetPubkey, tokenX, tokenY, DLMM_PROGRAM_ID);

            // Check if this pool already exists
            const poolAccountInfo = await this.connection.getAccountInfo(derivedPoolAddr);

            if (!poolAccountInfo) {
              // Pool doesn't exist with this preset - use it!
              presetParameterPubkey = presetPubkey;
              newPoolAddress = derivedPoolAddr;
              foundUnusedPreset = true;
              console.log('[DLMM-POOL] Found unused preset parameter:', {
                pubkey: presetPubkey.toBase58(),
                binStep: preset.account.binStep,
                baseFactor: preset.account.baseFactor,
                poolAddress: derivedPoolAddr.toBase58(),
              });
              break;
            } else {
              console.log('[DLMM-POOL] Pool already exists with preset', presetPubkey.toBase58().slice(0, 10) + '...', 'trying next...');
            }
          }

          if (!foundUnusedPreset) {
            // All presets for this binStep are already used, fall back to customizable permissionless
            console.log('[DLMM-POOL] All preset parameters for binStep', binStep, 'are already used');
            console.log('[DLMM-POOL] Falling back to customizable permissionless pool');
            const { deriveCustomizablePermissionlessLbPair } = await import('@meteora-ag/dlmm');
            const [poolAddr] = deriveCustomizablePermissionlessLbPair(tokenX, tokenY, DLMM_PROGRAM_ID);
            newPoolAddress = poolAddr;
            presetParameterPubkey = undefined;
          }
        } catch (presetError) {
          console.error('[DLMM-POOL] Error fetching preset parameters:', presetError);
          // Fall back to customizable permissionless
          const { deriveCustomizablePermissionlessLbPair } = await import('@meteora-ag/dlmm');
          const [poolAddr] = deriveCustomizablePermissionlessLbPair(tokenX, tokenY, DLMM_PROGRAM_ID);
          newPoolAddress = poolAddr;
          presetParameterPubkey = undefined;
        }
      } else {
        // For customizable permissionless, derive without preset
        const { deriveCustomizablePermissionlessLbPair } = await import('@meteora-ag/dlmm');
        const [poolAddr] = deriveCustomizablePermissionlessLbPair(tokenX, tokenY, DLMM_PROGRAM_ID);
        newPoolAddress = poolAddr;
      }

      console.log('[DLMM-POOL] Expected pool address:', newPoolAddress!.toBase58());

      // Only create pool if it doesn't exist
      if (needsPoolCreation) {
        let createPoolTx: Transaction;

        if (forceCreateNew && presetParameterPubkey) {
          // Use createLbPair2 which derives pool address using preset parameter
          // This allows creating multiple pools for the same token pair
          console.log('[DLMM-POOL] Using createLbPair2 for new pool creation (allows multiple pools per token pair)');
          console.log('[DLMM-POOL] Preset parameter:', presetParameterPubkey.toBase58());

          createPoolTx = await this.dlmmSdk.createLbPair2(
            this.connection,
            wallet.publicKey,
            tokenX,
            tokenY,
            presetParameterPubkey,
            new BN(activeBinId)
          );
        } else {
          // Use createCustomizablePermissionlessLbPair2 (single pool per token pair)
          // Note: If forceCreateNew was true but no preset was found, this is a fallback
          if (forceCreateNew) {
            console.warn('[DLMM-POOL] Warning: forceCreateNew requested but no preset parameter found for binStep', binStep);
            console.warn('[DLMM-POOL] Falling back to customizable permissionless pool (only one pool per token pair allowed)');
          }
          createPoolTx = await this.dlmmSdk.createCustomizablePermissionlessLbPair2(
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
        }

        // Add compute budget
        createPoolTx.instructions.unshift(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 })
        );

        // Set fee payer and blockhash
        createPoolTx.feePayer = wallet.publicKey;
        if (!createPoolTx.recentBlockhash) {
          const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
          createPoolTx.recentBlockhash = blockhash;
        }

        onProgress?.(5, 'Simulating pool creation...');

        // Simulate before sending
        await simulateTransaction(this.connection, createPoolTx);

        onProgress?.(6, 'Please sign the transaction...');

        // Sign and send transaction via RPC proxy for reliability
        const signedPoolTx = await wallet.signTransaction(createPoolTx);
        const poolTxSerialized = signedPoolTx.serialize();

        let poolSignature: string;
        if (typeof window !== 'undefined') {
          // Browser: use RPC HTTP proxy directly
          const txBase64 = poolTxSerialized.toString('base64');
          console.log('[DLMM-POOL] Sending pool creation via /api/rpc-http proxy...');

          const rpcResponse = await fetch('/api/rpc-http', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'send_dlmm_pool',
              method: 'sendTransaction',
              params: [
                txBase64,
                {
                  encoding: 'base64',
                  skipPreflight: false,
                  maxRetries: 5,
                  preflightCommitment: 'confirmed'
                }
              ]
            })
          });

          const rpcJson = await rpcResponse.json();
          if (rpcJson.error) {
            throw new Error(`Pool creation RPC error: ${rpcJson.error.message || JSON.stringify(rpcJson.error)}`);
          }
          poolSignature = rpcJson.result;
        } else {
          poolSignature = await this.connection.sendRawTransaction(poolTxSerialized, {
            skipPreflight: false,
            preflightCommitment: 'confirmed'
          });
        }

        console.log('[DLMM-POOL] Pool creation tx sent:', poolSignature);

        onProgress?.(7, 'Confirming pool creation...');

        await confirmTransactionPolling(this.connection, poolSignature);

        poolAddress = newPoolAddress!;
        console.log('[DLMM-POOL] Pool created at:', poolAddress.toBase58());

        // Wait for pool to be available
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        // Pool already exists, use existing address
        console.log('[DLMM-POOL] Using existing pool:', poolAddress!.toBase58());
      }

      onProgress?.(8, 'Adding liquidity...');

      // Fetch the pool
      const finalPoolAddress = poolAddress || newPoolAddress!;
      let dlmmPool: any = null;
      for (let attempt = 1; attempt <= 10; attempt++) {
        try {
          dlmmPool = await this.dlmmSdk.create(this.connection, finalPoolAddress);
          break;
        } catch {
          if (attempt === 10) throw new Error('Failed to fetch pool');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      // Update poolAddress for return value
      poolAddress = finalPoolAddress;

      // For existing pools, get the actual active bin from the pool
      let effectiveActiveBinId = activeBinId;
      if (!needsPoolCreation && dlmmPool) {
        try {
          // Refresh pool state to get current active bin
          await dlmmPool.refetchStates();
          const poolActiveBin = dlmmPool.lbPair?.activeId || dlmmPool.getActiveBin?.()?.binId;
          if (poolActiveBin !== undefined) {
            effectiveActiveBinId = poolActiveBin;
            console.log('[DLMM-POOL] Using pool active bin:', effectiveActiveBinId);
          }
        } catch (e) {
          console.log('[DLMM-POOL] Could not get pool active bin, using calculated:', activeBinId);
        }
      }

      // Calculate bin range for single-sided liquidity
      // Bins are placed ABOVE active bin for selling tokenX as price rises
      let minBinId: number;
      let maxBinId: number;
      let effectiveXAmount = tokenXAmount;

      // IMPORTANT: Limit bin range to avoid "InvalidRealloc" error
      // Single transactions can only handle limited bins due to account realloc limits
      // Being conservative with 50 bins to ensure success
      const MAX_BINS_PER_TX = 50;

      // Check for MCap-based range
      if (mcapRange && mcapRange.tokenSupply > 0 && mcapRange.minMcap > 0 && mcapRange.maxMcap > 0) {
        const minPriceSOL = mcapRange.minMcap / mcapRange.tokenSupply;
        const maxPriceSOL = mcapRange.maxMcap / mcapRange.tokenSupply;

        minBinId = calculateActiveBinFromPrice(minPriceSOL, binStep, tokenXDecimals, tokenYDecimals);
        maxBinId = calculateActiveBinFromPrice(maxPriceSOL, binStep, tokenXDecimals, tokenYDecimals);

        // Ensure min < max
        if (minBinId > maxBinId) {
          [minBinId, maxBinId] = [maxBinId, minBinId];
        }

        // CRITICAL: For single-sided X liquidity, bins must be ABOVE the active bin
        // The active bin is where trading happens - you can't deposit single-sided there
        if (minBinId <= effectiveActiveBinId) {
          console.log(`[DLMM-POOL] Adjusting minBinId from ${minBinId} to ${effectiveActiveBinId + 1} (must be above active bin)`);
          minBinId = effectiveActiveBinId + 1;
        }

        // If after adjustment minBinId > maxBinId, we need to adjust maxBinId too
        if (minBinId > maxBinId) {
          maxBinId = minBinId + Math.min(rangeInterval, MAX_BINS_PER_TX - 1);
          console.log(`[DLMM-POOL] Adjusted maxBinId to ${maxBinId} after minBinId correction`);
        }

        // Cap bin range to avoid realloc error
        const binCount = maxBinId - minBinId + 1;
        if (binCount > MAX_BINS_PER_TX) {
          console.log(`[DLMM-POOL] Bin range ${binCount} exceeds max ${MAX_BINS_PER_TX}, capping...`);
          maxBinId = minBinId + MAX_BINS_PER_TX - 1;
        }

        console.log('[DLMM-POOL] MCap-based bin range (after adjustments):', {
          minBinId,
          maxBinId,
          activeBinId: effectiveActiveBinId,
          minPriceSOL,
          maxPriceSOL,
          binCount: maxBinId - minBinId + 1
        });
      } else {
        // Single-sided: bins above active bin for selling tokenX
        minBinId = effectiveActiveBinId + 1;
        // Cap range interval to avoid realloc error
        const effectiveRange = Math.min(rangeInterval, MAX_BINS_PER_TX - 1);
        maxBinId = effectiveActiveBinId + effectiveRange;
        console.log('[DLMM-POOL] Single-sided bin range:', {
          minBinId,
          maxBinId,
          activeBinId: effectiveActiveBinId,
          rangeInterval,
          effectiveRange
        });
      }

      // Check user's token balance
      const tokenXProgram = await detectTokenProgram(this.connection, tokenX);
      try {
        const userTokenXAccount = await getAssociatedTokenAddress(
          tokenX,
          wallet.publicKey,
          false,
          tokenXProgram
        );
        const tokenAccount = await getAccount(this.connection, userTokenXAccount, 'confirmed', tokenXProgram);
        const actualBalance = Number(tokenAccount.amount) / Math.pow(10, tokenXDecimals);

        if (actualBalance < effectiveXAmount) {
          console.log('[DLMM-POOL] Adjusting amount due to transfer fees:', actualBalance);
          effectiveXAmount = actualBalance * 0.99; // Leave 1% buffer for fees
        }
      } catch {
        console.log('[DLMM-POOL] Could not check token balance');
      }

      // Convert to BN (single-sided: only tokenX, no tokenY)
      const tokenXAmountBN = new BN(Math.floor(effectiveXAmount * Math.pow(10, tokenXDecimals)));
      const tokenYAmountBN = new BN(0); // Single-sided: no SOL deposited

      // Generate position keypair
      const positionKeypair = Keypair.generate();

      console.log('[DLMM-POOL] Building liquidity transaction...', {
        positionPubKey: positionKeypair.publicKey.toBase58(),
        totalXAmount: tokenXAmountBN.toString(),
        totalYAmount: tokenYAmountBN.toString(),
        minBinId,
        maxBinId,
        strategy,
        binCount: maxBinId - minBinId + 1
      });

      // Add liquidity using single-sided strategy
      // Use try-catch to handle SDK's internal simulation errors
      let sdkTx: Transaction | VersionedTransaction;
      try {
        sdkTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
          positionPubKey: positionKeypair.publicKey,
          user: wallet.publicKey,
          totalXAmount: tokenXAmountBN,
          totalYAmount: tokenYAmountBN,
          strategy: {
            maxBinId,
            minBinId,
            strategyType: strategy,
            singleSidedX: true  // Always single-sided for selling tokenX
          },
          slippage: 100 // 1% slippage
        });
      } catch (sdkError: any) {
        // If SDK fails (often due to internal simulation), log and re-throw with better message
        const errorMsg = sdkError?.message || String(sdkError);
        console.error('[DLMM-POOL] SDK error building liquidity tx:', errorMsg);

        // Check for common errors
        if (errorMsg.includes('InvalidRealloc') || errorMsg.includes('realloc')) {
          throw new Error(`Bin range too large (${maxBinId - minBinId + 1} bins). Try reducing the range interval.`);
        }
        throw new Error(`Failed to build liquidity transaction: ${errorMsg.slice(0, 100)}`);
      }

      // Check if SDK returned a VersionedTransaction or legacy Transaction
      const isVersionedTx = sdkTx instanceof VersionedTransaction ||
                            ('version' in sdkTx) ||
                            !('instructions' in sdkTx);

      console.log('[DLMM-POOL] SDK returned transaction type:', isVersionedTx ? 'VersionedTransaction' : 'LegacyTransaction');

      // Get fresh blockhash
      const { blockhash: liqBlockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');

      let finalTx: Transaction | VersionedTransaction;

      if (isVersionedTx) {
        // Handle VersionedTransaction - need to rebuild with compute budget
        const versionedTx = sdkTx as VersionedTransaction;

        // For VersionedTransaction, we need to decompile, add instructions, and recompile
        // Or we can try to use it as-is since SDK should have set compute budget
        console.log('[DLMM-POOL] Using VersionedTransaction as-is from SDK');

        // Sign with position keypair
        versionedTx.sign([positionKeypair]);

        finalTx = versionedTx;
      } else {
        // Handle legacy Transaction
        const legacyTx = sdkTx as Transaction;

        // Check if SDK already added compute budget instructions
        const COMPUTE_BUDGET_ID = 'ComputeBudget111111111111111111111111111111';
        const hasComputeBudget = legacyTx.instructions.some(
          (ix: any) => ix.programId?.toBase58() === COMPUTE_BUDGET_ID
        );

        if (!hasComputeBudget) {
          // Add compute budget only if SDK didn't add it
          legacyTx.instructions.unshift(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 })
          );
          console.log('[DLMM-POOL] Added compute budget instructions');
        } else {
          console.log('[DLMM-POOL] SDK already has compute budget, skipping');
        }

        // Set blockhash and fee payer
        legacyTx.recentBlockhash = liqBlockhash;
        legacyTx.feePayer = wallet.publicKey;

        // Partial sign with position keypair
        legacyTx.partialSign(positionKeypair);

        finalTx = legacyTx;
      }

      console.log('[DLMM-POOL] Transaction partially signed with position keypair');

      onProgress?.(9, 'Please sign the liquidity transaction...');

      // Send liquidity transaction
      let liqSignature: string;
      try {
        console.log('[DLMM-POOL] Requesting wallet signature...');

        let serializedTx: Uint8Array;

        if (isVersionedTx) {
          // Handle VersionedTransaction
          const versionedTx = finalTx as VersionedTransaction;

          // Request wallet to sign the versioned transaction
          // Most wallets support signTransaction for versioned transactions
          const signedTx = await wallet.signTransaction(versionedTx as any);

          console.log('[DLMM-POOL] Wallet signature obtained for VersionedTransaction');

          // Serialize the signed versioned transaction
          serializedTx = (signedTx as unknown as VersionedTransaction).serialize();
          console.log('[DLMM-POOL] VersionedTransaction serialized, size:', serializedTx.length, 'bytes');

        } else {
          // Handle legacy Transaction
          const legacyTx = finalTx as Transaction;

          // Log existing signatures
          console.log('[DLMM-POOL] Existing signatures:', legacyTx.signatures.map(s => ({
            pubkey: s.publicKey.toBase58().slice(0, 10) + '...',
            signed: s.signature !== null
          })));

          const signedLiqTx = await wallet.signTransaction(legacyTx);

          console.log('[DLMM-POOL] Wallet signature obtained');
          console.log('[DLMM-POOL] Final signatures:', signedLiqTx.signatures.map(s => ({
            pubkey: s.publicKey.toBase58().slice(0, 10) + '...',
            signed: s.signature !== null
          })));

          // Verify all signatures are present
          const allSigned = signedLiqTx.signatures.every(s => s.signature !== null);
          if (!allSigned) {
            const missing = signedLiqTx.signatures
              .filter(s => s.signature === null)
              .map(s => s.publicKey.toBase58().slice(0, 10));
            throw new Error(`Missing signatures from: ${missing.join(', ')}`);
          }

          serializedTx = signedLiqTx.serialize();
          console.log('[DLMM-POOL] LegacyTransaction serialized, size:', serializedTx.length, 'bytes');
        }

        // Check transaction size
        if (serializedTx.length > 1644) {
          throw new Error(`Transaction too large: ${serializedTx.length} bytes (max ~1644)`);
        }

        console.log('[DLMM-POOL] All signatures verified, sending transaction...');

        // Send the transaction - use RPC HTTP proxy directly for browser environments
        console.log('[DLMM-POOL] Sending raw transaction to network...');

        if (typeof window !== 'undefined') {
          // Browser: use RPC HTTP proxy directly (more reliable)
          const txBase64 = Buffer.from(serializedTx).toString('base64');
          console.log('[DLMM-POOL] Sending via /api/rpc-http proxy...');

          const rpcResponse = await fetch('/api/rpc-http', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'send_dlmm_liq',
              method: 'sendTransaction',
              params: [
                txBase64,
                {
                  encoding: 'base64',
                  skipPreflight: false,  // Run preflight to catch errors
                  maxRetries: 5,
                  preflightCommitment: 'confirmed'
                }
              ]
            })
          });

          const rpcJson = await rpcResponse.json();
          console.log('[DLMM-POOL] RPC response:', rpcJson);

          if (rpcJson.error) {
            const errorMsg = rpcJson.error.message || JSON.stringify(rpcJson.error);
            console.error('[DLMM-POOL] RPC error:', errorMsg);

            // Check for common RPC errors
            if (errorMsg.includes('blockhash not found') || errorMsg.includes('Blockhash not found')) {
              throw new Error('Transaction expired. Please try again.');
            }
            if (errorMsg.includes('insufficient funds') || errorMsg.includes('Insufficient')) {
              throw new Error('Insufficient SOL for transaction fees.');
            }

            throw new Error(`RPC error: ${errorMsg}`);
          }

          liqSignature = rpcJson.result;
          console.log('[DLMM-POOL] Transaction sent via RPC proxy:', liqSignature);
        } else {
          // Server-side: use connection directly
          liqSignature = await this.connection.sendRawTransaction(Buffer.from(serializedTx), {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 5
          });
          console.log('[DLMM-POOL] sendRawTransaction returned:', liqSignature);
        }

        // Verify we got a valid-looking signature
        if (!liqSignature || liqSignature.length < 80) {
          throw new Error(`Invalid signature returned: ${liqSignature}`);
        }

      } catch (sendError: any) {
        console.error('[DLMM-POOL] Error signing/sending liquidity tx:', sendError);
        const errorMsg = sendError?.message || String(sendError);

        // Check for common wallet errors
        if (errorMsg.includes('User rejected') || errorMsg.includes('rejected')) {
          throw new Error('Transaction was rejected by wallet');
        }
        if (errorMsg.includes('insufficient') || errorMsg.includes('balance')) {
          throw new Error('Insufficient balance for transaction');
        }

        throw new Error(`Failed to sign/send transaction: ${errorMsg.slice(0, 150)}`);
      }

      console.log('[DLMM-POOL] Liquidity tx sent:', liqSignature);

      onProgress?.(10, 'Confirming liquidity addition...');

      await confirmTransactionPolling(this.connection, liqSignature);

      console.log('[DLMM-POOL] Pool created and liquidity added successfully:', {
        poolAddress: poolAddress.toBase58(),
        positionAddress: positionKeypair.publicKey.toBase58(),
      });

      onProgress?.(11, 'Pool created successfully!');

      return {
        success: true,
        poolAddress: poolAddress.toBase58(),
        positionAddress: positionKeypair.publicKey.toBase58(),
        signature: liqSignature,
      };

    } catch (error) {
      console.error('[DLMM-POOL] Error creating pool:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if a pool already exists for the given token pair
   */
  async poolExists(
    tokenXMint: string | PublicKey,
    tokenYMint: string | PublicKey
  ): Promise<{ exists: boolean; poolAddress?: string }> {
    try {
      await this.initSdk();

      const tokenX = typeof tokenXMint === 'string' ? new PublicKey(tokenXMint) : tokenXMint;
      const tokenY = typeof tokenYMint === 'string' ? new PublicKey(tokenYMint) : tokenYMint;

      let existingPairKey = await this.dlmmSdk.getCustomizablePermissionlessLbPairIfExists(
        this.connection,
        tokenX,
        tokenY
      );

      if (!existingPairKey) {
        existingPairKey = await this.dlmmSdk.getCustomizablePermissionlessLbPairIfExists(
          this.connection,
          tokenY,
          tokenX
        );
      }

      return {
        exists: !!existingPairKey,
        poolAddress: existingPairKey?.toBase58(),
      };
    } catch {
      return { exists: false };
    }
  }
}

// ============ SINGLETON EXPORT ============

let serviceInstance: DLMMPoolService | null = null;

export function getDLMMPoolService(connection: Connection): DLMMPoolService {
  if (!serviceInstance) {
    serviceInstance = new DLMMPoolService(connection);
  } else {
    serviceInstance.updateConnection(connection);
  }
  return serviceInstance;
}

/**
 * Convenience function to create a single-sided DLMM pool
 */
export async function createDLMMPool(
  params: DLMMPoolCreateParams
): Promise<DLMMPoolCreateResult> {
  const service = getDLMMPoolService(params.connection);
  return service.createPool(params);
}

// Re-export utilities
export { calculateActiveBinFromPrice, calculatePriceFromBin };
