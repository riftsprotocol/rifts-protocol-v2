// Server-side API to update a rift's pool address in Supabase
import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Lazy-initialize Supabase client to avoid build-time errors
let supabaseAdmin: SupabaseClient | null = null;

function getSupabaseAdmin(): SupabaseClient {
  if (!supabaseAdmin) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing Supabase configuration');
    }

    supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }
  return supabaseAdmin;
}

export async function POST(request: NextRequest) {
  try {
    // SECURITY: Require authentication for write operations
    const { isAuthenticatedForAdminOp } = await import('@/lib/middleware/api-auth');

    const searchParams = request.nextUrl.searchParams;
    const wallet = searchParams.get('wallet');
    const cronSecret = request.headers.get('x-cron-secret') || searchParams.get('secret');
    const authHeader = request.headers.get('authorization');

    const { authenticated, method } = isAuthenticatedForAdminOp({
      wallet,
      authHeader,
      cronSecret,
    });

    if (!authenticated) {
      console.log('[UPDATE-RIFT-POOL] Unauthorized access attempt');
      return NextResponse.json(
        { error: 'Unauthorized. Admin wallet or valid cron secret required.' },
        { status: 403 }
      );
    }

    console.log(`[UPDATE-RIFT-POOL] Authenticated via: ${method}`);

    const body = await request.json();
    const { riftId, poolAddress, poolType, tvl } = body;

    if (!riftId || !poolAddress) {
      return NextResponse.json(
        { error: 'Invalid request: riftId and poolAddress required' },
        { status: 400 }
      );
    }

    console.log('[UPDATE-RIFT-POOL] Updating rift', riftId.slice(0, 8), 'with pool', poolAddress.slice(0, 8), 'type:', poolType || 'unknown');

    // First, fetch the existing rift to get its raw_data
    const { data: existingRift, error: fetchError } = await getSupabaseAdmin()
      .from('rifts')
      .select('raw_data')
      .eq('id', riftId)
      .single();

    if (fetchError || !existingRift) {
      console.error('[UPDATE-RIFT-POOL] Failed to fetch existing rift:', fetchError);
      return NextResponse.json(
        { error: 'Rift not found', details: fetchError?.message },
        { status: 404 }
      );
    }

    // Update raw_data with pool information
    const updatedRawData = {
      ...existingRift.raw_data,
      meteoraPools: [poolAddress],
      hasMeteoraPool: true,
      meteoraPool: poolAddress,
      liquidityPool: poolAddress,
      poolType: poolType || existingRift.raw_data?.poolType || 'dlmm', // 'dlmm' or 'dammv2'
      ...(tvl !== undefined && { tvl, riftTvl: tvl, lpTvl: tvl })
    };

    // Update the rift record (include vault_balance if tvl provided)
    const updateData: any = { raw_data: updatedRawData };
    if (tvl !== undefined) {
      updateData.vault_balance = tvl.toString();
    }

    const { error: updateError } = await getSupabaseAdmin()
      .from('rifts')
      .update(updateData)
      .eq('id', riftId);

    if (updateError) {
      console.error('[UPDATE-RIFT-POOL] Supabase error:', updateError);
      return NextResponse.json(
        { error: 'Failed to update rift pool', details: updateError.message },
        { status: 500 }
      );
    }

    console.log('[UPDATE-RIFT-POOL] ✅ Successfully updated rift pool');

    return NextResponse.json({
      success: true,
      riftId,
      poolAddress
    });

  } catch (error) {
    console.error('[UPDATE-RIFT-POOL] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
