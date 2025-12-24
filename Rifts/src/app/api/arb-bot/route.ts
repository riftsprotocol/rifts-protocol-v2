import { NextRequest, NextResponse } from 'next/server';

// Dynamic import to avoid bundling issues
const getSolana = async () => {
  const { Connection, PublicKey } = await import('@solana/web3.js');
  const { getLaserstreamConnection } = await import('@/lib/solana/server-connection');
  return { Connection, PublicKey, getLaserstreamConnection };
};

// Supabase configuration
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://nitmreqtsnzjylyzwsri.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pdG1yZXF0c256anlseXp3c3JpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI1NjkyNDIsImV4cCI6MjA3ODE0NTI0Mn0.79J6IKGOTVeHGCj4A6oXG-Aj8hOh6vrylwK5rtJ8g9U';

// Supabase fetch helper
async function supabaseFetch(endpoint: string, options: RequestInit = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.method === 'POST' ? 'return=representation' : 'return=minimal',
      ...options.headers as Record<string, string>,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase error: ${text}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// Bot state storage - local cache for in-flight operations during web API calls
// Persistent state is stored in Supabase arb_bot_configs table
const botInstances: Map<string, BotInstance> = new Map();

interface LogEntry {
  timestamp: string;
  type: 'info' | 'opportunity' | 'trade' | 'error' | 'scan';
  message: string;
  data?: any;
}

interface BotInstance {
  riftId: string;
  riftSymbol: string;
  walletAddress: string;
  status: 'running' | 'stopped' | 'starting' | 'stopping';
  startedAt: number;
  stats: {
    opportunitiesFound: number;
    tradesExecuted: number;
    totalProfit: number;
    lastCheck: string;
    scansCompleted: number;
  };
  logs: LogEntry[];
  intervalId?: NodeJS.Timeout;
  config: {
    minProfitBps: number;
    maxSlippageBps: number;
    maxTradeSize: number;
  };
}

// Add log to bot instance (keep last 100 logs)
function addLog(bot: BotInstance, type: LogEntry['type'], message: string, data?: any) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    type,
    message,
    data
  };
  bot.logs.push(entry);
  if (bot.logs.length > 100) {
    bot.logs.shift();
  }
  console.log(`[ARB-BOT] [${type.toUpperCase()}] ${message}`);
}

interface RiftConfig {
  riftMint: string;
  underlyingMint: string;
  vault: string;
  meteoraPools: string[];
  wrapFeeBps: number;
  unwrapFeeBps: number;
  transferFeeBps: number;
}

if (!process.env.LASERSTREAM || !process.env.LASERSTREAM_API_KEY) {
  throw new Error('LaserStream not configured (LASERSTREAM + LASERSTREAM_API_KEY required)');
}

const RPC_URL = `${process.env.LASERSTREAM}/?api-key=${process.env.LASERSTREAM_API_KEY}`;
const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// Minimum TVL required to run a bot (in USD)
const MIN_TVL_USD = 100;

// Pool data structure
interface PoolData {
  address: string;
  dex: string;
  price: number;
  liquidity: number;
  baseSymbol: string;
  quoteSymbol: string;
  baseMint: string;
  quoteMint: string;
  baseReserve?: number;
  quoteReserve?: number;
}

// PumpSwap Pool structure from official IDL
// 8 bytes discriminator, u8 pool_bump, u16 index, then pubkeys and u64
interface PumpSwapPool {
  poolBump: number;
  index: number;
  creator: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  poolBaseTokenAccount: string;
  poolQuoteTokenAccount: string;
  lpSupply: bigint;
  coinCreator: string;
}

// Decode PumpSwap pool account data
function decodePumpSwapPool(data: Buffer): PumpSwapPool | null {
  try {
    const bs58 = require('bs58');

    // Check discriminator (first 8 bytes)
    const expectedDiscriminator = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
    if (!data.slice(0, 8).equals(expectedDiscriminator)) {
      return null;
    }

    let offset = 8;

    const poolBump = data.readUInt8(offset);
    offset += 1;

    const index = data.readUInt16LE(offset);
    offset += 2;

    const creator = bs58.encode(data.slice(offset, offset + 32));
    offset += 32;

    const baseMint = bs58.encode(data.slice(offset, offset + 32));
    offset += 32;

    const quoteMint = bs58.encode(data.slice(offset, offset + 32));
    offset += 32;

    const lpMint = bs58.encode(data.slice(offset, offset + 32));
    offset += 32;

    const poolBaseTokenAccount = bs58.encode(data.slice(offset, offset + 32));
    offset += 32;

    const poolQuoteTokenAccount = bs58.encode(data.slice(offset, offset + 32));
    offset += 32;

    const lpSupply = data.readBigUInt64LE(offset);
    offset += 8;

    const coinCreator = bs58.encode(data.slice(offset, offset + 32));

    return {
      poolBump,
      index,
      creator,
      baseMint,
      quoteMint,
      lpMint,
      poolBaseTokenAccount,
      poolQuoteTokenAccount,
      lpSupply,
      coinCreator,
    };
  } catch (err) {
    console.error('[ARB-BOT] Failed to decode PumpSwap pool:', err);
    return null;
  }
}

// Get token account balance (optimized: accepts connection to avoid creating new instances)
async function getTokenAccountBalance(connection: any, tokenAccount: string): Promise<number | null> {
  try {
    const { PublicKey } = await getSolana();
    const pubkey = new PublicKey(tokenAccount);

    const balance = await connection.getTokenAccountBalance(pubkey);
    return parseFloat(balance.value.uiAmountString || '0');
  } catch (err) {
    console.error(`[ARB-BOT] Failed to get token balance for ${tokenAccount}:`, err);
    return null;
  }
}

// Get PumpSwap pool price directly from on-chain data (optimized: accepts connection)
async function getPumpSwapPoolPrice(connection: any, poolAddress: string): Promise<PoolData | null> {
  try {
    const { PublicKey } = await getSolana();
    const pubkey = new PublicKey(poolAddress);

    // Fetch pool account
    const accountInfo = await connection.getAccountInfo(pubkey);
    if (!accountInfo || accountInfo.owner.toBase58() !== PUMPSWAP_PROGRAM) {
      return null;
    }

    // Decode pool data
    const pool = decodePumpSwapPool(accountInfo.data as Buffer);
    if (!pool) return null;

    // Fetch vault balances
    const [baseBalance, quoteBalance] = await Promise.all([
      getTokenAccountBalance(connection, pool.poolBaseTokenAccount),
      getTokenAccountBalance(connection, pool.poolQuoteTokenAccount),
    ]);

    if (!baseBalance || !quoteBalance || baseBalance === 0) return null;

    // Calculate price (SOL per token)
    const price = quoteBalance / baseBalance;

    // Estimate liquidity in USD (rough: assume SOL = $150)
    const liquidityUsd = quoteBalance * 2 * 150;

    return {
      address: poolAddress,
      dex: 'pumpswap',
      price,
      liquidity: liquidityUsd,
      baseSymbol: 'Token',
      quoteSymbol: 'SOL',
      baseMint: pool.baseMint,
      quoteMint: pool.quoteMint,
      baseReserve: baseBalance,
      quoteReserve: quoteBalance,
    };
  } catch (err) {
    console.error(`[ARB-BOT] Failed to get PumpSwap pool price for ${poolAddress}:`, err);
    return null;
  }
}

// DEX Program IDs
const DAMM_V2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const ORCA_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const RAYDIUM_AMM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Pool discovery cache
const poolCache = new Map<string, { pools: PoolData[], timestamp: number }>();
const POOL_CACHE_TTL = 30000; // 30 seconds

// Discover all pools for a token using ON-CHAIN queries (getProgramAccounts)
// Searches PumpSwap, Meteora DAMM, Meteora DLMM, Orca Whirlpool, Raydium CPMM/AMM/CLMM
// (optimized: accepts connection to avoid creating new instances)
async function discoverPools(connection: any, tokenMint: string): Promise<PoolData[]> {
  // Check cache first
  const cached = poolCache.get(tokenMint);
  if (cached && Date.now() - cached.timestamp < POOL_CACHE_TTL) {
    return cached.pools;
  }

  const { PublicKey } = await getSolana();
  const tokenMintPubkey = new PublicKey(tokenMint);
  const wsolMintPubkey = new PublicKey(WSOL_MINT);

  const pools: PoolData[] = [];

  // Query all DEXes in parallel
  const [pumpSwapPools, dammPools, dlmmPools, orcaPools, raydiumCpmmPools] = await Promise.allSettled([
    discoverPumpSwapPoolsOnChain(connection, tokenMintPubkey, wsolMintPubkey),
    discoverDammV2PoolsOnChain(connection, tokenMintPubkey, wsolMintPubkey),
    discoverDlmmPoolsOnChain(connection, tokenMintPubkey, wsolMintPubkey),
    discoverOrcaPoolsOnChain(connection, tokenMintPubkey, wsolMintPubkey),
    discoverRaydiumCpmmPoolsOnChain(connection, tokenMintPubkey, wsolMintPubkey),
  ]);

  // Collect successful results
  if (pumpSwapPools.status === 'fulfilled') pools.push(...pumpSwapPools.value);
  if (dammPools.status === 'fulfilled') pools.push(...dammPools.value);
  if (dlmmPools.status === 'fulfilled') pools.push(...dlmmPools.value);
  if (orcaPools.status === 'fulfilled') pools.push(...orcaPools.value);
  if (raydiumCpmmPools.status === 'fulfilled') pools.push(...raydiumCpmmPools.value);

  // Log discovery results with error details
  const getResult = (p: PromiseSettledResult<PoolData[]>) =>
    p.status === 'fulfilled' ? String(p.value.length) : `err:${(p as PromiseRejectedResult).reason?.message?.slice(0,50)}`;
  console.log(`[ARB-BOT] On-chain discovery for ${tokenMint.slice(0,8)}...: PumpSwap=${getResult(pumpSwapPools)}, DAMM=${getResult(dammPools)}, DLMM=${getResult(dlmmPools)}, Orca=${getResult(orcaPools)}, RaydiumCPMM=${getResult(raydiumCpmmPools)}`);

  // Sort by liquidity desc - note: liquidity may be 0 initially, fetched later
  pools.sort((a, b) => b.liquidity - a.liquidity);

  // Cache results
  poolCache.set(tokenMint, { pools, timestamp: Date.now() });

  return pools;
}

// PumpSwap pool discovery (on-chain)
async function discoverPumpSwapPoolsOnChain(connection: any, tokenMint: any, quoteMint: any): Promise<PoolData[]> {
  const pools: PoolData[] = [];
  const { PublicKey } = await getSolana();
  const bs58 = require('bs58');

  try {
    const accounts = await connection.getProgramAccounts(
      new PublicKey(PUMPSWAP_PROGRAM),
      {
        filters: [
          { dataSize: 301 },
          { memcmp: { offset: 43, bytes: tokenMint.toBase58() } },
          { memcmp: { offset: 75, bytes: quoteMint.toBase58() } },
        ],
      }
    );

    for (const { pubkey, account } of accounts) {
      const data = account.data as Buffer;
      const expectedDisc = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
      if (!data.slice(0, 8).equals(expectedDisc)) continue;

      const baseMint = bs58.encode(data.slice(43, 75));
      const quoteMintAddr = bs58.encode(data.slice(75, 107));
      const poolBaseVault = bs58.encode(data.slice(139, 171));
      const poolQuoteVault = bs58.encode(data.slice(171, 203));

      // Fetch vault balances
      const [baseBalance, quoteBalance] = await Promise.all([
        getTokenAccountBalance(connection, poolBaseVault),
        getTokenAccountBalance(connection, poolQuoteVault),
      ]);

      if (baseBalance && quoteBalance && baseBalance > 0) {
        const price = quoteBalance / baseBalance;
        const liquidityUsd = quoteBalance * 2 * 230; // Rough SOL price estimate

        pools.push({
          address: pubkey.toBase58(),
          dex: 'pumpswap',
          price,
          liquidity: liquidityUsd,
          baseSymbol: 'Token',
          quoteSymbol: 'SOL',
          baseMint,
          quoteMint: quoteMintAddr,
          baseReserve: baseBalance,
          quoteReserve: quoteBalance,
        });
      }
    }
  } catch (err) {
    console.error('[ARB-BOT] PumpSwap discovery error:', err);
  }

  return pools;
}

// Meteora DAMM V2 pool discovery (on-chain)
async function discoverDammV2PoolsOnChain(connection: any, tokenMint: any, quoteMint: any): Promise<PoolData[]> {
  const pools: PoolData[] = [];
  const { PublicKey } = await getSolana();
  const bs58 = require('bs58');

  try {
    // DAMM V2: token_a_mint at 168, token_b_mint at 200, vaults at 232/264
    const [poolsAB, poolsBA] = await Promise.all([
      connection.getProgramAccounts(new PublicKey(DAMM_V2_PROGRAM), {
        filters: [
          { memcmp: { offset: 168, bytes: tokenMint.toBase58() } },
          { memcmp: { offset: 200, bytes: quoteMint.toBase58() } },
        ],
      }),
      connection.getProgramAccounts(new PublicKey(DAMM_V2_PROGRAM), {
        filters: [
          { memcmp: { offset: 168, bytes: quoteMint.toBase58() } },
          { memcmp: { offset: 200, bytes: tokenMint.toBase58() } },
        ],
      }),
    ]);

    for (const { pubkey, account } of [...poolsAB, ...poolsBA]) {
      const data = account.data as Buffer;
      const tokenA = new PublicKey(data.slice(168, 200)).toBase58();
      const tokenB = new PublicKey(data.slice(200, 232)).toBase58();
      const vaultA = new PublicKey(data.slice(232, 264)).toBase58();
      const vaultB = new PublicKey(data.slice(264, 296)).toBase58();

      // Determine which is base/quote
      const isTokenBase = tokenA === tokenMint.toBase58();
      const baseVault = isTokenBase ? vaultA : vaultB;
      const quoteVault = isTokenBase ? vaultB : vaultA;

      const [baseBalance, quoteBalance] = await Promise.all([
        getTokenAccountBalance(connection, baseVault),
        getTokenAccountBalance(connection, quoteVault),
      ]);

      if (baseBalance && quoteBalance && baseBalance > 0) {
        const price = quoteBalance / baseBalance;
        const liquidityUsd = quoteBalance * 2 * 230;

        pools.push({
          address: pubkey.toBase58(),
          dex: 'meteora',
          price,
          liquidity: liquidityUsd,
          baseSymbol: 'Token',
          quoteSymbol: 'SOL',
          baseMint: isTokenBase ? tokenA : tokenB,
          quoteMint: isTokenBase ? tokenB : tokenA,
          baseReserve: baseBalance,
          quoteReserve: quoteBalance,
        });
      }
    }
  } catch (err) {
    console.error('[ARB-BOT] DAMM V2 discovery error:', err);
  }

  return pools;
}

// Meteora DLMM pool discovery (on-chain)
async function discoverDlmmPoolsOnChain(connection: any, tokenMint: any, quoteMint: any): Promise<PoolData[]> {
  const pools: PoolData[] = [];
  const { PublicKey } = await getSolana();
  const bs58 = require('bs58');

  try {
    // DLMM LbPair: tokenXMint at 88, tokenYMint at 120, reserveX at 152, reserveY at 184
    const [poolsAB, poolsBA] = await Promise.all([
      connection.getProgramAccounts(new PublicKey(METEORA_DLMM_PROGRAM), {
        filters: [
          { memcmp: { offset: 88, bytes: tokenMint.toBase58() } },
          { memcmp: { offset: 120, bytes: quoteMint.toBase58() } },
        ],
      }),
      connection.getProgramAccounts(new PublicKey(METEORA_DLMM_PROGRAM), {
        filters: [
          { memcmp: { offset: 88, bytes: quoteMint.toBase58() } },
          { memcmp: { offset: 120, bytes: tokenMint.toBase58() } },
        ],
      }),
    ]);

    for (const { pubkey, account } of [...poolsAB, ...poolsBA]) {
      const data = account.data as Buffer;
      const tokenXMint = bs58.encode(data.slice(88, 120));
      const tokenYMint = bs58.encode(data.slice(120, 152));
      const reserveX = bs58.encode(data.slice(152, 184));
      const reserveY = bs58.encode(data.slice(184, 216));

      const isTokenBase = tokenXMint === tokenMint.toBase58();
      const baseVault = isTokenBase ? reserveX : reserveY;
      const quoteVault = isTokenBase ? reserveY : reserveX;

      const [baseBalance, quoteBalance] = await Promise.all([
        getTokenAccountBalance(connection, baseVault),
        getTokenAccountBalance(connection, quoteVault),
      ]);

      if (baseBalance && quoteBalance && baseBalance > 0) {
        const price = quoteBalance / baseBalance;
        const liquidityUsd = quoteBalance * 2 * 230;

        pools.push({
          address: pubkey.toBase58(),
          dex: 'meteora_dlmm',
          price,
          liquidity: liquidityUsd,
          baseSymbol: 'Token',
          quoteSymbol: 'SOL',
          baseMint: isTokenBase ? tokenXMint : tokenYMint,
          quoteMint: isTokenBase ? tokenYMint : tokenXMint,
          baseReserve: baseBalance,
          quoteReserve: quoteBalance,
        });
      }
    }
  } catch (err) {
    console.error('[ARB-BOT] DLMM discovery error:', err);
  }

  return pools;
}

// Orca Whirlpool pool discovery (on-chain)
async function discoverOrcaPoolsOnChain(connection: any, tokenMint: any, quoteMint: any): Promise<PoolData[]> {
  const pools: PoolData[] = [];
  const { PublicKey } = await getSolana();
  const bs58 = require('bs58');

  try {
    // Orca Whirlpool: tokenMintA at 101, tokenMintB at 181, size 653
    const [poolsAB, poolsBA] = await Promise.all([
      connection.getProgramAccounts(new PublicKey(ORCA_WHIRLPOOL_PROGRAM), {
        filters: [
          { dataSize: 653 },
          { memcmp: { offset: 101, bytes: tokenMint.toBase58() } },
          { memcmp: { offset: 181, bytes: quoteMint.toBase58() } },
        ],
      }),
      connection.getProgramAccounts(new PublicKey(ORCA_WHIRLPOOL_PROGRAM), {
        filters: [
          { dataSize: 653 },
          { memcmp: { offset: 101, bytes: quoteMint.toBase58() } },
          { memcmp: { offset: 181, bytes: tokenMint.toBase58() } },
        ],
      }),
    ]);

    for (const { pubkey, account } of [...poolsAB, ...poolsBA]) {
      const data = account.data as Buffer;
      const tokenMintA = bs58.encode(data.slice(101, 133));
      const tokenVaultA = bs58.encode(data.slice(133, 165));
      const tokenMintB = bs58.encode(data.slice(181, 213));
      const tokenVaultB = bs58.encode(data.slice(213, 245));

      const isTokenBase = tokenMintA === tokenMint.toBase58();
      const baseVault = isTokenBase ? tokenVaultA : tokenVaultB;
      const quoteVault = isTokenBase ? tokenVaultB : tokenVaultA;

      const [baseBalance, quoteBalance] = await Promise.all([
        getTokenAccountBalance(connection, baseVault),
        getTokenAccountBalance(connection, quoteVault),
      ]);

      if (baseBalance && quoteBalance && baseBalance > 0) {
        const price = quoteBalance / baseBalance;
        const liquidityUsd = quoteBalance * 2 * 230;

        pools.push({
          address: pubkey.toBase58(),
          dex: 'orca',
          price,
          liquidity: liquidityUsd,
          baseSymbol: 'Token',
          quoteSymbol: 'SOL',
          baseMint: isTokenBase ? tokenMintA : tokenMintB,
          quoteMint: isTokenBase ? tokenMintB : tokenMintA,
          baseReserve: baseBalance,
          quoteReserve: quoteBalance,
        });
      }
    }
  } catch (err) {
    console.error('[ARB-BOT] Orca discovery error:', err);
  }

  return pools;
}

// Raydium CPMM pool discovery (on-chain)
async function discoverRaydiumCpmmPoolsOnChain(connection: any, tokenMint: any, quoteMint: any): Promise<PoolData[]> {
  const pools: PoolData[] = [];
  const { PublicKey } = await getSolana();
  const bs58 = require('bs58');

  try {
    // Raydium CPMM: mint0 at 72, mint1 at 104, size 637
    const [poolsAB, poolsBA] = await Promise.all([
      connection.getProgramAccounts(new PublicKey(RAYDIUM_CPMM_PROGRAM), {
        filters: [
          { dataSize: 637 },
          { memcmp: { offset: 72, bytes: tokenMint.toBase58() } },
          { memcmp: { offset: 104, bytes: quoteMint.toBase58() } },
        ],
      }),
      connection.getProgramAccounts(new PublicKey(RAYDIUM_CPMM_PROGRAM), {
        filters: [
          { dataSize: 637 },
          { memcmp: { offset: 72, bytes: quoteMint.toBase58() } },
          { memcmp: { offset: 104, bytes: tokenMint.toBase58() } },
        ],
      }),
    ]);

    for (const { pubkey, account } of [...poolsAB, ...poolsBA]) {
      const data = account.data as Buffer;
      const mint0 = bs58.encode(data.slice(72, 104));
      const mint1 = bs58.encode(data.slice(104, 136));
      const vault0 = bs58.encode(data.slice(168, 200));
      const vault1 = bs58.encode(data.slice(200, 232));

      const isTokenBase = mint0 === tokenMint.toBase58();
      const baseVault = isTokenBase ? vault0 : vault1;
      const quoteVault = isTokenBase ? vault1 : vault0;

      const [baseBalance, quoteBalance] = await Promise.all([
        getTokenAccountBalance(connection, baseVault),
        getTokenAccountBalance(connection, quoteVault),
      ]);

      if (baseBalance && quoteBalance && baseBalance > 0) {
        const price = quoteBalance / baseBalance;
        const liquidityUsd = quoteBalance * 2 * 230;

        pools.push({
          address: pubkey.toBase58(),
          dex: 'raydium',
          price,
          liquidity: liquidityUsd,
          baseSymbol: 'Token',
          quoteSymbol: 'SOL',
          baseMint: isTokenBase ? mint0 : mint1,
          quoteMint: isTokenBase ? mint1 : mint0,
          baseReserve: baseBalance,
          quoteReserve: quoteBalance,
        });
      }
    }
  } catch (err) {
    console.error('[ARB-BOT] Raydium CPMM discovery error:', err);
  }

  return pools;
}


// Estimate slippage based on trade size and pool liquidity
// Uses constant product formula approximation: slippage ≈ tradeSize / (2 * liquidity)
function estimateSlippage(tradeSizeUsd: number, liquidityUsd: number): number {
  if (liquidityUsd <= 0) return 10000; // 100% slippage if no liquidity
  // For AMMs: price impact ≈ tradeSize / liquidity (simplified)
  // More accurate: slippage = tradeSize / (liquidity + tradeSize)
  const slippagePct = (tradeSizeUsd / (liquidityUsd + tradeSizeUsd)) * 100;
  return slippagePct * 100; // Return in basis points
}

// Calculate optimal trade size for a pool (don't use more than 2% of liquidity)
function calculateOptimalTradeSize(liquidityUsd: number, maxTradeSizeUsd: number): number {
  // Rule: Don't trade more than 2% of pool liquidity to keep slippage reasonable
  const maxByLiquidity = liquidityUsd * 0.02;
  return Math.min(maxTradeSizeUsd, maxByLiquidity);
}

// Calculate arbitrage opportunity with slippage consideration
// For rToken/SOL pools, we compare pool price to the underlying token's price
// rToken should trade at ~same price as underlying (minus fees)
function calculateArbOpportunity(
  poolPriceInSol: number,  // How much SOL per rToken in the pool
  underlyingPriceInSol: number,  // How much SOL per underlying token (fair value)
  wrapFeeBps: number,
  unwrapFeeBps: number,
  transferFeeBps: number,
  direction: 'wrap' | 'unwrap',
  liquidityUsd: number = 0,
  tradeSizeUsd: number = 500
): { profitBps: number; route: string; details: string; optimalSize: number; slippageBps: number } {
  // Fair price of rToken = underlying price (they should be 1:1 redeemable)
  const fairPrice = underlyingPriceInSol;

  // Calculate optimal trade size based on liquidity
  const optimalSize = liquidityUsd > 0 ? calculateOptimalTradeSize(liquidityUsd, tradeSizeUsd) : tradeSizeUsd;

  // Estimate slippage for this trade
  const slippageBps = liquidityUsd > 0 ? estimateSlippage(optimalSize, liquidityUsd) : 0;

  if (direction === 'wrap') {
    // WRAP route: Buy underlying → Wrap to rToken → Sell rToken on DEX
    // Profitable when rToken trades ABOVE fair price (premium)
    const totalFeesBps = wrapFeeBps + transferFeeBps + slippageBps;
    const premium = poolPriceInSol - fairPrice;
    const premiumBps = (premium / fairPrice) * 10000;
    const profitBps = premiumBps - totalFeesBps;
    return {
      profitBps,
      route: 'WRAP',
      details: `Pool: ${poolPriceInSol.toFixed(8)} SOL, Fair: ${fairPrice.toFixed(8)} SOL, Premium: ${(premiumBps/100).toFixed(2)}%`,
      optimalSize,
      slippageBps
    };
  } else {
    // UNWRAP route: Buy rToken on DEX → Unwrap to underlying → Sell underlying
    // Profitable when rToken trades BELOW fair price (discount)
    const totalFeesBps = unwrapFeeBps + transferFeeBps + slippageBps;
    const discount = fairPrice - poolPriceInSol;
    const discountBps = (discount / fairPrice) * 10000;
    const profitBps = discountBps - totalFeesBps;
    return {
      profitBps,
      route: 'UNWRAP',
      details: `Pool: ${poolPriceInSol.toFixed(8)} SOL, Fair: ${fairPrice.toFixed(8)} SOL, Discount: ${(discountBps/100).toFixed(2)}%`,
      optimalSize,
      slippageBps
    };
  }
}

// Cache for rift data to avoid repeated API calls
let riftCache: { data: any; timestamp: number } | null = null;
const RIFT_CACHE_TTL = 60000; // 1 minute

async function getRiftData(): Promise<any[]> {
  // Check cache
  if (riftCache && Date.now() - riftCache.timestamp < RIFT_CACHE_TTL) {
    return riftCache.data;
  }

  // Fetch from Supabase directly instead of internal API
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://nitmreqtsnzjylyzwsri.supabase.co';
  const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pdG1yZXF0c256anlseXp3c3JpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI1NjkyNDIsImV4cCI6MjA3ODE0NTI0Mn0.79J6IKGOTVeHGCj4A6oXG-Aj8hOh6vrylwK5rtJ8g9U';

  const response = await fetch(`${SUPABASE_URL}/rest/v1/rifts?select=*`, {
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch rifts from Supabase');
  }

  const riftsData = await response.json();

  // Transform to expected format - data is nested in raw_data
  const rifts = riftsData.map((rift: any) => {
    const raw = rift.raw_data || {};

    // Get meteora pools - can be single pool in liquidityPool or array in meteoraPools
    let meteoraPools: string[] = [];
    if (raw.meteoraPools && Array.isArray(raw.meteoraPools)) {
      meteoraPools = raw.meteoraPools;
    } else if (raw.liquidityPool) {
      meteoraPools = [raw.liquidityPool];
    }

    // Determine correct symbol with prefix based on prefixType (0 = r, 1 = m)
    const prefix = raw.prefixType === 1 ? 'm' : 'r';
    const baseSymbol = raw.underlying || rift.name?.replace(/^[rm]/i, '') || 'UNKNOWN';
    const displaySymbol = raw.symbol || `${prefix}${baseSymbol}`;

    return {
      id: rift.id,
      symbol: baseSymbol,
      rSymbol: displaySymbol,
      underlying: raw.underlying || 'SOL',
      riftMint: rift.token_mint || raw.riftMint,
      underlyingMint: raw.underlyingMint,
      vault: raw.vault,
      meteoraPools,
      hasMeteoraPool: raw.hasMeteoraPool || meteoraPools.length > 0,
      wrapFeeBps: raw.wrapFeeBps || 30,
      unwrapFeeBps: raw.unwrapFeeBps || 30,
      transferFeeBps: raw.transferFeeBps || 70,
      underlyingTokenPriceUsd: raw.underlyingTokenPrice || 0,
      riftTokenPriceUsd: raw.riftTokenPrice || 0,
      creator: raw.creator || '',
      partnerWallet: raw.partnerWallet || '',
      tvl: raw.tvl || 0, // TVL in USD
    };
  });

  riftCache = { data: rifts, timestamp: Date.now() };
  return rifts;
}

// Scanner loop for a bot instance
async function runScanner(botId: string) {
  const bot = botInstances.get(botId);
  if (!bot || bot.status !== 'running') return;

  try {
    // Get singleton connection for all RPC calls in this scan
    const { getLaserstreamConnection } = await getSolana();
    const connection = await getLaserstreamConnection();

    // Fetch rift config
    const rifts = await getRiftData();
    const rift = rifts.find((r: any) => r.id === bot.riftId);

    if (!rift) {
      addLog(bot, 'error', `Rift not found: ${bot.riftId}`);
      return;
    }

    // Discover ALL pools for both rToken AND underlying token
    const [rTokenPools, underlyingPools] = await Promise.all([
      discoverPools(connection, rift.riftMint),
      discoverPools(connection, rift.underlyingMint)
    ]);

    // Get best underlying price from highest liquidity pool
    const underlyingPrice = underlyingPools.length > 0 ? underlyingPools[0].price : null;

    // Log underlying token pools first
    if (underlyingPools.length > 0) {
      const underlyingByDex = underlyingPools.reduce((acc: Record<string, number>, p) => {
        acc[p.dex] = (acc[p.dex] || 0) + 1;
        return acc;
      }, {});
      const underlyingSummary = Object.entries(underlyingByDex).map(([dex, count]) => `${dex}:${count}`).join(', ');
      addLog(bot, 'scan', `${rift.symbol} pools: ${underlyingPools.length} [${underlyingSummary}]`);

      // Show all underlying pools
      for (const pool of underlyingPools.slice(0, 5)) {
        addLog(bot, 'scan', `  └─ [${pool.dex.toUpperCase()}] ${pool.price.toFixed(8)} SOL | Liq: $${pool.liquidity.toFixed(0)}`);
      }
    }

    if (rTokenPools.length === 0) {
      addLog(bot, 'info', `No DEX pools found for ${rift.rSymbol}`);
      return;
    }

    // Group pools by DEX type for better logging
    const poolsByDex = rTokenPools.reduce((acc: Record<string, number>, p) => {
      acc[p.dex] = (acc[p.dex] || 0) + 1;
      return acc;
    }, {});
    const dexSummary = Object.entries(poolsByDex).map(([dex, count]) => `${dex}:${count}`).join(', ');

    addLog(bot, 'scan', `Found ${rTokenPools.length} pool(s) for ${rift.rSymbol} [${dexSummary}]${underlyingPrice ? ` | ${rift.symbol}: ${underlyingPrice.toFixed(8)} SOL` : ''}`);

    // Get max trade size from config
    const maxTradeSize = bot.config.maxTradeSize || 500;

    // Track best opportunities across ALL pools
    interface ArbOpportunity {
      pool: PoolData;
      direction: 'wrap' | 'unwrap';
      profitBps: number;
      route: string;
      details: string;
      optimalSize: number;
      slippageBps: number;
    }

    const allOpportunities: ArbOpportunity[] = [];

    // Check each pool for arbitrage opportunities
    for (const pool of rTokenPools) {
      // Calculate optimal trade size for this pool's liquidity
      const optimalSize = calculateOptimalTradeSize(pool.liquidity, maxTradeSize);
      const slippageEst = estimateSlippage(optimalSize, pool.liquidity);

      // Log pool state with liquidity info
      const reserveInfo = pool.baseReserve && pool.quoteReserve
        ? ` | Reserves: ${pool.baseReserve.toLocaleString()} / ${pool.quoteReserve.toFixed(2)} SOL`
        : '';
      const sizeInfo = ` | Max: $${optimalSize.toFixed(0)} (~${(slippageEst/100).toFixed(2)}% slip)`;
      addLog(bot, 'scan', `[${pool.dex.toUpperCase()}] ${pool.baseSymbol}/${pool.quoteSymbol}: ${pool.price.toFixed(8)} SOL | Liq: $${pool.liquidity.toFixed(0)}${sizeInfo}${reserveInfo}`);

      // If we have underlying price, calculate arbitrage WITH slippage
      if (underlyingPrice && underlyingPrice > 0) {
        // Check WRAP direction (profitable when rToken trades at premium)
        const wrapArb = calculateArbOpportunity(
          pool.price,
          underlyingPrice,
          rift.wrapFeeBps,
          rift.unwrapFeeBps,
          rift.transferFeeBps,
          'wrap',
          pool.liquidity,
          maxTradeSize
        );

        // Check UNWRAP direction (profitable when rToken trades at discount)
        const unwrapArb = calculateArbOpportunity(
          pool.price,
          underlyingPrice,
          rift.wrapFeeBps,
          rift.unwrapFeeBps,
          rift.transferFeeBps,
          'unwrap',
          pool.liquidity,
          maxTradeSize
        );

        // Store both opportunities for comparison (include negative for ranking)
        allOpportunities.push({
          pool,
          direction: 'wrap',
          profitBps: wrapArb.profitBps,
          route: wrapArb.route,
          details: wrapArb.details,
          optimalSize: wrapArb.optimalSize,
          slippageBps: wrapArb.slippageBps
        });
        allOpportunities.push({
          pool,
          direction: 'unwrap',
          profitBps: unwrapArb.profitBps,
          route: unwrapArb.route,
          details: unwrapArb.details,
          optimalSize: unwrapArb.optimalSize,
          slippageBps: unwrapArb.slippageBps
        });
      }
    }

    // Sort all opportunities by profit (highest first)
    allOpportunities.sort((a, b) => b.profitBps - a.profitBps);

    // If no underlying price available
    if (!underlyingPrice || underlyingPrice <= 0) {
      addLog(bot, 'info', `No underlying price for ${rift.symbol} - showing pool data only`);
    } else if (allOpportunities.length === 0) {
      addLog(bot, 'scan', `No profitable routes found (all negative after fees)`);
    } else {
      // Filter to only positive profit opportunities
      const positiveOps = allOpportunities.filter(op => op.profitBps > 0);
      const profitableOps = allOpportunities.filter(op => op.profitBps >= bot.config.minProfitBps);

      if (profitableOps.length > 0) {
        // Find the BEST opportunity across all DEXes
        const bestOp = profitableOps[0];
        bot.stats.opportunitiesFound++;

        // Show opportunity with optimal trade size and slippage info
        addLog(bot, 'opportunity', `🎯 BEST: [${bestOp.pool.dex.toUpperCase()}] ${bestOp.route} @ ${(bestOp.profitBps / 100).toFixed(2)}% | Size: $${bestOp.optimalSize.toFixed(0)} | Slip: ${(bestOp.slippageBps/100).toFixed(2)}%`, {
          pool: bestOp.pool.address,
          dex: bestOp.pool.dex,
          profitBps: bestOp.profitBps,
          route: bestOp.route,
          poolPrice: bestOp.pool.price,
          underlyingPrice,
          liquidity: bestOp.pool.liquidity,
          optimalSize: bestOp.optimalSize,
          slippageBps: bestOp.slippageBps
        });

        // Show comparison with other DEXes if there are alternatives
        if (profitableOps.length > 1) {
          const alternatives = profitableOps.slice(1, 4).map(op =>
            `${op.pool.dex.toUpperCase()}:${(op.profitBps / 100).toFixed(2)}%/$${op.optimalSize.toFixed(0)}`
          ).join(', ');
          addLog(bot, 'scan', `Alt routes: ${alternatives}`);
        }
      } else if (positiveOps.length > 0) {
        // Show best available (positive but below threshold)
        const bestAvailable = positiveOps[0];
        addLog(bot, 'scan', `Best: [${bestAvailable.pool.dex.toUpperCase()}] ${bestAvailable.route} @ ${(bestAvailable.profitBps / 100).toFixed(2)}% (need ${(bot.config.minProfitBps/100).toFixed(2)}%) | Size: $${bestAvailable.optimalSize.toFixed(0)}`);
      } else {
        // All negative - show the least negative
        const leastBad = allOpportunities[0];
        addLog(bot, 'scan', `No profit: Best is ${leastBad.route} @ ${(leastBad.profitBps / 100).toFixed(2)}% (fees > spread)`);
      }
    }

    bot.stats.scansCompleted = (bot.stats.scansCompleted || 0) + 1;
    bot.stats.lastCheck = new Date().toISOString();
  } catch (error) {
    addLog(bot, 'error', `Scanner error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Admin wallet that can access all rifts
const ADMIN_WALLET = '9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4';

// Check if wallet has permission to manage a rift
async function checkRiftPermission(walletAddress: string, riftId: string): Promise<{ allowed: boolean; error?: string; rift?: any }> {
  // Admin can do anything
  if (walletAddress === ADMIN_WALLET) return { allowed: true };

  // Fetch rift data to check creator/partner
  const rifts = await getRiftData();
  const rift = rifts.find((r: any) => r.id === riftId);

  if (!rift) {
    return { allowed: false, error: 'Rift not found' };
  }

  // Check if wallet is creator or partner
  const creator = rift.creator;
  const partnerWallet = rift.partnerWallet;

  if (walletAddress === creator || walletAddress === partnerWallet) {
    return { allowed: true, rift };
  }

  return { allowed: false, error: 'Only the rift creator, partner wallet, or admin can manage this bot' };
}

// Check if a bot is already running for this rift (by any wallet)
function isRiftBotRunning(riftId: string): { running: boolean; runningBy?: string } {
  for (const [botId, bot] of botInstances) {
    if (bot.riftId === riftId && bot.status === 'running') {
      return { running: true, runningBy: bot.walletAddress };
    }
  }
  return { running: false };
}

// ==================== SUPABASE BOT PERSISTENCE ====================

// Get bot config from Supabase by rift_id
async function getSupabaseBotConfig(riftId: string): Promise<any | null> {
  try {
    const result = await supabaseFetch(`arb_bot_configs?rift_id=eq.${riftId}&select=*`);
    return result && result.length > 0 ? result[0] : null;
  } catch (err) {
    console.error('[ARB-BOT] Failed to get bot config from Supabase:', err);
    return null;
  }
}

// Get all bot configs for a wallet from Supabase
async function getSupabaseBotsByWallet(walletAddress: string): Promise<any[]> {
  try {
    const result = await supabaseFetch(`arb_bot_configs?wallet_address=eq.${walletAddress}&select=*`);
    return result || [];
  } catch (err) {
    console.error('[ARB-BOT] Failed to get bots from Supabase:', err);
    return [];
  }
}

// Create or update bot config in Supabase
async function upsertSupabaseBotConfig(bot: {
  rift_id: string;
  rift_mint: string;
  underlying_mint: string;
  symbol: string;
  r_symbol: string;
  wallet_address: string;
  status: string;
  config: any;
  stats?: any;
}): Promise<any | null> {
  try {
    // Check if bot exists
    const existing = await getSupabaseBotConfig(bot.rift_id);

    if (existing) {
      // Update existing
      await supabaseFetch(`arb_bot_configs?id=eq.${existing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: bot.status,
          config: bot.config,
          stats: bot.stats || existing.stats,
          updated_at: new Date().toISOString(),
        }),
      });
      return { ...existing, ...bot };
    } else {
      // Create new
      const result = await supabaseFetch('arb_bot_configs', {
        method: 'POST',
        body: JSON.stringify({
          ...bot,
          stats: bot.stats || { scans: 0, opportunities: 0, trades: 0 },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });
      return result && result.length > 0 ? result[0] : null;
    }
  } catch (err) {
    console.error('[ARB-BOT] Failed to upsert bot config:', err);
    return null;
  }
}

// Update bot status in Supabase
async function updateSupabaseBotStatus(riftId: string, status: string, stats?: any): Promise<boolean> {
  try {
    const existing = await getSupabaseBotConfig(riftId);
    if (!existing) return false;

    const updateData: any = {
      status,
      updated_at: new Date().toISOString(),
    };
    if (stats) {
      updateData.stats = stats;
      updateData.last_scan = new Date().toISOString();
    }

    await supabaseFetch(`arb_bot_configs?id=eq.${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify(updateData),
    });
    return true;
  } catch (err) {
    console.error('[ARB-BOT] Failed to update bot status:', err);
    return false;
  }
}

// Log to Supabase bot logs
async function logToSupabase(botId: string, type: string, message: string, data?: any): Promise<void> {
  try {
    await supabaseFetch('arb_bot_logs', {
      method: 'POST',
      body: JSON.stringify({
        bot_id: botId,
        type,
        message,
        data,
        created_at: new Date().toISOString(),
      }),
    });
  } catch (err) {
    // Silent fail for logs
  }
}

// Get recent logs for a bot from Supabase
async function getSupabaseBotLogs(botId: string, limit: number = 50): Promise<any[]> {
  try {
    const result = await supabaseFetch(
      `arb_bot_logs?bot_id=eq.${botId}&select=*&order=created_at.desc&limit=${limit}`
    );
    return (result || []).reverse(); // Return in chronological order
  } catch (err) {
    console.error('[ARB-BOT] Failed to get logs from Supabase:', err);
    return [];
  }
}

// Check if rift has a running bot in Supabase
async function isSupabaseRiftBotRunning(riftId: string): Promise<{ running: boolean; runningBy?: string; botId?: string }> {
  try {
    const bot = await getSupabaseBotConfig(riftId);
    if (bot && bot.status === 'running') {
      return { running: true, runningBy: bot.wallet_address, botId: bot.id };
    }
    return { running: false };
  } catch (err) {
    return { running: false };
  }
}

// Get ALL running bots globally (not filtered by wallet) - for performance summary
async function getAllRunningBots(): Promise<any[]> {
  try {
    const result = await supabaseFetch(`arb_bot_configs?status=eq.running&select=*`);
    return result || [];
  } catch (err) {
    console.error('[ARB-BOT] Failed to get all running bots from Supabase:', err);
    return [];
  }
}

// Get ALL bots globally (for full summary)
async function getAllBots(): Promise<any[]> {
  try {
    const result = await supabaseFetch(`arb_bot_configs?select=*&order=updated_at.desc`);
    return result || [];
  } catch (err) {
    console.error('[ARB-BOT] Failed to get all bots from Supabase:', err);
    return [];
  }
}

// Check and auto-stop bots for rifts with TVL < $100
async function autoStopLowTvlBots(): Promise<{ stopped: string[], checked: number }> {
  const stopped: string[] = [];
  let checked = 0;

  try {
    // Get all running bots
    const runningBots = await getAllRunningBots();
    if (runningBots.length === 0) return { stopped, checked: 0 };

    // Fetch fresh rift data (bypass cache to get current TVL)
    riftCache = null; // Clear cache to get fresh data
    const rifts = await getRiftData();

    for (const bot of runningBots) {
      checked++;
      const rift = rifts.find((r: any) => r.id === bot.rift_id);

      if (!rift) {
        console.log(`[ARB-BOT] Auto-stop: Rift ${bot.rift_id} not found, stopping bot`);
        await updateSupabaseBotStatus(bot.rift_id, 'stopped', {
          ...bot.stats,
          autoStoppedReason: 'Rift not found'
        });
        stopped.push(bot.rift_id);
        continue;
      }

      const tvl = rift.tvl || 0;
      if (tvl < MIN_TVL_USD) {
        console.log(`[ARB-BOT] Auto-stop: ${rift.rSymbol} TVL $${tvl.toFixed(2)} < $${MIN_TVL_USD} minimum`);

        // Log the auto-stop
        if (bot.id) {
          await logToSupabase(bot.id, 'info', `Bot auto-stopped: TVL $${tvl.toFixed(2)} below $${MIN_TVL_USD} minimum`);
        }

        // Stop the bot
        await updateSupabaseBotStatus(bot.rift_id, 'stopped', {
          ...bot.stats,
          autoStoppedReason: `TVL below $${MIN_TVL_USD} minimum`,
          tvlAtStop: tvl
        });

        // Also stop local instance if exists
        for (const [botId, localBot] of botInstances) {
          if (localBot.riftId === bot.rift_id && localBot.status === 'running') {
            localBot.status = 'stopped';
            addLog(localBot, 'info', `Auto-stopped: TVL $${tvl.toFixed(2)} below $${MIN_TVL_USD} minimum`);
            if (localBot.intervalId) {
              clearInterval(localBot.intervalId);
            }
          }
        }

        stopped.push(bot.rift_id);
      }
    }
  } catch (err) {
    console.error('[ARB-BOT] Error in autoStopLowTvlBots:', err);
  }

  if (stopped.length > 0) {
    console.log(`[ARB-BOT] Auto-stopped ${stopped.length} bot(s) due to low TVL`);
  }

  return { stopped, checked };
}

// POST - Start/Stop bot (persists to Supabase for standalone service)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, walletAddress, riftId, config } = body;

    if (!walletAddress) {
      return NextResponse.json({ error: 'Wallet address required' }, { status: 400 });
    }

    const botId = `${walletAddress}-${riftId}`;

    if (action === 'start') {
      if (!riftId) {
        return NextResponse.json({ error: 'Rift ID required' }, { status: 400 });
      }

      // Check wallet permissions
      const permission = await checkRiftPermission(walletAddress, riftId);
      if (!permission.allowed) {
        return NextResponse.json({ error: permission.error }, { status: 403 });
      }

      // Check if ANY bot is already running for this rift (check both local and Supabase)
      const localStatus = isRiftBotRunning(riftId);
      const supabaseStatus = await isSupabaseRiftBotRunning(riftId);

      if (localStatus.running || supabaseStatus.running) {
        const runningBy = localStatus.runningBy || supabaseStatus.runningBy;
        return NextResponse.json({
          error: `A bot is already running for this rift${runningBy !== walletAddress ? ' by another wallet' : ''}`
        }, { status: 400 });
      }

      // Validate maxTradeSize (limit to 2500 USD)
      const maxTradeSize = Math.min(config?.maxTradeSize || 500, 2500);

      // Get rift data for persistence
      const rifts = await getRiftData();
      const rift = rifts.find((r: any) => r.id === riftId);

      if (!rift) {
        return NextResponse.json({ error: 'Rift not found' }, { status: 404 });
      }

      // Check minimum TVL requirement
      const riftTvl = rift.tvl || 0;
      if (riftTvl < MIN_TVL_USD) {
        return NextResponse.json({
          error: `Cannot start bot: TVL ($${riftTvl.toFixed(2)}) is below minimum $${MIN_TVL_USD} requirement`
        }, { status: 400 });
      }

      // Persist bot config to Supabase for standalone service
      const botConfig = {
        rift_id: riftId,
        rift_mint: rift.riftMint || '',
        underlying_mint: rift.underlyingMint || '',
        symbol: rift.symbol || 'UNKNOWN',
        r_symbol: body.riftSymbol || rift.rSymbol || 'Unknown',
        wallet_address: walletAddress,
        status: 'running',
        config: {
          min_profit_bps: config?.minProfitBps || 50,
          max_slippage_bps: config?.maxSlippageBps || 100,
          max_trade_size: maxTradeSize,
          wrap_fee_bps: rift.wrapFeeBps || 30,
          unwrap_fee_bps: rift.unwrapFeeBps || 30,
          transfer_fee_bps: rift.transferFeeBps || 70,
          auto_trade: config?.autoTrade || false,
        },
        stats: { scans: 0, opportunities: 0, trades: 0, total_profit: 0 },
      };

      const savedBot = await upsertSupabaseBotConfig(botConfig);

      // Also create local instance for immediate feedback (web-based scanning)
      const bot: BotInstance = {
        riftId,
        riftSymbol: body.riftSymbol || rift.rSymbol || 'Unknown',
        walletAddress,
        status: 'starting',
        startedAt: Date.now(),
        stats: {
          opportunitiesFound: 0,
          tradesExecuted: 0,
          totalProfit: 0,
          lastCheck: '-',
          scansCompleted: 0
        },
        logs: [],
        config: {
          minProfitBps: config?.minProfitBps || 50,
          maxSlippageBps: config?.maxSlippageBps || 100,
          maxTradeSize: maxTradeSize
        }
      };

      botInstances.set(botId, bot);

      // Mark as running - the external arb-bot-service.js handles actual scanning
      // We don't run the local scanner to avoid duplicate/conflicting scans
      bot.status = 'running';
      addLog(bot, 'info', `Bot registered for ${bot.riftSymbol} - external service handles scanning`);

      // Log to Supabase
      if (savedBot?.id) {
        await logToSupabase(savedBot.id, 'info', `Bot started with min profit ${(bot.config.minProfitBps / 100).toFixed(2)}%, max trade $${maxTradeSize}`);
      }

      // NOTE: Scanner is disabled here - arb-bot-service.js running externally handles all scanning
      // This prevents duplicate scans and conflicting logs
      // bot.intervalId = setInterval(() => runScanner(botId), 5000);
      // runScanner(botId);

      return NextResponse.json({
        success: true,
        botId: savedBot?.id || botId,
        status: 'running',
        message: 'Bot started successfully (external service handles scanning)',
        persistent: !!savedBot
      });

    } else if (action === 'stop') {
      // Stop local instance
      const bot = botInstances.get(botId);
      if (bot) {
        bot.status = 'stopping';
        addLog(bot, 'info', `Bot stopped. Total scans: ${bot.stats.scansCompleted}, Opportunities: ${bot.stats.opportunitiesFound}`);

        if (bot.intervalId) {
          clearInterval(bot.intervalId);
        }

        bot.status = 'stopped';
      }

      // Update Supabase status to stopped
      const updated = await updateSupabaseBotStatus(riftId, 'stopped', bot?.stats ? {
        scans: bot.stats.scansCompleted,
        opportunities: bot.stats.opportunitiesFound,
        trades: bot.stats.tradesExecuted,
        total_profit: bot.stats.totalProfit,
      } : undefined);

      // Log to Supabase
      const supabaseBot = await getSupabaseBotConfig(riftId);
      if (supabaseBot?.id) {
        await logToSupabase(supabaseBot.id, 'info', `Bot stopped by user`);
      }

      return NextResponse.json({
        success: true,
        botId,
        status: 'stopped',
        stats: bot?.stats,
        logs: bot?.logs || [],
        message: 'Bot stopped successfully',
        persistent: updated
      });

    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

  } catch (error) {
    console.error('[ARB-BOT] Error:', error);
    return NextResponse.json(
      { error: 'Failed to process request' },
      { status: 500 }
    );
  }
}

// GET - Get bot status or list all sessions (checks both local and Supabase)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get('wallet');
    const riftId = searchParams.get('riftId');
    const action = searchParams.get('action');

    if (!walletAddress) {
      return NextResponse.json({ error: 'Wallet address required' }, { status: 400 });
    }

    // List ALL bot sessions globally (not just wallet's bots)
    // This ensures all users see all running bots in performance summary
    if (action === 'list') {
      // Auto-stop any bots with TVL < $100 before listing
      const autoStopResult = await autoStopLowTvlBots();

      // Fetch persisted stats from arb_bot_stats and arb_bot_trades for accurate stats
      const persistedStatsMap = new Map<string, { opportunities: number; trades: number; profit: number }>();
      const pageSize = 1000;
      try {
        // Fetch opportunities from arb_bot_stats (paginated - can have 1000+ records)
        let statsOffset = 0;
        while (true) {
          const statsData = await supabaseFetch(`arb_bot_stats?select=rift_id,opportunities_detected&limit=${pageSize}&offset=${statsOffset}`);
          if (!statsData || !Array.isArray(statsData) || statsData.length === 0) break;

          for (const stat of statsData) {
            const existing = persistedStatsMap.get(stat.rift_id) || { opportunities: 0, trades: 0, profit: 0 };
            existing.opportunities += stat.opportunities_detected || 0;
            persistedStatsMap.set(stat.rift_id, existing);
          }

          if (statsData.length < pageSize) break;
          statsOffset += pageSize;
        }

        // Fetch trade counts and profits from arb_bot_trades (paginated - can have 7000+ records)
        let tradesOffset = 0;
        while (true) {
          const tradesData = await supabaseFetch(`arb_bot_trades?select=rift_id,actual_profit_sol,success&limit=${pageSize}&offset=${tradesOffset}`);
          if (!tradesData || !Array.isArray(tradesData) || tradesData.length === 0) break;

          for (const trade of tradesData) {
            const existing = persistedStatsMap.get(trade.rift_id) || { opportunities: 0, trades: 0, profit: 0 };
            existing.trades++;
            if (trade.success && trade.actual_profit_sol) {
              existing.profit += parseFloat(trade.actual_profit_sol) || 0;
            }
            persistedStatsMap.set(trade.rift_id, existing);
          }

          if (tradesData.length < pageSize) break;
          tradesOffset += pageSize;
        }
      } catch (err) {
        console.error('[ARB-BOT] Failed to fetch persisted stats:', err);
      }

      const sessions: any[] = [];
      const seenRiftIds = new Set<string>();

      // First, add local instances (from all wallets, not just current)
      botInstances.forEach((bot, botId) => {
        seenRiftIds.add(bot.riftId);
        const uptime = bot.status === 'running' ? Math.floor((Date.now() - bot.startedAt) / 1000) : 0;
        const persisted = persistedStatsMap.get(bot.riftId);
        sessions.push({
          botId,
          riftId: bot.riftId,
          riftSymbol: bot.riftSymbol,
          status: bot.status,
          uptime,
          stats: {
            // Use persisted stats if available, fall back to in-memory stats
            opportunitiesFound: persisted?.opportunities || bot.stats?.opportunitiesFound || (bot.stats as any)?.opportunities || 0,
            tradesExecuted: persisted?.trades || bot.stats?.tradesExecuted || (bot.stats as any)?.trades || 0,
            totalProfit: persisted?.profit || bot.stats?.totalProfit || (bot.stats as any)?.total_profit || 0,
            lastCheck: bot.stats?.lastCheck || '-',
            scansCompleted: bot.stats?.scansCompleted || (bot.stats as any)?.scans || 0
          },
          config: bot.config,
          startedAt: bot.startedAt,
          source: 'local',
          walletAddress: bot.walletAddress,
          ownedByCurrentWallet: bot.walletAddress === walletAddress
        });
      });

      // Then, add ALL Supabase instances (global, not just current wallet)
      try {
        const supabaseBots = await getAllBots();
        for (const sbBot of supabaseBots) {
          if (!seenRiftIds.has(sbBot.rift_id)) {
            const createdAt = new Date(sbBot.created_at).getTime();
            const uptime = sbBot.status === 'running' ? Math.floor((Date.now() - createdAt) / 1000) : 0;
            const persisted = persistedStatsMap.get(sbBot.rift_id);
            sessions.push({
              botId: sbBot.id,
              riftId: sbBot.rift_id,
              riftSymbol: sbBot.r_symbol,
              status: sbBot.status,
              uptime,
              stats: {
                // Use persisted stats if available, fall back to config stats
                opportunitiesFound: persisted?.opportunities || sbBot.stats?.opportunities || 0,
                tradesExecuted: persisted?.trades || sbBot.stats?.trades || 0,
                totalProfit: persisted?.profit || sbBot.stats?.total_profit || 0,
                lastCheck: sbBot.last_scan || '-',
                scansCompleted: sbBot.stats?.scans || 0
              },
              config: {
                minProfitBps: sbBot.config?.min_profit_bps || 50,
                maxSlippageBps: sbBot.config?.max_slippage_bps || 100,
                maxTradeSize: sbBot.config?.max_trade_size || 500
              },
              startedAt: createdAt,
              source: 'supabase',
              persistent: true,
              walletAddress: sbBot.wallet_address,
              ownedByCurrentWallet: sbBot.wallet_address === walletAddress
            });
          }
        }
      } catch (err) {
        console.error('[ARB-BOT] Failed to fetch Supabase bots:', err);
      }

      return NextResponse.json({
        sessions,
        autoStopped: autoStopResult.stopped.length > 0 ? autoStopResult.stopped : undefined,
        minTvlUsd: MIN_TVL_USD
      });
    }

    // Get specific bot - check local first, then Supabase
    const botId = `${walletAddress}-${riftId}`;
    const localBot = botInstances.get(botId);

    if (localBot) {
      const uptime = localBot.status === 'running' ? Math.floor((Date.now() - localBot.startedAt) / 1000) : 0;
      return NextResponse.json({
        status: localBot.status,
        uptime,
        stats: localBot.stats,
        config: localBot.config,
        logs: localBot.logs,
        riftSymbol: localBot.riftSymbol,
        startedAt: localBot.startedAt,
        source: 'local'
      });
    }

    // Check Supabase for persistent bot
    if (riftId) {
      try {
        const supabaseBot = await getSupabaseBotConfig(riftId);
        if (supabaseBot) {
          const logs = await getSupabaseBotLogs(supabaseBot.id, 100);
          const createdAt = new Date(supabaseBot.created_at).getTime();
          const uptime = supabaseBot.status === 'running' ? Math.floor((Date.now() - createdAt) / 1000) : 0;

          return NextResponse.json({
            status: supabaseBot.status,
            uptime,
            stats: {
              opportunitiesFound: supabaseBot.stats?.opportunities || 0,
              tradesExecuted: supabaseBot.stats?.trades || 0,
              totalProfit: supabaseBot.stats?.total_profit || 0,
              lastCheck: supabaseBot.last_scan || '-',
              scansCompleted: supabaseBot.stats?.scans || 0
            },
            config: {
              minProfitBps: supabaseBot.config?.min_profit_bps || 50,
              maxSlippageBps: supabaseBot.config?.max_slippage_bps || 100,
              maxTradeSize: supabaseBot.config?.max_trade_size || 500
            },
            logs: logs.map((log: any) => ({
              timestamp: log.created_at,
              type: log.type,
              message: log.message,
              data: log.data
            })),
            riftSymbol: supabaseBot.r_symbol,
            startedAt: createdAt,
            source: 'supabase',
            persistent: true
          });
        }
      } catch (err) {
        console.error('[ARB-BOT] Failed to fetch Supabase bot:', err);
      }
    }

    // No bot found
    return NextResponse.json({
      status: 'stopped',
      stats: {
        opportunitiesFound: 0,
        tradesExecuted: 0,
        totalProfit: 0,
        lastCheck: '-',
        scansCompleted: 0
      },
      logs: []
    });

  } catch (error) {
    console.error('[ARB-BOT] Error:', error);
    return NextResponse.json(
      { error: 'Failed to get bot status' },
      { status: 500 }
    );
  }
}
