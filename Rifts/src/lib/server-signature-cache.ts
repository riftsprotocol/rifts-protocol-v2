/**
 * Server-Side Signature Cache
 *
 * Caches getSignaturesForAddress results to avoid redundant RPC calls.
 * Signatures don't change once on-chain, so we can cache them aggressively.
 *
 * Uses Supabase for persistence (serverless environments lose in-memory state)
 * Cache TTL: 5 minutes (signatures are immutable, but new ones appear)
 */

import { ConfirmedSignatureInfo } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';

// Supabase client for persistence
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// In-memory cache (fast, but lost on cold start)
const signatureCache = new Map<string, {
  signatures: ConfirmedSignatureInfo[];
  timestamp: number;
  limit: number;
}>();

// Cache TTL: 5 minutes
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Get cached signatures for an address
 * Returns null if cache miss or expired
 */
export function getCachedSignatures(
  address: string,
  limit: number
): ConfirmedSignatureInfo[] | null {
  const cached = signatureCache.get(address);
  const now = Date.now();

  // Cache hit if:
  // 1. Entry exists
  // 2. Not expired
  // 3. Cached limit >= requested limit (we have enough data)
  if (cached && (now - cached.timestamp) < CACHE_TTL && cached.limit >= limit) {
    console.log(`[SIG-CACHE] HIT for ${address.slice(0, 8)}... (${cached.signatures.length} sigs)`);
    return cached.signatures.slice(0, limit);
  }

  return null;
}

/**
 * Store signatures in cache
 */
export function cacheSignatures(
  address: string,
  signatures: ConfirmedSignatureInfo[],
  limit: number
): void {
  signatureCache.set(address, {
    signatures,
    timestamp: Date.now(),
    limit
  });
  console.log(`[SIG-CACHE] Cached ${signatures.length} signatures for ${address.slice(0, 8)}...`);
}

/**
 * Get signatures from Supabase cache
 */
async function getSupabaseSignatures(address: string, limit: number): Promise<ConfirmedSignatureInfo[] | null> {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('signature_cache')
      .select('signatures, cached_at')
      .eq('address', address)
      .single();

    if (error || !data) return null;

    // Check if cache is still valid (5 min TTL)
    const cachedAt = new Date(data.cached_at).getTime();
    if (Date.now() - cachedAt > CACHE_TTL) return null;

    // Ensure we have enough signatures
    if (data.signatures && data.signatures.length >= limit) {
      console.log(`[SIG-CACHE] Supabase HIT for ${address.slice(0, 8)}... (${data.signatures.length} sigs)`);
      return data.signatures.slice(0, limit);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save signatures to Supabase cache
 */
async function saveSupabaseSignatures(address: string, signatures: ConfirmedSignatureInfo[]): Promise<void> {
  if (!supabase) return;

  try {
    await supabase
      .from('signature_cache')
      .upsert({
        address,
        signatures,
        cached_at: new Date().toISOString()
      }, { onConflict: 'address' });
  } catch (error) {
    // Silently fail - cache save shouldn't break the flow
  }
}

/**
 * Get signatures with caching - wraps the RPC call
 * Use this instead of connection.getSignaturesForAddress directly
 */
export async function getSignaturesWithCache(
  connection: { getSignaturesForAddress: (address: any, options?: any, commitment?: any) => Promise<ConfirmedSignatureInfo[]> },
  address: any, // PublicKey
  options?: { limit?: number; before?: string; until?: string },
  commitment?: string
): Promise<ConfirmedSignatureInfo[]> {
  const addressStr = address.toBase58 ? address.toBase58() : address.toString();
  const limit = options?.limit || 100;

  // Don't cache if using pagination (before/until)
  if (options?.before || options?.until) {
    return connection.getSignaturesForAddress(address, options, commitment);
  }

  // Check in-memory cache first (fastest)
  const memCached = getCachedSignatures(addressStr, limit);
  if (memCached) {
    return memCached;
  }

  // Check Supabase cache (persists across cold starts)
  const dbCached = await getSupabaseSignatures(addressStr, limit);
  if (dbCached) {
    // Populate in-memory cache for subsequent calls in same request
    cacheSignatures(addressStr, dbCached, limit);
    return dbCached;
  }

  // Cache miss - fetch from RPC
  console.log(`[SIG-CACHE] MISS for ${addressStr.slice(0, 8)}... fetching from RPC`);
  const signatures = await connection.getSignaturesForAddress(address, options, commitment);

  // Cache the result (both in-memory and Supabase)
  cacheSignatures(addressStr, signatures, limit);
  saveSupabaseSignatures(addressStr, signatures); // Fire and forget

  return signatures;
}

/**
 * Clear cache for a specific address (e.g., after a new transaction)
 */
export function invalidateSignatureCache(address: string): void {
  signatureCache.delete(address);
  console.log(`[SIG-CACHE] Invalidated cache for ${address.slice(0, 8)}...`);
}

/**
 * Clear entire cache
 */
export function clearSignatureCache(): void {
  signatureCache.clear();
  console.log('[SIG-CACHE] Cache cleared');
}

/**
 * Get cache stats for debugging
 */
export function getSignatureCacheStats(): {
  size: number;
  entries: Array<{ address: string; count: number; age: number }>;
} {
  const now = Date.now();
  const entries = Array.from(signatureCache.entries()).map(([addr, data]) => ({
    address: addr.slice(0, 8) + '...',
    count: data.signatures.length,
    age: Math.floor((now - data.timestamp) / 1000)
  }));
  return { size: signatureCache.size, entries };
}
