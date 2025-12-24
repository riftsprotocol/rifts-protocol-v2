// Static data cache for immutable on-chain data
// This data NEVER changes, so we cache it forever

import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

export interface StaticMintData {
  decimals: number;
  tokenProgram: 'spl' | 'token2022';
}

export interface StaticRiftData {
  underlyingMint: string;
  riftMint: string;
  vault: string;
  burnFee?: number;
  partnerFee?: number;
}

// ============ MINT CACHE ============
const staticMintCache = new Map<string, StaticMintData>();

// Pre-populate known mints (avoids ANY RPC call for these)
const KNOWN_MINTS: Record<string, StaticMintData> = {
  'So11111111111111111111111111111111111111112': { decimals: 9, tokenProgram: 'spl' },  // WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { decimals: 6, tokenProgram: 'spl' },  // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { decimals: 6, tokenProgram: 'spl' },  // USDT
  'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump': { decimals: 6, tokenProgram: 'spl' },  // RIFTS (pump.fun)
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB': { decimals: 6, tokenProgram: 'spl' },   // USD1
};

// Initialize cache with known mints
Object.entries(KNOWN_MINTS).forEach(([mint, data]) => staticMintCache.set(mint, data));

export function getStaticMintData(mint: string): StaticMintData | null {
  return staticMintCache.get(mint) || null;
}

export function setStaticMintData(mint: string, data: StaticMintData): void {
  staticMintCache.set(mint, data);
}

// ============ RIFT CACHE ============
const staticRiftCache = new Map<string, StaticRiftData>();

export function getStaticRiftData(riftId: string): StaticRiftData | null {
  return staticRiftCache.get(riftId) || null;
}

export function setStaticRiftData(riftId: string, data: StaticRiftData): void {
  staticRiftCache.set(riftId, data);
}

// ============ HELPER: Get decimals (from cache or fetch once) ============
export async function getDecimalsForMint(
  mint: string,
  connection: any
): Promise<number> {
  // Check cache first
  const cached = getStaticMintData(mint);
  if (cached) {
    console.log(`⚡ [CACHE] Decimals for ${mint.slice(0, 8)}... from cache: ${cached.decimals}`);
    return cached.decimals;
  }

  // Fetch from blockchain (only once, then cached forever)
  console.log(`🔍 [CACHE] Fetching decimals for ${mint.slice(0, 8)}... from blockchain`);
  const { getMint, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
  const { PublicKey } = await import('@solana/web3.js');

  const mintPubkey = new PublicKey(mint);

  // First check which token program owns this mint
  const mintAccountInfo = await connection.getAccountInfo(mintPubkey);
  if (!mintAccountInfo) {
    console.warn(`⚠️ [CACHE] Mint ${mint} not found, defaulting to 9 decimals`);
    return 9;
  }

  const tokenProgram = mintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? 'token2022' : 'spl';
  const programId = tokenProgram === 'token2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  const mintInfo = await getMint(connection, mintPubkey, 'confirmed', programId);
  const decimals = mintInfo.decimals;

  // Cache it forever
  setStaticMintData(mint, { decimals, tokenProgram });
  console.log(`📦 [CACHE] Cached ${mint.slice(0, 8)}...: decimals=${decimals}, program=${tokenProgram}`);

  return decimals;
}

// ============ HELPER: Get token program (from cache or fetch once) ============
export async function getTokenProgramForMint(
  mint: string,
  connection: any
): Promise<'spl' | 'token2022'> {
  // Check cache first
  const cached = getStaticMintData(mint);
  if (cached) {
    console.log(`⚡ [CACHE] Token program for ${mint.slice(0, 8)}... from cache: ${cached.tokenProgram}`);
    return cached.tokenProgram;
  }

  // Fetch from blockchain
  console.log(`🔍 [CACHE] Fetching token program for ${mint.slice(0, 8)}... from blockchain`);
  const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
  const { PublicKey } = await import('@solana/web3.js');

  const mintPubkey = new PublicKey(mint);
  const mintAccountInfo = await connection.getAccountInfo(mintPubkey);

  if (!mintAccountInfo) {
    console.warn(`⚠️ [CACHE] Mint ${mint} not found, defaulting to SPL Token`);
    return 'spl';
  }

  const tokenProgram = mintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? 'token2022' : 'spl';

  // We don't have decimals yet, but we can cache the program
  // Next call to getDecimalsForMint will fill in decimals
  return tokenProgram;
}

// ============ HELPER: Populate rift cache from loaded rifts ============
export function cacheRiftData(riftId: string, underlyingMint: string, riftMint: string, vault: string): void {
  setStaticRiftData(riftId, { underlyingMint, riftMint, vault });
}

// ============ HELPER: Bulk populate from rifts list ============
export function cacheRiftsFromList(rifts: Array<{ id: string; underlyingMint: string; riftMint: string; vault?: string }>): void {
  for (const rift of rifts) {
    if (rift.vault) {
      setStaticRiftData(rift.id, {
        underlyingMint: rift.underlyingMint,
        riftMint: rift.riftMint,
        vault: rift.vault,
      });
    }
  }
  console.log(`📦 [CACHE] Cached ${rifts.length} rifts`);
}
