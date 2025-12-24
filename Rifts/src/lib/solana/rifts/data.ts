// lib/solana/rifts/data.ts - Data fetching, processing, and caching functions
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, AccountLayout } from '@solana/spl-token';
import { supabase } from '@/lib/supabase/client';
import { productionJupiterOracle } from '@/lib/solana/jupiter-oracle';
import { getStaticRiftData, setStaticRiftData, getStaticMintData, setStaticMintData } from '@/lib/solana/static-cache';
import { MINT_CACHE_TTL } from './types';
import {
  ServiceContext,
  ProductionRiftData,
  DecodedRiftData,
  RIFTS_PROGRAM_ID,
  RIFTS_PROGRAM_ID_OLD,
  RIFTS_V1_PROGRAM_ID,
  METEORA_DAMM_V2_PROGRAM_ID,
  V1_RIFTS,
  BLACKLISTED_RIFTS,
  CACHE_DURATION_MS,
} from './types';
import {
  decodeRiftAccount,
  decodeMinimalRiftAccount,
  calculateRiskLevel,
  getOracleStatus,
  calculateOracleCountdown,
  generateMockPerformance,
  calculateRealArbitrageOpportunity,
  getPositionNftFromLocalStorage,
  savePositionNftToLocalStorage,
  getMintSymbol,
  getCachedMintDecimals,
  getProgramIdForRiftAddress,
  filterBlacklistedRifts,
  isV1Rift,
} from './utils';
import { getProgramVersionForRift } from './types';

// ============ DATA FETCHING FUNCTIONS ============

/**
 * Get all rifts - Main entry point for fetching rift data
 * Tries API first, falls back to Supabase
 */
export async function getAllRifts(
  ctx: ServiceContext,
  forceRefresh: boolean = false
): Promise<ProductionRiftData[]> {
  console.log('[GET-ALL-RIFTS] Fetching from API endpoint (has auto-detected pools)...');

  try {
    const apiResult = await getAllRiftsCacheBusted(ctx);
    if (apiResult && apiResult.length > 0) {
      console.log('[GET-ALL-RIFTS] ✅ Got', apiResult.length, 'rifts from API endpoint');
      return apiResult;
    }
    console.log('[GET-ALL-RIFTS] ⚠️ API returned empty, falling back to Supabase...');
  } catch (apiError) {
    console.error('[GET-ALL-RIFTS] ⚠️ API failed, falling back to Supabase:', apiError);
  }

  // FALLBACK: Only use direct Supabase if API fails
  try {
    // Fetch V2 rifts (new program) via proxy
    const { data: v2NewRifts, error: v2NewError } = await supabase
      .from('rifts')
      .select('*')
      .eq('is_deprecated', false)
      .eq('program_id', RIFTS_PROGRAM_ID.toBase58())
      .order('updated_at', { ascending: false });

    console.log('[SUPABASE-V2-NEW] v2NewError:', v2NewError, 'v2NewRifts count:', v2NewRifts?.length || 0);

    // Fetch V2 rifts (old program - before name prefix fix) via proxy
    const { data: v2OldRifts, error: v2OldError } = await supabase
      .from('rifts')
      .select('*')
      .eq('is_deprecated', false)
      .eq('program_id', RIFTS_PROGRAM_ID_OLD.toBase58())
      .order('updated_at', { ascending: false });

    console.log('[SUPABASE-V2-OLD] v2OldError:', v2OldError, 'v2OldRifts count:', v2OldRifts?.length || 0);

    // Fetch only the specific V1 rift via proxy
    const { data: v1Rifts, error: v1Error } = await supabase
      .from('rifts')
      .select('*')
      .eq('is_deprecated', false)
      .eq('program_id', RIFTS_V1_PROGRAM_ID.toBase58())
      .in('id', V1_RIFTS)
      .order('updated_at', { ascending: false });

    console.log('[SUPABASE-V1] v1Error:', v1Error, 'v1Rifts count:', v1Rifts?.length || 0);

    // Combine all rifts: new V2, old V2, and V1
    const rifts = [...(v2NewRifts || []), ...(v2OldRifts || []), ...(v1Rifts || [])];
    const error = v2NewError || v2OldError || v1Error;

    if (!error && rifts && rifts.length > 0) {
      console.log('[SUPABASE-PATH] ✅ Using Supabase data, not API endpoint');
      let riftData = rifts.map(r => r.raw_data as ProductionRiftData);

      riftData = filterBlacklistedRifts(riftData);

      // Filter out V1 rifts that are not in the allowlist
      riftData = riftData.filter(r => {
        const programId = r.programId || RIFTS_PROGRAM_ID.toBase58();
        if (programId === RIFTS_V1_PROGRAM_ID.toBase58()) {
          return V1_RIFTS.includes(r.id);
        }
        return true;
      });

      // Enrich with Meteora pool data if not already present
      await enrichRiftsWithMeteoraData(ctx, riftData);

      // ⚡ BACKGROUND PRE-FETCH: Warm up blockchain cache for instant wraps!
      prefetchRiftDataInBackground(ctx, riftData).catch(err =>
        console.debug('[PREFETCH] Background prefetch failed (non-critical):', err)
      );

      return riftData;
    }
  } catch (error) {
    console.error('[GET-ALL-RIFTS] Supabase error, falling back to API:', error);
  }

  // Fallback to API if Supabase fails or is empty
  console.log('[GET-ALL-RIFTS] Supabase empty/failed - fetching from API...');
  return getAllRiftsCacheBusted(ctx);
}

/**
 * Get all rifts with cache busting - fetches fresh data
 */
export async function getAllRiftsCacheBusted(
  ctx: ServiceContext
): Promise<ProductionRiftData[]> {
  try {
    console.log('[FETCH] Fetching rifts from /api/rifts-read endpoint (fast, no RPC)...');

    try {
      const baseUrl = typeof window !== 'undefined'
        ? window.location.origin
        : process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

      const response = await fetch(`${baseUrl}/api/rifts-read`, {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.rifts && data.rifts.length > 0) {
          console.log('[FETCH] ✅ Got', data.rifts.length, 'rifts from API');
          ctx.riftsCache = data.rifts;
          ctx.lastCacheUpdate = Date.now();
          ctx.isLoadingRifts = false;
          return data.rifts;
        }
      }

      console.log('[FETCH] ⚠️ API endpoint failed or returned no rifts, falling back to Supabase');
    } catch (apiError) {
      console.error('[FETCH] ❌ Error fetching from API, falling back to Supabase:', apiError);
    }

    // Fallback: Try to get from Supabase
    const { data: v2NewCachedRifts, error: v2NewDbError } = await supabase
      .from('rifts')
      .select('*')
      .eq('is_deprecated', false)
      .eq('program_id', RIFTS_PROGRAM_ID.toBase58())
      .order('updated_at', { ascending: false });

    const { data: v2OldCachedRifts, error: v2OldDbError } = await supabase
      .from('rifts')
      .select('*')
      .eq('is_deprecated', false)
      .eq('program_id', RIFTS_PROGRAM_ID_OLD.toBase58())
      .order('updated_at', { ascending: false });

    const { data: v1CachedRifts, error: v1DbError } = await supabase
      .from('rifts')
      .select('*')
      .eq('is_deprecated', false)
      .eq('program_id', RIFTS_V1_PROGRAM_ID.toBase58())
      .in('id', V1_RIFTS)
      .order('updated_at', { ascending: false });

    const cachedRifts = [...(v2NewCachedRifts || []), ...(v2OldCachedRifts || []), ...(v1CachedRifts || [])];
    const dbError = v2NewDbError || v2OldDbError || v1DbError;

    if (!dbError && cachedRifts && cachedRifts.length > 0) {
      console.log('[CACHE-BUSTED] ✅ Found', cachedRifts.length, 'rifts in Supabase (fallback)');
      let riftsData = cachedRifts.map(r => r.raw_data as ProductionRiftData);

      riftsData = filterBlacklistedRifts(riftsData);
      riftsData = riftsData.filter(r => {
        const programId = r.programId || RIFTS_PROGRAM_ID.toBase58();
        if (programId === RIFTS_V1_PROGRAM_ID.toBase58()) {
          return V1_RIFTS.includes(r.id);
        }
        return true;
      });

      ctx.riftsCache = riftsData;
      ctx.lastCacheUpdate = Date.now();
      ctx.isLoadingRifts = false;
      return riftsData;
    }

    // Prevent concurrent loads
    if (ctx.isLoadingRifts) {
      if (cachedRifts && cachedRifts.length > 0) {
        let riftsData = cachedRifts.map(r => r.raw_data as ProductionRiftData);
        riftsData = filterBlacklistedRifts(riftsData);
        ctx.riftsCache = riftsData;
        ctx.lastCacheUpdate = Date.now();
        return riftsData;
      }
      return [];
    }

    ctx.isLoadingRifts = true;
    ctx.isLoadingRifts = false;
    return [];
  } catch (error) {
    ctx.isLoadingRifts = false;
    return [];
  }
}

/**
 * Enrich rifts with Meteora pool data by searching for existing pools
 */
export async function enrichRiftsWithMeteoraData(
  ctx: ServiceContext,
  rifts: ProductionRiftData[]
): Promise<void> {
  if (!rifts || rifts.length === 0) {
    return;
  }

  for (const rift of rifts) {
    try {
      // IMPORTANT: If rift already has pool data from API/Supabase raw_data, use it!
      // Check liquidityPool, meteoraPool, or meteoraPools array
      const existingPool = rift.liquidityPool || rift.meteoraPool || (rift.meteoraPools && rift.meteoraPools[0]);
      if (existingPool && existingPool !== '11111111111111111111111111111111') {
        console.log(`[ENRICH-METEORA] Using API-detected pool for ${rift.symbol}: ${existingPool}`);
        rift.meteoraPool = existingPool;
        rift.liquidityPool = existingPool;
        rift.meteoraPools = rift.meteoraPools || [existingPool];
        rift.hasMeteoraPool = true;
        updateRiftInCache(ctx, rift.id, {
          meteoraPool: existingPool,
          liquidityPool: existingPool,
          meteoraPools: rift.meteoraPools,
          hasMeteoraPool: true
        });
        continue;
      }

      // Check localStorage cache if no API pool available
      const cached = getPositionNftFromLocalStorage(rift.id);

      // Check cache age (refresh every 5 minutes)
      const cacheAge = cached?.cachedAt ? Date.now() - cached.cachedAt : Infinity;
      const CACHE_MAX_AGE = 5 * 60 * 1000;

      if (cached?.meteoraPools && Array.isArray(cached.meteoraPools) && cached.meteoraPools.length > 0 && cacheAge < CACHE_MAX_AGE) {
        rift.meteoraPools = cached.meteoraPools;
        rift.meteoraPool = cached.meteoraPools[0];
        rift.liquidityPool = cached.meteoraPools[0];
        rift.hasMeteoraPool = true;
        continue;
      }

      // Search for pools containing this rift token
      const riftMint = new PublicKey(rift.riftMint);
      let foundPool = false;
      const allPoolAddresses: string[] = [];

      // Search for pools where this is Token X (offset 168)
      try {
        const rawConnection = (ctx.connection as any).connection || ctx.connection;
        const poolsAsTokenX = await rawConnection.getProgramAccounts(METEORA_DAMM_V2_PROGRAM_ID, {
          filters: [
            { dataSize: 1112 },
            { memcmp: { offset: 168, bytes: riftMint.toBase58() } }
          ]
        });

        if (poolsAsTokenX && poolsAsTokenX.length > 0) {
          poolsAsTokenX.forEach((pool: { pubkey: PublicKey }) => {
            allPoolAddresses.push(pool.pubkey.toBase58());
          });
          foundPool = true;
        }
      } catch (error) {
        // Error searching Token X
      }

      // Also search as Token Y (offset 200)
      try {
        const rawConnection = (ctx.connection as any).connection || ctx.connection;
        const poolsAsTokenY = await rawConnection.getProgramAccounts(METEORA_DAMM_V2_PROGRAM_ID, {
          filters: [
            { dataSize: 1112 },
            { memcmp: { offset: 200, bytes: riftMint.toBase58() } }
          ]
        });

        if (poolsAsTokenY && poolsAsTokenY.length > 0) {
          poolsAsTokenY.forEach((pool: { pubkey: PublicKey }) => {
            const poolAddress = pool.pubkey.toBase58();
            if (!allPoolAddresses.includes(poolAddress)) {
              allPoolAddresses.push(poolAddress);
            }
          });
          foundPool = true;
        }
      } catch (error) {
        // Error searching Token Y
      }

      // Update rift with all found pools
      if (allPoolAddresses.length > 0) {
        rift.meteoraPools = allPoolAddresses;
        rift.meteoraPool = allPoolAddresses[0];
        rift.liquidityPool = allPoolAddresses[0];
        rift.hasMeteoraPool = true;

        updateRiftInCache(ctx, rift.id, {
          meteoraPool: allPoolAddresses[0],
          liquidityPool: allPoolAddresses[0],
          meteoraPools: allPoolAddresses,
          hasMeteoraPool: true
        });
      }
    } catch (error) {
      // Silently fail for individual rifts
    }
  }
}

/**
 * Get rift data from blockchain with caching
 */
export async function getRiftData(
  ctx: ServiceContext,
  riftPubkey: PublicKey,
  skipRetries: boolean = false
): Promise<DecodedRiftData | null> {
  try {
    const riftId = riftPubkey.toBase58();

    // ⚡ FAST: Check static cache first (instant, immutable data)
    const staticRift = getStaticRiftData(riftId);
    if (staticRift) {
      console.log(`⚡ [STATIC-CACHE] Using cached rift data for ${riftId.slice(0, 8)}`);
      return {
        creator: riftId, // Use rift ID as creator placeholder
        underlyingMint: staticRift.underlyingMint,
        riftMint: staticRift.riftMint,
        vault: staticRift.vault,
        burnFee: 0,
        partnerFee: 0,
        totalWrapped: BigInt(0),
        totalBurned: BigInt(0),
        backingRatio: BigInt(10000),
        lastRebalance: BigInt(0),
        createdAt: BigInt(Math.floor(Date.now() / 1000)),
        oracleUpdateInterval: BigInt(60),
        maxRebalanceInterval: BigInt(3600),
        arbitrageThresholdBps: 50,
        lastOracleUpdate: BigInt(Math.floor(Date.now() / 1000)),
        totalVolume24h: BigInt(0),
        priceDeviation: BigInt(0),
        arbitrageOpportunityBps: 0,
        rebalanceCount: 0,
        totalFeesCollected: BigInt(0),
        riftsTokensDistributed: BigInt(0),
        riftsTokensBurned: BigInt(0),
      };
    }

    // Check in-memory cache
    let cachedRift = ctx.riftsCache.find(r => r.id === riftId || r.address === riftId);

    if (cachedRift && cachedRift.underlyingMint && cachedRift.riftMint) {
      return {
        creator: cachedRift.creator,
        underlyingMint: cachedRift.underlyingMint || cachedRift.underlying,
        riftMint: cachedRift.riftMint,
        vault: cachedRift.vault,
        burnFee: cachedRift.burnFee || 0,
        partnerFee: cachedRift.partnerFee || 0,
        totalWrapped: BigInt(cachedRift.totalWrapped || 0),
        totalBurned: BigInt(0),
        backingRatio: BigInt(10000),
        lastRebalance: BigInt(0),
        createdAt: BigInt(Math.floor(Date.now() / 1000)),
        oracleUpdateInterval: BigInt(60),
        maxRebalanceInterval: BigInt(3600),
        arbitrageThresholdBps: 50,
        lastOracleUpdate: BigInt(Math.floor(Date.now() / 1000)),
        totalVolume24h: BigInt(0),
        priceDeviation: BigInt(0),
        arbitrageOpportunityBps: 0,
        rebalanceCount: 0,
        totalFeesCollected: BigInt(0),
        riftsTokensDistributed: BigInt(0),
        riftsTokensBurned: BigInt(0),
      };
    }

    // Check localStorage for Position NFT metadata
    let positionMetadata: any = null;
    try {
      const storageKey = `rift_metadata_${riftId}`;
      const storedData = typeof window !== 'undefined' ? localStorage.getItem(storageKey) : null;
      if (storedData) {
        positionMetadata = JSON.parse(storedData);
      }
    } catch (error) {
      // Ignore localStorage errors
    }

    // Fetch full rift data from blockchain
    let accountInfo = null;
    const maxRetries = skipRetries ? 1 : 5;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const commitmentLevel = skipRetries ? 'confirmed' : (i < 2 ? 'processed' : i < 4 ? 'confirmed' : 'finalized');
        accountInfo = await ctx.connection.getAccountInfo(riftPubkey, commitmentLevel);

        if (accountInfo) {
          break;
        }

        if (!skipRetries) {
          const delay = i < 2 ? 500 : i < 4 ? 1000 : 2000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (error) {
        // Retry
      }
    }

    if (!accountInfo) {
      return null;
    }

    const blockchainData = decodeRiftAccount(accountInfo.data);

    // Cache the immutable data for future use (only store what StaticRiftData supports)
    setStaticRiftData(riftId, {
      underlyingMint: blockchainData.underlyingMint,
      riftMint: blockchainData.riftMint,
      vault: blockchainData.vault,
    });

    // Merge with Position NFT metadata if available
    if (positionMetadata) {
      return {
        ...blockchainData,
        positionNftMint: positionMetadata.positionNftMint,
        meteoraPool: positionMetadata.meteoraPool
      } as any;
    }

    return blockchainData;
  } catch (error) {
    return null;
  }
}

// ============ CACHE MANAGEMENT FUNCTIONS ============

/**
 * Update a rift in cache with new data
 */
export function updateRiftInCache(
  ctx: ServiceContext,
  riftId: string,
  updates: Partial<ProductionRiftData>
): void {
  const foundRift = ctx.riftsCache.find(r => r.id === riftId || r.address === riftId);
  if (foundRift) {
    ctx.riftsCache = ctx.riftsCache.map(rift =>
      rift.id === riftId || rift.address === riftId ? { ...rift, ...updates } : rift
    );
  } else {
    const placeholderRift: any = {
      id: riftId,
      address: riftId,
      ...updates
    };
    ctx.riftsCache.push(placeholderRift);
  }

  // Persist Position NFT data to localStorage
  if (updates.positionNftMint || updates.meteoraPool || updates.meteoraPools) {
    try {
      const storageKey = `rift_metadata_${riftId}`;
      const existingData = typeof window !== 'undefined' ? localStorage.getItem(storageKey) : null;
      const metadata = existingData ? JSON.parse(existingData) : {};

      const updatedMetadata = {
        ...metadata,
        ...updates,
        cachedAt: Date.now()
      };
      if (typeof window !== 'undefined') {
        localStorage.setItem(storageKey, JSON.stringify(updatedMetadata));
      }
    } catch (error) {
      // Ignore localStorage errors
    }
  }

  ctx.lastCacheUpdate = Date.now();
}

/**
 * Add a rift directly to cache
 */
export function addRiftToCache(ctx: ServiceContext, riftData: ProductionRiftData): void {
  ctx.riftsCache = [...ctx.riftsCache, riftData];
  ctx.lastCacheUpdate = Date.now();
}

/**
 * Clear cache to force fresh data
 */
export function clearCache(ctx: ServiceContext): void {
  ctx.riftsCache = [];
  ctx.lastCacheUpdate = 0;
}

/**
 * Clear localStorage cache for a specific rift
 */
export function clearRiftCache(riftId: string): void {
  try {
    const storageKey = `rift_metadata_${riftId}`;
    if (typeof window !== 'undefined') {
      localStorage.removeItem(storageKey);
      console.log(`[CACHE] Cleared cache for rift ${riftId}`);
    }
  } catch (error) {
    console.error('[CACHE] Error clearing rift cache:', error);
  }
}

/**
 * Clear all rift caches from localStorage
 */
export function clearAllRiftCaches(): void {
  try {
    if (typeof window !== 'undefined') {
      const keys = Object.keys(localStorage);
      let cleared = 0;
      keys.forEach(key => {
        if (key.startsWith('rift_metadata_')) {
          localStorage.removeItem(key);
          cleared++;
        }
      });
      console.log(`[CACHE] Cleared ${cleared} rift cache entries`);
    }
  } catch (error) {
    console.error('[CACHE] Error clearing all rift caches:', error);
  }
}

// ============ VOLUME TRACKING FUNCTIONS ============

/**
 * Track volume for oracle update triggers
 */
export function trackVolume(
  ctx: ServiceContext,
  riftId: string,
  volumeInSol: number
): void {
  if (!ctx.volumeTracker[riftId]) {
    ctx.volumeTracker[riftId] = [];
  }

  const now = Date.now();
  ctx.volumeTracker[riftId].push({
    volume: volumeInSol,
    timestamp: now
  });

  // Clean up old entries (older than 24 hours)
  ctx.volumeTracker[riftId] = ctx.volumeTracker[riftId].filter(
    entry => now - entry.timestamp < 24 * 60 * 60 * 1000
  );

  // Persist to database (fire-and-forget)
  saveVolumeTracking(riftId, volumeInSol, now);

  // Notify all registered callbacks
  ctx.volumeCallbacks.forEach(callback => {
    try {
      callback(riftId, volumeInSol);
    } catch (error) {
      // Ignore callback errors
    }
  });
}

/**
 * Get tracked volume for the last 24 hours
 */
export function getTrackedVolume(ctx: ServiceContext, riftId: string): number {
  if (!ctx.volumeTracker || !ctx.volumeTracker[riftId]) return 0;

  const now = Date.now();
  const volume24h = ctx.volumeTracker[riftId]
    .filter(entry => now - entry.timestamp < 24 * 60 * 60 * 1000)
    .reduce((sum, entry) => sum + entry.volume, 0);

  return volume24h;
}

/**
 * Track unique participants
 */
export function trackParticipant(
  ctx: ServiceContext,
  riftId: string,
  userAddress: string
): void {
  if (!ctx.participantTracker[riftId]) {
    ctx.participantTracker[riftId] = new Set();
  }
  ctx.participantTracker[riftId].add(userAddress);
}

/**
 * Get participant count for a rift
 */
export function getParticipantCount(ctx: ServiceContext, riftId: string): number {
  return ctx.participantTracker[riftId]?.size || 0;
}

/**
 * Get volume history for a rift
 */
export function getVolumeHistory(
  ctx: ServiceContext,
  riftId: string
): Array<{ timestamp: number; amount: number; participant?: string }> {
  if (!ctx.volumeTracker || !ctx.volumeTracker[riftId]) return [];

  const now = Date.now();
  return ctx.volumeTracker[riftId]
    .filter(entry => now - entry.timestamp < 24 * 60 * 60 * 1000)
    .map(entry => ({
      timestamp: entry.timestamp,
      amount: entry.volume,
      participant: (entry as any).participant || 'anonymous'
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Save volume tracking to database (fire-and-forget)
 */
function saveVolumeTracking(riftId: string, volume: number, timestamp: number): void {
  fetch('/api/track-volume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      riftId,
      tokenAmount: volume.toString(),
      usdValue: 0,
      transactionType: 'tracked',
      signature: null
    })
  }).catch(error => {
    // Silently fail - volume tracking is not critical
  });
}

/**
 * Register a callback for volume updates
 */
export function onVolumeUpdate(
  ctx: ServiceContext,
  callback: (riftId: string, volume: number) => void
): void {
  ctx.volumeCallbacks.push(callback);
}

/**
 * Remove a volume callback
 */
export function offVolumeUpdate(
  ctx: ServiceContext,
  callback: (riftId: string, volume: number) => void
): void {
  const index = ctx.volumeCallbacks.indexOf(callback);
  if (index > -1) {
    ctx.volumeCallbacks.splice(index, 1);
  }
}

// ============ PREFETCH FUNCTIONS ============

/**
 * Background pre-fetch to warm up cache for instant wraps
 */
export async function prefetchRiftDataInBackground(
  ctx: ServiceContext,
  rifts: ProductionRiftData[]
): Promise<void> {
  if (!rifts || rifts.length === 0) return;

  // Skip if wrap is in progress
  if (ctx.isWrapInProgress) {
    return;
  }

  const validRifts = filterBlacklistedRifts(rifts);

  for (let i = 0; i < validRifts.length; i++) {
    const rift = validRifts[i];

    // Abort if wrap started during prefetch
    if (ctx.isWrapInProgress) {
      return;
    }

    // Add 500ms delay between each rift
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Fire-and-forget pre-fetch
    prefetchSingleRift(ctx, rift).catch(err =>
      console.debug(`[PREFETCH] Failed to prefetch ${rift.id}:`, err)
    );
  }
}

/**
 * Prefetch single rift data
 */
async function prefetchSingleRift(
  ctx: ServiceContext,
  rift: ProductionRiftData
): Promise<void> {
  try {
    if (ctx.isWrapInProgress) {
      return;
    }

    const riftPubkey = new PublicKey(rift.id);

    // Pre-fetch rift account data
    await getRiftData(ctx, riftPubkey, true);

    // Pre-fetch mint decimals
    if (rift.underlying || rift.underlyingMint) {
      const underlyingMint = new PublicKey(rift.underlying || rift.underlyingMint);
      await getCachedMintDecimals(ctx.connection, underlyingMint, ctx.mintInfoCache, MINT_CACHE_TTL);
    }
  } catch (error) {
    console.debug(`[PREFETCH] Error prefetching ${rift.id}:`, error);
  }
}

// ============ HELPER FUNCTIONS ============

/**
 * Get actual vault balance from blockchain
 */
export async function getActualVaultBalance(
  ctx: ServiceContext,
  vaultPubkey: string,
  retryCount = 0
): Promise<number> {
  const fetchAccountInfoHttp = async () => {
    try {
      console.log('[TVL][HTTP] fetching account info for', vaultPubkey);
      const resp = await fetch('/api/rpc-http', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'getAccountInfo',
          params: [vaultPubkey, { encoding: 'base64' }]
        })
      });
      if (!resp.ok) return null;
      const json = await resp.json();
      return json?.result?.value ?? null;
    } catch {
      return null;
    }
  };

  const getTokenBalanceViaRpc = async () => {
    try {
      console.log('[TVL][RPC] getTokenAccountBalance via connection for', vaultPubkey);
      const bal = await ctx.connection.getTokenAccountBalance(new PublicKey(vaultPubkey));
      if (bal?.value) {
        const ui = bal.value.uiAmount ?? (Number(bal.value.amount) / Math.pow(10, bal.value.decimals || 0));
        if (Number.isFinite(ui)) return ui;
      }
    } catch {
      // ignore and fallback
    }
    // HTTP fallback
    try {
      console.log('[TVL][HTTP] getTokenAccountBalance fallback for', vaultPubkey);
      const resp = await fetch('/api/rpc-http', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'getTokenAccountBalance',
          params: [vaultPubkey]
        })
      });
      if (!resp.ok) {
        console.warn('[TVL][HTTP] token balance resp not ok', resp.status);
        return null;
      }
      const json = await resp.json();
      const val = json?.result?.value;
      if (val) {
        const ui = val.uiAmount ?? (Number(val.amount) / Math.pow(10, val.decimals || 0));
        if (Number.isFinite(ui)) return ui;
      }
      console.warn('[TVL][HTTP] token balance no value', json);
    } catch (err) {
      console.warn('[TVL][HTTP] token balance fetch error', err);
    }
    return null;
  };

  try {
    if (!vaultPubkey || vaultPubkey === '11111111111111111111111111111111') {
      return 0;
    }

    const vaultPublicKey = new PublicKey(vaultPubkey);
    let accountInfo: any = null;
    try {
      console.log('[TVL] getAccountInfo via connection for', vaultPubkey);
      accountInfo = await ctx.connection.getAccountInfo(vaultPublicKey, 'confirmed');
    } catch (err) {
      // fallback will handle
      console.warn('[TVL] getAccountInfo failed via connection, trying HTTP fallback', err);
    }

    // Fallback to HTTP RPC if the proxied connection fails (LaserStream gRPC can return empty bodies)
    if (!accountInfo) {
      const httpValue = await fetchAccountInfoHttp();
      if (httpValue) {
        accountInfo = {
          executable: httpValue.executable,
          lamports: httpValue.lamports,
          owner: new PublicKey(httpValue.owner),
          rentEpoch: httpValue.rentEpoch,
          data: Buffer.from(httpValue.data?.[0] || '', 'base64')
        } as any;
      }
    }

    if (!accountInfo) {
      if (retryCount < 3) {
        console.log(`[TVL] Vault account not found (attempt ${retryCount + 1}/3), retrying in 1s:`, vaultPubkey);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return getActualVaultBalance(ctx, vaultPubkey, retryCount + 1);
      }
      console.warn('[TVL] account info still null after retries for', vaultPubkey);
      return 0;
    }

    const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

    if (accountInfo.owner.equals(TOKEN_PROGRAM_ID) || accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      const rpcBalance = await getTokenBalanceViaRpc();
      if (rpcBalance !== null) {
        return rpcBalance;
      }

      try {
        const tokenAccountData = AccountLayout.decode(accountInfo.data);
        const mintPubkey = new PublicKey(tokenAccountData.mint);
        const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

        if (mintPubkey.equals(WSOL_MINT)) {
          const RENT_EXEMPT_MINIMUM = 2039280;
          const actualBalance = (accountInfo.lamports - RENT_EXEMPT_MINIMUM) / 1e9;
          return Math.max(0, actualBalance);
        } else {
          const amountBigInt = tokenAccountData.amount;
          try {
            const mintInfo = await ctx.connection.getAccountInfo(mintPubkey);
            if (mintInfo && mintInfo.data.length >= 44) {
              const decimals = mintInfo.data[44];
              return Number(amountBigInt) / Math.pow(10, decimals);
            }
          } catch (mintError) {
            console.warn('[TVL] Could not get mint decimals, using default 9');
          }
          return Number(amountBigInt) / 1e9;
        }
      } catch (decodeError) {
        console.error('[TVL] Failed to decode token account:', decodeError);
        return 0;
      }
    } else {
      return accountInfo.lamports / 1e9;
    }
  } catch (error) {
    console.error('[TVL] Error reading vault balance:', error);
    return 0;
  }
}

/**
 * Get token price from Jupiter oracle
 */
export async function getTokenPrice(tokenMint: string): Promise<number> {
  try {
    const priceData = await productionJupiterOracle.getJupiterPrice(tokenMint);
    return priceData.price;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[PRICE] Failed to fetch real-time price for', tokenMint);
    console.error('[PRICE] Error:', errorMsg);
    throw error;
  }
}

/**
 * Get token symbol from mint
 */
export async function getTokenSymbol(
  ctx: ServiceContext,
  mint: string
): Promise<string> {
  try {
    if (mint === 'So11111111111111111111111111111111111111112') {
      return 'SOL';
    }

    const mintPubkey = new PublicKey(mint);
    const mintInfo = await ctx.connection.getParsedAccountInfo(mintPubkey);

    if (mintInfo.value?.data && 'parsed' in mintInfo.value.data) {
      const parsedData = mintInfo.value.data.parsed;
      if (parsedData.info?.extensions) {
        for (const extension of parsedData.info.extensions) {
          if (extension.extension === 'tokenMetadata' && extension.state?.symbol) {
            return extension.state.symbol;
          }
        }
      }
    }

    return mint.slice(0, 8).toUpperCase();
  } catch (error) {
    return mint.slice(0, 8).toUpperCase();
  }
}

/**
 * Get total TVL across all rifts
 */
export async function getTotalTVL(ctx: ServiceContext): Promise<number> {
  try {
    const rifts = await getAllRifts(ctx);
    return rifts.reduce((sum, rift) => sum + rift.tvl, 0);
  } catch (error) {
    return 0;
  }
}

/**
 * Get total 24h volume across all rifts
 */
export async function getTotal24hVolume(ctx: ServiceContext): Promise<number> {
  try {
    const rifts = await getAllRifts(ctx);
    return rifts.reduce((sum, rift) => sum + rift.volume24h, 0);
  } catch (error) {
    return 0;
  }
}

/**
 * Get unique user count
 */
export async function getUniqueUserCount(ctx: ServiceContext): Promise<number> {
  try {
    const rifts = await getAllRifts(ctx);
    const uniqueCreators = new Set(rifts.map(rift => rift.creator));
    return uniqueCreators.size;
  } catch (error) {
    return 0;
  }
}

/**
 * Get performance history
 */
export async function getPerformanceHistory(): Promise<number[]> {
  const months = 12;
  const performance: number[] = [];
  let currentValue = 100;

  for (let i = 0; i < months; i++) {
    const change = (Math.random() - 0.4) * 0.1;
    currentValue *= (1 + change);
    performance.push(currentValue);
  }

  return performance;
}

/**
 * Save rifts to Supabase
 */
export async function saveRiftsToSupabase(rifts: ProductionRiftData[]): Promise<void> {
  try {
    const records = rifts.map(rift => ({
      id: rift.id,
      name: rift.symbol,
      is_open: rift.oracleStatus === 'active',
      total_tokens_wrapped: rift.tvl.toString(),
      total_fees_collected: '0',
      entry_price: rift.backingRatio.toString(),
      current_price: rift.realBackingRatio?.toString() || rift.backingRatio.toString(),
      price_change_24h: rift.priceDeviation || 0,
      volume_24h: rift.volume24h.toString(),
      total_participants: rift.participants,
      apy: rift.apy,
      token_mint: rift.riftMint,
      token_symbol: rift.symbol,
      token_decimals: 9,
      vault_balance: rift.tvl.toString(),
      is_deprecated: false,
      program_id: RIFTS_PROGRAM_ID.toBase58(),
      raw_data: rift
    }));

    const response = await fetch('/api/save-rifts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rifts: records })
    });

    if (!response.ok) {
      console.error('[SAVE] Failed to save rifts to Supabase');
    }
  } catch (error) {
    console.error('[SAVE] Error saving rifts to Supabase:', error);
  }
}
