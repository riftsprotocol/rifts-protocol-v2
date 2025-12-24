// Server-side blockhash cache - refreshes every 60s
// Eliminates the 10-second client-side RPC call!
import { NextRequest, NextResponse } from 'next/server';
import { getServerConnection } from '@/lib/solana/server-connection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// In-memory cache
let cachedBlockhash: string | null = null;
let cachedTimestamp: number = 0;
const CACHE_TTL = 60000; // 60 seconds (blockhashes valid for ~150s)

export async function GET(request: NextRequest) {
  try {
    const now = Date.now();

    // Return cached blockhash if still valid
    if (cachedBlockhash && (now - cachedTimestamp) < CACHE_TTL) {
      const age = Math.floor((now - cachedTimestamp) / 1000);
      console.log(`[BLOCKHASH-API] ⚡ Returning cached blockhash (${age}s old)`);

      return NextResponse.json({
        blockhash: cachedBlockhash,
        cached: true,
        age: age,
        expiresIn: Math.floor((CACHE_TTL - (now - cachedTimestamp)) / 1000)
      });
    }

    // Use shared server connection singleton (async)
    const connection = await getServerConnection();

    // Fetch fresh blockhash
    console.log('[BLOCKHASH-API] 🔄 Fetching fresh blockhash from RPC...');
    const start = Date.now();
    const { blockhash } = await connection.getLatestBlockhash('processed');
    const fetchTime = Date.now() - start;

    // Cache it
    cachedBlockhash = blockhash;
    cachedTimestamp = now;

    console.log(`[BLOCKHASH-API] ✅ Fetched fresh blockhash in ${fetchTime}ms`);

    return NextResponse.json({
      blockhash,
      cached: false,
      age: 0, // Fresh fetch, so age is 0
      fetchTime,
      expiresIn: Math.floor(CACHE_TTL / 1000)
    });

  } catch (error) {
    console.error('[BLOCKHASH-API] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch blockhash' },
      { status: 500 }
    );
  }
}
