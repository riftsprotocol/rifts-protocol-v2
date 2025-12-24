// Lightweight pool detection endpoint - runs independently of rifts-cache
// Detects DLMM and CP-AMM pools for rifts that don't have one yet
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import { PublicKey, Connection } from '@solana/web3.js';
import { getServerConnection } from '@/lib/solana/server-connection';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_HELIUS_API_KEY || '05cdb2bf-29b4-436b-afed-f757a4134fe6'}`;
const METEORA_CP_AMM_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
const SOL_MINT = 'So11111111111111111111111111111111111111112';

interface PoolDetectionResult {
  riftId: string;
  symbol: string;
  poolAddress: string;
  poolType: 'DLMM' | 'CP-AMM';
  pairedWith: string;
}

async function detectCpAmmPool(connection: Connection, riftMint: string): Promise<{ address: string; pairedWith: string } | null> {
  try {
    const riftMintPubkey = new PublicKey(riftMint);

    // Search for pools where rift is tokenA
    const poolsAsTokenA = await connection.getProgramAccounts(METEORA_CP_AMM_PROGRAM_ID, {
      filters: [
        { dataSize: 1112 },
        { memcmp: { offset: 168, bytes: riftMint } }
      ],
      dataSlice: { offset: 0, length: 0 },
      commitment: 'confirmed'
    }).catch(() => []);

    // Search for pools where rift is tokenB
    const poolsAsTokenB = await connection.getProgramAccounts(METEORA_CP_AMM_PROGRAM_ID, {
      filters: [
        { dataSize: 1112 },
        { memcmp: { offset: 200, bytes: riftMint } }
      ],
      dataSlice: { offset: 0, length: 0 },
      commitment: 'confirmed'
    }).catch(() => []);

    const allPools = [...poolsAsTokenA, ...poolsAsTokenB];
    if (allPools.length === 0) return null;

    // Find best pool (prefer SOL-paired)
    for (const pool of allPools) {
      try {
        const poolInfo = await connection.getAccountInfo(pool.pubkey);
        if (poolInfo && poolInfo.data.length >= 232) {
          const tokenAMint = new PublicKey(poolInfo.data.slice(168, 200)).toBase58();
          const tokenBMint = new PublicKey(poolInfo.data.slice(200, 232)).toBase58();

          if (tokenAMint === SOL_MINT || tokenBMint === SOL_MINT) {
            return {
              address: pool.pubkey.toBase58(),
              pairedWith: 'SOL'
            };
          }
        }
      } catch {}
    }

    // Fallback to first pool
    return {
      address: allPools[0].pubkey.toBase58(),
      pairedWith: 'unknown'
    };
  } catch (error) {
    console.error(`[DETECT-POOLS] CP-AMM search error for ${riftMint}:`, error);
    return null;
  }
}

async function detectDlmmPool(riftMint: string): Promise<{ address: string; pairedWith: string; tvl: number } | null> {
  try {
    const dlmmApiUrl = 'https://dlmm-api.meteora.ag/pair/all';
    const response = await fetch(dlmmApiUrl);

    if (!response.ok) return null;

    const allPools = await response.json();
    const matchingPools = allPools.filter((pool: any) =>
      pool.mint_x === riftMint || pool.mint_y === riftMint
    );

    if (matchingPools.length === 0) return null;

    // Prefer SOL-paired pools with highest TVL
    const solPaired = matchingPools.filter((pool: any) =>
      pool.mint_x === SOL_MINT || pool.mint_y === SOL_MINT
    );

    const poolsToCheck = solPaired.length > 0 ? solPaired : matchingPools;

    // Select highest TVL
    const bestPool = poolsToCheck.reduce((best: any, current: any) => {
      const currentTvl = parseFloat(current.liquidity || '0');
      const bestTvl = parseFloat(best?.liquidity || '0');
      return currentTvl > bestTvl ? current : best;
    }, null);

    if (!bestPool || !bestPool.address) return null;

    return {
      address: bestPool.address,
      pairedWith: solPaired.length > 0 ? 'SOL' : 'other',
      tvl: parseFloat(bestPool.liquidity || '0')
    };
  } catch (error) {
    console.error(`[DETECT-POOLS] DLMM search error for ${riftMint}:`, error);
    return null;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Allow GET for cron jobs and POST for manual triggers
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();
  console.log('[DETECT-POOLS] Starting pool detection...');

  try {
    // Fetch all rifts from Supabase
    const { data: rifts, error } = await supabase
      .from('rifts')
      .select('id, raw_data, updated_at')
      .eq('is_deprecated', false);

    if (error) {
      console.error('[DETECT-POOLS] Supabase fetch error:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!rifts || rifts.length === 0) {
      return res.status(200).json({ message: 'No rifts found', detected: [] });
    }

    const connection = await getServerConnection();
    const detected: PoolDetectionResult[] = [];
    const updated: string[] = [];

    // Process each rift
    for (const rift of rifts) {
      const rawData = rift.raw_data;
      if (!rawData || !rawData.riftMint) continue;

      const riftMint = rawData.riftMint;
      const symbol = rawData.symbol || 'unknown';
      const existingPool = rawData.liquidityPool || rawData.meteoraPool;
      const isMonorift = rawData.prefixType === 1;

      // Skip if already has a pool
      if (existingPool && existingPool !== '11111111111111111111111111111111') {
        continue;
      }

      console.log(`[DETECT-POOLS] Checking ${symbol} (${riftMint.slice(0, 8)}...) - ${isMonorift ? 'MONORIFT (DLMM only)' : 'DAMM v2 (CP-AMM only)'}`);

      if (isMonorift) {
        // MONORIFT: Only check DLMM pools
        const dlmmResult = await detectDlmmPool(riftMint);

        if (dlmmResult) {
          console.log(`[DETECT-POOLS] ✅ Found DLMM pool for monorift ${symbol}: ${dlmmResult.address}`);

          const updatedRawData = {
            ...rawData,
            hasMeteoraPool: true,
            liquidityPool: dlmmResult.address,
            meteoraPool: dlmmResult.address,
            meteoraPools: [dlmmResult.address]
          };

          const { error: updateError } = await supabase
            .from('rifts')
            .update({ raw_data: updatedRawData, updated_at: new Date().toISOString() })
            .eq('id', rift.id);

          if (updateError) {
            console.error(`[DETECT-POOLS] Update error for ${symbol}:`, updateError);
          } else {
            detected.push({
              riftId: rift.id,
              symbol,
              poolAddress: dlmmResult.address,
              poolType: 'DLMM',
              pairedWith: dlmmResult.pairedWith
            });
            updated.push(symbol);
          }
        } else {
          console.log(`[DETECT-POOLS] No DLMM pool found for monorift ${symbol}`);
        }
      } else {
        // DAMM v2 RIFT: Only check CP-AMM pools
        const cpAmmResult = await detectCpAmmPool(connection, riftMint);

        if (cpAmmResult) {
          console.log(`[DETECT-POOLS] ✅ Found CP-AMM (DAMM v2) pool for ${symbol}: ${cpAmmResult.address}`);

          const updatedRawData = {
            ...rawData,
            hasMeteoraPool: true,
            liquidityPool: cpAmmResult.address,
            meteoraPool: cpAmmResult.address,
            meteoraPools: [cpAmmResult.address]
          };

          const { error: updateError } = await supabase
            .from('rifts')
            .update({ raw_data: updatedRawData, updated_at: new Date().toISOString() })
            .eq('id', rift.id);

          if (updateError) {
            console.error(`[DETECT-POOLS] Update error for ${symbol}:`, updateError);
          } else {
            detected.push({
              riftId: rift.id,
              symbol,
              poolAddress: cpAmmResult.address,
              poolType: 'CP-AMM',
              pairedWith: cpAmmResult.pairedWith
            });
            updated.push(symbol);
          }
        } else {
          console.log(`[DETECT-POOLS] No CP-AMM pool found for ${symbol}`);
        }
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const duration = Date.now() - startTime;
    console.log(`[DETECT-POOLS] Completed in ${duration}ms. Detected ${detected.length} new pools.`);

    return res.status(200).json({
      success: true,
      detected,
      updated,
      totalRifts: rifts.length,
      newPoolsFound: detected.length,
      durationMs: duration
    });

  } catch (error) {
    console.error('[DETECT-POOLS] Error:', error);
    return res.status(500).json({ error: 'Pool detection failed' });
  }
}
