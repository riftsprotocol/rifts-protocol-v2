import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, quoteRateLimiter } from '@/lib/middleware/rate-limiter';
import { validateOrigin, createForbiddenResponse } from '@/lib/middleware/csrf-protection';

// Use Node.js runtime with fetch support
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    // SECURITY FIX: CSRF Protection - validate origin
    if (!validateOrigin(request)) {
      return createForbiddenResponse();
    }

    // SECURITY FIX: Rate limiting to prevent abuse
    const rateLimit = checkRateLimit(request, quoteRateLimiter);
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

    // Get query parameters from the request
    const searchParams = request.nextUrl.searchParams;
    const inputMint = searchParams.get('inputMint');
    const outputMint = searchParams.get('outputMint');
    const amount = searchParams.get('amount');
    const slippageBps = searchParams.get('slippageBps') || '300';
    const onlyDirectRoutes = searchParams.get('onlyDirectRoutes') || 'false';

    if (!inputMint || !outputMint || !amount) {
      return NextResponse.json(
        { error: 'Missing required parameters: inputMint, outputMint, amount' },
        { status: 400 }
      );
    }

    // 🔒 SECURITY FIX (Issue #7): Input validation for Jupiter routes

    // 1. Mint whitelist - only allow known/trusted tokens (configurable via env)
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

    if (!ALLOWED_MINTS.includes(inputMint)) {
      return NextResponse.json(
        { error: 'Invalid inputMint - token not whitelisted', mint: inputMint },
        { status: 400 }
      );
    }

    if (!ALLOWED_MINTS.includes(outputMint)) {
      return NextResponse.json(
        { error: 'Invalid outputMint - token not whitelisted', mint: outputMint },
        { status: 400 }
      );
    }

    // 2. Amount bounds validation
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return NextResponse.json(
        { error: 'Invalid amount - must be positive number', amount },
        { status: 400 }
      );
    }

    // Min/max amount checks (in lamports/smallest unit)
    const MIN_AMOUNT = 1; // Allow very small amounts for price quotes
    const MAX_AMOUNT = 1000000000000; // 1000 SOL
    if (amountNum < MIN_AMOUNT) {
      return NextResponse.json(
        { error: 'Amount too small', min: MIN_AMOUNT, provided: amountNum },
        { status: 400 }
      );
    }
    if (amountNum > MAX_AMOUNT) {
      return NextResponse.json(
        { error: 'Amount too large', max: MAX_AMOUNT, provided: amountNum },
        { status: 400 }
      );
    }

    // 3. Slippage caps - prevent excessive slippage
    const slippageNum = parseFloat(slippageBps);
    const MAX_SLIPPAGE_BPS = 1000; // 10% max
    const DEFAULT_SLIPPAGE_BPS = 300; // 3% default

    if (isNaN(slippageNum) || slippageNum < 0) {
      return NextResponse.json(
        { error: 'Invalid slippage - must be non-negative number', slippageBps },
        { status: 400 }
      );
    }

    if (slippageNum > MAX_SLIPPAGE_BPS) {
      console.warn(`⚠️ Slippage too high (${slippageNum} bps), capping at ${MAX_SLIPPAGE_BPS}`);
      // Cap slippage instead of rejecting
      searchParams.set('slippageBps', String(MAX_SLIPPAGE_BPS));
    }

    // Get Jupiter Ultra API key from environment
    const apiKey = process.env.JUPITER_ULTRA_API_KEY;
    if (!apiKey) {
      console.error('❌ JUPITER_ULTRA_API_KEY not configured');
      return NextResponse.json(
        { error: 'Jupiter Ultra API not configured. Please contact support.' },
        { status: 500 }
      );
    }

    // Forward request to Jupiter Ultra API with GET and query parameters
    const jupiterUrl = new URL('https://api.jup.ag/ultra/v1/order');
    jupiterUrl.searchParams.append('inputMint', inputMint);
    jupiterUrl.searchParams.append('outputMint', outputMint);
    jupiterUrl.searchParams.append('amount', amount);
    jupiterUrl.searchParams.append('slippageBps', slippageBps);
    // Note: taker is optional - if not provided, response won't include transaction
    // This is fine for quote-only requests

    console.log('🔄 Proxying Jupiter quote request to Ultra API:', jupiterUrl.toString());

    // Try fetch with retry logic and better error handling
    let response;
    let lastError;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        response = await fetch(jupiterUrl.toString(), {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'x-api-key': apiKey,
          },
          signal: AbortSignal.timeout(10000),
        });
        break; // Success, exit retry loop
      } catch (fetchError) {
        lastError = fetchError;
        console.error(`Fetch attempt ${attempt} failed:`, fetchError);
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
        }
      }
    }

    if (!response) {
      throw lastError || new Error('Failed to fetch after retries');
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Jupiter Ultra quote failed:', response.status, errorText);
      return NextResponse.json(
        { error: `Jupiter Ultra API error: ${response.status}`, details: errorText },
        { status: response.status }
      );
    }

    const data = await response.json();
    console.log('✅ Jupiter Ultra quote successful');

    // Return the data with proper CORS headers (only allowed origin)
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
    console.error('❌ Jupiter quote proxy error:', error);
    const errorCause = error instanceof Error ? (error as any).cause : undefined;
    console.error('Error details:', {
      name: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      cause: errorCause
    });

    // Check if it's a DNS error
    const isDnsError = errorCause && (errorCause.code === 'ENOTFOUND' || errorCause.code === 'EAI_AGAIN');

    return NextResponse.json(
      {
        error: isDnsError
          ? 'DNS resolution failed for Jupiter API. This might be a network or DNS configuration issue. Please try:\n1. Check your internet connection\n2. Try a different network\n3. Check if a VPN/proxy is blocking connections\n4. Flush DNS cache: ipconfig /flushdns'
          : 'Failed to fetch quote from Jupiter',
        details: error instanceof Error ? error.message : 'Unknown error',
        errorName: error instanceof Error ? error.name : 'Unknown',
        errorCause: errorCause ? JSON.stringify(errorCause) : undefined,
        suggestion: isDnsError ? 'DNS_RESOLUTION_FAILED' : 'NETWORK_ERROR'
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
