// lib/solana/rifts/utils.ts - Utility functions for Rifts Service
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { DecodedRiftData, ProductionRiftData, RIFTS_PROGRAM_ID, V1_RIFTS, RIFTS_V1_PROGRAM_ID, BLACKLISTED_RIFTS } from './types';
import { supabase } from '@/lib/supabase/client';

// ============ DECODE FUNCTIONS ============

// Decode rift account data matching Rust struct
export function decodeRiftAccount(data: Buffer): DecodedRiftData {
  try {
    // For smaller accounts (like 82 bytes), use minimal decoding
    if (data.length <= 100) {
      return decodeMinimalRiftAccount(data);
    }

    // Minimum required size for full decoding
    const minRequiredSize = 32;
    if (data.length < minRequiredSize) {
      throw new Error(`Account data too short: ${data.length} bytes`);
    }

    const view = new DataView(data.buffer, data.byteOffset);
    let offset = 8; // Skip 8-byte discriminator

    // Helper function to safely read data with bounds checking
    const safeRead = (readOffset: number, size: number, _type: string) => {
      if (readOffset + size > data.length) {
        return false;
      }
      return true;
    };

    // Read the name field - it's a FIXED 32-byte array, not a Borsh string!
    const nameBytes = data.slice(offset, offset + 32);
    const name = nameBytes.toString('utf8').replace(/\0/g, '').trim();
    offset += 32;

    // Decode according to Rust Rift struct with bounds checking
    const riftData = {
      name,
      creator: (() => {
        if (!safeRead(offset, 32, 'creator')) return PublicKey.default.toBase58();
        const creator = new PublicKey(data.slice(offset, offset + 32)).toBase58();
        offset += 32;
        return creator;
      })(),
      underlyingMint: (() => {
        if (!safeRead(offset, 32, 'underlyingMint')) return PublicKey.default.toBase58();
        const mint = new PublicKey(data.slice(offset, offset + 32)).toBase58();
        offset += 32;
        return mint;
      })(),
      riftMint: (() => {
        if (!safeRead(offset, 32, 'riftMint')) return PublicKey.default.toBase58();
        const riftMint = new PublicKey(data.slice(offset, offset + 32)).toBase58();
        offset += 32;
        return riftMint;
      })(),
      vault: (() => {
        if (!safeRead(offset, 32, 'vault')) return PublicKey.default.toBase58();
        const vault = new PublicKey(data.slice(offset, offset + 32)).toBase58();
        offset += 32;
        return vault;
      })(),
      feesVault: (() => {
        if (!safeRead(offset, 32, 'feesVault')) return PublicKey.default.toBase58();
        const feesVault = new PublicKey(data.slice(offset, offset + 32)).toBase58();
        offset += 32;
        return feesVault;
      })(),
      withheldVault: (() => {
        if (!safeRead(offset, 32, 'withheldVault')) return PublicKey.default.toBase58();
        const withheldVault = new PublicKey(data.slice(offset, offset + 32)).toBase58();
        offset += 32;
        return withheldVault;
      })(),
      partnerFeeBps: (() => {
        if (!safeRead(offset, 2, 'partnerFeeBps')) return undefined;
        return view.getUint16(offset, true);
      })(),
      partnerFee: (() => {
        if (!safeRead(offset, 2, 'partnerFee')) return 50;
        const feeBps = view.getUint16(offset, true);
        offset += 2;
        return feeBps / 100;
      })(),
      burnFee: 0,
      partnerWallet: (() => {
        const partnerOffset = offset;
        if (!safeRead(partnerOffset, 33, 'partnerWallet')) {
          offset += 33;
          return undefined;
        }
        const isSome = data[partnerOffset] === 1;
        offset += 33;
        if (isSome && safeRead(partnerOffset + 1, 32, 'partnerWalletKey')) {
          return new PublicKey(data.slice(partnerOffset + 1, partnerOffset + 33)).toBase58();
        }
        return undefined;
      })(),
      treasuryWallet: (() => {
        const treasuryOffset = offset;
        if (!safeRead(treasuryOffset, 33, 'treasuryWallet')) {
          offset += 33;
          return undefined;
        }
        const isSome = data[treasuryOffset] === 1;
        offset += 33;
        if (isSome && safeRead(treasuryOffset + 1, 32, 'treasuryWalletKey')) {
          return new PublicKey(data.slice(treasuryOffset + 1, treasuryOffset + 33)).toBase58();
        }
        return undefined;
      })(),
      wrapFeeBps: (() => {
        const absoluteOffset = 300;
        if (!safeRead(absoluteOffset, 2, 'wrapFeeBps')) return undefined;
        return view.getUint16(absoluteOffset, true);
      })(),
      unwrapFeeBps: (() => {
        const absoluteOffset = 302;
        if (!safeRead(absoluteOffset, 2, 'unwrapFeeBps')) return undefined;
        return view.getUint16(absoluteOffset, true);
      })(),
      totalWrapped: (() => {
        if (!safeRead(offset + 165, 8, 'totalWrapped')) return BigInt(0);
        return view.getBigUint64(offset + 165, true);
      })(),
      totalBurned: (() => {
        if (!safeRead(offset + 173, 8, 'totalBurned')) return BigInt(0);
        return view.getBigUint64(offset + 173, true);
      })(),
      backingRatio: (() => {
        if (!safeRead(offset + 181, 8, 'backingRatio')) return BigInt(0);
        return view.getBigUint64(offset + 181, true);
      })(),
      lastRebalance: (() => {
        if (!safeRead(offset + 189, 8, 'lastRebalance')) return BigInt(0);
        return view.getBigInt64(offset + 189, true);
      })(),
      createdAt: (() => {
        if (!safeRead(offset + 197, 8, 'createdAt')) return BigInt(0);
        return view.getBigInt64(offset + 197, true);
      })(),
      oracleUpdateInterval: data.length > offset + 268 ? view.getBigInt64(offset + 260, true) : BigInt(0),
      maxRebalanceInterval: data.length > offset + 276 ? view.getBigInt64(offset + 268, true) : BigInt(0),
      arbitrageThresholdBps: data.length > offset + 278 ? view.getUint16(offset + 276, true) : 0,
      lastOracleUpdate: data.length > offset + 286 ? view.getBigInt64(offset + 278, true) : BigInt(0),
      totalVolume24h: data.length > offset + 294 ? view.getBigUint64(offset + 286, true) : BigInt(0),
      priceDeviation: data.length > offset + 302 ? view.getBigUint64(offset + 294, true) : BigInt(0),
      arbitrageOpportunityBps: data.length > offset + 304 ? view.getUint16(offset + 302, true) : 0,
      rebalanceCount: data.length > offset + 308 ? view.getUint32(offset + 304, true) : 0,
      totalFeesCollected: data.length > offset + 316 ? view.getBigUint64(offset + 308, true) : BigInt(0),
      riftsTokensDistributed: data.length > offset + 324 ? view.getBigUint64(offset + 316, true) : BigInt(0),
      riftsTokensBurned: data.length > offset + 332 ? view.getBigUint64(offset + 324, true) : BigInt(0),
    };

    return riftData;
  } catch (error) {
    // Return a minimal safe rift data structure to prevent crashes
    return {
      creator: 'ERROR_PARSING_CREATOR',
      underlyingMint: 'So11111111111111111111111111111111111111112',
      riftMint: 'ERROR_PARSING_RIFT_MINT',
      vault: 'ERROR_PARSING_VAULT',
      burnFee: 0,
      partnerFee: 0,
      totalWrapped: BigInt(0),
      totalBurned: BigInt(0),
      backingRatio: BigInt(1000000000),
      lastRebalance: BigInt(Date.now()),
      createdAt: BigInt(Date.now()),
      oracleUpdateInterval: BigInt(300),
      maxRebalanceInterval: BigInt(3600),
      arbitrageThresholdBps: 100,
      lastOracleUpdate: BigInt(Date.now()),
      totalVolume24h: BigInt(0),
      priceDeviation: BigInt(0),
      arbitrageOpportunityBps: 0,
      rebalanceCount: 0,
      totalFeesCollected: BigInt(0),
      riftsTokensDistributed: BigInt(0),
      riftsTokensBurned: BigInt(0)
    };
  }
}

// Minimal decoder for smaller account data
export function decodeMinimalRiftAccount(data: Buffer): DecodedRiftData {
  try {
    const view = new DataView(data.buffer, data.byteOffset);
    let offset = 8; // Skip 8-byte discriminator

    // Read name as FIXED 32-byte array
    const nameBytes = data.slice(offset, offset + 32);
    const name = nameBytes.toString('utf8').replace(/\0/g, '').trim();
    offset += 32;

    const riftData = {
      name,
      creator: (() => {
        try {
          if (offset + 32 <= data.length) {
            const pubkey = new PublicKey(data.slice(offset, offset + 32));
            offset += 32;
            return pubkey.toBase58();
          }
          return PublicKey.default.toBase58();
        } catch {
          offset += 32;
          return PublicKey.default.toBase58();
        }
      })(),
      underlyingMint: (() => {
        try {
          if (offset + 32 <= data.length) {
            const pubkey = new PublicKey(data.slice(offset, offset + 32));
            offset += 32;
            return pubkey.toBase58();
          }
          return PublicKey.default.toBase58();
        } catch {
          offset += 32;
          return PublicKey.default.toBase58();
        }
      })(),
      riftMint: (() => {
        try {
          if (offset + 32 <= data.length) {
            const pubkey = new PublicKey(data.slice(offset, offset + 32));
            offset += 32;
            return pubkey.toBase58();
          }
          return PublicKey.default.toBase58();
        } catch {
          offset += 32;
          return PublicKey.default.toBase58();
        }
      })(),
      vault: (() => {
        try {
          if (offset + 32 <= data.length) {
            const pubkey = new PublicKey(data.slice(offset, offset + 32));
            offset += 32;
            return pubkey.toBase58();
          }
          return PublicKey.default.toBase58();
        } catch {
          offset += 32;
          return PublicKey.default.toBase58();
        }
      })(),
      // Default values for minimal decode
      burnFee: 0,
      partnerFee: 50,
      totalWrapped: BigInt(0),
      totalBurned: BigInt(0),
      backingRatio: BigInt(1000000000),
      lastRebalance: BigInt(Date.now()),
      createdAt: BigInt(Date.now()),
      oracleUpdateInterval: BigInt(300),
      maxRebalanceInterval: BigInt(3600),
      arbitrageThresholdBps: 100,
      lastOracleUpdate: BigInt(Date.now()),
      totalVolume24h: BigInt(0),
      priceDeviation: BigInt(0),
      arbitrageOpportunityBps: 0,
      rebalanceCount: 0,
      totalFeesCollected: BigInt(0),
      riftsTokensDistributed: BigInt(0),
      riftsTokensBurned: BigInt(0)
    };

    return riftData;
  } catch (error) {
    return {
      creator: PublicKey.default.toBase58(),
      underlyingMint: PublicKey.default.toBase58(),
      riftMint: PublicKey.default.toBase58(),
      vault: PublicKey.default.toBase58(),
      burnFee: 0,
      partnerFee: 0,
      totalWrapped: BigInt(0),
      totalBurned: BigInt(0),
      backingRatio: BigInt(1000000000),
      lastRebalance: BigInt(Date.now()),
      createdAt: BigInt(Date.now()),
      oracleUpdateInterval: BigInt(300),
      maxRebalanceInterval: BigInt(3600),
      arbitrageThresholdBps: 100,
      lastOracleUpdate: BigInt(Date.now()),
      totalVolume24h: BigInt(0),
      priceDeviation: BigInt(0),
      arbitrageOpportunityBps: 0,
      rebalanceCount: 0,
      totalFeesCollected: BigInt(0),
      riftsTokensDistributed: BigInt(0),
      riftsTokensBurned: BigInt(0)
    };
  }
}

// ============ ORACLE/RISK FUNCTIONS ============

export function calculateRiskLevel(backingRatio: number, arbitrageOpportunity: number): 'Very Low' | 'Low' | 'Medium' | 'High' {
  const deviation = Math.abs(100 - backingRatio);

  if (deviation < 1 && backingRatio > 0.98) return 'Very Low';
  if (deviation < 2 && backingRatio > 0.95) return 'Low';
  if (deviation < 5 && backingRatio > 0.90) return 'Medium';
  return 'High';
}

export function getOracleStatus(lastUpdate: number): 'active' | 'degraded' | 'inactive' {
  const now = Math.floor(Date.now() / 1000);
  const timeSinceUpdate = now - lastUpdate;

  if (timeSinceUpdate < 1800) return 'active'; // Less than 30 minutes
  if (timeSinceUpdate < 3600) return 'degraded'; // Less than 1 hour
  return 'inactive';
}

export function calculateOracleCountdown(lastUpdate: number): number {
  const now = Math.floor(Date.now() / 1000);
  const timeSinceUpdate = now - lastUpdate;
  const updateInterval = 300; // 5 minutes

  const nextUpdate = lastUpdate + updateInterval;
  const countdown = Math.max(0, nextUpdate - now);

  return countdown;
}

export function generateMockPerformance(months: number): number[] {
  const performance: number[] = [];
  for (let i = 0; i < months; i++) {
    // Generate realistic-looking performance data
    const baseReturn = 5 + Math.random() * 15;
    const volatility = (Math.random() - 0.5) * 10;
    performance.push(Number((baseReturn + volatility).toFixed(2)));
  }
  return performance;
}

export function calculateRealArbitrageOpportunity(backingRatio: number): number {
  // Calculate the real arbitrage opportunity based on backing ratio deviation
  const targetRatio = 100; // 100% backing
  const deviation = Math.abs(backingRatio - targetRatio);

  // Convert to arbitrage opportunity percentage
  // A 1% deviation from 100% backing = potential arbitrage
  if (deviation < 0.05) {
    return 0; // No meaningful arbitrage opportunity
  }

  // Return deviation as percentage (capped at 10%)
  return Math.min(deviation, 10);
}

// ============ CACHE HELPERS ============

export function getPositionNftFromLocalStorage(riftId: string): { meteoraPool?: string; meteoraPools?: string[]; positionNftMint?: string; hasMeteoraPool?: boolean; cachedAt?: number } | null {
  try {
    if (typeof window !== 'undefined') {
      const key = `rift_metadata_${riftId}`;
      const existingData = localStorage.getItem(key);
      if (existingData) {
        return JSON.parse(existingData);
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function savePositionNftToLocalStorage(riftId: string, data: { meteoraPool?: string; meteoraPools?: string[]; positionNftMint?: string; hasMeteoraPool?: boolean }): void {
  try {
    if (typeof window !== 'undefined') {
      const key = `rift_metadata_${riftId}`;
      localStorage.setItem(key, JSON.stringify({
        ...data,
        cachedAt: Date.now()
      }));
    }
  } catch {
    // Ignore storage errors
  }
}

// ============ MINT HELPERS ============

export async function getMintSymbol(connection: Connection, mint: string): Promise<string> {
  try {
    // Check known mints first
    if (mint === 'So11111111111111111111111111111111111111112') return 'SOL';
    if (mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return 'USDC';
    if (mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') return 'USDT';
    if (mint === 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump') return 'RIFTS';
    if (mint === 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB') return 'USD1';

    // Try to get from RPC
    const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
    const accountInfo = await connection.getAccountInfo(new PublicKey(mint));

    if (!accountInfo) {
      return 'UNKNOWN';
    }

    // Try parsed token info
    const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
    if (mintInfo.value?.data && 'parsed' in mintInfo.value.data) {
      const parsedData = mintInfo.value.data.parsed;
      if (parsedData.info?.extensions) {
        for (const extension of parsedData.info.extensions) {
          if (extension.extension === 'tokenMetadata' && extension.state?.symbol) {
            return extension.state.symbol;
          }
        }
      }
    }

    // Return truncated mint as fallback
    return mint.slice(0, 4) + '...' + mint.slice(-4);
  } catch {
    return 'UNKNOWN';
  }
}

export async function getCachedMintDecimals(
  connection: Connection,
  mint: PublicKey,
  mintInfoCache: { [key: string]: { decimals: number; timestamp: number } },
  MINT_CACHE_TTL: number,
  programId?: PublicKey
): Promise<number> {
  const mintKey = mint.toBase58();
  const now = Date.now();

  // 1. Check memory cache (instant)
  if (mintInfoCache[mintKey] && (now - mintInfoCache[mintKey].timestamp) < MINT_CACHE_TTL) {
    return mintInfoCache[mintKey].decimals;
  }

  // 2. Try Supabase cache (fast - pre-populated with common tokens)
  try {
    const { data: supabaseData } = await supabase
      .from('mint_metadata')
      .select('decimals')
      .eq('mint_address', mintKey)
      .maybeSingle();

    if (supabaseData?.decimals !== undefined) {
      mintInfoCache[mintKey] = { decimals: supabaseData.decimals, timestamp: now };
      return supabaseData.decimals;
    }
  } catch {
    // Supabase not available, continue to RPC
  }

  // 3. Fetch from RPC (slowest - only for tokens not in Supabase)
  try {
    const { getMint, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
    const effectiveProgramId = programId || TOKEN_PROGRAM_ID;
    const mintInfo = await getMint(connection, mint, 'confirmed', effectiveProgramId);

    // Cache in memory
    mintInfoCache[mintKey] = { decimals: mintInfo.decimals, timestamp: now };

    // Save to Supabase for future (async, don't await)
    saveMintMetadata(mintKey, mintInfo.decimals).catch(() => {});

    return mintInfo.decimals;
  } catch {
    // Try with Token-2022 if standard failed
    try {
      const { getMint, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
      const mintInfo = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
      mintInfoCache[mintKey] = { decimals: mintInfo.decimals, timestamp: now };
      saveMintMetadata(mintKey, mintInfo.decimals).catch(() => {});
      return mintInfo.decimals;
    } catch {
      throw new Error(`Failed to fetch decimals for mint ${mintKey}`);
    }
  }
}

async function saveMintMetadata(mintAddress: string, decimals: number): Promise<void> {
  try {
    await supabase
      .from('mint_metadata')
      .upsert({ mint_address: mintAddress, decimals, updated_at: new Date().toISOString() }, { onConflict: 'mint_address' });
  } catch {
    // Ignore save errors
  }
}

// ============ FILTER HELPERS ============

export function filterBlacklistedRifts(rifts: ProductionRiftData[]): ProductionRiftData[] {
  return rifts.filter(rift => !BLACKLISTED_RIFTS.includes(rift.id));
}

export function isV1Rift(riftAddress: string): boolean {
  return V1_RIFTS.includes(riftAddress);
}

export function getProgramIdForRiftAddress(riftAddress: string): PublicKey {
  if (V1_RIFTS.includes(riftAddress)) {
    return RIFTS_V1_PROGRAM_ID;
  }
  return RIFTS_PROGRAM_ID;
}
