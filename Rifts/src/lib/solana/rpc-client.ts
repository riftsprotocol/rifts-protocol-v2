/**
 * RPC Client Wrapper
 * Routes all RPC requests through /api/rpc proxy to hide the actual RPC URL
 */
import { Connection } from '@solana/web3.js';

export class ProxiedConnection extends Connection {
  constructor() {
    // Use proxy endpoint for browser, actual RPC for server
    const endpoint = typeof window !== 'undefined'
      ? 'https://proxy'  // Browser: dummy HTTPS URL (intercepted by customFetch)
      : process.env.SOLANA_RPC_URL!; // Server: use actual RPC

    // Choose a CSP-safe websocket endpoint (allowed hosts); defaults to mainnet if available
    // Note: We disable WebSocket for now since confirmTransaction uses HTTP polling anyway
    // This avoids the 'wss://proxy/' connection errors
    let wsEndpoint: string | undefined = undefined;
    if (typeof window !== 'undefined') {
      // Use NEXT_PUBLIC_ prefixed env vars for browser access
      const apiKey =
        process.env.NEXT_PUBLIC_HELIUS_API_KEY ||
        '05cdb2bf-29b4-436b-afed-f757a4134fe6'; // Fallback to hardcoded key
      if (apiKey) {
        wsEndpoint = `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
      }
    }

    super(endpoint, {
      commitment: 'confirmed',
      // Use CSP-safe websocket (or undefined server-side); confirmations primarily use HTTP polling
      wsEndpoint,
      disableRetryOnRateLimit: true,
      confirmTransactionInitialTimeout: 60000,
      // Custom fetch that routes through our proxy
      fetch: typeof window !== 'undefined' ? customFetch : undefined,
    });

    if (typeof window !== 'undefined') {
      console.warn('[RPC Client] Using proxied RPC with websockets enabled', { endpoint, wsEndpoint });
    }
  }
}

// Custom fetch function for proxying RPC requests
async function customFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Use LaserStream proxied endpoint
  const proxyUrl = '/api/rpc';

  // Validate that we have a body to send
  if (!init || !init.body) {
    console.error('[RPC Client] No request body provided to customFetch');
    throw new Error('RPC request must include a body');
  }

  let method = 'unknown';
  let frames: string[] = [];
  let fullStack = '';
  try {
    const parsed = JSON.parse(init.body as string);
    method = parsed?.method || 'unknown';
    fullStack = new Error().stack || '';
    frames = fullStack.split('\n').slice(2, 10).map((line: string) => line.trim());

    if (process.env.NEXT_PUBLIC_DEBUG_RPC_STACK === 'true' || process.env.DEBUG_RPC_STACK === 'true') {
      console.warn('[RPC Client][TRACE]', `method=${method}`, 'frames=', frames);
    }
  } catch {
    // ignore stack logging errors
  }

  const httpMethods = new Set([
    'getBalanceAndContext',
    'getAccountInfo',
    'getAccountInfoAndContext',
    'getParsedTokenAccountsByOwner',
    'getTokenAccountsByOwner',
    'getTokenAccountBalance',
    'getProgramAccounts',
    'getMultipleAccounts',
    'getMultipleAccountsInfo',
    'getLatestBlockhash',
    'getLatestBlockhashAndContext',
    'getSignatureStatuses',
    'getSignatureStatus',
    'getSignaturesForAddress', // Added: route to HTTP endpoint
    'getSlot',
    'simulateTransaction',
    'getTransaction', // Added: for transaction history
  ]);

  let targetUrl = proxyUrl;
  if (httpMethods.has(method)) {
    targetUrl = '/api/rpc-http';
  } else if (method === 'getBalance') {
    targetUrl = '/api/laserstream-json';
  } else if (method === 'sendTransaction' || method === 'sendRawTransaction' || method === 'sendEncodedTransaction') {
    // Use JSON-capable endpoint for transaction send
    targetUrl = '/api/rpc-http';
  }

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: init.body,
  });

  // Log failures with method + stack frames for pinpointing call sites
  if (!response.ok) {
    const ct = response.headers.get('content-type') || 'unknown';
    const len = response.headers.get('content-length') || 'unknown';
    console.error('[RPC Client][ERROR]', `method=${method}`, `status=${response.status}`, `ct=${ct}`, `len=${len}`, 'frames=', frames, 'stack=', fullStack);
  }

  return response;
}

// Export connection factory
export function createProxiedConnection() {
  return new ProxiedConnection();
}
