// Fast read-only rifts endpoint - just reads from Supabase, no RPC calls
// 🔧 FIX: Falls back to rifts-cache if data looks stale
import { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import { BLACKLISTED_RIFTS } from '@/lib/solana/rifts/types';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

// Minimum TVL threshold - if total TVL is below this, data is likely stale
const MIN_TOTAL_TVL_THRESHOLD = 1000; // $1000

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // Just read from Supabase - no RPC calls
    // Rift data is stored in the raw_data JSON column
    const { data: rifts, error } = await supabase
      .from('rifts')
      .select('id, raw_data, updated_at')
      .eq('is_deprecated', false)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('[RIFTS-READ] Supabase error:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    // Extract raw_data and filter out blacklisted rifts
    // raw_data contains the full rift object with id, symbol, tvl, etc.
    let filteredRifts = (rifts || [])
      .map((r: any) => r.raw_data)
      .filter((r: any) => r && !BLACKLISTED_RIFTS.includes(r.id));

    // 🔧 FIX: Check if data looks stale (total TVL too low)
    const totalTvl = filteredRifts.reduce((sum: number, r: any) => sum + (r?.tvl || 0), 0);

    if (totalTvl < MIN_TOTAL_TVL_THRESHOLD && filteredRifts.length > 0) {
      console.log(`[RIFTS-READ] ⚠️ Data looks stale (TVL=$${totalTvl.toFixed(2)}), triggering rifts-cache refresh...`);

      try {
        // Call rifts-cache internally to refresh data
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : 'http://localhost:3000';

        const cacheResponse = await fetch(`${baseUrl}/api/rifts-cache`, {
          headers: { 'x-refresh': 'true' },
          signal: AbortSignal.timeout(90000) // 90s timeout
        });

        if (cacheResponse.ok) {
          const cacheData = await cacheResponse.json();
          if (cacheData.success && cacheData.rifts?.length > 0) {
            console.log(`[RIFTS-READ] ✅ Got fresh data from rifts-cache: ${cacheData.rifts.length} rifts`);
            filteredRifts = cacheData.rifts.filter((r: any) => r && !BLACKLISTED_RIFTS.includes(r.id));
          }
        }
      } catch (fallbackError) {
        console.error('[RIFTS-READ] ❌ Fallback to rifts-cache failed:', fallbackError);
        // Continue with stale data rather than failing completely
      }
    }

    // Add burned rift programmatically (same as rifts-cache.ts)
    const BURNED_RIFT_SUPPLY = 120133315; // 120M rRIFTS tokens
    const BURNED_RIFT_MINT = 'B2ha7xqztT4qtmkzJC3yytaXnex2veEMiFXKUrVx6x8p';
    const RIFTS_UNDERLYING_MINT = 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';

    const burnedRiftExists = filteredRifts.some((r: any) => r.riftMint === BURNED_RIFT_MINT || r.id === BURNED_RIFT_MINT);

    if (!burnedRiftExists) {
      // Get RIFTS price from existing V2 RIFTS rift
      const riftsRift = filteredRifts.find((r: any) => r.underlyingMint === RIFTS_UNDERLYING_MINT);
      const riftsPrice = riftsRift?.underlyingTokenPrice || 0.0039; // Fallback estimate
      const burnedRiftTvl = BURNED_RIFT_SUPPLY * riftsPrice;

      const burnedRiftData = {
        id: BURNED_RIFT_MINT,
        programVersion: 'v1' as const,
        prefixType: 0, // Display as rRIFTS (not monorift)
        symbol: 'rRIFTS',
        underlying: 'RIFTS',
        underlyingMint: RIFTS_UNDERLYING_MINT,
        riftMint: BURNED_RIFT_MINT,
        vault: '',
        creator: '',
        tvl: burnedRiftTvl,
        vaultBalance: 0,
        underlyingTokenPrice: riftsPrice,
        riftTokenPrice: riftsPrice,
        totalRiftMinted: BURNED_RIFT_SUPPLY,
        backingRatio: 0,
        realBackingRatio: 0,
        burnFee: 0,
        partnerFee: 0,
        wrapFeeBps: 0,
        unwrapFeeBps: 0,
        partnerFeeBps: 0,
        totalFeesCollected: 0,
        isActive: false,
        oracleStatus: 'inactive' as const,
        // Don't set createdAt - let frontend handle it to avoid date parsing issues
        apy: 0,
        volume24h: 0,
        participants: 0,
        risk: 'High' as const,
        strategy: 'Burned' as const,
        performance: [0],
        arbitrageOpportunity: 0,
        hasMeteoraPool: false,
        liquidityPool: undefined,
        isBurned: true
      };

      filteredRifts.push(burnedRiftData);
      console.log(`[RIFTS-READ] 🔥 Added burned rift: TVL=$${burnedRiftTvl.toFixed(2)}`);
    }

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({
      success: true,
      rifts: filteredRifts,
      cached: true,
      source: 'supabase',
      count: filteredRifts.length
    });
  } catch (error) {
    console.error('[RIFTS-READ] Error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch rifts' });
  }
}
