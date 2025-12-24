// Server-side cache warmer - keeps rift data hot and ready!
// Call this endpoint periodically to ensure instant wraps for all users
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Allow up to 60 seconds for warming cache

const RIFTS_PROGRAM_ID_STR = '8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC';

// In-memory cache (shared across requests on same server instance)
const riftDataCache = new Map<string, unknown>();
const mintDecimalsCache = new Map<string, { decimals: number; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const warmed: string[] = [];
  const errors: string[] = [];

  try {
    // Check required environment variables
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('[WARM-CACHE] ❌ Missing Supabase credentials');
      return NextResponse.json(
        {
          success: false,
          error: 'Missing Supabase credentials. Please set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.',
          missingVars: {
            NEXT_PUBLIC_SUPABASE_URL: !supabaseUrl,
            SUPABASE_SERVICE_ROLE_KEY: !supabaseServiceKey
          }
        },
        { status: 500 }
      );
    }

    // Dynamically import dependencies to avoid build-time issues
    const { createClient } = await import('@supabase/supabase-js');
    const { PublicKey } = await import('@solana/web3.js');
    const { getMintDecimals, saveMintDecimals } = await import('@/lib/supabase/client');
    const { getServerConnection } = await import('@/lib/solana/server-connection');

    const supabaseClient = createClient(supabaseUrl, supabaseServiceKey);
    const conn = await getServerConnection();

    console.log('[WARM-CACHE] 🔥 Starting server-side cache warming...');

    // 1. Fetch all rifts directly from Supabase (avoid internal HTTP fetch which fails in serverless)
    console.log('[WARM-CACHE] Fetching rifts from Supabase...');
    const { data: riftsFromDb, error: riftsError } = await supabaseClient
      .from('rifts')
      .select('*')
      .eq('is_deprecated', false)
      .order('updated_at', { ascending: false });

    if (riftsError) {
      console.error('[WARM-CACHE] Supabase error:', riftsError);
      throw new Error(`Failed to fetch rifts from Supabase: ${riftsError.message}`);
    }

    if (!riftsFromDb || riftsFromDb.length === 0) {
      throw new Error('No rifts found in Supabase. Run /api/rifts-cache first to populate the database.');
    }

    // Map Supabase rifts to expected format
    const rifts = riftsFromDb.map((r: any) => ({
      id: r.id,
      symbol: r.token_symbol,
      riftMint: r.token_mint,
      underlyingMint: r.raw_data?.underlyingMint,
      underlying: r.raw_data?.underlying,
      tvl: r.raw_data?.tvl || 0,
      apy: r.apy || 0
    }));

    console.log(`[WARM-CACHE] Found ${rifts.length} rifts to warm`);

    // 2. OPTIMIZED: Batch fetch all rift accounts at once (instead of one by one)
    console.log('[WARM-CACHE] 🚀 Batch fetching all rift accounts...');
    const riftPubkeys = rifts.map(r => new PublicKey(r.id)).filter(pk => pk);
    const riftAccountsInfo = await conn.getMultipleAccountsInfo(riftPubkeys, 'processed');
    console.log(`[WARM-CACHE] ✅ Fetched ${riftAccountsInfo.length} rift accounts in 1 batch call`);

    // Cache all rift account data
    for (let i = 0; i < rifts.length; i++) {
      const rift = rifts[i];
      const riftId = rift.id;
      const accountInfo = riftAccountsInfo[i];

      if (accountInfo && riftId) {
        riftDataCache.set(riftId, {
          data: accountInfo,
          timestamp: Date.now()
        });
        console.log(`[WARM-CACHE] ✅ Cached rift ${riftId.slice(0, 12)}`);
      }
    }

    // 3. Check which mints need to be fetched from RPC (not in Supabase)
    const mintsToFetch: { index: number; mintKey: string; pubkey: any }[] = [];
    const mintChecks = await Promise.all(
      rifts.map(async (rift, i) => {
        const underlyingMint = rift.underlyingMint || rift.underlying;
        if (!underlyingMint) return null;

        const supabaseDecimals = await getMintDecimals(underlyingMint);
        if (supabaseDecimals !== null) {
          // Already in Supabase - just add to memory cache
          mintDecimalsCache.set(underlyingMint, { decimals: supabaseDecimals, timestamp: Date.now() });
          console.log(`[WARM-CACHE] 💾 Mint ${underlyingMint.slice(0, 12)} already in Supabase: ${supabaseDecimals}`);
          return null;
        }

        // Need to fetch from RPC
        return { index: i, mintKey: underlyingMint, pubkey: new PublicKey(underlyingMint) };
      })
    );

    // Filter out nulls
    for (const check of mintChecks) {
      if (check) mintsToFetch.push(check);
    }

    // 4. OPTIMIZED: Batch fetch all mint accounts that aren't in Supabase
    if (mintsToFetch.length > 0) {
      console.log(`[WARM-CACHE] 🚀 Batch fetching ${mintsToFetch.length} mint accounts...`);
      const mintPubkeys = mintsToFetch.map(m => m.pubkey);
      const mintAccountsInfo = await conn.getMultipleAccountsInfo(mintPubkeys, 'processed');
      console.log(`[WARM-CACHE] ✅ Fetched ${mintAccountsInfo.length} mint accounts in 1 batch call`);

      // Process and cache mint decimals
      for (let i = 0; i < mintsToFetch.length; i++) {
        const { mintKey } = mintsToFetch[i];
        const mintInfo = mintAccountsInfo[i];

        try {
          if (mintInfo && mintInfo.data.length > 44) {
            const decimals = mintInfo.data[44]; // Decimals at byte 44

            // Save to in-memory cache
            mintDecimalsCache.set(mintKey, { decimals, timestamp: Date.now() });

            // Save to Supabase for persistence
            await saveMintDecimals(mintKey, decimals);

            console.log(`[WARM-CACHE] 💾 Cached decimals for ${mintKey.slice(0, 12)}: ${decimals}`);
            warmed.push(mintKey.slice(0, 8));
          } else {
            errors.push(`${mintKey.slice(0, 12)}: Invalid mint data`);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`[WARM-CACHE] ❌ Failed to process mint ${mintKey.slice(0, 12)}: ${errorMsg}`);
          errors.push(`${mintKey.slice(0, 12)}: ${errorMsg}`);
        }
      }
    }

    // Mark all rifts as warmed (even if some mints failed)
    for (const rift of rifts) {
      if (rift.id && !warmed.includes(rift.id.slice(0, 12))) {
        warmed.push(rift.id.slice(0, 12));
      }
    }

    const totalTime = Date.now() - startTime;
    const result = {
      success: true,
      riftsWarmed: warmed.length,
      totalRifts: rifts.length,
      errorsCount: errors.length,
      errorDetails: errors.length > 0 ? errors : undefined, // Include error details if any
      timeMs: totalTime,
      cacheSize: {
        riftData: riftDataCache.size,
        mintDecimals: mintDecimalsCache.size
      }
    };

    console.log(`[WARM-CACHE] ✅ Completed in ${totalTime}ms:`, result);
    if (errors.length > 0) {
      console.error('[WARM-CACHE] ⚠️ Errors encountered:', errors);
    }

    // ⚡ PRE-WARM ACCOUNT CACHE: Warm vault PDAs for instant pool creation
    try {
      console.log('[WARM-CACHE] 🔥 Pre-warming account cache...');

      // Calculate vault PDAs for all rifts (PublicKey already imported dynamically above)
      const RIFTS_PROGRAM_ID = new PublicKey(RIFTS_PROGRAM_ID_STR);
      const vaultAccounts: string[] = [];

      for (const rift of rifts) {
        const riftPubkey = new PublicKey(rift.id);
        const [vaultPDA] = PublicKey.findProgramAddressSync(
          [Buffer.from('vault'), riftPubkey.toBuffer()],
          RIFTS_PROGRAM_ID
        );
        vaultAccounts.push(vaultPDA.toBase58());
      }

      // Pre-warm the account cache by fetching all vault PDAs
      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
      const warmResponse = await fetch(`${baseUrl}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts: vaultAccounts })
      });

      if (warmResponse.ok) {
        const warmData = await warmResponse.json();
        console.log(`[WARM-CACHE] ✅ Pre-warmed ${vaultAccounts.length} vault accounts in account cache`);
      }
    } catch (err) {
      console.warn('[WARM-CACHE] ⚠️ Failed to pre-warm account cache (non-critical):', err);
    }

    return NextResponse.json(result);

  } catch (error) {
    console.error('[WARM-CACHE] Fatal error:', error);

    // Get detailed error information
    const errorDetails = {
      message: error instanceof Error ? error.message : 'Cache warming failed',
      stack: error instanceof Error ? error.stack : undefined,
      type: error instanceof Error ? error.constructor.name : typeof error,
      raw: String(error)
    };

    return NextResponse.json(
      {
        success: false,
        error: errorDetails.message,
        errorDetails,
        warmed: warmed.length,
        errors,
        env: {
          hasSupabaseUrl: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
          hasSupabaseKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
          hasRpcEndpoint: !!process.env.SOLANA_RPC_URL,
          hasSiteUrl: !!process.env.NEXT_PUBLIC_SITE_URL,
          siteUrl: process.env.NEXT_PUBLIC_SITE_URL
        }
      },
      { status: 500 }
    );
  }
}
