import { NextRequest, NextResponse } from 'next/server';

// SECURITY: Require environment variables, no hardcoded fallback
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export async function GET(request: NextRequest) {
  try {
    // Get query parameters from the request
    const searchParams = request.nextUrl.searchParams;
    const queryString = searchParams.toString();
    
    // Construct the Supabase URL
    const supabaseUrl = `${SUPABASE_URL}/rest/v1/rifts?${queryString}`;
    
    console.log('[RIFTS-PROXY] Proxying request to:', supabaseUrl);
    
    // Forward the request to Supabase
    const response = await fetch(supabaseUrl, {
      method: 'GET',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      console.error('[RIFTS-PROXY] Supabase error:', response.status, response.statusText);
      const errorText = await response.text();
      console.error('[RIFTS-PROXY] Error response:', errorText);
      return NextResponse.json(
        { error: 'Failed to fetch rifts data', details: errorText },
        { status: response.status }
      );
    }
    
    const data = await response.json();
    console.log('[RIFTS-PROXY] Success, returning', Array.isArray(data) ? data.length : 'N/A', 'items');
    
    // Return the data with CORS headers
    return NextResponse.json(data, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  } catch (error) {
    console.error('[RIFTS-PROXY] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
