/**
 * PumpFun Launch + Auto Monorift Service
 *
 * Creates a pump.fun token with dev buy AND a DAMMV2 single-sided monorift
 * in a single atomic Jito bundle.
 *
 * Flow:
 * 1. Generate mint keypair
 * 2. Build TX1: Create token + dev buy (user signs)
 * 3. Build TX2: Create DAMMV2 single-sided pool (user signs)
 * 4. Bundle via Jito for atomic execution
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  VersionedTransaction,
  ComputeBudgetProgram,
  TransactionMessage,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';
import bs58 from 'bs58';

// ============ CONSTANTS ============

const PUMPPORTAL_API = 'https://pumpportal.fun/api';
const PUMPFUN_IPFS_API = 'https://pump.fun/api/ipfs';
const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

// DAMMV2 Program ID
const DAMMV2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// ============ TYPES ============

export interface PumpFunLaunchRiftParams {
  // Token metadata
  name: string;
  symbol: string;
  description: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  image: File;
  banner?: File;

  // Dev buy amount in SOL
  devBuyAmountSol: number;

  // Monorift settings
  initialPriceSol: number; // Price in SOL per token

  // Wallet
  creatorPublicKey: string;

  // Callbacks
  onProgress?: (step: number, message: string) => void;
}

export interface PreparedLaunchRift {
  success: boolean;

  // Mint info
  mintPublicKey?: string;
  mintSecretKey?: string;
  metadataUri?: string;

  // Transactions to sign (base64 encoded)
  createTxBase64?: string;
  poolTxBase64?: string;

  // Pool info
  poolAddress?: string;
  positionNftSecretKey?: string;

  error?: string;
}

export interface LaunchRiftResult {
  success: boolean;
  mint?: string;
  poolAddress?: string;
  bundleId?: string;
  signature?: string;
  error?: string;
}

// ============ HELPER FUNCTIONS ============

/**
 * Upload metadata to IPFS via pump.fun
 */
async function uploadMetadata(
  metadata: { name: string; symbol: string; description: string; twitter?: string; telegram?: string; website?: string },
  image: File,
  banner?: File
): Promise<string> {
  const formData = new FormData();
  formData.append('file', image);
  formData.append('name', metadata.name);
  formData.append('symbol', metadata.symbol);
  formData.append('description', metadata.description);
  if (metadata.twitter) formData.append('twitter', metadata.twitter);
  if (metadata.telegram) formData.append('telegram', metadata.telegram);
  if (metadata.website) formData.append('website', metadata.website);
  if (banner) formData.append('banner', banner);
  formData.append('showName', 'true');

  const response = await fetch(PUMPFUN_IPFS_API, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload metadata: ${await response.text()}`);
  }

  const result = await response.json();
  return result.metadataUri;
}

/**
 * Get create token transaction from PumpPortal
 */
async function getCreateTokenTx(
  creatorPublicKey: string,
  mintPublicKey: string,
  metadataUri: string,
  name: string,
  symbol: string,
  devBuyAmountSol: number
): Promise<Uint8Array> {
  const response = await fetch(`${PUMPPORTAL_API}/trade-local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: creatorPublicKey,
      action: 'create',
      tokenMetadata: { name, symbol, uri: metadataUri },
      mint: mintPublicKey,
      denominatedInSol: 'true',
      amount: devBuyAmountSol,
      slippage: 10,
      priorityFee: 0.001,
      pool: 'pump',
    }),
  });

  if (!response.ok) {
    throw new Error(`PumpPortal error: ${await response.text()}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Build DAMMV2 single-sided pool creation transaction
 * This is a simplified version that doesn't check balances (for bundled execution)
 */
async function buildPoolCreationTx(
  connection: Connection,
  creatorPublicKey: PublicKey,
  tokenMint: PublicKey,
  tokenAmount: number, // Amount of tokens to deposit (from dev buy)
  initialPriceSol: number,
  positionNft: Keypair
): Promise<{ tx: Transaction; poolAddress: string }> {
  // Import SDK
  const { CpAmm, getSqrtPriceFromPrice, derivePoolAddress } = await import('@meteora-ag/cp-amm-sdk');

  const cpAmm = new CpAmm(connection);

  // Token decimals - pump.fun tokens are 6 decimals
  const tokenDecimals = 6;
  const solDecimals = 9;

  // Find an available config
  const allConfigs = await cpAmm.getAllConfigs();
  let selectedConfig: PublicKey | null = null;
  let poolAddress: PublicKey | null = null;

  for (const { publicKey: config } of allConfigs) {
    try {
      const derivedPool = derivePoolAddress(config, tokenMint, WSOL_MINT);
      const exists = await cpAmm.isPoolExist(derivedPool);

      if (!exists) {
        selectedConfig = config;
        poolAddress = derivedPool;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!selectedConfig || !poolAddress) {
    throw new Error('No available pool config found');
  }

  console.log('[LAUNCH-RIFT] Selected config:', selectedConfig.toBase58());
  console.log('[LAUNCH-RIFT] Pool address:', poolAddress.toBase58());

  // Get config state for price bounds
  const configState = await cpAmm.fetchConfigState(selectedConfig);
  const configMinSqrtPrice = new BN(configState.sqrtMinPrice.toString());
  const configMaxSqrtPrice = new BN(configState.sqrtMaxPrice.toString());

  // For single-sided, use config min price as initial price
  const finalInitSqrtPrice = configMinSqrtPrice;

  // Convert token amount to lamports
  const tokenAmountBN = new BN(Math.floor(tokenAmount * Math.pow(10, tokenDecimals)));

  // Calculate liquidity using BigInt to avoid overflow
  const safeLiquidityDelta = (() => {
    const amountBI = BigInt(tokenAmountBN.toString());
    const lowerBI = BigInt(finalInitSqrtPrice.toString());
    const upperBI = BigInt(configMaxSqrtPrice.toString());
    const denominator = upperBI - lowerBI;
    const numerator = amountBI * lowerBI * upperBI;
    return new BN((numerator / denominator).toString());
  })();

  console.log('[LAUNCH-RIFT] Building pool TX:', {
    tokenAmount,
    tokenAmountBN: tokenAmountBN.toString(),
    liquidityDelta: safeLiquidityDelta.toString(),
  });

  // Build pool creation transaction
  const tx = await cpAmm.createPool({
    payer: creatorPublicKey,
    creator: creatorPublicKey,
    config: selectedConfig,
    positionNft: positionNft.publicKey,
    tokenAMint: tokenMint,
    tokenBMint: WSOL_MINT,
    tokenAAmount: tokenAmountBN,
    tokenBAmount: new BN(0), // Single-sided: no SOL
    initSqrtPrice: finalInitSqrtPrice,
    liquidityDelta: safeLiquidityDelta,
    activationPoint: null,
    tokenAProgram: TOKEN_PROGRAM_ID, // pump.fun uses standard SPL token
    tokenBProgram: TOKEN_PROGRAM_ID,
    isLockLiquidity: false,
  });

  // Add compute budget
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })
  );

  return { tx, poolAddress: poolAddress.toBase58() };
}

/**
 * Send Jito bundle
 */
async function sendJitoBundle(transactions: string[]): Promise<string> {
  for (const endpoint of JITO_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [transactions],
        }),
      });

      const result = await response.json();

      if (result.result) {
        console.log('[LAUNCH-RIFT] Bundle sent:', result.result);
        return result.result;
      }
    } catch (err) {
      continue;
    }
  }

  throw new Error('All Jito endpoints failed');
}

/**
 * Poll for Jito bundle status
 */
async function waitForBundle(bundleId: string, maxRetries = 30): Promise<{ confirmed: boolean; signature?: string }> {
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(r => setTimeout(r, 1000));

    for (const endpoint of JITO_ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBundleStatuses',
            params: [[bundleId]],
          }),
        });

        const result = await response.json();
        const status = result.result?.value?.[0];

        if (status) {
          if (status.confirmation_status === 'confirmed' || status.confirmation_status === 'finalized') {
            return { confirmed: true, signature: status.transactions?.[0] };
          }
          if (status.err) {
            throw new Error(`Bundle failed: ${JSON.stringify(status.err)}`);
          }
        }
      } catch (err: any) {
        if (err.message?.includes('Bundle failed')) throw err;
      }
    }
  }

  return { confirmed: false };
}

// ============ MAIN FUNCTIONS ============

/**
 * Step 1: Prepare the launch + rift transactions
 * Returns transactions for client to sign
 */
export async function prepareLaunchRift(
  params: PumpFunLaunchRiftParams,
  connection: Connection
): Promise<PreparedLaunchRift> {
  const { onProgress } = params;

  try {
    onProgress?.(1, 'Uploading metadata to IPFS...');

    // Upload metadata
    const metadataUri = await uploadMetadata(
      {
        name: params.name,
        symbol: params.symbol,
        description: params.description,
        twitter: params.twitter,
        telegram: params.telegram,
        website: params.website,
      },
      params.image,
      params.banner
    );

    console.log('[LAUNCH-RIFT] Metadata uploaded:', metadataUri);

    onProgress?.(2, 'Generating token mint...');

    // Generate mint keypair
    const mintKeypair = Keypair.generate();
    const mintPublicKey = mintKeypair.publicKey.toBase58();

    console.log('[LAUNCH-RIFT] Mint:', mintPublicKey);

    onProgress?.(3, 'Building create token transaction...');

    // Get create token transaction
    const createTxBytes = await getCreateTokenTx(
      params.creatorPublicKey,
      mintPublicKey,
      metadataUri,
      params.name,
      params.symbol,
      params.devBuyAmountSol
    );

    onProgress?.(4, 'Building pool creation transaction...');

    // Generate position NFT keypair
    const positionNft = Keypair.generate();

    // Estimate tokens received from dev buy
    // pump.fun bonding curve starts at ~0.00000003 SOL per token
    // For simplicity, estimate: devBuyAmountSol / 0.00000003 tokens (very rough)
    // A more accurate calculation would use the bonding curve formula
    const estimatedTokens = params.devBuyAmountSol * 30_000_000; // ~30M tokens per SOL at start

    console.log('[LAUNCH-RIFT] Estimated tokens from dev buy:', estimatedTokens);

    // Build pool creation transaction
    const { tx: poolTx, poolAddress } = await buildPoolCreationTx(
      connection,
      new PublicKey(params.creatorPublicKey),
      mintKeypair.publicKey,
      estimatedTokens,
      params.initialPriceSol,
      positionNft
    );

    // Get blockhash
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    poolTx.recentBlockhash = blockhash;
    poolTx.feePayer = new PublicKey(params.creatorPublicKey);

    // Partial sign pool TX with position NFT
    poolTx.partialSign(positionNft);

    onProgress?.(5, 'Transactions prepared. Ready for signing.');

    return {
      success: true,
      mintPublicKey,
      mintSecretKey: bs58.encode(mintKeypair.secretKey),
      metadataUri,
      createTxBase64: Buffer.from(createTxBytes).toString('base64'),
      poolTxBase64: Buffer.from(poolTx.serialize({ requireAllSignatures: false })).toString('base64'),
      poolAddress,
      positionNftSecretKey: bs58.encode(positionNft.secretKey),
    };

  } catch (error) {
    console.error('[LAUNCH-RIFT] Prepare error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Step 2: Execute the bundled launch + rift
 * Takes signed transactions and sends via Jito
 */
export async function executeLaunchRift(
  signedCreateTxBase64: string,
  signedPoolTxBase64: string,
  mintPublicKey: string,
  poolAddress: string
): Promise<LaunchRiftResult> {
  try {
    console.log('[LAUNCH-RIFT] Executing bundled launch...');

    // Decode transactions
    const createTxBytes = Buffer.from(signedCreateTxBase64, 'base64');
    const poolTxBytes = Buffer.from(signedPoolTxBase64, 'base64');

    // Bundle transactions
    const bundle = [
      bs58.encode(createTxBytes),
      bs58.encode(poolTxBytes),
    ];

    // Send bundle
    const bundleId = await sendJitoBundle(bundle);

    // Wait for confirmation
    const { confirmed, signature } = await waitForBundle(bundleId);

    if (!confirmed) {
      return {
        success: false,
        error: 'Bundle confirmation timeout',
        bundleId,
      };
    }

    console.log('[LAUNCH-RIFT] Bundle confirmed!', { bundleId, signature });

    return {
      success: true,
      mint: mintPublicKey,
      poolAddress,
      bundleId,
      signature,
    };

  } catch (error) {
    console.error('[LAUNCH-RIFT] Execute error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
