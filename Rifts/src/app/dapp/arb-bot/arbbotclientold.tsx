"use client";

import React, { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertCircle,
  BarChart3,
  Bot,
  ChevronDown,
  Cloud,
  DollarSign,
  Info,
  RefreshCw,
  Server,
  TrendingUp,
} from "lucide-react";
import nextDynamic from "next/dynamic";

const RippleGrid = nextDynamic(
  () => import("@/components/reactbits/backgrounds/RippleGrid/RippleGrid"),
  { ssr: false, loading: () => <div className="w-full h-full bg-black" /> }
);

interface RiftOption {
  id: string;
  symbol: string;
  rSymbol: string;
  underlying: string;
  riftMint: string;
  underlyingMint: string;
  meteoraPools: string[];
  tvl: number;
}

interface PersistedStats {
  cumulative: {
    totalTrades: number;
    successfulTrades: number;
    failedTrades: number;
    totalProfitSol: number;
    totalVolumeSol: number;
    opportunitiesDetected: number;
    winRate: number;
    avgTradeSizeSol: number;
    avgProfitPerTradeSol: number;
    activeSessions: number;
    totalUptimeSeconds: number;
  };
  riftStats: RiftStatRecord[];
  activeSessions?: { riftsMonitored?: string[]; walletAddress?: string }[];
}

interface RiftStatRecord {
  riftId: string;
  rSymbol: string;
  totalTrades: number;
  successfulTrades: number;
  totalProfitSol: number;
  totalVolumeSol: number;
  winRate: number;
  lastUpdated: string;
}

export default function ArbBotClient() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rifts, setRifts] = useState<RiftOption[]>([]);
  const [selectedRiftId, setSelectedRiftId] = useState<string | null>(null);
  const [persistedStats, setPersistedStats] = useState<PersistedStats | null>(
    null
  );
  const [solPrice, setSolPrice] = useState(230);
  // Bot start form
  const [minProfitBps, setMinProfitBps] = useState(50); // 0.5%
  const [maxSlippageBps, setMaxSlippageBps] = useState(100); // 1%
  const [maxTradeSize, setMaxTradeSize] = useState(500); // USD
  const [startLoading, setStartLoading] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [startSuccess, setStartSuccess] = useState<string | null>(null);
  const [stopLoading, setStopLoading] = useState(false);
  const [walletAddress, setWalletAddress] = useState("");
  const [stopRequests, setStopRequests] = useState<Set<string>>(new Set());

  const activeRifts = useMemo(() => {
    const set = new Set<string>();
    persistedStats?.activeSessions?.forEach((s) => {
      s.riftsMonitored?.forEach((rid) => set.add(rid));
    });
    // If a stop was requested locally, hide it from active to prevent flicker
    stopRequests.forEach((rid) => set.delete(rid));
    return set;
  }, [persistedStats, stopRequests]);

  const activeWallets = useMemo(() => {
    const map = new Map<string, string>();
    persistedStats?.activeSessions?.forEach((s) => {
      if (s.walletAddress) {
        s.riftsMonitored?.forEach((rid) => map.set(rid, s.walletAddress || ""));
      }
    });
    return map;
  }, [persistedStats]);

  const riftStatsMap = useMemo(() => {
    const map = new Map<string, RiftStatRecord>();
    persistedStats?.riftStats?.forEach((rs) => map.set(rs.riftId, rs));
    return map;
  }, [persistedStats]);

  const cumulative = useMemo(
    () => persistedStats?.cumulative,
    [persistedStats]
  );

  // Fetch rifts and Supabase stats
  useEffect(() => {
    async function fetchAll() {
      try {
        setLoading(true);
        const [riftsRes, statsRes] = await Promise.all([
          fetch("/api/arb-config?action=list"),
          fetch("/api/arb-bot/stats"),
        ]);
        const riftsJson = await riftsRes.json();
        const statsJson = await statsRes.json();
        setRifts(riftsJson.rifts || []);
        setPersistedStats(statsJson);
        if (!selectedRiftId) {
          const firstStatId = statsJson?.riftStats?.[0]?.riftId;
          if (firstStatId) setSelectedRiftId(firstStatId);
        }
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Failed to load arb bot data."
        );
      } finally {
        setLoading(false);
      }
    }
    fetchAll();

    const price = async () => {
      try {
        const res = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
        );
        const data = await res.json();
        if (data.solana?.usd) setSolPrice(data.solana.usd);
      } catch {
        /* ignore */
      }
    };
    price();

    const interval = setInterval(fetchAll, 10000);
    return () => clearInterval(interval);
  }, [selectedRiftId]);

  const selectedStats = useMemo(() => {
    if (!selectedRiftId) return null;
    const statById = riftStatsMap.get(selectedRiftId);
    if (statById) return statById;
    const statBySymbol = persistedStats?.riftStats?.find(
      (rs) => rs.rSymbol === selectedRiftId
    );
    return statBySymbol || null;
  }, [selectedRiftId, riftStatsMap, persistedStats]);

  const selectedRift = useMemo(() => {
    if (!selectedStats) return null;
    const byId = rifts.find((r) => r.id === selectedStats.riftId);
    if (byId) return byId;
    const bySymbol = rifts.find((r) => r.rSymbol === selectedStats.rSymbol);
    return bySymbol || null;
  }, [selectedStats, rifts]);

  useEffect(() => {
    if (!selectedRiftId) return;
    if (walletAddress) return;
    const w = activeWallets.get(selectedRiftId);
    if (w) setWalletAddress(w);
  }, [selectedRiftId, activeWallets, walletAddress]);

  const handleStartBot = async () => {
    if (!selectedStats) {
      setStartError("Select a rift first.");
      return;
    }
    if (!walletAddress) {
      setStartError("Wallet address required.");
      return;
    }
    setStartError(null);
    setStartSuccess(null);
    setStartLoading(true);
    try {
      const resp = await fetch("/api/arb-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          walletAddress,
          riftId: selectedStats.riftId,
          riftSymbol: selectedStats.rSymbol,
          config: {
            minProfitBps,
            maxSlippageBps,
            maxTradeSize,
          },
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Failed to start bot");
      setStartSuccess("Bot start requested. It will appear in Supabase stats once running.");
    } catch (e) {
      setStartError(e instanceof Error ? e.message : "Failed to start bot");
    } finally {
      setStartLoading(false);
    }
  };

  const handleStopBot = async () => {
    if (!selectedStats) {
      setStartError("Select a rift first.");
      return;
    }
    if (!walletAddress) {
      setStartError("Wallet address required.");
      return;
    }
    setStartError(null);
    setStartSuccess(null);
    setStopLoading(true);
    try {
      const resp = await fetch("/api/arb-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "stop",
          walletAddress,
          riftId: selectedStats.riftId,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Failed to stop bot");
      setStartSuccess("Bot stop requested.");
      // Optimistically remove from active sessions so UI reflects stopped state immediately
      setPersistedStats((prev) => {
        if (!prev) return prev;
        const nextActive = (prev.activeSessions || [])
          .map((s) => ({
            ...s,
            riftsMonitored: s.riftsMonitored?.filter((rid) => rid !== selectedStats.riftId),
          }))
          .filter((s) => s.riftsMonitored && s.riftsMonitored.length > 0);
        return { ...prev, activeSessions: nextActive };
      });
    } catch (e) {
      setStartError(e instanceof Error ? e.message : "Failed to stop bot");
    } finally {
      setStopLoading(false);
    }
  };

  // Inline error banner instead of full-page
  const errorBanner = error ? (
    <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center gap-3">
      <AlertCircle className="w-5 h-5 text-red-400" />
      <span className="text-red-400 text-sm">{error}</span>
    </div>
  ) : null;

  return (
    <div className="relative flex w-full min-h-screen text-white md:h-screen md:overflow-hidden">
      <div className="fixed inset-0 z-10 bg-black">
        <RippleGrid
          enableRainbow={false}
          gridColor="#10b981"
          rippleIntensity={0.03}
          gridSize={18}
          gridThickness={6}
          mouseInteraction
          mouseInteractionRadius={3.0}
          opacity={0.85}
          fadeDistance={2.5}
          vignetteStrength={2.5}
          glowIntensity={0.5}
        />
      </div>

      <div className="relative z-20 flex flex-col flex-1 overflow-hidden">
        <div className="relative flex flex-col flex-1 p-4 md:p-6 overflow-y-auto">
          {errorBanner}
          <div className="mb-4 flex items-center justify-between">
            <button
              onClick={() => router.push("/dapp")}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800/80 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-600 transition-all"
            >
              <ChevronDown className="w-4 h-4 rotate-90" />
              Back to dApp
            </button>
            <div className="flex items-center gap-3">
              <Bot className="w-5 h-5 text-emerald-400" />
              <span className="text-lg font-bold text-white">Arb Bot</span>
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/30">
                <Cloud className="w-4 h-4 text-blue-400" />
                <span className="text-xs text-blue-400">Cloud only</span>
              </div>
            </div>
          </div>

          {/* Performance Summary */}
          <div className="rounded-xl bg-black/60 backdrop-blur-xl border border-emerald-500/20 p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-emerald-400" />
                Performance Summary
                {cumulative?.activeSessions ? (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-xs">
                    {cumulative.activeSessions} Active
                  </span>
                ) : null}
              </h2>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
              <SummaryCard
                label="Total Trades"
                value={cumulative?.totalTrades ?? 0}
              />
              <SummaryCard
                label="Successful"
                value={cumulative?.successfulTrades ?? 0}
                color="text-emerald-400"
              />
              <SummaryCard
                label="Failed"
                value={cumulative?.failedTrades ?? 0}
                color="text-red-400"
              />
              <SummaryCard
                label="Opportunities"
                value={cumulative?.opportunitiesDetected ?? 0}
                color="text-purple-400"
              />
              <SummaryCard
                label="Volume ($)"
                value={((cumulative?.totalVolumeSol ?? 0) * solPrice).toFixed(
                  0
                )}
                color="text-cyan-400"
              />
              <SummaryCard
                label="Total P&L"
                value={`$${(
                  (cumulative?.totalProfitSol ?? 0) * solPrice
                ).toFixed(2)}`}
                color={(cumulative?.totalProfitSol ?? 0) >= 0 ? "text-green-400" : "text-red-400"}
              />
              <SummaryCard
                label="Win Rate"
                value={`${(cumulative?.winRate ?? 0).toFixed(1)}%`}
                color="text-yellow-400"
              />
              <SummaryCard
                label="Avg/Trade"
                value={`$${(
                  (cumulative?.avgProfitPerTradeSol ?? 0) * solPrice
                ).toFixed(2)}`}
                color="text-orange-400"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
            {/* Rift selector */}
            <div className="rounded-xl bg-black/60 backdrop-blur-xl border border-emerald-500/20 p-6 space-y-4">
              <h2 className="text-lg font-semibold text-white mb-2 flex items-center gap-2">
                <Server className="w-5 h-5 text-emerald-400" />
                Supabase Rifts
              </h2>
              <div className="max-h-72 overflow-y-auto rounded-lg bg-gray-900/80 border border-emerald-500/30">
                {persistedStats?.riftStats?.length ? (
                  persistedStats.riftStats.map((rs) => {
                    const meta =
                      rifts.find((r) => r.id === rs.riftId) ||
                      rifts.find((r) => r.rSymbol === rs.rSymbol);
                    const pnlUsd =
                      rs.totalProfitSol != null ? rs.totalProfitSol * solPrice : 0;
                    const isRunning = activeRifts.has(rs.riftId);
                    return (
                      <div
                        key={rs.riftId}
                        className={`px-4 py-3 border-b border-gray-800 last:border-b-0 cursor-pointer hover:bg-gray-800/40 transition-colors ${
                          selectedRiftId === rs.riftId ? "bg-emerald-500/10 border-emerald-500/30" : ""
                        }`}
                        onClick={() => setSelectedRiftId(rs.riftId)}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-white font-medium flex items-center gap-2">
                              {rs.rSymbol}
                            </div>
                            <div className="text-xs text-gray-400">
                              {meta?.underlying || rs.rSymbol}
                            </div>
                          </div>
                          <div className="text-right text-xs">
                            {isRunning && (
                              <div className="mb-1 text-emerald-400">Running</div>
                            )}
                            <div className="text-purple-400">
                              {rs.totalTrades ?? 0} trades
                            </div>
                            <div className={pnlUsd >= 0 ? "text-green-400" : "text-red-400"}>
                              ${pnlUsd.toFixed(2)}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="px-4 py-3 text-gray-400 text-sm">
                    No Supabase stats found
                  </div>
                )}
              </div>
            </div>

            {/* Bot stats (read-only from Supabase) */}
            <div className="lg:col-span-2 space-y-6">
              <div className="rounded-xl bg-black/60 backdrop-blur-xl border border-emerald-500/20 overflow-hidden">
                <div className="px-6 py-4 border-b border-emerald-500/20 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Bot className="w-5 h-5 text-emerald-400" />
                    <h2 className="text-lg font-semibold text-white">
                      Supabase Stats (read-only)
                    </h2>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-400">
                      SYNCED
                    </span>
                  </div>
                </div>

                {!selectedRift ? (
                  <div className="p-6 text-center">
                    <Bot className="w-16 h-16 mx-auto text-emerald-500/30 mb-4" />
                    <h3 className="text-xl font-semibold text-white mb-2">
                      Select a Token
                    </h3>
                    <p className="text-gray-400 max-w-md mx-auto">
                      Choose a rift token to view Supabase-recorded arbitrage
                      stats.
                    </p>
                  </div>
                ) : (
                  <div className="p-6 space-y-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-lg font-semibold text-white flex items-center gap-2">
                          {selectedStats?.rSymbol || selectedRift.rSymbol}
                          <span className="text-xs text-gray-400">
                            {selectedRift.underlying}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500">
                          {selectedStats?.riftId || selectedRift.id}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm text-gray-400">Last update</div>
                        <div className="text-xs text-gray-300">
                          {selectedStats?.lastUpdated
                            ? new Date(
                                selectedStats.lastUpdated
                              ).toLocaleString()
                            : "—"}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <StatTile
                        label="Trades"
                        value={selectedStats?.totalTrades ?? 0}
                        icon={<TrendingUp className="w-5 h-5" />}
                        color="text-purple-400"
                      />
                      <StatTile
                        label="P&L (USD)"
                        value={`$${(
                          (selectedStats?.totalProfitSol ?? 0) * solPrice
                        ).toFixed(2)}`}
                        icon={<DollarSign className="w-5 h-5" />}
                        color={
                          (selectedStats?.totalProfitSol ?? 0) >= 0
                            ? "text-green-400"
                            : "text-red-400"
                        }
                      />
                      <StatTile
                        label="Volume (USD)"
                        value={`$${(
                          (selectedStats?.totalVolumeSol ?? 0) * solPrice
                        ).toFixed(0)}`}
                        icon={<Activity className="w-5 h-5" />}
                        color="text-cyan-400"
                      />
                      <StatTile
                        label="Win Rate"
                        value={`${(selectedStats?.winRate ?? 0).toFixed(1)}%`}
                        icon={<BarChart3 className="w-5 h-5" />}
                        color="text-yellow-400"
                      />
                    </div>

                    <div className="rounded-lg bg-gray-900/50 border border-gray-800 p-4">
                      <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                        <Server className="w-4 h-4 text-emerald-400" />
                        Start Bot
                      </h3>
                      <div className="mb-3">
                        <label className="text-xs text-gray-500">Wallet Address</label>
                        <input
                          type="text"
                          value={walletAddress}
                          onChange={(e) => setWalletAddress(e.target.value.trim())}
                          placeholder="Enter wallet address"
                          className="w-full mt-1 px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm"
                        />
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3 text-sm">
                        <div>
                          <label className="text-xs text-gray-500">Minimum Profit (after fees)</label>
                          <input
                            type="range"
                            min={10}
                            max={200}
                            value={minProfitBps}
                            onChange={(e) => setMinProfitBps(Number(e.target.value))}
                            className="w-full accent-emerald-500"
                          />
                          <div className="flex items-center justify-between text-[11px] text-gray-500 mt-1">
                            <span>0.10%</span>
                            <span className="text-white font-mono">{(minProfitBps / 100).toFixed(2)}%</span>
                            <span>2.00%</span>
                          </div>
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">Max Slippage</label>
                          <input
                            type="range"
                            min={50}
                            max={300}
                            value={maxSlippageBps}
                            onChange={(e) => setMaxSlippageBps(Number(e.target.value))}
                            className="w-full accent-emerald-500"
                          />
                          <div className="flex items-center justify-between text-[11px] text-gray-500 mt-1">
                            <span>0.50%</span>
                            <span className="text-white font-mono">{(maxSlippageBps / 100).toFixed(2)}%</span>
                            <span>3.00%</span>
                          </div>
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">Max Trade Size (USD)</label>
                          <input
                            type="range"
                            min={100}
                            max={2500}
                            step={100}
                            value={maxTradeSize}
                            onChange={(e) => setMaxTradeSize(Number(e.target.value))}
                            className="w-full accent-emerald-500"
                          />
                          <div className="flex items-center justify-between text-[11px] text-gray-500 mt-1">
                            <span>$100</span>
                            <span className="text-white font-mono">${maxTradeSize}</span>
                            <span>$2500</span>
                          </div>
                        </div>
                      </div>
                      {startError && (
                        <div className="text-xs text-red-400 mb-2">{startError}</div>
                      )}
                      {startSuccess && (
                        <div className="text-xs text-emerald-400 mb-2">{startSuccess}</div>
                      )}
                      {activeRifts.has(selectedStats?.riftId || "") && (
                        <div className="flex gap-2 mb-2">
                          <button
                            onClick={handleStopBot}
                            disabled={stopLoading}
                            className="flex-1 px-4 py-2 rounded-lg bg-red-500 text-white font-semibold hover:bg-red-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {stopLoading ? "Stopping..." : "Stop Bot"}
                          </button>
                          <span className="text-xs text-emerald-400 flex items-center">
                            Running
                          </span>
                        </div>
                      )}
                      {!activeRifts.has(selectedStats?.riftId || "") && (
                        <button
                          onClick={handleStartBot}
                          disabled={startLoading || !selectedStats}
                          className="w-full px-4 py-2 rounded-lg bg-emerald-500 text-black font-semibold hover:bg-emerald-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {startLoading ? "Starting..." : "Start Bot"}
                        </button>
                      )}
                      <p className="text-[11px] text-gray-500 mt-2">
                        Starts a 24/7 cloud bot for this rift. Stats will appear from Supabase once running.
                      </p>
                    </div>

                    <div className="rounded-lg bg-gray-900/50 border border-gray-800 p-4">
                      <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                        <Info className="w-4 h-4 text-emerald-400" />
                        Rift Info
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm text-gray-300">
                        <div>
                          <span className="text-gray-500">Rift Mint: </span>
                          <span className="font-mono">{selectedRift.riftMint}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Underlying Mint: </span>
                          <span className="font-mono">{selectedRift.underlyingMint}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Pools: </span>
                          <span>{selectedRift.meteoraPools.length}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">TVL: </span>
                          <span>${selectedRift.tvl.toFixed(0)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  color = "text-white",
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-800 text-center">
      <div className={`text-lg font-bold ${color}`}>{value}</div>
      <div className="text-xs text-gray-400">{label}</div>
    </div>
  );
}

function StatTile({
  label,
  value,
  icon,
  color = "text-white",
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  color?: string;
}) {
  return (
    <div className="px-4 py-4 rounded-lg bg-gray-900/50 border border-gray-800 text-center">
      <div className={`w-5 h-5 mx-auto mb-2 ${color} flex items-center justify-center`}>
        {icon}
      </div>
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-gray-400">{label}</div>
    </div>
  );
}
