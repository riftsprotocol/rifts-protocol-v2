import { NextRequest, NextResponse } from 'next/server';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// PumpPortal API endpoint
const PUMPPORTAL_API = 'https://pumpportal.fun/api';

/**
 * POST /api/pumpfun
 *
 * action: "prepare" - Generate mint keypair and get create TX for user to sign
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'prepare') {
      return handlePrepare(body);
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('[PUMPFUN-API] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * Prepare launch - generate mint, get create TX for user to sign
 */
async function handlePrepare(body: any) {
  const {
    creatorPublicKey,
    metadataUri,
    name,
    symbol,
    devBuyAmountSol = 0,
    slippage = 10,
    priorityFee = 0.001,
  } = body;

  if (!creatorPublicKey || !metadataUri || !name || !symbol) {
    return NextResponse.json(
      { error: 'Missing required fields: creatorPublicKey, metadataUri, name, symbol' },
      { status: 400 }
    );
  }

  console.log('[PUMPFUN-API] Preparing launch for:', { name, symbol, creator: creatorPublicKey, devBuy: devBuyAmountSol });

  // Generate mint keypair
  const mintKeypair = Keypair.generate();
  const mintPublicKey = mintKeypair.publicKey.toBase58();
  const mintSecretKey = bs58.encode(mintKeypair.secretKey);

  console.log('[PUMPFUN-API] Generated mint:', mintPublicKey);

  // Get create transaction from PumpPortal
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
      slippage,
      priorityFee,
      pool: 'pump',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('[PUMPFUN-API] PumpPortal error:', error);
    return NextResponse.json({ error: `PumpPortal error: ${error}` }, { status: 500 });
  }

  // Get transaction bytes and encode as base64
  const txBytes = new Uint8Array(await response.arrayBuffer());
  const txBase64 = Buffer.from(txBytes).toString('base64');

  console.log('[PUMPFUN-API] Create TX prepared, size:', txBytes.length);

  return NextResponse.json({
    success: true,
    mintPublicKey,
    mintSecretKey, // Client needs this to sign
    createTxBase64: txBase64,
  });
}

/**
 * GET /api/pumpfun - Health check
 */
export async function GET() {
  return NextResponse.json({ status: 'ok' });
}
