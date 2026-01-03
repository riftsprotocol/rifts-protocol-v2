import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticatedForAdminOp, ADMIN_WALLET, isAdmin } from '@/lib/middleware/api-auth';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://nitmreqtsnzjylyzwsri.supabase.co';

// Dynamic import for @solana/web3.js to avoid bundling issues
const getSolana = async () => {
  const { Connection, PublicKey } = await import('@solana/web3.js');
  const { getLaserstreamConnection } = await import('@/lib/solana/server-connection');
  return { Connection, PublicKey, getLaserstreamConnection };
};
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
// Use environment variable for RPC URL - never expose API key in code
if (!process.env.LASERSTREAM || !process.env.LASERSTREAM_API_KEY) {
  throw new Error('LaserStream not configured (LASERSTREAM + LASERSTREAM_API_KEY required)');
}

const DEFAULT_RPC = `${process.env.LASERSTREAM}/?api-key=${process.env.LASERSTREAM_API_KEY}`;

// Program IDs (as strings, converted to PublicKey when needed)
const RIFTS_PROGRAM_ID_STR = '29JgMGWZ28CSF7JLStKFp8xb4BZyf7QitG5CHcfRBYoR';
const DAMM_V2_PROGRAM_ID_STR = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const PUMPSWAP_PROGRAM_ID_STR = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const ARB_BOT_PROGRAM_ID_STR = 'EfFU64GLBVnD2GSagotJ5kUEwEFN8qTj9caxExxFZ7C2';

// WSOL mint
const WSOL_MINT_STR = 'So11111111111111111111111111111111111111112';

interface RiftData {
  id: string;
  name: string;
  token_symbol: string;
  token_mint: string;
  symbol: string; // Short symbol (e.g., "RIFTS")
  is_open: boolean;
  is_deprecated: boolean;
  rift_address: string; // PDA address of the rift
  vault_auth?: string; // Vault authority PDA
  vault_address: string; // Token vault address
  vault: string; // Same as vault_address (alias)
  underlying_mint: string; // Underlying token mint (e.g., SOL wrapped)
  rift_mint: string; // Rift token mint (r-token)
  rift_mint_auth?: string; // Rift mint authority
  fees_vault?: string; // Fees vault address
  wrap_fee_bps?: number; // Wrap fee in basis points
  unwrap_fee_bps?: number; // Unwrap fee in basis points
  transfer_fee_bps?: number; // Transfer fee in basis points
  raw_data: {
    underlying: string;
    underlyingMint: string;
    vault: string;
    riftAddress?: string;
    riftMint: string;
    liquidityPool?: string;
    meteoraPool?: string;
    meteoraPools?: string[];
    hasMeteoraPool?: boolean;
    wrapFeeBps?: number;
    unwrapFeeBps?: number;
    transferFeeBps?: number;
    programVersion?: string;
    tvl?: number;
    creator?: string;
    authority?: string;
    partnerWallet?: string;
    treasuryWallet?: string;
  };
}

interface PoolConfig {
  name: string;
  type: 'meteora' | 'pumpswap' | 'raydium';
  address: string;
  vaultA: string;
  vaultB: string;
  tokenA: string;
  tokenB: string;
  authority?: string;
}

// Derive vault_auth PDA
async function deriveVaultAuth(riftAddress: string): Promise<string> {
  const { PublicKey } = await getSolana();
  const rift = new PublicKey(riftAddress);
  const programId = new PublicKey(RIFTS_PROGRAM_ID_STR);
  const [vaultAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault_auth'), rift.toBuffer()],
    programId
  );
  return vaultAuth.toBase58();
}

// Derive DAMM pool authority PDA
async function deriveDammPoolAuthority(poolAddress: string): Promise<string> {
  const { PublicKey } = await getSolana();
  const pool = new PublicKey(poolAddress);
  const programId = new PublicKey(DAMM_V2_PROGRAM_ID_STR);
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_authority'), pool.toBuffer()],
    programId
  );
  return authority.toBase58();
}

// Fetch pool vaults from DAMM V2 pool account
async function fetchDammPoolVaults(connection: any, poolAddress: string): Promise<{ vaultA: string; vaultB: string; tokenA: string; tokenB: string } | null> {
  try {
    const { PublicKey } = await getSolana();
    const poolInfo = await connection.getAccountInfo(new PublicKey(poolAddress));
    if (!poolInfo || poolInfo.data.length < 200) return null;

    // DAMM V2 pool layout - offsets based on actual pool data
    const data = poolInfo.data;

    const tokenA = new PublicKey(data.slice(72, 104)).toBase58();
    const tokenB = new PublicKey(data.slice(104, 136)).toBase58();
    const vaultA = new PublicKey(data.slice(136, 168)).toBase58();
    const vaultB = new PublicKey(data.slice(168, 200)).toBase58();

    return { vaultA, vaultB, tokenA, tokenB };
  } catch (err) {
    console.error(`Failed to fetch DAMM pool vaults for ${poolAddress}:`, err);
    return null;
  }
}

// Discover PumpSwap pool for a token
async function discoverPumpSwapPool(connection: any, tokenMint: string): Promise<PoolConfig | null> {
  try {
    const { PublicKey } = await getSolana();
    const tokenMintPubkey = new PublicKey(tokenMint);
    const wsolMint = new PublicKey(WSOL_MINT_STR);
    const pumpswapProgramId = new PublicKey(PUMPSWAP_PROGRAM_ID_STR);

    // Try both orderings
    const seeds1 = [Buffer.from('pool'), tokenMintPubkey.toBuffer(), wsolMint.toBuffer()];
    const seeds2 = [Buffer.from('pool'), wsolMint.toBuffer(), tokenMintPubkey.toBuffer()];

    let poolAddressPubkey: any = null;
    let poolInfo = null;

    try {
      const [pool1] = PublicKey.findProgramAddressSync(seeds1, pumpswapProgramId);
      poolInfo = await connection.getAccountInfo(pool1);
      if (poolInfo) poolAddressPubkey = pool1;
    } catch {}

    if (!poolAddressPubkey) {
      try {
        const [pool2] = PublicKey.findProgramAddressSync(seeds2, pumpswapProgramId);
        poolInfo = await connection.getAccountInfo(pool2);
        if (poolInfo) poolAddressPubkey = pool2;
      } catch {}
    }

    if (!poolAddressPubkey || !poolInfo) return null;

    const data = poolInfo.data;
    if (data.length < 200) return null;

    const baseMint = new PublicKey(data.slice(44, 76)).toBase58();
    const quoteMint = new PublicKey(data.slice(76, 108)).toBase58();
    const poolBaseVault = new PublicKey(data.slice(140, 172)).toBase58();
    const poolQuoteVault = new PublicKey(data.slice(172, 204)).toBase58();

    return {
      name: 'PumpSwap TOKEN/SOL',
      type: 'pumpswap',
      address: poolAddressPubkey.toBase58(),
      vaultA: poolBaseVault,
      vaultB: poolQuoteVault,
      tokenA: baseMint,
      tokenB: quoteMint,
    };
  } catch (err) {
    console.error('Failed to discover PumpSwap pool:', err);
    return null;
  }
}

// Generate scanner configuration code
async function generateScannerConfig(
  rift: RiftData,
  pools: PoolConfig[],
  apiKey?: string
): Promise<string> {
  // Extract API key from environment RPC URL or use provided
  const heliusApiKey = apiKey || process.env.SOLANA_RPC_URL?.match(/api-key=([a-f0-9-]+)/)?.[1];
  const rpcUrl = heliusApiKey
    ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
    : DEFAULT_RPC;
  const wsUrl = heliusApiKey
    ? `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
    : 'wss://api.mainnet-beta.solana.com'; // Fallback to public WS if no key

  // Laserstream for ultra-low latency (~10-20ms instead of ~50-100ms)
  const laserstreamApiKey = process.env.LASERSTREAM_API_KEY || heliusApiKey;
  const laserstreamUrl = laserstreamApiKey
    ? `https://laserstream-mainnet-ewr.helius-rpc.com/?api-key=${laserstreamApiKey}`
    : null;

  const meteoraPool = pools.find(p => p.type === 'meteora');
  const pumpSwapPool = pools.find(p => p.type === 'pumpswap');

  const vaultAuth = rift.vault_auth || await deriveVaultAuth(rift.rift_address);

  return `/**
 * MAINNET RIFTS Arbitrage Scanner Bot
 * Auto-generated for ${rift.symbol} (r${rift.symbol})
 * Generated: ${new Date().toISOString()}
 *
 * Routes:
 *   WRAP_ROUTE:   SOL -> ${rift.symbol} -> WRAP -> r${rift.symbol} -> SWAP -> SOL (when pool r${rift.symbol} is expensive)
 *   UNWRAP_ROUTE: SOL -> SWAP -> r${rift.symbol} -> UNWRAP -> ${rift.symbol} -> SOL (when pool r${rift.symbol} is cheap)
 *
 * Deployed arb-bot program: ${ARB_BOT_PROGRAM_ID_STR}
 */

const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint, getTransferFeeConfig, getAssociatedTokenAddress, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, createAssociatedTokenAccountIdempotentInstruction, getAccount } = require('@solana/spl-token');
const fs = require('fs');
const https = require('https');
const http = require('http');
const BN = require('bn.js');

// HTTP Keep-Alive agents
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 10,
    timeout: 60000,
});

const bs58 = require('bs58').default || require('bs58');
const WebSocket = require('ws');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    // RPC endpoint (standard Helius)
    rpcUrl: '${rpcUrl}',
    wsUrl: '${wsUrl}',

    // Laserstream for ultra-low latency (~10-20ms vs ~50-100ms)
    // Use for: getAccountInfo, getBalance, sendTransaction in hot path
    laserstreamUrl: ${laserstreamUrl ? `'${laserstreamUrl}'` : 'null'},
    useLaserstream: ${laserstreamUrl ? 'true' : 'false'},

    // Helius Sender for ultra-low latency transaction sending
    useSender: true,
    senderEndpoint: 'https://sender.helius-rpc.com/fast',
    senderTipMin: 200000, // 0.0002 SOL minimum
    senderTipDynamic: true,

    // Use WebSocket subscriptions
    useWebSocket: true,

    // Minimum profit threshold (in token units with 6 decimals)
    minProfitTokens: 1_000_000n, // 1 token

    // Trade size config
    tradeSizeUsd: 0, // Dynamic sizing
    maxTradeSizeUsd: 2000,
    maxSlippagePct: 5.0,
    minProfitUsd: 0.50,

    // Priority fee
    priorityFee: 500000,

    // Log level
    logLevel: 'info',

    // Dry run mode
    dryRun: false,
};

// ============================================================================
// TOKEN CONSTANTS - ${rift.symbol}
// ============================================================================

// Program IDs
const ARB_BOT_PROGRAM_ID = new PublicKey('${ARB_BOT_PROGRAM_ID_STR}');
const RIFTS_PROGRAM_ID = new PublicKey('${RIFTS_PROGRAM_ID_STR}');
const DAMM_V2_PROGRAM_ID = new PublicKey('${DAMM_V2_PROGRAM_ID_STR}');

// Token mints - ${rift.symbol}
const TOKEN_MINT = new PublicKey('${rift.underlying_mint}'); // ${rift.symbol}
const RTOKEN_MINT = new PublicKey('${rift.rift_mint}'); // r${rift.symbol}

${meteoraPool ? `// Meteora DAMM V2 Pool - r${rift.symbol}/SOL
const POOL_RRIFTS_RSOL = new PublicKey('${meteoraPool.address}');
const POOL_RRIFTS_RSOL_VAULT_A = new PublicKey('${meteoraPool.vaultA}'); // r${rift.symbol}
const POOL_RRIFTS_RSOL_VAULT_B = new PublicKey('${meteoraPool.vaultB}'); // WSOL
const POOL_RRIFTS_RSOL_AUTHORITY = new PublicKey('${meteoraPool.authority || 'DERIVE_FROM_POOL'}');
` : `// No Meteora pool found for r${rift.symbol}
const POOL_RRIFTS_RSOL = null;
const POOL_RRIFTS_RSOL_VAULT_A = null;
const POOL_RRIFTS_RSOL_VAULT_B = null;
const POOL_RRIFTS_RSOL_AUTHORITY = null;
`}

${pumpSwapPool ? `// PumpSwap Pool - ${rift.symbol}/SOL
const PUMPSWAP_PROGRAM_ID = new PublicKey('${PUMPSWAP_PROGRAM_ID_STR}');
const POOL_RIFTS_SOL = new PublicKey('${pumpSwapPool.address}');
const POOL_RIFTS_SOL_VAULT_RIFTS = new PublicKey('${pumpSwapPool.vaultA}'); // ${rift.symbol}
const POOL_RIFTS_SOL_VAULT_SOL = new PublicKey('${pumpSwapPool.vaultB}'); // SOL
` : `// No PumpSwap pool found - discover manually or use Raydium
const PUMPSWAP_PROGRAM_ID = new PublicKey('${PUMPSWAP_PROGRAM_ID_STR}');
const POOL_RIFTS_SOL = null; // Set manually if using a different DEX
const POOL_RIFTS_SOL_VAULT_RIFTS = null;
const POOL_RIFTS_SOL_VAULT_SOL = null;
`}

// RIFTS Protocol accounts
const RIFT = new PublicKey('${rift.rift_address}');
const VAULT = new PublicKey('${rift.vault}');
const VAULT_AUTH = new PublicKey('${vaultAuth}');
const RIFT_MINT_AUTH = new PublicKey('${rift.rift_mint_auth || 'SET_RIFT_MINT_AUTHORITY_HERE'}');
const FEES_VAULT = new PublicKey('${rift.fees_vault || 'SET_FEES_VAULT_HERE'}');

// WSOL
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// Default fees (will be read dynamically from on-chain)
let WRAP_FEE_BPS = ${rift.wrap_fee_bps || 30};
let UNWRAP_FEE_BPS = ${rift.unwrap_fee_bps || 30};
let TRANSFER_FEE_BPS = ${rift.transfer_fee_bps || 70};

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

async function main() {
    console.log('='.repeat(60));
    console.log('  RIFTS Arbitrage Scanner - ${rift.symbol}');
    console.log('  Token: ${rift.underlying_mint}');
    console.log('  rToken: ${rift.rift_mint}');
    console.log('='.repeat(60));

    // Load wallet
    const walletPath = process.env.WALLET_PATH ||
        (process.env.HOME || process.env.USERPROFILE) + '/.config/solana/arb-wallet.json';

    if (!fs.existsSync(walletPath)) {
        console.error('ERROR: Wallet not found at', walletPath);
        console.error('Create a wallet or set WALLET_PATH environment variable');
        process.exit(1);
    }

    const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    const wallet = Keypair.fromSecretKey(new Uint8Array(walletData));
    console.log('Wallet:', wallet.publicKey.toBase58());

    // Standard RPC connection
    const connection = new Connection(CONFIG.rpcUrl, {
        commitment: 'confirmed',
        httpAgent: httpsAgent,
    });

    // Laserstream connection for ultra-low latency operations (hot path)
    const laserstreamConnection = CONFIG.useLaserstream
        ? new Connection(CONFIG.laserstreamUrl, { commitment: 'confirmed', httpAgent: httpsAgent })
        : connection;

    console.log('RPC:', CONFIG.rpcUrl.split('?')[0]);
    if (CONFIG.useLaserstream) {
        console.log('Laserstream: ENABLED (ultra-low latency)');
    }

    // Check balance
    const balance = await connection.getBalance(wallet.publicKey);
    console.log('Balance:', balance / LAMPORTS_PER_SOL, 'SOL');

    if (balance < 0.1 * LAMPORTS_PER_SOL) {
        console.warn('WARNING: Low balance. Recommend at least 0.1 SOL');
    }

    console.log('\\nScanner ready! Monitoring for arbitrage opportunities...');
    console.log('Press Ctrl+C to stop\\n');

    // TODO: Implement your scanning logic here
    // The configuration above provides all the accounts needed for:
    // 1. Wrap/Unwrap via RIFTS protocol
    // 2. Swap via Meteora DAMM V2 or PumpSwap
    //
    // Example routes:
    // WRAP_ROUTE: Buy ${rift.symbol} -> Wrap to r${rift.symbol} -> Sell r${rift.symbol} for SOL
    // UNWRAP_ROUTE: Buy r${rift.symbol} -> Unwrap to ${rift.symbol} -> Sell ${rift.symbol} for SOL
}

main().catch(console.error);
`;
}

// ADMIN_WALLET imported from @/lib/middleware/api-auth

// Team rift data with profit split
interface TeamRiftData {
  rift_id: string;
  team_split: number; // Percentage for team (0-100), rest goes to us
}

// Team rifts stored in memory (will be persisted to Supabase)
let teamRiftsCache: Map<string, TeamRiftData> = new Map();
let teamRiftsCacheLoaded = false;

// Load team rifts from Supabase
async function loadTeamRifts(): Promise<Map<string, TeamRiftData>> {
  if (teamRiftsCacheLoaded) return teamRiftsCache;

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/arb_team_rifts?select=rift_id,team_split`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      cache: 'no-store',
    });

    if (response.ok) {
      const data: TeamRiftData[] = await response.json();
      teamRiftsCache = new Map(data.map(r => [r.rift_id, r]));
      teamRiftsCacheLoaded = true;
    }
  } catch (err) {
    console.error('Failed to load team rifts:', err);
  }

  return teamRiftsCache;
}

// Add rift to team rifts with default 50/50 split
async function addTeamRift(riftId: string, teamSplit: number = 50): Promise<boolean> {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/arb_team_rifts`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ rift_id: riftId, team_split: teamSplit }),
    });

    if (response.ok || response.status === 201) {
      teamRiftsCache.set(riftId, { rift_id: riftId, team_split: teamSplit });
      return true;
    }
    return false;
  } catch (err) {
    console.error('Failed to add team rift:', err);
    return false;
  }
}

// Update team rift profit split
async function updateTeamRiftSplit(riftId: string, teamSplit: number): Promise<boolean> {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/arb_team_rifts?rift_id=eq.${riftId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ team_split: teamSplit }),
    });

    if (response.ok) {
      const existing = teamRiftsCache.get(riftId);
      if (existing) {
        existing.team_split = teamSplit;
      }
      return true;
    }
    return false;
  } catch (err) {
    console.error('Failed to update team rift split:', err);
    return false;
  }
}

// Remove rift from team rifts
async function removeTeamRift(riftId: string): Promise<boolean> {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/arb_team_rifts?rift_id=eq.${riftId}`, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });

    if (response.ok) {
      teamRiftsCache.delete(riftId);
      return true;
    }
    return false;
  } catch (err) {
    console.error('Failed to remove team rift:', err);
    return false;
  }
}

// GET - List available rifts (filtered by wallet permissions)
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const action = searchParams.get('action');
    const walletAddress = searchParams.get('wallet');

    // Get team rifts list (admin only)
    if (action === 'team-rifts') {
      const teamRifts = await loadTeamRifts();
      return NextResponse.json({
        teamRifts: Array.from(teamRifts.values()),
        isAdmin: isAdmin(walletAddress),
      });
    }

    // Lookup rift by contract address (rift address, token mint, or underlying mint)
    if (action === 'lookup') {
      const address = searchParams.get('address');
      if (!address) {
        return NextResponse.json({ error: 'Address parameter required' }, { status: 400 });
      }

      // Fetch all rifts from Supabase
      const response = await fetch(`${SUPABASE_URL}/rest/v1/rifts?select=*`, {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
        cache: 'no-store',
      });

      if (!response.ok) {
        throw new Error('Failed to fetch rifts');
      }

      const riftsData: RiftData[] = await response.json();

      // Find rift by any of: rift_address, token_mint, underlying_mint, or id
      const foundRift = riftsData.find(r => {
        const raw = r.raw_data || {};
        const programId = (r as any).program_id;

        // Only match V2 program rifts
        if (programId !== RIFTS_PROGRAM_ID_STR) return false;
        if (r.is_deprecated) return false;

        return (
          r.id === address ||
          r.token_mint === address ||
          raw.riftAddress === address ||
          raw.riftMint === address ||
          raw.underlyingMint === address
        );
      });

      if (!foundRift) {
        return NextResponse.json({ error: 'Rift not found for this address' }, { status: 404 });
      }

      // Check permissions if wallet provided (admin bypasses permission check)
      if (walletAddress && !isAdmin(walletAddress)) {
        const raw = foundRift.raw_data || {};
        const creator = raw.creator;
        const partnerWallet = raw.partnerWallet;

        if (walletAddress !== creator && walletAddress !== partnerWallet) {
          return NextResponse.json({
            error: 'You do not have permission to manage this rift'
          }, { status: 403 });
        }
      }

      const raw = foundRift.raw_data || {};
      const meteoraPools = raw.meteoraPools || (raw.liquidityPool ? [raw.liquidityPool] : []);

      return NextResponse.json({
        rift: {
          id: foundRift.id,
          symbol: raw.underlying || foundRift.name?.replace('r', '') || 'TOKEN',
          rSymbol: foundRift.token_symbol || foundRift.name || `r${raw.underlying}`,
          underlying: raw.underlying || 'Unknown',
          riftMint: foundRift.token_mint || raw.riftMint,
          underlyingMint: raw.underlyingMint || '',
          vault: raw.vault || '',
          rift: raw.riftAddress || foundRift.id,
          hasMeteoraPool: raw.hasMeteoraPool || meteoraPools.length > 0,
          hasPumpSwapPool: false,
          meteoraPools,
          programVersion: raw.programVersion || 'v2',
          tvl: raw.tvl || 0,
          transferFeeBps: raw.transferFeeBps || 70,
          wrapFeeBps: raw.wrapFeeBps || 30,
          unwrapFeeBps: raw.unwrapFeeBps || 30,
          creator: raw.creator || '',
          partnerWallet: raw.partnerWallet || '',
        }
      });
    }

    if (action === 'list') {
      // Load team rifts (legacy) for fallback
      const teamRifts = await loadTeamRifts();

      // Fetch rift configs from arb_rift_config (source of truth - same as profit distribution)
      const configsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/arb_rift_config?select=rift_id,is_team_rift,lp_split`,
        {
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          },
          cache: 'no-store',
        }
      );
      const riftConfigs: { rift_id: string; is_team_rift: boolean; lp_split: number }[] =
        configsResponse.ok ? await configsResponse.json() : [];
      const configMap = new Map(riftConfigs.map(c => [c.rift_id, c]));

      // Fetch all rifts from Supabase
      const response = await fetch(`${SUPABASE_URL}/rest/v1/rifts?select=*`, {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
        cache: 'no-store',
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('Supabase error:', errText);
        throw new Error(`Failed to fetch rifts: ${errText}`);
      }

      const riftsData: RiftData[] = await response.json();

      // Filter to only active, non-deprecated rifts from V2 program
      // AND filter by wallet permissions (creator, partner, or admin)
      const rifts = riftsData
        .filter(r => {
          // Must not be deprecated and must be open
          if (r.is_deprecated || !r.is_open) return false;

          // Must be V2 program - check program_id field
          const programId = (r as any).program_id;
          if (programId !== RIFTS_PROGRAM_ID_STR) return false;

          // If no wallet provided, return all (for backward compatibility)
          if (!walletAddress) return true;

          // Admin can access all rifts
          if (isAdmin(walletAddress)) return true;

          // Check if wallet is creator or partner
          const raw = r.raw_data || {};
          const creator = raw.creator;
          const partnerWallet = raw.partnerWallet;

          return walletAddress === creator || walletAddress === partnerWallet;
        })
        .map(r => {
          const raw = r.raw_data || {};
          const meteoraPools = raw.meteoraPools || (raw.liquidityPool ? [raw.liquidityPool] : []);

          // Use arb_rift_config as source of truth, fallback to arb_team_rifts (legacy)
          const config = configMap.get(r.id);
          const legacyTeamRift = teamRifts.get(r.id);
          const isTeamRift = config?.is_team_rift ?? (legacyTeamRift !== undefined);
          const teamSplit = config?.lp_split ?? legacyTeamRift?.team_split ?? null;

          return {
            id: r.id,
            symbol: raw.underlying || r.name?.replace('r', '') || 'TOKEN',
            rSymbol: r.token_symbol || r.name || `r${raw.underlying}`,
            underlying: raw.underlying || 'Unknown',
            riftMint: r.token_mint || raw.riftMint,
            underlyingMint: raw.underlyingMint || '',
            vault: raw.vault || '',
            vaultAuth: '',
            riftMintAuth: '',
            feesVault: '',
            rift: raw.riftAddress || r.id,
            hasMeteoraPool: raw.hasMeteoraPool || meteoraPools.length > 0,
            hasPumpSwapPool: false,
            meteoraPools,
            programVersion: raw.programVersion || 'v2',
            tvl: raw.tvl || 0,
            transferFeeBps: raw.transferFeeBps || 70,
            wrapFeeBps: raw.wrapFeeBps || 30,
            unwrapFeeBps: raw.unwrapFeeBps || 30,
            creator: raw.creator || '',
            partnerWallet: raw.partnerWallet || '',
            isTeamRift,
            teamSplit,
          };
        });

      return NextResponse.json({
        rifts,
        isAdmin: isAdmin(walletAddress),
      });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('ARB-CONFIG GET error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    );
  }
}

// POST - Generate configuration for a specific rift
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { riftId, apiKey } = body;

    if (!riftId) {
      return NextResponse.json({ error: 'riftId is required' }, { status: 400 });
    }

    // Fetch rift data
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rifts?id=eq.${riftId}`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch rift data');
    }

    const [riftData]: RiftData[] = await response.json();
    if (!riftData) {
      return NextResponse.json({ error: 'Rift not found' }, { status: 404 });
    }

    const raw = riftData.raw_data || {};

    // Create connection for pool discovery (optimized: use singleton when no custom key)
    const { Connection, getLaserstreamConnection } = await getSolana();
    const poolDiscoveryKey = apiKey || process.env.SOLANA_RPC_URL?.match(/api-key=([a-f0-9-]+)/)?.[1];

    // Use singleton connection if no custom API key, otherwise create new connection
    const connection = (!apiKey)
      ? await getLaserstreamConnection()
      : new Connection(
          poolDiscoveryKey
            ? `https://mainnet.helius-rpc.com/?api-key=${poolDiscoveryKey}`
            : DEFAULT_RPC,
          'confirmed'
        );

    // Discover pools
    const pools: PoolConfig[] = [];

    // Process Meteora pools
    const meteoraPools = raw.meteoraPools || (raw.liquidityPool ? [raw.liquidityPool] : []);
    if (meteoraPools.length > 0) {
      for (const poolAddr of meteoraPools) {
        const vaults = await fetchDammPoolVaults(connection, poolAddr);
        if (vaults) {
          const authority = await deriveDammPoolAuthority(poolAddr);
          pools.push({
            name: `Meteora r${raw.underlying}/SOL`,
            type: 'meteora',
            address: poolAddr,
            vaultA: vaults.vaultA,
            vaultB: vaults.vaultB,
            tokenA: vaults.tokenA,
            tokenB: vaults.tokenB,
            authority,
          });
        }
      }
    }

    // Discover PumpSwap pool for underlying token
    if (raw.underlyingMint) {
      const pumpSwapPool = await discoverPumpSwapPool(connection, raw.underlyingMint);
      if (pumpSwapPool) {
        pumpSwapPool.name = `PumpSwap ${raw.underlying}/SOL`;
        pools.push(pumpSwapPool);
      }
    }

    // Transform rift data for config generation
    const configRift = {
      id: riftData.id,
      symbol: riftData.token_symbol || riftData.name,
      underlying: raw.underlying || 'TOKEN',
      vault: raw.vault || '',
      rift_mint: riftData.token_mint || raw.riftMint,
      underlying_mint: raw.underlyingMint || '',
      rift_address: raw.riftAddress || riftData.id,
      wrap_fee_bps: raw.wrapFeeBps || 30,
      unwrap_fee_bps: raw.unwrapFeeBps || 30,
      transfer_fee_bps: raw.transferFeeBps || 70,
      program_version: raw.programVersion || 'v2',
    };

    // Generate the config code
    const configCode = await generateScannerConfig(configRift as any, pools, apiKey);

    return NextResponse.json({
      rift: {
        id: riftData.id,
        symbol: raw.underlying || riftData.name?.replace('r', '') || 'TOKEN',
        rSymbol: riftData.token_symbol || riftData.name || `r${raw.underlying}`,
      },
      pools,
      generatedAt: new Date().toISOString(),
      configCode,
    });
  } catch (error) {
    console.error('ARB-CONFIG POST error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    );
  }
}

// PUT - Toggle team rift status or update profit split (admin only)
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { riftId, isTeamRift, teamSplit, wallet, signature, timestamp } = body;

    // Verify admin authentication (signature-based preferred, legacy wallet check as fallback)
    const { authenticated, error } = isAuthenticatedForAdminOp({
      wallet,
      signature,
      action: 'manage-team-rifts',
      timestamp,
    });

    if (!authenticated) {
      return NextResponse.json(
        { error: error || 'Only admin can manage team rifts' },
        { status: 403 }
      );
    }

    if (!riftId) {
      return NextResponse.json(
        { error: 'riftId is required' },
        { status: 400 }
      );
    }

    let success: boolean;

    // If teamSplit is provided, update the split percentage
    if (typeof teamSplit === 'number') {
      // Validate split is between 0-100
      const validSplit = Math.max(0, Math.min(100, teamSplit));

      // Check if rift is already a team rift
      const teamRifts = await loadTeamRifts();
      if (teamRifts.has(riftId)) {
        success = await updateTeamRiftSplit(riftId, validSplit);
      } else {
        // Add as team rift with the specified split
        success = await addTeamRift(riftId, validSplit);
      }

      if (!success) {
        return NextResponse.json(
          { error: 'Failed to update team rift split' },
          { status: 500 }
        );
      }

      return NextResponse.json({
        success: true,
        riftId,
        teamSplit: validSplit,
        isTeamRift: true,
      });
    }

    // Toggle team rift status
    if (isTeamRift) {
      success = await addTeamRift(riftId, 50); // Default 50/50 split
    } else {
      success = await removeTeamRift(riftId);
    }

    if (!success) {
      return NextResponse.json(
        { error: 'Failed to update team rift status' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      riftId,
      isTeamRift,
      teamSplit: isTeamRift ? 50 : null,
    });
  } catch (error) {
    console.error('ARB-CONFIG PUT error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    );
  }
}
