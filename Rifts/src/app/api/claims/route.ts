import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY || '';
const HELIUS_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const getHeaders = (forWrite = false) => {
  const key = forWrite && SUPABASE_SERVICE_KEY ? SUPABASE_SERVICE_KEY : SUPABASE_ANON_KEY;
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
};

// Fetch all rows with pagination (Supabase limits to 1000 per request)
async function supabaseFetchAll(endpoint: string): Promise<any[]> {
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

interface ClaimableItem {
  type: 'lp' | 'team' | 'referral' | 'legacy_lp' | 'legacy_team';
  riftId?: string;
  symbol?: string;
  amount: number;
  source: 'treasury' | 'legacy_wallet';
  walletAddress?: string; // For legacy wallets
}

interface LegacyWallet {
  rift_id: string;
  wallet_address: string;
  private_key: string;
  owner_wallet?: string;
  share_pct?: number;
}

// GET - Get all claimable amounts for a wallet
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const wallet = searchParams.get('wallet');

    if (!wallet) {
      return NextResponse.json({ error: 'Wallet required' }, { status: 400 });
    }

    // SECURITY: Validate wallet address format to prevent PostgREST injection
    const { isValidWalletAddress } = await import('@/lib/middleware/api-auth');
    if (!isValidWalletAddress(wallet)) {
      return NextResponse.json({ error: 'Invalid wallet address format' }, { status: 400 });
    }

    // URL-encode the wallet to prevent injection attacks
    const encodedWallet = encodeURIComponent(wallet);

    const connection = new Connection(HELIUS_RPC, 'confirmed');
    const claimableItems: ClaimableItem[] = [];
    let totalClaimable = 0;

    // 1. Check NEW earnings system - LP earnings from lp_earnings table (synced by lp-earnings-sync)
    const lpEarningsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/lp_earnings?wallet_address=eq.${encodedWallet}&select=*`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const lpEarningsData = lpEarningsResponse.ok ? await lpEarningsResponse.json() : [];

    // Map of rift_id -> claimable amount for LP earnings
    const lpEarningsByRift = new Map<string, number>();
    let totalLpEarnings = 0;
    let totalLpClaimed = 0;
    for (const le of lpEarningsData) {
      const earned = parseFloat(le.total_earned_sol || '0');
      const claimed = parseFloat(le.claimed_sol || '0');
      const claimable = Math.max(0, earned - claimed);
      lpEarningsByRift.set(le.rift_id, claimable);
      totalLpEarnings += earned;
      totalLpClaimed += claimed;
    }
    const newSystemLpClaimable = Math.max(0, totalLpEarnings - totalLpClaimed);

    // Also check referral earnings
    const refEarningsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/referral_earnings?referrer_wallet=eq.${encodedWallet}&select=amount_sol`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const refEarnings = refEarningsResponse.ok ? await refEarningsResponse.json() : [];
    const refClaimsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/referral_claims?referrer_wallet=eq.${encodedWallet}&select=amount_sol`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const refClaims = refClaimsResponse.ok ? await refClaimsResponse.json() : [];
    const totalRefEarned = refEarnings.reduce((sum: number, e: any) => sum + parseFloat(e.amount_sol || '0'), 0);
    const totalRefClaimed = refClaims.reduce((sum: number, c: any) => sum + parseFloat(c.amount_sol || '0'), 0);
    const newSystemRefClaimable = Math.max(0, totalRefEarned - totalRefClaimed);

    const newSystemClaimable = newSystemLpClaimable + newSystemRefClaimable;

    if (newSystemLpClaimable > 0.001) {
      claimableItems.push({ type: 'lp', amount: newSystemLpClaimable, source: 'treasury' });
    }
    if (newSystemRefClaimable > 0.001) {
      claimableItems.push({ type: 'referral', amount: newSystemRefClaimable, source: 'treasury' });
    }
    totalClaimable += newSystemClaimable;

    // 2a. Check NEW LP positions (arb_lp_positions - the current system)
    const lpPositionsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/arb_lp_positions?wallet_address=eq.${encodedWallet}&select=*`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const arbLpPositions = lpPositionsResponse.ok ? await lpPositionsResponse.json() : [];

    // 2b. Check LEGACY LP wallets (backwards compatibility)
    const lpWalletsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/lp_wallets?owner_wallet=eq.${encodedWallet}&select=*`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const lpWallets: LegacyWallet[] = lpWalletsResponse.ok ? await lpWalletsResponse.json() : [];

    // Get rift info for symbols - collect IDs from both LP position systems
    const allLpRiftIds = [
      ...lpWallets.map(w => w.rift_id),
      ...arbLpPositions.map((p: any) => p.rift_id)
    ];
    const uniqueLpRiftIds = [...new Set(allLpRiftIds)];

    let riftMap = new Map<string, { symbol: string; underlying: string }>();
    if (uniqueLpRiftIds.length > 0) {
      const riftsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/rifts?id=in.(${uniqueLpRiftIds.join(',')})&select=id,raw_data`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const rifts = riftsResponse.ok ? await riftsResponse.json() : [];
      rifts.forEach((r: any) => {
        riftMap.set(r.id, {
          symbol: r.raw_data?.symbol || 'Unknown',
          underlying: r.raw_data?.underlying || 'Unknown'
        });
      });
    }

    // Batch fetch LP wallet balances
    if (lpWallets.length > 0) {
      const lpPubkeys = lpWallets.map(w => new PublicKey(w.wallet_address));
      const lpBalances = await connection.getMultipleAccountsInfo(lpPubkeys);

      for (let i = 0; i < lpWallets.length; i++) {
        const lpWallet = lpWallets[i];
        const accountInfo = lpBalances[i];
        const balance = accountInfo ? accountInfo.lamports / LAMPORTS_PER_SOL : 0;
        const claimable = Math.max(0, balance - 0.001); // Leave rent

        if (claimable > 0.001) {
          const riftInfo = riftMap.get(lpWallet.rift_id);
          claimableItems.push({
            type: 'legacy_lp',
            riftId: lpWallet.rift_id,
            symbol: riftInfo?.symbol,
            amount: claimable,
            source: 'legacy_wallet',
            walletAddress: lpWallet.wallet_address,
          });
          totalClaimable += claimable;
        }
      }
    }

    // 3. Check LEGACY team wallets (for rift creators)
    // First get rifts created by this wallet
    const createdRiftsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/rifts?select=id,raw_data`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const allRifts = createdRiftsResponse.ok ? await createdRiftsResponse.json() : [];
    const createdRiftIds = allRifts
      .filter((r: any) => r.raw_data?.creator === wallet)
      .map((r: any) => r.id);

    // Declare teamWallets at outer scope for portfolio data
    let teamWallets: LegacyWallet[] = [];

    if (createdRiftIds.length > 0) {
      // Check arb_config for team splits
      const configResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_config?rift_id=in.(${createdRiftIds.join(',')})&lp_split=gt.0&select=*`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const configs = configResponse.ok ? await configResponse.json() : [];

      // Get team wallets for these rifts
      const teamWalletsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/team_wallets?rift_id=in.(${createdRiftIds.join(',')})&select=*`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      teamWallets = teamWalletsResponse.ok ? await teamWalletsResponse.json() : [];

      if (teamWallets.length > 0) {
        const teamPubkeys = teamWallets.map(w => new PublicKey(w.wallet_address));
        const teamBalances = await connection.getMultipleAccountsInfo(teamPubkeys);

        for (let i = 0; i < teamWallets.length; i++) {
          const teamWallet = teamWallets[i];
          const accountInfo = teamBalances[i];
          const balance = accountInfo ? accountInfo.lamports / LAMPORTS_PER_SOL : 0;
          const claimable = Math.max(0, balance - 0.001);

          if (claimable > 0.001) {
            const rift = allRifts.find((r: any) => r.id === teamWallet.rift_id);
            claimableItems.push({
              type: 'legacy_team',
              riftId: teamWallet.rift_id,
              symbol: rift?.raw_data?.symbol,
              amount: claimable,
              source: 'legacy_wallet',
              walletAddress: teamWallet.wallet_address,
            });
            totalClaimable += claimable;
          }
        }
      }
    }

    // Note: Referral earnings are already checked in section 1 above (newSystemRefClaimable)

    // Fetch arb_bot_trades to get total profits per rift (with pagination)
    const trades = await supabaseFetchAll('arb_bot_trades?select=rift_id,actual_profit_sol,success');

    // Aggregate profits by rift (only successful trades)
    const profitsByRift = new Map<string, number>();
    for (const trade of trades) {
      if (trade.success) {
        const current = profitsByRift.get(trade.rift_id) || 0;
        profitsByRift.set(trade.rift_id, current + parseFloat(trade.actual_profit_sol || '0'));
      }
    }

    // Helper to get pool type - use stored poolType if available, otherwise infer from prefixType
    const getPoolType = (rawData: any): string | null => {
      if (!rawData?.liquidityPool) return null;
      // Use stored poolType if available (e.g., 'dlmm', 'dammv2')
      if (rawData?.poolType) return rawData.poolType;
      // Fallback: prefixType 1 = monorift = typically DLMM, otherwise DAMM
      return rawData?.prefixType === 1 ? 'dlmm' : 'damm';
    };

    // Helper to check if single-sided (monorift = prefixType 1)
    const isSingleSided = (rawData: any): boolean => {
      return rawData?.prefixType === 1;
    };

    // Helper to get Meteora pool link
    const getPoolLink = (rawData: any) => {
      const poolAddress = rawData?.liquidityPool || rawData?.meteoraPool;
      if (!poolAddress || poolAddress === '11111111111111111111111111111111') return null;
      const poolType = getPoolType(rawData);
      // Only DLMM and DAMMV2 pools exist
      return `https://app.meteora.ag/${poolType === 'dlmm' ? 'dlmm' : 'dammv2'}/${poolAddress}`;
    };

    // Build portfolio data - LP positions from BOTH systems
    // 1. New system: arb_lp_positions (direct LP holdings)
    const newLpPositions = arbLpPositions.map((lp: any) => {
      const rift = allRifts.find((r: any) => r.id === lp.rift_id);
      const rawData = rift?.raw_data;
      const poolAddress = rawData?.liquidityPool || rawData?.meteoraPool || null;
      return {
        riftId: lp.rift_id,
        symbol: rawData?.symbol || 'Unknown',
        underlying: rawData?.underlying || 'Unknown',
        riftMint: rawData?.riftMint || lp.rift_id,
        underlyingMint: rawData?.underlyingMint || null,
        tvl: rawData?.tvl || 0,
        sharePct: lp.share_pct || 0,
        lpWalletAddress: lp.wallet_address || wallet, // User's wallet for new system
        poolAddress: poolAddress && poolAddress !== '11111111111111111111111111111111' ? poolAddress : null,
        poolType: getPoolType(rawData),
        isSingleSided: isSingleSided(rawData),
        poolLink: getPoolLink(rawData),
        totalArbProfit: profitsByRift.get(lp.rift_id) || 0,
        claimable: lpEarningsByRift.get(lp.rift_id) || 0, // From lp_earnings table
        source: 'new' as const,
      };
    });

    // 2. Legacy system: lp_wallets (per-rift wallets)
    const legacyLpPositions = lpWallets.map(lp => {
      const rift = allRifts.find((r: any) => r.id === lp.rift_id);
      const rawData = rift?.raw_data;
      const poolAddress = rawData?.liquidityPool || rawData?.meteoraPool || null;
      return {
        riftId: lp.rift_id,
        symbol: rawData?.symbol || 'Unknown',
        underlying: rawData?.underlying || 'Unknown',
        riftMint: rawData?.riftMint || lp.rift_id,
        underlyingMint: rawData?.underlyingMint || null,
        tvl: rawData?.tvl || 0,
        sharePct: lp.share_pct || 0,
        lpWalletAddress: lp.wallet_address,
        poolAddress: poolAddress && poolAddress !== '11111111111111111111111111111111' ? poolAddress : null,
        poolType: getPoolType(rawData),
        isSingleSided: isSingleSided(rawData),
        poolLink: getPoolLink(rawData),
        totalArbProfit: profitsByRift.get(lp.rift_id) || 0,
        claimable: claimableItems.find(i => i.type === 'legacy_lp' && i.riftId === lp.rift_id)?.amount || 0,
        source: 'legacy' as const,
      };
    });

    // Merge and dedupe (prefer new system data if same rift appears in both)
    const seenRiftIds = new Set<string>();
    const lpPositions = [...newLpPositions, ...legacyLpPositions].filter(pos => {
      if (seenRiftIds.has(pos.riftId)) return false;
      seenRiftIds.add(pos.riftId);
      return true;
    });

    // Get rifts created by this wallet with full details
    const userRifts = allRifts
      .filter((r: any) => r.raw_data?.creator === wallet)
      .map((r: any) => {
        const rawData = r.raw_data;
        const teamWallet = teamWallets?.find((tw: LegacyWallet) => tw.rift_id === r.id);
        const teamClaimable = claimableItems.find(i => i.type === 'legacy_team' && i.riftId === r.id)?.amount || 0;
        const poolAddress = rawData?.liquidityPool || rawData?.meteoraPool || null;
        return {
          riftId: r.id,
          symbol: rawData?.symbol || 'Unknown',
          underlying: rawData?.underlying || 'Unknown',
          riftMint: rawData?.riftMint || r.id,
          underlyingMint: rawData?.underlyingMint || null,
          tvl: rawData?.tvl || 0,
          teamWalletAddress: teamWallet?.wallet_address || null,
          poolAddress: poolAddress && poolAddress !== '11111111111111111111111111111111' ? poolAddress : null,
          poolType: getPoolType(rawData),
          isSingleSided: isSingleSided(rawData),
          poolLink: getPoolLink(rawData),
          totalArbProfit: profitsByRift.get(r.id) || 0,
          teamClaimable,
        };
      });

    return NextResponse.json({
      success: true,
      wallet,
      totalClaimable,
      items: claimableItems,
      breakdown: {
        newSystem: newSystemClaimable,
        newSystemLp: newSystemLpClaimable,
        newSystemTeam: 0, // Team earnings handled via team rifts
        legacyLp: claimableItems.filter(i => i.type === 'legacy_lp').reduce((s, i) => s + i.amount, 0),
        legacyTeam: claimableItems.filter(i => i.type === 'legacy_team').reduce((s, i) => s + i.amount, 0),
        referral: newSystemRefClaimable,
      },
      portfolio: {
        lpPositions,
        createdRifts: userRifts,
      }
    });
  } catch (error) {
    console.error('[CLAIMS-API] GET error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch claims' },
      { status: 500 }
    );
  }
}

// Simple in-memory lock to prevent race conditions on same server
const claimLocks = new Map<string, number>();
const LOCK_TIMEOUT = 30000; // 30 seconds

function acquireLocalLock(wallet: string): boolean {
  const now = Date.now();
  const existingLock = claimLocks.get(wallet);
  if (existingLock && now - existingLock < LOCK_TIMEOUT) {
    return false;
  }
  claimLocks.set(wallet, now);
  return true;
}

function releaseLocalLock(wallet: string): void {
  claimLocks.delete(wallet);
}

// Database-level distributed lock using claim_locks table
async function acquireDbLock(wallet: string, supabaseUrl: string, headers: Record<string, string>): Promise<boolean> {
  // URL-encode the wallet for safe use in queries
  const encodedWallet = encodeURIComponent(wallet);

  try {
    // Try to insert a lock record - will fail if one exists
    const response = await fetch(`${supabaseUrl}/rest/v1/claim_locks`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        wallet,
        locked_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + LOCK_TIMEOUT).toISOString()
      }),
    });

    if (response.ok) {
      return true;
    }

    // If insert failed, check if existing lock is expired
    const existingResponse = await fetch(
      `${supabaseUrl}/rest/v1/claim_locks?wallet=eq.${encodedWallet}&select=*`,
      { headers, cache: 'no-store' }
    );

    if (existingResponse.ok) {
      const existing = await existingResponse.json();
      if (existing.length > 0) {
        const expiresAt = new Date(existing[0].expires_at);
        if (expiresAt < new Date()) {
          // Lock expired, delete and try again
          await fetch(`${supabaseUrl}/rest/v1/claim_locks?wallet=eq.${encodedWallet}`, {
            method: 'DELETE',
            headers,
          });
          // Retry insert
          const retryResponse = await fetch(`${supabaseUrl}/rest/v1/claim_locks`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              wallet,
              locked_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + LOCK_TIMEOUT).toISOString()
            }),
          });
          return retryResponse.ok;
        }
      }
    }

    return false;
  } catch {
    return false;
  }
}

async function releaseDbLock(wallet: string, supabaseUrl: string, headers: Record<string, string>): Promise<void> {
  // URL-encode the wallet for safe use in queries
  const encodedWallet = encodeURIComponent(wallet);

  try {
    await fetch(`${supabaseUrl}/rest/v1/claim_locks?wallet=eq.${encodedWallet}`, {
      method: 'DELETE',
      headers,
    });
  } catch {
    // Ignore errors on release
  }
}

// POST - Claim all available earnings
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { wallet } = body;

    if (!wallet) {
      return NextResponse.json({ error: 'Wallet required' }, { status: 400 });
    }

    // SECURITY: Validate wallet address format to prevent PostgREST injection
    const { isValidWalletAddress } = await import('@/lib/middleware/api-auth');
    if (!isValidWalletAddress(wallet)) {
      return NextResponse.json({ error: 'Invalid wallet address format' }, { status: 400 });
    }

    // URL-encode the wallet to prevent injection attacks
    const encodedWallet = encodeURIComponent(wallet);

    // Acquire local lock (same server)
    if (!acquireLocalLock(wallet)) {
      return NextResponse.json({
        error: 'Claim already in progress. Please wait and try again.'
      }, { status: 429 });
    }

    // Acquire distributed DB lock (multi-server)
    const dbLockAcquired = await acquireDbLock(wallet, SUPABASE_URL, getHeaders(true));
    if (!dbLockAcquired) {
      releaseLocalLock(wallet);
      return NextResponse.json({
        error: 'Claim already in progress on another server. Please wait and try again.'
      }, { status: 429 });
    }

    try {
      const connection = new Connection(HELIUS_RPC, 'confirmed');
      const recipientPubkey = new PublicKey(wallet);
      const results: { type: string; amount: number; signature?: string; error?: string }[] = [];
      let totalClaimed = 0;

      // 1. Claim LP earnings from lp_earnings table (synced by lp-earnings-sync)
    const lpEarningsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/lp_earnings?wallet_address=eq.${encodedWallet}&select=*`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const lpEarningsData = lpEarningsResponse.ok ? await lpEarningsResponse.json() : [];

    let totalLpEarned = 0;
    let totalLpClaimedBefore = 0;
    for (const le of lpEarningsData) {
      totalLpEarned += parseFloat(le.total_earned_sol || '0');
      totalLpClaimedBefore += parseFloat(le.claimed_sol || '0');
    }
    const newSystemClaimable = Math.max(0, totalLpEarned - totalLpClaimedBefore);

    // 2. Claim referral earnings (treasury)
    const refEarningsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/referral_earnings?referrer_wallet=eq.${encodedWallet}&select=amount_sol`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const refEarnings = refEarningsResponse.ok ? await refEarningsResponse.json() : [];

    const refClaimsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/referral_claims?referrer_wallet=eq.${encodedWallet}&select=amount_sol`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const refClaims = refClaimsResponse.ok ? await refClaimsResponse.json() : [];

    const totalRefEarned = refEarnings.reduce((sum: number, e: any) => sum + parseFloat(e.amount_sol || '0'), 0);
    const totalRefClaimed = refClaims.reduce((sum: number, c: any) => sum + parseFloat(c.amount_sol || '0'), 0);
    const refClaimable = Math.max(0, totalRefEarned - totalRefClaimed);

    // Combine treasury claims
    const treasuryClaimable = newSystemClaimable + refClaimable;

    if (treasuryClaimable > 0.001 && TREASURY_PRIVATE_KEY) {
      try {
        const treasuryKeypair = Keypair.fromSecretKey(bs58.decode(TREASURY_PRIVATE_KEY));
        const treasuryBalance = await connection.getBalance(treasuryKeypair.publicKey);
        const lamportsToSend = Math.floor(treasuryClaimable * LAMPORTS_PER_SOL);

        if (treasuryBalance >= lamportsToSend + 10000) {
          // SECURITY: Reserve claims BEFORE transfer to prevent double-claiming
          // If a second request comes in, they'll see claimed = earned and get 0
          const claimNonce = `pending_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          // Store original claimed values for rollback if transfer fails
          const originalClaimedValues: { id: string; claimed_sol: number }[] = [];

          // 1. PRE-RESERVE LP earnings by setting claimed_sol = total_earned_sol
          if (newSystemClaimable > 0 && lpEarningsData.length > 0) {
            for (const le of lpEarningsData) {
              originalClaimedValues.push({
                id: le.id,
                claimed_sol: parseFloat(le.claimed_sol) || 0
              });

              const reserveRes = await fetch(`${SUPABASE_URL}/rest/v1/lp_earnings?id=eq.${le.id}`, {
                method: 'PATCH',
                headers: getHeaders(true),
                body: JSON.stringify({
                  claimed_sol: le.total_earned_sol, // Mark as claimed (pre-reserve)
                  updated_at: new Date().toISOString()
                }),
              });

              if (!reserveRes.ok) {
                // Rollback any already-reserved LP earnings
                for (const orig of originalClaimedValues) {
                  await fetch(`${SUPABASE_URL}/rest/v1/lp_earnings?id=eq.${orig.id}`, {
                    method: 'PATCH',
                    headers: getHeaders(true),
                    body: JSON.stringify({ claimed_sol: orig.claimed_sol }),
                  });
                }
                throw new Error('Failed to reserve LP earnings claim');
              }
            }
          }

          // 2. PRE-RESERVE referral earnings
          let pendingRefClaimId: string | null = null;
          if (refClaimable > 0) {
            const insertRefResponse = await fetch(`${SUPABASE_URL}/rest/v1/referral_claims`, {
              method: 'POST',
              headers: { ...getHeaders(true), 'Prefer': 'return=representation' },
              body: JSON.stringify({
                referrer_wallet: wallet,
                amount_sol: refClaimable,
                signature: claimNonce
              }),
            });

            if (!insertRefResponse.ok) {
              // Rollback LP earnings reservation
              for (const orig of originalClaimedValues) {
                await fetch(`${SUPABASE_URL}/rest/v1/lp_earnings?id=eq.${orig.id}`, {
                  method: 'PATCH',
                  headers: getHeaders(true),
                  body: JSON.stringify({ claimed_sol: orig.claimed_sol }),
                });
              }
              throw new Error('Failed to reserve referral claim');
            }

            const insertedRefClaim = await insertRefResponse.json();
            pendingRefClaimId = insertedRefClaim[0]?.id;
          }

          // 3. NOW do the actual transfer (all claims are reserved)
          try {
            const tx = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: treasuryKeypair.publicKey,
                toPubkey: recipientPubkey,
                lamports: lamportsToSend,
              })
            );

            const { blockhash } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = treasuryKeypair.publicKey;

            const signature = await connection.sendTransaction(tx, [treasuryKeypair]);
            await connection.confirmTransaction(signature, 'confirmed');

            // Transfer succeeded - update referral claim with signature
            if (pendingRefClaimId) {
              await fetch(`${SUPABASE_URL}/rest/v1/referral_claims?id=eq.${pendingRefClaimId}`, {
                method: 'PATCH',
                headers: getHeaders(true),
                body: JSON.stringify({ signature }),
              });
            }

            results.push({ type: 'treasury', amount: treasuryClaimable, signature });
            totalClaimed += treasuryClaimable;
          } catch (transferErr) {
            // CRITICAL: Transfer failed - rollback ALL reservations
            console.error('[CLAIMS] Transfer failed, rolling back:', transferErr);

            // Rollback LP earnings
            for (const orig of originalClaimedValues) {
              await fetch(`${SUPABASE_URL}/rest/v1/lp_earnings?id=eq.${orig.id}`, {
                method: 'PATCH',
                headers: getHeaders(true),
                body: JSON.stringify({ claimed_sol: orig.claimed_sol }),
              });
            }

            // Rollback referral claim
            if (pendingRefClaimId) {
              await fetch(`${SUPABASE_URL}/rest/v1/referral_claims?id=eq.${pendingRefClaimId}`, {
                method: 'DELETE',
                headers: getHeaders(true),
              });
            }

            throw transferErr; // Re-throw to be caught by outer catch
          }
        } else {
          results.push({ type: 'treasury', amount: treasuryClaimable, error: 'Insufficient treasury balance' });
        }
      } catch (err) {
        results.push({ type: 'treasury', amount: treasuryClaimable, error: err instanceof Error ? err.message : 'Failed' });
      }
    }

    // 3. Claim from LEGACY LP wallets
    const lpWalletsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/lp_wallets?owner_wallet=eq.${encodedWallet}&select=*`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const lpWallets: LegacyWallet[] = lpWalletsResponse.ok ? await lpWalletsResponse.json() : [];

    for (const lpWallet of lpWallets) {
      try {
        const lpKeypair = Keypair.fromSecretKey(bs58.decode(lpWallet.private_key));
        const balance = await connection.getBalance(lpKeypair.publicKey);
        const claimable = Math.max(0, balance - 0.002 * LAMPORTS_PER_SOL); // Leave rent + buffer

        if (claimable > 1000) { // > 0.000001 SOL
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: lpKeypair.publicKey,
              toPubkey: recipientPubkey,
              lamports: claimable,
            })
          );

          const { blockhash } = await connection.getLatestBlockhash();
          tx.recentBlockhash = blockhash;
          tx.feePayer = lpKeypair.publicKey;

          const signature = await connection.sendTransaction(tx, [lpKeypair]);
          await connection.confirmTransaction(signature, 'confirmed');

          const amountSol = claimable / LAMPORTS_PER_SOL;
          results.push({ type: `legacy_lp_${lpWallet.rift_id.slice(0, 8)}`, amount: amountSol, signature });
          totalClaimed += amountSol;
        }
      } catch (err) {
        console.error(`[CLAIMS] Failed to claim from LP wallet ${lpWallet.rift_id}:`, err);
      }
    }

    // 4. Claim from LEGACY team wallets
    const createdRiftsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/rifts?select=id,raw_data`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const allRifts = createdRiftsResponse.ok ? await createdRiftsResponse.json() : [];
    const createdRiftIds = allRifts
      .filter((r: any) => r.raw_data?.creator === wallet)
      .map((r: any) => r.id);

    if (createdRiftIds.length > 0) {
      const teamWalletsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/team_wallets?rift_id=in.(${createdRiftIds.join(',')})&select=*`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const teamWallets: LegacyWallet[] = teamWalletsResponse.ok ? await teamWalletsResponse.json() : [];

      for (const teamWallet of teamWallets) {
        try {
          const teamKeypair = Keypair.fromSecretKey(bs58.decode(teamWallet.private_key));
          const balance = await connection.getBalance(teamKeypair.publicKey);
          const claimable = Math.max(0, balance - 0.002 * LAMPORTS_PER_SOL);

          if (claimable > 1000) {
            const tx = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: teamKeypair.publicKey,
                toPubkey: recipientPubkey,
                lamports: claimable,
              })
            );

            const { blockhash } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = teamKeypair.publicKey;

            const signature = await connection.sendTransaction(tx, [teamKeypair]);
            await connection.confirmTransaction(signature, 'confirmed');

            const amountSol = claimable / LAMPORTS_PER_SOL;
            results.push({ type: `legacy_team_${teamWallet.rift_id.slice(0, 8)}`, amount: amountSol, signature });
            totalClaimed += amountSol;
          }
        } catch (err) {
          console.error(`[CLAIMS] Failed to claim from team wallet ${teamWallet.rift_id}:`, err);
        }
      }
    }

      if (totalClaimed === 0) {
        return NextResponse.json({
          success: false,
          error: 'Nothing to claim',
          results,
        });
      }

      console.log(`[CLAIMS] ${wallet.slice(0, 8)}... claimed ${totalClaimed.toFixed(4)} SOL`);

      return NextResponse.json({
        success: true,
        totalClaimed,
        results,
      });
    } finally {
      // Always release both locks
      releaseLocalLock(wallet);
      await releaseDbLock(wallet, SUPABASE_URL, getHeaders(true));
    }
  } catch (error) {
    console.error('[CLAIMS-API] POST error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to process claims' },
      { status: 500 }
    );
  }
}
