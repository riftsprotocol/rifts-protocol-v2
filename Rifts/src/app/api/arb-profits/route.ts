import { NextRequest, NextResponse } from 'next/server';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://nitmreqtsnzjylyzwsri.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Admin wallet that can manage configs and distribute profits
const ADMIN_WALLET = '9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4';

// Treasury wallet for profit distribution
const TREASURY_WALLET = process.env.TREASURY_WALLET || '';
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY || '';

// Default LP split for fee rifts (40% to LPs, 60% to us)
const DEFAULT_LP_SPLIT = 40;

// VIP wallets - always get 10% bonus on their own earnings (from protocol's share)
const VIP_WALLETS = [
  'H1v8BRhuATZv9ELpYMuaZut5c3UtCKxxgKpFLbVnErWp', // Boosted wallet
];

// Check if wallet is VIP (gets 10% bonus on own earnings)
function isVipWallet(wallet: string): boolean {
  return VIP_WALLETS.includes(wallet);
}

// Dynamic imports for Solana
const getSolana = async () => {
  const { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
  const bs58 = (await import('bs58')).default;
  const { getServerConnection } = await import('@/lib/solana/server-connection');
  return { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, bs58, getServerConnection };
};

// Helper to get Supabase headers (use service key for writes, anon for reads)
const getHeaders = (forWrite = false) => {
  const key = forWrite && SUPABASE_SERVICE_KEY ? SUPABASE_SERVICE_KEY : SUPABASE_ANON_KEY;
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
};

// Record treasury payment for audit trail
async function recordTreasuryPayment(params: {
  paymentType: string;
  amountSol: number;
  recipientWallet: string;
  riftId?: string;
  sourceDescription?: string;
  signature?: string;
}) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/treasury_payments`, {
      method: 'POST',
      headers: getHeaders(true),
      body: JSON.stringify({
        payment_type: params.paymentType,
        amount_sol: params.amountSol,
        recipient_wallet: params.recipientWallet,
        rift_id: params.riftId || null,
        source_description: params.sourceDescription || null,
        signature: params.signature || null,
        status: 'confirmed',
      }),
    });
    console.log(`[TREASURY] Recorded ${params.paymentType}: ${params.amountSol.toFixed(6)} SOL to ${params.recipientWallet.slice(0, 8)}...`);
  } catch (err) {
    console.error('[TREASURY] Failed to record payment:', err);
  }
}

// Fetch all rows with pagination (Supabase limits to 1000 per request)
async function supabaseFetchAllTrades(endpoint: string): Promise<any[]> {
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

interface RiftConfig {
  rift_id: string;
  is_team_rift: boolean;
  lp_split: number;
  fees_enabled: boolean;
  fees_enabled_at?: string;
  created_at: string;
  updated_at: string;
}

interface TeamWallet {
  rift_id: string;
  wallet_address: string;
  private_key: string;
  created_at: string;
}

interface LpPosition {
  rift_id: string;
  wallet_address: string;
  liquidity_amount: number;
  share_pct: number;
}

interface LpProfit {
  rift_id: string;
  wallet_address: string;
  total_profit_sol: number;
  claimed_sol: number;
}

// Get or create config for a rift (default: fee rift with 40% LP split)
async function getOrCreateRiftConfig(riftId: string): Promise<RiftConfig> {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/arb_rift_config?rift_id=eq.${riftId}&select=*`,
    { headers: getHeaders(), cache: 'no-store' }
  );

  if (response.ok) {
    const data = await response.json();
    if (data.length > 0) return data[0];
  }

  // Create default config with fees_enabled_at = NOW to prevent historical earnings exploit
  const createResponse = await fetch(`${SUPABASE_URL}/rest/v1/arb_rift_config`, {
    method: 'POST',
    headers: { ...getHeaders(true), 'Prefer': 'return=representation' },
    body: JSON.stringify({
      rift_id: riftId,
      is_team_rift: false,
      lp_split: DEFAULT_LP_SPLIT,
      fees_enabled: true,
      fees_enabled_at: new Date().toISOString(),
    }),
  });

  if (!createResponse.ok) {
    // Return default if creation fails
    return {
      rift_id: riftId,
      is_team_rift: false,
      lp_split: DEFAULT_LP_SPLIT,
      fees_enabled: true,
      fees_enabled_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  const created = await createResponse.json();
  return created[0];
}

// Get or create team wallet for a rift
async function getOrCreateTeamWallet(riftId: string): Promise<TeamWallet> {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/arb_team_wallets?rift_id=eq.${riftId}&select=*`,
    { headers: getHeaders(), cache: 'no-store' }
  );

  if (response.ok) {
    const data = await response.json();
    if (data.length > 0) return data[0];
  }

  // Create new wallet
  const { Keypair, bs58 } = await getSolana();
  const newWallet = Keypair.generate();
  const walletAddress = newWallet.publicKey.toBase58();
  const privateKey = bs58.encode(newWallet.secretKey);

  const createResponse = await fetch(`${SUPABASE_URL}/rest/v1/arb_team_wallets`, {
    method: 'POST',
    headers: { ...getHeaders(true), 'Prefer': 'return=representation' },
    body: JSON.stringify({
      rift_id: riftId,
      wallet_address: walletAddress,
      private_key: privateKey,
    }),
  });

  if (!createResponse.ok) throw new Error('Failed to create team wallet');
  const created = await createResponse.json();
  return created[0];
}

interface LpWallet {
  rift_id: string;
  lp_address: string;
  wallet_address: string;
  private_key: string;
}

// Get or create LP wallet for a specific LP on a rift
async function getOrCreateLpWallet(riftId: string, lpAddress: string): Promise<LpWallet> {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/arb_lp_wallets?rift_id=eq.${riftId}&lp_address=eq.${lpAddress}&select=*`,
    { headers: getHeaders(), cache: 'no-store' }
  );

  if (response.ok) {
    const data = await response.json();
    if (data.length > 0) return data[0];
  }

  // Create new wallet for this LP
  const { Keypair, bs58 } = await getSolana();
  const newWallet = Keypair.generate();
  const walletAddress = newWallet.publicKey.toBase58();
  const privateKey = bs58.encode(newWallet.secretKey);

  const createResponse = await fetch(`${SUPABASE_URL}/rest/v1/arb_lp_wallets`, {
    method: 'POST',
    headers: { ...getHeaders(true), 'Prefer': 'return=representation' },
    body: JSON.stringify({
      rift_id: riftId,
      lp_address: lpAddress,
      wallet_address: walletAddress,
      private_key: privateKey,
    }),
  });

  if (!createResponse.ok) throw new Error('Failed to create LP wallet');
  const created = await createResponse.json();
  return created[0];
}

// Get rift creator from rifts table
async function getRiftCreator(riftId: string): Promise<string | null> {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/rifts?id=eq.${riftId}&select=raw_data`,
    { headers: getHeaders(), cache: 'no-store' }
  );

  if (!response.ok) return null;
  const data = await response.json();
  if (data.length === 0) return null;
  return data[0].raw_data?.creator || null;
}

// GET - Get profit info (admin view, LP claim view, or team claim view)
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const wallet = searchParams.get('wallet');
    const action = searchParams.get('action'); // 'claim-info' for LP/team claim view, 'admin' for admin view

    if (!wallet) {
      return NextResponse.json({ error: 'Wallet required' }, { status: 400 });
    }

    const { PublicKey, LAMPORTS_PER_SOL, getServerConnection } = await getSolana();
    const connection = await getServerConnection();

    // Get all rifts info (including token_mint and pool address for portfolio display)
    const riftsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/rifts?select=id,token_symbol,token_mint,raw_data`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const rifts = riftsResponse.ok ? await riftsResponse.json() : [];
    const riftMap = new Map<string, { symbol: string; underlying: string; creator: string | null; tokenMint: string | null; poolAddress: string | null; poolType: string | null }>(
      rifts.map((r: { id: string; token_symbol: string; token_mint?: string; raw_data?: { underlying?: string; creator?: string; liquidityPool?: string; meteoraPool?: string; meteoraPools?: string[]; prefixType?: number; poolType?: string } }) => {
        // Get pool address from raw_data - check multiple fields
        let poolAddress = r.raw_data?.liquidityPool || r.raw_data?.meteoraPool || null;
        if (!poolAddress && r.raw_data?.meteoraPools && r.raw_data.meteoraPools.length > 0) {
          poolAddress = r.raw_data.meteoraPools[0];
        }
        // Determine pool type from prefix type
        const isMonorift = r.raw_data?.prefixType === 1;
        const poolType = isMonorift
          ? (r.raw_data?.poolType === 'dlmm' ? 'dlmm' : 'dammv2-ss')
          : 'dammv2';

        return [
          r.id,
          {
            symbol: r.token_symbol,
            underlying: r.raw_data?.underlying || 'Unknown',
            creator: r.raw_data?.creator || null,
            tokenMint: r.token_mint || null,
            poolAddress,
            poolType
          }
        ];
      })
    );

    // Get all rift configs (new system)
    const configsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/arb_rift_config?select=*`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const configs: RiftConfig[] = configsResponse.ok ? await configsResponse.json() : [];
    const configMap = new Map(configs.map(c => [c.rift_id, c]));

    // Get legacy team rifts (old system) and merge into configMap
    const legacyTeamRiftsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/arb_team_rifts?select=rift_id,team_split`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const legacyTeamRifts = legacyTeamRiftsResponse.ok ? await legacyTeamRiftsResponse.json() : [];
    for (const legacy of legacyTeamRifts) {
      // Only add if not already in new config system
      if (!configMap.has(legacy.rift_id)) {
        configMap.set(legacy.rift_id, {
          rift_id: legacy.rift_id,
          is_team_rift: true, // Legacy rifts were all team rifts
          lp_split: legacy.team_split || 80, // Legacy used team_split
          fees_enabled: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
    }

    // Get bot profits by aggregating from arb_bot_trades table (primary source of truth)
    // This contains actual trade results with actual_profit_sol
    // Uses pagination since Supabase limits to 1000 rows per request
    const trades = await supabaseFetchAllTrades('arb_bot_trades?select=rift_id,actual_profit_sol,success');
    const profitMap = new Map<string, number>();
    for (const trade of trades) {
      if (trade.success && trade.actual_profit_sol) {
        const current = profitMap.get(trade.rift_id) || 0;
        profitMap.set(trade.rift_id, current + (parseFloat(trade.actual_profit_sol) || 0));
      }
    }

    // Get team wallets
    const walletsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/arb_team_wallets?select=rift_id,wallet_address,private_key`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const wallets: TeamWallet[] = walletsResponse.ok ? await walletsResponse.json() : [];
    const walletMap = new Map<string, TeamWallet>(
      wallets.map((w) => [w.rift_id, w])
    );

    // Get team payments (already paid to team wallets)
    const paymentsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/arb_team_payments?select=rift_id,amount_sol`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const payments = paymentsResponse.ok ? await paymentsResponse.json() : [];
    const paidMap = new Map<string, number>();
    for (const p of payments) {
      const current = paidMap.get(p.rift_id) || 0;
      paidMap.set(p.rift_id, current + (parseFloat(p.amount_sol) || 0));
    }

    // Get LP payments (already paid to LP wallets)
    const lpPaymentsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/arb_lp_profits?select=rift_id,total_profit_sol`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const lpPayments = lpPaymentsResponse.ok ? await lpPaymentsResponse.json() : [];
    // Aggregate LP payments by rift_id and add to paidMap
    for (const lp of lpPayments) {
      const current = paidMap.get(lp.rift_id) || 0;
      paidMap.set(lp.rift_id, current + (parseFloat(lp.total_profit_sol) || 0));
    }

    // LP Claim Info - show rifts where user is an LP
    if (action === 'claim-info') {
      // Get LP wallets for this user (dedicated claim wallets)
      const lpWalletsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_lp_wallets?lp_address=eq.${wallet}&select=*`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const lpWallets: LpWallet[] = lpWalletsResponse.ok ? await lpWalletsResponse.json() : [];

      // Get LP positions for this wallet (for share % info)
      const lpPositionsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_lp_positions?wallet_address=eq.${wallet}&select=*`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const lpPositions: LpPosition[] = lpPositionsResponse.ok ? await lpPositionsResponse.json() : [];
      const lpPositionMap = new Map(lpPositions.map(p => [p.rift_id, p]));

      // Build claimable rifts for LPs (fee rifts only)
      // Now based on actual wallet balances, not DB records

      // OPTIMIZATION: Batch fetch all LP wallet balances at once
      const lpWalletsFiltered = lpWallets.filter(lp => {
        const config = configMap.get(lp.rift_id);
        return !config?.is_team_rift; // Only fee rifts
      });

      const lpWalletPubkeys = lpWalletsFiltered.map(lp => new PublicKey(lp.wallet_address));
      const lpWalletBalances = lpWalletPubkeys.length > 0
        ? await connection.getMultipleAccountsInfo(lpWalletPubkeys)
        : [];

      console.log(`[ARB-PROFITS] 🚀 Batch fetched ${lpWalletBalances.length} LP wallet balances`);

      const claimableRifts = [];
      for (let i = 0; i < lpWalletsFiltered.length; i++) {
        const lpWallet = lpWalletsFiltered[i];
        const config = configMap.get(lpWallet.rift_id);
        const riftInfo = riftMap.get(lpWallet.rift_id) || { symbol: 'Unknown', underlying: 'Unknown', creator: null, tokenMint: null, poolAddress: null, poolType: null };
        const position = lpPositionMap.get(lpWallet.rift_id);

        // Get balance from batched result
        const accountInfo = lpWalletBalances[i];
        const lpWalletBalance = accountInfo ? accountInfo.lamports / LAMPORTS_PER_SOL : 0;

        // Subtract rent reserve (0.001 SOL) to get claimable amount
        const claimable = Math.max(0, lpWalletBalance - 0.001);

        if (claimable > 0.0001) {
          claimableRifts.push({
            riftId: lpWallet.rift_id,
            symbol: riftInfo.symbol,
            underlying: riftInfo.underlying,
            tokenMint: riftInfo.tokenMint,
            poolAddress: riftInfo.poolAddress,
            poolType: riftInfo.poolType,
            lpSplit: config?.lp_split || DEFAULT_LP_SPLIT,
            sharePct: position?.share_pct || 0,
            liquidityAmount: position?.liquidity_amount || 0,
            lpWalletAddress: lpWallet.wallet_address,
            lpWalletBalance,
            claimableSol: claimable,
            isTeamRift: false,
          });
        }
      }

      // Also include LP positions even without claim wallets (for access control)
      // These are users who have provided liquidity but don't have claimable profits yet
      for (const [riftId, position] of lpPositionMap) {
        // Skip if already added from LP wallets
        if (claimableRifts.some(r => r.riftId === riftId)) continue;

        const config = configMap.get(riftId);
        if (config?.is_team_rift) continue; // Skip team rifts

        const riftInfo = riftMap.get(riftId) || { symbol: 'Unknown', underlying: 'Unknown', creator: null, tokenMint: null, poolAddress: null, poolType: null };

        // Include even with 0 claimable (for access control purposes)
        claimableRifts.push({
          riftId,
          symbol: riftInfo.symbol,
          underlying: riftInfo.underlying,
          tokenMint: riftInfo.tokenMint,
          poolAddress: riftInfo.poolAddress,
          poolType: riftInfo.poolType,
          lpSplit: config?.lp_split || DEFAULT_LP_SPLIT,
          sharePct: position.share_pct || 0,
          liquidityAmount: position.liquidity_amount || 0,
          lpWalletAddress: null, // No dedicated wallet yet
          lpWalletBalance: 0,
          claimableSol: 0,
          isTeamRift: false,
          hasLpPosition: true, // Flag to indicate they have LP but no profits yet
        });
      }

      // Also check for team rifts where this wallet is the creator
      // OPTIMIZATION: Batch fetch all team wallet balances at once
      const teamRifts: Array<{ riftId: string; config: any; riftInfo: any; teamWallet: any }> = [];
      for (const [riftId, config] of configMap) {
        if (!config.is_team_rift) continue;

        const riftInfo = riftMap.get(riftId);
        if (!riftInfo || riftInfo.creator !== wallet) continue;

        const teamWallet = walletMap.get(riftId);
        if (!teamWallet) continue;

        teamRifts.push({ riftId, config, riftInfo, teamWallet });
      }

      const teamWalletPubkeys = teamRifts.map(tr => new PublicKey(tr.teamWallet.wallet_address));
      const teamWalletBalances = teamWalletPubkeys.length > 0
        ? await connection.getMultipleAccountsInfo(teamWalletPubkeys)
        : [];

      console.log(`[ARB-PROFITS] 🚀 Batch fetched ${teamWalletBalances.length} team wallet balances`);

      for (let i = 0; i < teamRifts.length; i++) {
        const { riftId, config, riftInfo, teamWallet } = teamRifts[i];
        const accountInfo = teamWalletBalances[i];
        const teamWalletBalance = accountInfo ? accountInfo.lamports / LAMPORTS_PER_SOL : 0;
        const totalProfitSol = profitMap.get(riftId) || 0;

        if (teamWalletBalance > 0.001) {
          claimableRifts.push({
            riftId,
            symbol: riftInfo.symbol,
            underlying: riftInfo.underlying,
            tokenMint: riftInfo.tokenMint,
            poolAddress: riftInfo.poolAddress,
            poolType: riftInfo.poolType,
            lpSplit: config.lp_split,
            sharePct: 100, // Team creator gets 100% of team wallet
            totalProfitSol,
            claimedSol: 0,
            claimableSol: teamWalletBalance,
            teamWalletAddress: teamWallet.wallet_address,
            teamWalletBalance,
            isTeamRift: true,
          });
        }
      }

      return NextResponse.json({
        claimableRifts,
        totalClaimable: claimableRifts.reduce((sum, r) => sum + r.claimableSol, 0),
      });
    }

    // Admin view
    if (wallet !== ADMIN_WALLET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    // Get treasury balance
    let treasuryBalanceSol = 0;
    if (TREASURY_WALLET) {
      try {
        treasuryBalanceSol = await connection.getBalance(new PublicKey(TREASURY_WALLET)) / LAMPORTS_PER_SOL;
      } catch (err) {
        console.error('Failed to get treasury balance:', err);
      }
    }

    // Build rifts list with configs and profits
    const allRiftsWithConfig = [];
    for (const [riftId, riftInfo] of riftMap) {
      const config = configMap.get(riftId);
      const feesEnabled = config?.fees_enabled !== false; // Default to true
      const totalProfitSol = profitMap.get(riftId) || 0;
      const lpShare = config?.lp_split || DEFAULT_LP_SPLIT;
      // Only calculate owed amounts if fees are enabled
      const totalOwedSol = feesEnabled ? totalProfitSol * (lpShare / 100) : 0;
      const alreadyPaidSol = paidMap.get(riftId) || 0;
      const remainingOwedSol = Math.max(0, totalOwedSol - alreadyPaidSol);
      const teamWallet = walletMap.get(riftId);

      allRiftsWithConfig.push({
        riftId,
        symbol: riftInfo.symbol,
        underlying: riftInfo.underlying,
        creator: riftInfo.creator,
        isTeamRift: config?.is_team_rift || false,
        feesEnabled,
        lpSplit: lpShare,
        totalProfitSol,
        totalOwedSol, // Amount owed to LPs/Team (profit × lpSplit%) - 0 if fees disabled
        alreadyPaidSol,
        remainingOwedSol,
        walletAddress: teamWallet?.wallet_address || null,
      });
    }

    // Sort by profit (highest first)
    allRiftsWithConfig.sort((a, b) => b.totalProfitSol - a.totalProfitSol);

    // Calculate totals
    const totalProfitSol = allRiftsWithConfig.reduce((sum, r) => sum + r.totalProfitSol, 0);
    const totalOwedSol = allRiftsWithConfig.reduce((sum, r) => sum + r.remainingOwedSol, 0);
    const totalAlreadyPaidSol = allRiftsWithConfig.reduce((sum, r) => sum + r.alreadyPaidSol, 0);

    // Calculate breakdown: how much goes to LPs/Teams vs Protocol
    const totalToLpsTeams = allRiftsWithConfig.reduce((sum, r) => sum + r.totalOwedSol, 0);
    const totalToProtocol = totalProfitSol - totalToLpsTeams;

    return NextResponse.json({
      treasuryWallet: TREASURY_WALLET,
      treasuryBalance: treasuryBalanceSol,
      rifts: allRiftsWithConfig,
      totalProfitSol,
      totalOwedSol, // Remaining owed (after payments)
      totalAlreadyPaidSol,
      totalToLpsTeams, // Total that should go to LPs/Teams
      totalToProtocol, // Total that goes to protocol (us)
    });
  } catch (error) {
    console.error('ARB-PROFITS GET error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    );
  }
}

// PUT - Claim profits (LP or team creator)
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { wallet, riftId, destinationWallet } = body;

    if (!wallet || !riftId) {
      return NextResponse.json({ error: 'Wallet and riftId required' }, { status: 400 });
    }

    const targetWallet = destinationWallet || wallet;

    // Get rift config
    const config = await getOrCreateRiftConfig(riftId);

    const { PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, bs58, getServerConnection } = await getSolana();
    const connection = await getServerConnection();

    // Team rift claim - verify creator
    if (config.is_team_rift) {
      const creator = await getRiftCreator(riftId);
      if (!creator || creator !== wallet) {
        return NextResponse.json({ error: 'Only the rift creator can claim team profits' }, { status: 403 });
      }

      // Get team wallet
      const walletResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_team_wallets?rift_id=eq.${riftId}&select=*`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const walletData = walletResponse.ok ? await walletResponse.json() : [];
      if (walletData.length === 0) {
        return NextResponse.json({ error: 'No team wallet found' }, { status: 404 });
      }

      const teamWallet = walletData[0];
      const teamKeypair = Keypair.fromSecretKey(bs58.decode(teamWallet.private_key));

      // Get balance
      const balance = await connection.getBalance(teamKeypair.publicKey);
      const rentReserve = 0.001 * LAMPORTS_PER_SOL;
      const amountToSend = balance - rentReserve - 5000;

      if (amountToSend <= 0) {
        return NextResponse.json({
          error: `Insufficient balance. Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
        }, { status: 400 });
      }

      // Transfer
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: teamKeypair.publicKey,
          toPubkey: new PublicKey(targetWallet),
          lamports: amountToSend,
        })
      );

      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = teamKeypair.publicKey;
      transaction.sign(teamKeypair);

      const signature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(signature, 'confirmed');

      // Record the team payment for dashboard tracking
      const claimedSol = amountToSend / LAMPORTS_PER_SOL;
      await fetch(`${SUPABASE_URL}/rest/v1/arb_team_payments`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify({
          rift_id: riftId,
          amount_sol: claimedSol,
          signature,
        }),
      });

      // Record in unified treasury_payments audit log (team wallet -> user)
      await recordTreasuryPayment({
        paymentType: 'team_claim',
        amountSol: claimedSol,
        recipientWallet: targetWallet,
        riftId,
        sourceDescription: `Team/creator claim from rift team wallet`,
        signature,
      });

      return NextResponse.json({
        success: true,
        amountClaimed: claimedSol,
        signature,
        fromWallet: teamWallet.wallet_address,
        toWallet: targetWallet,
      });
    }

    // Fee rift claim - LP claims from their dedicated wallet
    // Get LP's dedicated wallet
    const lpWalletResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/arb_lp_wallets?rift_id=eq.${riftId}&lp_address=eq.${wallet}&select=*`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const lpWalletData = lpWalletResponse.ok ? await lpWalletResponse.json() : [];

    if (lpWalletData.length === 0) {
      return NextResponse.json({ error: 'No LP wallet found. Wait for distribution first.' }, { status: 404 });
    }

    const lpWallet = lpWalletData[0];
    const lpKeypair = Keypair.fromSecretKey(bs58.decode(lpWallet.private_key));

    // Get balance of LP's dedicated wallet
    const lpWalletBalance = await connection.getBalance(lpKeypair.publicKey);
    const rentReserve = 0.001 * LAMPORTS_PER_SOL;
    const amountToSend = lpWalletBalance - rentReserve - 5000;

    if (amountToSend <= 0) {
      return NextResponse.json({
        error: `Nothing to claim. Wallet balance: ${(lpWalletBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
      }, { status: 400 });
    }

    // Transfer from LP's dedicated wallet to their personal wallet
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: lpKeypair.publicKey,
        toPubkey: new PublicKey(targetWallet),
        lamports: amountToSend,
      })
    );

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = lpKeypair.publicKey;
    transaction.sign(lpKeypair);

    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(signature, 'confirmed');

    // Update claimed amount in arb_lp_profits
    const lpProfitResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/arb_lp_profits?rift_id=eq.${riftId}&wallet_address=eq.${wallet}&select=*`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const lpProfitData = lpProfitResponse.ok ? await lpProfitResponse.json() : [];

    if (lpProfitData.length > 0) {
      const lpProfit = lpProfitData[0];
      await fetch(
        `${SUPABASE_URL}/rest/v1/arb_lp_profits?rift_id=eq.${riftId}&wallet_address=eq.${wallet}`,
        {
          method: 'PATCH',
          headers: getHeaders(true),
          body: JSON.stringify({
            claimed_sol: parseFloat(lpProfit.claimed_sol || 0) + (amountToSend / LAMPORTS_PER_SOL),
            last_updated: new Date().toISOString(),
          }),
        }
      );
    }

    return NextResponse.json({
      success: true,
      amountClaimed: amountToSend / LAMPORTS_PER_SOL,
      signature,
      fromWallet: lpWallet.wallet_address,
      toWallet: targetWallet,
    });
  } catch (error) {
    console.error('ARB-PROFITS PUT error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to claim' },
      { status: 500 }
    );
  }
}

// POST - Admin actions (distribute profits, update config)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { wallet, action } = body;

    if (wallet !== ADMIN_WALLET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    // Reset all profit data (stats and payments)
    if (action === 'reset-profits') {
      // Delete all arb_bot_stats
      const statsDeleteResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_bot_stats?total_profit_sol=gte.0`,
        {
          method: 'DELETE',
          headers: getHeaders(true),
        }
      );

      // Delete all arb_team_payments
      const paymentsDeleteResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_team_payments?amount_sol=gte.0`,
        {
          method: 'DELETE',
          headers: getHeaders(true),
        }
      );

      // Delete all arb_lp_profits
      const lpProfitsDeleteResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_lp_profits?total_profit_sol=gte.0`,
        {
          method: 'DELETE',
          headers: getHeaders(true),
        }
      );

      return NextResponse.json({
        success: true,
        message: 'All profit data has been reset',
        deleted: {
          stats: statsDeleteResponse.ok,
          payments: paymentsDeleteResponse.ok,
          lpProfits: lpProfitsDeleteResponse.ok,
        },
      });
    }

    // Update rift config (toggle team/fee, change split, toggle fees_enabled)
    if (action === 'update-config') {
      const { riftId, isTeamRift, lpSplit, feesEnabled } = body;

      if (!riftId) {
        return NextResponse.json({ error: 'riftId required' }, { status: 400 });
      }

      // Ensure config exists
      await getOrCreateRiftConfig(riftId);

      // Update config
      const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof isTeamRift === 'boolean') updateData.is_team_rift = isTeamRift;
      if (typeof lpSplit === 'number') updateData.lp_split = Math.min(100, Math.max(0, lpSplit));
      if (typeof feesEnabled === 'boolean') updateData.fees_enabled = feesEnabled;

      const updateResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_rift_config?rift_id=eq.${riftId}`,
        {
          method: 'PATCH',
          headers: { ...getHeaders(true), 'Prefer': 'return=representation' },
          body: JSON.stringify(updateData),
        }
      );

      if (!updateResponse.ok) {
        return NextResponse.json({ error: 'Failed to update config' }, { status: 500 });
      }

      const updated = await updateResponse.json();
      return NextResponse.json({ success: true, config: updated[0] });
    }

    // Add/update LP position
    if (action === 'update-lp-position') {
      const { riftId, lpWallet, liquidityAmount, sharePct } = body;

      if (!riftId || !lpWallet) {
        return NextResponse.json({ error: 'riftId and lpWallet required' }, { status: 400 });
      }

      const upsertResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_lp_positions?on_conflict=rift_id,wallet_address`,
        {
          method: 'POST',
          headers: { ...getHeaders(true), 'Prefer': 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify({
            rift_id: riftId,
            wallet_address: lpWallet,
            liquidity_amount: liquidityAmount || 0,
            share_pct: sharePct || 0,
            last_updated: new Date().toISOString(),
          }),
        }
      );

      if (!upsertResponse.ok) {
        return NextResponse.json({ error: 'Failed to update LP position' }, { status: 500 });
      }

      const upserted = await upsertResponse.json();
      return NextResponse.json({ success: true, position: upserted[0] });
    }

    // NEW: Record earnings in unified earnings table (no wallet transfers)
    // Users claim via /api/claims endpoint from treasury
    if (action === 'record-earnings') {
      const { recipientType } = body; // recipientType: 'lp' | 'team' | 'all'

      // Get all rift configs
      const configsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_rift_config?select=*`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const configs: RiftConfig[] = configsResponse.ok ? await configsResponse.json() : [];
      const configMap = new Map(configs.map(c => [c.rift_id, c]));

      // Get legacy team rifts
      const legacyTeamRiftsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_team_rifts?select=rift_id,team_split`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const legacyTeamRifts = legacyTeamRiftsResponse.ok ? await legacyTeamRiftsResponse.json() : [];
      for (const legacy of legacyTeamRifts) {
        if (!configMap.has(legacy.rift_id)) {
          configMap.set(legacy.rift_id, {
            rift_id: legacy.rift_id,
            is_team_rift: true,
            lp_split: legacy.team_split || 80,
            fees_enabled: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      }

      // Get rift creators for team earnings
      const riftsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/rifts?select=id,raw_data`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const riftsData = riftsResponse.ok ? await riftsResponse.json() : [];
      const riftCreatorMap = new Map<string, string>(
        riftsData.map((r: any) => [r.id, r.raw_data?.creator || null])
      );

      // Get bot profits from arb_bot_trades
      const trades3 = await supabaseFetchAllTrades('arb_bot_trades?select=rift_id,actual_profit_sol,success,signature');
      const profitMap = new Map<string, { total: number; txs: string[] }>();
      for (const trade of trades3) {
        if (trade.success && trade.actual_profit_sol) {
          const current = profitMap.get(trade.rift_id) || { total: 0, txs: [] };
          current.total += parseFloat(trade.actual_profit_sol) || 0;
          if (trade.signature) current.txs.push(trade.signature);
          profitMap.set(trade.rift_id, current);
        }
      }

      // Get already recorded earnings (to avoid duplicates)
      const existingEarningsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/earnings?select=wallet,rift_id,amount_sol`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const existingEarnings = existingEarningsResponse.ok ? await existingEarningsResponse.json() : [];
      const recordedMap = new Map<string, number>();
      for (const e of existingEarnings) {
        const key = `${e.wallet}:${e.rift_id}`;
        recordedMap.set(key, (recordedMap.get(key) || 0) + parseFloat(e.amount_sol));
      }

      // Get LP positions for fee rifts
      const lpPositionsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_lp_positions?select=*`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const lpPositions: LpPosition[] = lpPositionsResponse.ok ? await lpPositionsResponse.json() : [];

      const earningsToRecord: { wallet: string; type: string; rift_id: string; amount_sol: number; source_description: string }[] = [];
      let totalNewEarnings = 0;

      for (const [riftId, config] of configMap) {
        if (!config.fees_enabled) continue;

        const profitData = profitMap.get(riftId);
        if (!profitData || profitData.total <= 0) continue;

        const profitSol = profitData.total;
        const riftOwedSol = profitSol * (config.lp_split / 100);

        if (config.is_team_rift) {
          // Team rift - creator gets earnings
          if (recipientType === 'lp') continue;

          const creator = riftCreatorMap.get(riftId);
          if (!creator) continue;

          const key = `${creator}:${riftId}`;
          const alreadyRecorded = recordedMap.get(key) || 0;
          const newAmount = Math.max(0, riftOwedSol - alreadyRecorded);

          if (newAmount > 0.000001) {
            earningsToRecord.push({
              wallet: creator,
              type: 'team',
              rift_id: riftId,
              amount_sol: newAmount,
              source_description: `Team earnings from rift arb profits (${config.lp_split}% of ${profitSol.toFixed(4)} SOL)`,
            });
            totalNewEarnings += newAmount;
          }
        } else {
          // Fee rift - LPs get earnings based on share
          if (recipientType === 'team') continue;

          const riftLpPositions = lpPositions.filter(lp => lp.rift_id === riftId);
          for (const lp of riftLpPositions) {
            const lpOwedSol = riftOwedSol * (lp.share_pct / 100);
            const key = `${lp.wallet_address}:${riftId}`;
            const alreadyRecorded = recordedMap.get(key) || 0;
            const newAmount = Math.max(0, lpOwedSol - alreadyRecorded);

            if (newAmount > 0.000001) {
              earningsToRecord.push({
                wallet: lp.wallet_address,
                type: 'lp',
                rift_id: riftId,
                amount_sol: newAmount,
                source_description: `LP earnings (${lp.share_pct}% share of ${config.lp_split}% split = ${lpOwedSol.toFixed(4)} SOL)`,
              });
              totalNewEarnings += newAmount;
            }
          }
        }
      }

      if (earningsToRecord.length === 0) {
        return NextResponse.json({
          success: true,
          message: 'No new earnings to record',
          recorded: 0,
          totalAmount: 0,
        });
      }

      // Insert all earnings
      const insertResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/earnings`,
        {
          method: 'POST',
          headers: { ...getHeaders(true), 'Prefer': 'return=representation' },
          body: JSON.stringify(earningsToRecord),
        }
      );

      if (!insertResponse.ok) {
        const errorText = await insertResponse.text();
        return NextResponse.json({ error: `Failed to record earnings: ${errorText}` }, { status: 500 });
      }

      const inserted = await insertResponse.json();

      // Also record referral earnings
      for (const earning of earningsToRecord) {
        await recordReferralEarnings(
          earning.rift_id,
          earning.wallet,
          earning.amount_sol,
          earning.type === 'team' ? 'rift_profit' : 'lp_profit'
        );
      }

      return NextResponse.json({
        success: true,
        message: `Recorded ${earningsToRecord.length} earnings totaling ${totalNewEarnings.toFixed(4)} SOL`,
        recorded: earningsToRecord.length,
        totalAmount: totalNewEarnings,
        earnings: inserted,
      });
    }

    // LEGACY: Distribute profits to team wallets and LP wallets (old system, for backwards compatibility)
    if (action === 'distribute') {
      const { totalAmount, recipientType } = body; // recipientType: 'lp' | 'team' | 'all'

      if (!totalAmount || totalAmount <= 0) {
        return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
      }

      if (!TREASURY_WALLET || !TREASURY_PRIVATE_KEY) {
        return NextResponse.json({ error: 'Treasury not configured' }, { status: 500 });
      }

      const { PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, bs58, getServerConnection } = await getSolana();
      const connection = await getServerConnection();

      const treasuryKeypair = Keypair.fromSecretKey(bs58.decode(TREASURY_PRIVATE_KEY));

      // Get treasury balance ONCE (not in loop)
      let treasuryBalance = await connection.getBalance(treasuryKeypair.publicKey);

      if (treasuryBalance < totalAmount * LAMPORTS_PER_SOL) {
        return NextResponse.json({
          error: `Insufficient treasury balance. Have: ${(treasuryBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
        }, { status: 400 });
      }

      // Get all rift configs
      const configsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_rift_config?select=*`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const configs: RiftConfig[] = configsResponse.ok ? await configsResponse.json() : [];
      const configMap = new Map(configs.map(c => [c.rift_id, c]));

      // Get legacy team rifts
      const legacyTeamRiftsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_team_rifts?select=rift_id,team_split`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const legacyTeamRifts = legacyTeamRiftsResponse.ok ? await legacyTeamRiftsResponse.json() : [];
      for (const legacy of legacyTeamRifts) {
        if (!configMap.has(legacy.rift_id)) {
          configMap.set(legacy.rift_id, {
            rift_id: legacy.rift_id,
            is_team_rift: true,
            lp_split: legacy.team_split || 80,
            fees_enabled: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      }

      // Get bot profits by aggregating from arb_bot_trades table (primary source of truth)
      // Uses pagination since Supabase limits to 1000 rows per request
      const trades2 = await supabaseFetchAllTrades('arb_bot_trades?select=rift_id,actual_profit_sol,success');
      const profitMap = new Map<string, number>();
      for (const trade of trades2) {
        if (trade.success && trade.actual_profit_sol) {
          const current = profitMap.get(trade.rift_id) || 0;
          profitMap.set(trade.rift_id, current + (parseFloat(trade.actual_profit_sol) || 0));
        }
      }

      // Get already paid amounts (for team rifts)
      const paymentsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_team_payments?select=rift_id,amount_sol`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const payments = paymentsResponse.ok ? await paymentsResponse.json() : [];
      const paidMap = new Map<string, number>();
      for (const p of payments) {
        const current = paidMap.get(p.rift_id) || 0;
        paidMap.set(p.rift_id, current + (parseFloat(p.amount_sol) || 0));
      }

      // Get LP positions for fee rifts
      const lpPositionsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_lp_positions?select=*`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const lpPositions: LpPosition[] = lpPositionsResponse.ok ? await lpPositionsResponse.json() : [];

      // Get already paid to LPs
      const lpPaymentsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_lp_profits?select=rift_id,wallet_address,total_profit_sol,claimed_sol`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const lpPayments = lpPaymentsResponse.ok ? await lpPaymentsResponse.json() : [];
      const lpPaidMap = new Map<string, number>();
      for (const p of lpPayments) {
        const key = `${p.rift_id}:${p.wallet_address}`;
        lpPaidMap.set(key, parseFloat(p.total_profit_sol) || 0);
      }

      // Build distribution list
      interface DistributionTarget {
        rift_id: string;
        type: 'team' | 'lp';
        recipient: string; // LP address for LPs, or 'creator' for teams
        owedSol: number;
        lpSplit: number;
      }
      const distributionTargets: DistributionTarget[] = [];
      let totalOwed = 0;

      for (const [riftId, config] of configMap) {
        if (!config.fees_enabled) continue;

        const profitSol = profitMap.get(riftId) || 0;
        if (profitSol <= 0) continue;

        const riftOwedSol = profitSol * (config.lp_split / 100);

        if (config.is_team_rift) {
          // Team rift - single recipient (creator)
          // Skip if recipientType is 'lp' (only distributing to LPs)
          if (recipientType === 'lp') continue;

          const alreadyPaidSol = paidMap.get(riftId) || 0;
          const remainingOwedSol = Math.max(0, riftOwedSol - alreadyPaidSol);
          if (remainingOwedSol > 0.0001) {
            distributionTargets.push({
              rift_id: riftId,
              type: 'team',
              recipient: 'creator',
              owedSol: remainingOwedSol,
              lpSplit: config.lp_split,
            });
            totalOwed += remainingOwedSol;
          }
        } else {
          // Fee rift - distribute to LPs based on their share
          // Skip if recipientType is 'team' (only distributing to teams)
          if (recipientType === 'team') continue;

          const riftLpPositions = lpPositions.filter(lp => lp.rift_id === riftId);
          for (const lp of riftLpPositions) {
            const lpOwedSol = riftOwedSol * (lp.share_pct / 100);
            const lpKey = `${riftId}:${lp.wallet_address}`;
            const alreadyPaidSol = lpPaidMap.get(lpKey) || 0;
            const remainingOwedSol = Math.max(0, lpOwedSol - alreadyPaidSol);
            if (remainingOwedSol > 0.0001) {
              distributionTargets.push({
                rift_id: riftId,
                type: 'lp',
                recipient: lp.wallet_address,
                owedSol: remainingOwedSol,
                lpSplit: config.lp_split,
              });
              totalOwed += remainingOwedSol;
            }
          }
        }
      }

      if (distributionTargets.length === 0) {
        return NextResponse.json({ error: 'No rifts with remaining owed amounts' }, { status: 400 });
      }

      const RENT_EXEMPT_MINIMUM = 890880;
      const TX_FEE_BUFFER = 10000;
      const distributions: { riftId: string; type: string; recipient: string; walletAddress: string; amount: number; signature?: string; error?: string }[] = [];

      // OPTIMIZATION 1: Get or create all wallets first
      const walletsToFetch: { target: typeof distributionTargets[0]; wallet: { wallet_address: string; private_key: string } }[] = [];
      for (const target of distributionTargets) {
        try {
          const share = totalOwed > 0
            ? (target.owedSol / totalOwed) * totalAmount
            : totalAmount / distributionTargets.length;
          const lamportsToSend = Math.floor(share * LAMPORTS_PER_SOL);

          if (lamportsToSend < 1000) {
            distributions.push({
              riftId: target.rift_id,
              type: target.type,
              recipient: target.recipient,
              walletAddress: 'skipped',
              amount: share,
              error: 'Amount too small',
            });
            continue;
          }

          const destWallet = target.type === 'team'
            ? await getOrCreateTeamWallet(target.rift_id)
            : await getOrCreateLpWallet(target.rift_id, target.recipient);

          walletsToFetch.push({ target, wallet: destWallet });
        } catch (err) {
          distributions.push({
            riftId: target.rift_id,
            type: target.type,
            recipient: target.recipient,
            walletAddress: 'error',
            amount: 0,
            error: err instanceof Error ? err.message : 'Failed to get wallet',
          });
        }
      }

      // OPTIMIZATION 2: Batch fetch all destination balances
      const destPubkeys = walletsToFetch.map(w => new PublicKey(w.wallet.wallet_address));
      const destAccountsInfo = destPubkeys.length > 0
        ? await connection.getMultipleAccountsInfo(destPubkeys)
        : [];
      const destBalances = new Map<string, number>();
      destAccountsInfo.forEach((accountInfo: any, i: number) => {
        destBalances.set(destPubkeys[i].toBase58(), accountInfo?.lamports || 0);
      });

      // OPTIMIZATION 3: Get blockhash ONCE (not per transaction)
      const { blockhash } = await connection.getLatestBlockhash();

      // Process distributions
      for (let i = 0; i < walletsToFetch.length; i++) {
        const { target, wallet: destWallet } = walletsToFetch[i];
        const destWalletAddress = destWallet.wallet_address;

        try {
          let share = totalOwed > 0
            ? (target.owedSol / totalOwed) * totalAmount
            : totalAmount / distributionTargets.length;

          // VIP wallets get 10% bonus on their own earnings (from protocol's share)
          const recipientWallet = target.type === 'lp' ? target.recipient : null;
          const isVip = recipientWallet && isVipWallet(recipientWallet);
          let vipBonus = 0;
          if (isVip) {
            vipBonus = share * 0.10; // 10% bonus
            share += vipBonus;
            console.log(`[VIP-BONUS] Adding 10% bonus for VIP wallet ${recipientWallet?.slice(0, 8)}...: +${vipBonus.toFixed(6)} SOL`);
          }

          let lamportsToSend = Math.floor(share * LAMPORTS_PER_SOL);

          const destPubkey = new PublicKey(destWalletAddress);
          const destBalance = destBalances.get(destWalletAddress) || 0;

          if (destBalance === 0) {
            lamportsToSend += RENT_EXEMPT_MINIMUM;
          }

          // Check treasury balance (tracked locally, not re-fetched)
          if (treasuryBalance < lamportsToSend + TX_FEE_BUFFER) {
            distributions.push({
              riftId: target.rift_id,
              type: target.type,
              recipient: target.recipient,
              walletAddress: destWallet.wallet_address,
              amount: share,
              error: 'Insufficient treasury balance',
            });
            continue;
          }

          const transaction = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: treasuryKeypair.publicKey,
              toPubkey: destPubkey,
              lamports: lamportsToSend,
            })
          );

          transaction.recentBlockhash = blockhash;
          transaction.feePayer = treasuryKeypair.publicKey;
          transaction.sign(treasuryKeypair);

          const signature = await connection.sendRawTransaction(transaction.serialize());
          await connection.confirmTransaction(signature, 'confirmed');

          // Track treasury balance locally (avoid re-fetching)
          treasuryBalance -= lamportsToSend + TX_FEE_BUFFER;

          // Record payment
          if (target.type === 'team') {
            await fetch(`${SUPABASE_URL}/rest/v1/arb_team_payments`, {
              method: 'POST',
              headers: getHeaders(true),
              body: JSON.stringify({
                rift_id: target.rift_id,
                amount_sol: share,
                signature,
              }),
            });
            // Track referral earnings for rifts created by referred users
            await recordReferralEarnings(target.rift_id, target.recipient, share, 'rift_profit');

            // Record in unified treasury_payments audit log
            await recordTreasuryPayment({
              paymentType: 'team_distribution',
              amountSol: share,
              recipientWallet: destWallet.wallet_address,
              riftId: target.rift_id,
              sourceDescription: `Admin distribution to team wallet (${target.lpSplit}% split)`,
              signature,
            });
          } else {
            // Update or create LP profit record
            await fetch(
              `${SUPABASE_URL}/rest/v1/arb_lp_profits?on_conflict=rift_id,wallet_address`,
              {
                method: 'POST',
                headers: { ...getHeaders(true), 'Prefer': 'resolution=merge-duplicates' },
                body: JSON.stringify({
                  rift_id: target.rift_id,
                  wallet_address: target.recipient,
                  total_profit_sol: (lpPaidMap.get(`${target.rift_id}:${target.recipient}`) || 0) + share,
                  last_updated: new Date().toISOString(),
                }),
              }
            );
            // Track referral earnings for LPs who were referred
            await recordReferralEarnings(target.rift_id, target.recipient, share, 'lp_profit');

            // Record in unified treasury_payments audit log
            await recordTreasuryPayment({
              paymentType: 'lp_distribution',
              amountSol: share,
              recipientWallet: destWallet.wallet_address,
              riftId: target.rift_id,
              sourceDescription: `Admin distribution to LP wallet for ${target.recipient.slice(0, 8)}...`,
              signature,
            });
          }

          distributions.push({
            riftId: target.rift_id,
            type: target.type,
            recipient: target.recipient,
            walletAddress: destWallet.wallet_address,
            amount: share,
            signature,
          });
        } catch (err) {
          distributions.push({
            riftId: target.rift_id,
            type: target.type,
            recipient: target.recipient,
            walletAddress: destWalletAddress,
            amount: target.owedSol,
            error: err instanceof Error ? err.message : 'Transfer failed',
          });
        }
      }

      const successful = distributions.filter(d => d.signature);
      const failed = distributions.filter(d => d.error);

      return NextResponse.json({
        success: true,
        totalDistributed: successful.reduce((sum, d) => sum + d.amount, 0),
        distributions,
        summary: {
          total: distributions.length,
          successful: successful.length,
          failed: failed.length,
          teamDistributions: distributions.filter(d => d.type === 'team').length,
          lpDistributions: distributions.filter(d => d.type === 'lp').length,
        },
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('ARB-PROFITS POST error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    );
  }
}

// ============ REFERRAL EARNINGS TRACKING ============

// Tiered referral rates based on number of successful referrals
// 0-4 referrals: 5%, 5-9 referrals: 8%, 10+ referrals: 10%
// VIP wallets always get 10% (VIP_WALLETS defined at top of file)
async function getReferralPercentage(referrerWallet: string): Promise<number> {
  try {
    // VIP wallets always get max rate
    if (isVipWallet(referrerWallet)) {
      return 10;
    }

    // Count unique referred wallets for this referrer
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/referrals?referrer_wallet=eq.${referrerWallet}&select=referred_wallet`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const referrals = response.ok ? await response.json() : [];
    const referralCount = referrals.length;

    if (referralCount >= 10) return 10;
    if (referralCount >= 5) return 8;
    return 5;
  } catch {
    return 5; // Default to base rate on error
  }
}

/**
 * Record referral earnings when profits are distributed.
 * Tiered rates: 5% (0-4 refs), 8% (5-9 refs), 10% (10+ refs)
 */
async function recordReferralEarnings(
  riftId: string,
  recipientWallet: string,
  profitAmount: number,
  type: 'rift_profit' | 'lp_profit'
): Promise<void> {
  try {
    let referrerWallet: string | null = null;

    if (type === 'rift_profit') {
      // Check if this rift was created by a referred user
      const referredRiftResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/referred_rifts?rift_id=eq.${riftId}&select=referrer_wallet`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const referredRifts = referredRiftResponse.ok ? await referredRiftResponse.json() : [];
      if (referredRifts.length > 0) {
        referrerWallet = referredRifts[0].referrer_wallet;
      }
    } else {
      // Check if the LP was referred
      const referralResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/referrals?referred_wallet=eq.${recipientWallet}&select=referrer_wallet`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const referrals = referralResponse.ok ? await referralResponse.json() : [];
      if (referrals.length > 0) {
        referrerWallet = referrals[0].referrer_wallet;
      }
    }

    if (!referrerWallet) {
      return; // No referrer, nothing to record
    }

    // Get tiered referral percentage based on referrer's total referrals
    const referralPercentage = await getReferralPercentage(referrerWallet);
    const referralAmount = profitAmount * (referralPercentage / 100);

    if (referralAmount < 0.000001) {
      return; // Too small to track
    }

    // Record the earning
    await fetch(
      `${SUPABASE_URL}/rest/v1/referral_earnings`,
      {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify({
          referrer_wallet: referrerWallet,
          source_type: type,
          source_id: riftId,
          amount_sol: referralAmount,
          referred_wallet: type === 'lp_profit' ? recipientWallet : null,
        }),
      }
    );

    console.log(`[REFERRAL] Recorded ${type} earning: ${referralAmount.toFixed(6)} SOL (${referralPercentage}%) for referrer ${referrerWallet.slice(0, 8)}...`);
  } catch (err) {
    console.error('[REFERRAL] Error recording earnings:', err);
  }
}
