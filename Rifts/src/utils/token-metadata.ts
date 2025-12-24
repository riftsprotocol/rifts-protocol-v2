// utils/token-metadata.ts - Token Metadata Fetching Utilities

import { Connection, PublicKey } from '@solana/web3.js';

export interface TokenMetadata {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  source: 'jupiter' | 'metaplex' | 'onchain' | 'unknown';
}

// Normalize IPFS logos to a working gateway
const normalizeLogoUri = (uri?: string): string | undefined => {
  if (!uri) return undefined;
  if (uri.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${uri.replace('ipfs://', '')}`;
  }
  if (uri.includes('cf-ipfs.com/ipfs/')) {
    return uri.replace('cf-ipfs.com', 'ipfs.io');
  }
  return uri;
};

// Ensure we have a real Connection with parsed account helpers
const getUsableConnection = (conn?: Connection): Connection | null => {
  if (!conn) return null;
  // RateLimitedConnection stores raw connection on .connection
  const raw = (conn as any).connection;
  if (raw?.getParsedAccountInfo) return raw as Connection;
  if ((conn as any).getParsedAccountInfo) return conn;
  // Fallback to a fresh Connection if needed
  const rpc =
    process.env.NEXT_PUBLIC_SOLANA_RPC ||
    process.env.SOLANA_RPC_URL ||
    'https://api.mainnet-beta.solana.com';
  try {
    return new Connection(rpc, 'confirmed');
  } catch {
    return null;
  }
};

/**
 * Fetch token metadata from Jupiter Token List API (fastest and most comprehensive)
 */
async function fetchFromJupiter(mintAddress: string): Promise<TokenMetadata | null> {
  try {
    const response = await fetch('https://token.jup.ag/all');
    if (!response.ok) return null;

    const tokens = await response.json();
    const token = tokens.find((t: TokenMetadata) => t.address === mintAddress);

    if (token) {
      return {
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        logoURI: normalizeLogoUri(token.logoURI),
        source: 'jupiter'
      };
    }

    return null;
  } catch (error) {
    console.warn('Failed to fetch from Jupiter:', error);
    return null;
  }
}

/**
 * Fetch token metadata from Metaplex Metadata Program
 */
async function fetchFromMetaplex(
  connection: Connection,
  mintAddress: string
): Promise<TokenMetadata | null> {
  try {
    const usableConnection = getUsableConnection(connection);
    if (!usableConnection) {
      console.warn('No usable connection for Metaplex fetch');
      return null;
    }

    const mintPubkey = new PublicKey(mintAddress);

    // Derive Metaplex metadata PDA
    const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('metadata'),
        METADATA_PROGRAM_ID.toBuffer(),
        mintPubkey.toBuffer(),
      ],
      METADATA_PROGRAM_ID
    );

    // Fetch metadata account
    const accountInfo = await usableConnection.getAccountInfo(metadataPDA);
    if (!accountInfo) return null;

    // Parse metadata (simplified - full Metaplex parsing would require @metaplex-foundation/mpl-token-metadata)
    // This is a basic implementation that gets the essential data
    const data = accountInfo.data;

    console.log('📦 Parsing Metaplex metadata, data size:', data.length);

    // Skip key (1 byte) and update authority (32 bytes) and mint (32 bytes)
    let offset = 1 + 32 + 32;

    // Read name (first 4 bytes = length, then string)
    const nameLength = data.readUInt32LE(offset);
    offset += 4;
    console.log('  Name length:', nameLength);

    if (nameLength > 200) {
      console.warn('  ⚠️ Name length seems invalid, skipping Metaplex parsing');
      throw new Error('Invalid name length in Metaplex metadata');
    }

    const name = data.slice(offset, offset + nameLength).toString('utf8').replace(/\0/g, '').trim();
    offset += nameLength;
    console.log('  Name:', name);

    // Read symbol (first 4 bytes = length, then string)
    const symbolLength = data.readUInt32LE(offset);
    offset += 4;
    console.log('  Symbol length:', symbolLength);

    if (symbolLength > 50) {
      console.warn('  ⚠️ Symbol length seems invalid, skipping Metaplex parsing');
      throw new Error('Invalid symbol length in Metaplex metadata');
    }

    const symbol = data.slice(offset, offset + symbolLength).toString('utf8').replace(/\0/g, '').trim();
    offset += symbolLength;
    console.log('  Symbol:', symbol);

    // Read URI (first 4 bytes = length, then string)
    const uriLength = data.readUInt32LE(offset);
    offset += 4;
    console.log('  URI length:', uriLength);

    if (uriLength > 500) {
      console.warn('  ⚠️ URI length seems invalid, but continuing...');
    }

    const uri = data.slice(offset, offset + uriLength).toString('utf8').replace(/\0/g, '').trim();
    console.log('  URI:', uri?.substring(0, 50) + '...');

    // Try to fetch logo from URI if it's a valid URL
    let logoURI: string | undefined;
    if (uri && uri.startsWith('http')) {
      try {
        const uriResponse = await fetch(uri);
        if (uriResponse.ok) {
          const metadata = await uriResponse.json();
          logoURI = normalizeLogoUri(metadata.image);
        }
      } catch {
        // Failed to fetch URI metadata, continue without logo
      }
    }

    // Get mint info for decimals
    const mintInfo = await usableConnection.getParsedAccountInfo(mintPubkey);
    const decimals = (mintInfo.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info?.decimals ?? 9;

    return {
      address: mintAddress,
      symbol: symbol || 'UNKNOWN',
      name: name || 'Unknown Token',
      decimals,
      logoURI: normalizeLogoUri(logoURI),
      source: 'metaplex'
    };
  } catch (error) {
    console.warn('Failed to fetch from Metaplex:', error);
    return null;
  }
}

/**
 * Fetch token metadata from Token-2022 Metadata Extension (pump.fun tokens use this!)
 */
async function fetchFromToken2022Extension(
  connection: Connection,
  mintAddress: string
): Promise<TokenMetadata | null> {
  try {
    const usableConnection = getUsableConnection(connection);
    if (!usableConnection) {
      console.warn('No usable connection for Token-2022 extension fetch');
      return null;
    }

    const mintPubkey = new PublicKey(mintAddress);
    const accountInfo = await usableConnection.getAccountInfo(mintPubkey);

    if (!accountInfo) return null;

    // Check if this is a Token-2022 token
    const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    if (accountInfo.owner.toBase58() !== TOKEN_2022_PROGRAM_ID) {
      console.log('  Not a Token-2022 token, skipping extension check');
      return null;
    }

    console.log('🔍 Token-2022 detected, parsing metadata extension...');
    const data = accountInfo.data;

    // Get decimals from mint (offset 44)
    const decimals = data[44];

    // Token-2022 mint account structure:
    // - Basic mint data: 82 bytes
    // - Padding: 83 bytes (to byte 165)
    // - Account type byte at 165 (1 = Mint)
    // - Extensions start at byte 166 in TLV format

    let name = '';
    let symbol = '';
    let uri = '';

    // Start at extension area (byte 166)
    let offset = 166;

    // Parse TLV extensions
    while (offset + 4 <= data.length) {
      const extensionType = data.readUInt16LE(offset);
      const extensionLength = data.readUInt16LE(offset + 2);

      if (extensionLength === 0 || offset + 4 + extensionLength > data.length) break;

      const extData = data.slice(offset + 4, offset + 4 + extensionLength);

      // Extension type 19 = TokenMetadata (the actual name/symbol/uri data)
      if (extensionType === 19) {
        console.log('  Found TokenMetadata extension (type 19) at offset', offset);

        // TokenMetadata extension format:
        // - update_authority: 32 bytes (pubkey, zeros if none)
        // - mint: 32 bytes (pubkey)
        // - name: 4 bytes length + string
        // - symbol: 4 bytes length + string
        // - uri: 4 bytes length + string

        let mOff = 0;

        // Skip update_authority (32 bytes)
        mOff += 32;

        // Skip mint (32 bytes)
        mOff += 32;

        // Read name
        if (mOff + 4 <= extData.length) {
          const nameLen = extData.readUInt32LE(mOff);
          mOff += 4;
          if (nameLen > 0 && nameLen < 200 && mOff + nameLen <= extData.length) {
            name = extData.slice(mOff, mOff + nameLen).toString('utf8').replace(/\0/g, '').trim();
            mOff += nameLen;
            console.log('  Name:', name);
          }
        }

        // Read symbol
        if (mOff + 4 <= extData.length) {
          const symbolLen = extData.readUInt32LE(mOff);
          mOff += 4;
          if (symbolLen > 0 && symbolLen < 50 && mOff + symbolLen <= extData.length) {
            symbol = extData.slice(mOff, mOff + symbolLen).toString('utf8').replace(/\0/g, '').trim();
            mOff += symbolLen;
            console.log('  Symbol:', symbol);
          }
        }

        // Read URI
        if (mOff + 4 <= extData.length) {
          const uriLen = extData.readUInt32LE(mOff);
          mOff += 4;
          if (uriLen > 0 && uriLen < 500 && mOff + uriLen <= extData.length) {
            uri = extData.slice(mOff, mOff + uriLen).toString('utf8').replace(/\0/g, '').trim();
            console.log('  URI:', uri?.substring(0, 50) + '...');
          }
        }

        break; // Found metadata, stop searching
      }

      offset += 4 + extensionLength;
    }

    if (symbol || name) {
      // Try to fetch logo from URI
      let logoURI: string | undefined;
      if (uri && uri.startsWith('http')) {
        try {
          const uriResponse = await fetch(uri);
          if (uriResponse.ok) {
            const metadata = await uriResponse.json();
            logoURI = normalizeLogoUri(metadata.image);
          }
        } catch {
          // Failed to fetch URI metadata
        }
      }

      return {
        address: mintAddress,
        symbol: symbol || 'UNKNOWN',
        name: name || 'Unknown Token',
        decimals,
        logoURI: normalizeLogoUri(logoURI),
        source: 'onchain'
      };
    }

    return null;
  } catch (error) {
    console.warn('Failed to fetch from Token-2022 extension:', error);
    return null;
  }
}

/**
 * Fetch token metadata from on-chain SPL token data (last resort)
 */
async function fetchFromOnchain(
  connection: Connection,
  mintAddress: string
): Promise<TokenMetadata | null> {
  try {
    const usableConnection = getUsableConnection(connection);
    if (!usableConnection) {
      console.warn('No usable connection for on-chain fetch');
      return null;
    }

    const mintPubkey = new PublicKey(mintAddress);
    const mintInfo = await usableConnection.getParsedAccountInfo(mintPubkey);

    if (!mintInfo.value) return null;

    const decimals = (mintInfo.value.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info?.decimals ?? 9;

    // Extract a simple symbol from the address (not ideal, but better than nothing)
    const shortAddress = mintAddress.slice(0, 4).toUpperCase();

    return {
      address: mintAddress,
      symbol: shortAddress,
      name: `Token ${shortAddress}`,
      decimals,
      source: 'onchain'
    };
  } catch (error) {
    console.warn('Failed to fetch from on-chain:', error);
    return null;
  }
}

/**
 * Known token metadata (hardcoded fallback for common tokens)
 */
const KNOWN_TOKENS: { [address: string]: TokenMetadata } = {
  'So11111111111111111111111111111111111111112': {
    address: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    name: 'Wrapped SOL',
    decimals: 9,
    source: 'jupiter'
  },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': {
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    source: 'jupiter'
  }
};

/**
 * Main function to fetch token metadata with multiple fallbacks
 * Tries Known Tokens -> Jupiter -> Metaplex -> On-chain in order
 */
export async function fetchTokenMetadata(
  mintAddress: string,
  connection?: Connection
): Promise<TokenMetadata | null> {
  const normalized = mintAddress?.trim?.() || mintAddress;
  // Early reject obviously bad inputs (whitespace, too short/long)
  if (!normalized || normalized.length < 32 || normalized.length > 44 || /\s/.test(normalized)) {
    console.warn('Skipping metadata fetch for invalid mint input:', normalized);
    return null;
  }

  // Validate mint address
  try {
    new PublicKey(normalized);
  } catch {
    console.error('Invalid mint address:', normalized);
    return null;
  }

  // Try Jupiter first (fastest and most comprehensive)
  console.log('🔍 Attempting to fetch metadata from Jupiter...');
  try {
    const jupiterData = await fetchFromJupiter(normalized);
    if (jupiterData) {
      console.log('✅ Found metadata from Jupiter:', jupiterData.symbol);
      return jupiterData;
    }
  } catch (error) {
    console.warn('⚠️ Jupiter fetch failed, trying Metaplex fallback...', error);
  }

  // If connection is provided (or we can build one), try Metaplex, Token-2022, and on-chain
  const usableConnection = connection ? getUsableConnection(connection) : getUsableConnection(undefined as any);
  if (usableConnection) {
    console.log('🔍 Attempting to fetch metadata from Metaplex...');
    try {
      const metaplexData = await fetchFromMetaplex(usableConnection, normalized);
      if (metaplexData) {
        console.log('✅ Found metadata from Metaplex:', metaplexData.symbol);
        return metaplexData;
      }
    } catch (error) {
      console.warn('⚠️ Metaplex fetch failed, trying Token-2022 extension...', error);
    }

    // Try Token-2022 metadata extension (pump.fun tokens use this!)
    console.log('🔍 Attempting to fetch metadata from Token-2022 extension...');
    try {
      const token2022Data = await fetchFromToken2022Extension(usableConnection, mintAddress);
      if (token2022Data) {
        console.log('✅ Found metadata from Token-2022 extension:', token2022Data.symbol);
        return token2022Data;
      }
    } catch (error) {
      console.warn('⚠️ Token-2022 extension fetch failed, trying on-chain fallback...', error);
    }

    console.log('🔍 Attempting to fetch metadata from on-chain mint...');
    try {
      const onchainData = await fetchFromOnchain(usableConnection, mintAddress);
      if (onchainData) {
        console.log('✅ Found metadata from on-chain:', onchainData.symbol);
        return onchainData;
      }
    } catch (error) {
      console.warn('⚠️ On-chain fetch failed:', error);
    }
  } else {
    console.warn('⚠️ No connection provided, skipping Metaplex, Token-2022, and on-chain fallbacks');
  }

  // As a last resort, fall back to known tokens to avoid total failure
  if (KNOWN_TOKENS[mintAddress]) {
    const fallback = KNOWN_TOKENS[mintAddress];
    console.log('✅ Using known token fallback:', fallback.symbol);
    return { ...fallback, logoURI: normalizeLogoUri(fallback.logoURI) };
  }

  // No metadata found
  console.error('❌ No metadata found for token:', mintAddress);
  return null;
}

/**
 * Generate rift token symbol from underlying token symbol
 * E.g., "USDC" -> "rUSDC", "SOL" -> "rSOL"
 */
export function generateRiftSymbol(underlyingSymbol: string): string {
  return `r${underlyingSymbol}`;
}

/**
 * Generate rift token name from underlying token name
 * E.g., "USD Coin" -> "Rift USD Coin", "Solana" -> "Rift Solana"
 */
export function generateRiftName(underlyingName: string): string {
  return `Rift ${underlyingName}`;
}
