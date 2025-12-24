import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/price-history?token_pair=RIFTS/SOL&hours=24
 * Fetch price history for a token pair
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const tokenPair = searchParams.get('token_pair');
    const hours = parseInt(searchParams.get('hours') || '24');

    if (!tokenPair) {
      return NextResponse.json(
        { error: 'token_pair parameter required' },
        { status: 400 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Calculate cutoff time
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    // Fetch price history from Supabase
    const { data, error } = await supabase
      .from('price_history')
      .select('*')
      .eq('token_pair', tokenPair)
      .gte('timestamp', cutoffTime)
      .order('timestamp', { ascending: true });

    if (error) {
      console.error('[PRICE-HISTORY-API] Supabase error:', error);
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    console.log(`[PRICE-HISTORY-API] Fetched ${data?.length || 0} price points for ${tokenPair} (last ${hours}h)`);

    return NextResponse.json({
      token_pair: tokenPair,
      hours,
      data: data || [],
      count: data?.length || 0
    });

  } catch (error: any) {
    console.error('[PRICE-HISTORY-API] Error:', error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}

/**
 * POST /api/price-history
 * Save a new price point
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token_pair, price, volume_24h } = body;

    if (!token_pair || price === undefined) {
      return NextResponse.json(
        { error: 'token_pair and price are required' },
        { status: 400 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Insert price point
    const { data, error } = await supabase
      .from('price_history')
      .insert({
        token_pair,
        price,
        volume_24h: volume_24h || 0,
        timestamp: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('[PRICE-HISTORY-API] Insert error:', error);
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    console.log(`[PRICE-HISTORY-API] Saved price point for ${token_pair}: $${price}`);

    return NextResponse.json({
      success: true,
      data
    });

  } catch (error: any) {
    console.error('[PRICE-HISTORY-API] Error:', error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
