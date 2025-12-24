import { NextRequest, NextResponse } from 'next/server';
import { getServerClient } from '@/lib/supabase/server-client';

// POST /api/update-tvl
// Update TVL for a rift (requires service role to bypass RLS)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { riftId, tvlDelta, tokenPrice, tokenAmount } = body;

    if (!riftId) {
      return NextResponse.json(
        { error: 'Missing riftId' },
        { status: 400 }
      );
    }

    if (tvlDelta === undefined || tokenPrice === undefined || tokenAmount === undefined) {
      return NextResponse.json(
        { error: 'Missing tvlDelta, tokenPrice, or tokenAmount' },
        { status: 400 }
      );
    }

    console.log('[UPDATE-TVL API] Request:', { riftId, tvlDelta, tokenPrice, tokenAmount });

    // Get server client with service role (bypasses RLS)
    const supabase = getServerClient();

    // Get current rift data
    const { data: currentRift, error: fetchError } = await supabase
      .from('rifts')
      .select('raw_data, vault_balance, total_tokens_wrapped')
      .eq('id', riftId)
      .single();

    if (fetchError) {
      console.error('[UPDATE-TVL API] Fetch error:', fetchError);
      return NextResponse.json(
        { error: 'Failed to fetch rift data', details: fetchError.message },
        { status: 500 }
      );
    }

    if (!currentRift) {
      return NextResponse.json(
        { error: 'Rift not found' },
        { status: 404 }
      );
    }

    // Calculate new TVL (ensure it doesn't go negative)
    const currentTVL = currentRift.raw_data?.tvl || 0;
    const newTVL = Math.max(0, currentTVL + tvlDelta); // Prevent negative TVL

    console.log('[UPDATE-TVL API] TVL calculation:', {
      currentTVL,
      tvlDelta,
      newTVL,
      tokenAmount,
      tokenPrice,
      operation: tvlDelta >= 0 ? 'wrap' : 'unwrap'
    });

    // Update raw_data with new TVL
    const updatedRawData = {
      ...currentRift.raw_data,
      tvl: newTVL
    };

    // Update rift in database
    const { data: updateResult, error: updateError } = await supabase
      .from('rifts')
      .update({
        vault_balance: newTVL.toString(),
        total_tokens_wrapped: newTVL.toString(),
        raw_data: updatedRawData,
        updated_at: new Date().toISOString()
      })
      .eq('id', riftId)
      .select('id, vault_balance, total_tokens_wrapped, raw_data');

    if (updateError) {
      console.error('[UPDATE-TVL API] Update error:', updateError);
      return NextResponse.json(
        { error: 'Failed to update TVL', details: updateError.message },
        { status: 500 }
      );
    }

    console.log('[UPDATE-TVL API] ✅ TVL updated successfully:', {
      riftId,
      oldTVL: currentTVL,
      newTVL,
      result: updateResult
    });

    return NextResponse.json({
      success: true,
      newTvl: newTVL,
      oldTvl: currentTVL,
      delta: tvlDelta,
      updatedRift: updateResult?.[0]
    });

  } catch (error) {
    console.error('[UPDATE-TVL API] Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
