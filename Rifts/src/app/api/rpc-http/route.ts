import { NextRequest, NextResponse } from 'next/server';
import { getHeliusHttpRpcUrl } from '@/lib/solana/rpc-endpoints';

function getFallbackRpcUrls(): string[] {
  const urls: string[] = [];

  const apiKey =
    process.env.LASERSTREAM_API_KEY ||
    process.env.SOLANA_RPC_URL?.match(/api-key=([a-f0-9-]+)/)?.[1];

  // Prefer SOLANA_RPC_URL if it is not LaserStream/local proxy
  if (process.env.SOLANA_RPC_URL && !process.env.SOLANA_RPC_URL.toLowerCase().includes('laserstream') && !process.env.SOLANA_RPC_URL.includes('/api/rpc')) {
    urls.push(stripDuplicateApiKey(process.env.SOLANA_RPC_URL));
  }

  // Derived helper (will default to Helius HTTP JSON)
  const primary = getHeliusHttpRpcUrl();
  if (!urls.includes(primary)) {
    urls.push(primary);
  }

  const envCandidates = [
    process.env.SOLANA_RPC_URL,
    process.env.SOLANA_HTTP_URL
  ].filter(Boolean) as string[];

  for (const url of envCandidates) {
    // Avoid LaserStream gRPC endpoints or local proxy /api/rpc for HTTP JSON calls
    const lower = url.toLowerCase();
    if (
      lower.includes('laserstream') ||
      lower.includes('/api/rpc')
    ) {
      continue;
    }
    if (!urls.includes(url)) {
      urls.push(url);
    }
  }

  // Always include a public fallback
  if (!urls.includes('https://api.mainnet-beta.solana.com')) {
    urls.push('https://api.mainnet-beta.solana.com');
  }

  // Normalize duplicates and strip double api-key
  const normalized = urls.map(stripDuplicateApiKey);
  return Array.from(new Set(normalized));
}

function stripDuplicateApiKey(url: string) {
  if (!url.includes('api-key=')) return url;
  try {
    const parsed = new URL(url);
    const apiKey = parsed.searchParams.get('api-key');
    parsed.search = '';
    if (apiKey) parsed.searchParams.set('api-key', apiKey);
    return parsed.toString();
  } catch {
    return url;
  }
}

// JSON-capable RPC proxy using Helius HTTP endpoint with LaserStream key
export async function POST(request: NextRequest) {
  try {
    const incoming = await request.json();
    const body = {
      jsonrpc: '2.0',
      id: incoming?.id ?? Date.now(),
      method: incoming?.method,
      params: incoming?.params ?? []
    };
    const rpcUrls = getFallbackRpcUrls();
    let lastError: any = null;

    console.error('[rpc-http] starting RPC HTTP request', {
      urls: rpcUrls,
      method: body?.method,
      paramsType: Array.isArray(body?.params) ? 'array' : typeof body?.params
    });

    for (const rpcUrl of rpcUrls) {
      const controller = new AbortController();
      // getProgramAccounts is expensive - use 30s timeout for it, 15s for others
      const isHeavyMethod = body.method === 'getProgramAccounts' || body.method === 'getMultipleAccounts';
      const timeoutMs = isHeavyMethod ? 30000 : 15000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const responseText = await response.text();
        const contentType = response.headers.get('content-type') || 'unknown';
        const preview = responseText ? responseText.slice(0, 200) : '';
        console.error('[rpc-http] response meta', { rpcUrl, status: response.status, contentType, previewLength: responseText.length });

        if (response.status >= 400) {
          let errorData: any = {};
          try {
            errorData = JSON.parse(responseText);
          } catch {
            errorData = { raw: preview };
          }
          lastError = { status: response.status, details: errorData, rpcUrl };
          console.error('[rpc-http] RPC server error', lastError);
          continue;
        }

        if (!responseText || !contentType.includes('json')) {
          lastError = { status: response.status, contentType, rpcUrl, body: preview };
          console.error('[rpc-http] Non-JSON/empty body', lastError);
          continue;
        }

        try {
          const data = JSON.parse(responseText);
          console.error('[rpc-http] success', { rpcUrl, status: response.status, keys: Object.keys(data || {}) });
          return NextResponse.json(data, { status: response.status });
        } catch (parseError) {
          lastError = { parseError: (parseError as Error).message, rpcUrl, body: preview };
          console.error('[rpc-http] Invalid JSON from RPC', lastError);
          continue;
        }
      } catch (error) {
        clearTimeout(timeoutId);
        const isAbort = error instanceof Error && error.name === 'AbortError';
        lastError = {
          error: isAbort ? 'timeout' : (error as Error)?.message || String(error),
          rpcUrl
        };
        console.error('[rpc-http] fetch failed', lastError);
        if (isAbort) {
          // try next URL
          continue;
        }
      }
    }

    return NextResponse.json(
      { error: 'All RPC endpoints failed', details: lastError || 'Unknown' },
      { status: 502 }
    );
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort) {
      return NextResponse.json(
        { error: 'RPC request timeout', details: 'Request took too long to complete (>10s)' },
        { status: 504 }
      );
    }
    return NextResponse.json(
      { error: 'RPC request failed', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
