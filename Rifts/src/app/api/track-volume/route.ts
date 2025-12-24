// Server-side API to track rift volumes in Supabase
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Note: Supabase client removed - volume tracking is currently disabled
// Re-add lazy-initialized client when enabling this feature

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { riftId, tokenAmount, usdValue, transactionType, signature } = body;

    if (!riftId || !tokenAmount || !transactionType) {
      return NextResponse.json(
        { error: 'Invalid request: riftId, tokenAmount, and transactionType required' },
        { status: 400 }
      );
    }

    // Volume tracking is disabled - table not set up in Supabase
    // This is non-critical functionality, so we just return success
    console.log('[TRACK-VOLUME-API] Volume tracking called (disabled):', {
      riftId,
      tokenAmount,
      transactionType
    });

    return NextResponse.json({
      success: true,
      note: 'Volume tracking disabled - set up rift_volumes table in Supabase to enable'
    });

  } catch (error) {
    console.error('[TRACK-VOLUME-API] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
