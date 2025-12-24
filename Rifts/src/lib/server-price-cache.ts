/**
 * Server-Side Price Cache
 *
 * Shared price cache for all API routes to avoid duplicate Jupiter/DexScreener calls.
 * Prices are cached for 2 minutes (120 seconds) to balance freshness with efficiency.
 *
 * Usage:
 *   import { getCachedPrice, getCachedRiftsPrice, getCachedSolPrice } from '@/lib/server-price-cache';
 *   const price = await getCachedPrice('HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump');
 */

// Price cache: Map<mint, { price: number, timestamp: number }>
const priceCache = new Map<string, { price: number; timestamp: number }>();

// Cache TTL: 2 minutes (120 seconds)
const CACHE_TTL = 120000;

// Known token mints
const RIFTS_TOKEN_MINT = 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Get cached price for any token mint
 * First checks cache, then fetches from Jupiter if needed
 */
export async function getCachedPrice(mint: string): Promise<number> {
  const now = Date.now();
  const cached = priceCache.get(mint);

  // Return cached price if valid
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    return cached.price;
  }

  // Fetch fresh price from Jupiter
  try {
    const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
    if (!response.ok) {
      throw new Error(`Jupiter API error: ${response.status}`);
    }

    const data = await response.json();
    const price = data[mint]?.usdPrice || data[mint]?.price || 0;

    // Cache the price
    priceCache.set(mint, { price, timestamp: now });
    console.log(`[PRICE-CACHE] Fetched ${mint.slice(0, 8)}... = $${price}`);

    return price;
  } catch (error) {
    console.error(`[PRICE-CACHE] Error fetching price for ${mint}:`, error);

    // Return stale cached price if available, otherwise 0
    return cached?.price || 0;
  }
}

/**
 * Get cached RIFTS token price (convenience method)
 */
export async function getCachedRiftsPrice(): Promise<number> {
  return getCachedPrice(RIFTS_TOKEN_MINT);
}

/**
 * Get cached SOL price (convenience method)
 */
export async function getCachedSolPrice(): Promise<number> {
  return getCachedPrice(SOL_MINT);
}

/**
 * Get multiple prices at once (batched for efficiency)
 */
export async function getCachedPrices(mints: string[]): Promise<Record<string, number>> {
  const now = Date.now();
  const result: Record<string, number> = {};
  const mintsToFetch: string[] = [];

  // Check cache first
  for (const mint of mints) {
    const cached = priceCache.get(mint);
    if (cached && (now - cached.timestamp) < CACHE_TTL) {
      result[mint] = cached.price;
    } else {
      mintsToFetch.push(mint);
    }
  }

  // Fetch missing prices in batch
  if (mintsToFetch.length > 0) {
    try {
      const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mintsToFetch.join(',')}`);
      if (response.ok) {
        const data = await response.json();
        for (const mint of mintsToFetch) {
          const price = data[mint]?.usdPrice || data[mint]?.price || 0;
          priceCache.set(mint, { price, timestamp: now });
          result[mint] = price;
        }
        console.log(`[PRICE-CACHE] Batch fetched ${mintsToFetch.length} prices`);
      }
    } catch (error) {
      console.error('[PRICE-CACHE] Batch fetch error:', error);
      // Set 0 for failed mints
      for (const mint of mintsToFetch) {
        result[mint] = priceCache.get(mint)?.price || 0;
      }
    }
  }

  return result;
}

/**
 * Clear the price cache (for testing or manual refresh)
 */
export function clearPriceCache(): void {
  priceCache.clear();
  console.log('[PRICE-CACHE] Cache cleared');
}

/**
 * Get cache stats for debugging
 */
export function getPriceCacheStats(): { size: number; entries: Array<{ mint: string; age: number }> } {
  const now = Date.now();
  const entries = Array.from(priceCache.entries()).map(([mint, { timestamp }]) => ({
    mint: mint.slice(0, 8) + '...',
    age: Math.floor((now - timestamp) / 1000)
  }));
  return { size: priceCache.size, entries };
}
