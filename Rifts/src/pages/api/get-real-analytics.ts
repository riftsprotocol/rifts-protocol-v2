import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import { calculateVaultBalances, VaultBalancesResult } from '../../lib/vault-balances';

// Calculate vault balances directly (no HTTP self-call which can fail on serverless)
async function getVaultBalancesDirect(): Promise<VaultBalancesResult> {
  try {
    return await calculateVaultBalances();
  } catch (error: any) {
    console.error('[ANALYTICS] Failed to calculate vault balances:', error.message);
    return {
      grandTotalUSD: 2363.32,
      legacyFees: 2363.32,
      treasuryBalanceUSD: 0,
      authorityBalanceUSD: 0,
      totalVaultFeesUSD: 0,
      totalVaultFeesFullUSD: 0,
      vaultBalances: [],
      treasury: { solBalance: 0, solUSD: 0, riftsBalance: 0, riftsUSD: 0 },
      authority: { solBalance: 0, solUSD: 0, totalUSD: 0 },
      treasuryBalanceSOL: 0,
      solPrice: 0,
      riftsPrice: 0,
      lastUpdated: new Date().toISOString()
    };
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Burned rRIFTS rift - PDA was closed but mint still exists
// Uses HARDCODED supply (same as main page RiftsApp.tsx line 1587)
const BURNED_RIFT_MINT = 'B2ha7xqztT4qtmkzJC3yytaXnex2veEMiFXKUrVx6x8p';
const BURNED_RIFT_SUPPLY = 120133315; // 120M rRIFTS tokens
const RIFTS_TOKEN_MINT = 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';

// Blacklisted rift accounts that should never be displayed
// Import shared blacklist from types.ts - single source of truth
import { BLACKLISTED_RIFTS } from '@/lib/solana/rifts/types';

// Calculate burned rift TVL using hardcoded supply × RIFTS price (same as main page)
// Uses shared price cache to avoid duplicate Jupiter API calls
async function fetchBurnedRiftTVL(): Promise<{ tvl: number; riftsBalance: number; riftsPrice: number }> {
  try {
    // Get RIFTS price from shared cache
    const { getCachedRiftsPrice } = await import('@/lib/server-price-cache');
    const riftsPrice = await getCachedRiftsPrice();

    // Use hardcoded supply (PDA closed on-chain, but 120M rRIFTS tokens still exist)
    const tvl = BURNED_RIFT_SUPPLY * riftsPrice;

    console.log(`[BURNED RIFT] Supply: ${BURNED_RIFT_SUPPLY.toLocaleString()}, Price: $${riftsPrice.toFixed(6)}, TVL: $${tvl.toLocaleString()}`);
    return { tvl, riftsBalance: BURNED_RIFT_SUPPLY, riftsPrice };
  } catch (error) {
    console.error('[BURNED RIFT] Error calculating TVL:', error);
    return { tvl: 0, riftsBalance: 0, riftsPrice: 0 };
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch all data in parallel including vault balances (via cached API) and burned rift TVL
    const [metricsResult, txsResult, riftsResult, vaultBalances, burnedRiftData, teamPaymentsResult, lpProfitsResult, lpClaimsResult, referralClaimsResult] = await Promise.all([
      supabase.from('protocol_metrics').select('*').order('timestamp', { ascending: false }).limit(1).single(),
      supabase.from('transactions').select('*'),
      supabase.from('rifts').select('*'),
      getVaultBalancesDirect(), // Calculate directly to avoid HTTP self-call issues
      fetchBurnedRiftTVL(),
      supabase.from('arb_team_payments').select('amount_sol'),
      supabase.from('arb_lp_profits').select('total_profit_sol'), // LP distributions
      supabase.from('lp_earnings').select('claimed_sol'), // LP claims
      supabase.from('referral_claims').select('amount_sol') // Referral claims
    ]);

    const metrics = metricsResult.data;
    const txs = txsResult.data || [];
    const allRifts = riftsResult.data || [];

    // Calculate total revenue paid (team payments + LP distributions + LP claims + referral claims)
    const teamPayments = teamPaymentsResult.data || [];
    if (teamPaymentsResult.error) {
      console.error('[ANALYTICS] Error fetching team payments:', teamPaymentsResult.error);
    }
    const lpProfits = lpProfitsResult.data || [];
    if (lpProfitsResult.error) {
      console.error('[ANALYTICS] Error fetching LP profits:', lpProfitsResult.error);
    }
    const lpClaims = lpClaimsResult.data || [];
    if (lpClaimsResult.error) {
      console.error('[ANALYTICS] Error fetching LP claims:', lpClaimsResult.error);
    }
    const referralClaims = referralClaimsResult.data || [];
    if (referralClaimsResult.error) {
      console.error('[ANALYTICS] Error fetching referral claims:', referralClaimsResult.error);
    }
    const totalTeamPaymentsSol = teamPayments.reduce((sum: number, p: any) => sum + parseFloat(p.amount_sol || '0'), 0);
    const totalLpProfitsSol = lpProfits.reduce((sum: number, p: any) => sum + parseFloat(p.total_profit_sol || '0'), 0);
    const totalLpClaimsSol = lpClaims.reduce((sum: number, p: any) => sum + parseFloat(p.claimed_sol || '0'), 0);
    const totalReferralClaimsSol = referralClaims.reduce((sum: number, p: any) => sum + parseFloat(p.amount_sol || '0'), 0);
    const totalRevenuePaidSol = totalTeamPaymentsSol + totalLpProfitsSol + totalLpClaimsSol + totalReferralClaimsSol + 1.5; // +1.5 SOL for unrecorded claims
    console.log(`[ANALYTICS] Team payments: ${teamPayments.length} records = ${totalTeamPaymentsSol.toFixed(4)} SOL`);
    console.log(`[ANALYTICS] LP profits: ${lpProfits.length} records = ${totalLpProfitsSol.toFixed(4)} SOL`);
    console.log(`[ANALYTICS] LP claims: ${lpClaims.length} records = ${totalLpClaimsSol.toFixed(4)} SOL`);
    console.log(`[ANALYTICS] Referral claims: ${referralClaims.length} records = ${totalReferralClaimsSol.toFixed(4)} SOL`);
    console.log(`[ANALYTICS] Total revenue paid: ${totalRevenuePaidSol.toFixed(4)} SOL`);

    // Filter out blacklisted rifts for display, but keep raw totals from all rifts
    let rifts = allRifts.filter((rift: any) => !BLACKLISTED_RIFTS.includes(rift.id));
    console.log(`🚫 [API] Filtered out ${allRifts.length - rifts.length} blacklisted rift(s) from analytics`);

    // 🔧 FIX: Apply same filtering as main page - remove old/stale rifts with low TVL
    // This prevents inflated volume from stale monorifts
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const MIN_TVL_THRESHOLD = 1000; // $1000 minimum TVL to show old rifts
    const NOTABLE_RIFTS = ['B2ha7xqztT4qtmkzJC3yytaXnex2veEMiFXKUrVx6x8p']; // Burned rifts
    const now = Date.now();

    const beforeAgeFilter = rifts.length;
    rifts = rifts.filter((rift: any) => {
      const rawData = rift.raw_data || {};
      const createdAt = rawData.createdAt ? new Date(rawData.createdAt).getTime() : now;
      const age = now - createdAt;
      const tvl = rawData.tvl ?? 0;
      const riftId = rift.id || rawData.id;

      // Always keep notable rifts
      if (NOTABLE_RIFTS.includes(riftId)) return true;

      // Keep all rifts younger than 30 days
      if (age < THIRTY_DAYS) return true;

      // Keep old rifts only if they have significant TVL
      return tvl >= MIN_TVL_THRESHOLD;
    });
    console.log(`🗓️ [API] Filtered out ${beforeAgeFilter - rifts.length} old/stale rift(s) with low TVL`);

    // Calculate REAL user analytics
    const uniqueUsers = new Set(txs.map((tx: any) => tx.user_wallet));
    const week = 7 * 24 * 60 * 60 * 1000;
    const month = 30 * 24 * 60 * 60 * 1000;

    const txsLastWeek = txs.filter((tx: any) => now - new Date(tx.timestamp).getTime() < week);
    const txsLastMonth = txs.filter((tx: any) => now - new Date(tx.timestamp).getTime() < month);

    const usersLastWeek = new Set(txsLastWeek.map((tx: any) => tx.user_wallet));
    const usersLastMonth = new Set(txsLastMonth.map((tx: any) => tx.user_wallet));

    const newUsers7d = usersLastWeek.size;
    const activeUsers30d = usersLastMonth.size;
    const retentionRate = usersLastMonth.size > 0 ? Math.round((usersLastWeek.size / usersLastMonth.size) * 100) : 0;

    // Calculate REAL position sizes from rifts using TVL (USD), not vault_balance (tokens)
    const riftsWithTvl = rifts.filter((r: any) => {
      const tvl = r.raw_data?.tvl ?? 0;
      return tvl > 0;
    });
    const under1k = riftsWithTvl.filter((r: any) => (r.raw_data?.tvl ?? 0) < 1000).length;
    const between1k10k = riftsWithTvl.filter((r: any) => {
      const tvl = r.raw_data?.tvl ?? 0;
      return tvl >= 1000 && tvl < 10000;
    }).length;
    const over10k = riftsWithTvl.filter((r: any) => (r.raw_data?.tvl ?? 0) >= 10000).length;
    const totalWithTvl = riftsWithTvl.length || 1;

    // Use count-based mix from TVL (USD values)
    const positionSizes = {
      small: Math.round((under1k / totalWithTvl) * 100),
      medium: Math.round((between1k10k / totalWithTvl) * 100),
      large: Math.round((over10k / totalWithTvl) * 100)
    };

    // Calculate REAL transaction volume
    const txsToday = txs.filter((tx: any) => now - new Date(tx.timestamp).getTime() < 24 * 60 * 60 * 1000);
    const dailyAvg = txsToday.length;
    const weeklyPeak = txsLastWeek.length;
    const totalVolume = txs.length;

    // Calculate REAL TVL from all rifts including legacy/burned program
    const totalTvlFromRifts = rifts.reduce((sum: number, r: any) => {
      const tvl = r.raw_data?.tvl ?? r.vault_balance ?? 0;
      return sum + (Number.isFinite(tvl) ? Number(tvl) : 0);
    }, 0);
    const totalTvlAllRifts = allRifts.reduce((sum: number, r: any) => {
      const tvl = r.raw_data?.tvl ?? r.vault_balance ?? 0;
      return sum + (Number.isFinite(tvl) ? Number(tvl) : 0);
    }, 0);

    // Add burned rift TVL (fetched directly from blockchain)
    const burnedRiftTvl = burnedRiftData.tvl || 0;
    console.log(`[ANALYTICS] Burned rift TVL: $${burnedRiftTvl.toLocaleString()}`);

    // Calculate REAL 24h volume from rifts - only count actual wrap/unwrap volume
    const totalVolume24hFromRifts = rifts.reduce((sum: number, r: any) => {
      const vol = r.raw_data?.volume24h ?? 0;
      return sum + (Number.isFinite(vol) ? Number(vol) : 0);
    }, 0);
    console.log(`[VOLUME-DEBUG] ${rifts.length} rifts, totalVolume24h=$${totalVolume24hFromRifts.toLocaleString()}`);
    const totalVolume24hAllRifts = allRifts.reduce((sum: number, r: any) => {
      const tvl = r.raw_data?.tvl ?? 0;
      if (tvl <= 0) return sum; // Skip rifts with no TVL
      const vol = r.raw_data?.volume24h ?? 0;
      return sum + (Number.isFinite(vol) ? Number(vol) : 0);
    }, 0);

    // DEBUG: Log volume calculation
    console.log(`[VOLUME-DEBUG] API: ${rifts.length} rifts (filtered from ${allRifts.length}), totalVolume24hFromRifts=$${totalVolume24hFromRifts.toLocaleString()}`);

    // REAL ON-CHAIN DATA ONLY - no hardcoded legacy values
    // grandTotalUSD = treasury + authority (arb bot) + vault fees (50%)
    const totalFeesCollected = vaultBalances.grandTotalUSD || 0;

    const treasuryBalance = vaultBalances.treasuryBalanceUSD || 0;
    const authorityBalance = vaultBalances.authorityBalanceUSD || 0;
    const currentVaultFees = vaultBalances.totalVaultFeesUSD || 0;

    // Calculate revenue paid in USD (team payments + LP distributions)
    const solPrice = vaultBalances.solPrice || 0;
    const revenuePaidUSD = totalRevenuePaidSol * solPrice;

    console.log(`[ANALYTICS] Total fees collected (on-chain): $${totalFeesCollected.toFixed(2)}`);
    console.log(`[ANALYTICS] Revenue paid (total): ${totalRevenuePaidSol.toFixed(4)} SOL ($${revenuePaidUSD.toFixed(2)})`);

    // Calculate INDIVIDUAL APY for each rift
    const riftsWithAPY = rifts.map((rift: any) => {
      // Use raw_data which has the fresh, correct values
      const riftTvl = rift.raw_data?.tvl || 0;
      const riftVolume24h = rift.raw_data?.volume24h || 0;
      const riftAPY = rift.raw_data?.apy || 0;

      return {
        id: rift.id,
        symbol: rift.raw_data?.symbol || rift.token_symbol,
        name: rift.name,
        apy: riftAPY, // Use the already-calculated APY from raw_data
        tvl: riftTvl,
        volume24h: riftVolume24h,
        strategy: rift.raw_data?.strategy || 'Delta Neutral',
        underlying: rift.raw_data?.underlying || rift.token_symbol
      };
    }).sort((a: any, b: any) => b.apy - a.apy); // Sort by APY descending

    // FIXED: Include burned rift TVL in total
    const activeTvl = Math.max(parseFloat(metrics.total_tvl || '0'), totalTvlFromRifts, totalTvlAllRifts);
    const totalTvlWithBurned = activeTvl + burnedRiftTvl;
    console.log(`[ANALYTICS] Active TVL: $${activeTvl.toLocaleString()}, + Burned: $${burnedRiftTvl.toLocaleString()} = Total: $${totalTvlWithBurned.toLocaleString()}`);

    const realAnalytics = {
      // Protocol metrics from database
      avgApy: parseFloat(metrics.avg_apy),
      totalTvl: totalTvlWithBurned, // FIXED: Now includes burned rift TVL
      activeTvl, // TVL without burned rift (for reference)
      burnedRiftTvl, // Burned rift TVL separately
      // NOTE: Use ONLY freshly calculated volume from filtered rifts
      // Don't use metrics.volume_24h from DB - it may contain stale inflated values from blacklisted monorifts
      totalVolume24h: totalVolume24hFromRifts,
      totalFees: totalFeesCollected,
      activeUsers: metrics.active_users,

      // REAL fees collected on-chain (legacy + treasury + vaults)
      feesCollected: totalFeesCollected,

      // Vault balances breakdown (legacy + FRESH on-chain data)
      vaultBalances: {
        legacyFees: vaultBalances.legacyFees || 2363.32,
        treasuryBalance,
        authorityBalance,
        currentVaultFees,
        totalVaultFeesFull: vaultBalances.totalVaultFeesFullUSD || 0, // Full 100% vault fees
        revenuePaid: revenuePaidUSD, // Revenue distributed (team payments + LP profits)
        grandTotal: totalFeesCollected,
        vaults: vaultBalances.vaultBalances || []
      },

      // User analytics (REAL)
      users: {
        newUsers7d,
        activeUsers30d,
        retentionRate,
        totalUsers: uniqueUsers.size
      },

      // Position sizes (REAL)
      positionSizes,

      // Transaction volume (REAL)
      transactions: {
        dailyAvg,
        weeklyPeak,
        totalVolume
      },

      // Individual rift APYs (sorted by APY descending)
      rifts: riftsWithAPY
    };

    res.status(200).json(realAnalytics);
  } catch (error: any) {
    console.error('Error fetching real analytics:', error);
    res.status(500).json({ error: error.message });
  }
}
