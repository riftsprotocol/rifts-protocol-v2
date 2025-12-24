import { NextResponse } from 'next/server';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://nitmreqtsnzjylyzwsri.supabase.co';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Fetch all rows with pagination (Supabase limits to 1000 per request)
async function supabaseFetchAll(endpoint: string): Promise<any[]> {
  const allRows: any[] = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `${SUPABASE_URL}/rest/v1/${endpoint}${separator}limit=${pageSize}&offset=${offset}`;

    const response = await fetch(url, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      cache: 'no-store',
    });

    if (!response.ok) break;

    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) break;

    allRows.push(...rows);
    if (rows.length < pageSize) break;

    offset += pageSize;
  }

  return allRows;
}

/**
 * Public API endpoint to get arb bot revenue per rift
 * Returns a simple map of rift_id -> total_profit_sol
 * Uses arb_bot_trades as source of truth (matches stats API)
 */
export async function GET() {
  try {
    // Fetch ALL trades with pagination (source of truth)
    const trades = await supabaseFetchAll('arb_bot_trades?select=rift_id,actual_profit_sol,success');

    // Build revenue map: rift_id -> total profit in SOL from successful trades
    const revenue: Record<string, number> = {};
    for (const trade of trades) {
      if (trade.success) {
        const riftId = trade.rift_id;
        const profit = parseFloat(trade.actual_profit_sol) || 0;
        revenue[riftId] = (revenue[riftId] || 0) + profit;
      }
    }

    return NextResponse.json({ revenue });
  } catch (error) {
    console.error('ARB-REVENUE error:', error);
    return NextResponse.json({ revenue: {} });
  }
}
