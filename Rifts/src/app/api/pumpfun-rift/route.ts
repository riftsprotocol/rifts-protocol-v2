import { NextRequest, NextResponse } from 'next/server';
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import bs58 from 'bs58';

// ============ CONSTANTS ============

const PUMPPORTAL_API = 'https://pumpportal.fun/api';
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

// RPC endpoint
const RPC_URL = process.env.NEXT_PUBLIC_RPC_ENDPOINT || process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Pump.fun bonding curve constants
const PUMPFUN_VIRTUAL_SOL_RESERVES = 30; // 30 SOL virtual reserves
const PUMPFUN_VIRTUAL_TOKEN_RESERVES = 1_073_000_000; // ~1.073B tokens
const PUMPFUN_K = PUMPFUN_VIRTUAL_SOL_RESERVES * PUMPFUN_VIRTUAL_TOKEN_RESERVES;

/**
 * Calculate price and tokens received from pump.fun bonding curve
 * Uses constant product formula: k = solReserves * tokenReserves
 */
function calculatePumpFunBondingCurve(devBuyAmountSol: number): {
  tokensReceived: number;
  priceAfterBuy: number; // SOL per token
} {
  // After dev buy
  const newSolReserves = PUMPFUN_VIRTUAL_SOL_RESERVES + devBuyAmountSol;
  const newTokenReserves = PUMPFUN_K / newSolReserves;
  const tokensReceived = PUMPFUN_VIRTUAL_TOKEN_RESERVES - newTokenReserves;
  const priceAfterBuy = newSolReserves / newTokenReserves;

  return {
    tokensReceived,
    priceAfterBuy,
  };
}

/**
 * POST /api/pumpfun-rift
 *
 * Actions:
 * - prepare: Build both create token + pool creation TXs
 * - execute: Bundle signed TXs and send via Jito
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'prepare') {
      return handlePrepare(body);
    } else if (action === 'execute') {
      return handleExecute(body);
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('[PUMPFUN-RIFT] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * Prepare launch + rift transactions
 */
async function handlePrepare(body: any) {
  const {
    creatorPublicKey,
    metadataUri,
    name,
    symbol,
    devBuyAmountSol,
    initialPriceSol,
  } = body;

  if (!creatorPublicKey || !metadataUri || !name || !symbol || !devBuyAmountSol) {
    return NextResponse.json(
      { error: 'Missing required fields' },
      { status: 400 }
    );
  }

  console.log('[PUMPFUN-RIFT] Preparing launch + rift:', {
    creator: creatorPublicKey,
    name,
    symbol,
    devBuy: devBuyAmountSol,
  });

  const connection = new Connection(RPC_URL, 'confirmed');

  // Generate keypairs
  const mintKeypair = Keypair.generate();
  const positionNft = Keypair.generate();

  console.log('[PUMPFUN-RIFT] Mint:', mintKeypair.publicKey.toBase58());

  // ===== TX1: Create token + dev buy =====
  const createResponse = await fetch(`${PUMPPORTAL_API}/trade-local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: creatorPublicKey,
      action: 'create',
      tokenMetadata: { name, symbol, uri: metadataUri },
      mint: mintKeypair.publicKey.toBase58(),
      denominatedInSol: 'true',
      amount: devBuyAmountSol,
      slippage: 10,
      priorityFee: 0.001,
      pool: 'pump',
    }),
  });

  if (!createResponse.ok) {
    const error = await createResponse.text();
    console.error('[PUMPFUN-RIFT] PumpPortal error:', error);
    return NextResponse.json({ error: `PumpPortal error: ${error}` }, { status: 500 });
  }

  const createTxBytes = new Uint8Array(await createResponse.arrayBuffer());
  console.log('[PUMPFUN-RIFT] Create TX size:', createTxBytes.length);

  // ===== TX2: Create DAMMV2 pool =====
  // Calculate tokens and price from pump.fun bonding curve
  const { tokensReceived, priceAfterBuy } = calculatePumpFunBondingCurve(devBuyAmountSol);

  console.log('[PUMPFUN-RIFT] Bonding curve calculation:', {
    devBuyAmountSol,
    tokensReceived,
    priceAfterBuy,
    priceInSolPerToken: priceAfterBuy.toFixed(12),
  });

  // Import SDK
  const { CpAmm, derivePoolAddress } = await import('@meteora-ag/cp-amm-sdk');
  const cpAmm = new CpAmm(connection);

  // Find available config
  const allConfigs = await cpAmm.getAllConfigs();
  let selectedConfig: PublicKey | null = null;
  let poolAddress: PublicKey | null = null;

  for (const { publicKey: config } of allConfigs) {
    try {
      const derivedPool = derivePoolAddress(config, mintKeypair.publicKey, WSOL_MINT);
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
    return NextResponse.json(
      { error: 'No available pool config found' },
      { status: 500 }
    );
  }

  console.log('[PUMPFUN-RIFT] Pool config:', selectedConfig.toBase58());
  console.log('[PUMPFUN-RIFT] Pool address:', poolAddress.toBase58());

  // Get config state
  const configState = await cpAmm.fetchConfigState(selectedConfig);
  const configMinSqrtPrice = new BN(configState.sqrtMinPrice.toString());
  const configMaxSqrtPrice = new BN(configState.sqrtMaxPrice.toString());

  // Token amount in lamports (pump.fun tokens are 6 decimals)
  const tokenDecimals = 6;
  const tokenAmountBN = new BN(Math.floor(tokensReceived * Math.pow(10, tokenDecimals)));

  // Calculate liquidity using BigInt
  const liquidityDelta = (() => {
    const amountBI = BigInt(tokenAmountBN.toString());
    const lowerBI = BigInt(configMinSqrtPrice.toString());
    const upperBI = BigInt(configMaxSqrtPrice.toString());
    const denominator = upperBI - lowerBI;
    const numerator = amountBI * lowerBI * upperBI;
    return new BN((numerator / denominator).toString());
  })();

  console.log('[PUMPFUN-RIFT] Liquidity delta:', liquidityDelta.toString());

  // Build pool creation TX
  const poolTx = await cpAmm.createPool({
    payer: new PublicKey(creatorPublicKey),
    creator: new PublicKey(creatorPublicKey),
    config: selectedConfig,
    positionNft: positionNft.publicKey,
    tokenAMint: mintKeypair.publicKey,
    tokenBMint: WSOL_MINT,
    tokenAAmount: tokenAmountBN,
    tokenBAmount: new BN(0),
    initSqrtPrice: configMinSqrtPrice,
    liquidityDelta,
    activationPoint: null,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    isLockLiquidity: false,
  });

  // Add compute budget
  poolTx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })
  );

  // Set blockhash and fee payer
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  poolTx.recentBlockhash = blockhash;
  poolTx.feePayer = new PublicKey(creatorPublicKey);

  // Partial sign with position NFT
  poolTx.partialSign(positionNft);

  console.log('[PUMPFUN-RIFT] Pool TX built');

  return NextResponse.json({
    success: true,
    mintPublicKey: mintKeypair.publicKey.toBase58(),
    mintSecretKey: bs58.encode(mintKeypair.secretKey),
    poolAddress: poolAddress.toBase58(),
    createTxBase64: Buffer.from(createTxBytes).toString('base64'),
    poolTxBase64: Buffer.from(poolTx.serialize({ requireAllSignatures: false })).toString('base64'),
    tokensReceived,
    initialPriceSol: priceAfterBuy,
  });
}

/**
 * Execute bundled launch + rift
 */
async function handleExecute(body: any) {
  const {
    signedCreateTxBase64,
    signedPoolTxBase64,
    mintPublicKey,
    poolAddress,
  } = body;

  if (!signedCreateTxBase64 || !signedPoolTxBase64 || !mintPublicKey || !poolAddress) {
    return NextResponse.json(
      { error: 'Missing required fields' },
      { status: 400 }
    );
  }

  console.log('[PUMPFUN-RIFT] Executing bundled launch...');

  // Decode transactions
  const createTxBytes = Buffer.from(signedCreateTxBase64, 'base64');
  const poolTxBytes = Buffer.from(signedPoolTxBase64, 'base64');

  // Bundle transactions (base58 encoded)
  const bundle = [
    bs58.encode(createTxBytes),
    bs58.encode(poolTxBytes),
  ];

  console.log('[PUMPFUN-RIFT] Sending Jito bundle...');

  // Send bundle
  let bundleId = '';
  for (const endpoint of JITO_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [bundle],
        }),
      });

      const result = await response.json();

      if (result.result) {
        bundleId = result.result;
        console.log('[PUMPFUN-RIFT] Bundle sent:', bundleId);
        break;
      }
    } catch (err) {
      continue;
    }
  }

  if (!bundleId) {
    return NextResponse.json(
      { error: 'Failed to send Jito bundle' },
      { status: 500 }
    );
  }

  // Poll for confirmation
  let confirmed = false;
  let signature = '';

  for (let i = 0; i < 30; i++) {
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
          console.log('[PUMPFUN-RIFT] Bundle status:', status.confirmation_status);

          if (status.confirmation_status === 'confirmed' || status.confirmation_status === 'finalized') {
            confirmed = true;
            signature = status.transactions?.[0] || '';
            break;
          }

          if (status.err) {
            return NextResponse.json(
              { error: `Bundle failed: ${JSON.stringify(status.err)}` },
              { status: 500 }
            );
          }
        }
      } catch (err) {
        continue;
      }
    }

    if (confirmed) break;
  }

  if (!confirmed) {
    return NextResponse.json({
      success: false,
      error: 'Bundle confirmation timeout',
      bundleId,
      hint: 'Bundle may still land - check status manually',
    }, { status: 408 });
  }

  console.log('[PUMPFUN-RIFT] Launch + rift success!', {
    mint: mintPublicKey,
    pool: poolAddress,
    bundleId,
    signature,
  });

  return NextResponse.json({
    success: true,
    mint: mintPublicKey,
    poolAddress,
    bundleId,
    signature,
  });
}

/**
 * GET - Health check
 */
export async function GET() {
  return NextResponse.json({ status: 'ok', service: 'pumpfun-rift' });
}
