// Force refresh rifts cache - clears Supabase and forces blockchain refetch
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    console.log('[FORCE-REFRESH] Clearing rifts cache and forcing blockchain refetch...');

    // Check if Supabase is configured
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.log('[FORCE-REFRESH] Supabase not configured');
      return NextResponse.json({
        success: true,
        message: 'Supabase not configured - no cache to clear',
        cleared: 0
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Delete all rifts from Supabase cache to force refetch
    const { error: deleteError, count } = await supabase
      .from('rifts')
      .delete()
      .neq('id', '00000000000000000000000000000000'); // Delete all rows

    if (deleteError) {
      console.error('[FORCE-REFRESH] Error clearing cache:', deleteError);
      return NextResponse.json({
        success: false,
        error: 'Failed to clear cache',
        details: deleteError.message
      }, { status: 500 });
    }

    console.log(`[FORCE-REFRESH] Successfully cleared ${count || 'all'} rifts from cache`);

    return NextResponse.json({
      success: true,
      message: 'Cache cleared successfully. Rifts will be refetched from blockchain on next load.',
      cleared: count || 0
    });
  } catch (error) {
    console.error('[FORCE-REFRESH] Error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to clear cache'
    }, { status: 500 });
  }
}
