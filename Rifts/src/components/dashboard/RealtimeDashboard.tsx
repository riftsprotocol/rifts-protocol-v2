"use client";

import React, { Component, ErrorInfo, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Check,
  Copy,
  ExternalLink,
  Flame,
  LineChart,
  Loader2,
  Radar,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
} from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { RiftDetailModal } from "./RiftDetailModal";

// Error boundary for Safari/iOS crashes
class DashboardErrorBoundary extends Component<
  { children: React.ReactNode },
  { hasError: boolean; error?: Error }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Dashboard error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950 flex items-center justify-center p-4">
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-6 max-w-md text-center">
            <AlertCircle className="h-12 w-12 text-red-400 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-white mb-2">Dashboard Error</h2>
            <p className="text-white/70 mb-4">
              {this.state.error?.message || "Something went wrong loading the dashboard."}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

type ProtocolMetricRow = {
  timestamp: string | number;
  avg_apy?: string | number;
  total_tvl?: string | number;
  volume_24h?: string | number;
  total_fees?: string | number;
  total_rifts?: number;
  active_users?: number;
};

type RealAnalytics = {
  avgApy: number;
  totalTvl: number;
  activeTvl?: number;
  burnedRiftTvl?: number;
  totalVolume24h: number;
  totalFees: number;
  activeUsers: number;
  feesCollected?: number;
  vaultBalances?: {
    treasuryBalance: number;
    authorityBalance: number;
    currentVaultFees: number;
    totalVaultFeesFull: number;
    legacyFees: number;
    grandTotal: number;
    revenuePaid: number;
    vaults?: Array<{
      riftSymbol: string;
      feesUSD: number;
      withheldUSD: number;
      totalUSD: number;
    }>;
  };
  users?: {
    newUsers7d: number;
    activeUsers30d: number;
    retentionRate: number;
    totalUsers: number;
  };
  positionSizes?: { small: number; medium: number; large: number };
  transactions?: { dailyAvg: number; weeklyPeak: number; totalVolume: number };
  rifts?: Array<{
    id: string;
    symbol: string;
    apy: number;
    tvl: number;
    volume24h: number;
    strategy?: string;
    underlying?: string;
  }>;
};

type RiftData = {
  id: string;
  symbol: string;
  tvl: number;
  volume24h: number;
  apy: number;
  underlying?: string;
  strategy?: string;
};

type TransactionRow = {
  id?: string;
  signature?: string; // Actual tx signature for Solscan links
  type?: string;
  amount?: number;
  amount_usd?: number;
  volume?: number;
  token?: string;
  user_wallet?: string;
  timestamp?: string | number;
  status?: string;
};

type ChartPoint = { ts: number; value: number };

const formatNumber = (value: number, prefix = "", decimals = 1) => {
  if (value === undefined || value === null || Number.isNaN(value)) return "–";
  if (value >= 1_000_000_000) return `${prefix}${(value / 1_000_000_000).toFixed(decimals)}B`;
  if (value >= 1_000_000) return `${prefix}${(value / 1_000_000).toFixed(decimals)}M`;
  if (value >= 1_000) return `${prefix}${(value / 1_000).toFixed(decimals)}K`;
  return `${prefix}${value.toFixed(decimals)}`;
};

const linePath = (points: ChartPoint[], width = 320, height = 120, padding = 12) => {
  if (!points.length) return "";
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.value);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const xScale = (val: number) =>
    padding + ((val - minX) / Math.max(1, maxX - minX || 1)) * (width - padding * 2);
  const yScale = (val: number) =>
    height - padding - ((val - minY) / Math.max(1, maxY - minY || 1)) * (height - padding * 2);

  return points
    .map((p, idx) => `${idx === 0 ? "M" : "L"}${xScale(p.ts)},${yScale(p.value)}`)
    .join(" ");
};

// Helper to create filled area path with proper closure
const linePathWithFill = (points: ChartPoint[], width = 320, height = 120, padding = 12) => {
  if (points.length < 2) return { line: "", fill: "" };
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.value);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const xScale = (val: number) =>
    padding + ((val - minX) / Math.max(1, maxX - minX || 1)) * (width - padding * 2);
  const yScale = (val: number) =>
    height - padding - ((val - minY) / Math.max(1, maxY - minY || 1)) * (height - padding * 2);

  const line = points
    .map((p, idx) => `${idx === 0 ? "M" : "L"}${xScale(p.ts)},${yScale(p.value)}`)
    .join(" ");

  // Close the fill path properly using actual first and last x coordinates
  const firstX = xScale(points[0].ts);
  const lastX = xScale(points[points.length - 1].ts);
  const bottomY = height - padding;
  const fill = `${line} L ${lastX} ${bottomY} L ${firstX} ${bottomY} Z`;

  return { line, fill };
};

// Timeframe options
type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d' | '7d';
const TIMEFRAMES: { key: Timeframe; label: string; ms: number }[] = [
  { key: '5m', label: '5m', ms: 5 * 60 * 1000 },
  { key: '15m', label: '15m', ms: 15 * 60 * 1000 },
  { key: '1h', label: '1H', ms: 60 * 60 * 1000 },
  { key: '4h', label: '4H', ms: 4 * 60 * 60 * 1000 },
  { key: '1d', label: '1D', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7D', ms: 7 * 24 * 60 * 60 * 1000 },
];

const sparkline = (values: number[]) => {
  const points = values.map((value, idx) => ({ ts: idx, value }));
  return linePath(points, 120, 36, 6);
};

const nearestPointByX = (
  clientX: number,
  rect: DOMRect,
  series: ChartPoint[],
  viewBoxWidth = 640,
  padding = 24
) => {
  if (!series.length) return null;

  // Calculate the actual timestamp range like linePath does
  const timestamps = series.map(p => p.ts);
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const tsRange = maxTs - minTs || 1;

  // Calculate mouse position as ratio (accounting for padding like linePath uses)
  const chartWidth = rect.width;
  const paddingPx = (padding / viewBoxWidth) * chartWidth; // Scale padding to actual width
  const effectiveWidth = chartWidth - paddingPx * 2;
  const mouseX = clientX - rect.left - paddingPx;
  const xRatio = Math.min(1, Math.max(0, mouseX / effectiveWidth));

  // Convert ratio back to timestamp
  const targetTs = minTs + xRatio * tsRange;

  // Find the nearest point by timestamp
  let nearestIdx = 0;
  let nearestDist = Math.abs(series[0].ts - targetTs);
  for (let i = 1; i < series.length; i++) {
    const dist = Math.abs(series[i].ts - targetTs);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestIdx = i;
    }
  }

  return series[nearestIdx];
};

const TrendPill = ({ value }: { value: number }) => {
  if (Number.isNaN(value)) return null;
  const positive = value >= 0;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
        positive ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30" : "bg-rose-500/10 text-rose-300 border border-rose-500/30"
      }`}
    >
      {positive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
      {Math.abs(value).toFixed(1)}%
    </span>
  );
};

// Wallet actions component (copy + Solscan link)
const WalletActions = ({ wallet, showFull = false }: { wallet: string; showFull?: boolean }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const openSolscan = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(`https://solscan.io/account/${wallet}`, "_blank");
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-medium">
        {showFull ? wallet : `${wallet.slice(0, 4)}…${wallet.slice(-4)}`}
      </span>
      <button
        onClick={handleCopy}
        className="p-0.5 rounded hover:bg-white/10 transition-colors"
        title="Copy address"
      >
        {copied ? (
          <Check className="w-3 h-3 text-emerald-400" />
        ) : (
          <Copy className="w-3 h-3 text-white/50 hover:text-white/80" />
        )}
      </button>
      <button
        onClick={openSolscan}
        className="p-0.5 rounded hover:bg-white/10 transition-colors"
        title="View on Solscan"
      >
        <ExternalLink className="w-3 h-3 text-white/50 hover:text-white/80" />
      </button>
    </span>
  );
};

// Transaction signature link (for Live Feed)
const TxActions = ({ signature }: { signature?: string }) => {
  const [copied, setCopied] = useState(false);

  if (!signature) return null;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(signature);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const openSolscan = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(`https://solscan.io/tx/${signature}`, "_blank");
  };

  return (
    <span className="inline-flex items-center gap-1">
      <button
        onClick={handleCopy}
        className="p-0.5 rounded hover:bg-white/10 transition-colors"
        title="Copy signature"
      >
        {copied ? (
          <Check className="w-3 h-3 text-emerald-400" />
        ) : (
          <Copy className="w-3 h-3 text-white/50 hover:text-white/80" />
        )}
      </button>
      <button
        onClick={openSolscan}
        className="p-0.5 rounded hover:bg-white/10 transition-colors"
        title="View tx on Solscan"
      >
        <ExternalLink className="w-3 h-3 text-white/50 hover:text-white/80" />
      </button>
    </span>
  );
};

const Card = ({
  title,
  value,
  sub,
  accent,
  icon,
  chart,
}: {
  title: string;
  value: string;
  sub?: string | React.ReactNode;
  accent?: string;
  icon?: React.ReactNode;
  chart?: React.ReactNode;
}) => (
  <div className="group relative overflow-hidden rounded-2xl border border-white/5 bg-neutral-950/70 p-4 shadow-xl backdrop-blur-lg transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-emerald-500/10">
    <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 via-cyan-500/0 to-blue-500/5 pointer-events-none" />
    {accent && <div className="absolute right-4 top-4 text-xs font-semibold text-emerald-300/80">{accent}</div>}
    <div className="relative flex items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2 text-sm text-white/60">
          {icon}
          <span>{title}</span>
        </div>
        <div className="mt-2 text-2xl font-semibold text-white">{value}</div>
        {sub && <div className="mt-1 text-sm text-white/60">{sub}</div>}
      </div>
      {chart && <div className="h-16 w-28">{chart}</div>}
    </div>
  </div>
);

export const RealtimeDashboard: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metricsHistory, setMetricsHistory] = useState<ProtocolMetricRow[]>([]);
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [analytics, setAnalytics] = useState<RealAnalytics | null>(null);
  const [hoveredPrimary, setHoveredPrimary] = useState<{ ts: number; tvl: number; vol: number } | null>(null);
  const [hoveredSparklines, setHoveredSparklines] = useState<{ tvl?: number; volume?: number; fees?: number }>({});
  const [hoveredHeatmap, setHoveredHeatmap] = useState<{ day: number; hour: number; count: number } | null>(null);
  const [hoveredUsers, setHoveredUsers] = useState<number | null>(null);
  const [liveTotals, setLiveTotals] = useState<{ tvl: number; volume24h: number } | null>(null);
  const [riftsData, setRiftsData] = useState<RiftData[]>([]);
  const [chartTimeframe, setChartTimeframe] = useState<Timeframe>('1d');
  const [chartMetric, setChartMetric] = useState<'tvl' | 'volume' | 'fees' | 'apy'>('tvl');
  const [selectedRift, setSelectedRift] = useState<RiftData | null>(null);
  const [riftModalOpen, setRiftModalOpen] = useState(false);
  const [solPrice, setSolPrice] = useState<number>(0);

  const latestMetrics = useMemo(() => {
    if (metricsHistory.length === 0) return null;
    const latest = metricsHistory[metricsHistory.length - 1];
    return {
      tvl: Number(latest.total_tvl || 0),
      volume24h: Number(latest.volume_24h || 0),
      fees: Number(latest.total_fees || 0),
      apy: Number(latest.avg_apy || 0),
      rifts: latest.total_rifts || 0,
      activeUsers: latest.active_users || 0,
      timestamp: latest.timestamp,
    };
  }, [metricsHistory]);

  const loadData = async () => {
    setRefreshing(true);
    setError(null);
    try {
      // OPTIMIZED: Removed duplicate get-protocol-metrics call
      // (metricsHistory from Supabase already contains all data needed)
      const [analyticsRes, metricsHistoryRes, txRes, riftsCacheRes, solPriceRes] = await Promise.allSettled([
        fetch("/api/get-real-analytics").then((r) => (r.ok ? r.json() : null)),
        supabase
          .from("protocol_metrics")
          .select("*")
          .order("timestamp", { ascending: false })
          .limit(2000),
        supabase
          .from("transactions")
          .select("*")
          .order("timestamp", { ascending: false })
          .limit(250),
        fetch("/api/rifts-read").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/sol-price")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);

      if (analyticsRes.status === "fulfilled" && analyticsRes.value) {
        setAnalytics(analyticsRes.value);
      }

      if (metricsHistoryRes.status === "fulfilled" && !metricsHistoryRes.value.error) {
        setMetricsHistory(metricsHistoryRes.value.data || []);
      }

      if (txRes.status === "fulfilled" && !txRes.value.error) {
        setTransactions(txRes.value.data || []);
      }

      // Live totals from rifts cache (PRIMARY source for TVL/volume - same as main page)
      if (riftsCacheRes.status === "fulfilled" && riftsCacheRes.value) {
        const data = riftsCacheRes.value;
        // rifts-cache returns { success: true, rifts: [...] }
        const rifts = data.success && data.rifts ? data.rifts : (Array.isArray(data) ? data : []);

        console.log('[DASHBOARD] rifts-cache response:', { success: data.success, riftsCount: rifts.length });

        if (rifts.length > 0) {
          const liveTvl = rifts.reduce((sum: number, r: any) => sum + (Number(r.tvl) || 0), 0);
          const liveVol = rifts.reduce((sum: number, r: any) => sum + (Number(r.volume24h) || 0), 0);

          console.log('[DASHBOARD] Live TVL from rifts-cache:', liveTvl, 'Volume:', liveVol);
          console.log('[DASHBOARD] First rift TVL:', rifts[0]?.tvl, 'Symbol:', rifts[0]?.symbol);

          setLiveTotals({ tvl: liveTvl, volume24h: liveVol });

          // Store rifts data for display
          const parsedRifts: RiftData[] = rifts.map((r: any) => ({
            id: r.id,
            symbol: r.symbol || r.token_symbol || 'Unknown',
            tvl: Number(r.tvl) || 0,
            volume24h: Number(r.volume24h) || 0,
            apy: Number(r.apy) || 0,
            underlying: r.underlying,
          }));
          setRiftsData(parsedRifts);
        } else {
          console.warn('[DASHBOARD] rifts-cache returned empty rifts array');
        }
      } else {
        console.warn('[DASHBOARD] rifts-cache fetch failed or returned null:', riftsCacheRes);
      }

      // Set SOL price
      if (solPriceRes.status === "fulfilled" && solPriceRes.value?.price) {
        setSolPrice(solPriceRes.value.price);
      }
    } catch (err: any) {
      setError(err?.message || "Failed to load metrics");
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30_000);

    // Try to set up realtime subscription (may fail on Safari/iOS due to WebSocket security)
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      channel = supabase
        .channel("dashboard-live")
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "protocol_metrics" },
          (payload) => {
            setMetricsHistory((prev) => [...prev, payload.new as ProtocolMetricRow].slice(-150));
          }
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "transactions" },
          (payload) => {
            setTransactions((prev) => [payload.new as TransactionRow, ...prev].slice(0, 250));
          }
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "rifts" },
          () => {
            loadData();
          }
        )
        .subscribe();
    } catch (e) {
      console.warn("Realtime subscription failed (Safari/iOS WebSocket issue):", e);
      // Dashboard still works via polling every 30s
    }

    return () => {
      clearInterval(interval);
      if (channel) {
        try {
          supabase.removeChannel(channel);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    };
  }, []);

  // Get timeframe duration in ms
  const timeframeDuration = useMemo(() => {
    return TIMEFRAMES.find(t => t.key === chartTimeframe)?.ms ?? 24 * 60 * 60 * 1000;
  }, [chartTimeframe]);

  // Check if we have enough data for the selected timeframe
  const hasLimitedData = useMemo(() => {
    const now = Date.now();
    const cutoffTime = now - timeframeDuration;
    const timeframePoints = metricsHistory.filter(row => {
      const ts = new Date(row.timestamp).getTime();
      return ts >= cutoffTime && Number(row.total_tvl) > 0;
    });
    return timeframePoints.length < 3;
  }, [metricsHistory, timeframeDuration]);

  const tvlSeries: ChartPoint[] = useMemo(() => {
    // Get current live TVL
    // SYNCED: rifts-cache now includes burned rift, so liveTotals.tvl is the complete total
    const totalLive = liveTotals?.tvl ?? analytics?.totalTvl ?? 0;
    const now = Date.now();
    const cutoffTime = now - timeframeDuration;

    // Get ALL historical data with valid TVL values, sorted chronologically
    // Filter out bad data (TVL < $200K means burned rift TVL fetch failed)
    const allPoints = metricsHistory
      .filter(row => Number(row.total_tvl) >= 200000)
      .map((row) => ({
        ts: new Date(row.timestamp).getTime(),
        value: Number(row.total_tvl) || 0,
      }))
      .sort((a, b) => a.ts - b.ts);

    // Find continuous recent data (no gaps > 2 hours)
    const MAX_GAP = 2 * 60 * 60 * 1000; // 2 hours
    let continuousStartIdx = allPoints.length - 1;
    for (let i = allPoints.length - 1; i > 0; i--) {
      const gap = allPoints[i].ts - allPoints[i - 1].ts;
      if (gap > MAX_GAP) break;
      continuousStartIdx = i - 1;
    }
    const continuousPoints = allPoints.slice(continuousStartIdx);

    // Filter to selected timeframe
    const timeframePoints = allPoints.filter(p => p.ts >= cutoffTime);

    // Decide which dataset to use based on timeframe:
    // - For 7D: show ALL data to see full historical trends
    // - For other timeframes: show only data within the timeframe
    let historicalPoints: ChartPoint[];
    const is7DTimeframe = timeframeDuration >= 7 * 24 * 60 * 60 * 1000; // 7d only

    if (is7DTimeframe) {
      // For 7D: show ALL available data to see full history
      historicalPoints = allPoints;
    } else if (timeframePoints.length >= 5) {
      // Short timeframe with enough data points
      historicalPoints = timeframePoints;
    } else if (continuousPoints.length >= 3) {
      // Short timeframe, use continuous recent data
      historicalPoints = continuousPoints;
    } else {
      // Fallback to all data
      historicalPoints = allPoints;
    }

    // Always append current live value as the latest point
    if (totalLive > 0) {
      historicalPoints.push({ ts: now, value: totalLive });
    }

    // If we have data, return it
    if (historicalPoints.length >= 2) {
      return historicalPoints;
    }

    // Fallback: just show current value
    return [
      { ts: cutoffTime, value: totalLive },
      { ts: now, value: totalLive }
    ];
  }, [metricsHistory, analytics, liveTotals, timeframeDuration]);

  const volumeSeries: ChartPoint[] = useMemo(() => {
    // Get current live volume
    const liveVol = liveTotals?.volume24h ?? analytics?.totalVolume24h ?? 0;
    const now = Date.now();
    const cutoffTime = now - timeframeDuration;

    // Get ALL historical data with valid volume values, sorted chronologically
    // Filter out bad data (volume < $100K means data fetch likely failed - normal is $115K+)
    const allPoints = metricsHistory
      .filter(row => Number(row.volume_24h) >= 100000)
      .map((row) => ({
        ts: new Date(row.timestamp).getTime(),
        value: Number(row.volume_24h) || 0,
      }))
      .sort((a, b) => a.ts - b.ts);

    // Find continuous recent data (no gaps > 2 hours)
    const MAX_GAP = 2 * 60 * 60 * 1000; // 2 hours
    let continuousStartIdx = allPoints.length - 1;
    for (let i = allPoints.length - 1; i > 0; i--) {
      const gap = allPoints[i].ts - allPoints[i - 1].ts;
      if (gap > MAX_GAP) break;
      continuousStartIdx = i - 1;
    }
    const continuousPoints = allPoints.slice(continuousStartIdx);

    // Filter to selected timeframe
    const timeframePoints = allPoints.filter(p => p.ts >= cutoffTime);

    // Decide which dataset to use (same logic as TVL)
    let historicalPoints: ChartPoint[];
    const is7DTimeframe = timeframeDuration >= 7 * 24 * 60 * 60 * 1000; // 7d only

    if (is7DTimeframe) {
      // For 7D: show ALL available data to see full history
      historicalPoints = allPoints;
    } else if (timeframePoints.length >= 5) {
      // Short timeframe with enough data points
      historicalPoints = timeframePoints;
    } else if (continuousPoints.length >= 3) {
      // Short timeframe, use continuous recent data
      historicalPoints = continuousPoints;
    } else {
      // Fallback to all data
      historicalPoints = allPoints;
    }

    // Always append current live value as the latest point
    if (liveVol > 0) {
      historicalPoints.push({ ts: now, value: liveVol });
    }

    // If we have data, return it
    if (historicalPoints.length >= 2) {
      return historicalPoints;
    }

    // Fallback: just show current value
    return [
      { ts: cutoffTime, value: liveVol },
      { ts: now, value: liveVol }
    ];
  }, [metricsHistory, analytics, liveTotals, timeframeDuration]);

  const feeSeries: ChartPoint[] = useMemo(() => {
    const now = Date.now();
    const cutoffTime = now - timeframeDuration;

    // Filter out bad fee records (< $2000 means vault fetch failed)
    const allPoints = metricsHistory
      .filter(row => Number(row.total_fees) >= 2000)
      .map((row) => ({
        ts: new Date(row.timestamp).getTime(),
        value: Number(row.total_fees || 0),
      }))
      .sort((a, b) => a.ts - b.ts);

    const is7DTimeframe = timeframeDuration >= 7 * 24 * 60 * 60 * 1000;
    let historicalPoints = is7DTimeframe ? allPoints : allPoints.filter(p => p.ts >= cutoffTime);

    // Add current real on-chain fees as the latest point (including buybacks)
    const currentFees = analytics?.feesCollected ?? analytics?.totalFees ?? 0;
    if (currentFees > 0) {
      historicalPoints.push({ ts: now, value: currentFees + (50 * solPrice) });
    }

    // FIX: If not enough points in timeframe, use most recent historical point for comparison
    // This ensures we show meaningful change even when data is sparse
    if (historicalPoints.length < 2) {
      // Get the most recent historical point (before current)
      const previousPoint = allPoints.length > 0 ? allPoints[allPoints.length - 1] : null;
      const previousFees = previousPoint?.value ?? currentFees;
      return [
        { ts: cutoffTime, value: previousFees },
        { ts: now, value: currentFees + (50 * solPrice) }
      ];
    }

    return historicalPoints;
  }, [metricsHistory, analytics, timeframeDuration, solPrice]);

  const apySeries: ChartPoint[] = useMemo(() => {
    const now = Date.now();
    const cutoffTime = now - timeframeDuration;

    const allPoints = metricsHistory
      .filter(row => Number(row.avg_apy) > 0)
      .map((row) => ({
        ts: new Date(row.timestamp).getTime(),
        value: Number(row.avg_apy || 0),
      }))
      .sort((a, b) => a.ts - b.ts);

    const is7DTimeframe = timeframeDuration >= 7 * 24 * 60 * 60 * 1000;
    let historicalPoints = is7DTimeframe ? allPoints : allPoints.filter(p => p.ts >= cutoffTime);

    const currentApy = analytics?.avgApy ?? latestMetrics?.apy ?? 0;
    if (currentApy > 0) {
      historicalPoints.push({ ts: now, value: currentApy });
    }

    if (historicalPoints.length < 2) {
      return [
        { ts: cutoffTime, value: currentApy },
        { ts: now, value: currentApy }
      ];
    }

    return historicalPoints;
  }, [metricsHistory, analytics, latestMetrics, timeframeDuration]);

  const usersSeries: ChartPoint[] = useMemo(() => {
    const base = metricsHistory.map((row) => ({
      ts: new Date(row.timestamp).getTime(),
      value: Number(row.active_users || 0),
    }));
    if (analytics?.users?.totalUsers) {
      base.push({ ts: Date.now(), value: analytics.users.totalUsers });
    }
    return base;
  }, [metricsHistory, analytics]);

  // SYNCED: rifts-cache now includes burned rift in the rifts array (same as main page)
  // liveTotals.tvl already includes burned rift TVL, so use it directly
  const burnedRiftTvl = analytics?.burnedRiftTvl ?? 0; // Keep for display purposes
  const totalTvlValue = liveTotals?.tvl ?? analytics?.totalTvl ?? latestMetrics?.tvl ?? 0;
  const totalVolumeValue = liveTotals?.volume24h ?? analytics?.totalVolume24h ?? latestMetrics?.volume24h ?? 0;

  // Total fees = feesCollected from analytics (includes legacy + treasury + vault fees)
  // Only use latestMetrics if it's valid (>= $2000, otherwise vault fetch failed)
  const latestMetricsFees = (latestMetrics?.fees ?? 0) >= 2000 ? latestMetrics?.fees : 0;
  const totalFeesValue = analytics?.feesCollected ?? analytics?.totalFees ?? latestMetricsFees ?? 0;
  const displayTvl = hoveredSparklines.tvl ?? totalTvlValue;
  const displayVolume = hoveredSparklines.volume ?? totalVolumeValue;
  // Never show fees < $2000 (means bad data)
  // Match the fee breakdown total: grandTotal + buybacks + revenuePaid
  const feeBreakdownTotal = (analytics?.vaultBalances?.grandTotal ?? totalFeesValue) + (50 * solPrice) + (analytics?.vaultBalances?.revenuePaid ?? 0);
  const rawDisplayFees = hoveredSparklines.fees ?? feeBreakdownTotal;
  const displayFees = rawDisplayFees >= 2000 ? rawDisplayFees : feeBreakdownTotal;

  // Get series based on selected metric
  const getSelectedSeries = () => {
    switch (chartMetric) {
      case 'tvl': return tvlSeries;
      case 'volume': return volumeSeries;
      case 'fees': return feeSeries;
      case 'apy': return apySeries;
      default: return tvlSeries;
    }
  };

  const getMetricConfig = () => {
    switch (chartMetric) {
      case 'tvl': return { label: 'TVL', color: '#34d399', fillColor: 'rgba(16,185,129,0.35)', prefix: '$' };
      case 'volume': return { label: '24h Volume', color: '#38bdf8', fillColor: 'rgba(56,189,248,0.35)', prefix: '$' };
      case 'fees': return { label: 'Total Fees', color: '#fbbf24', fillColor: 'rgba(251,191,36,0.35)', prefix: '$' };
      case 'apy': return { label: 'Avg APY', color: '#a855f7', fillColor: 'rgba(168,85,247,0.35)', prefix: '', suffix: '%' };
      default: return { label: 'TVL', color: '#34d399', fillColor: 'rgba(16,185,129,0.35)', prefix: '$' };
    }
  };

  const handlePrimaryHover = (clientX: number, rect: DOMRect) => {
    // Use same padding (8) as the chart rendering
    const series = getSelectedSeries();
    const nearPoint = nearestPointByX(clientX, rect, series, 640, 8);
    if (nearPoint) {
      setHoveredPrimary({
        ts: nearPoint.ts,
        tvl: chartMetric === 'tvl' ? nearPoint.value : 0,
        vol: nearPoint.value, // Use vol for the general value display
      });
    }
  };

  const heatmap = useMemo(() => {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    transactions.forEach((tx) => {
      const ts = new Date(tx.timestamp || 0);
      if (Number.isNaN(ts.getTime())) return;
      grid[ts.getDay()][ts.getHours()] += 1;
    });
    return grid;
  }, [transactions]);

  const topUsers = useMemo(() => {
    const totals: Record<string, number> = {};
    transactions.forEach((tx) => {
      const key = tx.user_wallet || "unknown";
      // amount is raw token amount - filter out obviously wrong values (> 1M is likely raw lamports/tokens)
      let val = Number(tx.amount ?? 0);
      // If value is absurdly high, it's probably raw tokens not USD - skip or scale down
      if (val > 1_000_000) {
        // Likely raw lamports or smallest token unit - convert assuming 9 decimals and $1 price as rough estimate
        val = val / 1_000_000_000;
      }
      // Cap at reasonable single-tx max of $100K
      if (val > 100_000) val = 0;
      totals[key] = (totals[key] || 0) + val;
    });
    return Object.entries(totals)
      .filter(([_, total]) => total > 0 && total < 10_000_000) // Filter out unreasonable totals
      .map(([user, total]) => ({ user, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);
  }, [transactions]);

  const trend = (series: ChartPoint[]) => {
    if (series.length < 2) return 0;
    const first = series[0].value || 0;
    const last = series[series.length - 1].value || 0;
    if (first === 0) return 0;
    return ((last - first) / Math.abs(first)) * 100;
  };

  const tvlTrend = trend(tvlSeries);
  const volumeTrend = trend(volumeSeries);
  const feeTrend = trend(feeSeries);

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(16,185,129,0.08),transparent_35%),radial-gradient(circle_at_80%_0%,rgba(59,130,246,0.08),transparent_30%)] pointer-events-none" />
      <div className="relative mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-emerald-300/70">RIFTS Protocol</p>
            <h1 className="mt-2 text-3xl font-semibold md:text-4xl">Analytics Center</h1>
            <p className="mt-1 text-sm text-white/60">
              Live, real-time view across TVL, fees, users, and rift performance
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/dapp"
              className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/5 px-4 py-2 text-sm font-medium text-white/80 transition hover:border-white/40 hover:bg-white/10"
            >
              ← Back to Dapp
            </a>
            <button
              onClick={loadData}
              className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:border-emerald-400/70 hover:bg-emerald-500/15"
              disabled={refreshing}
            >
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex h-[50vh] items-center justify-center">
            <div className="inline-flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading live metrics...
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <Card
                title="Total Value Locked"
                value={formatNumber(displayTvl, "$", 2)}
                sub={
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <TrendPill value={tvlTrend} />
                    </div>
                    {burnedRiftTvl > 0 && (
                      <span className="text-[11px] text-white/50">
                        incl. {formatNumber(burnedRiftTvl, "$", 1)} burned
                      </span>
                    )}
                  </div>
                }
                accent="Realtime"
                icon={<ShieldCheck className="h-4 w-4 text-emerald-300" />}
                chart={
                  <svg
                    viewBox="0 0 120 64"
                    className="h-full w-full opacity-80 transition-transform duration-200 group-hover:scale-[1.02] cursor-pointer"
                    onMouseMove={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      // Create index-based series to match sparkline rendering
                      const indexSeries = tvlSeries.map((p, idx) => ({ ts: idx, value: p.value }));
                      const near = nearestPointByX(e.clientX, rect, indexSeries, 120, 6);
                      if (near) setHoveredSparklines((prev) => ({ ...prev, tvl: near.value }));
                    }}
                    onMouseLeave={() => setHoveredSparklines((prev) => ({ ...prev, tvl: undefined }))}
                  >
                    <path
                      d={sparkline(tvlSeries.map((p) => p.value))}
                      fill="none"
                      stroke="url(#tvlGradient)"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <defs>
                      <linearGradient id="tvlGradient" x1="0" x2="1" y1="0" y2="0">
                        <stop offset="0%" stopColor="#34d399" />
                        <stop offset="100%" stopColor="#22c55e" />
                      </linearGradient>
                    </defs>
                  </svg>
                }
              />
              <Card
                title="24h Volume"
                value={formatNumber(displayVolume, "$", 2)}
                sub={
                  <div className="flex items-center gap-2">
                    <TrendPill value={volumeTrend} />
                  </div>
                }
                accent="Flow"
                icon={<Activity className="h-4 w-4 text-cyan-300" />}
                chart={
                  <svg
                    viewBox="0 0 120 64"
                    className="h-full w-full opacity-80 transition-transform duration-200 group-hover:scale-[1.02] cursor-pointer"
                    onMouseMove={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      // Create index-based series to match sparkline rendering
                      const indexSeries = volumeSeries.map((p, idx) => ({ ts: idx, value: p.value }));
                      const near = nearestPointByX(e.clientX, rect, indexSeries, 120, 6);
                      if (near) setHoveredSparklines((prev) => ({ ...prev, volume: near.value }));
                    }}
                    onMouseLeave={() => setHoveredSparklines((prev) => ({ ...prev, volume: undefined }))}
                  >
                    <path
                      d={sparkline(volumeSeries.map((p) => p.value))}
                      fill="none"
                      stroke="url(#volGradient)"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <defs>
                      <linearGradient id="volGradient" x1="0" x2="1" y1="0" y2="0">
                        <stop offset="0%" stopColor="#67e8f9" />
                        <stop offset="100%" stopColor="#22d3ee" />
                      </linearGradient>
                    </defs>
                  </svg>
                }
              />
              <Card
                title="Total Fees"
                value={formatNumber(displayFees, "$", 2)}
                sub={
                  <div className="flex items-center gap-2">
                    <TrendPill value={feeTrend} />
                  </div>
                }
                accent="Revenue"
                icon={<Flame className="h-4 w-4 text-amber-300" />}
                chart={
                  <svg
                    viewBox="0 0 120 64"
                    className="h-full w-full opacity-80 transition-transform duration-200 group-hover:scale-[1.02] cursor-pointer"
                    onMouseMove={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      // Create index-based series to match sparkline rendering
                      const indexSeries = feeSeries.map((p, idx) => ({ ts: idx, value: p.value }));
                      const near = nearestPointByX(e.clientX, rect, indexSeries, 120, 6);
                      if (near) setHoveredSparklines((prev) => ({ ...prev, fees: near.value }));
                    }}
                    onMouseLeave={() => setHoveredSparklines((prev) => ({ ...prev, fees: undefined }))}
                  >
                    <path
                      d={sparkline(feeSeries.map((p) => p.value))}
                      fill="none"
                      stroke="url(#feeGradient)"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <defs>
                      <linearGradient id="feeGradient" x1="0" x2="1" y1="0" y2="0">
                        <stop offset="0%" stopColor="#fbbf24" />
                        <stop offset="100%" stopColor="#fb923c" />
                      </linearGradient>
                    </defs>
                  </svg>
                }
              />
              <Card
                title="Avg APY"
                value={`${((analytics?.avgApy ?? latestMetrics?.apy) || 0).toFixed(2)}%`}
                sub={`Active Users: ${analytics?.users?.totalUsers ?? latestMetrics?.activeUsers ?? 0}`}
                accent="Yield"
                icon={<TrendingUp className="h-4 w-4 text-emerald-200" />}
                chart={
                  <div className="flex h-full w-full items-center justify-center">
                    <div className="relative h-12 w-12">
                      <div className="absolute inset-0 rounded-full border border-emerald-400/40" />
                      <div
                        className="absolute inset-1 rounded-full border-2 border-emerald-300/70"
                        style={{ opacity: 0.9 }}
                      />
                    </div>
                  </div>
                }
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <div className="relative lg:col-span-2 rounded-2xl border border-white/5 bg-white/5 backdrop-blur-lg p-4 shadow-xl transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-emerald-500/10">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 text-white/70 text-sm">
                    <LineChart className="h-4 w-4" style={{ color: getMetricConfig().color }} />
                    <span style={{ color: getMetricConfig().color }}>{getMetricConfig().label}</span>
                    {hasLimitedData && (
                      <span className="ml-2 text-[10px] text-amber-400/80 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">
                        Showing all data
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Metric selector */}
                    <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/30 p-0.5">
                      {[
                        { key: 'tvl' as const, label: 'TVL', color: 'emerald' },
                        { key: 'volume' as const, label: 'Vol', color: 'cyan' },
                        { key: 'fees' as const, label: 'Fees', color: 'amber' },
                        { key: 'apy' as const, label: 'APY', color: 'purple' },
                      ].map(m => (
                        <button
                          key={m.key}
                          onClick={() => setChartMetric(m.key)}
                          className={`px-2 py-1 text-xs font-medium rounded-md transition-all ${
                            chartMetric === m.key
                              ? `bg-${m.color}-500/20 text-${m.color}-300 border border-${m.color}-500/30`
                              : 'text-white/50 hover:text-white/80 hover:bg-white/5'
                          }`}
                          style={chartMetric === m.key ? {
                            backgroundColor: m.color === 'emerald' ? 'rgba(16,185,129,0.2)' :
                                           m.color === 'cyan' ? 'rgba(34,211,238,0.2)' :
                                           m.color === 'amber' ? 'rgba(251,191,36,0.2)' : 'rgba(168,85,247,0.2)',
                            color: m.color === 'emerald' ? '#6ee7b7' :
                                   m.color === 'cyan' ? '#67e8f9' :
                                   m.color === 'amber' ? '#fcd34d' : '#c4b5fd',
                            borderColor: m.color === 'emerald' ? 'rgba(16,185,129,0.3)' :
                                        m.color === 'cyan' ? 'rgba(34,211,238,0.3)' :
                                        m.color === 'amber' ? 'rgba(251,191,36,0.3)' : 'rgba(168,85,247,0.3)'
                          } : {}}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                    {/* Timeframe selector */}
                    <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/30 p-0.5">
                      {TIMEFRAMES.map(tf => (
                        <button
                          key={tf.key}
                          onClick={() => setChartTimeframe(tf.key)}
                          className={`px-2 py-1 text-xs font-medium rounded-md transition-all ${
                            chartTimeframe === tf.key
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'text-white/50 hover:text-white/80 hover:bg-white/5'
                          }`}
                        >
                          {tf.label}
                        </button>
                      ))}
                    </div>
                    <TrendPill value={trend(getSelectedSeries())} />
                  </div>
                </div>
                <div className="mt-4 h-56 w-full group" onMouseLeave={() => setHoveredPrimary(null)}>
                  <svg
                    viewBox="0 0 640 220"
                    className="h-full w-full transition-transform duration-200 group-hover:scale-[1.01] cursor-pointer"
                    onMouseMove={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      handlePrimaryHover(e.clientX, rect);
                    }}
                  >
                    <defs>
                      <linearGradient id="selectedFill" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor={getMetricConfig().fillColor} />
                        <stop offset="100%" stopColor={getMetricConfig().fillColor.replace('0.35', '0.05')} />
                      </linearGradient>
                    </defs>
                    {/* Selected metric chart */}
                    {getSelectedSeries().length > 1 && (() => {
                      const paths = linePathWithFill(getSelectedSeries(), 640, 200, 8);
                      return (
                        <>
                          <path
                            d={paths.fill}
                            fill="url(#selectedFill)"
                            stroke="none"
                            transform="translate(0,10)"
                          />
                          <path
                            d={paths.line}
                            fill="none"
                            stroke={getMetricConfig().color}
                            strokeWidth="3"
                            strokeLinecap="round"
                            transform="translate(0,10)"
                          />
                        </>
                      );
                    })()}
                  </svg>
                  {hoveredPrimary && (
                    <div className="pointer-events-none absolute right-4 top-4 rounded-xl border border-white/10 bg-black/70 px-3 py-2 text-xs text-white shadow-lg">
                      <div className="flex items-center justify-between gap-6">
                        <span className="text-white/60">{new Date(hoveredPrimary.ts).toLocaleString()}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-4">
                        <span className="text-white/70">{getMetricConfig().label}</span>
                        <span className="font-semibold" style={{ color: getMetricConfig().color }}>
                          {chartMetric === 'apy'
                            ? `${hoveredPrimary.vol.toFixed(2)}%`
                            : formatNumber(hoveredPrimary.vol, "$", 2)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
                <div className="mt-4 grid grid-cols-4 gap-2 text-sm text-white/70">
                  <div
                    className={`rounded-xl border px-3 py-2 transition-colors duration-150 cursor-pointer ${
                      chartMetric === 'tvl' ? 'border-emerald-400/40 bg-emerald-500/10' : 'border-white/5 bg-white/5 hover:border-emerald-400/30'
                    }`}
                    onClick={() => setChartMetric('tvl')}
                  >
                    <div className="text-xs text-white/50">TVL</div>
                    <div className="text-lg font-semibold">{formatNumber(totalTvlValue, "$", 2)}</div>
                  </div>
                  <div
                    className={`rounded-xl border px-3 py-2 transition-colors duration-150 cursor-pointer ${
                      chartMetric === 'volume' ? 'border-cyan-400/40 bg-cyan-500/10' : 'border-white/5 bg-white/5 hover:border-cyan-400/30'
                    }`}
                    onClick={() => setChartMetric('volume')}
                  >
                    <div className="text-xs text-white/50">24h Vol</div>
                    <div className="text-lg font-semibold">{formatNumber(totalVolumeValue, "$", 2)}</div>
                  </div>
                  <div
                    className={`rounded-xl border px-3 py-2 transition-colors duration-150 cursor-pointer ${
                      chartMetric === 'fees' ? 'border-amber-400/40 bg-amber-500/10' : 'border-white/5 bg-white/5 hover:border-amber-400/30'
                    }`}
                    onClick={() => setChartMetric('fees')}
                  >
                    <div className="text-xs text-white/50">Fees</div>
                    <div className="text-lg font-semibold">{formatNumber(feeBreakdownTotal, "$", 2)}</div>
                  </div>
                  <div
                    className={`rounded-xl border px-3 py-2 transition-colors duration-150 cursor-pointer ${
                      chartMetric === 'apy' ? 'border-purple-400/40 bg-purple-500/10' : 'border-white/5 bg-white/5 hover:border-purple-400/30'
                    }`}
                    onClick={() => setChartMetric('apy')}
                  >
                    <div className="text-xs text-white/50">Avg APY</div>
                    <div className="text-lg font-semibold">{((analytics?.avgApy ?? latestMetrics?.apy) || 0).toFixed(2)}%</div>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-white/5 bg-white/5 backdrop-blur-lg p-4 shadow-xl space-y-4 transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-emerald-500/10">
                <div className="flex items-center gap-2 text-sm text-white/70">
                  <BarChart3 className="h-4 w-4 text-amber-300" />
                  Fee Breakdown
                </div>
                <div className="space-y-3">
                  {/* Main fee categories */}
                  {[
                    { label: "Legacy Fees", value: analytics?.vaultBalances?.legacyFees ?? 2363.32 },
                    { label: "Treasury Wallet", value: analytics?.vaultBalances?.treasuryBalance ?? 0 },
                    { label: "Arbitrage Revenue", value: analytics?.vaultBalances?.authorityBalance ?? 0 },
                    { label: "Buybacks", value: 80 * solPrice },
                    { label: "Revenue Paid", value: analytics?.vaultBalances?.revenuePaid ?? 0 },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="flex items-center justify-between rounded-xl border border-white/5 bg-gradient-to-r px-3 py-2 text-sm text-white/70 backdrop-blur-lg shadow-sm hover:border-white/10"
                      title={`${item.label}: ${formatNumber(item.value, "$", 2)}`}
                    >
                      <span>{item.label}</span>
                      <span className="font-semibold text-white">{formatNumber(item.value, "$", 2)}</span>
                    </div>
                  ))}
                  {/* Wrap Fee Vaults - full amount */}
                  <div
                    className="flex items-center justify-between rounded-xl border border-white/5 bg-gradient-to-r px-3 py-2 text-sm text-white/70 backdrop-blur-lg shadow-sm hover:border-white/10"
                    title={`Wrap Fee Vaults (total across all rifts)`}
                  >
                    <span>Wrap Fee Vaults</span>
                    <span className="font-semibold text-white">{formatNumber(analytics?.vaultBalances?.totalVaultFeesFull ?? 0, "$", 2)}</span>
                  </div>
                  {/* Total row */}
                  <div className="flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-white/80 backdrop-blur-lg shadow-sm">
                    <span className="font-medium">Total Fees</span>
                    <span className="font-bold text-emerald-300">{formatNumber(feeBreakdownTotal, "$", 2)}</span>
                  </div>
                </div>
                <div className="rounded-xl border border-white/5 bg-neutral-950/60 p-3">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-white/50">
                    <Radar className="h-3.5 w-3.5 text-cyan-300" />
                    Position Mix
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center text-sm text-white/70">
                    <div className="rounded-lg border border-white/5 bg-white/5 px-2 py-2">
                      <div className="text-lg font-semibold">{analytics?.positionSizes?.small ?? 0}%</div>
                      <div className="text-[11px] text-white/50">Under $1K</div>
                    </div>
                    <div className="rounded-lg border border-white/5 bg-white/5 px-2 py-2">
                      <div className="text-lg font-semibold">{analytics?.positionSizes?.medium ?? 0}%</div>
                      <div className="text-[11px] text-white/50">$1K - $10K</div>
                    </div>
                    <div className="rounded-lg border border-white/5 bg-white/5 px-2 py-2">
                      <div className="text-lg font-semibold">{analytics?.positionSizes?.large ?? 0}%</div>
                      <div className="text-[11px] text-white/50">Over $10K</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-2xl border border-white/5 bg-white/5 backdrop-blur-lg p-4 shadow-xl transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-emerald-500/10">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm text-white/70">
                    <Users className="h-4 w-4 text-indigo-300" />
                    User Stats
                  </div>
                  <span className="text-xs text-white/50">{analytics?.users?.totalUsers ?? 0} total</span>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-3 text-sm text-white/70">
                  <div className="rounded-xl border border-white/5 bg-white/5 px-3 py-2">
                    <div className="text-xs text-white/50">New (7d)</div>
                    <div className="text-lg font-semibold">{analytics?.users?.newUsers7d ?? 0}</div>
                  </div>
                  <div className="rounded-xl border border-white/5 bg-white/5 px-3 py-2">
                    <div className="text-xs text-white/50">Active (30d)</div>
                    <div className="text-lg font-semibold">{analytics?.users?.activeUsers30d ?? 0}</div>
                  </div>
                  <div className="rounded-xl border border-white/5 bg-white/5 px-3 py-2">
                    <div className="text-xs text-white/50">Retention</div>
                    <div className="text-lg font-semibold">{(analytics?.users?.retentionRate ?? 0).toFixed(0)}%</div>
                  </div>
                </div>
                <div className="mt-4 h-28 rounded-xl border border-white/5 bg-neutral-950/70 p-3">
                  <svg
                    viewBox="0 0 260 80"
                    className="h-full w-full cursor-pointer"
                    onMouseMove={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const near = nearestPointByX(e.clientX, rect, usersSeries, 120, 6);
                      if (near) setHoveredUsers(near.value);
                    }}
                    onMouseLeave={() => setHoveredUsers(null)}
                  >
                    <path
                      d={sparkline(metricsHistory.map((m) => Number(m.active_users || 0)))}
                      fill="none"
                      stroke="#a855f7"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                  {hoveredUsers !== null && (
                    <div className="mt-1 text-[11px] text-white/70">Active users: {Math.round(hoveredUsers)}</div>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-white/5 bg-white/5 backdrop-blur-lg p-4 shadow-xl transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-emerald-500/10">
                <div className="flex items-center gap-2 text-sm text-white/70">
                  <Activity className="h-4 w-4 text-cyan-300" />
                  Hourly Activity (7d)
                </div>
                <div className="mt-4 grid grid-cols-7 gap-1">
                  {["S", "M", "T", "W", "T", "F", "S"].map((d, idx) => (
                    <div key={`${d}-${idx}`} className="flex flex-col gap-1">
                      <span className="text-center text-[10px] text-white/50">{d}</span>
                      <div className="grid grid-cols-4 gap-1">
                        {Array.from({ length: 24 }).map((_, hour) => {
                          const v = heatmap[idx][hour];
                          const intensity = Math.min(1, v / 6);
                          const bg = `rgba(16,185,129,${0.15 + intensity * 0.55})`;
                          return (
                            <div
                              key={hour}
                              className="h-3 w-3 rounded-sm"
                              style={{ backgroundColor: bg }}
                              onMouseEnter={() => setHoveredHeatmap({ day: idx, hour, count: v })}
                              onMouseLeave={() => setHoveredHeatmap(null)}
                            />
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                {hoveredHeatmap && (
                  <div className="mt-2 text-[11px] text-white/70">
                    {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][hoveredHeatmap.day]} {hoveredHeatmap.hour}:00 —{" "}
                    {hoveredHeatmap.count} tx
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-white/5 bg-white/5 backdrop-blur-lg p-4 shadow-xl">
                <div className="flex items-center gap-2 text-sm text-white/70">
                  <BarChart3 className="h-4 w-4 text-emerald-300" />
                  Top Users (volume)
                </div>
                <div className="mt-4 space-y-2">
                  {topUsers.length === 0 && <div className="text-sm text-white/50">No transactions yet.</div>}
                  {topUsers.map((u, idx) => (
                    <div key={u.user} className="flex items-center justify-between rounded-xl border border-white/5 bg-white/5 px-3 py-2 text-sm text-white/80">
                      <div className="flex items-center gap-2">
                        <span className="text-white/50">#{idx + 1}</span>
                        <WalletActions wallet={u.user} />
                      </div>
                      <span className="font-semibold">{formatNumber(u.total, "$", 2)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2 rounded-2xl border border-white/5 bg-white/5 backdrop-blur-lg p-4 shadow-xl transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-emerald-500/10">
                <div className="flex items-center gap-2 text-sm text-white/70">
                  <ShieldCheck className="h-4 w-4 text-emerald-300" />
                  Top Rifts (live)
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {/* FIXED: Use riftsData from rifts-cache (fresh) instead of analytics.rifts (stale) */}
                  {/* Sort by TVL highest to lowest */}
                  {(riftsData.length > 0 ? riftsData : analytics?.rifts || [])
                    .sort((a, b) => b.tvl - a.tvl)
                    .slice(0, 6)
                    .map((rift) => (
                    <div
                      key={rift.id}
                      onClick={() => {
                        setSelectedRift(rift);
                        setRiftModalOpen(true);
                      }}
                      className="rounded-xl border border-white/5 bg-neutral-950/70 px-3 py-3 shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:border-emerald-400/30 cursor-pointer hover:bg-neutral-900/70"
                    >
                      <div className="flex items-center justify-between text-sm text-white/80">
                        <div className="font-semibold">{rift.symbol || rift.underlying}</div>
                        <ExternalLink className="w-3.5 h-3.5 text-white/30" />
                      </div>
                      <div className="mt-2 flex items-center justify-between text-sm">
                        <div>
                          <div className="text-[11px] uppercase text-white/50">APY</div>
                          <div className="text-lg font-semibold text-emerald-300">{rift.apy.toFixed(2)}%</div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase text-white/50">TVL</div>
                          <div className="text-lg font-semibold">{formatNumber(rift.tvl, "$", 2)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase text-white/50">24h Vol</div>
                          <div className="text-lg font-semibold text-cyan-200">{formatNumber(rift.volume24h, "$", 2)}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {riftsData.length === 0 && (analytics?.rifts || []).length === 0 && (
                    <div className="col-span-2 text-sm text-white/60">No rift data yet.Will get populated as trades occur.</div>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-white/5 bg-white/5 backdrop-blur-lg p-4 shadow-xl transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-emerald-500/10">
                <div className="flex items-center gap-2 text-sm text-white/70">
                  <LineChart className="h-4 w-4 text-emerald-300" />
                  Live Feed
                </div>
              <div className="mt-3 space-y-2 text-sm text-white/70 max-h-[320px] overflow-auto pr-1">
                  {transactions.slice(0, 20).map((tx) => {
                    const ts = new Date(tx.timestamp || 0);
                    const value = Number(tx.amount_usd ?? tx.amount ?? tx.volume ?? 0);
                    return (
                      <div key={(tx.id as string) || `${tx.user_wallet}-${ts.getTime()}`} className="flex items-center justify-between rounded-lg border border-white/5 bg-neutral-950/60 px-3 py-2">
                        <div className="flex flex-col">
                          <div className="flex items-center gap-2">
                            <span className="text-white font-semibold">{tx.type || "tx"}</span>
                            <TxActions signature={(tx.signature || tx.id || '').replace(/-(?:wrap|unwrap)$/, '')} />
                          </div>
                          <span className="text-[11px] text-white/50">{ts.toLocaleString()}</span>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold">{formatNumber(value, "$", 2)}</div>
                          <div className="text-[11px] text-white/50">
                            {tx.user_wallet ? <WalletActions wallet={tx.user_wallet} /> : "unknown"}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {transactions.length === 0 && <div className="text-white/50">Waiting for transactions...</div>}
                </div>
              </div>
            </div>
          </>
        )}

        {/* Rift Detail Modal */}
        <RiftDetailModal
          rift={selectedRift}
          isOpen={riftModalOpen}
          onClose={() => {
            setRiftModalOpen(false);
            setSelectedRift(null);
          }}
        />
      </div>
    </div>
  );
};

// Wrap with error boundary for Safari/iOS
export default function RealtimeDashboardWithErrorBoundary() {
  return (
    <DashboardErrorBoundary>
      <RealtimeDashboard />
    </DashboardErrorBoundary>
  );
}
