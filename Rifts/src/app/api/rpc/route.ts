import { NextRequest, NextResponse } from 'next/server';
import { Agent } from 'undici';
import { getHeliusHttpRpcUrl } from '@/lib/solana/rpc-endpoints';

/**
 * RPC Proxy Endpoint
 * Proxies Solana RPC requests to hide the actual RPC URL from the client
 */
export async function POST(request: NextRequest) {
  try {
    // Check if request has body
    const contentLength = request.headers.get('content-length');
    if (!contentLength || contentLength === '0') {
      console.error('[RPC Proxy] Empty request body');
      return NextResponse.json(
        { error: 'Empty request body' },
        { status: 400 }
      );
    }

    // Try to parse JSON, catch empty/malformed bodies
    let body;
    try {
      body = await request.json();
    } catch (jsonError) {
      console.error('[RPC Proxy] Failed to parse JSON:', jsonError instanceof Error ? jsonError.message : jsonError);
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }

    // Validate body is not empty
    if (!body || Object.keys(body).length === 0) {
      console.error('[RPC Proxy] Invalid request body:', body);
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    // LOG WHAT METHOD IS BEING CALLED (only in debug mode)
    const method = body.method || 'unknown';

    // TEMPORARY: Count requests to find spam source
    if (!(global as any).rpcCallCounts) (global as any).rpcCallCounts = {};
    if (!(global as any).rpcCallCounts[method]) (global as any).rpcCallCounts[method] = 0;
    (global as any).rpcCallCounts[method]++;

    // Log summary every 50 requests
    const totalCalls = Object.values((global as any).rpcCallCounts as Record<string, number>).reduce((a, b) => a + b, 0);
    if (totalCalls % 50 === 0) {
      console.log('\n📊 RPC Call Stats:', (global as any).rpcCallCounts);
      console.log(`Total: ${totalCalls} calls\n`);
    }

    if (process.env.DEBUG_RPC === 'true') {
      const params = body.params ? JSON.stringify(body.params).slice(0, 100) : 'none';
      console.log(`[RPC Proxy] 🔍 Method: ${method} | Params: ${params}`);
    }

    // Get RPC URL - use LaserStream endpoint directly
    const laserstreamUrl = process.env.LASERSTREAM && process.env.LASERSTREAM_API_KEY
      ? `${process.env.LASERSTREAM}/?api-key=${process.env.LASERSTREAM_API_KEY}`
      : null;

    if (!laserstreamUrl) {
      console.error('[RPC Proxy] No LaserStream RPC URL configured!');
      return NextResponse.json(
        { error: 'LaserStream RPC URL not configured' },
        { status: 500 }
      );
    }

    // Log which RPC we're using (only once)
    if (!(global as any).rpcUrlLogged) {
      console.log(`🚀 [RPC Proxy] Using RPC target: LASERSTREAM ⚡`);
      (global as any).rpcUrlLogged = true;
    }

    // Forward the RPC request using native fetch (LaserStream only, no fallback)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    try {
      if (process.env.DEBUG_RPC === 'true') {
        console.log(`[RPC Proxy] -> LASERSTREAM ⚡ (${laserstreamUrl}) | method=${method}`);
      }

      const response = await fetch(laserstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const contentType = response.headers.get('content-type') || 'unknown';
      const contentLength = response.headers.get('content-length') || 'unknown';
      const responseText = await response.text();
      const isGrpcLike = contentType.includes('grpc');

      if (response.status >= 400) {
        let errorData: any = {};
        try {
          errorData = JSON.parse(responseText);
        } catch {
          errorData = { raw: responseText.slice(0, 200) };
        }

        console.error('[RPC Proxy] RPC server error:', response.status, response.statusText);
        console.error('[RPC Proxy] Error details:', JSON.stringify(errorData));

        return NextResponse.json(
          { error: 'RPC server error', status: response.status, details: errorData },
          { status: response.status }
        );
      }

      if (!responseText || isGrpcLike) {
        const msg = `[RPC Proxy] LASERSTREAM ⚡ returned empty or non-JSON body (status ${response.status}, type: ${contentType}, length: ${contentLength}).`;
        console.warn(msg);

        // Fallback to a plain HTTP JSON RPC (Helius) to avoid breaking the caller
        try {
          const fallbackUrl = getHeliusHttpRpcUrl();
          const fallbackResp = await fetch(fallbackUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(body),
          });
          const fallbackText = await fallbackResp.text();
          const fallbackType = fallbackResp.headers.get('content-type') || 'unknown';

          if (fallbackResp.status >= 400 || !fallbackText || !fallbackType.includes('json')) {
            return NextResponse.json(
              { error: 'Empty or non-JSON RPC response body', details: msg },
              { status: 502 }
            );
          }

          const fallbackData = JSON.parse(fallbackText);
          return NextResponse.json(fallbackData, {
            status: fallbackResp.status,
            headers: { 'Cache-Control': 'no-store, max-age=0' }
          });
        } catch (fallbackErr) {
          return NextResponse.json(
            { error: 'Empty or non-JSON RPC response body', details: msg },
            { status: 502 }
          );
        }
      }

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        const preview = responseText.slice(0, 200);
        console.error(`[RPC Proxy] LASERSTREAM ⚡ parse error (status ${response.status}, type: ${contentType}, length: ${contentLength}):`, parseError);
        console.error(`[RPC Proxy] LASERSTREAM ⚡ body preview:`, preview);
        return NextResponse.json(
          { error: 'Invalid JSON from RPC', status: response.status, bodyPreview: preview },
          { status: 502 }
        );
      }

      // Return successful response
      return NextResponse.json(data, {
        status: response.status,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        }
      });
    } catch (fetchError) {
      clearTimeout(timeoutId);

      const isAbort = fetchError instanceof Error && fetchError.name === 'AbortError';
      if (isAbort) {
        console.error(`[RPC Proxy] Request timeout after 10s via LASERSTREAM ⚡`);
        return NextResponse.json(
          { error: 'RPC request timeout', details: 'Request took too long to complete (>10s)' },
          { status: 504 }
        );
      }

      console.error(`[RPC Proxy] Failed via LASERSTREAM ⚡:`, fetchError);

      // Fallback to Helius when LASERSTREAM fails (SSL errors, network issues, etc.)
      try {
        console.log(`[RPC Proxy] Falling back to Helius HTTP RPC...`);
        const fallbackUrl = getHeliusHttpRpcUrl();
        const fallbackResp = await fetch(fallbackUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
        });
        const fallbackText = await fallbackResp.text();
        const fallbackType = fallbackResp.headers.get('content-type') || 'unknown';

        if (fallbackResp.status >= 400 || !fallbackText || !fallbackType.includes('json')) {
          console.error(`[RPC Proxy] Helius fallback also failed:`, fallbackResp.status);
          return NextResponse.json(
            { error: 'RPC request failed', details: fetchError instanceof Error ? fetchError.message : String(fetchError) },
            { status: 500 }
          );
        }

        const fallbackData = JSON.parse(fallbackText);
        console.log(`[RPC Proxy] ✓ Helius fallback succeeded for method: ${method}`);
        return NextResponse.json(fallbackData, {
          status: fallbackResp.status,
          headers: { 'Cache-Control': 'no-store, max-age=0' }
        });
      } catch (fallbackErr) {
        console.error(`[RPC Proxy] Helius fallback error:`, fallbackErr);
        return NextResponse.json(
          { error: 'RPC request failed', details: fetchError instanceof Error ? fetchError.message : String(fetchError) },
          { status: 500 }
        );
      }
    }
  } catch (error) {
    console.error('[RPC Proxy] Error:', error);
    return NextResponse.json(
      { error: 'RPC request failed', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
