import { NextRequest, NextResponse } from 'next/server';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://nitmreqtsnzjylyzwsri.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ADMIN_WALLET = '9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4';
// Cron secret for Vercel cron jobs
const CRON_SECRET = process.env.CRON_SECRET || '';

// Dynamic imports for Solana
const getSolana = async () => {
  const { PublicKey } = await import('@solana/web3.js');
  const { getServerConnection } = await import('@/lib/solana/server-connection');
  return { PublicKey, getServerConnection };
};

const getHeaders = () => ({
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
});

interface RiftInfo {
  id: string;
  token_symbol: string;
  created_at?: string;
  raw_data: {
    riftMint: string;
    meteoraPool?: string;
    meteoraPools?: string[];
    liquidityPool?: string;
    prefixType?: number; // 0 = mono (r prefix), 1 = mr prefix
    underlying?: string;
    createdAt?: string;
  };
}

interface LpPositionResult {
  riftId: string;
  wallet: string;
  liquidityAmount: number;
  sharePct: number;
  poolType: 'DLMM' | 'DAMMV2';
}

// Auto-create rift config if it doesn't exist
// IMPORTANT: For OLD rifts with existing trades, we set fees_enabled_at = NOW
// to prevent retroactive earnings. Only truly NEW rifts (no trades) get rift creation time.
async function ensureRiftConfig(riftId: string, riftCreatedAt?: string): Promise<void> {
  try {
    // Check if config exists
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/arb_rift_config?rift_id=eq.${riftId}&select=rift_id`,
      { headers: getHeaders(), cache: 'no-store' }
    );

    const existing = checkRes.ok ? await checkRes.json() : [];
    if (existing.length > 0) {
      return; // Config already exists
    }

    // Check if this rift has ANY existing trades (to detect old vs new rift)
    const tradesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/arb_bot_trades?rift_id=eq.${riftId}&select=id&limit=1`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const existingTrades = tradesRes.ok ? await tradesRes.json() : [];
    const hasExistingTrades = existingTrades.length > 0;

    // For OLD rifts with existing trades: fees_enabled_at = NOW (no retroactive earnings)
    // For NEW rifts with no trades: fees_enabled_at = rift creation time (earn from start)
    const feesEnabledAt = hasExistingTrades
      ? new Date().toISOString()
      : (riftCreatedAt || new Date().toISOString());

    console.log(`[LP-SYNC] Auto-creating config for rift ${riftId.slice(0, 8)}... ` +
      `hasExistingTrades=${hasExistingTrades}, fees_enabled_at=${feesEnabledAt}`);

    await fetch(`${SUPABASE_URL}/rest/v1/arb_rift_config`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        rift_id: riftId,
        is_team_rift: false,
        lp_split: 80,
        fees_enabled: true,
        fees_enabled_at: feesEnabledAt,
      }),
    });
  } catch (error) {
    console.error(`[LP-SYNC] Failed to create config for ${riftId}:`, error);
  }
}

// Check if LP position already exists (to preserve created_at for existing positions)
async function getLpPositionCreatedAt(riftId: string, wallet: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/arb_lp_positions?rift_id=eq.${riftId}&wallet_address=eq.${wallet}&select=created_at`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const data = res.ok ? await res.json() : [];
    return data.length > 0 ? data[0].created_at : null;
  } catch {
    return null;
  }
}

// Get all LP positions for a DLMM pool using Meteora API
async function getDLMMPositions(
  connection: any,
  poolAddress: string
): Promise<{ wallet: string; liquidity: number }[]> {
  try {
    // Try Meteora DLMM API first
    const apiUrl = `https://dlmm-api.meteora.ag/pair/${poolAddress}/positions`;
    console.log(`[LP-SYNC] Fetching DLMM positions from ${apiUrl}`);

    const response = await fetch(apiUrl, {
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
    });

    if (response.ok) {
      const data = await response.json();
      console.log(`[LP-SYNC] DLMM API returned ${data?.length || 0} positions`);

      if (data && Array.isArray(data) && data.length > 0) {
        // Group positions by owner wallet
        const walletLiquidity = new Map<string, number>();

        for (const pos of data) {
          const owner = pos.owner || pos.user || pos.wallet;
          if (!owner) continue;

          // Use totalXAmount + totalYAmount or liquidity field
          const liq = Number(pos.totalXAmount || 0) + Number(pos.totalYAmount || 0) ||
                      Number(pos.liquidity || 0) ||
                      Number(pos.positionLiquidity || 1);

          if (liq > 0) {
            const current = walletLiquidity.get(owner) || 0;
            walletLiquidity.set(owner, current + liq);
          }
        }

        const positions: { wallet: string; liquidity: number }[] = [];
        for (const [wallet, liquidity] of walletLiquidity) {
          if (liquidity > 0) {
            positions.push({ wallet, liquidity });
          }
        }

        console.log(`[LP-SYNC] Found ${positions.length} unique LP wallets in DLMM pool via API`);
        return positions;
      }
    }

    // Fallback: use SDK with getProgramAccounts
    console.log(`[LP-SYNC] DLMM API failed, falling back to SDK for ${poolAddress.slice(0, 8)}...`);
    const { PublicKey } = await getSolana();
    const DLMM = (await import('@meteora-ag/dlmm')).default;

    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool = await DLMM.create(connection, poolPubkey);
    const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

    const positionAccounts = await connection.getProgramAccounts(DLMM_PROGRAM_ID, {
      filters: [
        { memcmp: { offset: 8, bytes: poolPubkey.toBase58() } },
      ],
    });

    console.log(`[LP-SYNC] SDK found ${positionAccounts?.length || 0} position accounts`);

    if (!positionAccounts || positionAccounts.length === 0) {
      return [];
    }

    const walletLiquidity = new Map<string, number>();

    for (const { pubkey, account } of positionAccounts) {
      try {
        const data = account.data;
        if (data.length < 72) continue;

        const owner = new PublicKey(data.slice(40, 72)).toBase58();

        try {
          const positionInfo = await dlmmPool.getPosition(pubkey);
          const liq = Number(positionInfo.positionData?.totalXAmount || 0) +
                      Number(positionInfo.positionData?.totalYAmount || 0);

          if (liq > 0) {
            const current = walletLiquidity.get(owner) || 0;
            walletLiquidity.set(owner, current + liq);
          }
        } catch {
          // Use lamports as fallback
          const current = walletLiquidity.get(owner) || 0;
          walletLiquidity.set(owner, current + account.lamports);
        }
      } catch {
        // Skip invalid position
      }
    }

    const positions: { wallet: string; liquidity: number }[] = [];
    for (const [wallet, liquidity] of walletLiquidity) {
      if (liquidity > 0) {
        positions.push({ wallet, liquidity });
      }
    }

    console.log(`[LP-SYNC] Found ${positions.length} unique LP wallets via SDK`);
    return positions;
  } catch (error) {
    console.error('[LP-SYNC] DLMM error:', error);
    return [];
  }
}

// Get all LP positions for a DAMM V2 pool using CP-AMM SDK
async function getDAMMV2Positions(
  connection: any,
  poolAddress: string
): Promise<{ wallet: string; liquidity: number }[]> {
  try {
    const { PublicKey } = await getSolana();
    const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');

    const poolPubkey = new PublicKey(poolAddress);
    const cpAmm = new CpAmm(connection);

    console.log(`[LP-SYNC] Fetching DAMMV2 positions for pool ${poolAddress.slice(0, 8)}... using CP-AMM SDK`);

    // Get all positions for this pool using the SDK
    const positions = await cpAmm.getAllPositionsByPool(poolPubkey);

    console.log(`[LP-SYNC] DAMMV2 pool has ${positions?.length || 0} position accounts`);

    if (!positions || positions.length === 0) {
      return [];
    }

    // Group positions by owner wallet (need to look up NFT mint owners)
    const walletLiquidity = new Map<string, number>();

    for (const pos of positions) {
      try {
        const nftMint = (pos.account as { nftMint: any }).nftMint as typeof PublicKey.prototype;
        const liquidity = Number((pos.account as { unlockedLiquidity: any }).unlockedLiquidity?.toString() || '0');

        // Get the owner by finding who holds the NFT mint token
        // Using getTokenLargestAccounts is more reliable than parsing raw data
        const largestAccounts = await connection.getTokenLargestAccounts(nftMint);
        if (largestAccounts.value.length > 0) {
          const tokenAccountAddress = largestAccounts.value[0].address;
          const tokenAccountInfo = await connection.getParsedAccountInfo(tokenAccountAddress);

          if (tokenAccountInfo.value && 'parsed' in tokenAccountInfo.value.data) {
            const parsedData = (tokenAccountInfo.value.data as { parsed: { info: { owner: string } } }).parsed;
            const owner = parsedData.info.owner;

            if (owner && liquidity > 0) {
              const current = walletLiquidity.get(owner) || 0;
              walletLiquidity.set(owner, current + liquidity);
            }
          }
        }
      } catch (err) {
        // Skip invalid position
        console.log(`[LP-SYNC] Error parsing position:`, err instanceof Error ? err.message : 'unknown');
      }
    }

    const result: { wallet: string; liquidity: number }[] = [];
    for (const [wallet, liquidity] of walletLiquidity) {
      if (liquidity > 0) {
        result.push({ wallet, liquidity });
      }
    }

    console.log(`[LP-SYNC] Found ${result.length} unique LP wallets in DAMMV2 pool`);
    return result;
  } catch (error) {
    console.error('[LP-SYNC] DAMMV2 error:', error);
    return [];
  }
}

// POST - Sync LP positions for all rifts (admin only) or specific rift
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { wallet, riftId } = body;

    // Allow admin or cron job (no wallet = internal call)
    if (wallet && wallet !== ADMIN_WALLET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const { getServerConnection } = await getSolana();
    const connection = await getServerConnection();

    // Get rifts to sync (include created_at for auto-config)
    let riftsQuery = `${SUPABASE_URL}/rest/v1/rifts?select=id,token_symbol,raw_data,created_at`;
    if (riftId) {
      riftsQuery += `&id=eq.${riftId}`;
    }

    const riftsResponse = await fetch(riftsQuery, {
      headers: getHeaders(),
      cache: 'no-store',
    });

    if (!riftsResponse.ok) {
      return NextResponse.json({ error: 'Failed to fetch rifts' }, { status: 500 });
    }

    const rifts: RiftInfo[] = await riftsResponse.json();
    const results: { riftId: string; symbol: string; poolType: string; lpCount: number; error?: string }[] = [];

    for (const rift of rifts) {
      // Get ALL pool addresses - some rifts have multiple pools
      const allPools: string[] = [];
      if (rift.raw_data?.meteoraPool) allPools.push(rift.raw_data.meteoraPool);
      if (rift.raw_data?.liquidityPool && !allPools.includes(rift.raw_data.liquidityPool)) {
        allPools.push(rift.raw_data.liquidityPool);
      }
      if (rift.raw_data?.meteoraPools) {
        for (const p of rift.raw_data.meteoraPools) {
          if (!allPools.includes(p)) allPools.push(p);
        }
      }

      const rTokenMint = rift.raw_data?.riftMint;

      if (allPools.length === 0 || !rTokenMint) {
        results.push({
          riftId: rift.id,
          symbol: rift.token_symbol,
          poolType: 'none',
          lpCount: 0,
          error: 'No pool or mint found',
        });
        continue;
      }

      // Determine pool type: prefixType 0 = mono (DLMM), prefixType 1 = normal (DAMMV2)
      // Also check symbol: starts with "r" (mono) vs "mr" (normal)
      // m prefix = DLMM (mono), r prefix = DAMMV2
      const isDLMM = rift.token_symbol?.startsWith('m') && !rift.token_symbol?.startsWith('mr');
      const poolType = isDLMM ? 'DLMM' : 'DAMMV2';

      // Get rift creation time for config and LP position timestamps
      const riftCreatedAt = rift.created_at || rift.raw_data?.createdAt;

      // Auto-create rift config if it doesn't exist
      await ensureRiftConfig(rift.id, riftCreatedAt);

      try {
        // Get LP positions from ALL pools and aggregate
        console.log(`[LP-SYNC] Getting LP positions for ${rift.token_symbol} from ${allPools.length} pools...`);

        // Aggregate positions from all pools
        const walletLiquidity = new Map<string, number>();

        for (const poolAddress of allPools) {
          console.log(`[LP-SYNC] Checking pool ${poolAddress.slice(0, 8)}...`);

          let poolPositions: { wallet: string; liquidity: number }[] = [];

          if (poolType === 'DLMM') {
            poolPositions = await getDLMMPositions(connection, poolAddress);
            if (poolPositions.length === 0) {
              poolPositions = await getDAMMV2Positions(connection, poolAddress);
            }
          } else {
            poolPositions = await getDAMMV2Positions(connection, poolAddress);
            if (poolPositions.length === 0) {
              poolPositions = await getDLMMPositions(connection, poolAddress);
            }
          }

          // Aggregate liquidity per wallet across all pools
          for (const pos of poolPositions) {
            const current = walletLiquidity.get(pos.wallet) || 0;
            walletLiquidity.set(pos.wallet, current + pos.liquidity);
          }

          if (poolPositions.length > 0) {
            console.log(`[LP-SYNC] Found ${poolPositions.length} positions in pool ${poolAddress.slice(0, 8)}`);
          }
        }

        // Convert aggregated map to positions array
        const positions: { wallet: string; liquidity: number }[] = [];
        for (const [wallet, liquidity] of walletLiquidity) {
          if (liquidity > 0) {
            positions.push({ wallet, liquidity });
          }
        }

        console.log(`[LP-SYNC] Found ${positions.length} total LP positions for ${rift.token_symbol}`);

        // Calculate total liquidity and share percentages
        const totalLiquidity = positions.reduce((sum, p) => sum + p.liquidity, 0);

        // Upsert LP positions to database
        // Scale liquidity to fit database constraints (max 10^21)
        // Use a scaling factor to normalize large values
        const LIQUIDITY_SCALE = 1e15; // Scale down by 10^15

        for (const pos of positions) {
          const sharePct = totalLiquidity > 0 ? (pos.liquidity / totalLiquidity) * 100 : 0;
          // Scale liquidity to avoid numeric overflow in database
          const scaledLiquidity = pos.liquidity / LIQUIDITY_SCALE;

          // Check if position already exists (to preserve created_at for existing positions)
          const existingCreatedAt = await getLpPositionCreatedAt(rift.id, pos.wallet);
          const isNewPosition = !existingCreatedAt;

          console.log(`[LP-SYNC] ${isNewPosition ? 'Creating' : 'Updating'} position: rift=${rift.id}, wallet=${pos.wallet}, liquidity=${scaledLiquidity.toFixed(0)}, share=${sharePct.toFixed(2)}%`);

          // Build position data - only include created_at for NEW positions (set to rift creation time)
          const positionData: Record<string, unknown> = {
            rift_id: rift.id,
            wallet_address: pos.wallet,
            liquidity_amount: scaledLiquidity,
            share_pct: sharePct,
            last_updated: new Date().toISOString(),
          };

          // For new positions, set created_at to rift creation time (so they can earn from past trades)
          if (isNewPosition && riftCreatedAt) {
            positionData.created_at = riftCreatedAt;
            console.log(`[LP-SYNC] New LP position - setting created_at to rift creation time: ${riftCreatedAt}`);
          }

          const upsertRes = await fetch(
            `${SUPABASE_URL}/rest/v1/arb_lp_positions?on_conflict=rift_id,wallet_address`,
            {
              method: 'POST',
              headers: { ...getHeaders(), 'Prefer': 'resolution=merge-duplicates' },
              body: JSON.stringify(positionData),
            }
          );

          if (!upsertRes.ok) {
            const errText = await upsertRes.text();
            console.error(`[LP-SYNC] Upsert failed: ${errText}`);
          }
        }

        // Remove stale positions (wallets no longer in LP)
        // IMPORTANT: Always run cleanup, even when positions.length === 0
        // This ensures we delete stale entries when a pool becomes empty
        const currentWallets = positions.map(p => p.wallet);

        // Get existing positions for this rift
        const existingResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/arb_lp_positions?rift_id=eq.${rift.id}&select=wallet_address`,
          { headers: getHeaders(), cache: 'no-store' }
        );
        const existing = existingResponse.ok ? await existingResponse.json() : [];

        // Delete positions for wallets no longer in LP (or all if pool is empty)
        let deletedCount = 0;
        for (const ex of existing) {
          if (!currentWallets.includes(ex.wallet_address)) {
            await fetch(
              `${SUPABASE_URL}/rest/v1/arb_lp_positions?rift_id=eq.${rift.id}&wallet_address=eq.${ex.wallet_address}`,
              { method: 'DELETE', headers: getHeaders() }
            );
            deletedCount++;
          }
        }
        if (deletedCount > 0) {
          console.log(`[LP-SYNC] Deleted ${deletedCount} stale positions for ${rift.token_symbol}`);
        }

        results.push({
          riftId: rift.id,
          symbol: rift.token_symbol,
          poolType,
          lpCount: positions.length,
        });
      } catch (error) {
        console.error(`[LP-SYNC] Error syncing ${rift.token_symbol}:`, error);
        results.push({
          riftId: rift.id,
          symbol: rift.token_symbol,
          poolType,
          lpCount: 0,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const totalSynced = results.filter(r => !r.error).reduce((sum, r) => sum + r.lpCount, 0);

    return NextResponse.json({
      success: true,
      riftsProcessed: results.length,
      totalLpPositions: totalSynced,
      results,
    });
  } catch (error) {
    console.error('[LP-SYNC] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    );
  }
}

// GET - Get sync status / last sync time, or trigger sync (for cron)
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const riftId = searchParams.get('riftId');
    const sync = searchParams.get('sync');
    const wallet = searchParams.get('wallet');
    const cronSecret = request.headers.get('x-cron-secret') || searchParams.get('secret');

    // If sync=true or called without params (cron), run the sync
    if (sync === 'true' || (!riftId && !searchParams.has('status'))) {
      // Authentication check for sync operations
      const authHeader = request.headers.get('authorization');
      const isVercelCron = authHeader === `Bearer ${CRON_SECRET}`;
      const isValidCronSecret = CRON_SECRET && cronSecret === CRON_SECRET;
      const isAdmin = wallet === ADMIN_WALLET;

      if (!isAdmin && !isValidCronSecret && !isVercelCron) {
        console.log('[LP-SYNC] Unauthorized sync attempt');
        return NextResponse.json({ error: 'Unauthorized. Provide admin wallet or cron secret.' }, { status: 403 });
      }

      console.log(`[LP-SYNC] Running scheduled sync (auth: ${isAdmin ? 'admin' : isVercelCron ? 'vercel-cron' : 'cron-secret'})...`);

      const { getServerConnection } = await getSolana();
      const connection = await getServerConnection();

      // Get all rifts (include created_at for auto-config)
      const riftsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/rifts?select=id,token_symbol,raw_data,created_at`,
        { headers: getHeaders(), cache: 'no-store' }
      );

      if (!riftsResponse.ok) {
        return NextResponse.json({ error: 'Failed to fetch rifts' }, { status: 500 });
      }

      const rifts: RiftInfo[] = await riftsResponse.json();
      const results: { riftId: string; symbol: string; poolType: string; lpCount: number; error?: string }[] = [];

      for (const rift of rifts) {
        // Get ALL pool addresses - some rifts have multiple pools
        const allPools: string[] = [];
        if (rift.raw_data?.meteoraPool) allPools.push(rift.raw_data.meteoraPool);
        if (rift.raw_data?.liquidityPool && !allPools.includes(rift.raw_data.liquidityPool)) {
          allPools.push(rift.raw_data.liquidityPool);
        }
        if (rift.raw_data?.meteoraPools) {
          for (const p of rift.raw_data.meteoraPools) {
            if (!allPools.includes(p)) allPools.push(p);
          }
        }

        const rTokenMint = rift.raw_data?.riftMint;

        if (allPools.length === 0 || !rTokenMint) {
          continue; // Skip rifts without pools
        }

        // m prefix = DLMM (mono), r prefix = DAMMV2
        const isDLMM = rift.token_symbol?.startsWith('m') && !rift.token_symbol?.startsWith('mr');
        const poolType = isDLMM ? 'DLMM' : 'DAMMV2';

        // Get rift creation time for config and LP position timestamps
        const riftCreatedAt = rift.created_at || rift.raw_data?.createdAt;

        // Auto-create rift config if it doesn't exist
        await ensureRiftConfig(rift.id, riftCreatedAt);

        try {
          // Aggregate positions from all pools
          const walletLiquidity = new Map<string, number>();

          for (const poolAddress of allPools) {
            let poolPositions: { wallet: string; liquidity: number }[] = [];
            if (poolType === 'DLMM') {
              poolPositions = await getDLMMPositions(connection, poolAddress);
              if (poolPositions.length === 0) {
                poolPositions = await getDAMMV2Positions(connection, poolAddress);
              }
            } else {
              poolPositions = await getDAMMV2Positions(connection, poolAddress);
              if (poolPositions.length === 0) {
                poolPositions = await getDLMMPositions(connection, poolAddress);
              }
            }

            for (const pos of poolPositions) {
              const current = walletLiquidity.get(pos.wallet) || 0;
              walletLiquidity.set(pos.wallet, current + pos.liquidity);
            }
          }

          // Convert aggregated map to positions array
          const positions: { wallet: string; liquidity: number }[] = [];
          for (const [wallet, liquidity] of walletLiquidity) {
            if (liquidity > 0) {
              positions.push({ wallet, liquidity });
            }
          }

          const totalLiquidity = positions.reduce((sum, p) => sum + p.liquidity, 0);
          const LIQUIDITY_SCALE = 1e15; // Scale down to fit database constraints

          // Upsert current positions
          for (const pos of positions) {
            const sharePct = totalLiquidity > 0 ? (pos.liquidity / totalLiquidity) * 100 : 0;
            const scaledLiquidity = pos.liquidity / LIQUIDITY_SCALE;

            // Check if position already exists (to preserve created_at)
            const existingCreatedAt = await getLpPositionCreatedAt(rift.id, pos.wallet);
            const isNewPosition = !existingCreatedAt;

            // Build position data - only include created_at for NEW positions
            const positionData: Record<string, unknown> = {
              rift_id: rift.id,
              wallet_address: pos.wallet,
              liquidity_amount: scaledLiquidity,
              share_pct: sharePct,
              last_updated: new Date().toISOString(),
            };

            // For new positions, set created_at to rift creation time
            if (isNewPosition && riftCreatedAt) {
              positionData.created_at = riftCreatedAt;
            }

            await fetch(
              `${SUPABASE_URL}/rest/v1/arb_lp_positions?on_conflict=rift_id,wallet_address`,
              {
                method: 'POST',
                headers: { ...getHeaders(), 'Prefer': 'resolution=merge-duplicates' },
                body: JSON.stringify(positionData),
              }
            );
          }

          // IMPORTANT: Always cleanup stale positions, even when pool is empty
          const currentWallets = positions.map(p => p.wallet);
          const existingResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/arb_lp_positions?rift_id=eq.${rift.id}&select=wallet_address`,
            { headers: getHeaders(), cache: 'no-store' }
          );
          const existing = existingResponse.ok ? await existingResponse.json() : [];

          for (const ex of existing) {
            if (!currentWallets.includes(ex.wallet_address)) {
              await fetch(
                `${SUPABASE_URL}/rest/v1/arb_lp_positions?rift_id=eq.${rift.id}&wallet_address=eq.${ex.wallet_address}`,
                { method: 'DELETE', headers: getHeaders() }
              );
              console.log(`[LP-SYNC] Cron: Deleted stale position for ${rift.token_symbol} - ${ex.wallet_address.slice(0, 8)}...`);
            }
          }

          results.push({
            riftId: rift.id,
            symbol: rift.token_symbol,
            poolType,
            lpCount: positions.length,
          });
        } catch (error) {
          console.error(`[LP-SYNC] Error syncing ${rift.token_symbol}:`, error);
        }
      }

      const totalSynced = results.reduce((sum, r) => sum + r.lpCount, 0);
      return NextResponse.json({
        success: true,
        source: 'cron',
        riftsProcessed: results.length,
        totalLpPositions: totalSynced,
        results,
      });
    }

    // Status query - get current LP positions
    let query = `${SUPABASE_URL}/rest/v1/arb_lp_positions?select=rift_id,wallet_address,share_pct,last_updated`;
    if (riftId) {
      query += `&rift_id=eq.${riftId}`;
    }
    query += '&order=last_updated.desc&limit=100';

    const response = await fetch(query, {
      headers: getHeaders(),
      cache: 'no-store',
    });

    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch positions' }, { status: 500 });
    }

    const positions = await response.json();

    // Get unique rifts and their LP counts
    const riftStats = new Map<string, { lpCount: number; lastUpdated: string }>();
    for (const pos of positions) {
      const existing = riftStats.get(pos.rift_id);
      if (!existing) {
        riftStats.set(pos.rift_id, { lpCount: 1, lastUpdated: pos.last_updated });
      } else {
        existing.lpCount++;
      }
    }

    return NextResponse.json({
      totalPositions: positions.length,
      riftsWithLPs: riftStats.size,
      positions: riftId ? positions : undefined,
      riftStats: Object.fromEntries(riftStats),
    });
  } catch (error) {
    console.error('[LP-SYNC] GET Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    );
  }
}
