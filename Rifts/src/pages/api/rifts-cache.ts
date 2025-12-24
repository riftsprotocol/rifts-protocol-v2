// Server-side rifts cache API
// Pre-fetches rifts from blockchain and serves them instantly to all users
import { NextApiRequest, NextApiResponse } from 'next';
import { productionJupiterOracle } from '@/lib/solana/jupiter-oracle';
import { withRateLimiting } from '@/lib/middleware/pages-api-protection';
import { apiRateLimiter } from '@/lib/middleware/rate-limiter';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
// DLMM pools are now fetched using getProgramAccountsV2 with memcmp filters
// This is much faster than fetching all 124k pools via DLMM SDK

// Manual monorift overrides - these rifts were created as monorifts but the on-chain name doesn't start with 'm'
// Map of rift address -> { symbol, prefixType }
const MONORIFT_OVERRIDES: Record<string, { symbol: string; prefixType: 1 }> = {
  'HFwWNDSTiDH9BrvJx7wzHQ3WxcQd4f5WKrxnzxqA3wN7': { symbol: 'mLASHI', prefixType: 1 },  // mLASHI monorift
  'ComaEqvAM2Eb9ndEPjjKMX2TdD8ZinBKmVvaJwpVH4Zj': { symbol: 'mLASHI', prefixType: 1 },  // mLASHI monorift (duplicate)
  '9eSLyvGkKjLvu2YhtvFH5biYkx7fDmzJZgwTb1J3A2eo': { symbol: 'mHAMM', prefixType: 1 },   // mHAMM monorift
  '2YeTFrHmeJ55kYBfeCciJTNFCfEEoXZKZcj7RMfHhJRh': { symbol: 'mRIFTS', prefixType: 1 },  // mRIFTS monorift (on-chain name is "RIFTS")
  'HbFjxB41Ty17XSeAZqf6LYoUTrr75rJ5utFnCfGQUYNU': { symbol: 'mRIFTS', prefixType: 1 },  // mRIFTS monorift (on-chain rift name is "RIFTS" but token is "mRIFTS")
  '6M6eZPMBGr59Rqd1exwJ9ZV2uk1ZcFWGcUtLnFhhZHqE': { symbol: 'mRIFTS', prefixType: 1 },  // mRIFTS monorift (riftMint: De9BRKErZErThHdXBDnLkgqhbSwhRsxK1hC3ketaU4CY)
};

// Import shared blacklist from types.ts - single source of truth
import { BLACKLISTED_RIFTS } from '@/lib/solana/rifts/types';

// Cache configuration
const CACHE_DURATION = 60 * 1000; // 60 seconds (increased from 15s to reduce RPC load)
const MAX_CACHE_AGE = 5 * 60 * 1000; // 5 minutes max age before forcing refresh
const TX_SCAN_COOLDOWN = 5 * 60 * 1000; // 🔧 5 minute cooldown for real-time metrics
const TX_LIMIT_PER_RIFT = 100; // 🔧 Scan 100 signatures per rift for transaction scanner
const DLMM_CACHE_DURATION = 10 * 60 * 1000; // 10 minutes - DLMM pools don't change often
let cachedRifts: any[] = [];
let lastFetchTime = 0;
let lastTxScanTime = 0; // Track last transaction scan

// DLMM pool cache (separate from rifts cache - pools change less frequently)
type DlmmPoolInfo = { address: string; tokenX: string; tokenY: string; binStep: number };
let cachedDlmmPoolsByMint: Map<string, DlmmPoolInfo[]> = new Map();
let lastDlmmFetchTime = 0;

// Use shared server connection singleton (avoids creating 25+ connections)
import { getServerConnection, getServerRpcUrl } from '@/lib/solana/server-connection';

// String constants - PublicKey created dynamically to avoid bundling issues
const RIFTS_PROGRAM_ID_STR = process.env.NEXT_PUBLIC_RIFTS_PROGRAM_ID || '6FEZJKsxbDm5W4Ad4eogNehivRKKGCHJHRnKUSFbLpKt';
const RIFTS_V1_PROGRAM_ID_STR = process.env.NEXT_PUBLIC_RIFTS_V1_PROGRAM_ID || '9qomJJ5jMzaKu9JXgMzbA3KEyQ3kqcW7hN3xq3tMEkww'; // V1 legacy program

// Specific V1 Rift that needs to be included
const V1_RIFT_ADDRESS = 'CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL'; // V1 rRIFTS rift PDA (token mint: 3X7VGd8dK6obiQUtAVRZhTRpP1sfhLc1JMGtQi4hYi2z)

// Lazy-initialized runtime values
let _connection: any = null;
let _PublicKey: any = null;
let _RIFTS_PROGRAM_ID: any = null;
let _RIFTS_V1_PROGRAM_ID: any = null;

// Get connection and PublicKey lazily
async function getRuntime() {
  if (!_connection) {
    const { PublicKey } = await import('@solana/web3.js');
    _PublicKey = PublicKey;
    _connection = await getServerConnection();
    _RIFTS_PROGRAM_ID = new PublicKey(RIFTS_PROGRAM_ID_STR);
    _RIFTS_V1_PROGRAM_ID = new PublicKey(RIFTS_V1_PROGRAM_ID_STR);
  }
  return {
    connection: _connection,
    PublicKey: _PublicKey,
    RIFTS_PROGRAM_ID: _RIFTS_PROGRAM_ID,
    RIFTS_V1_PROGRAM_ID: _RIFTS_V1_PROGRAM_ID,
    RPC_URL: getServerRpcUrl()
  };
}

// DLMM Program ID
const DLMM_PROGRAM_ID_STR = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

/**
 * Fetch DLMM pools for specific token mints
 * Primary: Meteora DLMM API (reliable, always up-to-date)
 * Fallback: On-chain detection via RPC (uses correct offsets: tokenX@88, tokenY@120)
 */
async function fetchDlmmPoolsForMints(
  rpcUrl: string,
  mintAddresses: string[]
): Promise<Map<string, DlmmPoolInfo[]>> {
  if (mintAddresses.length === 0) {
    return new Map();
  }

  console.log(`[DLMM] Fetching pools for ${mintAddresses.length} unique token(s)...`);
  const startTime = Date.now();

  const poolsByMint = new Map<string, DlmmPoolInfo[]>();
  const mintSet = new Set(mintAddresses);

  // ============ PRIMARY: Meteora DLMM API ============
  try {
    console.log(`[DLMM] 📡 Trying Meteora API first...`);
    const response = await fetch('https://dlmm-api.meteora.ag/pair/all', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000), // 15s timeout
    });

    if (response.ok) {
      const allPools = await response.json();
      console.log(`[DLMM] 📊 Fetched ${allPools.length} total DLMM pools from Meteora API`);

      let matchedPools = 0;

      for (const pool of allPools) {
        const mintX = pool.mint_x;
        const mintY = pool.mint_y;

        if (!mintSet.has(mintX) && !mintSet.has(mintY)) continue;

        matchedPools++;

        const poolInfo: DlmmPoolInfo = {
          address: pool.address,
          tokenX: mintX,
          tokenY: mintY,
          binStep: pool.bin_step || 0
        };

        // Add to map for both tokens
        if (!poolsByMint.has(mintX)) poolsByMint.set(mintX, []);
        if (!poolsByMint.has(mintY)) poolsByMint.set(mintY, []);

        const existingX = poolsByMint.get(mintX)!;
        const existingY = poolsByMint.get(mintY)!;

        if (!existingX.some(p => p.address === poolInfo.address)) {
          existingX.push(poolInfo);
        }
        if (!existingY.some(p => p.address === poolInfo.address)) {
          existingY.push(poolInfo);
        }
      }

      const elapsed = Date.now() - startTime;
      console.log(`[DLMM] ✅ Meteora API: Found ${matchedPools} pool(s) for ${poolsByMint.size} mint(s) in ${elapsed}ms`);

      if (matchedPools > 0) {
        return poolsByMint;
      }
      console.log(`[DLMM] ⚠️ No pools found via API, trying on-chain fallback...`);
    } else {
      console.log(`[DLMM] ⚠️ Meteora API returned ${response.status}, trying on-chain fallback...`);
    }
  } catch (apiError) {
    console.log(`[DLMM] ⚠️ Meteora API error: ${apiError instanceof Error ? apiError.message : apiError}, trying on-chain fallback...`);
  }

  // ============ FALLBACK: On-chain detection via RPC ============
  // DLMM LbPair account layout (904 bytes):
  // - Offset 88: tokenXMint (32 bytes)
  // - Offset 120: tokenYMint (32 bytes)
  // - Offset 152: binStep (2 bytes, u16)
  try {
    console.log(`[DLMM] 🔗 Trying on-chain detection...`);
    const { PublicKey } = await import('@solana/web3.js');
    const connection = await getServerConnection();
    const DLMM_PROGRAM_ID = new PublicKey(DLMM_PROGRAM_ID_STR);

    for (const mint of mintAddresses) {
      const mintPubkey = new PublicKey(mint);

      // Query as tokenX (offset 88)
      try {
        const poolsAsTokenX = await connection.getProgramAccounts(DLMM_PROGRAM_ID, {
          filters: [
            { dataSize: 904 },
            { memcmp: { offset: 88, bytes: mint } }
          ],
          commitment: 'confirmed'
        });

        for (const { pubkey, account } of poolsAsTokenX) {
          const data = account.data;
          const tokenX = new PublicKey(data.slice(88, 120)).toBase58();
          const tokenY = new PublicKey(data.slice(120, 152)).toBase58();
          const binStep = data.readUInt16LE(152);

          const poolInfo: DlmmPoolInfo = {
            address: pubkey.toBase58(),
            tokenX,
            tokenY,
            binStep
          };

          if (!poolsByMint.has(tokenX)) poolsByMint.set(tokenX, []);
          if (!poolsByMint.has(tokenY)) poolsByMint.set(tokenY, []);

          const existingX = poolsByMint.get(tokenX)!;
          const existingY = poolsByMint.get(tokenY)!;

          if (!existingX.some(p => p.address === poolInfo.address)) {
            existingX.push(poolInfo);
            console.log(`[DLMM] 🔍 On-chain: Found pool ${pubkey.toBase58().slice(0,8)}... for ${mint.slice(0,8)}... as tokenX`);
          }
          if (!existingY.some(p => p.address === poolInfo.address)) {
            existingY.push(poolInfo);
          }
        }
      } catch (e) {
        console.log(`[DLMM] ⚠️ On-chain tokenX query failed for ${mint.slice(0,8)}...:`, e instanceof Error ? e.message : e);
      }

      // Query as tokenY (offset 120)
      try {
        const poolsAsTokenY = await connection.getProgramAccounts(DLMM_PROGRAM_ID, {
          filters: [
            { dataSize: 904 },
            { memcmp: { offset: 120, bytes: mint } }
          ],
          commitment: 'confirmed'
        });

        for (const { pubkey, account } of poolsAsTokenY) {
          const data = account.data;
          const tokenX = new PublicKey(data.slice(88, 120)).toBase58();
          const tokenY = new PublicKey(data.slice(120, 152)).toBase58();
          const binStep = data.readUInt16LE(152);

          const poolInfo: DlmmPoolInfo = {
            address: pubkey.toBase58(),
            tokenX,
            tokenY,
            binStep
          };

          if (!poolsByMint.has(tokenX)) poolsByMint.set(tokenX, []);
          if (!poolsByMint.has(tokenY)) poolsByMint.set(tokenY, []);

          const existingX = poolsByMint.get(tokenX)!;
          const existingY = poolsByMint.get(tokenY)!;

          if (!existingX.some(p => p.address === poolInfo.address)) {
            existingX.push(poolInfo);
          }
          if (!existingY.some(p => p.address === poolInfo.address)) {
            existingY.push(poolInfo);
            console.log(`[DLMM] 🔍 On-chain: Found pool ${pubkey.toBase58().slice(0,8)}... for ${mint.slice(0,8)}... as tokenY`);
          }
        }
      } catch (e) {
        console.log(`[DLMM] ⚠️ On-chain tokenY query failed for ${mint.slice(0,8)}...:`, e instanceof Error ? e.message : e);
      }
    }

    const elapsed = Date.now() - startTime;
    const totalPools = Array.from(poolsByMint.values()).reduce((sum, pools) => sum + pools.length, 0) / 2; // Divide by 2 since each pool is in both token maps
    console.log(`[DLMM] ✅ On-chain fallback: Found ${Math.round(totalPools)} pool(s) for ${poolsByMint.size} mint(s) in ${elapsed}ms`);

  } catch (onchainError) {
    console.log(`[DLMM] ❌ On-chain detection failed:`, onchainError instanceof Error ? onchainError.message : onchainError);
  }

  return poolsByMint;
}

// Initialize Supabase client with SERVICE ROLE KEY for write access (bypasses RLS)
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Scan blockchain for wrap/unwrap transactions and save to database
 * OPTIMIZED: Checks Supabase cache first to avoid redundant RPC calls
 */
async function scanAndSaveTransactions(rifts: any[]) {
  if (!rifts || rifts.length === 0) return;

  // Get lazy-initialized runtime values
  const { connection, PublicKey } = await getRuntime();

  console.log(`\n🔍 [TX SCANNER] ===== STARTING TRANSACTION SCAN =====`);
  console.log(`[TX SCANNER] Scanning transactions for ${rifts.length} rifts...`);

  const transactions: any[] = [];
  const oneDayAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
  let totalGetTransactionCalls = 0;
  let cachedSkipped = 0;

  // 🔧 OPTIMIZATION: Pre-fetch ALL cached signatures from Supabase to avoid redundant RPC calls
  const cachedSignatures = new Set<string>();
  try {
    const oneDayAgoISO = new Date(oneDayAgo * 1000).toISOString();
    const { data: cachedTxs } = await supabase
      .from('transactions')
      .select('signature')
      .gte('timestamp', oneDayAgoISO);

    if (cachedTxs && cachedTxs.length > 0) {
      for (const tx of cachedTxs) {
        cachedSignatures.add(tx.signature);
      }
      console.log(`[TX SCANNER] 📦 Found ${cachedSignatures.size} cached transactions - will skip these`);
    }
  } catch (cacheError) {
    console.log(`[TX SCANNER] ⚠️ Cache check failed, will fetch all:`, cacheError instanceof Error ? cacheError.message : cacheError);
  }

  // Scan each rift for recent transactions
  for (const rift of rifts) {
    try {
      const riftPubkey = new PublicKey(rift.id);

      // Get recent transaction signatures (with caching to avoid redundant RPC calls)
      console.log(`[TX SCANNER] 📡 Fetching signatures for ${rift.symbol}...`);
      const { getSignaturesWithCache } = await import('@/lib/server-signature-cache');
      const signatures = await getSignaturesWithCache(
        connection,
        riftPubkey,
        { limit: TX_LIMIT_PER_RIFT },
        'confirmed'
      );

      console.log(`[TX SCANNER] Found ${signatures.length} signatures for ${rift.symbol}`);

      // Parse each transaction - SKIP if already cached
      for (const sig of signatures) {
        if (!sig.blockTime || sig.blockTime < oneDayAgo) continue;

        // 🔧 OPTIMIZATION: Skip if already in cache
        if (cachedSignatures.has(sig.signature)) {
          cachedSkipped++;
          continue;
        }

        try {
          console.log(`[TX SCANNER] 🔎 getTransaction #${++totalGetTransactionCalls}: ${sig.signature.slice(0, 8)}...`);
          const tx = await connection.getTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0
          });

          if (!tx || !tx.meta || tx.meta.err) continue;

          // Parse logs for wrap/unwrap events
          const logs = tx.meta.logMessages || [];
          let txType: 'wrap' | 'unwrap' | null = null;
          let amount = 0;

          // Look for wrap/unwrap in logs
          for (const log of logs) {
            // Check for Wrap instruction or wrapped confirmation
            if (log.includes('Instruction: WrapTokens') || log.includes('✅ Wrapped')) {
              txType = 'wrap';
              // Try to extract amount from log: "✅ Wrapped 320339473735 SOL → 318097097419 RIFT"
              const match = log.match(/Wrapped\s+([\d.]+)\s+SOL/i);
              if (match) {
                amount = parseFloat(match[1]) / 1e9; // Convert from lamports to SOL
              }
            }
            // Check for Unwrap instruction or unwrapping confirmation
            else if (log.includes('Instruction: UnwrapFromVault') || log.includes('💰 Unwrapping')) {
              txType = 'unwrap';
              // Try to extract amount from log: "💰 Unwrapping 297039351502 RIFT from vault"
              const match = log.match(/Unwrapping\s+([\d.]+)\s+RIFT/i);
              if (match) {
                amount = parseFloat(match[1]) / 1e9; // Convert from lamports to SOL equivalent
              }
            }
          }

          if (!txType) continue;

          // Get user wallet (fee payer)
          // Note: Some versioned transactions use Address Lookup Tables (ALTs)
          // which need to be resolved. If unresolved, getAccountKeys() will throw.
          let userWallet: string | undefined;
          try {
            const accountKeys = tx.transaction.message.getAccountKeys();
            userWallet = accountKeys && accountKeys.length > 0
              ? accountKeys.get(0)?.toBase58()
              : undefined;
          } catch (altError) {
            // Transaction uses unresolved ALTs (common with Jupiter/DEX swaps)
            // Fall back to getting the fee payer from static account keys
            try {
              const staticKeys = tx.transaction.message.staticAccountKeys;
              userWallet = staticKeys && staticKeys.length > 0
                ? staticKeys[0].toBase58()
                : undefined;
            } catch {
              // If all else fails, skip the user wallet
              userWallet = undefined;
            }
          }

          // If amount not in logs, calculate from token balance changes
          if (amount === 0) {
            const preBalances = tx.meta.preTokenBalances || [];
            const postBalances = tx.meta.postTokenBalances || [];

            for (const post of postBalances) {
              if (post.mint === rift.underlyingMint) {
                const pre = preBalances.find((p: any) => p.accountIndex === post.accountIndex);
                const preAmount = pre ? parseFloat(pre.uiTokenAmount.uiAmountString || '0') : 0;
                const postAmount = parseFloat(post.uiTokenAmount.uiAmountString || '0');
                amount = Math.abs(postAmount - preAmount);
                if (amount > 0) break;
              }
            }
          }

          if (amount === 0) continue;

          // Add transaction to list
          transactions.push({
            id: `${sig.signature}-${txType}`,
            signature: sig.signature,
            type: txType,
            amount: amount.toString(),
            asset: rift.symbol,
            token_symbol: rift.symbol, // Add token_symbol for display in portfolio
            rift_id: rift.id,
            rift_mint: rift.riftMint, // Add rift_mint for reference
            user_wallet: userWallet,
            timestamp: new Date(sig.blockTime * 1000).toISOString(),
            status: 'confirmed'
          });

        } catch (txError) {
          console.error(`[TX SCANNER] Error parsing tx ${sig.signature}:`, txError instanceof Error ? txError.message : txError);
        }
      }
    } catch (riftError) {
      console.error(`[TX SCANNER] Error scanning ${rift.symbol}:`, riftError instanceof Error ? riftError.message : riftError);
    }
  }

  console.log(`\n📊 [TX SCANNER] ===== SCAN COMPLETE =====`);
  console.log(`[TX SCANNER] Total getTransaction calls made: ${totalGetTransactionCalls}`);
  console.log(`[TX SCANNER] Skipped from cache: ${cachedSkipped}`);
  console.log(`[TX SCANNER] Found ${transactions.length} NEW wrap/unwrap transactions`);

  // NOTE: Metrics are saved separately in the main handler (with burned rift TVL included)
  // This function only saves transactions to avoid duplicate metrics saves

  // Save transactions to database (metrics handled by main handler)
  if (transactions.length > 0) {
    try {
      const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : (process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000');
      const response = await fetch(`${baseUrl}/api/save-protocol-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions }) // Only transactions, no metrics
      });

      if (response.ok) {
        console.log(`[TX SCANNER] ✅ Saved ${transactions.length} transactions to database`);
      } else {
        const errorText = await response.text();
        console.error(`[TX SCANNER] Failed to save transactions:`, errorText);
      }
    } catch (saveError) {
      console.error(`[TX SCANNER] Error saving transactions:`, saveError instanceof Error ? saveError.message : saveError);
    }
  } else {
    console.log(`[TX SCANNER] No new transactions to save`);
  }
}

/**
 * Get cached mint data (decimals, transfer fee) to avoid redundant RPC calls
 * These values NEVER change for a mint, so we can cache them indefinitely
 */
async function getCachedMintData(riftAddress: string): Promise<{
  underlyingDecimals: number;
  riftDecimals: number;
  transferFeeBps: number | null;
} | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;

  try {
    const { data, error } = await supabase
      .from('rift_account_cache')
      .select('underlying_decimals, rift_decimals, transfer_fee_bps')
      .eq('rift_address', riftAddress)
      .single();

    if (error || !data) return null;

    // Only return if we have the essential decimals data
    if (data.underlying_decimals !== null && data.rift_decimals !== null) {
      return {
        underlyingDecimals: data.underlying_decimals,
        riftDecimals: data.rift_decimals,
        transferFeeBps: data.transfer_fee_bps ?? null
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save raw rift account data to cache for instant client access
 */
async function saveRiftAccountToCache(riftData: {
  riftAddress: string;
  accountData: Buffer;
  vaultAddress: string;
  vaultAccountData: Buffer | null;
  underlyingMint: string;
  underlyingDecimals: number;
  riftMint: string;
  riftDecimals: number;
  transferFeeBps: number | null;
  backingRatio: bigint;
  totalWrapped: bigint;
  totalMinted: bigint;
}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  try {
    const { error } = await supabase
      .from('rift_account_cache')
      .upsert({
        rift_address: riftData.riftAddress,
        account_data: {
          // Store as hex string for easy parsing
          hex: riftData.accountData.toString('hex'),
          length: riftData.accountData.length
        },
        vault_address: riftData.vaultAddress,
        vault_account_data: riftData.vaultAccountData ? {
          hex: riftData.vaultAccountData.toString('hex'),
          length: riftData.vaultAccountData.length
        } : null,
        underlying_mint: riftData.underlyingMint,
        underlying_decimals: riftData.underlyingDecimals,
        rift_mint: riftData.riftMint,
        rift_decimals: riftData.riftDecimals,
        transfer_fee_bps: riftData.transferFeeBps,
        backing_ratio: riftData.backingRatio.toString(), // Store as string to avoid bigint JSON issues
        total_wrapped: riftData.totalWrapped.toString(),
        total_minted: riftData.totalMinted.toString(),
        last_updated: new Date().toISOString()
      }, {
        onConflict: 'rift_address'
      });

    if (error) {
      console.error(`[RIFT-CACHE] Error saving ${riftData.riftAddress}:`, error.message);
    } else {
      console.log(`[RIFT-CACHE] ✅ Cached account data for ${riftData.riftAddress.slice(0, 8)}...`);
    }
  } catch (error) {
    console.error(`[RIFT-CACHE] Exception saving ${riftData.riftAddress}:`, error instanceof Error ? error.message : error);
  }
}

/**
 * Update Supabase with fresh rift data
 */
async function updateSupabaseCache(rifts: any[]) {
  if (!rifts || rifts.length === 0) return;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('[SUPABASE] Skipping update - Supabase credentials not configured');
    return;
  }

  const { connection, PublicKey, RIFTS_PROGRAM_ID, RIFTS_V1_PROGRAM_ID } = await getRuntime();
  console.log(`[SUPABASE] Updating ${rifts.length} rifts in Supabase...`);

  // Mark blacklisted rifts as deprecated in Supabase
  try {
    for (const blacklistedId of BLACKLISTED_RIFTS) {
      await supabase
        .from('rifts')
        .update({ is_deprecated: true, is_open: false })
        .eq('id', blacklistedId);
    }
    console.log(`[SUPABASE] ✅ Marked ${BLACKLISTED_RIFTS.length} blacklisted rifts as deprecated`);
  } catch (error) {
    console.error('[SUPABASE] Error marking blacklisted rifts:', error instanceof Error ? error.message : error);
  }

  for (const rift of rifts) {
    // Extra safety check - skip blacklisted rifts
    if (BLACKLISTED_RIFTS.includes(rift.id)) {
      console.log(`[SUPABASE] ⚠️ Skipping blacklisted rift ${rift.id}`);
      continue;
    }

    try {
      // 🔍 PRESERVE EXISTING DATA: Fetch existing rift from database to preserve ALL existing raw_data
      let existingRawData: Record<string, any> = {};
      try {
        console.log(`[DATA-PRESERVE] Fetching existing data for ${rift.id}...`);
        const { data: existingRift, error: fetchError } = await supabase
          .from('rifts')
          .select('raw_data')
          .eq('id', rift.id)
          .single();

        if (fetchError) {
          console.log(`[DATA-PRESERVE] No existing rift found (${fetchError.message})`);
        } else if (existingRift?.raw_data) {
          // 🔒 PRESERVE ENTIRE raw_data - this is critical to not lose manually added fields
          existingRawData = existingRift.raw_data;
          console.log(`[DATA-PRESERVE] Found existing data with ${Object.keys(existingRawData).length} fields: hasMeteoraPool=${existingRawData.hasMeteoraPool}, liquidityPool=${existingRawData.liquidityPool}, meteoraPools=${JSON.stringify(existingRawData.meteoraPools)}, prefixType=${existingRawData.prefixType}, symbol=${existingRawData.symbol}`);
        } else {
          console.log(`[DATA-PRESERVE] Existing rift has no raw_data`);
        }
      } catch (fetchError) {
        console.log(`[POOL-PRESERVE] Exception: ${fetchError instanceof Error ? fetchError.message : fetchError}`);
        // Rift doesn't exist yet in database, continue with new data
      }

      // Get token price from TVL and total minted
      const tokenPrice = rift.tvl / (rift.totalRiftMinted || 1);

      // Calculate INDIVIDUAL APY for this rift (V1 rift always 0%)
      const isV1Rift = rift.id === V1_RIFT_ADDRESS;
      const riftTvl = rift.tvl || 0;
      const riftVolume24h = rift.volume24h || 0;
      const estimatedFees = riftVolume24h * 0.007; // 0.7% fee rate
      const rawAPY = riftTvl > 0 ? (estimatedFees / riftTvl) * 365 * 100 : 0;
      let individualAPY = isV1Rift ? 0 : rawAPY; // V1 rift excluded from APY (mutable for monorift recalc)

      // Calculate USD value of fees collected using underlying token price
      // totalFeesCollected is already in tokens (converted from BigInt earlier)
      // underlyingTokenPrice is stored in the rift object
      const feesInTokens = Number(rift.totalFeesCollected) || 0;
      const feesCollectedUSD = feesInTokens * (rift.underlyingTokenPrice || 0);

      console.log('  💵 Fees breakdown:', {
        feesInTokens: feesInTokens.toLocaleString(),
        price: rift.underlyingTokenPrice || 0,
        totalUSD: feesCollectedUSD.toLocaleString()
      });

      // 🔄 MERGE PRESERVED DATA: Start with existing raw_data, then overlay blockchain data
      // This ensures we don't lose any manually added fields (pools, symbols, etc.)

      // 🔒 Preserve symbol with prefix from existing data (prevents blockchain overwriting monorift symbols)
      const existingSymbol = existingRawData.symbol || '';
      const preserveSymbol = existingSymbol.startsWith('r') || existingSymbol.startsWith('m');

      // 🔒 For monorifts (DLMM single-sided), calculate TVL from pool reserves (not vault)
      // Monorifts don't have vaults - their TVL comes from DLMM pool reserves
      const isMonorift = existingRawData.prefixType === 1 || existingRawData.strategy === 'DLMM' || (existingSymbol && existingSymbol.startsWith('m')) || rift.prefixType === 1 || (rift.symbol && rift.symbol.toLowerCase().startsWith('m'));

      // Debug: Log monorift detection
      if (rift.prefixType === 1 || (rift.symbol && rift.symbol.toLowerCase().startsWith('m'))) {
        console.log(`  🔍 Monorift detection for ${rift.symbol}: isMonorift=${isMonorift}, rift.prefixType=${rift.prefixType}, existingRawData.prefixType=${existingRawData.prefixType}, rift.symbol=${rift.symbol}`);
      }

      // 🔧 POOL TYPE VALIDATION: Use fresh blockchain-detected pools, with fallback to existing data
      // For monorifts, preserve existing pool data if fresh detection fails (DLMM detection can be flaky)
      // For regular rifts, only use existing pools if fresh detection didn't explicitly find none
      const shouldPreserveExistingPool = isMonorift || (rift.hasMeteoraPool !== false);
      const poolAddress = rift.liquidityPool ||
                         (shouldPreserveExistingPool ? existingRawData.liquidityPool : undefined) ||
                         (shouldPreserveExistingPool ? existingRawData.meteoraPool : undefined) ||
                         (shouldPreserveExistingPool ? (existingRawData.meteoraPools && existingRawData.meteoraPools[0]) : undefined);
      const poolsArray = rift.meteoraPools ||
                        (shouldPreserveExistingPool ? existingRawData.meteoraPools : undefined) ||
                        (poolAddress ? [poolAddress] : undefined);

      // 🔒 Fix symbol for monorifts that were saved without 'm' prefix
      // If prefixType is 1 (monorift) but symbol doesn't start with 'm', add the prefix
      let correctedSymbol = rift.symbol;
      if (isMonorift && !rift.symbol.toLowerCase().startsWith('m')) {
        correctedSymbol = `m${rift.symbol.replace(/^r/i, '')}`;
        console.log(`  🔧 Correcting monorift symbol: ${rift.symbol} → ${correctedSymbol}`);
      }

      // Calculate TVL for monorifts: wrapped tokens × underlying price
      let monoriftTvl = 0;
      if (isMonorift) {
        // For monorifts, use totalRiftMinted since they don't have a vault
        // Monorifts are 1:1 with underlying token, so TVL = totalRiftMinted × underlyingPrice
        const vaultBalance = rift.vaultBalance || existingRawData.vaultBalance || 0;
        const totalMinted = rift.totalRiftMinted || existingRawData.totalRiftMinted || 0;
        const tokensForTvl = totalMinted > 0 ? totalMinted : vaultBalance; // Prefer totalMinted for monorifts
        const underlyingMint = rift.underlyingMint || existingRawData.underlyingMint;
        let underlyingPrice = rift.underlyingTokenPrice || existingRawData.underlyingTokenPrice || 0;

        // Fetch underlying price from DexScreener if not available
        if (underlyingMint) {
          if (underlyingPrice === 0) {
            try {
              console.log(`  🔍 Fetching DexScreener price for monorift ${rift.symbol}, underlyingMint: ${underlyingMint}`);
              const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${underlyingMint}`);
              const dexData = await dexRes.json();
              const pairs = dexData.pairs || [];

              if (pairs.length > 0) {
                underlyingPrice = parseFloat(pairs[0]?.priceUsd || '0');
                console.log(`  📡 DexScreener: got price $${underlyingPrice} from ${pairs.length} pairs`);
              }
            } catch (e) {
              console.log(`  ❌ DexScreener fetch error for ${rift.symbol}:`, e instanceof Error ? e.message : e);
            }
          }
        } else {
          console.log(`  ⚠️ No underlyingMint for monorift ${rift.symbol}`);
        }

        // TVL = tokens (minted or vault) × underlying price
        monoriftTvl = tokensForTvl * underlyingPrice;

        console.log(`  💎 Monorift ${rift.symbol}: ${tokensForTvl.toLocaleString()} tokens (minted=${totalMinted.toLocaleString()}, vault=${vaultBalance.toLocaleString()}) × $${underlyingPrice} = $${monoriftTvl.toFixed(2)} TVL`);
      }

      // Use calculated monorift TVL for monorifts, or regular rift.tvl for normal rifts
      // For monorifts: Use freshly calculated TVL if available, otherwise preserve database value
      // For regular rifts: use blockchain-calculated TVL
      let finalTvl: number;
      if (isMonorift) {
        // If we calculated a valid TVL, use it; otherwise fall back to database value
        if (monoriftTvl > 0) {
          finalTvl = monoriftTvl;
        } else if (existingRawData.tvl && existingRawData.tvl > 0) {
          finalTvl = existingRawData.tvl;
          console.log(`  🔒 Preserving existing TVL for monorift ${rift.symbol}: $${finalTvl.toLocaleString()} (recalc returned 0)`);
        } else {
          finalTvl = 0;
        }
      } else {
        finalTvl = rift.tvl;
      }

      // 🔧 MONORIFT APY: Use ONLY vault transaction volume (wrap/unwrap), NOT DEX volume
      // Monorifts with no wrap/unwrap activity = 0 APY (correct behavior)
      if (isMonorift && !isV1Rift) {
        if (finalTvl > 0) {
          // Use ONLY vault transaction volume for APY calculation (no DEX volume fallback)
          const volumeForApy = riftVolume24h; // Only real wrap/unwrap volume from Helius
          const monoriftEstimatedFees = volumeForApy * 0.007; // 0.7% fee rate
          individualAPY = (monoriftEstimatedFees / finalTvl) * 365 * 100;
          console.log(`  📈 Monorift ${rift.symbol} APY: vault_volume=$${volumeForApy.toLocaleString()}, TVL=$${finalTvl.toFixed(2)}, APY=${individualAPY.toFixed(2)}%`);
        } else if (rift.apy && rift.apy > 0) {
          // Use APY from blockchain parsing
          individualAPY = rift.apy;
          console.log(`  🔒 Monorift ${rift.symbol} APY: Using blockchain APY=${individualAPY.toFixed(2)}% (TVL=0)`);
        } else if (existingRawData.apy && existingRawData.apy > 0) {
          // Preserve existing APY from database when we can't recalculate
          individualAPY = existingRawData.apy;
          console.log(`  🔒 Monorift ${rift.symbol} APY: Preserving existing APY=${individualAPY.toFixed(2)}% (TVL=0, can't recalculate)`);
        } else {
          console.log(`  ⚠️ Monorift ${rift.symbol} APY: Cannot calculate (TVL=0, no existing APY)`);
        }
      }

      const finalVaultBalance = rift.vaultBalance || existingRawData.vaultBalance || 0;

      // For monorifts, use underlying price (1:1); otherwise use existing or rift price
      const finalUnderlyingPrice = rift.underlyingTokenPrice || existingRawData.underlyingTokenPrice || 0;
      const finalRiftPrice = isMonorift
        ? finalUnderlyingPrice  // Monorifts have 1:1 price with underlying
        : (rift.riftTokenPrice || existingRawData.riftTokenPrice || 0);

      // 🔍 AUTO-DETECT POOL TYPE from blockchain if not set
      let detectedPoolType = existingRawData.poolType || rift.poolType;
      if (!detectedPoolType && poolAddress) {
        try {
          const DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
          const CPAMM_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';

          const poolAccountInfo = await connection.getAccountInfo(new PublicKey(poolAddress));
          if (poolAccountInfo) {
            const ownerStr = poolAccountInfo.owner.toBase58();
            if (ownerStr === DLMM_PROGRAM) {
              detectedPoolType = 'dlmm';
              console.log(`  🔍 Auto-detected DLMM pool for ${rift.symbol}`);
            } else if (ownerStr === CPAMM_PROGRAM) {
              detectedPoolType = 'dammv2';
              console.log(`  🔍 Auto-detected DAMMV2 pool for ${rift.symbol}`);
            }
          }
        } catch (detectErr) {
          console.log(`  ⚠️ Could not detect pool type for ${rift.symbol}:`, detectErr instanceof Error ? detectErr.message : detectErr);
        }
      }
      // Default based on rift type if still not detected
      if (!detectedPoolType) {
        detectedPoolType = isMonorift ? 'dlmm' : 'dammv2';
      }

      const mergedRift = {
        // 1. Start with ALL existing raw_data fields (preserves everything)
        ...existingRawData,
        // 2. Overlay fresh blockchain data (updates dynamic values like TVL, prices)
        ...rift,
        // 3. Ensure pool data is preserved/merged correctly
        // 🔧 FIX: Only set pool fields if we have a value, otherwise preserve existing
        hasMeteoraPool: rift.hasMeteoraPool || existingRawData.hasMeteoraPool || !!poolAddress,
        liquidityPool: poolAddress || existingRawData.liquidityPool,
        meteoraPool: poolAddress || existingRawData.meteoraPool,
        meteoraPools: (poolsArray && poolsArray.length > 0) ? poolsArray : existingRawData.meteoraPools,
        // 4. 🔒 PRESERVE MONORIFT DATA: Override blockchain data with preserved symbol/prefixType for monorifts
        // For monorifts without 'm' prefix, use correctedSymbol; otherwise preserve existing or use blockchain symbol
        symbol: preserveSymbol ? existingSymbol : correctedSymbol,
        // IMPORTANT: Fresh blockchain-detected prefixType takes priority over cached data
        // This ensures MONORIFT_OVERRIDES corrections are applied even if cached with wrong prefixType
        prefixType: rift.prefixType !== undefined ? rift.prefixType : existingRawData.prefixType,
        // 5. 🔒 MONORIFT TVL: Use calculated TVL from pool reserves or preserve existing
        tvl: finalTvl,
        vaultBalance: finalVaultBalance,
        // 6. 🔒 MONORIFT PRICES: Use calculated prices for monorifts
        underlyingTokenPrice: finalUnderlyingPrice,
        riftTokenPrice: finalRiftPrice,
        // 7. 🔒 POOL TYPE: Use fresh blockchain-detected poolType, fallback to existing
        poolType: rift.poolType || existingRawData.poolType || 'dammv2',
        // 8. 🔧 VOLUME: Use fresh vault transaction volume (from Helius) - NOT stale DB data
        // For both regular rifts and monorifts, prefer fresh blockchain volume over stale Supabase data
        volume24h: rift.volume24h || 0,
        // 9. 🔧 APY: Use recalculated individualAPY (not the blockchain fetch APY)
        apy: individualAPY
      };

      // Log pool detection/update status
      const finalPoolAddress = mergedRift.liquidityPool;
      if (rift.liquidityPool && existingRawData.liquidityPool && rift.liquidityPool !== existingRawData.liquidityPool) {
        console.log(`  🔄 Updated pool for ${rift.symbol}: ${existingRawData.liquidityPool} → ${rift.liquidityPool}`);
      } else if (rift.liquidityPool && !existingRawData.liquidityPool) {
        console.log(`  ✨ New pool detected for ${rift.symbol}: ${rift.liquidityPool}`);
      } else if (!rift.liquidityPool && existingRawData.liquidityPool) {
        // Fresh data has no pool but existing data does - preserved!
        console.log(`  ℹ️ PRESERVED existing pool for ${rift.symbol}: ${existingRawData.liquidityPool}`);
      } else if (!rift.liquidityPool && !existingRawData.liquidityPool && poolAddress) {
        console.log(`  ℹ️ Using fallback pool for ${rift.symbol}: ${poolAddress}`);
      }

      // 🚨 CRITICAL WARNING: Monorifts should always have a pool
      if (isMonorift && !finalPoolAddress) {
        console.log(`  🚨 WARNING: Monorift ${rift.symbol} (${rift.id}) has NO POOL! Fresh detection: ${rift.liquidityPool}, Existing: ${existingRawData.liquidityPool}, rift.hasMeteoraPool: ${rift.hasMeteoraPool}`);
      }

      // Prepare rift data matching Supabase schema with ALL required fields
      // Determine program_id based on whether this is a v1 or v2 rift
      const programId = rift.id === V1_RIFT_ADDRESS ? RIFTS_V1_PROGRAM_ID.toBase58() : RIFTS_PROGRAM_ID.toBase58();

      const riftData = {
        id: rift.id,
        name: mergedRift.symbol,
        token_mint: rift.riftMint,
        token_symbol: mergedRift.symbol,
        token_decimals: 9, // Default decimals
        program_id: programId,
        is_deprecated: false,
        is_open: true,
        total_tokens_wrapped: rift.totalRiftMinted || 0,
        total_fees_collected: feesCollectedUSD, // REAL on-chain fees in USD!
        entry_price: tokenPrice || 0,
        current_price: tokenPrice || 0,
        price_change_24h: 0,
        // Use fresh vault transaction volume (from Helius) - NOT stale DB data
        volume_24h: rift.volume24h || 0,
        total_participants: rift.participants || 0,
        vault_balance: rift.totalRiftMinted || 0,
        apy: individualAPY, // REAL calculated APY!
        raw_data: mergedRift, // ✅ Use merged data with preserved pools
        updated_at: new Date().toISOString()
      };

      // 🔧 DEBUG: Log what's being saved for monorifts
      if (isMonorift && (rift.id === 'HbFjxB41Ty17XSeAZqf6LYoUTrr75rJ5utFnCfGQUYNU' || rift.id === '6M6eZPMBGr59Rqd1exwJ9ZV2uk1ZcFWGcUtLnFhhZHqE')) {
        console.log(`  🔍 DEBUG mergedRift for ${rift.symbol} (${rift.id.slice(0,8)}):`, JSON.stringify({
          apy: mergedRift.apy,
          tvl: mergedRift.tvl,
          volume24h: mergedRift.volume24h,
          totalRiftMinted: mergedRift.totalRiftMinted,
          liquidityPool: mergedRift.liquidityPool,
          hasMeteoraPool: mergedRift.hasMeteoraPool,
          riftFromBlockchain: {
            apy: rift.apy,
            totalRiftMinted: rift.totalRiftMinted,
            liquidityPool: rift.liquidityPool
          },
          existingFromDb: {
            apy: existingRawData.apy,
            totalRiftMinted: existingRawData.totalRiftMinted,
            liquidityPool: existingRawData.liquidityPool
          },
          individualAPY: individualAPY
        }, null, 2));
      }

      // 🔧 UPDATE ORIGINAL RIFT: Copy calculated values back to the original rift object
      // This ensures the API returns the correct APY, TVL, volume, and POOL DATA (not just stores them in DB)
      rift.apy = individualAPY;
      rift.tvl = finalTvl;
      // 🔧 FIX: Use ONLY vault transaction volume (from Helius) - NO DEX volume fallback
      // Monorifts with no wrap/unwrap activity = 0 volume (correct behavior)
      rift.volume24h = rift.volume24h || 0;
      rift.vaultBalance = finalVaultBalance;
      rift.underlyingTokenPrice = finalUnderlyingPrice;
      rift.riftTokenPrice = finalRiftPrice;
      // 🔧 CRITICAL: Also update pool data on the rift object so API returns correct pool info
      rift.hasMeteoraPool = mergedRift.hasMeteoraPool;
      rift.liquidityPool = mergedRift.liquidityPool;
      rift.meteoraPools = mergedRift.meteoraPools;
      rift.poolType = mergedRift.poolType;

      // Upsert (insert or update)
      const { error } = await supabase
        .from('rifts')
        .upsert(riftData, {
          onConflict: 'id'
        });

      if (error) {
        console.error(`[SUPABASE] Error upserting ${rift.id}:`, error.message);
      } else {
        const priceInfo = isMonorift ? ` Price: $${finalUnderlyingPrice.toFixed(6)}` : '';
        console.log(`[SUPABASE] ✅ Updated ${rift.symbol} (${rift.id.slice(0, 8)}...) TVL: $${finalTvl.toLocaleString()}${priceInfo} APY: ${individualAPY.toFixed(2)}%`);
      }
    } catch (error) {
      console.error(`[SUPABASE] Error processing ${rift.id}:`, error instanceof Error ? error.message : error);
    }
  }

  console.log(`[SUPABASE] ✅ Supabase cache updated`);
}

/**
 * Fetch rifts from blockchain
 */
async function fetchRiftsFromBlockchain() {
  const startTime = Date.now();

  // Get lazy-initialized runtime values
  const { connection, PublicKey, RIFTS_PROGRAM_ID, RIFTS_V1_PROGRAM_ID, RPC_URL } = await getRuntime();

  try {
    console.log('🔍 [FETCH-RIFTS] Starting blockchain fetch...');

    // Get all rift accounts from the program
    // Get all accounts - we'll filter by size in code to support both old (952) and new (984) formats
    console.log('[FETCH-RIFTS] Step 1/4: Fetching program accounts...');
    let accounts = await connection.getProgramAccounts(RIFTS_PROGRAM_ID, {
      commitment: 'confirmed'
    });
    console.log(`[FETCH-RIFTS] ✅ Step 1/4 complete: Found ${accounts.length} total accounts (+${Date.now() - startTime}ms)`);

    // Manually fetch the specific V1 Rift and add it to accounts
    try {
      console.log(`[V1-RIFT] Fetching V1 Rift: ${V1_RIFT_ADDRESS}`);
      const v1RiftPubkey = new PublicKey(V1_RIFT_ADDRESS);
      const v1RiftAccount = await connection.getAccountInfo(v1RiftPubkey, 'confirmed');

      if (v1RiftAccount && v1RiftAccount.owner.equals(RIFTS_V1_PROGRAM_ID)) {
        console.log(`[V1-RIFT] ✅ Found V1 Rift account, size: ${v1RiftAccount.data.length}`);
        // Add V1 rift to accounts array
        accounts = [
          ...accounts,
          {
            pubkey: v1RiftPubkey,
            account: v1RiftAccount
          }
        ];
        console.log(`[V1-RIFT] ✅ Added V1 Rift to accounts list, total: ${accounts.length}`);
      } else {
        console.log(`[V1-RIFT] ⚠️ V1 Rift account not found or wrong owner`);
      }
    } catch (v1Error) {
      console.error(`[V1-RIFT] ❌ Error fetching V1 Rift:`, v1Error);
    }

    console.log(`📊 Server: Found ${accounts.length} total accounts`);

    // Filter for valid rift accounts (782 bytes current format with wrap/unwrap fees, 952/984 bytes old formats)
    const validRiftAccounts = accounts.filter((acc: any) => {
      const address = acc.pubkey.toBase58();

      // ALWAYS include V1 Rift, regardless of size
      if (address === V1_RIFT_ADDRESS) {
        console.log('[FILTER] ✅ ALWAYS INCLUDING V1 RIFT:', address, 'size:', acc.account.data.length);
        return true;
      }

      const size = acc.account.data.length;
      return size === 782 || size === 952 || size === 984;
    });

    console.log(`📊 Server: Filtered to ${validRiftAccounts.length} valid rift accounts (782, 952 or 984 bytes)`);

    // Filter out blacklisted rifts EARLY - before processing
    const nonBlacklistedAccounts = validRiftAccounts.filter((acc: any) => {
      const address = acc.pubkey.toBase58();

      // ALWAYS include V1 Rift, even if somehow blacklisted
      if (address === V1_RIFT_ADDRESS) {
        console.log('[FILTER] ✅ ALWAYS INCLUDING V1 RIFT (skipping blacklist check)');
        return true;
      }

      const isBlacklisted = BLACKLISTED_RIFTS.includes(address);
      if (isBlacklisted) {
        console.log(`🚫 [FETCH-RIFTS] Skipping blacklisted rift: ${address}`);
      }
      return !isBlacklisted;
    });

    const earlyFilteredCount = validRiftAccounts.length - nonBlacklistedAccounts.length;
    if (earlyFilteredCount > 0) {
      console.log(`🚫 [FETCH-RIFTS] Filtered out ${earlyFilteredCount} blacklisted rift(s) before processing`);
    }

    // Meteora CP-AMM (Constant Product AMM) - used by some pools
    const METEORA_CP_AMM_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
    // Meteora DLMM (Dynamic Liquidity Market Maker) - used by most modern pools
    const METEORA_DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

    // 🔍 FETCH DLMM POOLS using Helius getProgramAccountsV2 with memcmp filters
    // This is MUCH faster than fetching all 124k pools - only queries pools for our rift tokens
    console.log('[FETCH-RIFTS] Step 2/4: Loading DLMM pools via getProgramAccountsV2...');
    const dlmmCacheAge = Date.now() - lastDlmmFetchTime;
    let dlmmPoolsByMint = cachedDlmmPoolsByMint;

    // First, extract all unique rift token mints from the accounts we're processing
    const uniqueRiftMints = new Set<string>();
    for (const account of nonBlacklistedAccounts) {
      try {
        // rift_mint is at offset 104 (32 bytes)
        // Handle both Buffer and Uint8Array data types
        const data = Buffer.isBuffer(account.account.data)
          ? account.account.data
          : Buffer.from(account.account.data);
        const riftMint = new PublicKey(data.slice(104, 136));
        uniqueRiftMints.add(riftMint.toBase58());
      } catch (e) {
        console.log(`[FETCH-RIFTS] ⚠️ Failed to parse rift mint from account ${account.pubkey?.toBase58?.() || 'unknown'}:`, e);
      }
    }
    console.log(`[FETCH-RIFTS] 📊 Found ${uniqueRiftMints.size} unique rift token(s) to query for pools`);
    // Debug: log all mints being queried
    console.log(`[FETCH-RIFTS] 📋 Rift mints: ${Array.from(uniqueRiftMints).map(m => m.slice(0,8) + '...').join(', ')}`);

    // Check if any rift mints are missing from the cache (new rifts added)
    const missingMints = Array.from(uniqueRiftMints).filter(mint => !cachedDlmmPoolsByMint.has(mint));
    const hasMissingMints = missingMints.length > 0;

    if (cachedDlmmPoolsByMint.size === 0 || dlmmCacheAge > DLMM_CACHE_DURATION || hasMissingMints) {
      const reason = cachedDlmmPoolsByMint.size === 0 ? 'empty' : hasMissingMints ? `missing ${missingMints.length} mint(s)` : 'expired';
      console.log(`[FETCH-RIFTS] 🔄 DLMM cache ${reason} (age: ${Math.round(dlmmCacheAge / 1000)}s), fetching fresh...`);
      if (hasMissingMints) {
        console.log(`[FETCH-RIFTS] 📋 Missing mints: ${missingMints.map(m => m.slice(0,8) + '...').join(', ')}`);
      }

      try {
        // Use getProgramAccountsV2 with memcmp filters for each rift mint
        const newDlmmMap = await fetchDlmmPoolsForMints(RPC_URL, Array.from(uniqueRiftMints));

        // Update cache
        cachedDlmmPoolsByMint = newDlmmMap;
        lastDlmmFetchTime = Date.now();
        dlmmPoolsByMint = newDlmmMap;

        console.log(`[FETCH-RIFTS] ✅ Built DLMM lookup map with ${newDlmmMap.size} mints (cached for 10 min)`);
      } catch (dlmmFetchError) {
        console.log(`[FETCH-RIFTS] ⚠️ DLMM V2 fetch failed:`, dlmmFetchError instanceof Error ? dlmmFetchError.message : dlmmFetchError);
        // Use stale cache if available
        if (cachedDlmmPoolsByMint.size > 0) {
          console.log(`[FETCH-RIFTS] ℹ️ Using stale DLMM cache (${cachedDlmmPoolsByMint.size} mints)`);
          dlmmPoolsByMint = cachedDlmmPoolsByMint;
        }
      }
    } else {
      console.log(`[FETCH-RIFTS] ✅ Using cached DLMM pools (${cachedDlmmPoolsByMint.size} mints, age: ${Math.round(dlmmCacheAge / 1000)}s)`);
    }

    console.log(`[FETCH-RIFTS] ✅ Step 2/4 complete: DLMM pools loaded (+${Date.now() - startTime}ms)`);

    console.log('[FETCH-RIFTS] Step 3/4: Pre-fetching vault accounts...');
    // 🚀 OPTIMIZED: Batch fetch all vault accounts before processing
    const allVaultPubkeys = nonBlacklistedAccounts.map((account: any) => {
      const data = account.account.data;
      return new PublicKey(data.slice(136, 168)); // Vault at offset 136
    });
    console.log(`[FETCH-RIFTS] 🚀 Batch fetching ${allVaultPubkeys.length} vault accounts...`);
    const allVaultAccountsInfo = await connection.getMultipleAccountsInfo(allVaultPubkeys);
    console.log(`[FETCH-RIFTS] ✅ Fetched ${allVaultAccountsInfo.length} vault accounts in 1 batch call`);

    // Create a lookup map for quick access
    const vaultDataMap = new Map<string, any>();
    for (let i = 0; i < allVaultPubkeys.length; i++) {
      vaultDataMap.set(allVaultPubkeys[i].toBase58(), allVaultAccountsInfo[i]);
    }

    console.log('[FETCH-RIFTS] Step 4/4: Processing rift accounts...');
    const rifts = await Promise.all(nonBlacklistedAccounts.map(async (account: any, index: number) => {
      const data = account.account.data;

      // CRITICAL: Must fetch actual decimals from blockchain, NO DEFAULTS
      let underlyingDecimals: number | null = null;

      try {
        console.log(`[FETCH-RIFTS] Processing rift ${index + 1}/${nonBlacklistedAccounts.length}: ${account.pubkey.toBase58()}`);

      // Parse rift data based on actual Rust struct layout:
      // discriminator(8) + name[32](32) + creator(32) + underlying_mint(32) + rift_mint(32) + vault(32) + burn_fee_bps(2) + partner_fee_bps(2) + partner_wallet(Option<Pubkey>=33) + total_underlying_wrapped(8) + total_rift_minted(8)...

      // Read name field (32 bytes at offset 8) - this is the rift account name, NOT the token metadata name
      const nameBytes = data.slice(8, 40);
      let riftName = nameBytes.toString('utf8').replace(/\0/g, '').trim();

      // Read creator (32 bytes at offset 40)
      const creator = new PublicKey(data.slice(40, 72));

      // Read underlying_mint (32 bytes at offset 72)
      const underlyingMint = new PublicKey(data.slice(72, 104));

      // Read rift_mint (32 bytes at offset 104)
      const riftMint = new PublicKey(data.slice(104, 136));

      // Read vault (32 bytes at offset 136)
      const vault = new PublicKey(data.slice(136, 168));

      console.log('  Name:', riftName);
      console.log('  Underlying mint:', underlyingMint.toBase58());
      console.log('  Rift mint:', riftMint.toBase58());
      console.log('  Vault:', vault.toBase58());

      // 🔒 OPTIMIZATION: Check cache for static mint data first (decimals never change)
      let riftDecimals: number | null = null;
      let transferFeeBps: number | null = null;
      const cachedMintData = await getCachedMintData(account.pubkey.toBase58());

      if (cachedMintData) {
        // Use cached values - saves 2-3 RPC calls per rift!
        underlyingDecimals = cachedMintData.underlyingDecimals;
        riftDecimals = cachedMintData.riftDecimals;
        transferFeeBps = cachedMintData.transferFeeBps;
        console.log(`  ⚡ Using cached mint data: underlying=${underlyingDecimals}, rift=${riftDecimals}, fee=${transferFeeBps ?? 'none'}`);
      } else {
        // No cache - fetch from RPC and it will be cached after
        console.log('  📡 No cached mint data, fetching from RPC...');

        // 🔒 CRITICAL: Fetch underlying token decimals FIRST (before vault balance)
        try {
          console.log('  Fetching underlying token decimals from mint...');
          const underlyingMintInfo = await connection.getAccountInfo(underlyingMint);
          if (underlyingMintInfo && underlyingMintInfo.data.length >= 45) {
            underlyingDecimals = underlyingMintInfo.data[44]; // Decimals at offset 44 in SPL mint
            console.log(`  ✅ Underlying token decimals: ${underlyingDecimals}`);
          } else {
            console.error(`  ❌ Failed to fetch mint info for ${underlyingMint.toBase58()}`);
            throw new Error(`Could not fetch decimals for underlying mint ${underlyingMint.toBase58()}`);
          }
        } catch (error) {
          console.error('  ❌ CRITICAL ERROR fetching underlying decimals:', error instanceof Error ? error.message : error);
          console.error(`  ⚠️ Skipping rift ${account.pubkey.toBase58()} - cannot determine accurate decimals`);
          return null;
        }

        // 🔒 CRITICAL: Also fetch rift token decimals (used for unwrap calculations)
        try {
          console.log('  Fetching rift token decimals and transfer fee from mint...');

          const { getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getTokenMetadata } = await import('@solana/spl-token');
          const { getTransferFeeConfig } = await import('@solana/spl-token');

          let mintInfo = null;
          let isToken2022 = false;
          try {
            mintInfo = await getMint(connection, riftMint, 'confirmed', TOKEN_2022_PROGRAM_ID);
            isToken2022 = true;
            console.log(`  ✅ Fetched as Token-2022 mint`);
          } catch (token2022Error) {
            console.log(`  ⚠️ Not a Token-2022 mint, trying regular SPL Token...`);
            try {
              mintInfo = await getMint(connection, riftMint, 'confirmed', TOKEN_PROGRAM_ID);
              console.log(`  ✅ Fetched as regular SPL Token mint`);
            } catch (splTokenError) {
              console.error(`  ❌ Failed to fetch mint info for ${riftMint.toBase58()}`);
              throw new Error(`Could not fetch decimals for rift mint ${riftMint.toBase58()}`);
            }
          }

          if (mintInfo) {
            riftDecimals = mintInfo.decimals;
            console.log(`  ✅ Rift token decimals: ${riftDecimals}`);

            // 🔒 LONG-TERM FIX: Fetch token metadata name (the REAL name, not rift account name)
            // Token-2022 metadata has the correct name (e.g., "mRIFTS") even if rift account has wrong name
            if (isToken2022) {
              try {
                const tokenMetadata = await getTokenMetadata(connection, riftMint, 'confirmed', TOKEN_2022_PROGRAM_ID);
                if (tokenMetadata?.name) {
                  const metadataName = tokenMetadata.name.replace(/\0/g, '').trim();
                  if (metadataName && metadataName !== riftName) {
                    console.log(`  🔧 TOKEN METADATA NAME: "${metadataName}" (rift account had "${riftName}")`);
                    riftName = metadataName; // Use the token metadata name instead
                  }
                }
              } catch (metadataErr) {
                console.log(`  ⚠️ Could not fetch token metadata:`, metadataErr instanceof Error ? metadataErr.message : metadataErr);
              }
            }

            try {
              const transferFeeConfig = getTransferFeeConfig(mintInfo);
              if (transferFeeConfig) {
                transferFeeBps = transferFeeConfig.newerTransferFee.transferFeeBasisPoints;
                console.log(`  ✅ Token-2022 transfer fee: ${transferFeeBps} bps (${transferFeeBps / 100}%)`);
              } else {
                console.log('  ⚠️ No transfer fee config found (regular SPL Token or V1 rift)');
              }
            } catch (feeError) {
              console.log('  ⚠️ No transfer fee extension (regular SPL Token)');
            }
          } else {
            throw new Error(`Could not fetch decimals for rift mint ${riftMint.toBase58()}`);
          }
        } catch (error) {
          console.error('  ❌ CRITICAL ERROR fetching rift decimals:', error instanceof Error ? error.message : error);
          console.error(`  ⚠️ Skipping rift ${account.pubkey.toBase58()} - cannot determine accurate rift decimals`);
          return null;
        }
      }

      // 🔒 ALWAYS fetch Token-2022 metadata name (even when using cached mint data)
      // This ensures monorift names like "mRIFTS10" are correctly detected even if
      // the on-chain rift account name doesn't have the 'm' prefix
      try {
        const { TOKEN_2022_PROGRAM_ID, getTokenMetadata } = await import('@solana/spl-token');
        try {
          const tokenMetadata = await getTokenMetadata(connection, riftMint, 'confirmed', TOKEN_2022_PROGRAM_ID);
          if (tokenMetadata?.name) {
            const metadataName = tokenMetadata.name.replace(/\0/g, '').trim();
            if (metadataName && metadataName !== riftName) {
              console.log(`  🔧 TOKEN METADATA NAME: "${metadataName}" (rift account had "${riftName}")`);
              riftName = metadataName; // Use the token metadata name instead
            }
          }
        } catch {
          // Token might not be Token-2022 or might not have metadata - that's OK
        }
      } catch {
        // Import failed - continue without metadata correction
      }

      // Fetch actual vault balance for real TVL
      let vaultBalance = 0;
      let vaultAccountData: Buffer | null = null;
      try {
        console.log('  Using pre-fetched vault account info...');
        const vaultAccountInfo = vaultDataMap.get(vault.toBase58());
        if (vaultAccountInfo) {
          // Save raw vault data for caching
          vaultAccountData = Buffer.from(vaultAccountInfo.data);

          // Parse token account to get balance
          const vaultBalanceLamports = vaultAccountInfo.data.readBigUInt64LE(64); // Token amount at offset 64
          console.log('  Raw vault balance:', vaultBalanceLamports.toString());

          vaultBalance = Number(vaultBalanceLamports) / Math.pow(10, underlyingDecimals!);
          console.log('  ✅ Vault balance:', vaultBalance.toLocaleString(), 'tokens (decimals:', underlyingDecimals + ')');
        } else {
          console.log('  ❌ Vault account not found!');
        }
      } catch (error) {
        console.log('  ❌ Error fetching vault balance:', error instanceof Error ? error.message : error);
      }

      // Get real-time UNDERLYING token price (SOL, USDC, etc.)
      // The vault holds the underlying tokens, not rift tokens!
      // Uses shared price cache to avoid duplicate API calls
      const mintAddress = underlyingMint.toBase58();
      let underlyingTokenPrice: number = 0;

      try {
        const { getCachedPrice } = await import('@/lib/server-price-cache');
        underlyingTokenPrice = await getCachedPrice(mintAddress);

        if (underlyingTokenPrice > 0) {
          console.log(`  ✅ Cached price for ${mintAddress.slice(0, 8)}...: $${underlyingTokenPrice}`);
        } else {
          console.log(`  ❌ No price data for underlying mint: ${mintAddress}`);
          console.log('  Skipping this rift (no price available)');
          return null;
        }
      } catch (error) {
        console.log('  ❌ Price fetch exception:', error instanceof Error ? error.message : error);
        console.log('  Skipping this rift');
        return null; // Skip this rift if no price available
      }

      // CORRECT Rust struct layout:
      // discriminator(8) + name[32](32) + creator(32) + underlying_mint(32) + rift_mint(32) + vault(32) + fees_vault(32) + withheld_vault(32)
      // = 8 + 32 + 32 + 32 + 32 + 32 + 32 + 32 = 232 bytes before partner_fee_bps

      // Read partner_fee_bps (2 bytes u16 at offset 232)
      const partnerFeeBps = data.readUInt16LE(232);

      // Parse partner_wallet (Option<Pubkey> at offset 234: 1 byte flag + 32 bytes)
      const hasPartnerWallet = data[234] === 1;
      const partnerWallet = hasPartnerWallet ? new PublicKey(data.slice(235, 267)).toBase58() : undefined;

      // Parse treasury_wallet (Option<Pubkey> at offset 267: 1 byte flag + 32 bytes)
      const hasTreasuryWallet = data[267] === 1;
      const treasuryWallet = hasTreasuryWallet ? new PublicKey(data.slice(268, 300)).toBase58() : undefined;

      // Read wrap_fee_bps (2 bytes u16 at offset 300)
      const wrapFeeBps = data.readUInt16LE(300);

      // Read unwrap_fee_bps (2 bytes u16 at offset 302)
      const unwrapFeeBps = data.readUInt16LE(302);

      // Read total_underlying_wrapped (8 bytes u64 at offset 304)
      const totalUnderlyingWrapped = data.readBigUInt64LE(304);

      // Read total_rift_minted (8 bytes u64 at offset 312)
      const totalRiftMinted = data.readBigUInt64LE(312);

      // Calculate backing ratio (needed for rift token price)
      const backingRatio = totalRiftMinted > BigInt(0)
        ? Number(totalUnderlyingWrapped) / Number(totalRiftMinted)
        : 1.0;

      // Calculate rift token price = underlying price * backing ratio
      const riftTokenPrice = underlyingTokenPrice * backingRatio;

      // Calculate TVL using vaultBalance (actual tokens held in vault)
      // totalUnderlyingWrapped can be corrupted/inflated on-chain (e.g. CuyPWo... shows 4.7T wrapped but vault is empty)
      // vaultBalance represents the REAL tokens - this is the true TVL source
      const tvl = vaultBalance * underlyingTokenPrice;
      const totalWrappedTokens = Number(totalUnderlyingWrapped) / Math.pow(10, underlyingDecimals!);
      console.log('  💰 TVL = ' + vaultBalance.toLocaleString() + ' vault × $' + underlyingTokenPrice + ' = $' + tvl.toLocaleString());
      if (Math.abs(totalWrappedTokens - vaultBalance) > vaultBalance * 0.01 && vaultBalance > 0) {
        console.log('  ⚠️ totalUnderlyingWrapped (' + totalWrappedTokens.toLocaleString() + ') differs from vault balance');
      }
      console.log('  🪙 Rift token price = $' + underlyingTokenPrice + ' × ' + backingRatio.toFixed(4) + ' = $' + riftTokenPrice.toFixed(4));
      console.log('');

      // Read created_at (8 bytes i64 at offset 344)
      // Offset calculation: 8 (discriminator) + 32 (name) + 32 (creator) + 32 (underlying_mint) + 32 (rift_mint) + 32 (vault) + 32 (fees_vault) + 32 (withheld_vault) + 2 (partner_fee_bps) + 33 (partner_wallet) + 33 (treasury_wallet) + 2 (wrap_fee_bps) + 2 (unwrap_fee_bps) + 8 (total_underlying_wrapped) + 8 (total_rift_minted) + 8 (total_burned) + 8 (backing_ratio) + 8 (last_rebalance) = 344
      let createdAt: Date;
      try {
        const createdAtTimestamp = data.readBigInt64LE(344);
        // Validate timestamp and convert to Date (handle 0 or invalid values)
        if (createdAtTimestamp > BigInt(0) && createdAtTimestamp < BigInt(Date.now() / 1000) * BigInt(2)) {
          createdAt = new Date(Number(createdAtTimestamp) * 1000);
        } else {
          createdAt = new Date(); // Use current date if timestamp is invalid
        }
      } catch {
        createdAt = new Date(); // Use current date if parsing fails
      }

      // Calculate REAL fees collected as vault_balance - backing_needed
      // The on-chain total_fees_collected field is incomplete (only tracks unwrap fees, not wrap fees)
      // REAL fees = vault_balance - total_underlying_wrapped
      // Store as number in tokens (not BigInt in lamports) for JSON serialization
      let totalFeesCollected = 0;
      try {
        const vaultBalanceLamports = vaultBalance * Math.pow(10, underlyingDecimals ?? 9);
        const feesCollectedLamports = vaultBalanceLamports - Number(totalUnderlyingWrapped);

        if (feesCollectedLamports > 0) {
          // Convert to tokens immediately (not lamports)
          totalFeesCollected = feesCollectedLamports / Math.pow(10, underlyingDecimals ?? 9);
          const feesInUSD = totalFeesCollected * underlyingTokenPrice;
          console.log('  💵 Total fees collected: ' + totalFeesCollected.toLocaleString() + ' tokens ($' + feesInUSD.toLocaleString() + ')');
        }
      } catch (err) {
        console.log('  ⚠️ Could not calculate total_fees_collected:', err instanceof Error ? err.message : err);
      }

      // Fetch REAL 24h volume and participants using Helius Enhanced Transactions API
      // This properly parses versioned transactions with Address Lookup Tables
      // 🔧 FIX: Paginated fetching with Supabase cache to get ALL 24h transactions
      let volume24h = 0;
      let participants = 0;
      try {
        const oneDayAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
        const uniqueUsers = new Set<string>();
        const vaultAddress = vault.toBase58();

        // Extract Helius API key from RPC URL
        const heliusApiKey = RPC_URL.match(/api-key=([a-f0-9-]+)/)?.[1];
        if (!heliusApiKey) {
          console.log('  ⚠️ No Helius API key found, falling back to basic volume calc');
          throw new Error('No Helius API key');
        }

        // 1. First check Supabase cache for recent transactions (avoid re-fetching)
        let cachedSignatures = new Set<string>();
        let cachedVolume = 0;
        let cachedParticipants = new Set<string>();

        try {
          const { data: cachedTxs } = await supabase
            .from('vault_transactions_cache')
            .select('signature, volume_usd, fee_payer, timestamp')
            .eq('vault_address', vaultAddress)
            .gte('timestamp', oneDayAgo);

          if (cachedTxs && cachedTxs.length > 0) {
            for (const tx of cachedTxs) {
              cachedSignatures.add(tx.signature);
              cachedVolume += tx.volume_usd || 0;
              if (tx.fee_payer) cachedParticipants.add(tx.fee_payer);
            }
            console.log(`  📦 Found ${cachedTxs.length} cached transactions (volume: $${cachedVolume.toFixed(2)})`);
          }
        } catch (cacheError) {
          console.log('  ⚠️ Cache check failed, fetching all:', cacheError instanceof Error ? cacheError.message : cacheError);
        }

        // 2. Paginated fetch from Helius - 100 txs at a time until we hit 24h boundary
        const underlyingMintStr = underlyingMint.toBase58();
        let txCount = 0;
        let txIn24h = 0;
        let cursor: string | undefined = undefined;
        let reachedEnd = false;
        let pageCount = 0;
        const maxPages = 20; // Safety limit: 20 pages × 100 = 2000 max transactions
        const newTransactions: any[] = [];

        while (!reachedEnd && pageCount < maxPages) {
          pageCount++;

          // Build URL with pagination cursor
          let heliusUrl = `https://api.helius.xyz/v0/addresses/${vaultAddress}/transactions?api-key=${heliusApiKey}&limit=100`;
          if (cursor) {
            heliusUrl += `&before=${cursor}`;
          }

          console.log(`  🔍 Fetching page ${pageCount} from Helius...`);

          const heliusResponse = await fetch(heliusUrl);
          if (!heliusResponse.ok) {
            throw new Error(`Helius API error: ${heliusResponse.status}`);
          }

          const transactions = await heliusResponse.json();
          if (!Array.isArray(transactions) || transactions.length === 0) {
            reachedEnd = true;
            break;
          }

          // Process transactions
          for (const tx of transactions) {
            const timestamp = tx.timestamp || 0;
            const signature = tx.signature;

            // Stop if we've gone past 24h
            if (timestamp < oneDayAgo) {
              reachedEnd = true;
              break;
            }

            // Skip if already in cache
            if (cachedSignatures.has(signature)) {
              continue;
            }

            txIn24h++;

            // Track unique users from fee payer
            const feePayer = tx.feePayer;
            if (feePayer) {
              uniqueUsers.add(feePayer);
            }

            // Find the largest underlying token transfer (represents wrap/unwrap volume)
            const tokenTransfers = tx.tokenTransfers || [];
            let maxTransfer = 0;

            for (const transfer of tokenTransfers) {
              if (transfer.mint === underlyingMintStr) {
                const amount = transfer.tokenAmount || 0;
                if (amount > maxTransfer) {
                  maxTransfer = amount;
                }
              }
            }

            if (maxTransfer > 0) {
              const volumeUsd = maxTransfer * underlyingTokenPrice;
              volume24h += volumeUsd;
              txCount++;

              // Save for caching
              newTransactions.push({
                signature,
                vault_address: vaultAddress,
                volume_usd: volumeUsd,
                fee_payer: feePayer,
                timestamp,
                underlying_amount: maxTransfer
              });
            }
          }

          // Set cursor for next page (last signature)
          if (transactions.length > 0 && !reachedEnd) {
            cursor = transactions[transactions.length - 1].signature;
          }
        }

        // 3. Cache new transactions to Supabase (fire-and-forget)
        if (newTransactions.length > 0) {
          supabase
            .from('vault_transactions_cache')
            .upsert(newTransactions, { onConflict: 'signature' })
            .then(({ error }) => {
              if (error) {
                console.log(`  ⚠️ Failed to cache transactions: ${error.message}`);
              } else {
                console.log(`  💾 Cached ${newTransactions.length} new transactions`);
              }
            });
        }

        // 4. Combine cached + fresh volume
        volume24h += cachedVolume;
        for (const user of cachedParticipants) {
          uniqueUsers.add(user);
        }

        console.log(`  📝 Found ${txIn24h} new + ${cachedSignatures.size} cached transactions in 24h, ${txCount} with volume`);
        console.log(`  📊 Real 24h volume: $${volume24h.toFixed(2)} (pages: ${pageCount})`);

        participants = uniqueUsers.size;
        console.log('  👥 Real participants:', participants);
      } catch (error) {
        console.log('  ⚠️ Could not fetch volume:', error instanceof Error ? error.message : error);
        // Keep any volume we've already calculated, don't zero it out
      }

      // Determine token symbol - prefer rift name, then known tokens, then first 8 chars of mint
      const mintToSymbol: { [key: string]: string } = {
        'So11111111111111111111111111111111111111112': 'SOL',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
        'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'mSOL',
        '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj': 'stSOL',
      };

      // Extract underlying symbol from rift name (remove prefix if present)
      // If riftName is "rSOL" or "mSOL", extract "SOL" as the underlying
      // Check: first char is lowercase 'r' or 'm', AND second char is uppercase
      // This avoids matching "RIFTS" → "IFTS" or "RACHA" → "ACHA"
      let underlyingSymbol = riftName;
      if (riftName && riftName.length > 1) {
        const firstChar = riftName[0];
        const secondChar = riftName[1];
        // Only remove prefix if: first char is lowercase 'r'/'m' AND second char is uppercase letter
        if ((firstChar === 'r' || firstChar === 'm') && secondChar === secondChar.toUpperCase() && /[A-Z]/.test(secondChar)) {
          underlyingSymbol = riftName.slice(1); // Remove first character (prefix)
        }
      }
      // Fallback to known tokens or mint address if no rift name
      if (!underlyingSymbol) {
        underlyingSymbol = mintToSymbol[underlyingMint.toBase58()] || underlyingMint.toBase58().slice(0, 8).toUpperCase();
      }

      // Check if this rift has a Meteora pool by searching for pools containing this rift mint
      let hasMeteoraPool = false;
      let liquidityPool: string | undefined;
      let meteoraPoolsArray: string[] = []; // All discovered pools (CP-AMM + DLMM)
      let detectedPoolType: 'dlmm' | 'dammv2' = 'dammv2'; // Default to DAMMV2

      try {
        // 🔍 AUTOMATIC POOL DETECTION (using Helius RPC)
        // Helius supports getProgramAccounts with large result sets
        // Search for Meteora CP-AMM pools containing this rift mint using memcmp filter
        // CP-AMM pools: tokenA at offset 168, tokenB at offset 200, dataSize 1112

        // Small stagger to avoid rate limiting (200ms between rifts)
        await new Promise(resolve => setTimeout(resolve, index * 200));

        console.log(`  🔍 Searching for Meteora pools for rift mint: ${riftMint.toBase58()}`);

        // Declare pool arrays outside try block so they're accessible for pool type filtering later
        let allDiscoveredCpammPools: Array<{ address: string; tvl: number; isSolPaired: boolean; type: 'cpamm' }> = [];
        let allDiscoveredDlmmPools: Array<{ address: string; tvl: number; isSolPaired: boolean; type: 'dlmm' }> = [];

        const poolsWithRiftAsTokenA = await connection.getProgramAccounts(METEORA_CP_AMM_PROGRAM_ID, {
          filters: [
            { dataSize: 1112 },
            { memcmp: { offset: 168, bytes: riftMint.toBase58() } }
          ],
          dataSlice: { offset: 0, length: 0 }, // Only get pubkeys, no account data
          commitment: 'confirmed'
        }).catch((err: any) => {
          console.log(`  ⚠️ TokenA search failed: ${err.message}`);
          return [];
        });

        console.log(`  📊 TokenA search found: ${poolsWithRiftAsTokenA.length} pools`);

        // Small delay between the two searches for same rift
        await new Promise(resolve => setTimeout(resolve, 100));

        const poolsWithRiftAsTokenB = await connection.getProgramAccounts(METEORA_CP_AMM_PROGRAM_ID, {
          filters: [
            { dataSize: 1112 },
            { memcmp: { offset: 200, bytes: riftMint.toBase58() } }
          ],
          dataSlice: { offset: 0, length: 0 }, // Only get pubkeys, no account data
          commitment: 'confirmed'
        }).catch((err: any) => {
          console.log(`  ⚠️ TokenB search failed: ${err.message}`);
          return [];
        });

        console.log(`  📊 TokenB search found: ${poolsWithRiftAsTokenB.length} pools`);

        const matchingPools = [...poolsWithRiftAsTokenA, ...poolsWithRiftAsTokenB];

        if (matchingPools.length > 0) {
          hasMeteoraPool = true;
          const SOL_MINT = 'So11111111111111111111111111111111111111112';

          console.log(`  🔎 Found ${matchingPools.length} CP-AMM pool(s), fetching TVL for each...`);

          // 🚀 OPTIMIZED: Batch fetch all pool accounts at once
          console.log(`  🚀 Batch fetching ${matchingPools.length} CP-AMM pool accounts...`);
          const poolPubkeys = matchingPools.map(p => p.pubkey);
          const poolInfos = await connection.getMultipleAccountsInfo(poolPubkeys);
          console.log(`  ✅ Fetched ${poolInfos.length} pool accounts in 1 batch call`);

          // Process all pool accounts
          for (let i = 0; i < matchingPools.length; i++) {
            const pool = matchingPools[i];
            const poolInfo = poolInfos[i];

            try {
              if (poolInfo && poolInfo.data.length >= 232) {
                const tokenAMint = new PublicKey(poolInfo.data.slice(168, 200)).toBase58();
                const tokenBMint = new PublicKey(poolInfo.data.slice(200, 232)).toBase58();
                const isSolPaired = tokenAMint === SOL_MINT || tokenBMint === SOL_MINT;

                // Try to get TVL from pool reserves (simplified - just check if has liquidity)
                // CP-AMM vault balances are at different offsets, use 0 as default
                let tvl = 0;
                try {
                  // For CP-AMM, we can estimate TVL from vault token accounts
                  // This is a simplified check - real TVL calculation would need vault account reads
                  // For now, mark all pools as having potential liquidity
                  tvl = 1; // Non-zero to indicate pool exists
                } catch {
                  tvl = 0;
                }

                allDiscoveredCpammPools.push({
                  address: pool.pubkey.toBase58(),
                  tvl,
                  isSolPaired,
                  type: 'cpamm'
                });

                console.log(`    Pool ${pool.pubkey.toBase58().slice(0,8)}...: SOL-paired=${isSolPaired}`);
              }
            } catch (err) {
              // Still add the pool even if we can't get details
              allDiscoveredCpammPools.push({
                address: pool.pubkey.toBase58(),
                tvl: 0,
                isSolPaired: false,
                type: 'cpamm'
              });
              console.log(`    ⚠️ Could not check pool ${pool.pubkey.toBase58()}: ${err instanceof Error ? err.message : err}`);
            }
          }

          // Sort: SOL-paired first, then by TVL (highest first)
          allDiscoveredCpammPools.sort((a, b) => {
            if (a.isSolPaired !== b.isSolPaired) return a.isSolPaired ? -1 : 1;
            return b.tvl - a.tvl;
          });

          // Select best pool (first after sorting = highest TVL SOL-paired, or highest TVL overall)
          liquidityPool = allDiscoveredCpammPools[0]?.address;
          console.log(`  ✅ AUTO-DETECTED ${matchingPools.length} Meteora CP-AMM pool(s) for ${riftName || riftMint.toBase58()}`);
          console.log(`     Primary pool: ${liquidityPool} (SOL-paired: ${allDiscoveredCpammPools[0]?.isSolPaired})`);
        }

        // 🔍 DLMM POOL DETECTION - Use pre-fetched data from getProgramAccountsV2
        const riftMintStr = riftMint.toBase58();
        const dlmmPoolsForRift = dlmmPoolsByMint.get(riftMintStr) || [];

        // Debug: log DLMM pool lookup
        console.log(`  🔍 DLMM lookup for ${riftName || riftMintStr.slice(0,8)}: map has ${dlmmPoolsByMint.size} mints, found ${dlmmPoolsForRift.length} pool(s) for this mint`);

        if (dlmmPoolsForRift.length > 0) {
          const SOL_MINT = 'So11111111111111111111111111111111111111112';

          for (const pool of dlmmPoolsForRift) {
            // Only include pools where our rift mint is one of the tokens
            if (pool.tokenX !== riftMintStr && pool.tokenY !== riftMintStr) continue;

            const isSolPaired = pool.tokenX === SOL_MINT || pool.tokenY === SOL_MINT;

            allDiscoveredDlmmPools.push({
              address: pool.address,
              tvl: 0, // TVL not available from SDK, but we sort by SOL-paired first anyway
              isSolPaired,
              type: 'dlmm'
            });
          }

          if (allDiscoveredDlmmPools.length > 0) {
            console.log(`  🔍 DLMM SDK: Found ${allDiscoveredDlmmPools.length} pool(s) for ${riftName || riftMintStr.slice(0, 8)}`);
          }
        }

        // 📦 Merge ALL discovered pools into meteoraPools array (CP-AMM + DLMM)
        // Sort by: SOL-paired first, then highest TVL first
        const allDiscoveredPools = [...allDiscoveredCpammPools, ...allDiscoveredDlmmPools];
        allDiscoveredPools.sort((a, b) => {
          if (a.isSolPaired !== b.isSolPaired) return a.isSolPaired ? -1 : 1;
          return b.tvl - a.tvl;
        });

        // Store all pool addresses in meteoraPools array
        meteoraPoolsArray = allDiscoveredPools.map(p => p.address);

        // If we found any pools, use the best one as primary
        if (meteoraPoolsArray.length > 0 && !liquidityPool) {
          liquidityPool = meteoraPoolsArray[0];
          hasMeteoraPool = true;
        }

        if (meteoraPoolsArray.length > 0) {
          console.log(`  📦 Total pools discovered: ${meteoraPoolsArray.length} (${allDiscoveredCpammPools.length} CP-AMM, ${allDiscoveredDlmmPools.length} DLMM)`);
          console.log(`     All pools: ${meteoraPoolsArray.map(p => p.slice(0,8) + '...').join(', ')}`);
        }

        // 🔧 POOL TYPE FILTERING: Determine pool type based on what pools were discovered
        // - Regular rifts (prefixType=0): Use CP-AMM pools, poolType='dammv2'
        // - Monorifts (prefixType=1) can use EITHER:
        //   - DLMM pools (traditional monorifts), poolType='dlmm'
        //   - DAMMV2 single-sided pools (new DAMMV2 SS monorifts), poolType='dammv2'
        const riftAddressStr = account.pubkey.toBase58();
        let prefixTypeForFilter = 0;

        // Check monorift override first
        const overrideForFilter = MONORIFT_OVERRIDES[riftAddressStr];
        if (overrideForFilter) {
          prefixTypeForFilter = overrideForFilter.prefixType;
        } else if (riftName) {
          const lowerName = riftName.toLowerCase();
          if (lowerName.startsWith('m')) {
            prefixTypeForFilter = 1;
          }
        }
        const isMonoriftForFilter = prefixTypeForFilter === 1;

        if (meteoraPoolsArray.length > 0 || allDiscoveredCpammPools.length > 0 || allDiscoveredDlmmPools.length > 0) {
          if (isMonoriftForFilter) {
            // Monorifts can use DLMM or DAMMV2 single-sided
            // Prefer DLMM if found, otherwise use DAMMV2 (CP-AMM) for DAMMV2 SS monorifts
            const dlmmPoolAddresses = allDiscoveredDlmmPools.map(p => p.address);
            const cpammPoolAddresses = allDiscoveredCpammPools.map(p => p.address);

            if (dlmmPoolAddresses.length > 0) {
              // Monorift with DLMM pool
              meteoraPoolsArray = dlmmPoolAddresses;
              liquidityPool = dlmmPoolAddresses[0];
              detectedPoolType = 'dlmm';
              console.log(`  ✅ MONORIFT ${riftName}: Using ${dlmmPoolAddresses.length} DLMM pool(s)`);
            } else if (cpammPoolAddresses.length > 0) {
              // Monorift with DAMMV2 single-sided pool (DAMMV2 SS)
              meteoraPoolsArray = cpammPoolAddresses;
              liquidityPool = cpammPoolAddresses[0];
              detectedPoolType = 'dammv2';
              console.log(`  ✅ MONORIFT ${riftName}: Using ${cpammPoolAddresses.length} DAMMV2 single-sided pool(s)`);
            } else if (meteoraPoolsArray.length > 0) {
              // No pools in the arrays, but we already have pools from earlier detection
              // Keep existing pools and determine type based on what we have
              // This handles edge cases where pool detection was done differently
              console.log(`  ℹ️ MONORIFT ${riftName}: Keeping ${meteoraPoolsArray.length} previously detected pool(s)`);
              // Check if any are DLMM (by checking if they were in the DLMM search)
              detectedPoolType = allDiscoveredDlmmPools.length > 0 ? 'dlmm' : 'dammv2';
            }
          } else {
            // Regular rifts only get CP-AMM pools - filter out DLMM pools
            const cpammPoolAddresses = allDiscoveredCpammPools.map(p => p.address);
            meteoraPoolsArray = cpammPoolAddresses;
            detectedPoolType = 'dammv2';
            if (cpammPoolAddresses.length > 0) {
              liquidityPool = cpammPoolAddresses[0];
            }
            if (allDiscoveredDlmmPools.length > 0 && cpammPoolAddresses.length === 0) {
              console.log(`  ⚠️ POOL TYPE MISMATCH: Regular rift ${riftName} has ${allDiscoveredDlmmPools.length} DLMM pool(s) but needs CP-AMM - ignoring DLMM pools`);
            }
          }

          if (meteoraPoolsArray.length > 0) {
            console.log(`  ✅ POOL TYPE: ${isMonoriftForFilter ? 'Monorift' : 'Regular rift'} ${riftName} using ${detectedPoolType.toUpperCase()} with ${meteoraPoolsArray.length} pool(s)`);
          }
        }

      } catch (poolSearchError) {
        console.log(`  ⚠️ Error searching for Meteora pool:`, poolSearchError instanceof Error ? poolSearchError.message : poolSearchError);
        // Continue without pool detection for this rift
      }

      // ⚡ Save raw account data to cache for instant client access (fire-and-forget)
      saveRiftAccountToCache({
        riftAddress: account.pubkey.toBase58(),
        accountData: Buffer.from(data),
        vaultAddress: vault.toBase58(),
        vaultAccountData,
        underlyingMint: underlyingMint.toBase58(),
        underlyingDecimals: underlyingDecimals ?? 9,
        riftMint: riftMint.toBase58(),
        riftDecimals: riftDecimals!, // Fetched from blockchain (validated above)
        transferFeeBps, // Cache transfer fee to avoid future RPC calls
        backingRatio: BigInt(Math.floor(backingRatio * 1_000_000)), // Store as micro-ratio (6 decimals)
        totalWrapped: totalUnderlyingWrapped,
        totalMinted: totalRiftMinted,
      }).catch(err => {
        console.error(`[RIFT-CACHE] Failed to cache ${account.pubkey.toBase58()}:`, err.message);
      });

        const riftAddress = account.pubkey.toBase58();
        const isV1Rift = riftAddress === V1_RIFT_ADDRESS;

        // V1 Rift gets 0% APY (legacy, excluded from protocol metrics)
        const rawApy = (volume24h > 0 && vaultBalance > 0)
          ? ((volume24h * 0.007) / (vaultBalance * underlyingTokenPrice)) * 365 * 100
          : 0;
        const finalApy = isV1Rift ? 0 : rawApy;

        // Determine prefix type and symbol from the on-chain name
        // If riftName starts with 'm', it's a monorift (prefixType: 1)
        // Otherwise it's a regular rift (prefixType: 0)
        let prefixType = 0;
        let displaySymbol = '';

        // Check for manual monorift override first
        const monoriftOverride = MONORIFT_OVERRIDES[riftAddress];
        if (monoriftOverride) {
          prefixType = monoriftOverride.prefixType;
          displaySymbol = monoriftOverride.symbol;
          console.log(`  🔧 MONORIFT OVERRIDE: ${riftAddress} -> ${displaySymbol} (prefixType=${prefixType})`);
        } else if (riftName) {
          const lowerName = riftName.toLowerCase();
          if (lowerName.startsWith('m')) {
            // Monorift with 'm' prefix already in name
            prefixType = 1;
            displaySymbol = riftName;
          } else if (lowerName.startsWith('r')) {
            // Regular rift with 'r' prefix already in name
            prefixType = 0;
            displaySymbol = riftName;
          } else {
            // Name has no prefix, add 'r' for regular rifts
            prefixType = 0;
            displaySymbol = `r${riftName}`;
          }
        } else {
          // No name on-chain, default to 'r' + underlyingSymbol
          prefixType = 0;
          displaySymbol = `r${underlyingSymbol}`;
        }

        // Update hasMeteoraPool based on filtered results (meteoraPoolsArray was updated by pool type filtering)
        const filteredHasMeteoraPool = meteoraPoolsArray.length > 0;

        return {
          id: riftAddress,
          programVersion: isV1Rift ? 'v1' as const : 'v2' as const, // V1 or V2 program
          programId: isV1Rift ? RIFTS_V1_PROGRAM_ID.toBase58() : RIFTS_PROGRAM_ID.toBase58(), // Program ID
          symbol: displaySymbol,
          underlying: underlyingSymbol,
          prefixType,
          underlyingMint: underlyingMint.toBase58(),
          riftMint: riftMint.toBase58(),
          riftAddress: riftAddress, // Rift PDA address (same as id)
          vault: vault.toBase58(),
          authority: creator.toBase58(),
          creator: creator.toBase58(), // Also set creator for backward compatibility
          partnerWallet, // Parsed from on-chain data
          treasuryWallet, // Parsed from on-chain data
          tvl, // TVL = totalUnderlyingWrapped * underlying token price (NOT vaultBalance!)
          vaultBalance, // Actual vault balance in underlying tokens (for "Total Wrapped" display)
          underlyingTokenPrice, // Price of the underlying asset (SOL, USDC, etc.)
          riftTokenPrice, // Price of the rift token (underlying price * backing ratio)
          totalRiftMinted: Number(totalRiftMinted) / Math.pow(10, riftDecimals ?? 9),
          backingRatio,
          realBackingRatio: backingRatio,
          burnFee: 0, // Deprecated - was removed from struct
          partnerFee: partnerFeeBps / 100,
          wrapFeeBps, // Wrap fee in basis points (e.g., 30 = 0.3%)
          unwrapFeeBps, // Unwrap fee in basis points (e.g., 30 = 0.3%)
          partnerFeeBps, // Partner fee in basis points
          transferFeeBps: transferFeeBps !== null ? transferFeeBps : undefined, // Token-2022 transfer fee in basis points (e.g., 80 = 0.8%), undefined if not found
          totalFeesCollected, // Already a number in tokens
          isActive: true, // We don't have is_active field in this struct version
          oracleStatus: 'active',
          createdAt: createdAt.toISOString(), // Include creation timestamp for sorting
          // Real on-chain values only (V1 rift excluded from APY)
          apy: finalApy, // Calculate REAL APY: (daily_fees / tvl) × 365 × 100
          volume24h,
          participants,
          risk: 'Medium' as const,
          strategy: 'Delta Neutral' as const,
          performance: [12.5],
          arbitrageOpportunity: 2.0,
          hasMeteoraPool: filteredHasMeteoraPool,
          liquidityPool: liquidityPool,
          meteoraPools: meteoraPoolsArray.length > 0 ? meteoraPoolsArray : undefined,
          // Pool type: detected from actual pools (DLMM or DAMMV2/CP-AMM)
          // Monorifts can use either DLMM or DAMMV2 single-sided
          poolType: detectedPoolType
        };
      } catch (riftError) {
        console.error(`[FETCH-RIFTS] ❌ Error processing rift ${account.pubkey.toBase58()}:`, riftError instanceof Error ? riftError.message : riftError);
        console.error('[FETCH-RIFTS] Stack:', riftError instanceof Error ? riftError.stack : 'N/A');
        return null; // Skip this rift on error
      }
    }));

    // Filter out null values (rifts that couldn't get prices)
    const validRifts = rifts.filter(rift => rift !== null);

    // Filter out blacklisted rifts
    const nonBlacklistedRifts = validRifts.filter(rift => !BLACKLISTED_RIFTS.includes(rift.id));
    const blacklistedCount = validRifts.length - nonBlacklistedRifts.length;

    if (blacklistedCount > 0) {
      console.log(`[FETCH-RIFTS] 🚫 Filtered out ${blacklistedCount} blacklisted rift(s)`);
    }

    console.log(`[FETCH-RIFTS] ✅ Step 4/4 complete: Successfully parsed ${nonBlacklistedRifts.length} rifts (${rifts.length - nonBlacklistedRifts.length} skipped/blacklisted) (+${Date.now() - startTime}ms)`);
    return nonBlacklistedRifts;
  } catch (error) {
    console.error('[FETCH-RIFTS] ❌ CRITICAL ERROR in fetchRiftsFromBlockchain:', error instanceof Error ? error.message : error);
    console.error('[FETCH-RIFTS] Stack:', error instanceof Error ? error.stack : 'N/A');

    // 🔄 FALLBACK: Try to load from Supabase when blockchain fetch fails
    console.log('[FETCH-RIFTS] 🔄 Blockchain failed, attempting Supabase fallback...');
    try {
      const { data: v2Rifts, error: v2Error } = await supabase
        .from('rifts')
        .select('*')
        .eq('is_deprecated', false)
        .eq('program_id', RIFTS_PROGRAM_ID.toBase58())
        .order('updated_at', { ascending: false });

      const { data: v1Rifts, error: v1Error } = await supabase
        .from('rifts')
        .select('*')
        .eq('is_deprecated', false)
        .eq('program_id', RIFTS_V1_PROGRAM_ID.toBase58())
        .eq('id', V1_RIFT_ADDRESS)
        .order('updated_at', { ascending: false });

      const supabaseRifts = [...(v2Rifts || []), ...(v1Rifts || [])];
      const dbError = v2Error || v1Error;

      if (!dbError && supabaseRifts && supabaseRifts.length > 0) {
        console.log(`[FETCH-RIFTS] ✅ Loaded ${supabaseRifts.length} rifts from Supabase fallback`);
        const riftsData = supabaseRifts.map(r => r.raw_data);

        // Filter out blacklisted rifts
        const nonBlacklistedRifts = riftsData.filter(r => !BLACKLISTED_RIFTS.includes(r.id));
        console.log(`[FETCH-RIFTS] ✅ Supabase fallback complete: ${nonBlacklistedRifts.length} rifts`);
        return nonBlacklistedRifts;
      } else {
        console.error('[FETCH-RIFTS] ❌ Supabase fallback also failed:', dbError);
        throw error; // Throw original error if Supabase also fails
      }
    } catch (supabaseError) {
      console.error('[FETCH-RIFTS] ❌ Supabase fallback error:', supabaseError);
      throw error; // Throw original blockchain error
    }
  }
}

/**
 * API handler
 */
async function riftsCacheHandler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const requestStartTime = Date.now();
  let currentStep = 'initialization';

  // Initialize runtime values (connection, PublicKey, program IDs)
  const { connection, PublicKey, RIFTS_PROGRAM_ID, RIFTS_V1_PROGRAM_ID, RPC_URL } = await getRuntime();

  try {
    console.log('\n\n🚀 [RIFTS-CACHE] ===== NEW REQUEST =====');
    console.log(`[RIFTS-CACHE] Request method: ${req.method}`);
    console.log(`[RIFTS-CACHE] Timestamp: ${new Date().toISOString()}`);

    // Check if cache is still valid
    currentStep = 'cache-check';
    const now = Date.now();
    const cacheAge = now - lastFetchTime;

    // Check if this is a forced refresh request
    const forceRefresh = req.headers['x-refresh'] === 'true';

    if (cachedRifts.length > 0 && cacheAge < CACHE_DURATION && !forceRefresh) {
      // Return cached data
      console.log(`[RIFTS-CACHE] ✅ Serving ${cachedRifts.length} rifts from cache (age: ${Math.round(cacheAge / 1000)}s)`);
      return res.status(200).json({
        success: true,
        rifts: cachedRifts,
        cached: true,
        cacheAge: Math.round(cacheAge / 1000),
        timestamp: lastFetchTime
      });
    }

    // If cache is too old, force refresh even if not expired
    if (cachedRifts.length > 0 && cacheAge > MAX_CACHE_AGE) {
      console.log('[RIFTS-CACHE] Cache too old, forcing refresh...');
    } else {
      // Cache expired or empty - fetch fresh data
      console.log('[RIFTS-CACHE] Cache expired or empty, fetching fresh data...');
    }

    currentStep = 'fetch-blockchain';
    const rifts = await fetchRiftsFromBlockchain();
    console.log(`[RIFTS-CACHE] ✅ Fetched ${rifts.length} rifts from blockchain (+${Date.now() - requestStartTime}ms)`);

    // Update cache
    currentStep = 'update-cache';
    cachedRifts = rifts;
    lastFetchTime = now;

    // Update Supabase with fresh data (AWAIT to see errors)
    currentStep = 'update-supabase';
    try {
      await updateSupabaseCache(rifts);
      // 🔧 FIX: Add small delay after upserts to ensure DB consistency before reads
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log('[RIFTS-CACHE] ✅ Supabase update completed successfully (with 500ms propagation delay)');
    } catch (err) {
      console.error('[RIFTS-CACHE] ❌ Failed to update Supabase cache:', err instanceof Error ? err.message : err);
    }

    // Scan and save transactions to database (async, don't wait)
    // ✅ OPTIMIZED: Now runs once per hour with reduced limits (5 tx per rift)
    currentStep = 'scan-transactions';
    const timeSinceLastScan = now - lastTxScanTime;
    console.log(`\n🔍 [RIFTS-CACHE] Transaction scan check:`);
    console.log(`  - Rifts: ${rifts.length}`);
    console.log(`  - Time since last scan: ${Math.round(timeSinceLastScan / 1000 / 60)}min`);
    console.log(`  - Cooldown: ${TX_SCAN_COOLDOWN / 1000 / 60}min`);
    console.log(`  - Limit per rift: ${TX_LIMIT_PER_RIFT} transactions`);
    console.log(`  - Max calls: ${rifts.length} × ${TX_LIMIT_PER_RIFT} = ${rifts.length * TX_LIMIT_PER_RIFT} getTransaction calls`);

    if (rifts.length <= 20 && timeSinceLastScan > TX_SCAN_COOLDOWN) {
      console.log('✅ [RIFTS-CACHE] Starting optimized transaction scan (runs every 5 min)...');
      lastTxScanTime = now; // Update timestamp BEFORE scanning to prevent concurrent scans
      try {
        await scanAndSaveTransactions(rifts);
        console.log('[RIFTS-CACHE] ✅ Transaction scan completed successfully');
      } catch (err) {
        console.error('[RIFTS-CACHE] ❌ Failed to scan transactions:', err instanceof Error ? err.message : err);
      }
    } else {
      if (rifts.length > 20) {
        console.log('⏭️  [RIFTS-CACHE] Skipping scan - too many rifts');
      } else {
        console.log(`⏭️  [RIFTS-CACHE] Skipping scan - cooldown active (${Math.round(timeSinceLastScan / 1000 / 60)}/${TX_SCAN_COOLDOWN / 1000 / 60} min)`);
      }
    }

    // Save protocol metrics to database on every fresh fetch
    currentStep = 'save-metrics';
    try {
      const activeTvl = rifts.reduce((sum: number, r: any) => sum + (Number(r.tvl) || 0), 0);
      const volume24h = rifts.reduce((sum: number, r: any) => sum + (Number(r.volume24h) || 0), 0);

      // Calculate average APY from individual rift APYs (excluding V1 rift and blacklisted)
      // Use TVL-weighted average: sum(apy × tvl) / sum(tvl)
      const v2Rifts = rifts.filter((r: any) => r.id !== V1_RIFT_ADDRESS && !BLACKLISTED_RIFTS.includes(r.id));
      const riftsWithApy = v2Rifts.filter((r: any) => (Number(r.apy) || 0) > 0 && (Number(r.tvl) || 0) > 0);
      const totalWeightedApy = riftsWithApy.reduce((sum: number, r: any) => sum + ((Number(r.apy) || 0) * (Number(r.tvl) || 0)), 0);
      const totalApyTvl = riftsWithApy.reduce((sum: number, r: any) => sum + (Number(r.tvl) || 0), 0);
      const avgApy = totalApyTvl > 0 ? totalWeightedApy / totalApyTvl : 0;
      console.log(`[RIFTS-CACHE] 📊 Avg APY calculation: ${riftsWithApy.length} rifts with APY, weighted avg = ${avgApy.toFixed(2)}%`);

      // Fetch REAL on-chain fees from vault balances
      // IMPORTANT: Use production domain to avoid Vercel auth protection issues
      let totalFees = 0;
      try {
        const vaultBaseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://app.rifts.finance';
        const vaultRes = await fetch(`${vaultBaseUrl}/api/get-vault-balances`);
        if (vaultRes.ok) {
          const vaultData = await vaultRes.json();
          totalFees = vaultData.grandTotalUSD || 0;
          console.log(`[RIFTS-CACHE] Real on-chain fees: $${totalFees.toFixed(2)}`);
        }
      } catch (vaultErr) {
        console.error('[RIFTS-CACHE] Failed to fetch vault balances:', vaultErr);
      }

      // Calculate burned rift TVL (120M rRIFTS × RIFTS price)
      // Uses shared price cache to avoid duplicate Jupiter API calls
      const BURNED_RIFT_SUPPLY = 120133315; // 120M rRIFTS tokens
      const BURNED_RIFT_MINT = 'B2ha7xqztT4qtmkzJC3yytaXnex2veEMiFXKUrVx6x8p';
      const RIFTS_UNDERLYING_MINT = 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';
      let burnedRiftTvl = 0;
      let riftsPrice = 0;
      try {
        const { getCachedRiftsPrice } = await import('@/lib/server-price-cache');
        riftsPrice = await getCachedRiftsPrice();
        burnedRiftTvl = BURNED_RIFT_SUPPLY * riftsPrice;
        console.log(`[RIFTS-CACHE] 🔥 DEBUG: riftsPrice = ${riftsPrice}, burnedRiftTvl = ${burnedRiftTvl.toFixed(2)}`);
      } catch (e) {
        console.error('[RIFTS-CACHE] Failed to fetch RIFTS price for burned TVL', e);
      }

      // Add burned rift to rifts array (same as RiftsApp.tsx does)
      // This ensures both main page and dashboard get the same data
      const burnedRiftExists = rifts.some((r: any) => r.riftMint === BURNED_RIFT_MINT || r.id === BURNED_RIFT_MINT);
      console.log(`[RIFTS-CACHE] 🔥 DEBUG: burnedRiftExists = ${burnedRiftExists}, riftsPrice = ${riftsPrice}, riftsPrice > 0 = ${riftsPrice > 0}`);
      console.log(`[RIFTS-CACHE] 🔥 DEBUG: Checking rifts array for burned rift (${rifts.length} rifts total)`);
      console.log(`[RIFTS-CACHE] 🔥 DEBUG: Rift IDs in array:`, rifts.map((r: any) => r.id).join(', '));
      console.log(`[RIFTS-CACHE] 🔥 DEBUG: Will add burned rift = ${!burnedRiftExists && riftsPrice > 0}`);
      if (!burnedRiftExists && riftsPrice > 0) {
        const burnedRiftData = {
          id: BURNED_RIFT_MINT,
          programVersion: 'v1' as const,
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
          createdAt: new Date('2024-10-01').toISOString(),
          apy: 0,
          volume24h: 0,
          participants: 0,
          risk: 'High' as const,
          strategy: 'Burned' as const,
          performance: [0],
          arbitrageOpportunity: 0,
          hasMeteoraPool: false,
          liquidityPool: undefined,
          isBurned: true // Flag to identify burned rift
        };
        rifts.push(burnedRiftData);
        console.log(`[RIFTS-CACHE] 🔥 Added burned rift to response: TVL=$${burnedRiftTvl.toFixed(2)}`);
      }

      // Total TVL = active rifts + burned rift (now included in rifts array)
      const totalTvl = rifts.reduce((sum: number, r: any) => sum + (Number(r.tvl) || 0), 0);

      // DEBUG: Log the values to see what's happening
      console.log(`[RIFTS-CACHE] 🔍 DEBUG TVL check: active=$${activeTvl.toFixed(2)}, burned=$${burnedRiftTvl.toFixed(2)}, total=$${totalTvl.toFixed(2)}, threshold=200000`);

      // ONLY save metrics if TVL > 200K AND fees > 2000 (validates data is correct)
      // Note: Total TVL = active rifts TVL + burned rift TVL (120M rRIFTS × RIFTS price)
      if (totalTvl > 200000 && totalFees > 2000) {
        const { error: metricsError } = await supabase
          .from('protocol_metrics')
          .insert({
            avg_apy: avgApy,
            total_tvl: totalTvl,
            volume_24h: volume24h,
            total_rifts: rifts.length,
            total_fees: totalFees,
            active_users: 0 // Will be updated by transaction scanner
          });

        if (metricsError) {
          console.error('[RIFTS-CACHE] ⚠️ Failed to save metrics:', metricsError.message);
        } else {
          console.log(`[RIFTS-CACHE] 📊 Saved metrics: TVL=$${totalTvl.toFixed(2)}, Fees=$${totalFees.toFixed(2)}`);
        }
      } else if (totalTvl <= 200000) {
        console.error(`[RIFTS-CACHE] ⚠️ Skipping metrics - TVL too low ($${totalTvl.toFixed(2)}), threshold is 200K`);
      } else if (totalFees <= 2000) {
        console.error(`[RIFTS-CACHE] ⚠️ Skipping metrics - fees too low ($${totalFees.toFixed(2)}), vault fetch failed`);
      }
    } catch (err) {
      console.error('[RIFTS-CACHE] ⚠️ Error saving metrics:', err);
    }

    // Return fresh data
    currentStep = 'return-response';
    console.log(`[RIFTS-CACHE] ✅ Request complete (+${Date.now() - requestStartTime}ms)`);
    return res.status(200).json({
      success: true,
      rifts,
      cached: false,
      cacheAge: 0,
      timestamp: now
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;

    console.error('[RIFTS-CACHE] ❌ ERROR at step:', currentStep);
    console.error('[RIFTS-CACHE] Error message:', errorMessage);
    console.error('[RIFTS-CACHE] Stack:', errorStack);

    // If we have cached data, return it even if expired
    if (cachedRifts.length > 0) {
      console.log('[RIFTS-CACHE] Returning stale cache due to error');
      return res.status(200).json({
        success: true,
        rifts: cachedRifts,
        cached: true,
        stale: true,
        cacheAge: Math.round((Date.now() - lastFetchTime) / 1000),
        timestamp: lastFetchTime,
        warning: `Error during refresh: ${errorMessage}`
      });
    }

    // No cache available - return detailed error for debugging
    return res.status(500).json({
      success: false,
      error: errorMessage,
      errorStep: currentStep,
      errorStack: errorStack,
      timestamp: Date.now(),
      rifts: [],
      debug: {
        rpcUrl: RPC_URL ? 'configured' : 'missing',
        programId: RIFTS_PROGRAM_ID.toBase58(),
        supabaseConfigured: !!(SUPABASE_URL && SUPABASE_KEY),
        cacheSize: cachedRifts.length,
        lastFetchTime: lastFetchTime,
        requestDuration: Date.now() - requestStartTime
      }
    });
  }
}

// Configure max execution time for Vercel Pro (5 minutes = 300 seconds)
export const config = {
  maxDuration: 300,
};

// Export with rate limiting (GET endpoint, so no CSRF needed, but rate limit to prevent abuse)
// 🔒 SECURITY FIX (Issue #2): Add rate limiting to prevent abuse of this heavy endpoint
export default withRateLimiting(riftsCacheHandler, apiRateLimiter);
