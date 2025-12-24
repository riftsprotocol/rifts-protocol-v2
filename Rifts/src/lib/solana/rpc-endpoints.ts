export function getPreferredRpcUrl() {
  if (process.env.LASERSTREAM && process.env.LASERSTREAM_API_KEY) {
    return `${process.env.LASERSTREAM}/?api-key=${process.env.LASERSTREAM_API_KEY}`;
  }
  throw new Error('LaserStream not configured (LASERSTREAM + LASERSTREAM_API_KEY required)');
}

export function getPreferredWsUrl() {
  if (process.env.LASERSTREAM && process.env.LASERSTREAM_API_KEY) {
    // Use same base, swap to wss if not already
    const base = process.env.LASERSTREAM.startsWith('http')
      ? process.env.LASERSTREAM.replace('http', 'ws')
      : process.env.LASERSTREAM;
    return `${base}/?api-key=${process.env.LASERSTREAM_API_KEY}`;
  }
  throw new Error('LaserStream not configured (LASERSTREAM + LASERSTREAM_API_KEY required)');
}

// Helius/LaserStream websocket endpoint with key, or fallback to configured RPC
export function getHeliusWsRpcUrl(): string {
  if (process.env.LASERSTREAM && process.env.LASERSTREAM_API_KEY) {
    const base = process.env.LASERSTREAM.startsWith('http')
      ? process.env.LASERSTREAM.replace('http', 'ws')
      : process.env.LASERSTREAM;
    // Enforce wss:// to satisfy clients that require http(s) scheme
    const safeBase = base.startsWith('ws://') ? base.replace('ws://', 'wss://') : base;
    return `${safeBase}/?api-key=${process.env.LASERSTREAM_API_KEY}`;
  }
  if (process.env.SOLANA_RPC_URL) {
    const base = process.env.SOLANA_RPC_URL.startsWith('http')
      ? process.env.SOLANA_RPC_URL.replace('http', 'ws')
      : process.env.SOLANA_RPC_URL;
    const safeBase = base.startsWith('ws://') ? base.replace('ws://', 'wss://') : base;
    return safeBase;
  }
  return 'wss://api.mainnet-beta.solana.com';
}

// JSON-RPC (Helius HTTP) endpoint for cases where gRPC LaserStream cannot be used
export function getHeliusHttpRpcUrl() {
  // Force a JSON-capable endpoint; never point this helper at LaserStream gRPC or local proxy
  const isLaser = (url?: string) => !!url && url.toLowerCase().includes('laserstream');

  // Prefer explicit HTTP RPC envs that are not LaserStream; default to Helius HTTP JSON endpoint
  const candidate =
    (!isLaser(process.env.SOLANA_HTTP_URL) && process.env.SOLANA_HTTP_URL) ||
    (!isLaser(process.env.SOLANA_RPC_URL) && process.env.SOLANA_RPC_URL) ||
    (!isLaser(process.env.NEXT_PUBLIC_SOLANA_RPC_URL) && process.env.NEXT_PUBLIC_SOLANA_RPC_URL) ||
    process.env.HELIUS_RPC_ENDPOINT ||
    'https://mainnet.helius-rpc.com';

  // If candidate is a local proxy or LaserStream, fall back to public Helius RPC host
  const base =
    isLaser(candidate) ||
    candidate.startsWith('http://localhost:3000/api/rpc') ||
    candidate.includes('/api/rpc')
      ? 'https://mainnet.helius-rpc.com'
      : candidate;
  const apiKey =
    process.env.LASERSTREAM_API_KEY ||
    process.env.SOLANA_RPC_URL?.match(/api-key=([a-f0-9-]+)/)?.[1];

  const baseHasKey = base.includes('api-key=');

  if (apiKey && !baseHasKey) {
    return `${base}${base.includes('?') ? '&' : '?'}api-key=${apiKey}`;
  }

  // Even without a key, prefer the chosen base (defaults to mainnet.helius-rpc.com)
  return baseHasKey ? base : base;
}
