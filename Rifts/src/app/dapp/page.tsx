import { createClient } from '@supabase/supabase-js'
import { BLACKLISTED_RIFTS } from '@/lib/solana/rifts/types'
import RiftsApp from './RiftsApp'

const isBlacklistedRift = (rift: any) => {
  const candidates = [rift?.id, rift?.address, rift?.riftMint];
  return candidates.some(id => id && BLACKLISTED_RIFTS.includes(id));
};

// Force dynamic rendering to avoid SSG issues with wallet hooks
export const dynamic = 'force-dynamic'

// Revalidate every 30 seconds for fresh data
export const revalidate = 30

// Fetch rifts on the server - no loading flash!
async function getRifts() {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    if (!supabaseUrl || !supabaseKey) {
      console.error('[SSR] Missing Supabase credentials')
      return []
    }

    const supabase = createClient(supabaseUrl, supabaseKey)

    // Rift data is stored in raw_data JSON column
    const { data: rifts, error } = await supabase
      .from('rifts')
      .select('id, raw_data')
      .eq('is_deprecated', false)
      .order('updated_at', { ascending: false })

    if (error) {
      console.error('[SSR] Supabase error:', {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
        raw: JSON.stringify(error)
      })
      return []
    }

    console.log('[SSR] Fetched', rifts?.length || 0, 'rifts from Supabase')
    if (rifts?.[0]) {
      console.log('[SSR] Sample raw_data keys:', Object.keys(rifts[0].raw_data || {}))
    }

    // Extract raw_data and filter blacklisted
    const filtered = (rifts || [])
      .map((r: any) => r.raw_data)
      .filter((r: any) => r && !BLACKLISTED_RIFTS.includes(r.id))

    // Add burned rift programmatically (same as rifts-read.ts)
    const BURNED_RIFT_SUPPLY = 120133315; // 120M rRIFTS tokens
    const BURNED_RIFT_MINT = 'B2ha7xqztT4qtmkzJC3yytaXnex2veEMiFXKUrVx6x8p';
    const RIFTS_UNDERLYING_MINT = 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';

    const burnedRiftExists = filtered.some((r: any) => r.riftMint === BURNED_RIFT_MINT || r.id === BURNED_RIFT_MINT);

    if (!burnedRiftExists) {
      // Get RIFTS price from existing V2 RIFTS rift
      const riftsRift = filtered.find((r: any) => r.underlyingMint === RIFTS_UNDERLYING_MINT);
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

      filtered.push(burnedRiftData);
      console.log(`[SSR] 🔥 Added burned rift: TVL=$${burnedRiftTvl.toFixed(2)}`);
    }

    console.log('[SSR] Returning', filtered.length, 'filtered rifts')
    return filtered
  } catch (err) {
    console.error('[SSR] Error fetching rifts:', err)
    return []
  }
}

export default async function DappPage() {
  const initialRifts = await getRifts()
  return <RiftsApp initialRifts={initialRifts} />
}
