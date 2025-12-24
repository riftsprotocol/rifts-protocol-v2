import { NextRequest, NextResponse } from 'next/server';

/**
 * LP EARNINGS VIEW ENDPOINT
 *
 * Returns current lp_earnings AND referral_earnings data for admin view.
 * Shows total earned, claimed, and claimable amounts.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://nitmreqtsnzjylyzwsri.supabase.co';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const ADMIN_WALLET = '9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4';

const getHeaders = () => ({
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
});

// GET - Fetch all LP earnings and referral earnings with rift symbols
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const wallet = searchParams.get('wallet');

    // Only admin can view all earnings
    if (wallet !== ADMIN_WALLET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    // Fetch lp_earnings, referral_earnings, and referral_claims in parallel
    const [earningsResponse, riftsResponse, referralEarningsResponse, referralClaimsResponse] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/lp_earnings?select=rift_id,wallet_address,total_earned_sol,claimed_sol,last_trade_at`,
        { headers: getHeaders(), cache: 'no-store' }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/rifts?select=id,token_symbol`,
        { headers: getHeaders(), cache: 'no-store' }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/referral_earnings?select=referrer_wallet,source_type,source_id,amount_sol,referred_wallet,created_at`,
        { headers: getHeaders(), cache: 'no-store' }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/referral_claims?select=referrer_wallet,amount_sol,signature,created_at`,
        { headers: getHeaders(), cache: 'no-store' }
      ),
    ]);

    const earnings = earningsResponse.ok ? await earningsResponse.json() : [];
    const rifts = riftsResponse.ok ? await riftsResponse.json() : [];
    const referralEarnings = referralEarningsResponse.ok ? await referralEarningsResponse.json() : [];
    const referralClaims = referralClaimsResponse.ok ? await referralClaimsResponse.json() : [];

    const riftSymbolMap = new Map<string, string>(
      rifts.map((r: { id: string; token_symbol: string | null }) => [r.id, r.token_symbol || 'Unknown'])
    );

    // ===== LP EARNINGS =====
    let totalEarned = 0;
    let totalClaimed = 0;
    let totalClaimable = 0;

    // Per-rift aggregation
    const riftAggregation = new Map<string, {
      rift_id: string;
      rift_symbol: string;
      total_earned_sol: number;
      claimed_sol: number;
      claimable: number;
      lp_count: number;
    }>();

    const enrichedEarnings = earnings.map((e: { rift_id: string; wallet_address: string; total_earned_sol: number; claimed_sol: number }) => {
      const earned = parseFloat(String(e.total_earned_sol)) || 0;
      const claimed = parseFloat(String(e.claimed_sol)) || 0;
      const claimable = Math.max(0, earned - claimed);

      totalEarned += earned;
      totalClaimed += claimed;
      totalClaimable += claimable;

      // Aggregate by rift
      const existing = riftAggregation.get(e.rift_id);
      if (existing) {
        existing.total_earned_sol += earned;
        existing.claimed_sol += claimed;
        existing.claimable += claimable;
        existing.lp_count += 1;
      } else {
        riftAggregation.set(e.rift_id, {
          rift_id: e.rift_id,
          rift_symbol: riftSymbolMap.get(e.rift_id) || 'Unknown',
          total_earned_sol: earned,
          claimed_sol: claimed,
          claimable,
          lp_count: 1,
        });
      }

      return {
        rift_id: e.rift_id,
        rift_symbol: riftSymbolMap.get(e.rift_id) || 'Unknown',
        wallet_address: e.wallet_address,
        total_earned_sol: earned,
        claimed_sol: claimed,
        claimable,
      };
    });

    // Sort rifts by claimable amount (descending)
    const riftBreakdown = Array.from(riftAggregation.values())
      .sort((a, b) => b.claimable - a.claimable);

    // ===== REFERRAL EARNINGS =====
    // Aggregate earnings by referrer wallet
    const referrerEarnings = new Map<string, number>();
    for (const re of referralEarnings) {
      const amount = parseFloat(re.amount_sol) || 0;
      referrerEarnings.set(re.referrer_wallet, (referrerEarnings.get(re.referrer_wallet) || 0) + amount);
    }

    // Aggregate claims by referrer wallet
    const referrerClaims = new Map<string, number>();
    for (const rc of referralClaims) {
      const amount = parseFloat(rc.amount_sol) || 0;
      referrerClaims.set(rc.referrer_wallet, (referrerClaims.get(rc.referrer_wallet) || 0) + amount);
    }

    // Build referral breakdown per wallet
    const referralBreakdown: {
      wallet: string;
      total_earned: number;
      total_claimed: number;
      claimable: number;
      earnings_count: number;
    }[] = [];

    let referralTotalEarned = 0;
    let referralTotalClaimed = 0;
    let referralTotalClaimable = 0;

    for (const [wallet, earned] of referrerEarnings) {
      const claimed = referrerClaims.get(wallet) || 0;
      const claimable = Math.max(0, earned - claimed);
      const earningsCount = referralEarnings.filter((re: { referrer_wallet: string }) => re.referrer_wallet === wallet).length;

      referralTotalEarned += earned;
      referralTotalClaimed += claimed;
      referralTotalClaimable += claimable;

      referralBreakdown.push({
        wallet,
        total_earned: earned,
        total_claimed: claimed,
        claimable,
        earnings_count: earningsCount,
      });
    }

    // Sort by claimable descending
    referralBreakdown.sort((a, b) => b.claimable - a.claimable);

    return NextResponse.json({
      success: true,
      // LP Earnings
      totalEarned,
      totalClaimed,
      totalClaimable,
      riftCount: riftBreakdown.length,
      lpCount: earnings.length,
      riftBreakdown,
      earnings: enrichedEarnings,
      // Referral Earnings
      referrals: {
        totalEarned: referralTotalEarned,
        totalClaimed: referralTotalClaimed,
        totalClaimable: referralTotalClaimable,
        referrerCount: referralBreakdown.length,
        breakdown: referralBreakdown,
      },
      // Grand totals
      grandTotal: {
        earned: totalEarned + referralTotalEarned,
        claimed: totalClaimed + referralTotalClaimed,
        claimable: totalClaimable + referralTotalClaimable,
      },
    });
  } catch (error) {
    console.error('[LP-EARNINGS] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch earnings' },
      { status: 500 }
    );
  }
}
