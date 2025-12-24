import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, swapRateLimiter } from '@/lib/middleware/rate-limiter';
import { validateOrigin, createForbiddenResponse } from '@/lib/middleware/csrf-protection';

// Use Node.js runtime with fetch support
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // SECURITY FIX: CSRF Protection - validate origin
    if (!validateOrigin(request)) {
      return createForbiddenResponse();
    }

    // SECURITY FIX: Rate limiting to prevent abuse
    const rateLimit = checkRateLimit(request, swapRateLimiter);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: 'Too many requests',
          retryAfter: rateLimit.retryAfter
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(rateLimit.retryAfter || 10)
          }
        }
      );
    }

    // Get the request body
    const body = await request.json();

    // Validate required fields
    if (!body.quoteResponse || !body.userPublicKey) {
      return NextResponse.json(
        { error: 'Missing required parameters: quoteResponse, userPublicKey' },
        { status: 400 }
      );
    }

    // 🔒 SECURITY FIX (Issue #7): Swap input validation

    // 1. Validate quote freshness - prevent stale quotes
    const quote = body.quoteResponse;
    const quoteTimestamp = quote.timeTaken || quote.contextSlot || Date.now();
    const now = Date.now();
    const QUOTE_MAX_AGE_MS = 30000; // 30 seconds max age

    // Check if quote has a timestamp we can validate
    if (quote.timeTaken) {
      const quoteAge = now - quoteTimestamp;
      if (quoteAge > QUOTE_MAX_AGE_MS) {
        return NextResponse.json(
          {
            error: 'Quote too old',
            quoteAge: quoteAge,
            maxAge: QUOTE_MAX_AGE_MS,
            message: 'Please refresh quote before swapping'
          },
          { status: 400 }
        );
      }
    }

    // 2. Validate mints in quote (same whitelist as quote endpoint - configurable via env)
    const DEFAULT_ALLOWED_MINTS = [
      'So11111111111111111111111111111111111111112', // SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
      '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // Bonk
      process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump', // RIFTS token
    ];

    // Load from env or use defaults
    const ALLOWED_MINTS = process.env.JUPITER_ALLOWED_MINTS
      ? process.env.JUPITER_ALLOWED_MINTS.split(',').map(m => m.trim())
      : DEFAULT_ALLOWED_MINTS;

    if (quote.inputMint && !ALLOWED_MINTS.includes(quote.inputMint)) {
      return NextResponse.json(
        { error: 'Invalid inputMint in quote - token not whitelisted', mint: quote.inputMint },
        { status: 400 }
      );
    }

    if (quote.outputMint && !ALLOWED_MINTS.includes(quote.outputMint)) {
      return NextResponse.json(
        { error: 'Invalid outputMint in quote - token not whitelisted', mint: quote.outputMint },
        { status: 400 }
      );
    }

    // 3. Validate slippage cap
    const MAX_SLIPPAGE_BPS = 1000; // 10% max
    if (quote.slippageBps && quote.slippageBps > MAX_SLIPPAGE_BPS) {
      return NextResponse.json(
        {
          error: 'Slippage too high',
          provided: quote.slippageBps,
          max: MAX_SLIPPAGE_BPS,
          message: 'Please use lower slippage'
        },
        { status: 400 }
      );
    }

    // 4. Validate amount bounds
    const MIN_AMOUNT = 1; // Allow small amounts
    const MAX_AMOUNT = 1000000000000; // 1000 SOL

    if (quote.inAmount) {
      const inAmount = parseFloat(quote.inAmount);
      if (inAmount < MIN_AMOUNT || inAmount > MAX_AMOUNT) {
        return NextResponse.json(
          {
            error: 'Amount out of bounds',
            amount: inAmount,
            min: MIN_AMOUNT,
            max: MAX_AMOUNT
          },
          { status: 400 }
        );
      }
    }

    // 5. Ensure transaction will be user-signed (never server-signed)
    // The API should return unsigned transaction for user to sign
    body.wrapAndUnwrapSol = body.wrapAndUnwrapSol !== false; // Default true
    body.feeAccount = undefined; // No fee account (user pays their own fees)

    console.log('✅ Swap validation passed - calling Jupiter Ultra for transaction');

    // Get Jupiter Ultra API key
    const apiKey = process.env.JUPITER_ULTRA_API_KEY;
    if (!apiKey) {
      console.error('❌ JUPITER_ULTRA_API_KEY not configured');
      return NextResponse.json(
        { error: 'Jupiter Ultra API not configured. Please contact support.' },
        { status: 500 }
      );
    }

    // Call Jupiter Ultra /order endpoint WITH taker to get the transaction (GET request)
    const jupiterUrl = new URL('https://api.jup.ag/ultra/v1/order');
    jupiterUrl.searchParams.append('inputMint', quote.inputMint);
    jupiterUrl.searchParams.append('outputMint', quote.outputMint);
    jupiterUrl.searchParams.append('amount', quote.inAmount);
    jupiterUrl.searchParams.append('taker', body.userPublicKey); // Required for transaction
    jupiterUrl.searchParams.append('slippageBps', String(quote.slippageBps || 300));

    console.log('🔄 Requesting swap transaction from Jupiter Ultra:', jupiterUrl.toString());

    const response = await fetch(jupiterUrl.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'x-api-key': apiKey,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Jupiter Ultra swap failed:', response.status, errorText);
      return NextResponse.json(
        { error: `Jupiter Ultra API error: ${response.status}`, details: errorText },
        { status: response.status }
      );
    }

    const data = await response.json();
    console.log('✅ Jupiter Ultra transaction received');

    // Return the transaction data
    const origin = request.headers.get('origin') || 'https://www.rifts.finance';
    return NextResponse.json(data, {
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Credentials': 'true',
      },
    });
  } catch (error) {
    console.error('❌ Jupiter swap proxy error:', error);
    console.error('Error details:', {
      name: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      cause: error instanceof Error ? (error as any).cause : undefined
    });

    return NextResponse.json(
      {
        error: 'Failed to get swap transaction from Jupiter',
        details: error instanceof Error ? error.message : 'Unknown error',
        errorName: error instanceof Error ? error.name : 'Unknown',
        errorCause: error instanceof Error ? JSON.stringify((error as any).cause) : undefined
      },
      { status: 500 }
    );
  }
}

export async function OPTIONS(request: NextRequest) {
  // SECURITY FIX: CSRF Protection on preflight requests
  if (!validateOrigin(request)) {
    return createForbiddenResponse();
  }

  const origin = request.headers.get('origin') || 'https://www.rifts.finance';
  return NextResponse.json({}, {
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true',
    },
  });
}
