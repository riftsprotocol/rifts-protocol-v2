import { createClient } from '@supabase/supabase-js';
import { Connection } from '@solana/web3.js';
import { getHeliusHttpRpcUrl } from '@/lib/solana/rpc-endpoints';

// String constants - PublicKey created dynamically to avoid bundling issues
const PROGRAM_ID_V2_STR = '29JgMGWZ28CSF7JLStKFp8xb4BZyf7QitG5CHcfRBYoR'; // V2 program
const PROGRAM_ID_V1_STR = '9qomJJ5jMzaKu9JXgMzbA3KEyQ3kqcW7hN3xq3tMEkww'; // V1 program
const TREASURY_WALLET = '5NrHu6zpWqYT6LH74WmTNFHGcxZEmRMVK4hR7sHjS9Fc';
const PROTOCOL_AUTHORITY = '9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4'; // Main protocol authority
const RIFTS_TOKEN_MINT = 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';

// Cache for token decimals fetched from chain
const decimalsCache: Record<string, number> = {};
let cachedConnection: Connection | null = null;
async function getHttpConnection(): Promise<Connection> {
  if (!cachedConnection) {
    const rpcUrl = getHeliusHttpRpcUrl();
    cachedConnection = new Connection(rpcUrl, { commitment: 'confirmed' });
  }
  return cachedConnection;
}

// Get decimals for a token mint by fetching from chain
async function getDecimals(connection: any, mint: string | undefined): Promise<number> {
  if (!mint) return 9;

  // Check cache first
  if (decimalsCache[mint] !== undefined) {
    return decimalsCache[mint];
  }

  try {
    const { PublicKey } = await import('@solana/web3.js');
    const mintPubkey = new PublicKey(mint);
    const mintInfo = await connection.getParsedAccountInfo(mintPubkey);

    if (mintInfo?.value?.data?.parsed?.info?.decimals !== undefined) {
      const decimals = mintInfo.value.data.parsed.info.decimals;
      decimalsCache[mint] = decimals;
      return decimals;
    }
  } catch (error) {
    console.error(`Error fetching decimals for ${mint}:`, error);
  }

  // Default to 9 if we can't fetch
  return 9;
}

// Helper function to fetch with retry logic
async function fetchWithRetry(url: string, maxRetries = 3, delayMs = 500): Promise<Response | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url);
      return response;
    } catch (error: any) {
      const isRetryable = error?.code === 'ENOTFOUND' ||
                         error?.code === 'ETIMEDOUT' ||
                         error?.code === 'ECONNRESET' ||
                         error?.message?.includes('getaddrinfo') ||
                         error?.message?.includes('DNS');

      if (isRetryable && attempt < maxRetries) {
        console.log(`[RETRY] Attempt ${attempt}/${maxRetries} failed for ${url.slice(0, 50)}..., retrying in ${delayMs}ms`);
        await new Promise(r => setTimeout(r, delayMs * attempt)); // Exponential backoff
        continue;
      }
      throw error;
    }
  }
  return null;
}

// Get token price using shared server-side cache
// This avoids duplicate Jupiter/DexScreener API calls across all endpoints
async function getTokenPriceUSD(mintAddress: string): Promise<number> {
  try {
    const { getCachedPrice } = await import('@/lib/server-price-cache');
    return await getCachedPrice(mintAddress);
  } catch (error: any) {
    console.log(`[PRICE] Failed to get cached price for ${mintAddress.slice(0, 8)}...: ${error?.message || 'unknown'}`);
    return 0;
  }
}

// Get SOL price using shared cache
async function getSOLPriceUSD(): Promise<number> {
  return getTokenPriceUSD('So11111111111111111111111111111111111111112');
}

// Derive vault PDAs for a rift (programId passed as parameter)
async function deriveVaultPDAs(riftPubkey: any, programId: any) {
  const { PublicKey } = await import('@solana/web3.js');

  const [feesVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('fees_vault'), riftPubkey.toBuffer()],
    programId
  );

  const [withheldVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('withheld_vault'), riftPubkey.toBuffer()],
    programId
  );

  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), riftPubkey.toBuffer()],
    programId
  );

  return { feesVault, withheldVault, vault };
}

// Get token account balance - supports both SPL Token and Token-2022
async function getTokenBalance(connection: any, accountPubkey: any): Promise<bigint> {
  try {
    // Use getParsedAccountInfo for better compatibility with Token-2022
    const accountInfo = await connection.getParsedAccountInfo(accountPubkey);
    if (!accountInfo?.value) return BigInt(0);

    const data = accountInfo.value.data;

    // If parsed data available (works for both Token and Token-2022)
    if (data?.parsed?.info?.tokenAmount?.amount) {
      return BigInt(data.parsed.info.tokenAmount.amount);
    }

    // Fallback to raw bytes for standard SPL Token
    if (Buffer.isBuffer(data) && data.length >= 72) {
      return data.readBigUInt64LE(64);
    }

    return BigInt(0);
  } catch (error) {
    console.error('Error fetching token balance:', error);
    return BigInt(0);
  }
}

// Get RIFTS token balance for a wallet (finds associated token account)
async function getWalletRiftsBalance(connection: any, walletPubkey: any): Promise<bigint> {
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const riftsMint = new PublicKey(RIFTS_TOKEN_MINT);
    const tokenAccounts = await connection.getTokenAccountsByOwner(walletPubkey, { mint: riftsMint });

    let totalBalance = BigInt(0);
    for (const { account } of tokenAccounts.value) {
      if (account.data.length >= 72) {
        totalBalance += account.data.readBigUInt64LE(64);
      }
    }
    return totalBalance;
  } catch (error) {
    console.error('Error fetching RIFTS balance:', error);
    return BigInt(0);
  }
}

// Known rift token mints to check in treasury (rRIFTS, rSOL, etc.)
const RIFT_TOKEN_MINTS = [
  'H8wDrayqi5YrBqkc162JU1cVyHvX4rMcjxLzPzNNFToS', // rRIFTS
  'CP3k7ZWoWmj89mnyPzexDuLZTghJ7yYktD12f2kna63R', // rSOL
];

// Get all rift token balances for a wallet (Token-2022 accounts)
async function getWalletRiftTokenBalances(connection: any, walletPubkey: any, priceMap: Record<string, number>): Promise<{ totalUSD: number; breakdown: any[] }> {
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
      programId: TOKEN_2022_PROGRAM
    });

    let totalUSD = 0;
    const breakdown: any[] = [];

    for (const { account } of tokenAccounts.value) {
      const info = account.data.parsed?.info;
      if (!info) continue;

      const mint = info.mint;
      const balance = info.tokenAmount?.uiAmount || 0;

      if (balance > 0 && RIFT_TOKEN_MINTS.includes(mint)) {
        const price = priceMap[mint] || 0;
        const usd = balance * price;
        totalUSD += usd;
        breakdown.push({ mint, balance, price, usd });
        console.log(`[TREASURY RIFT TOKEN] ${mint.slice(0,8)}...: ${balance.toFixed(2)} * $${price.toFixed(6)} = $${usd.toFixed(2)}`);
      }
    }

    return { totalUSD, breakdown };
  } catch (error) {
    console.error('Error fetching rift token balances:', error);
    return { totalUSD: 0, breakdown: [] };
  }
}

export interface VaultBalancesResult {
  legacyFees: number;
  treasury: {
    solBalance: number;
    solUSD: number;
    riftsBalance: number;
    riftsUSD: number;
  };
  authority: {
    solBalance: number;
    solUSD: number;
    totalUSD: number;
  };
  treasuryBalanceSOL: number;
  treasuryBalanceUSD: number;
  authorityBalanceUSD: number;
  vaultBalances: any[];
  totalVaultFeesFullUSD: number;
  totalVaultFeesUSD: number;
  grandTotalUSD: number;
  solPrice: number;
  riftsPrice: number;
  lastUpdated: string;
}

// Main function to calculate vault balances - can be called directly without HTTP
export async function calculateVaultBalances(): Promise<VaultBalancesResult> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

  // Dynamic imports to avoid bundling issues with @solana/web3.js
  const { PublicKey } = await import('@solana/web3.js');
  const connection = await getHttpConnection();
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Create PublicKey objects now that we have the import
  const PROGRAM_ID_V2 = new PublicKey(PROGRAM_ID_V2_STR);
  const PROGRAM_ID_V1 = new PublicKey(PROGRAM_ID_V1_STR);

  // Fetch all rifts from database
  const { data: rifts } = await supabase
    .from('rifts')
    .select('*');

  if (!rifts || rifts.length === 0) {
    return {
      legacyFees: 2363.32,
      treasury: { solBalance: 0, solUSD: 0, riftsBalance: 0, riftsUSD: 0 },
      authority: { solBalance: 0, solUSD: 0, totalUSD: 0 },
      treasuryBalanceSOL: 0,
      treasuryBalanceUSD: 0,
      authorityBalanceUSD: 0,
      vaultBalances: [],
      totalVaultFeesFullUSD: 0,
      totalVaultFeesUSD: 0,
      grandTotalUSD: 2363.32,
      solPrice: 0,
      riftsPrice: 0,
      lastUpdated: new Date().toISOString()
    };
  }

  // Get prices from rifts data (more reliable than Jupiter API which may be rate-limited)
  const priceMap: Record<string, number> = {};
  rifts.forEach((rift: any) => {
    if (rift.raw_data?.underlyingMint && rift.raw_data?.underlyingTokenPrice) {
      priceMap[rift.raw_data.underlyingMint] = rift.raw_data.underlyingTokenPrice;
    }
    if (rift.raw_data?.riftMint && rift.raw_data?.riftTokenPrice) {
      priceMap[rift.raw_data.riftMint] = rift.raw_data.riftTokenPrice;
    }
  });

  // Get SOL price - ALWAYS fetch fresh from Jupiter (database prices are stale)
  const solMint = 'So11111111111111111111111111111111111111112';
  const solPrice = await getSOLPriceUSD();
  // Update priceMap with fresh SOL price for other calculations
  priceMap[solMint] = solPrice;

  // Get RIFTS price - ALWAYS fetch fresh from Jupiter (cache can be stale)
  const riftsPrice = await getTokenPriceUSD(RIFTS_TOKEN_MINT);
  // Update priceMap with fresh RIFTS price for other calculations
  priceMap[RIFTS_TOKEN_MINT] = riftsPrice;
  console.log(`[PRICES] SOL: $${solPrice.toFixed(2)}, RIFTS: $${riftsPrice.toFixed(6)}`);

  // Fetch treasury SOL balance
  const treasuryPubkey = new PublicKey(TREASURY_WALLET);
  const treasuryBalance = await connection.getBalance(treasuryPubkey);
  const treasurySOL = Number(treasuryBalance) / 1e9;
  const treasurySOLUSD = treasurySOL * solPrice;

  // Fetch treasury RIFTS balance
  const treasuryRiftsBalance = await getWalletRiftsBalance(connection, treasuryPubkey);
  const treasuryRiftsHuman = Number(treasuryRiftsBalance) / 1e6; // RIFTS has 6 decimals
  const treasuryRiftsUSD = treasuryRiftsHuman * riftsPrice;

  // Fetch treasury rift token balances (rRIFTS, rSOL, etc. - Token-2022)
  const treasuryRiftTokens = await getWalletRiftTokenBalances(connection, treasuryPubkey, priceMap);

  console.log(`[TREASURY] SOL: ${treasurySOL.toFixed(4)} ($${treasurySOLUSD.toFixed(2)}), RIFTS: ${treasuryRiftsHuman.toFixed(2)} ($${treasuryRiftsUSD.toFixed(2)}), Rift Tokens: $${treasuryRiftTokens.totalUSD.toFixed(2)}`);

  // Total treasury balance (SOL + RIFTS + Rift Tokens)
  const treasuryBalanceUSD = treasurySOLUSD + treasuryRiftsUSD + treasuryRiftTokens.totalUSD;

  // Fetch protocol authority SOL balance only (RIFTS in this wallet is not protocol revenue)
  const authorityPubkey = new PublicKey(PROTOCOL_AUTHORITY);
  const authoritySOLBalance = await connection.getBalance(authorityPubkey);
  const authoritySOL = Number(authoritySOLBalance) / 1e9;
  const authoritySOLUSD = authoritySOL * solPrice;
  console.log(`[AUTHORITY] SOL: ${authoritySOL.toFixed(4)} ($${authoritySOLUSD.toFixed(2)})`);

  // Process each rift
  const vaultBalances = await Promise.all(rifts.map(async (rift) => {
    try {
      const riftPubkey = new PublicKey(rift.id); // Rift pubkey is stored in 'id' field

      // Determine which program ID to use based on the rift's program_id field
      const programId = rift.program_id === PROGRAM_ID_V1.toBase58() ? PROGRAM_ID_V1 : PROGRAM_ID_V2;

      const { feesVault, withheldVault } = await deriveVaultPDAs(riftPubkey, programId);

      // Get underlying mint and rift mint from rift data
      const underlyingMint = rift.raw_data?.underlyingMint || rift.underlying_mint;
      const riftMint = rift.token_mint || rift.raw_data?.riftMint;

      // Fetch vault balances
      const [feesBalance, withheldBalance] = await Promise.all([
        getTokenBalance(connection, feesVault),
        getTokenBalance(connection, withheldVault)
      ]);

      // Get token prices (use priceMap first, fallback to Jupiter API)
      const underlyingPrice = underlyingMint ? (priceMap[underlyingMint] || (await getTokenPriceUSD(underlyingMint))) : 0;
      const riftPrice = riftMint ? (priceMap[riftMint] || (await getTokenPriceUSD(riftMint))) : 0;

      // Get correct decimals for each token (fetch from chain)
      const [underlyingDecimals, riftDecimals] = await Promise.all([
        getDecimals(connection, underlyingMint),
        getDecimals(connection, riftMint)
      ]);

      // Calculate USD values with correct decimals
      const feesHuman = Number(feesBalance) / Math.pow(10, underlyingDecimals);
      const withheldHuman = Number(withheldBalance) / Math.pow(10, riftDecimals);
      const feesUSD = feesHuman * underlyingPrice;
      const withheldUSD = withheldHuman * riftPrice;
      const totalUSD = feesUSD + withheldUSD;

      console.log(`[VAULT] ${rift.token_symbol}: fees=${feesHuman.toFixed(4)} (${underlyingDecimals}d) * $${underlyingPrice.toFixed(4)} = $${feesUSD.toFixed(2)}, withheld=${withheldHuman.toFixed(4)} (${riftDecimals}d) * $${riftPrice.toFixed(4)} = $${withheldUSD.toFixed(2)}`);

      return {
        riftId: rift.id,
        riftSymbol: rift.token_symbol,
        riftPubkey: rift.id,
        feesVault: feesVault.toBase58(),
        withheldVault: withheldVault.toBase58(),
        feesBalanceRaw: feesBalance.toString(),
        feesBalanceHuman: feesHuman,
        withheldBalanceRaw: withheldBalance.toString(),
        withheldBalanceHuman: withheldHuman,
        underlyingDecimals,
        riftDecimals,
        feesUSD,
        withheldUSD,
        totalUSD,
        underlyingMint,
        riftMint
      };
    } catch (error) {
      console.error(`Error processing rift ${rift.id}:`, error);
      return {
        riftId: rift.id,
        riftSymbol: rift.token_symbol,
        riftPubkey: rift.id, // Rift pubkey is stored in 'id' field
        error: 'Failed to fetch',
        feesUSD: 0,
        withheldUSD: 0,
        totalUSD: 0
      };
    }
  }));

  // Sum up all vault fees (only 50% is ours, other 50% goes to partner)
  const totalVaultFeesFullUSD = vaultBalances.reduce((sum, v) => sum + v.totalUSD, 0);
  const totalVaultFeesUSD = totalVaultFeesFullUSD * 0.5; // Our share (50%)

  // Authority wallet total (SOL only)
  const authorityBalanceUSD = authoritySOLUSD;

  // Grand total = legacy fees (claimed) + treasury + authority + current vault fees (50%)
  const legacyFees = 2363.32; // Already claimed fees (hardcoded base)
  const grandTotalUSD = legacyFees + treasuryBalanceUSD + authorityBalanceUSD + totalVaultFeesUSD;

  return {
    legacyFees, // Hardcoded base ($2,363 already claimed)
    treasury: {
      solBalance: treasurySOL,
      solUSD: treasurySOLUSD,
      riftsBalance: treasuryRiftsHuman,
      riftsUSD: treasuryRiftsUSD
    },
    authority: {
      solBalance: authoritySOL,
      solUSD: authoritySOLUSD,
      totalUSD: authorityBalanceUSD
    },
    treasuryBalanceSOL: treasurySOL,
    treasuryBalanceUSD, // Combined: treasury SOL + treasury RIFTS
    authorityBalanceUSD,
    vaultBalances,
    totalVaultFeesFullUSD, // Full vault fees (before 50% split)
    totalVaultFeesUSD, // Our share (50%)
    grandTotalUSD,
    solPrice,
    riftsPrice,
    lastUpdated: new Date().toISOString()
  };
}
