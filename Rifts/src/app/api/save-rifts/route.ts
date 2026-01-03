// Server-side API to save rifts to Supabase
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
      console.log('[SAVE-RIFTS-API] Unauthorized access attempt');
      return NextResponse.json(
        { error: 'Unauthorized. Admin wallet or valid cron secret required.' },
        { status: 403 }
      );
    }

    console.log(`[SAVE-RIFTS-API] Authenticated via: ${method}`);

    const body = await request.json();
    const { rifts } = body;

    if (!rifts || !Array.isArray(rifts)) {
      return NextResponse.json(
        { error: 'Invalid request: rifts array required' },
        { status: 400 }
      );
    }

    // Save rifts to Supabase using service role (bypasses RLS)
    const { data, error } = await getSupabaseAdmin()
      .from('rifts')
      .upsert(rifts, { onConflict: 'id' });

    if (error) {
      console.error('[SAVE-RIFTS-API] Supabase error:', error);
      return NextResponse.json(
        { error: 'Failed to save rifts', details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      count: rifts.length
    });

  } catch (error) {
    console.error('[SAVE-RIFTS-API] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
