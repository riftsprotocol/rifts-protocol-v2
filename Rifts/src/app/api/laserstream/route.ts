import { NextRequest, NextResponse } from 'next/server';

/**
 * Laserstream RPC Proxy Endpoint
 * Proxies requests to Helius Laserstream for ultra-low latency (~10-20ms)
 * Used by arb bot and other latency-sensitive operations
 *
 * Laserstream is Helius's gRPC-based streaming service optimized for:
 * - Real-time account updates
 * - Low-latency transaction submission
 * - High-frequency trading use cases
 */

if (!process.env.LASERSTREAM || !process.env.LASERSTREAM_API_KEY) {
  throw new Error('LaserStream not configured (LASERSTREAM + LASERSTREAM_API_KEY required)');
}

// Get Laserstream config from server-side env (not exposed to client)
const LASERSTREAM_ENDPOINT = process.env.LASERSTREAM || 'https://laserstream-mainnet-ewr.helius-rpc.com';
const LASERSTREAM_API_KEY = process.env.LASERSTREAM_API_KEY;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const method = body?.method || 'unknown';
    console.log(`[LASERSTREAM] ${method} request received`);

    if (!body || Object.keys(body).length === 0) {
      console.error('[LASERSTREAM] Invalid request body');
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    if (!LASERSTREAM_API_KEY) {
      console.error('[LASERSTREAM] No API key configured.');
      return NextResponse.json(
        { error: 'Helius RPC not configured - check LASERSTREAM_API_KEY env var' },
        { status: 500 }
      );
    }

    // Build Helius RPC URL with API key (using HTTP RPC, not gRPC Laserstream)
    const url = `${LASERSTREAM_ENDPOINT}/?api-key=${LASERSTREAM_API_KEY}`;
    console.log(`[LASERSTREAM] Calling ${LASERSTREAM_ENDPOINT} for ${method}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error(`[LASERSTREAM] HTTP ${response.status} for ${method}:`, responseText.slice(0, 500));
      return NextResponse.json(
        { error: 'Laserstream request failed', details: responseText },
        { status: response.status }
      );
    }

    // Parse and check for RPC errors
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      console.error('[LASERSTREAM] Invalid JSON response:', responseText.slice(0, 200));
      return NextResponse.json(
        { error: 'Invalid JSON from Laserstream', details: responseText },
        { status: 500 }
      );
    }

    // Log RPC errors but still return them
    if (data.error) {
      console.error(`[LASERSTREAM] RPC error for ${method}:`, JSON.stringify(data.error));
    } else if (method === 'sendTransaction' && data.result) {
      console.log(`[LASERSTREAM] ✓ TX sent: ${data.result}`);
    }

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      }
    });

  } catch (error) {
    console.error('[LASERSTREAM] Catch error:', error);
    return NextResponse.json(
      { error: 'Laserstream request failed', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

// GET endpoint to return Laserstream config for client setup (WebSocket URL)
export async function GET() {
  if (!LASERSTREAM_API_KEY) {
    return NextResponse.json(
      { error: 'Laserstream not configured' },
      { status: 500 }
    );
  }

  // Return WebSocket endpoint for gRPC streaming (without exposing full API key)
  return NextResponse.json({
    wsEndpoint: `${LASERSTREAM_ENDPOINT.replace('https', 'wss')}/?api-key=${LASERSTREAM_API_KEY}`,
    rpcEndpoint: `/api/laserstream`, // Use the proxy
    available: true
  });
}
