import { NextRequest, NextResponse } from 'next/server';

/**
 * LP EARNINGS SYNC ENDPOINT
 *
 * Calculates and records LP earnings from arb bot trades.
 * - Reads successful trades from arb_bot_trades
 * - Calculates LP share based on their share_pct in arb_lp_positions
 * - Records accumulated earnings in lp_earnings table
 * - Also calculates referral earnings (5% of LP/team profits)
 *
 * Called via cron job (every 15 minutes) or manually.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://nitmreqtsnzjylyzwsri.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Admin wallet for authenticated sync
const ADMIN_WALLET = '9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4';
// Cron secret for Vercel cron jobs
const CRON_SECRET = process.env.CRON_SECRET || '';

// LP split rates
const EXTERNAL_LP_SPLIT = 40; // External LPs always get 40%
const TEAM_LP_SPLIT = 80;     // Team (rift creator) gets 80% on team rifts

// VIP wallets - always get 10% referral bonus regardless of referral count
const VIP_WALLETS = [
  'H1v8BRhuATZv9ELpYMuaZut5c3UtCKxxgKpFLbVnErWp', // Boosted wallet
];

// Tiered referral rates: 0-4 refs = 5%, 5-9 refs = 8%, 10+ refs = 10%
// VIP wallets always get 10%
function getReferralPercentage(referralCount: number, referrerWallet?: string): number {
  // VIP wallets always get max rate
  if (referrerWallet && VIP_WALLETS.includes(referrerWallet)) {
    return 10;
  }
  if (referralCount >= 10) return 10;
  if (referralCount >= 5) return 8;
  return 5;
}

// Helper to get Supabase headers
const getHeaders = (forWrite = false) => {
  const key = forWrite && SUPABASE_SERVICE_KEY ? SUPABASE_SERVICE_KEY : SUPABASE_ANON_KEY;
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
};

// Fetch all rows with pagination
async function fetchAllRows(endpoint: string): Promise<any[]> {
  const allRows: any[] = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `${SUPABASE_URL}/rest/v1/${endpoint}${separator}limit=${pageSize}&offset=${offset}`;

    const response = await fetch(url, {
      headers: getHeaders(),
      cache: 'no-store',
    });

    if (!response.ok) break;

    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) break;

    allRows.push(...rows);
    if (rows.length < pageSize) break;

    offset += pageSize;
  }

  return allRows;
}

interface LpPosition {
  rift_id: string;
  wallet_address: string;
  share_pct: number;
  created_at?: string; // When LP first deposited
}

interface RiftConfig {
  rift_id: string;
  is_team_rift: boolean;
  fees_enabled: boolean;
  fees_enabled_at?: string; // When fees were enabled - only count trades after this
}

interface Trade {
  rift_id: string;
  actual_profit_sol: string;
  success: boolean;
  created_at: string;
}

interface LpEarning {
  rift_id: string;
  wallet_address: string;
  total_earned_sol: number;
  claimed_sol: number;
  last_trade_at: string;
}

// GET - Sync LP earnings from trades (authenticated: admin wallet or cron secret)
export async function GET(request: NextRequest) {
  // Authentication check
  const searchParams = request.nextUrl.searchParams;
  const wallet = searchParams.get('wallet');
  const cronSecret = request.headers.get('x-cron-secret') || searchParams.get('secret');

  // Allow: admin wallet, valid cron secret, or Vercel cron
  const authHeader = request.headers.get('authorization');
  const isVercelCron = authHeader === `Bearer ${CRON_SECRET}`;
  const isValidCronSecret = CRON_SECRET && cronSecret === CRON_SECRET;
  const isAdmin = wallet === ADMIN_WALLET;

  if (!isAdmin && !isValidCronSecret && !isVercelCron) {
    console.log('[LP-EARNINGS-SYNC] Unauthorized sync attempt');
    return NextResponse.json({ error: 'Unauthorized. Provide admin wallet or cron secret.' }, { status: 403 });
  }

  const startTime = Date.now();
  console.log(`[LP-EARNINGS-SYNC] Starting sync (auth: ${isAdmin ? 'admin' : isVercelCron ? 'vercel-cron' : 'cron-secret'})...`);

  try {
    // 1. Fetch all successful trades
    const trades: Trade[] = await fetchAllRows('arb_bot_trades?success=eq.true&select=rift_id,actual_profit_sol,success,created_at');
    console.log(`[LP-EARNINGS-SYNC] Fetched ${trades.length} successful trades`);

    if (trades.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No trades to process',
        processed: 0,
      });
    }

    // 2. Calculate total profit per rift
    const profitByRift = new Map<string, { totalProfit: number; lastTradeAt: string }>();
    for (const trade of trades) {
      const profit = parseFloat(trade.actual_profit_sol) || 0;
      if (profit <= 0) continue;

      const existing = profitByRift.get(trade.rift_id);
      if (existing) {
        existing.totalProfit += profit;
        if (trade.created_at > existing.lastTradeAt) {
          existing.lastTradeAt = trade.created_at;
        }
      } else {
        profitByRift.set(trade.rift_id, {
          totalProfit: profit,
          lastTradeAt: trade.created_at,
        });
      }
    }
    console.log(`[LP-EARNINGS-SYNC] Profits calculated for ${profitByRift.size} rifts`);

    // 3. Fetch rift configs (team vs fee rift)
    const configs: RiftConfig[] = await fetchAllRows('arb_rift_config?select=rift_id,is_team_rift,fees_enabled,fees_enabled_at');
    const configMap = new Map(configs.map(c => [c.rift_id, c]));

    // 4. Fetch LP positions (including created_at for deposit-time filtering)
    const lpPositions: LpPosition[] = await fetchAllRows('arb_lp_positions?select=rift_id,wallet_address,share_pct,created_at');
    console.log(`[LP-EARNINGS-SYNC] Fetched ${lpPositions.length} LP positions`);

    // Group LP positions by rift
    const lpsByRift = new Map<string, LpPosition[]>();
    for (const lp of lpPositions) {
      const existing = lpsByRift.get(lp.rift_id) || [];
      existing.push(lp);
      lpsByRift.set(lp.rift_id, existing);
    }

    // 5. Fetch rift creators for team rifts
    const riftsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/rifts?select=id,raw_data`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const rifts = riftsResponse.ok ? await riftsResponse.json() : [];
    const creatorByRift = new Map<string, string>();
    for (const rift of rifts) {
      if (rift.raw_data?.creator) {
        creatorByRift.set(rift.id, rift.raw_data.creator);
      }
    }

    // 6. Fetch referral data
    const referrals = await fetchAllRows('referrals?select=referrer_wallet,referred_wallet');
    const referrerByWallet = new Map<string, string>();
    for (const ref of referrals) {
      referrerByWallet.set(ref.referred_wallet, ref.referrer_wallet);
    }

    // Fetch referred rifts (rifts created by referred users)
    const referredRifts = await fetchAllRows('referred_rifts?select=rift_id,referrer_wallet,referred_wallet');
    const referrerByRift = new Map<string, string>();
    for (const ref of referredRifts) {
      referrerByRift.set(ref.rift_id, ref.referrer_wallet);
    }

    // Build active referral counts (only referrals who generated earnings count towards tier)
    // A referral is active if:
    // 1. They created a rift with profits (in referredRifts and profitByRift has that rift)
    // 2. OR they're an LP with earnings (in lpPositions and the rift has profit)
    const activeReferralsByReferrer = new Map<string, Set<string>>();

    // Check rifts created by referred users that have profit
    for (const ref of referredRifts) {
      if (profitByRift.has(ref.rift_id) && profitByRift.get(ref.rift_id)!.totalProfit > 0) {
        const set = activeReferralsByReferrer.get(ref.referrer_wallet) || new Set();
        set.add(ref.referred_wallet);
        activeReferralsByReferrer.set(ref.referrer_wallet, set);
      }
    }

    // Check LPs who are referred and have profit from their positions
    for (const lp of lpPositions) {
      const referrer = referrerByWallet.get(lp.wallet_address);
      if (referrer && profitByRift.has(lp.rift_id) && profitByRift.get(lp.rift_id)!.totalProfit > 0) {
        const set = activeReferralsByReferrer.get(referrer) || new Set();
        set.add(lp.wallet_address);
        activeReferralsByReferrer.set(referrer, set);
      }
    }

    // Count active referrals per referrer
    const activeReferralCountByReferrer = new Map<string, number>();
    for (const [referrer, activeSet] of activeReferralsByReferrer) {
      activeReferralCountByReferrer.set(referrer, activeSet.size);
    }

    // 6b. Fetch existing LP earnings to preserve claimed_sol values
    const existingEarnings = await fetchAllRows('lp_earnings?select=rift_id,wallet_address,claimed_sol');
    const claimedByKey = new Map<string, number>();
    for (const e of existingEarnings) {
      const key = `${e.rift_id}:${e.wallet_address}`;
      claimedByKey.set(key, parseFloat(e.claimed_sol) || 0);
    }
    console.log(`[LP-EARNINGS-SYNC] Fetched ${existingEarnings.length} existing earnings with claimed values`);

    // 7. Calculate LP earnings
    const lpEarnings: LpEarning[] = [];
    const referralEarnings: { referrer_wallet: string; source_type: string; source_id: string; amount_sol: number; referred_wallet: string | null }[] = [];

    for (const [riftId, profitData] of profitByRift) {
      const config = configMap.get(riftId);
      const isTeamRift = config?.is_team_rift ?? false;
      const feesEnabled = config?.fees_enabled !== false;
      // Only count trades AFTER fees were enabled (default to epoch if always enabled)
      const feesEnabledAt = config?.fees_enabled_at || '1970-01-01T00:00:00Z';

      if (!feesEnabled) continue;

      // Get rift creator (team wallet)
      const riftCreator = creatorByRift.get(riftId);

      // Get trades for this rift, filtered by fees_enabled_at
      const riftTrades = trades.filter(t => t.rift_id === riftId && t.success && t.created_at > feesEnabledAt);
      const riftProfit = riftTrades.reduce((sum, t) => sum + (parseFloat(t.actual_profit_sol) || 0), 0);

      if (riftProfit <= 0) continue;

      const lastTradeAt = riftTrades.length > 0
        ? riftTrades.reduce((latest, t) => t.created_at > latest ? t.created_at : latest, riftTrades[0].created_at)
        : profitData.lastTradeAt;

      // LP earnings distribution:
      // - Team rifts: Creator gets 80% split, external LPs get 40% split
      // - Normal rifts: All LPs get 40% split
      // IMPORTANT: Only count trades that happened AFTER BOTH:
      // 1. fees_enabled_at (when fees were turned on for this rift)
      // 2. LP's created_at (when LP deposited)
      const lps = lpsByRift.get(riftId) || [];

      for (const lp of lps) {
        // Use the LATER of fees_enabled_at and lp.created_at
        const lpCreatedAt = lp.created_at || '1970-01-01T00:00:00Z';
        const cutoffTime = lpCreatedAt > feesEnabledAt ? lpCreatedAt : feesEnabledAt;

        const eligibleTrades = riftTrades.filter(t => t.created_at > cutoffTime);
        const eligibleProfit = eligibleTrades.reduce((sum, t) => sum + (parseFloat(t.actual_profit_sol) || 0), 0);

        // Determine LP split rate:
        // - If team rift AND this LP is the creator → 80%
        // - Otherwise (external LP or normal rift) → 40%
        const isTeamWallet = isTeamRift && riftCreator && lp.wallet_address === riftCreator;
        const lpSplitRate = isTeamWallet ? TEAM_LP_SPLIT : EXTERNAL_LP_SPLIT;

        // Apply LP split and their share percentage
        let lpEarning = (eligibleProfit * lpSplitRate / 100) * (lp.share_pct / 100);

        // VIP wallets get 10% bonus on their own earnings (from protocol's share)
        if (VIP_WALLETS.includes(lp.wallet_address)) {
          const vipBonus = lpEarning * 0.10;
          lpEarning += vipBonus;
          console.log(`[LP-EARNINGS-SYNC] VIP bonus for ${lp.wallet_address.slice(0, 8)}...: +${vipBonus.toFixed(6)} SOL`);
        }

        const lpLastTradeAt = eligibleTrades.length > 0
          ? eligibleTrades.reduce((latest, t) => t.created_at > latest ? t.created_at : latest, eligibleTrades[0].created_at)
          : lastTradeAt;

        if (lpEarning > 0.000001) {
          const key = `${riftId}:${lp.wallet_address}`;
          lpEarnings.push({
            rift_id: riftId,
            wallet_address: lp.wallet_address,
            total_earned_sol: lpEarning,
            claimed_sol: claimedByKey.get(key) || 0, // Preserve claimed amount
            last_trade_at: lpLastTradeAt,
          });

          // Check if LP was referred - referrer gets tiered % of their LP profits
          const referrer = referrerByWallet.get(lp.wallet_address);
          if (referrer) {
            const refCount = activeReferralCountByReferrer.get(referrer) || 0;
            const referralPct = getReferralPercentage(refCount, referrer);
            const referralAmount = lpEarning * (referralPct / 100);
            if (referralAmount > 0.000001) {
              referralEarnings.push({
                referrer_wallet: referrer,
                source_type: 'lp_profit',
                source_id: riftId,
                amount_sol: referralAmount,
                referred_wallet: lp.wallet_address,
              });
            }
          }
        }
      }
    }

    console.log(`[LP-EARNINGS-SYNC] Calculated ${lpEarnings.length} LP earnings, ${referralEarnings.length} referral earnings`);

    // 8. Upsert LP earnings to database using SAFE upsert (no delete+insert race condition)
    // This preserves claimed_sol even if sync crashes mid-way
    const lpEarningsKeys = new Set<string>();

    for (const le of lpEarnings) {
      const key = `${le.rift_id}:${le.wallet_address}`;
      lpEarningsKeys.add(key);

      // Upsert: update total_earned_sol but preserve claimed_sol from DB
      const upsertResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/lp_earnings?on_conflict=rift_id,wallet_address`,
        {
          method: 'POST',
          headers: { ...getHeaders(true), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            rift_id: le.rift_id,
            wallet_address: le.wallet_address,
            total_earned_sol: le.total_earned_sol,
            // Don't include claimed_sol - let DB preserve existing value
            last_trade_at: le.last_trade_at,
            updated_at: new Date().toISOString(),
          }),
        }
      );

      if (!upsertResponse.ok) {
        const error = await upsertResponse.text();
        // If table doesn't exist, report migration needed
        if (error.includes('relation') && error.includes('does not exist')) {
          return NextResponse.json({
            success: false,
            error: 'lp_earnings table does not exist. Please run the migration.',
            migration: `
CREATE TABLE public.lp_earnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rift_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  total_earned_sol DECIMAL(20,9) NOT NULL DEFAULT 0,
  claimed_sol DECIMAL(20,9) NOT NULL DEFAULT 0,
  last_trade_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(rift_id, wallet_address)
);

CREATE INDEX idx_lp_earnings_wallet ON public.lp_earnings(wallet_address);
CREATE INDEX idx_lp_earnings_rift ON public.lp_earnings(rift_id);
            `,
          }, { status: 500 });
        }
        console.error(`[LP-EARNINGS-SYNC] Failed to upsert LP earning for ${le.wallet_address}:`, error);
      }
    }
    console.log(`[LP-EARNINGS-SYNC] Upserted ${lpEarnings.length} LP earnings`);

    // Clean up stale LP earnings (wallets no longer earning)
    // Only delete records where claimed_sol >= total_earned_sol (fully claimed)
    // This prevents losing unclaimed earnings if LP temporarily has no new trades
    const existingEarningsForCleanup = await fetchAllRows('lp_earnings?select=rift_id,wallet_address,total_earned_sol,claimed_sol');
    let deletedCount = 0;
    for (const existing of existingEarningsForCleanup) {
      const key = `${existing.rift_id}:${existing.wallet_address}`;
      if (!lpEarningsKeys.has(key)) {
        // Only delete if fully claimed (no unclaimed balance)
        const totalEarned = parseFloat(existing.total_earned_sol) || 0;
        const claimed = parseFloat(existing.claimed_sol) || 0;
        if (claimed >= totalEarned) {
          await fetch(
            `${SUPABASE_URL}/rest/v1/lp_earnings?rift_id=eq.${existing.rift_id}&wallet_address=eq.${existing.wallet_address}`,
            { method: 'DELETE', headers: getHeaders(true) }
          );
          deletedCount++;
        }
      }
    }
    if (deletedCount > 0) {
      console.log(`[LP-EARNINGS-SYNC] Cleaned up ${deletedCount} fully-claimed stale LP earnings`);
    }

    // 9. Upsert referral earnings using SAFE upsert (same pattern)
    const refEarningsKeys = new Set<string>();

    for (const re of referralEarnings) {
      // Create unique key for this referral earning
      const key = `${re.referrer_wallet}:${re.source_type}:${re.source_id}:${re.referred_wallet || 'null'}`;
      refEarningsKeys.add(key);

      // For referral earnings, we need to check if record exists and update or insert
      // Using source_id + referrer_wallet + referred_wallet as composite key
      const existingRef = await fetch(
        `${SUPABASE_URL}/rest/v1/referral_earnings?referrer_wallet=eq.${re.referrer_wallet}&source_id=eq.${re.source_id}&referred_wallet=eq.${re.referred_wallet || 'null'}&select=id`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const existingRefData = existingRef.ok ? await existingRef.json() : [];

      if (existingRefData.length > 0) {
        // Update existing
        await fetch(
          `${SUPABASE_URL}/rest/v1/referral_earnings?id=eq.${existingRefData[0].id}`,
          {
            method: 'PATCH',
            headers: getHeaders(true),
            body: JSON.stringify({ amount_sol: re.amount_sol }),
          }
        );
      } else {
        // Insert new
        await fetch(
          `${SUPABASE_URL}/rest/v1/referral_earnings`,
          {
            method: 'POST',
            headers: { ...getHeaders(true), 'Prefer': 'return=minimal' },
            body: JSON.stringify(re),
          }
        );
      }
    }
    console.log(`[LP-EARNINGS-SYNC] Upserted ${referralEarnings.length} referral earnings`);

    // Clean up stale referral earnings (only if fully claimed)
    const existingRefForCleanup = await fetchAllRows('referral_earnings?select=id,referrer_wallet,source_id,referred_wallet,amount_sol');
    const refClaimsAll = await fetchAllRows('referral_claims?select=referrer_wallet,amount_sol');
    const claimedByReferrer = new Map<string, number>();
    for (const rc of refClaimsAll) {
      const current = claimedByReferrer.get(rc.referrer_wallet) || 0;
      claimedByReferrer.set(rc.referrer_wallet, current + parseFloat(rc.amount_sol || '0'));
    }

    let refDeletedCount = 0;
    for (const existing of existingRefForCleanup) {
      const key = `${existing.referrer_wallet}:lp_profit:${existing.source_id}:${existing.referred_wallet || 'null'}`;
      if (!refEarningsKeys.has(key)) {
        // Check if this referrer has fully claimed
        const totalClaimed = claimedByReferrer.get(existing.referrer_wallet) || 0;
        // Only delete if referrer has claimed something (conservative cleanup)
        if (totalClaimed > 0) {
          await fetch(
            `${SUPABASE_URL}/rest/v1/referral_earnings?id=eq.${existing.id}`,
            { method: 'DELETE', headers: getHeaders(true) }
          );
          refDeletedCount++;
        }
      }
    }
    if (refDeletedCount > 0) {
      console.log(`[LP-EARNINGS-SYNC] Cleaned up ${refDeletedCount} stale referral earnings`);
    }

    const duration = Date.now() - startTime;
    console.log(`[LP-EARNINGS-SYNC] Sync completed in ${duration}ms`);

    return NextResponse.json({
      success: true,
      processed: {
        trades: trades.length,
        riftsWithProfit: profitByRift.size,
        lpEarnings: lpEarnings.length,
        referralEarnings: referralEarnings.length,
      },
      duration: `${duration}ms`,
    });
  } catch (error) {
    console.error('[LP-EARNINGS-SYNC] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 }
    );
  }
}

// POST - Force sync for specific rift (optional)
export async function POST(request: NextRequest) {
  // For now, just call GET handler
  return GET(request);
}
