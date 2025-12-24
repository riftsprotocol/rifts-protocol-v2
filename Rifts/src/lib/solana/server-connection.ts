/**
 * Server-side Connection Singleton
 *
 * For use in API routes and server-side code.
 * Uses direct Helius RPC connection (not proxied) since API routes have access to env vars.
 *
 * This prevents creating 25+ Connection instances across different API routes.
 *
 * Uses dynamic import to avoid Next.js build-time bundling issues with @solana/web3.js
 */

// Server-side RPC URL (JSON endpoint, not LaserStream)
const RPC_URL =
  process.env.SOLANA_RPC_URL
  || process.env.HELIUS_RPC_ENDPOINT
  || require('./rpc-endpoints').getHeliusHttpRpcUrl();

// Laserstream URL for low-latency operations (optional)
const LASERSTREAM_URL = process.env.LASERSTREAM && process.env.LASERSTREAM_API_KEY
  ? `${process.env.LASERSTREAM}/?api-key=${process.env.LASERSTREAM_API_KEY}`
  : null;

// Singleton connections - reused across all API routes
let _serverConnection: any = null;
let _laserstreamConnection: any = null;

/**
 * Get the shared server-side Helius connection
 * Uses standard RPC for most operations
 */
export async function getServerConnection(): Promise<any> {
  if (!_serverConnection) {
    const { Connection } = await import('@solana/web3.js');
    _serverConnection = new Connection(RPC_URL, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
    console.log('[SERVER-CONNECTION] Created shared LaserStream connection');
  }
  return _serverConnection;
}

/**
 * Get the shared Laserstream connection for low-latency operations
 * Falls back to standard connection if Laserstream not configured
 */
export async function getLaserstreamConnection(): Promise<any> {
  if (!LASERSTREAM_URL) {
    return getServerConnection();
  }

  if (!_laserstreamConnection) {
    const { Connection } = await import('@solana/web3.js');
    _laserstreamConnection = new Connection(LASERSTREAM_URL, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 30000, // Faster timeout for low-latency
    });
    console.log('[SERVER-CONNECTION] Created shared Laserstream connection');
  }
  return _laserstreamConnection;
}

/**
 * Get the RPC URL (for cases where you need the URL directly)
 */
export function getServerRpcUrl(): string {
  return RPC_URL;
}

/**
 * Check if Laserstream is available
 */
export function isLaserstreamAvailable(): boolean {
  return LASERSTREAM_URL !== null;
}

// Default export - async function to get connection
export default getServerConnection;
