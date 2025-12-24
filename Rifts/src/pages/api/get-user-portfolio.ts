import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { getServerConnection } from '@/lib/solana/server-connection';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

interface RiftPosition {
  rift: string;
  underlying: string;
  position: number;
  value: number;
  pnl: number;
  entry: number;
  current: number;
  rewards: number;
}

interface Transaction {
  type: string;
  amount: string;
  timestamp: number;
  hash: string;
  rift: string;
  time: string;
  status: string;
  value: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { wallet } = req.query;

  if (!wallet || typeof wallet !== 'string') {
    return res.status(400).json({ error: 'Wallet address required' });
  }

  // Check required environment variables
  if (!supabaseUrl || !supabaseKey) {
    console.error('[GET-USER-PORTFOLIO] ❌ Missing Supabase credentials');
    return res.status(500).json({
      error: 'Missing Supabase credentials. Please set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables.',
      missingVars: {
        NEXT_PUBLIC_SUPABASE_URL: !supabaseUrl,
        SUPABASE_KEY: !supabaseKey
      },
      totalValue: 0,
      positions: [],
      totalRewards: 0,
      claimableRewards: 0,
      transactions: [],
      pnl7d: 0,
      pnl7dPercent: 0,
      pnl30d: 0,
      pnl30dPercent: 0,
      riftsBalance: 0,
      riftsBalanceUsd: 0
    });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    const connection = await getServerConnection();

    // Fetch user's transactions from Supabase
    const { data: transactions, error: txError } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_wallet', wallet)
      .order('timestamp', { ascending: false })
      .limit(50);

    if (txError) {
      console.error('[GET-USER-PORTFOLIO] Supabase error:', txError);
    }

    // Fetch all rifts directly from Supabase (avoid internal HTTP fetch which fails in serverless)
    console.log(`[GET-USER-PORTFOLIO] Fetching rifts from Supabase...`);

    const { data: riftsFromDb, error: riftsError } = await supabase
      .from('rifts')
      .select('*')
      .eq('is_deprecated', false);

    if (riftsError) {
      console.error(`[GET-USER-PORTFOLIO] Supabase error:`, riftsError);
      throw new Error(`Failed to fetch rifts from Supabase: ${riftsError.message}`);
    }

    // Map Supabase rifts to expected format
    const rifts = (riftsFromDb || []).map((r: any) => ({
      id: r.id,
      symbol: r.token_symbol,
      riftMint: r.token_mint,
      underlyingMint: r.raw_data?.underlyingMint,
      underlying: r.raw_data?.underlying,
      riftTokenPrice: r.current_price || r.raw_data?.riftTokenPrice || 0,
      totalRiftMinted: r.total_tokens_wrapped || r.raw_data?.totalRiftMinted || 0,
      volume24h: r.volume_24h || r.raw_data?.volume24h || 0
    }));

    console.log(`[GET-USER-PORTFOLIO] Found ${rifts.length} rifts from Supabase`);

    const userPubkey = new PublicKey(wallet);
    const positions: RiftPosition[] = [];

    // Check balance for each rift token
    if (rifts && rifts.length > 0) {
      for (const rift of rifts) {
        try {
          if (!rift.riftMint) {
            console.log(`[GET-USER-PORTFOLIO] Skipping ${rift.symbol} - no riftMint`);
            continue;
          }

          const riftTokenMint = new PublicKey(rift.riftMint);

          // Get user's ATA for this rift token
          const userAta = await getAssociatedTokenAddress(
            riftTokenMint,
            userPubkey
          );

          // Try to get the account
          const accountInfo = await connection.getAccountInfo(userAta);

          if (accountInfo) {
            const tokenAccount = await getAccount(connection, userAta);
            const balance = Number(tokenAccount.amount) / 1e9; // Convert from lamports

            if (balance > 0) {
              // Calculate position value
              const currentPrice = rift.riftTokenPrice || 1;
              const value = balance * currentPrice;

              // Calculate entry price from user's transactions
              const userWrapTxs = (transactions || [])
                .filter((tx: any) =>
                  tx.type === 'wrap' &&
                  (tx.token_symbol === rift.symbol || tx.token === rift.symbol)
                );

              let totalCost = 0;
              let totalAmount = 0;

              userWrapTxs.forEach((tx: any) => {
                const amount = tx.amount || 0;
                const price = tx.price || currentPrice;
                totalCost += amount * price;
                totalAmount += amount;
              });

              const entryPrice = totalAmount > 0 ? totalCost / totalAmount : currentPrice;
              const pnl = ((currentPrice - entryPrice) / entryPrice) * 100;

              // Calculate rewards based on user's share of rift tokens
              // Rewards = (user_balance / total_supply) × total_fees_collected
              const totalSupply = rift.totalRiftMinted || balance; // Fallback to balance if no total supply
              const userShare = totalSupply > 0 ? balance / totalSupply : 0;
              const totalFeesCollected = rift.volume24h * 0.007; // 0.7% fee on volume
              const rewards = userShare * totalFeesCollected;

              positions.push({
                rift: rift.symbol,
                underlying: rift.underlying || 'SOL',
                position: balance,
                value,
                pnl,
                entry: entryPrice,
                current: currentPrice,
                rewards
              });
            }
          }
        } catch (err) {
          // Account doesn't exist or other error - user has no position in this rift
          console.log(`[GET-USER-PORTFOLIO] No position in ${rift.symbol}:`, err instanceof Error ? err.message : 'Unknown error');
        }
      }
    }

    // Calculate portfolio summary (includes RIFTS token value)
    const positionsValue = positions.reduce((sum, p) => sum + p.value, 0);
    const totalRewards = positions.reduce((sum, p) => sum + p.rewards, 0);

    // Calculate claimable rewards (rewards that are ready to claim)
    const claimableRewards = totalRewards * 0.8; // 80% of rewards are claimable

    // Fetch RIFTS token balance
    let riftsBalance = 0;
    let riftsBalanceUsd = 0;
    const RIFTS_MINT = process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';
    const RIFTS_DECIMALS = 6; // RIFTS always has 6 decimals (hardcoded to avoid RPC call)

    try {
      const riftsMint = new PublicKey(RIFTS_MINT);
      const decimals = RIFTS_DECIMALS;

      const riftsAta = await getAssociatedTokenAddress(riftsMint, userPubkey);
      const riftsAccountInfo = await connection.getAccountInfo(riftsAta);

      if (riftsAccountInfo) {
        const riftsTokenAccount = await getAccount(connection, riftsAta);
        // Use correct decimals (RIFTS has 6 decimals, not 9)
        riftsBalance = Number(riftsTokenAccount.amount) / Math.pow(10, decimals);

        // Get RIFTS price from DexScreener for accurate market price
        let riftsPrice = 0.002; // Fallback price
        try {
          const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${RIFTS_MINT}`);
          const dexData = await dexRes.json();
          riftsPrice = parseFloat(dexData.pairs?.[0]?.priceUsd || '0.002');
          console.log(`[GET-USER-PORTFOLIO] RIFTS price from DexScreener: $${riftsPrice}`);
        } catch (e) {
          console.log(`[GET-USER-PORTFOLIO] Failed to fetch RIFTS price from DexScreener, using fallback`);
        }
        riftsBalanceUsd = riftsBalance * riftsPrice;

        console.log(`[GET-USER-PORTFOLIO] RIFTS Balance: ${riftsBalance.toLocaleString()} RIFTS ($${riftsBalanceUsd.toFixed(2)}) [${decimals} decimals]`);
      }
    } catch (err) {
      console.log(`[GET-USER-PORTFOLIO] No RIFTS balance found:`, err instanceof Error ? err.message : 'Unknown error');
    }

    // Format transactions for frontend
    const formattedTransactions: Transaction[] = (transactions || []).map((tx: any) => ({
      type: tx.type,
      amount: tx.amount?.toFixed(4) || '0',
      timestamp: new Date(tx.timestamp).getTime(),
      hash: tx.signature,
      rift: tx.token_symbol || tx.token || 'Unknown',
      time: new Date(tx.timestamp).toLocaleString(),
      status: tx.status || 'confirmed',
      value: `$${(tx.amount * (tx.price || 180)).toFixed(2)}`
    }));

    // Total value includes both rift positions AND RIFTS governance token
    const totalValue = positionsValue + riftsBalanceUsd;

    // Calculate PnL based on position entry prices vs current value
    // Simple PnL: sum of (current_value - entry_value) for all positions
    const totalEntryValue = positions.reduce((sum, p) => sum + (p.position * p.entry), 0);
    const pnl = positionsValue - totalEntryValue;
    const pnlPercent = totalEntryValue > 0 ? (pnl / totalEntryValue) * 100 : 0;

    // For 7-day and 30-day PnL, use simplified calculation
    // Since we don't have historical price data, we'll use entry-based PnL
    const pnl7d = pnl; // Same as overall PnL
    const pnl7dPercent = pnlPercent;
    const pnl30d = pnl;
    const pnl30dPercent = pnlPercent;

    const portfolioData = {
      // Portfolio summary
      totalValue,
      positions,
      totalRewards,
      claimableRewards,

      // Transactions
      transactions: formattedTransactions,

      // Performance
      pnl7d,
      pnl7dPercent,
      pnl30d,
      pnl30dPercent,

      // RIFTS Token Status
      riftsBalance,
      riftsBalanceUsd
    };

    res.status(200).json(portfolioData);
  } catch (error: any) {
    console.error('[GET-USER-PORTFOLIO] Fatal error:', error);

    // Get detailed error information
    const errorDetails = {
      message: error instanceof Error ? error.message : 'Portfolio fetch failed',
      stack: error instanceof Error ? error.stack : undefined,
      type: error instanceof Error ? error.constructor.name : typeof error,
      raw: String(error)
    };

    res.status(500).json({
      error: errorDetails.message,
      errorDetails,
      totalValue: 0,
      positions: [],
      totalRewards: 0,
      claimableRewards: 0,
      transactions: [],
      pnl7d: 0,
      pnl7dPercent: 0,
      pnl30d: 0,
      pnl30dPercent: 0,
      riftsBalance: 0,
      riftsBalanceUsd: 0,
      env: {
        hasSupabaseUrl: !!supabaseUrl,
        hasSupabaseKey: !!supabaseKey,
        hasSiteUrl: !!(process.env.NEXT_PUBLIC_SITE_URL),
        siteUrl: process.env.NEXT_PUBLIC_SITE_URL
      }
    });
  }
}
