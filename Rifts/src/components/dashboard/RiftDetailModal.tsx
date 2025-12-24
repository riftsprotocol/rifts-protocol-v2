"use client";

import React, { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Check,
  Clock,
  Copy,
  ExternalLink,
  Flame,
  LineChart,
  Loader2,
  PieChart,
  Shield,
  TrendingUp,
  Users,
  Wallet,
  X,
  Zap,
} from "lucide-react";

type RiftDetailData = {
  id: string;
  symbol: string;
  name?: string;
  tvl: number;
  volume24h: number;
  apy: number;
  underlying?: string;
  riftMint?: string;
  riftAddress?: string;
  underlyingMint?: string;
  vaultAddress?: string;
  vaultBalance?: number;
  participants?: number;
  totalWrapped?: number;
  feeRate?: number;
};

type HistoricalPoint = {
  timestamp: string;
  tvl: number;
  volume24h: number;
  apy: number;
};

type Transaction = {
  signature: string;
  type: "wrap" | "unwrap";
  amount: number;
  user_wallet: string;
  timestamp: string;
};

interface RiftDetailModalProps {
  rift: RiftDetailData | null;
  isOpen: boolean;
  onClose: () => void;
}

// Chart path helper
const createChartPath = (
  points: { x: number; y: number }[],
  width: number,
  height: number,
  padding: number
): { line: string; fill: string } => {
  if (points.length < 2) return { line: "", fill: "" };

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const xScale = (val: number) =>
    padding + ((val - minX) / Math.max(1, maxX - minX)) * (width - padding * 2);
  const yScale = (val: number) =>
    height - padding - ((val - minY) / Math.max(1, maxY - minY)) * (height - padding * 2);

  const line = points
    .map((p, idx) => `${idx === 0 ? "M" : "L"}${xScale(p.x)},${yScale(p.y)}`)
    .join(" ");

  // Create fill path
  const firstX = xScale(points[0].x);
  const lastX = xScale(points[points.length - 1].x);
  const bottomY = height - padding;
  const fill = `${line} L ${lastX} ${bottomY} L ${firstX} ${bottomY} Z`;

  return { line, fill };
};

const formatNumber = (value: number, prefix = "", decimals = 2) => {
  if (value === undefined || value === null || Number.isNaN(value)) return "–";
  if (value >= 1_000_000_000) return `${prefix}${(value / 1_000_000_000).toFixed(decimals)}B`;
  if (value >= 1_000_000) return `${prefix}${(value / 1_000_000).toFixed(decimals)}M`;
  if (value >= 1_000) return `${prefix}${(value / 1_000).toFixed(decimals)}K`;
  return `${prefix}${value.toFixed(decimals)}`;
};

const formatAddress = (addr: string) => `${addr.slice(0, 4)}...${addr.slice(-4)}`;

const CopyButton = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button onClick={handleCopy} className="p-1 hover:bg-white/10 rounded transition-colors">
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-white/50" />}
    </button>
  );
};

// Mini chart component
const MiniChart = ({
  data,
  color,
  fillColor,
  height = 80,
  showGrid = false,
}: {
  data: number[];
  color: string;
  fillColor: string;
  height?: number;
  showGrid?: boolean;
}) => {
  if (data.length < 2) {
    return (
      <div className="flex items-center justify-center h-20 text-white/30 text-sm">
        No data available
      </div>
    );
  }

  const points = data.map((value, idx) => ({ x: idx, y: value }));
  const paths = createChartPath(points, 300, height, 8);

  return (
    <svg viewBox={`0 0 300 ${height}`} className="w-full" style={{ height }}>
      <defs>
        <linearGradient id={`gradient-${color}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={fillColor} />
          <stop offset="100%" stopColor={fillColor.replace("0.3", "0.05")} />
        </linearGradient>
      </defs>
      {showGrid && (
        <>
          {[0.25, 0.5, 0.75].map((p) => (
            <line
              key={p}
              x1="8"
              x2="292"
              y1={height * p}
              y2={height * p}
              stroke="rgba(255,255,255,0.05)"
              strokeDasharray="4 4"
            />
          ))}
        </>
      )}
      <path d={paths.fill} fill={`url(#gradient-${color})`} />
      <path d={paths.line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
};

// Stat card component
const StatCard = ({
  icon,
  label,
  value,
  subValue,
  trend,
  color = "emerald",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  subValue?: string;
  trend?: number;
  color?: "emerald" | "cyan" | "amber" | "purple" | "rose";
}) => {
  const colorClasses = {
    emerald: "from-emerald-500/20 to-emerald-500/5 border-emerald-500/30",
    cyan: "from-cyan-500/20 to-cyan-500/5 border-cyan-500/30",
    amber: "from-amber-500/20 to-amber-500/5 border-amber-500/30",
    purple: "from-purple-500/20 to-purple-500/5 border-purple-500/30",
    rose: "from-rose-500/20 to-rose-500/5 border-rose-500/30",
  };

  return (
    <div className={`rounded-xl border bg-gradient-to-br ${colorClasses[color]} p-4`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-white/60 text-sm">
          {icon}
          <span>{label}</span>
        </div>
        {trend !== undefined && (
          <span
            className={`flex items-center gap-1 text-xs ${
              trend >= 0 ? "text-emerald-400" : "text-rose-400"
            }`}
          >
            {trend >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {Math.abs(trend).toFixed(1)}%
          </span>
        )}
      </div>
      <div className="mt-2 text-2xl font-bold text-white">{value}</div>
      {subValue && <div className="mt-1 text-sm text-white/50">{subValue}</div>}
    </div>
  );
};

// Tab component
const TabButton = ({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button
    onClick={onClick}
    className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
      active
        ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
        : "text-white/60 hover:text-white/80 hover:bg-white/5"
    }`}
  >
    {children}
  </button>
);

export const RiftDetailModal: React.FC<RiftDetailModalProps> = ({
  rift,
  isOpen,
  onClose,
}) => {
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"overview" | "charts" | "history">("overview");
  const [chartTimeframe, setChartTimeframe] = useState<"1d" | "7d" | "30d">("7d");
  const [historicalData, setHistoricalData] = useState<HistoricalPoint[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [riftDetails, setRiftDetails] = useState<RiftDetailData | null>(null);

  // Fetch rift details and history when modal opens
  useEffect(() => {
    if (!isOpen || !rift) return;

    const fetchData = async () => {
      setLoading(true);
      try {
        // Fetch rift details from rifts-read (fast Supabase read)
        const [cacheRes, historyRes] = await Promise.all([
          fetch("/api/rifts-read").then((r) => r.json()),
          fetch(`/api/get-transactions?rift_id=${rift.id}&limit=50`).then((r) => r.json()).catch(() => ({ transactions: [] })),
        ]);

        // Find this rift in the cache
        const rifts = cacheRes.rifts || [];
        const fullRift = rifts.find((r: any) => r.id === rift.id);

        if (fullRift) {
          setRiftDetails({
            ...rift,
            ...fullRift,
            participants: fullRift.participants || 0,
            totalWrapped: fullRift.vaultBalance || 0,
            feeRate: 0.7,
          });
        } else {
          setRiftDetails(rift);
        }

        // Set transactions
        setTransactions(historyRes.transactions || []);

        // Generate mock historical data based on current values (TODO: fetch real historical)
        const now = Date.now();
        const points: HistoricalPoint[] = [];
        const days = chartTimeframe === "1d" ? 1 : chartTimeframe === "7d" ? 7 : 30;
        const interval = (days * 24 * 60 * 60 * 1000) / 48;

        for (let i = 48; i >= 0; i--) {
          const variance = 1 + (Math.random() - 0.5) * 0.1;
          points.push({
            timestamp: new Date(now - i * interval).toISOString(),
            tvl: (rift.tvl || 0) * variance,
            volume24h: (rift.volume24h || 0) * variance,
            apy: (rift.apy || 0) * variance,
          });
        }
        setHistoricalData(points);
      } catch (error) {
        console.error("Error fetching rift details:", error);
        setRiftDetails(rift);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [isOpen, rift, chartTimeframe]);

  const tvlData = useMemo(() => historicalData.map((p) => p.tvl), [historicalData]);
  const volumeData = useMemo(() => historicalData.map((p) => p.volume24h), [historicalData]);
  const apyData = useMemo(() => historicalData.map((p) => p.apy), [historicalData]);

  const tvlChange = useMemo(() => {
    if (tvlData.length < 2) return 0;
    const first = tvlData[0] || 1;
    const last = tvlData[tvlData.length - 1] || 0;
    return ((last - first) / first) * 100;
  }, [tvlData]);

  if (!isOpen || !rift) return null;

  const displayRift = riftDetails || rift;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-2 md:p-4 z-[100]"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className="bg-neutral-950/95 backdrop-blur-xl border border-white/10 rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden shadow-2xl"
        >
          {/* Header */}
          <div className="relative border-b border-white/10 p-6">
            <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/10 via-transparent to-cyan-500/10 pointer-events-none" />
            <div className="relative flex items-start justify-between">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-emerald-500/30 to-cyan-500/30 border border-emerald-500/30 flex items-center justify-center">
                  <span className="text-2xl font-bold text-emerald-300">
                    {displayRift.symbol?.charAt(0) || "R"}
                  </span>
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-white">{displayRift.symbol}</h2>
                  <p className="text-white/60 text-sm mt-0.5">
                    {displayRift.name || `${displayRift.underlying || "Token"} Volatility Vault`}
                  </p>
                  <div className="flex items-center gap-3 mt-2">
                    {displayRift.riftMint && (
                      <span className="flex items-center gap-1 text-white/40 text-xs">
                        {formatAddress(displayRift.riftMint)}
                        <CopyButton text={displayRift.riftMint} />
                        <a
                          href={`https://solscan.io/token/${displayRift.riftMint}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1 hover:bg-white/10 rounded transition-colors"
                        >
                          <ExternalLink className="w-3 h-3 text-white/50" />
                        </a>
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 rounded-lg hover:bg-white/10 transition-colors text-white/60 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="overflow-y-auto max-h-[calc(90vh-120px)]">
            {loading ? (
              <div className="flex items-center justify-center h-64">
                <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
              </div>
            ) : (
              <div className="p-6 space-y-6">
                {/* Key Stats */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <StatCard
                    icon={<Wallet className="w-4 h-4 text-emerald-400" />}
                    label="TVL"
                    value={formatNumber(displayRift.tvl, "$")}
                    trend={tvlChange}
                    color="emerald"
                  />
                  <StatCard
                    icon={<Activity className="w-4 h-4 text-cyan-400" />}
                    label="24h Volume"
                    value={formatNumber(displayRift.volume24h, "$")}
                    color="cyan"
                  />
                  <StatCard
                    icon={<TrendingUp className="w-4 h-4 text-purple-400" />}
                    label="APY"
                    value={`${displayRift.apy?.toFixed(2) || 0}%`}
                    subValue="Annualized yield"
                    color="purple"
                  />
                  <StatCard
                    icon={<Users className="w-4 h-4 text-amber-400" />}
                    label="Farmers"
                    value={(displayRift.participants || 0).toString()}
                    subValue="Active holders"
                    color="amber"
                  />
                </div>

                {/* Tabs */}
                <div className="flex items-center gap-2 border-b border-white/10 pb-4">
                  <TabButton active={activeTab === "overview"} onClick={() => setActiveTab("overview")}>
                    <span className="flex items-center gap-2">
                      <BarChart3 className="w-4 h-4" /> Overview
                    </span>
                  </TabButton>
                  <TabButton active={activeTab === "charts"} onClick={() => setActiveTab("charts")}>
                    <span className="flex items-center gap-2">
                      <LineChart className="w-4 h-4" /> Charts
                    </span>
                  </TabButton>
                  <TabButton active={activeTab === "history"} onClick={() => setActiveTab("history")}>
                    <span className="flex items-center gap-2">
                      <Clock className="w-4 h-4" /> History
                    </span>
                  </TabButton>
                </div>

                {/* Tab Content */}
                {activeTab === "overview" && (
                  <div className="grid md:grid-cols-2 gap-6">
                    {/* TVL Chart */}
                    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                      <div className="flex items-center justify-between mb-4">
                        <span className="text-white/60 text-sm flex items-center gap-2">
                          <Wallet className="w-4 h-4 text-emerald-400" /> TVL History
                        </span>
                        <span className="text-emerald-300 text-lg font-semibold">
                          {formatNumber(displayRift.tvl, "$")}
                        </span>
                      </div>
                      <MiniChart
                        data={tvlData}
                        color="#34d399"
                        fillColor="rgba(52, 211, 153, 0.3)"
                        height={100}
                        showGrid
                      />
                    </div>

                    {/* Volume Chart */}
                    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                      <div className="flex items-center justify-between mb-4">
                        <span className="text-white/60 text-sm flex items-center gap-2">
                          <Activity className="w-4 h-4 text-cyan-400" /> Volume History
                        </span>
                        <span className="text-cyan-300 text-lg font-semibold">
                          {formatNumber(displayRift.volume24h, "$")}
                        </span>
                      </div>
                      <MiniChart
                        data={volumeData}
                        color="#22d3ee"
                        fillColor="rgba(34, 211, 238, 0.3)"
                        height={100}
                        showGrid
                      />
                    </div>

                    {/* Vault Details */}
                    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                      <h3 className="text-white font-medium mb-4 flex items-center gap-2">
                        <Shield className="w-4 h-4 text-emerald-400" /> Vault Details
                      </h3>
                      <div className="space-y-3">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-white/60">Underlying Token</span>
                          <span className="text-white">{displayRift.underlying || displayRift.symbol}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-white/60">Fee Rate</span>
                          <span className="text-white">{displayRift.feeRate || 0.3}%</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-white/60">Total Wrapped</span>
                          <span className="text-white">
                            {formatNumber(displayRift.totalWrapped || 0)} tokens
                          </span>
                        </div>
                        {displayRift.riftMint && (
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-white/60">rToken Mint</span>
                            <span className="flex items-center gap-1 text-white">
                              {formatAddress(displayRift.riftMint)}
                              <CopyButton text={displayRift.riftMint} />
                              <a
                                href={`https://solscan.io/token/${displayRift.riftMint}`}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <ExternalLink className="w-3 h-3 text-white/50" />
                              </a>
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Performance */}
                    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                      <h3 className="text-white font-medium mb-4 flex items-center gap-2">
                        <Zap className="w-4 h-4 text-amber-400" /> Performance
                      </h3>
                      <div className="space-y-3">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-white/60">Current APY</span>
                          <span className="text-emerald-400 font-semibold">
                            {displayRift.apy?.toFixed(2) || 0}%
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-white/60">Daily Yield</span>
                          <span className="text-white">
                            {((displayRift.apy || 0) / 365).toFixed(4)}%
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-white/60">Weekly Yield</span>
                          <span className="text-white">
                            {((displayRift.apy || 0) / 52).toFixed(3)}%
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-white/60">Monthly Yield</span>
                          <span className="text-white">
                            {((displayRift.apy || 0) / 12).toFixed(2)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === "charts" && (
                  <div className="space-y-6">
                    {/* Timeframe Selector */}
                    <div className="flex items-center gap-2">
                      {(["1d", "7d", "30d"] as const).map((tf) => (
                        <button
                          key={tf}
                          onClick={() => setChartTimeframe(tf)}
                          className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-all ${
                            chartTimeframe === tf
                              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                              : "text-white/50 hover:text-white/80 hover:bg-white/5"
                          }`}
                        >
                          {tf.toUpperCase()}
                        </button>
                      ))}
                    </div>

                    {/* Large TVL Chart */}
                    <div className="rounded-xl border border-white/10 bg-white/5 p-6">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-white font-medium flex items-center gap-2">
                          <Wallet className="w-5 h-5 text-emerald-400" /> Total Value Locked
                        </h3>
                        <span className="text-2xl font-bold text-emerald-300">
                          {formatNumber(displayRift.tvl, "$")}
                        </span>
                      </div>
                      <MiniChart
                        data={tvlData}
                        color="#34d399"
                        fillColor="rgba(52, 211, 153, 0.3)"
                        height={180}
                        showGrid
                      />
                    </div>

                    {/* Volume & APY side by side */}
                    <div className="grid md:grid-cols-2 gap-6">
                      <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                        <div className="flex items-center justify-between mb-4">
                          <h3 className="text-white/60 text-sm flex items-center gap-2">
                            <Activity className="w-4 h-4 text-cyan-400" /> 24h Volume
                          </h3>
                          <span className="text-cyan-300 font-semibold">
                            {formatNumber(displayRift.volume24h, "$")}
                          </span>
                        </div>
                        <MiniChart
                          data={volumeData}
                          color="#22d3ee"
                          fillColor="rgba(34, 211, 238, 0.3)"
                          height={120}
                          showGrid
                        />
                      </div>

                      <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                        <div className="flex items-center justify-between mb-4">
                          <h3 className="text-white/60 text-sm flex items-center gap-2">
                            <TrendingUp className="w-4 h-4 text-purple-400" /> APY
                          </h3>
                          <span className="text-purple-300 font-semibold">
                            {displayRift.apy?.toFixed(2)}%
                          </span>
                        </div>
                        <MiniChart
                          data={apyData}
                          color="#a855f7"
                          fillColor="rgba(168, 85, 247, 0.3)"
                          height={120}
                          showGrid
                        />
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === "history" && (
                  <div className="space-y-4">
                    <h3 className="text-white font-medium flex items-center gap-2">
                      <Clock className="w-5 h-5 text-white/60" /> Recent Transactions
                    </h3>

                    {transactions.length === 0 ? (
                      <div className="text-center py-12 text-white/50">
                        <Clock className="w-12 h-12 mx-auto mb-4 opacity-30" />
                        <p>No recent transactions found for this rift</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {transactions.map((tx, idx) => (
                          <div
                            key={tx.signature || idx}
                            className="flex items-center justify-between rounded-lg border border-white/5 bg-white/5 px-4 py-3 hover:border-white/10 transition-colors"
                          >
                            <div className="flex items-center gap-4">
                              <div
                                className={`p-2 rounded-lg ${
                                  tx.type === "wrap"
                                    ? "bg-emerald-500/20 text-emerald-400"
                                    : "bg-rose-500/20 text-rose-400"
                                }`}
                              >
                                {tx.type === "wrap" ? (
                                  <ArrowUpRight className="w-4 h-4" />
                                ) : (
                                  <ArrowDownRight className="w-4 h-4" />
                                )}
                              </div>
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-medium text-white capitalize">{tx.type}</span>
                                  {tx.signature && (
                                    <a
                                      href={`https://solscan.io/tx/${tx.signature}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-white/40 hover:text-white/60"
                                    >
                                      <ExternalLink className="w-3 h-3" />
                                    </a>
                                  )}
                                </div>
                                <div className="text-sm text-white/50">
                                  {new Date(tx.timestamp).toLocaleString()}
                                </div>
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="font-semibold text-white">
                                {formatNumber(tx.amount)} {displayRift.underlying || displayRift.symbol}
                              </div>
                              {tx.user_wallet && (
                                <div className="text-sm text-white/50 flex items-center gap-1 justify-end">
                                  {formatAddress(tx.user_wallet)}
                                  <a
                                    href={`https://solscan.io/account/${tx.user_wallet}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-white/40 hover:text-white/60"
                                  >
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

export default RiftDetailModal;
