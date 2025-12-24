// Server-side account cache - dramatically speeds up account fetches
// Acts as a smart RPC proxy that caches account data
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// In-memory cache: Map<publicKey, { data: any | null, timestamp: number }>
const accountCache = new Map<string, { data: any; timestamp: number }>();

// Cache TTL: 30 seconds (accounts change, but not that frequently)
const CACHE_TTL = 30000;

interface AccountRequest {
  accounts: string[]; // Array of public key strings
}

export async function POST(request: NextRequest) {
  try {
    // Dynamic import to avoid bundling issues
    const { PublicKey } = await import('@solana/web3.js');
    const { getServerConnection } = await import('@/lib/solana/server-connection');
    const connection = await getServerConnection();

    const body: AccountRequest = await request.json();
    const { accounts } = body;

    if (!accounts || !Array.isArray(accounts)) {
      return NextResponse.json(
        { error: 'accounts array is required' },
        { status: 400 }
      );
    }

    console.log(`[ACCOUNT-CACHE] Request for ${accounts.length} accounts`);

    const now = Date.now();
    const results: (any | null)[] = [];
    const accountsToFetch: { index: number; pubkey: InstanceType<typeof PublicKey> }[] = [];

    // Check cache for each account
    for (let i = 0; i < accounts.length; i++) {
      const pubkeyStr = accounts[i];
      const cached = accountCache.get(pubkeyStr);

      if (cached && (now - cached.timestamp) < CACHE_TTL) {
        // Cache hit
        console.log(`[ACCOUNT-CACHE] ✅ Cache HIT for ${pubkeyStr.slice(0, 8)}... (${Math.floor((now - cached.timestamp) / 1000)}s old)`, {
          dataIsNull: cached.data === null,
          dataLength: cached.data?.data.length,
          lamports: cached.data?.lamports
        });
        results[i] = cached.data;
      } else {
        // Cache miss - need to fetch
        console.log(`[ACCOUNT-CACHE] ❌ Cache MISS for ${pubkeyStr.slice(0, 8)}...`);
        accountsToFetch.push({ index: i, pubkey: new PublicKey(pubkeyStr) });
        results[i] = null; // Placeholder
      }
    }

    // Fetch missing accounts from RPC (batched)
    if (accountsToFetch.length > 0) {
      console.log(`[ACCOUNT-CACHE] Fetching ${accountsToFetch.length} accounts from RPC...`);
      const startFetch = Date.now();

      const pubkeys = accountsToFetch.map(a => a.pubkey);
      const fetchedAccounts = await connection.getMultipleAccountsInfo(pubkeys, 'processed');

      console.log(`[ACCOUNT-CACHE] RPC fetch took ${Date.now() - startFetch}ms`);

      // Update cache and results
      for (let i = 0; i < accountsToFetch.length; i++) {
        const { index, pubkey } = accountsToFetch[i];
        const accountInfo = fetchedAccounts[i];

        console.log(`[ACCOUNT-CACHE] 📥 Fetched account ${pubkey.toBase58().slice(0, 8)}:`, {
          exists: accountInfo !== null,
          dataLength: accountInfo?.data.length,
          lamports: accountInfo?.lamports,
          owner: accountInfo?.owner.toBase58()
        });

        // Cache it
        accountCache.set(pubkey.toBase58(), {
          data: accountInfo,
          timestamp: now
        });

        // Add to results
        results[index] = accountInfo;
      }
    }

    // Calculate cache stats
    const cacheHits = accounts.length - accountsToFetch.length;
    const cacheHitRate = Math.round((cacheHits / accounts.length) * 100);

    console.log(`[ACCOUNT-CACHE] ✅ Returned ${accounts.length} accounts (${cacheHits} cached, ${accountsToFetch.length} fetched, ${cacheHitRate}% hit rate)`);

    const serializedAccounts = results.map((acc, idx) => {
      if (!acc) {
        console.log(`[ACCOUNT-CACHE] 📤 Returning account[${idx}]: null (account does not exist)`);
        return null;
      }

      console.log(`[ACCOUNT-CACHE] 📤 Returning account[${idx}]:`, {
        dataLength: acc.data.length,
        lamports: acc.lamports,
        owner: acc.owner.toBase58(),
        serializedDataLength: Array.from(acc.data).length
      });

      return {
        data: Array.from(acc.data),
        executable: acc.executable,
        lamports: acc.lamports,
        owner: acc.owner.toBase58(),
        rentEpoch: acc.rentEpoch
      };
    });

    return NextResponse.json({
      accounts: serializedAccounts,
      cached: cacheHits,
      fetched: accountsToFetch.length,
      cacheHitRate
    });

  } catch (error) {
    console.error('[ACCOUNT-CACHE] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch accounts' },
      { status: 500 }
    );
  }
}

// Optional: Warm cache endpoint
export async function GET(request: NextRequest) {
  try {
    console.log('[ACCOUNT-CACHE] Cache stats requested');

    return NextResponse.json({
      cacheSize: accountCache.size,
      accounts: Array.from(accountCache.keys()).map(k => ({
        key: k.slice(0, 12) + '...',
        age: Math.floor((Date.now() - accountCache.get(k)!.timestamp) / 1000)
      }))
    });
  } catch (error) {
    console.error('[ACCOUNT-CACHE] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get cache stats' },
      { status: 500 }
    );
  }
}
