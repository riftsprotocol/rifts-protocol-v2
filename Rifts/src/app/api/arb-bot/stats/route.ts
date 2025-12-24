import { NextRequest, NextResponse } from 'next/server';

// Supabase configuration
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://nitmreqtsnzjylyzwsri.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Supabase fetch helper
async function supabaseFetch(endpoint: string) {
  const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
  const response = await fetch(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store', // Disable caching to ensure fresh data
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase error: ${text}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

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
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Supabase error: ${text}`);
    }

    const text = await response.text();
    const rows = text ? JSON.parse(text) : [];

    if (!Array.isArray(rows) || rows.length === 0) {
      break;
    }

    allRows.push(...rows);

    // If we got less than pageSize, we've reached the end
    if (rows.length < pageSize) {
      break;
    }

    offset += pageSize;
  }

  return allRows;
}

// GET - Fetch aggregated stats and trade history
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const riftId = searchParams.get('riftId');
    const limit = parseInt(searchParams.get('limit') || '50');

    console.log('[ARB-BOT-STATS] Fetching stats', { riftId, limit });

    // Fetch aggregate stats (sum across all sessions)
    let statsQuery = 'arb_bot_stats?select=*';
    if (riftId) {
      statsQuery += `&rift_id=eq.${riftId}`;
    }

    // Fetch ALL trades for stats aggregation using pagination (Supabase limits to 1000 per request)
    let allTradesQuery = `arb_bot_trades?select=rift_id,r_symbol,actual_profit_sol,trade_size_sol,success,created_at`;
    if (riftId) {
      allTradesQuery += `&rift_id=eq.${riftId}`;
    }

    // Fetch recent trades for display (limited)
    let tradesQuery = `arb_bot_trades?select=*&order=created_at.desc&limit=${limit}`;
    if (riftId) {
      tradesQuery += `&rift_id=eq.${riftId}`;
    }

    // Fetch active sessions
    let sessionsQuery = 'arb_bot_sessions?select=*&status=eq.running';

    // Fetch bot configs (where actual profits are stored)
    let configsQuery = 'arb_bot_configs?select=rift_id,r_symbol,stats';
    if (riftId) {
      configsQuery += `&rift_id=eq.${riftId}`;
    }

    // Fetch all trades with pagination (can be 7000+ rows), other queries in parallel
    const [allTradesData, statsResult, recentTradesResult, sessionsResult, configsResult] = await Promise.all([
      supabaseFetchAll(allTradesQuery),
      supabaseFetch(statsQuery).catch(() => []),
      supabaseFetch(tradesQuery).catch(() => []),
      supabaseFetch(sessionsQuery).catch(() => []),
      supabaseFetch(configsQuery).catch(() => []),
    ]);

    console.log('[ARB-BOT-STATS] Fetched data', {
      allTradesCount: allTradesData.length,
      statsCount: Array.isArray(statsResult) ? statsResult.length : 0,
      sessionsCount: Array.isArray(sessionsResult) ? sessionsResult.length : 0,
    });

    // Process stats - aggregate across all sessions
    const stats = statsResult || [];
    const trades = allTradesData;
    const recentTrades = recentTradesResult || [];
    const sessions = sessionsResult || [];
    const configs = configsResult || [];

    // Calculate cumulative stats across all rifts/sessions
    const cumulative = {
      totalTrades: 0,
      successfulTrades: 0,
      failedTrades: 0,
      totalProfitSol: 0,
      totalVolumeSol: 0,
      opportunitiesDetected: 0,
      poolUpdates: 0,
      avgTradeSizeSol: 0,
      avgProfitPerTradeSol: 0,
      winRate: 0,
      activeSessions: sessions.length,
    };

    // Per-rift stats
    const riftStats: Record<string, {
      riftId: string;
      rSymbol: string;
      totalTrades: number;
      successfulTrades: number;
      failedTrades: number;
      totalProfitSol: number;
      totalVolumeSol: number;
      winRate: number;
      lastUpdated: string;
    }> = {};

    // Primary: Aggregate stats from arb_bot_trades table (source of truth)
    for (const trade of trades) {
      const riftId = trade.rift_id;
      const rSymbol = trade.r_symbol;
      const success = trade.success;
      const profitSol = parseFloat(trade.actual_profit_sol) || 0;
      const volumeSol = parseFloat(trade.trade_size_sol) || 0;

      cumulative.totalTrades++;
      if (success) {
        cumulative.successfulTrades++;
        cumulative.totalProfitSol += profitSol;
      } else {
        cumulative.failedTrades++;
      }
      cumulative.totalVolumeSol += volumeSol;

      // Aggregate per-rift
      if (!riftStats[riftId]) {
        riftStats[riftId] = {
          riftId: riftId,
          rSymbol: rSymbol,
          totalTrades: 0,
          successfulTrades: 0,
          failedTrades: 0,
          totalProfitSol: 0,
          totalVolumeSol: 0,
          winRate: 0,
          lastUpdated: trade.created_at || new Date().toISOString(),
        };
      }
      riftStats[riftId].totalTrades++;
      if (success) {
        riftStats[riftId].successfulTrades++;
        riftStats[riftId].totalProfitSol += profitSol;
      } else {
        riftStats[riftId].failedTrades++;
      }
      riftStats[riftId].totalVolumeSol += volumeSol;
      if (trade.created_at > riftStats[riftId].lastUpdated) {
        riftStats[riftId].lastUpdated = trade.created_at;
      }
    }

    // Only aggregate opportunitiesDetected and poolUpdates from arb_bot_stats
    // (these are tracking metrics, not profit - profit comes from arb_bot_trades only)
    for (const stat of stats) {
      cumulative.opportunitiesDetected += stat.opportunities_detected || 0;
      cumulative.poolUpdates += stat.pool_updates || 0;
      // NOTE: We intentionally do NOT add profit from arb_bot_stats
      // arb_bot_trades is the source of truth for all profit calculations
    }

    // Calculate derived metrics
    cumulative.winRate = cumulative.totalTrades > 0
      ? (cumulative.successfulTrades / cumulative.totalTrades) * 100
      : 0;
    cumulative.avgTradeSizeSol = cumulative.totalTrades > 0
      ? cumulative.totalVolumeSol / cumulative.totalTrades
      : 0;
    cumulative.avgProfitPerTradeSol = cumulative.successfulTrades > 0
      ? cumulative.totalProfitSol / cumulative.successfulTrades
      : 0;

    // Calculate per-rift win rates
    for (const riftId in riftStats) {
      const rs = riftStats[riftId];
      rs.winRate = rs.totalTrades > 0
        ? (rs.successfulTrades / rs.totalTrades) * 100
        : 0;
    }

    // Format recent trades for response (with full details)
    const formattedTrades = recentTrades.map((t: any) => ({
      id: t.id,
      riftId: t.rift_id,
      rSymbol: t.r_symbol,
      direction: t.direction,
      underlyingDex: t.underlying_dex,
      tradeSizeSol: parseFloat(t.trade_size_sol),
      expectedProfitSol: parseFloat(t.expected_profit_sol),
      actualProfitSol: parseFloat(t.actual_profit_sol),
      expectedProfitBps: t.expected_profit_bps,
      spreadBps: t.spread_bps,
      success: t.success,
      signature: t.signature,
      errorMessage: t.error_message,
      executionTimeMs: t.execution_time_ms,
      createdAt: t.created_at,
    }));

    // Get uptime from active sessions
    let totalUptimeSeconds = 0;
    let longestUptimeSeconds = 0;
    const now = Date.now();
    for (const session of sessions) {
      const startedAt = new Date(session.started_at).getTime();
      const sessionUptime = Math.floor((now - startedAt) / 1000);
      totalUptimeSeconds += sessionUptime;
      if (sessionUptime > longestUptimeSeconds) {
        longestUptimeSeconds = sessionUptime;
      }
    }
    // Average uptime per bot (more meaningful than combined total)
    const avgUptimeSeconds = sessions.length > 0 ? Math.floor(totalUptimeSeconds / sessions.length) : 0;

    return NextResponse.json({
      cumulative: {
        ...cumulative,
        totalUptimeSeconds: longestUptimeSeconds, // Show longest-running bot's uptime
        avgUptimeSeconds,
        combinedUptimeSeconds: totalUptimeSeconds, // Keep combined if needed
      },
      riftStats: Object.values(riftStats),
      recentTrades: formattedTrades,
      activeSessions: sessions.map((s: any) => ({
        sessionId: s.session_id,
        walletAddress: s.wallet_address,
        status: s.status,
        startedAt: s.started_at,
        lastHeartbeat: s.last_heartbeat_at,
        riftsMonitored: s.rifts_monitored,
      })),
    });

  } catch (error) {
    console.error('[ARB-BOT-STATS] Error:', error);

    // Return empty stats if tables don't exist yet
    return NextResponse.json({
      cumulative: {
        totalTrades: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalProfitSol: 0,
        totalVolumeSol: 0,
        opportunitiesDetected: 0,
        poolUpdates: 0,
        avgTradeSizeSol: 0,
        avgProfitPerTradeSol: 0,
        winRate: 0,
        activeSessions: 0,
        totalUptimeSeconds: 0,
        avgUptimeSeconds: 0,
        combinedUptimeSeconds: 0,
      },
      riftStats: [],
      recentTrades: [],
      activeSessions: [],
      error: 'Stats tables not yet created - run migration',
    });
  }
}
