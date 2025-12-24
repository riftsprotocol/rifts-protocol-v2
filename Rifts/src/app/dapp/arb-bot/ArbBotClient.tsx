"use client"

import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter } from 'next/navigation';
import {
  Bot, RefreshCw, AlertCircle, Play, Square,
  ChevronDown, Zap, Activity, TrendingUp,
  Info, Lock, Wallet, BarChart3, Target,
  DollarSign, Clock, Gauge, Settings, Search,
  Cloud, Star, Send, Copy, Check, X, ExternalLink
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { LuxuryButton } from '@/components/ui/luxury-button';
import nextDynamic from 'next/dynamic';
import { useRealWallet } from '@/hooks/useWalletAdapter';
import DappSidebar from '@/components/dapp/DappSidebar';

// Luxury Card Component for consistent styling
function LuxuryCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`relative bg-black/90 backdrop-blur-md border border-emerald-500/30 rounded-xl overflow-hidden ${className}`}>
      {/* Luxury background patterns */}
      <div className="absolute inset-0 opacity-30 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
      </div>
      {/* Corner accents */}
      <div className="absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 border-emerald-500/50 pointer-events-none" />
      <div className="absolute top-0 right-0 w-3 h-3 border-t-2 border-r-2 border-emerald-500/50 pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-3 h-3 border-b-2 border-l-2 border-emerald-500/50 pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-emerald-500/50 pointer-events-none" />
      <div className="relative z-10">{children}</div>
    </div>
  );
}

const RippleGrid = nextDynamic(
  () => import('@/components/reactbits/backgrounds/RippleGrid/RippleGrid'),
  {
    ssr: false,
    loading: () => <div className="w-full h-full bg-black" />
  }
);

// Admin wallet - can access all rifts
const ADMIN_WALLET = '9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4';

interface RiftOption {
  id: string;
  symbol: string;
  rSymbol: string;
  underlying: string;
  riftMint: string;
  underlyingMint: string;
  vault: string;
  hasMeteoraPool: boolean;
  hasPumpSwapPool: boolean;
  meteoraPools: string[];
  programVersion: string;
  tvl: number;
  transferFeeBps: number;
  wrapFeeBps: number;
  unwrapFeeBps: number;
  isTeamRift?: boolean;
  teamSplit?: number | null; // Team's percentage (0-100), rest goes to us
}

interface BotStats {
  status: 'stopped' | 'running' | 'starting' | 'stopping';
  uptime: number;
  opportunitiesFound: number;
  tradesExecuted: number;
  totalProfit: number;
  lastCheck: string;
  scansCompleted?: number;
  persistent?: boolean;  // True if bot is saved to Supabase and will run 24/7
  source?: 'local' | 'supabase';  // Where the bot is running
}

// Aggregate stats across all bots
interface AggregateStats {
  totalBots: number;
  runningBots: number;
  totalScans: number;
  totalOpportunities: number;
  totalTrades: number;
  totalProfit: number;
  winRate: number;  // opportunities that turned into trades
  avgProfitPerTrade: number;
  totalUptime: number;  // combined uptime in seconds
}

// Bot session for multi-bot view
interface BotSession {
  botId: string;
  riftId: string;
  riftSymbol: string;
  status: 'stopped' | 'running' | 'starting' | 'stopping';
  uptime: number;
  stats: {
    opportunitiesFound: number;
    tradesExecuted: number;
    totalProfit: number;
    lastCheck: string;
    scansCompleted: number;
  };
  config: {
    minProfitBps: number;
    maxSlippageBps: number;
    maxTradeSize: number;
  };
  source: 'local' | 'supabase';
  persistent?: boolean;
  walletAddress?: string;  // The wallet that started this bot
  ownedByCurrentWallet?: boolean;  // True if current wallet owns this bot
}

interface LogEntry {
  timestamp: string;
  type: 'info' | 'opportunity' | 'trade' | 'error' | 'scan';
  message: string;
}

// Persisted stats from Supabase
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
    totalUptimeSeconds: number; // Now shows longest-running bot's uptime
    avgUptimeSeconds?: number;
    combinedUptimeSeconds?: number;
  };
  recentTrades: TradeRecord[];
  riftStats: RiftStatRecord[];
}

interface TradeRecord {
  id: number;
  riftId: string;
  rSymbol: string;
  direction: 'wrap' | 'unwrap';
  underlyingDex: string;
  tradeSizeSol: number;
  expectedProfitSol: number;
  actualProfitSol: number;
  expectedProfitBps: number;
  success: boolean;
  signature: string | null;
  errorMessage: string | null;
  executionTimeMs: number;
  createdAt: string;
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
  const wallet = useRealWallet();
  const router = useRouter();
  const [rifts, setRifts] = useState<RiftOption[]>([]);
  const [selectedRift, setSelectedRift] = useState<RiftOption | null>(null);
  const [selectedRifts, setSelectedRifts] = useState<Set<string>>(new Set()); // Multi-select
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [walletReady, setWalletReady] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showLogs, setShowLogs] = useState(true);
  const [showTrades, setShowTrades] = useState(true);
  const [customAddress, setCustomAddress] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showOnlyWithTvl, setShowOnlyWithTvl] = useState(false);
  const [showClaimsModal, setShowClaimsModal] = useState(false);
  const [claimsViewMode, setClaimsViewMode] = useState<'rift' | 'user' | 'referrals'>('rift');
  const [claimsData, setClaimsData] = useState<{
    totalEarned: number;
    totalClaimed: number;
    totalClaimable: number;
    riftCount: number;
    lpCount: number;
    riftBreakdown: {
      rift_id: string;
      rift_symbol: string;
      total_earned_sol: number;
      claimed_sol: number;
      claimable: number;
      lp_count: number;
    }[];
    earnings: {
      rift_id: string;
      rift_symbol: string;
      wallet_address: string;
      total_earned_sol: number;
      claimed_sol: number;
      claimable: number;
    }[];
    referrals?: {
      totalEarned: number;
      totalClaimed: number;
      totalClaimable: number;
      referrerCount: number;
      breakdown: {
        wallet: string;
        total_earned: number;
        total_claimed: number;
        claimable: number;
        earnings_count: number;
      }[];
    };
    grandTotal?: {
      earned: number;
      claimed: number;
      claimable: number;
    };
  } | null>(null);
  const [claimsLoading, setClaimsLoading] = useState(false);

  // Profit distribution state (admin only)
  const [profitDistribution, setProfitDistribution] = useState<{
    treasuryBalance: number;
    totalProfitSol: number;
    totalOwedSol: number;
    totalAlreadyPaidSol: number;
    totalToLpsTeams: number;
    totalToProtocol: number;
    rifts: {
      riftId: string;
      symbol: string;
      underlying: string;
      creator: string | null;
      isTeamRift: boolean;
      feesEnabled: boolean;
      lpSplit: number;
      totalProfitSol: number;
      totalOwedSol: number;
      alreadyPaidSol: number;
      remainingOwedSol: number;
      walletAddress: string | null;
    }[];
  } | null>(null);
  const [resetLoading, setResetLoading] = useState(false);
  const [distributionAmount, setDistributionAmount] = useState<string>('');
  const [distributionLoading, setDistributionLoading] = useState(false);
  const [distributionResult, setDistributionResult] = useState<{
    success: boolean;
    message: string;
    distributions?: { riftId: string; walletAddress: string; amount: number; signature?: string; error?: string }[];
  } | null>(null);

  // Creator/LP claim state
  const [claimableRifts, setClaimableRifts] = useState<{
    riftId: string;
    symbol: string;
    underlying: string;
    lpSplit: number;
    sharePct: number;
    claimableSol: number;
    // Team rift specific fields
    teamWalletAddress?: string;
    teamWalletBalance?: number;
    // LP rift specific fields (dedicated LP wallet)
    lpWalletAddress?: string;
    lpWalletBalance?: number;
    isTeamRift: boolean;
  }[]>([]);
  const [totalClaimable, setTotalClaimable] = useState(0);
  const [claimLoading, setClaimLoading] = useState<string | null>(null); // riftId being claimed
  const [claimResult, setClaimResult] = useState<{
    success: boolean;
    message: string;
    signature?: string;
  } | null>(null);

  // Persisted stats from Supabase (real bot data)
  const [persistedStats, setPersistedStats] = useState<PersistedStats | null>(null);
  const [solPrice, setSolPrice] = useState(230); // Default SOL price for USD conversion
  const [showProfitBreakdown, setShowProfitBreakdown] = useState(false); // Toggle for profit breakdown
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null); // Track which address was copied

  // Multi-bot management
  const [allBotSessions, setAllBotSessions] = useState<BotSession[]>([]);
  const [minTvlUsd, setMinTvlUsd] = useState(100); // Minimum TVL required to run a bot
  const [, setAggregateStats] = useState<AggregateStats>({
    totalBots: 0,
    runningBots: 0,
    totalScans: 0,
    totalOpportunities: 0,
    totalTrades: 0,
    totalProfit: 0,
    winRate: 0,
    avgProfitPerTrade: 0,
    totalUptime: 0,
  });

  // Wait for wallet to initialize (autoConnect takes a moment)
  useEffect(() => {
    // Check if we should wait for autoConnect
    const shouldAutoConnect = typeof window !== 'undefined' && localStorage.getItem('walletConnected') === 'true';

    if (shouldAutoConnect && !wallet.connected && !wallet.connecting) {
      // Give autoConnect time to kick in
      const timeout = setTimeout(() => setWalletReady(true), 1500);
      return () => clearTimeout(timeout);
    } else {
      setWalletReady(true);
    }
  }, [wallet.connected, wallet.connecting]);

  // Fetch persisted stats from Supabase
  useEffect(() => {
    async function fetchPersistedStats() {
      try {
        const response = await fetch('/api/arb-bot/stats');
        if (!response.ok) return;
        const data = await response.json();
        setPersistedStats(data);
      } catch (err) {
        console.error('Failed to fetch persisted stats:', err);
      }
    }

    async function fetchSolPrice() {
      try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        const data = await res.json();
        if (data.solana?.usd) {
          setSolPrice(data.solana.usd);
        }
      } catch {
        // Ignore - use default
      }
    }

    // Initial fetch
    fetchPersistedStats();
    fetchSolPrice();

    // Poll every 10 seconds
    const interval = setInterval(fetchPersistedStats, 10000);
    return () => clearInterval(interval);
  }, []);

  // Bot control state
  const [botStats, setBotStats] = useState<BotStats>({
    status: 'stopped',
    uptime: 0,
    opportunitiesFound: 0,
    tradesExecuted: 0,
    totalProfit: 0,
    lastCheck: '-',
    scansCompleted: 0,
    persistent: false,
    source: undefined
  });

  // Bot settings
  const [minProfitBps, setMinProfitBps] = useState(50); // 0.5%
  const [maxSlippageBps, setMaxSlippageBps] = useState(100); // 1%
  const [maxTradeSize, setMaxTradeSize] = useState(500); // $500 default, max $2500

  // Check for existing running sessions on load and calculate aggregate stats
  useEffect(() => {
    if (!wallet.connected || !wallet.publicKey) return;

    async function checkExistingSessions() {
      try {
        const response = await fetch(`/api/arb-bot?wallet=${wallet.publicKey}&action=list`);
        const data = await response.json();

        // Update minTvlUsd from API if provided
        if (data.minTvlUsd) {
          setMinTvlUsd(data.minTvlUsd);
        }

        if (data.sessions && data.sessions.length > 0) {
          // Store all sessions for multi-bot view
          setAllBotSessions(data.sessions);

          // Calculate aggregate stats across all bots
          const agg: AggregateStats = {
            totalBots: data.sessions.length,
            runningBots: data.sessions.filter((s: BotSession) => s.status === 'running').length,
            totalScans: 0,
            totalOpportunities: 0,
            totalTrades: 0,
            totalProfit: 0,
            winRate: 0,
            avgProfitPerTrade: 0,
            totalUptime: 0,
          };

          for (const session of data.sessions) {
            agg.totalScans += session.stats?.scansCompleted || 0;
            agg.totalOpportunities += session.stats?.opportunitiesFound || 0;
            agg.totalTrades += session.stats?.tradesExecuted || 0;
            agg.totalProfit += session.stats?.totalProfit || 0;
            if (session.status === 'running') {
              agg.totalUptime += session.uptime || 0;
            }
          }

          // Calculate derived stats
          agg.winRate = agg.totalOpportunities > 0
            ? (agg.totalTrades / agg.totalOpportunities) * 100
            : 0;
          agg.avgProfitPerTrade = agg.totalTrades > 0
            ? agg.totalProfit / agg.totalTrades
            : 0;

          setAggregateStats(agg);

          // Find running session (prefer local over supabase)
          const runningSession = data.sessions.find((s: BotSession) => s.status === 'running');
          if (runningSession) {
            // Restore session
            const matchingRift = rifts.find(r => r.id === runningSession.riftId);
            if (matchingRift) {
              setSelectedRift(matchingRift);
            }
            setBotStats({
              status: 'running',
              uptime: runningSession.uptime,
              opportunitiesFound: runningSession.stats?.opportunitiesFound || 0,
              tradesExecuted: runningSession.stats?.tradesExecuted || 0,
              totalProfit: runningSession.stats?.totalProfit || 0,
              lastCheck: runningSession.stats?.lastCheck || '-',
              scansCompleted: runningSession.stats?.scansCompleted || 0,
              persistent: runningSession.persistent || runningSession.source === 'supabase',
              source: runningSession.source || 'local'
            });
            setMinProfitBps(runningSession.config?.minProfitBps || 50);
            setMaxSlippageBps(runningSession.config?.maxSlippageBps || 100);
            setMaxTradeSize(runningSession.config?.maxTradeSize || 500);
          }
        }
      } catch {
        // Ignore errors
      }
    }

    if (rifts.length > 0) {
      checkExistingSessions();
    }
  }, [wallet.connected, wallet.publicKey, rifts]);

  // Check if wallet is allowed (admin always allowed, or if they have rifts to manage, or claimable profits)
  const walletAddress = wallet.publicKey || '';
  const canManageBot = walletAddress === ADMIN_WALLET || rifts.length > 0;
  const isAllowed = canManageBot || claimableRifts.length > 0 || loading;

  // Fetch available rifts (filtered by wallet permissions)
  useEffect(() => {
    async function fetchRifts() {
      try {
        setLoading(true);
        // Pass wallet address to filter rifts by permissions
        const walletParam = wallet.publicKey ? `&wallet=${wallet.publicKey}` : '';
        const response = await fetch(`/api/arb-config?action=list${walletParam}`);
        if (!response.ok) throw new Error('Failed to fetch rifts');
        const data = await response.json();
        setRifts(data.rifts || []);
        setIsAdmin(data.isAdmin || false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load rifts');
      } finally {
        setLoading(false);
      }
    }
    // Only fetch when wallet is connected
    if (wallet.connected && wallet.publicKey) {
      fetchRifts();
    }
  }, [wallet.connected, wallet.publicKey]);

  // Toggle rift selection for multi-bot
  const toggleRiftSelection = (riftId: string) => {
    setSelectedRifts(prev => {
      const next = new Set(prev);
      if (next.has(riftId)) {
        next.delete(riftId);
      } else {
        next.add(riftId);
      }
      return next;
    });
  };

  // Toggle team rift status (admin only)
  const toggleTeamRift = async (riftId: string, currentStatus: boolean) => {
    if (!isAdmin) return;

    try {
      const response = await fetch('/api/arb-profits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: wallet.publicKey,
          action: 'update-config',
          riftId,
          isTeamRift: !currentStatus,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update rift config');
      }

      const data = await response.json();

      // Update local state
      setRifts(prev => prev.map(r =>
        r.id === riftId ? { ...r, isTeamRift: !currentStatus, lpSplit: data.config?.lp_split || 40 } : r
      ));

      // Refresh profit distribution info
      await fetchProfitDistributionInfo();
    } catch (err) {
      console.error('Failed to toggle team rift:', err);
      setError(err instanceof Error ? err.message : 'Failed to update rift config');
    }
  };

  // Fetch profit distribution info (admin only)
  const fetchProfitDistributionInfo = async () => {
    if (!isAdmin || !wallet.publicKey) return;

    try {
      const response = await fetch(`/api/arb-profits?wallet=${wallet.publicKey}`);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to fetch profit info');
      }
      const data = await response.json();
      setProfitDistribution({
        treasuryBalance: data.treasuryBalance,
        totalProfitSol: data.totalProfitSol || 0,
        totalOwedSol: data.totalOwedSol || 0,
        totalAlreadyPaidSol: data.totalAlreadyPaidSol || 0,
        totalToLpsTeams: data.totalToLpsTeams || 0,
        totalToProtocol: data.totalToProtocol || 0,
        rifts: data.rifts || [],
      });
    } catch (err) {
      console.error('Failed to fetch profit distribution info:', err);
    }
  };

  // Fetch earnings data (admin only) - for teams, LPs, and referrals auto-claim system
  const fetchLpEarningsData = async () => {
    if (!isAdmin || !wallet.publicKey) return;

    setClaimsLoading(true);
    try {
      const response = await fetch(`/api/lp-earnings?wallet=${wallet.publicKey}`);
      if (!response.ok) {
        throw new Error('Failed to fetch earnings data');
      }
      const data = await response.json();
      setClaimsData({
        totalEarned: data.totalEarned || 0,
        totalClaimed: data.totalClaimed || 0,
        totalClaimable: data.totalClaimable || 0,
        riftCount: data.riftCount || 0,
        lpCount: data.lpCount || 0,
        riftBreakdown: data.riftBreakdown || [],
        earnings: data.earnings || [],
        referrals: data.referrals || undefined,
        grandTotal: data.grandTotal || undefined,
      });
    } catch (err) {
      console.error('Failed to fetch LP earnings:', err);
      setClaimsData(null);
    } finally {
      setClaimsLoading(false);
    }
  };

  // Open claims modal and fetch data
  const openClaimsModal = () => {
    setShowClaimsModal(true);
    fetchLpEarningsData();
  };

  // Reset all profit data (admin only)
  const resetProfitData = async () => {
    if (!isAdmin || !wallet.publicKey) return;
    if (!confirm('Are you sure you want to reset ALL profit data? This cannot be undone.')) return;

    setResetLoading(true);
    try {
      const response = await fetch('/api/arb-profits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: wallet.publicKey,
          action: 'reset-profits',
        }),
      });

      if (response.ok) {
        await fetchProfitDistributionInfo();
        alert('Profit data has been reset successfully');
      } else {
        const data = await response.json();
        alert(`Failed to reset: ${data.error}`);
      }
    } catch (err) {
      console.error('Failed to reset profit data:', err);
      alert('Failed to reset profit data');
    } finally {
      setResetLoading(false);
    }
  };

  // Toggle fees enabled for a rift (admin only)
  const toggleFeesEnabled = async (riftId: string, currentStatus: boolean) => {
    if (!isAdmin || !wallet.publicKey) return;

    try {
      const response = await fetch('/api/arb-profits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: wallet.publicKey,
          action: 'update-config',
          riftId,
          feesEnabled: !currentStatus,
        }),
      });

      if (response.ok) {
        await fetchProfitDistributionInfo();
      } else {
        const data = await response.json();
        setError(data.error || 'Failed to toggle fees');
      }
    } catch (err) {
      console.error('Failed to toggle fees:', err);
      setError('Failed to toggle fees');
    }
  };

  // Send profit distribution (admin only)
  const sendProfitDistribution = async () => {
    if (!isAdmin || !wallet.publicKey) return;

    const amount = parseFloat(distributionAmount);
    if (isNaN(amount) || amount <= 0) {
      setDistributionResult({ success: false, message: 'Please enter a valid amount' });
      return;
    }

    setDistributionLoading(true);
    setDistributionResult(null);

    try {
      const response = await fetch('/api/arb-profits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: wallet.publicKey,
          action: 'distribute',
          totalAmount: amount,
          recipientType: 'lp', // Only distribute to LPs, not teams
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to distribute profits');
      }

      setDistributionResult({
        success: true,
        message: `Successfully distributed ${data.totalDistributed.toFixed(4)} SOL to ${data.summary.lpDistributions} LP(s)`,
        distributions: data.distributions,
      });

      // Refresh the profit info
      await fetchProfitDistributionInfo();
      setDistributionAmount('');
    } catch (err) {
      setDistributionResult({
        success: false,
        message: err instanceof Error ? err.message : 'Failed to distribute profits',
      });
    } finally {
      setDistributionLoading(false);
    }
  };

  // Fetch claimable profits for creators
  const fetchClaimableInfo = async () => {
    if (!wallet.publicKey) return;

    try {
      const response = await fetch(`/api/arb-profits?wallet=${wallet.publicKey}&action=claim-info`);
      if (!response.ok) return;
      const data = await response.json();
      setClaimableRifts(data.claimableRifts || []);
      setTotalClaimable(data.totalClaimable || 0);
    } catch (err) {
      console.error('Failed to fetch claimable info:', err);
    }
  };

  // Claim profits from a team wallet
  const claimProfits = async (riftId: string) => {
    if (!wallet.publicKey) return;

    setClaimLoading(riftId);
    setClaimResult(null);

    try {
      const response = await fetch('/api/arb-profits', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: wallet.publicKey,
          riftId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to claim profits');
      }

      setClaimResult({
        success: true,
        message: `Successfully claimed ${data.amountClaimed.toFixed(4)} SOL`,
        signature: data.signature,
      });

      // Refresh claimable info
      await fetchClaimableInfo();
    } catch (err) {
      setClaimResult({
        success: false,
        message: err instanceof Error ? err.message : 'Failed to claim profits',
      });
    } finally {
      setClaimLoading(null);
    }
  };

  // Fetch profit distribution info when admin status changes
  useEffect(() => {
    if (isAdmin) {
      fetchProfitDistributionInfo();
    }
  }, [isAdmin, wallet.publicKey]);

  // Fetch claimable info for all connected wallets (creators and LPs)
  useEffect(() => {
    if (wallet.publicKey) {
      fetchClaimableInfo();
    }
  }, [wallet.publicKey]);

  // Update team rift profit split (admin only)
  const updateTeamSplit = async (riftId: string, teamSplit: number) => {
    if (!isAdmin) return;

    try {
      // Use arb-profits API which updates arb_rift_config (source of truth for profit distribution)
      const response = await fetch('/api/arb-profits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: wallet.publicKey,
          action: 'update-config',
          riftId,
          isTeamRift: true,
          lpSplit: teamSplit,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update team split');
      }

      const data = await response.json();

      // Update local state
      setRifts(prev => prev.map(r =>
        r.id === riftId ? { ...r, isTeamRift: true, teamSplit: data.config?.lp_split || teamSplit } : r
      ));

      // Refresh profit distribution to reflect the new split
      await fetchProfitDistributionInfo();
    } catch (err) {
      console.error('Failed to update team split:', err);
      setError(err instanceof Error ? err.message : 'Failed to update team split');
    }
  };

  // Check if a rift is running (by any wallet)
  const isRiftRunning = (riftId: string) => {
    return allBotSessions.some(s => s.riftId === riftId && s.status === 'running');
  };

  // Check if current wallet owns the running bot for a rift
  const isRiftOwnedByCurrentWallet = (riftId: string) => {
    const session = allBotSessions.find(s => s.riftId === riftId && s.status === 'running');
    return session?.ownedByCurrentWallet ?? false;
  };

  // Get the running session info for a rift
  const getRunningSession = (riftId: string) => {
    return allBotSessions.find(s => s.riftId === riftId && s.status === 'running');
  };

  const handleSelectRift = (rift: RiftOption) => {
    setSelectedRift(rift);
    const session = getRunningSession(rift.id);
    if (session) {
      // Load bot stats
      setBotStats({
        status: session.status,
        uptime: session.uptime,
        opportunitiesFound: session.stats?.opportunitiesFound || 0,
        tradesExecuted: session.stats?.tradesExecuted || 0,
        totalProfit: session.stats?.totalProfit || 0,
        lastCheck: session.stats?.lastCheck || '-',
        scansCompleted: session.stats?.scansCompleted || 0,
        persistent: session.persistent || session.source === 'supabase',
        source: session.source
      });
      // Load bot configuration - fixes bug where users see defaults instead of their saved config
      setMinProfitBps(session.config?.minProfitBps || 50);
      setMaxSlippageBps(session.config?.maxSlippageBps || 100);
      setMaxTradeSize(session.config?.maxTradeSize || 500);
    } else {
      setBotStats(prev => ({
        ...prev,
        status: 'stopped',
        uptime: 0,
        opportunitiesFound: 0,
        tradesExecuted: 0,
        totalProfit: 0,
        lastCheck: '-',
        scansCompleted: 0,
        persistent: false,
        source: undefined
      }));
    }
  };

  // Start a single rift bot
  const startRiftBot = async (rift: RiftOption) => {
    if (!wallet.publicKey) return;

    // Update session status
    setAllBotSessions(prev => {
      const exists = prev.find(s => s.riftId === rift.id);
      if (exists) {
        return prev.map(s => s.riftId === rift.id ? { ...s, status: 'starting' as const } : s);
      }
      return [...prev, {
        botId: `${wallet.publicKey}-${rift.id}`,
        riftId: rift.id,
        riftSymbol: rift.rSymbol,
        status: 'starting' as const,
        uptime: 0,
        stats: { opportunitiesFound: 0, tradesExecuted: 0, totalProfit: 0, lastCheck: '-', scansCompleted: 0 },
        config: { minProfitBps, maxSlippageBps, maxTradeSize },
        source: 'local'
      }];
    });

    try {
      const response = await fetch('/api/arb-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          walletAddress: wallet.publicKey,
          riftId: rift.id,
          riftSymbol: rift.rSymbol,
          config: { minProfitBps, maxSlippageBps, maxTradeSize }
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to start bot');
      }

      setAllBotSessions(prev => prev.map(s =>
        s.riftId === rift.id ? { ...s, status: 'running' as const, persistent: data.persistent } : s
      ));

      // Update aggregate stats - only increment runningBots, totalBots is derived from allBotSessions.length
      setAggregateStats(prev => ({
        ...prev,
        runningBots: prev.runningBots + 1
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start bot');
      setAllBotSessions(prev => prev.map(s =>
        s.riftId === rift.id ? { ...s, status: 'stopped' as const } : s
      ));
    }
  };

  // Stop a single rift bot
  const stopRiftBot = async (riftId: string) => {
    if (!wallet.publicKey) return;

    setAllBotSessions(prev => prev.map(s =>
      s.riftId === riftId ? { ...s, status: 'stopping' as const } : s
    ));

    try {
      const response = await fetch('/api/arb-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'stop',
          walletAddress: wallet.publicKey,
          riftId: riftId
        })
      });

      await response.json();

      setAllBotSessions(prev => prev.map(s =>
        s.riftId === riftId ? { ...s, status: 'stopped' as const } : s
      ));

      // Update aggregate stats
      setAggregateStats(prev => ({
        ...prev,
        runningBots: Math.max(0, prev.runningBots - 1)
      }));
    } catch {
      setAllBotSessions(prev => prev.map(s =>
        s.riftId === riftId ? { ...s, status: 'stopped' as const } : s
      ));
    }
  };

  // Start all selected rifts
  const startSelectedBots = async () => {
    if (selectedRifts.size === 0) return;
    setError(null);

    for (const riftId of selectedRifts) {
      const rift = rifts.find(r => r.id === riftId);
      if (rift && !isRiftRunning(riftId)) {
        await startRiftBot(rift);
      }
    }
  };

  // Stop all selected rifts
  const stopSelectedBots = async () => {
    for (const riftId of selectedRifts) {
      if (isRiftRunning(riftId)) {
        await stopRiftBot(riftId);
      }
    }
  };

  // Bot control functions (legacy - for single bot mode)
  const startBot = async () => {
    if (!selectedRift || !wallet.publicKey) return;

    setBotStats(prev => ({ ...prev, status: 'starting' }));
    setError(null);
    setLogs([]);

    try {
      const response = await fetch('/api/arb-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          walletAddress: wallet.publicKey,
          riftId: selectedRift.id,
          riftSymbol: selectedRift.rSymbol,
          config: { minProfitBps, maxSlippageBps, maxTradeSize }
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to start bot');
      }

      setBotStats({
        status: 'running',
        uptime: 0,
        opportunitiesFound: 0,
        tradesExecuted: 0,
        totalProfit: 0,
        lastCheck: new Date().toLocaleTimeString(),
        scansCompleted: 0,
        persistent: data.persistent || false,
        source: 'local'
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start bot');
      setBotStats(prev => ({ ...prev, status: 'stopped' }));
    }
  };

  const stopBot = async () => {
    if (!wallet.publicKey || !selectedRift) return;

    setBotStats(prev => ({ ...prev, status: 'stopping' }));

    try {
      const response = await fetch('/api/arb-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'stop',
          walletAddress: wallet.publicKey,
          riftId: selectedRift.id
        })
      });

      const data = await response.json();
      setBotStats(prev => ({
        ...prev,
        status: 'stopped',
        ...data.stats
      }));
      if (data.logs) {
        setLogs(data.logs);
      }
    } catch {
      setBotStats(prev => ({ ...prev, status: 'stopped' }));
    }
  };

  // Lookup rift by custom address
  const lookupRiftByAddress = async () => {
    if (!customAddress.trim() || !wallet.publicKey) return;

    setLookupLoading(true);
    setLookupError(null);

    try {
      const response = await fetch(
        `/api/arb-config?action=lookup&address=${encodeURIComponent(customAddress.trim())}&wallet=${wallet.publicKey}`
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Rift not found');
      }

      if (data.rift) {
        setSelectedRift(data.rift);
        setCustomAddress('');
      }
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : 'Failed to lookup rift');
    } finally {
      setLookupLoading(false);
    }
  };

  // Poll for bot status when running
  useEffect(() => {
    if (botStats.status !== 'running' || !wallet.publicKey || !selectedRift) return;

    const pollStatus = async () => {
      try {
        const response = await fetch(`/api/arb-bot?wallet=${wallet.publicKey}&riftId=${selectedRift.id}`);
        const data = await response.json();

        if (data.status === 'running') {
          const newStats = {
            opportunitiesFound: data.stats?.opportunitiesFound || 0,
            tradesExecuted: data.stats?.tradesExecuted || 0,
            totalProfit: data.stats?.totalProfit || 0,
            scansCompleted: data.stats?.scansCompleted || 0,
          };

          setBotStats(prev => ({
            ...prev,
            uptime: data.uptime || prev.uptime,
            ...newStats,
            lastCheck: new Date().toLocaleTimeString(),
            persistent: data.persistent || prev.persistent,
            source: data.source || prev.source
          }));

          // Also update aggregate stats in real-time
          setAggregateStats(prev => ({
            ...prev,
            totalScans: newStats.scansCompleted,
            totalOpportunities: newStats.opportunitiesFound,
            totalTrades: newStats.tradesExecuted,
            totalProfit: newStats.totalProfit,
            winRate: newStats.opportunitiesFound > 0 ? (newStats.tradesExecuted / newStats.opportunitiesFound) * 100 : 0,
            avgProfitPerTrade: newStats.tradesExecuted > 0 ? newStats.totalProfit / newStats.tradesExecuted : 0,
          }));

          // Update the session in allBotSessions too
          setAllBotSessions(prev => prev.map(s =>
            s.riftId === selectedRift.id
              ? { ...s, stats: { ...s.stats, ...newStats }, uptime: data.uptime || s.uptime }
              : s
          ));

          if (data.logs) {
            setLogs(data.logs);
          }
        } else if (data.status === 'stopped') {
          setBotStats(prev => ({ ...prev, status: 'stopped', persistent: false }));
          if (data.logs) {
            setLogs(data.logs);
          }
        }
      } catch {
        // Silent fail
      }
    };

    const interval = setInterval(pollStatus, 3000);
    return () => clearInterval(interval);
  }, [botStats.status, wallet.publicKey, selectedRift]);

  // Update uptime counter when bot is running
  useEffect(() => {
    if (botStats.status !== 'running') return;

    const interval = setInterval(() => {
      setBotStats(prev => ({
        ...prev,
        uptime: prev.uptime + 1,
        lastCheck: new Date().toLocaleTimeString()
      }));
    }, 1000);

    return () => clearInterval(interval);
  }, [botStats.status]);

  const formatUptime = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Copy address to clipboard with feedback
  const copyToClipboard = (address: string, key: string) => {
    navigator.clipboard.writeText(address);
    setCopiedAddress(key);
    setTimeout(() => setCopiedAddress(null), 2000);
  };

  const cumulative = persistedStats?.cumulative;
  const selectedRiftStats = useMemo(() => {
    if (!persistedStats || !selectedRift) return null;
    // Match by riftId only - symbol matching causes duplicate rifts with same symbol to share stats
    return persistedStats.riftStats?.find(
      (rs) => rs.riftId === selectedRift.id
    ) || null;
  }, [persistedStats, selectedRift]);

  // Filter trades by selected rift
  const selectedRiftTrades = useMemo(() => {
    if (!persistedStats?.recentTrades) return [];
    if (!selectedRift) return persistedStats.recentTrades.slice(0, 50); // Show all if none selected
    return persistedStats.recentTrades.filter(
      (trade) => trade.riftId === selectedRift.id
    );
  }, [persistedStats, selectedRift]);

  // Filter rifts based on search query and TVL toggle
  const filteredRifts = useMemo(() => {
    let result = rifts;

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      result = result.filter(rift =>
        rift.symbol.toLowerCase().includes(query) ||
        rift.rSymbol.toLowerCase().includes(query) ||
        rift.underlying.toLowerCase().includes(query) ||
        rift.riftMint.toLowerCase().includes(query) ||
        rift.underlyingMint.toLowerCase().includes(query) ||
        rift.id.toLowerCase().includes(query)
      );
    }

    // Filter by TVL if toggle is on
    if (showOnlyWithTvl) {
      result = result.filter(rift => rift.tvl >= minTvlUsd);
    }

    return result;
  }, [rifts, searchQuery, showOnlyWithTvl, minTvlUsd]);

  // Access denied screen - only show if connected but not allowed
  if (wallet.connected && !isAllowed) {
    return (
      <div className="min-h-screen bg-black text-white relative overflow-hidden">
        <div className="fixed inset-0 z-0">
          <RippleGrid
            gridColor="#ef4444"
            rippleIntensity={0.03}
            gridSize={12.0}
            gridThickness={12.0}
            fadeDistance={1.5}
            vignetteStrength={2.0}
            glowIntensity={0.1}
            opacity={0.4}
            mouseInteraction={true}
            mouseInteractionRadius={1.2}
          />
        </div>
        <div className="relative z-10 flex items-center justify-center min-h-screen">
          <div className="text-center p-8 rounded-xl bg-black/60 backdrop-blur-xl border border-red-500/20 max-w-md">
            <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center">
              <Lock className="w-8 h-8 text-red-400" />
            </div>
            <h2 className="text-2xl font-bold text-white mb-3">Access Restricted</h2>
            <p className="text-gray-400 mb-4">
              This tool is only available to authorized wallets.
            </p>
            <div className="px-4 py-2 rounded-lg bg-gray-900/50 border border-gray-800 mb-6">
              <p className="text-xs text-gray-500 mb-1">Connected Wallet</p>
              <p className="text-sm text-gray-300 font-mono truncate">{walletAddress}</p>
            </div>
            <button
              onClick={() => router.push('/dapp')}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-gray-800 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-600 transition-all"
            >
              <ChevronDown className="w-4 h-4 rotate-90" />
              Back to dApp
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex w-full min-h-screen text-white md:h-screen md:overflow-hidden">
      {/* Full Page RippleGrid Background */}
      <div className="fixed inset-0 z-10 bg-black">
        <RippleGrid
          enableRainbow={false}
          gridColor="#10b981"
          rippleIntensity={0.03}
          gridSize={18}
          gridThickness={6}
          mouseInteraction={true}
          mouseInteractionRadius={3.0}
          opacity={0.85}
          fadeDistance={2.5}
          vignetteStrength={2.5}
          glowIntensity={0.5}
        />
      </div>

      {/* Sidebar */}
      <div className="relative z-20">
        <DappSidebar
          wallet={{
            connected: wallet.connected,
            connecting: wallet.connecting,
            publicKey: wallet.publicKey,
            connect: () => wallet.connect(),
            disconnect: () => wallet.disconnect(),
          }}
        />
      </div>

      {/* Main Content Area */}
      <div className="relative z-20 flex flex-col flex-1 overflow-hidden">
        <div className="relative flex flex-col flex-1 p-3 md:p-6 overflow-y-auto">
          {/* Header */}
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <LuxuryButton
                variant="ghost"
                size="sm"
                onClick={() => router.push('/dapp')}
                icon={ChevronDown}
                className="[&_svg]:rotate-90"
              >
                Back
              </LuxuryButton>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30">
                  <Bot className="w-6 h-6 text-emerald-400" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-white">Arb Bot</h1>
                  <p className="text-sm text-gray-400">Automated arbitrage trading</p>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {botStats.status === 'running' && (
                <>
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                    <span className="text-sm text-emerald-400 font-medium">Running</span>
                  </div>
                  {botStats.persistent && (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/30" title="Bot will continue running even when you close this tab">
                      <Cloud className="w-4 h-4 text-blue-400" />
                      <span className="text-xs text-blue-400 font-medium">24/7</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Show loading while waiting for wallet to initialize */}
          {!walletReady || wallet.connecting ? (
            <div className="flex items-center justify-center flex-1">
              <LuxuryCard className="max-w-md py-16 px-8">
                <div className="flex flex-col items-center justify-center text-center">
                  <div className="w-20 h-20 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center mb-6">
                    <RefreshCw className="w-10 h-10 text-emerald-400 animate-spin" />
                  </div>
                  <h2 className="text-xl font-bold text-white mb-2">Loading...</h2>
                  <p className="text-gray-400 text-sm">Connecting to wallet...</p>
                </div>
              </LuxuryCard>
            </div>
          ) : !wallet.connected ? (
            <div className="flex items-center justify-center flex-1">
              <LuxuryCard className="max-w-md py-16 px-8">
                <div className="flex flex-col items-center justify-center text-center">
                  <div className="w-20 h-20 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center mb-6">
                    <Wallet className="w-10 h-10 text-emerald-400" />
                  </div>
                  <h2 className="text-xl font-bold text-white mb-2">Connect Wallet</h2>
                  <p className="text-gray-400 text-sm max-w-sm mb-6">
                    Connect your wallet to access the Arbitrage Bot.
                  </p>
                  <LuxuryButton
                    variant="primary"
                    size="lg"
                    onClick={() => wallet.connect()}
                    disabled={wallet.connecting}
                    loading={wallet.connecting}
                    icon={Wallet}
                  >
                    {wallet.connecting ? 'Connecting...' : 'Connect Wallet'}
                  </LuxuryButton>
                </div>
              </LuxuryCard>
            </div>
          ) : !canManageBot ? (
          /* LP-only view - compact style matching wrap/deposit modals */
          <div className="space-y-6">
            {/* Global Stats Bar */}
            {cumulative && (
              <LuxuryCard className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30">
                      <Bot className="w-5 h-5 text-emerald-400" />
                    </div>
                    <div>
                      <span className="text-white font-semibold">Arb Bot Performance</span>
                      {cumulative.activeSessions > 0 && (
                        <span className="ml-2 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-xs">
                          {cumulative.activeSessions} Active
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold text-emerald-400">{cumulative.totalProfitSol.toFixed(2)} SOL</div>
                    <div className="text-xs text-gray-400">${(cumulative.totalProfitSol * solPrice).toFixed(0)} profit</div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="p-3 rounded-lg bg-gray-900/50 border border-gray-800">
                    <div className="text-lg font-bold text-white">{cumulative.totalTrades}</div>
                    <div className="text-xs text-gray-500">Trades</div>
                  </div>
                  <div className="p-3 rounded-lg bg-gray-900/50 border border-gray-800">
                    <div className="text-lg font-bold text-cyan-400">{cumulative.opportunitiesDetected.toLocaleString()}</div>
                    <div className="text-xs text-gray-500">Opportunities</div>
                  </div>
                  <div className="p-3 rounded-lg bg-gray-900/50 border border-gray-800">
                    <div className="text-lg font-bold text-purple-400">{formatUptime(cumulative.totalUptimeSeconds)}</div>
                    <div className="text-xs text-gray-500">Uptime</div>
                  </div>
                </div>
              </LuxuryCard>
            )}

            {/* No Rift Access Message */}
            <LuxuryCard className="py-12 px-8">
              <div className="flex flex-col items-center justify-center text-center">
                <div className="w-16 h-16 rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center mb-4">
                  <Lock className="w-8 h-8 text-gray-500" />
                </div>
                <h3 className="text-lg font-bold text-white mb-2">No Rift Access</h3>
                <p className="text-gray-400 text-sm max-w-md mb-6">
                  You need to create a rift to access the Arb Bot and claim earnings.
                </p>
                <LuxuryButton
                  variant="primary"
                  size="md"
                  onClick={() => router.push('/dapp')}
                  icon={Zap}
                >
                  Create a Rift
                </LuxuryButton>
              </div>
            </LuxuryCard>
          </div>
          ) : (
          <div className="space-y-6">
            {/* Performance Summary */}
            <LuxuryCard className="p-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30">
                    <BarChart3 className="w-5 h-5 text-emerald-400" />
                  </div>
                  <div>
                    <span className="text-white font-semibold">Performance</span>
                    {cumulative?.activeSessions ? (
                      <span className="ml-2 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-xs">
                        {cumulative.activeSessions} Active
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xl font-bold text-emerald-400">{(cumulative?.totalProfitSol ?? 0).toFixed(2)} SOL</div>
                  <div className="text-xs text-gray-400">${((cumulative?.totalProfitSol ?? 0) * solPrice).toFixed(0)} profit</div>
                </div>
              </div>
              <div className="grid grid-cols-4 md:grid-cols-7 gap-2 text-center">
                <div className="p-2 rounded-lg bg-gray-900/50 border border-gray-800">
                  <div className="text-sm font-bold text-white">{cumulative?.totalTrades ?? 0}</div>
                  <div className="text-[10px] text-gray-500 uppercase">Trades</div>
                </div>
                <div className="p-2 rounded-lg bg-gray-900/50 border border-gray-800">
                  <div className="text-sm font-bold text-emerald-400">{cumulative?.successfulTrades ?? 0}</div>
                  <div className="text-[10px] text-gray-500 uppercase">Won</div>
                </div>
                <div className="p-2 rounded-lg bg-gray-900/50 border border-gray-800">
                  <div className="text-sm font-bold text-red-400">{cumulative?.failedTrades ?? 0}</div>
                  <div className="text-[10px] text-gray-500 uppercase">Lost</div>
                </div>
                <div className="p-2 rounded-lg bg-gray-900/50 border border-gray-800">
                  <div className="text-sm font-bold text-cyan-400">${((cumulative?.totalVolumeSol ?? 0) * solPrice / 1000).toFixed(0)}k</div>
                  <div className="text-[10px] text-gray-500 uppercase">Volume</div>
                </div>
                <div className="p-2 rounded-lg bg-gray-900/50 border border-gray-800">
                  <div className="text-sm font-bold text-yellow-400">{(cumulative?.winRate ?? 0).toFixed(0)}%</div>
                  <div className="text-[10px] text-gray-500 uppercase">Win Rate</div>
                </div>
                <div className="p-2 rounded-lg bg-gray-900/50 border border-gray-800">
                  <div className="text-sm font-bold text-orange-400">${((cumulative?.avgProfitPerTradeSol ?? 0) * solPrice).toFixed(1)}</div>
                  <div className="text-[10px] text-gray-500 uppercase">$/Trade</div>
                </div>
                <div className="p-2 rounded-lg bg-gray-900/50 border border-gray-800">
                  <div className="text-sm font-bold text-purple-400">{formatUptime(cumulative?.totalUptimeSeconds ?? 0)}</div>
                  <div className="text-[10px] text-gray-500 uppercase">Uptime</div>
                </div>
              </div>
            </LuxuryCard>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left Panel - Rift Selection & Settings */}
            <div className="lg:col-span-1 space-y-4">
              {/* Rift Selector */}
              <LuxuryCard className="relative z-30">
                <div className="px-4 py-3 border-b border-emerald-500/20 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/30">
                      <Zap className="w-4 h-4 text-emerald-400" />
                    </div>
                    <span className="text-sm font-semibold text-white">Select Tokens</span>
                  </div>
                  {selectedRifts.size > 0 && (
                    <span className="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full">
                      {selectedRifts.size} selected
                    </span>
                  )}
                </div>
                <div className="p-4">

                {/* Search and Filter Controls */}
                <div className="mb-3 space-y-2">
                  {/* Search Input */}
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search tokens..."
                      className="w-full pl-9 pr-3 py-2 rounded-lg bg-gray-800/80 border border-gray-700 text-white text-sm placeholder-gray-500 focus:border-emerald-500/50 focus:outline-none"
                    />
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                      >
                        ×
                      </button>
                    )}
                  </div>

                  {/* TVL Filter Toggle - Switch */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400">
                      {filteredRifts.length} of {rifts.length} tokens
                    </span>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs ${!showOnlyWithTvl ? 'text-white' : 'text-gray-500'}`}>All</span>
                      <Switch
                        checked={showOnlyWithTvl}
                        onCheckedChange={setShowOnlyWithTvl}
                      />
                      <span className={`text-xs ${showOnlyWithTvl ? 'text-emerald-400' : 'text-gray-500'}`}>TVL ≥ $100</span>
                    </div>
                  </div>
                </div>

                {loading ? (
                  <div className="flex items-center justify-center py-8">
                    <RefreshCw className="w-6 h-6 text-emerald-400 animate-spin" />
                  </div>
                ) : (
                  <div className="relative z-40">
                    {/* Multi-select rift list */}
                    <div className="max-h-64 overflow-y-auto rounded-lg bg-gray-900/80 border border-emerald-500/30">
                      {filteredRifts.length === 0 ? (
                        <div className="px-4 py-3 text-gray-400 text-sm">
                          {searchQuery ? 'No tokens match your search' : 'No rifts available'}
                        </div>
                      ) : (
                        filteredRifts.map((rift) => {
                          const running = isRiftRunning(rift.id);
                          const ownedByMe = isRiftOwnedByCurrentWallet(rift.id);
                          const runningSession = getRunningSession(rift.id);
                          const selected = selectedRifts.has(rift.id);
                          const lowTvl = rift.tvl < minTvlUsd;
                          return (
                            <div
                              key={rift.id}
                              className={`px-4 py-3 flex items-center gap-3 border-b border-gray-800 last:border-b-0 transition-colors cursor-pointer ${
                                selected ? 'bg-emerald-500/10' : lowTvl ? 'bg-red-500/5' : 'hover:bg-gray-800/50'
                              }`}
                              onClick={() => handleSelectRift(rift)}
                              role="button"
                              tabIndex={0}
                            >
                              {/* Checkbox */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!lowTvl) toggleRiftSelection(rift.id);
                                }}
                                disabled={lowTvl}
                                className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${
                                  selected
                                    ? 'bg-emerald-500 border-emerald-500'
                                    : lowTvl
                                      ? 'border-gray-700 opacity-50 cursor-not-allowed'
                                      : 'border-gray-600 hover:border-emerald-500/50'
                                }`}
                              >
                                {selected && (
                                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                  </svg>
                                )}
                              </button>

                              {/* Rift info */}
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center relative ${lowTvl ? 'bg-red-500/20' : 'bg-emerald-500/20'}`}>
                                <span className={`font-bold text-sm ${lowTvl ? 'text-red-400' : 'text-emerald-400'}`}>r</span>
                                {isAdmin && rift.isTeamRift && (
                                  <Star className="w-3 h-3 text-yellow-400 fill-yellow-400 absolute -top-1 -right-1" />
                                )}
                              </div>
                              <div className="flex-1">
                                <div className="text-white font-medium flex items-center gap-2">
                                  {rift.rSymbol}
                                  {isAdmin && rift.isTeamRift && (
                                    <select
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => {
                                        e.stopPropagation();
                                        updateTeamSplit(rift.id, parseInt(e.target.value));
                                      }}
                                      value={rift.teamSplit ?? 50}
                                      className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 border-none cursor-pointer appearance-none hover:bg-yellow-500/30 transition-colors"
                                      title={`Team: ${rift.teamSplit ?? 50}% | Us: ${100 - (rift.teamSplit ?? 50)}%`}
                                    >
                                      <option value={80} className="bg-gray-900 text-yellow-400">80/20</option>
                                      <option value={70} className="bg-gray-900 text-yellow-400">70/30</option>
                                      <option value={60} className="bg-gray-900 text-yellow-400">60/40</option>
                                      <option value={50} className="bg-gray-900 text-yellow-400">50/50</option>
                                      <option value={40} className="bg-gray-900 text-yellow-400">40/60</option>
                                      <option value={30} className="bg-gray-900 text-yellow-400">30/70</option>
                                      <option value={20} className="bg-gray-900 text-yellow-400">20/80</option>
                                    </select>
                                  )}
                                  {running && (
                                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" title={ownedByMe ? "Bot running (yours)" : "Bot running (other wallet)"} />
                                  )}
                                  {running && !ownedByMe && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400" title={`Running by ${runningSession?.walletAddress?.slice(0,4)}...${runningSession?.walletAddress?.slice(-4)}`}>
                                      Other
                                    </span>
                                  )}
                                  {lowTvl && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400" title={`TVL $${rift.tvl.toFixed(0)} below $${minTvlUsd} minimum`}>
                                      Low TVL
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-gray-400">{rift.underlying}</div>
                              </div>

                              {/* TVL & per-rift controls */}
                              <div className="flex items-center gap-2">
                                <div className={`text-xs mr-2 ${lowTvl ? 'text-red-400' : 'text-emerald-400'}`}>
                                  ${rift.tvl >= 1000 ? `${(rift.tvl / 1000).toFixed(1)}k` : rift.tvl.toFixed(0)}
                                </div>
                                {running ? (
                                  ownedByMe ? (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        stopRiftBot(rift.id);
                                      }}
                                      className="px-2 py-1 text-xs rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                                      title="Stop bot"
                                    >
                                      Stop
                                    </button>
                                  ) : (
                                    <span className="px-2 py-1 text-xs rounded bg-gray-500/20 text-gray-400" title={`Running by ${runningSession?.walletAddress?.slice(0,4)}...${runningSession?.walletAddress?.slice(-4)}`}>
                                      Running
                                    </span>
                                  )
                                ) : lowTvl ? (
                                  <span className="px-2 py-1 text-xs rounded bg-red-500/10 text-red-400/70" title={`TVL must be at least $${minTvlUsd}`}>
                                    Min $100
                                  </span>
                                ) : (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      startRiftBot(rift);
                                    }}
                                    disabled={!wallet.publicKey}
                                    className="px-2 py-1 text-xs rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
                                    title="Start bot"
                                  >
                                    Start
                                  </button>
                                )}
                                {/* Admin-only team rift toggle */}
                                {isAdmin && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleTeamRift(rift.id, rift.isTeamRift || false);
                                    }}
                                    className={`p-1 rounded transition-colors ${
                                      rift.isTeamRift
                                        ? 'text-yellow-400 hover:text-yellow-300'
                                        : 'text-gray-500 hover:text-yellow-400'
                                    }`}
                                    title={rift.isTeamRift ? 'Remove from team rifts' : 'Add to team rifts'}
                                  >
                                    <Star className={`w-4 h-4 ${rift.isTeamRift ? 'fill-yellow-400' : ''}`} />
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    {/* Bulk action buttons */}
                    {selectedRifts.size > 0 && (
                      <div className="mt-3 flex gap-2">
                        <button
                          onClick={startSelectedBots}
                          disabled={!wallet.publicKey}
                          className="flex-1 px-3 py-2 text-sm rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
                        >
                          Start Selected ({selectedRifts.size})
                        </button>
                        <button
                          onClick={stopSelectedBots}
                          className="flex-1 px-3 py-2 text-sm rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                        >
                          Stop Selected
                        </button>
                      </div>
                    )}

                    {/* Custom Address Input */}
                    <div className="mt-4 pt-4 border-t border-gray-800">
                      <label className="text-xs text-gray-500 mb-2 block">Or enter rift contract address:</label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={customAddress}
                          onChange={(e) => {
                            setCustomAddress(e.target.value);
                            setLookupError(null);
                          }}
                          onKeyDown={(e) => e.key === 'Enter' && lookupRiftByAddress()}
                          placeholder="Rift address, token mint, or underlying mint..."
                          disabled={lookupLoading}
                          className="flex-1 px-3 py-2 rounded-lg bg-gray-800/80 border border-gray-700 text-white text-sm placeholder-gray-500 focus:border-emerald-500/50 focus:outline-none disabled:opacity-50"
                        />
                        <button
                          onClick={lookupRiftByAddress}
                          disabled={!customAddress.trim() || lookupLoading}
                          className="px-3 py-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {lookupLoading ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : (
                            <Search className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                      {lookupError && (
                        <p className="mt-2 text-xs text-red-400">{lookupError}</p>
                      )}
                    </div>
                  </div>
                )}
                </div>
              </LuxuryCard>

              {/* Bot Settings */}
              <LuxuryCard>
                <div className="px-4 py-3 border-b border-emerald-500/20 flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-cyan-500/20 border border-cyan-500/30">
                    <Settings className="w-4 h-4 text-cyan-400" />
                  </div>
                  <span className="text-sm font-semibold text-white">Bot Settings</span>
                </div>
                <div className="p-4 space-y-3">
                  <div>
                    <label className="text-xs text-gray-400 mb-1.5 block">Min Profit (after fees)</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="10"
                        max="200"
                        value={minProfitBps}
                        onChange={(e) => setMinProfitBps(Number(e.target.value))}
                        className="flex-1 accent-emerald-500 h-1.5"
                      />
                      <span className="text-white font-mono text-xs w-12 text-right bg-black/40 px-1.5 py-0.5 rounded">{(minProfitBps / 100).toFixed(2)}%</span>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-gray-400 mb-1.5 block">Max Slippage</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="50"
                        max="300"
                        value={maxSlippageBps}
                        onChange={(e) => setMaxSlippageBps(Number(e.target.value))}
                        className="flex-1 accent-emerald-500 h-1.5"
                      />
                      <span className="text-white font-mono text-xs w-12 text-right bg-black/40 px-1.5 py-0.5 rounded">{(maxSlippageBps / 100).toFixed(2)}%</span>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-gray-400 mb-1.5 block">Max Trade Size</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="100"
                        max="2500"
                        step="100"
                        value={maxTradeSize}
                        onChange={(e) => setMaxTradeSize(Number(e.target.value))}
                        className="flex-1 accent-emerald-500 h-1.5"
                      />
                      <span className="text-white font-mono text-xs w-14 text-right bg-black/40 px-1.5 py-0.5 rounded">${maxTradeSize.toLocaleString()}</span>
                    </div>
                    <p className="text-[10px] text-gray-500 mt-1">Maximum: $2,500 per trade</p>
                  </div>

                  {allBotSessions.some(s => s.status === 'running') && (
                    <p className="text-[10px] text-yellow-400/80 mt-1.5 px-2 py-1 rounded bg-yellow-500/10">
                      Settings apply to newly started bots only
                    </p>
                  )}
                </div>
              </LuxuryCard>

              {/* Profit Distribution (Admin Only) */}
              {isAdmin && (
                <LuxuryCard className="border-yellow-500/30">
                  <div className="px-4 py-3 border-b border-yellow-500/20 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 rounded-lg bg-yellow-500/20 border border-yellow-500/30">
                        <Send className="w-4 h-4 text-yellow-400" />
                      </div>
                      <span className="text-sm font-semibold text-white">Profit Distribution</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={openClaimsModal}
                        className="text-xs px-2 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors"
                      >
                        View Claims
                      </button>
                      <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400">Admin</span>
                    </div>
                  </div>
                  <div className="p-4">

                  {/* Treasury & Totals Info */}
                  {profitDistribution && (
                    <div className="mb-3 p-2.5 rounded-lg bg-black/40 border border-gray-800/50 space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-gray-400">Treasury Balance</span>
                        <div className="text-right">
                          <span className="text-lg font-bold text-emerald-400">
                            {profitDistribution.treasuryBalance.toFixed(4)} SOL
                          </span>
                          <span className="text-xs text-gray-500 ml-2">
                            (${(profitDistribution.treasuryBalance * solPrice).toFixed(2)})
                          </span>
                        </div>
                      </div>

                      {/* Total Arb Profits */}
                      <div
                        className="flex justify-between items-center cursor-pointer hover:bg-gray-800/50 rounded -mx-2 px-2 py-1 transition-colors"
                        onClick={() => setShowProfitBreakdown(!showProfitBreakdown)}
                      >
                        <div className="flex items-center gap-2">
                          <ChevronDown className={`w-4 h-4 text-white transition-transform ${showProfitBreakdown ? 'rotate-180' : ''}`} />
                          <span className="text-sm text-gray-400">Total Arb Profits</span>
                        </div>
                        <div className="text-right">
                          <span className="text-sm text-white font-semibold">
                            {profitDistribution.totalProfitSol.toFixed(4)} SOL
                          </span>
                          <span className="text-xs text-gray-500 ml-2">
                            (${(profitDistribution.totalProfitSol * solPrice).toFixed(2)})
                          </span>
                        </div>
                      </div>

                      {/* Split Breakdown */}
                      <div className="pl-6 space-y-1 text-xs border-l-2 border-gray-700 ml-2">
                        <div className="flex justify-between items-center">
                          <span className="text-gray-500">LPs/Teams Share</span>
                          <span className="text-yellow-400">
                            {(profitDistribution.totalToLpsTeams ?? 0).toFixed(4)} SOL
                            <span className="text-gray-600 ml-1">
                              (${((profitDistribution.totalToLpsTeams ?? 0) * solPrice).toFixed(2)})
                            </span>
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-gray-500">Protocol Revenue</span>
                          <span className="text-emerald-400">
                            {(profitDistribution.totalToProtocol ?? 0).toFixed(4)} SOL
                            <span className="text-gray-600 ml-1">
                              (${((profitDistribution.totalToProtocol ?? 0) * solPrice).toFixed(2)})
                            </span>
                          </span>
                        </div>
                      </div>

                      {/* Already Paid to LPs/Teams */}
                      {profitDistribution.totalAlreadyPaidSol > 0 && (
                        <div className="flex justify-between items-center pl-6 text-xs">
                          <span className="text-gray-500">Already Paid (LPs/Teams)</span>
                          <span className="text-emerald-400">
                            -{profitDistribution.totalAlreadyPaidSol.toFixed(4)} SOL
                          </span>
                        </div>
                      )}

                      {/* Remaining Owed */}
                      <div className="flex justify-between items-center border-t border-gray-700 pt-2">
                        <span className="text-sm text-yellow-400 font-semibold">Remaining Owed (LPs/Teams)</span>
                        <div className="text-right">
                          <span className="text-lg font-bold text-yellow-400">
                            {profitDistribution.totalOwedSol.toFixed(4)} SOL
                          </span>
                          <span className="text-xs text-yellow-400/70 ml-2">
                            (${(profitDistribution.totalOwedSol * solPrice).toFixed(2)})
                          </span>
                        </div>
                      </div>

                      {/* Detailed Breakdown Dropdown */}
                      {showProfitBreakdown && (
                        <div className="mt-2 pt-2 border-t border-gray-700/50 space-y-1 max-h-64 overflow-y-auto">
                          <div className="text-xs text-gray-500 mb-2">Toggle fees per rift:</div>
                          {profitDistribution.rifts
                            .filter(r => r.totalProfitSol > 0)
                            .sort((a, b) => b.totalProfitSol - a.totalProfitSol)
                            .map((rift) => {
                              const lpOwed = rift.feesEnabled ? rift.totalProfitSol * (rift.lpSplit / 100) : 0;
                              const usOwed = rift.feesEnabled ? rift.totalProfitSol * ((100 - rift.lpSplit) / 100) : rift.totalProfitSol;
                              return (
                                <div key={rift.riftId} className={`p-2 rounded transition-colors ${rift.feesEnabled ? 'bg-gray-800/30 hover:bg-gray-800/50' : 'bg-gray-800/10 opacity-60'}`}>
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                      <Switch
                                        checked={rift.feesEnabled}
                                        onCheckedChange={() => toggleFeesEnabled(rift.riftId, rift.feesEnabled)}
                                        className="scale-75"
                                      />
                                      <span className="text-xs text-white font-medium">{rift.symbol}</span>
                                      {rift.feesEnabled && (
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${rift.isTeamRift ? 'bg-yellow-500/20 text-yellow-400' : 'bg-emerald-500/20 text-emerald-400'}`}>
                                          {rift.isTeamRift ? 'Team' : 'Fee'} {rift.lpSplit}%
                                        </span>
                                      )}
                                      {!rift.feesEnabled && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-500/20 text-gray-400">
                                          Disabled
                                        </span>
                                      )}
                                    </div>
                                    <span className="text-xs text-white font-semibold">
                                      {rift.totalProfitSol.toFixed(4)} SOL
                                    </span>
                                  </div>
                                  {rift.feesEnabled && rift.totalProfitSol > 0 && (
                                    <div className="mt-1 pl-8 grid grid-cols-2 gap-x-4 text-[10px]">
                                      <div className="flex justify-between">
                                        <span className="text-gray-500">{rift.isTeamRift ? 'Team' : 'LPs'} ({rift.lpSplit}%):</span>
                                        <span className="text-yellow-400">{lpOwed.toFixed(4)}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-gray-500">Protocol ({100 - rift.lpSplit}%):</span>
                                        <span className="text-emerald-400">{usOwed.toFixed(4)}</span>
                                      </div>
                                      {rift.alreadyPaidSol > 0 && (
                                        <div className="flex justify-between col-span-2 mt-0.5">
                                          <span className="text-gray-500">Already Paid:</span>
                                          <span className="text-emerald-400">-{rift.alreadyPaidSol.toFixed(4)}</span>
                                        </div>
                                      )}
                                      {rift.remainingOwedSol > 0.0001 && (
                                        <div className="flex justify-between col-span-2 mt-0.5 pt-0.5 border-t border-gray-700/30">
                                          <span className="text-yellow-400 font-medium">Still Owed:</span>
                                          <span className="text-yellow-400 font-medium">{rift.remainingOwedSol.toFixed(4)}</span>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          {profitDistribution.rifts.filter(r => r.totalProfitSol > 0).length === 0 && (
                            <div className="text-xs text-gray-500 text-center py-2">No rifts with profits yet</div>
                          )}
                        </div>
                      )}

                      {/* Reset Button */}
                      <div className="flex justify-between items-center pt-2 border-t border-gray-700">
                        <span className="text-[10px] text-gray-600">SOL: ${solPrice.toFixed(2)}</span>
                        <button
                          onClick={resetProfitData}
                          disabled={resetLoading}
                          className="text-[10px] px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
                        >
                          {resetLoading ? 'Resetting...' : 'Reset All Profits'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Rifts List (Team rifts with profits) */}
                  {profitDistribution && profitDistribution.rifts.filter(r => r.isTeamRift && r.totalProfitSol > 0).length > 0 && (
                    <div className="mb-4 space-y-2 max-h-48 overflow-y-auto">
                      {profitDistribution.rifts.filter(r => r.isTeamRift && r.totalProfitSol > 0).map((tr) => (
                        <div key={tr.riftId} className="p-2 rounded bg-gray-800/50 space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <div className="flex items-center gap-2">
                              <Star className="w-3 h-3 text-yellow-400 fill-yellow-400" />
                              <span className="text-white font-medium">{tr.symbol || tr.underlying}</span>
                              <span className="text-gray-500">({tr.lpSplit}% split)</span>
                            </div>
                            {tr.walletAddress ? (
                              <span className="text-gray-500 font-mono" title={tr.walletAddress}>
                                {tr.walletAddress.slice(0, 4)}...{tr.walletAddress.slice(-4)}
                              </span>
                            ) : (
                              <span className="text-gray-500 italic">no wallet yet</span>
                            )}
                          </div>
                          <div className="flex items-center justify-between text-xs pl-5">
                            <span className="text-gray-400">
                              Profit: <span className="text-white">{tr.totalProfitSol.toFixed(4)} SOL</span>
                            </span>
                            {tr.alreadyPaidSol > 0 ? (
                              <span className="text-emerald-400">
                                Paid: {tr.alreadyPaidSol.toFixed(4)} SOL
                              </span>
                            ) : (
                              <span className="text-yellow-400 font-semibold">
                                Owed: {tr.remainingOwedSol.toFixed(4)} SOL
                              </span>
                            )}
                          </div>
                          {tr.alreadyPaidSol > 0 && tr.remainingOwedSol > 0.0001 && (
                            <div className="flex items-center justify-end text-xs pl-5">
                              <span className="text-yellow-400">
                                Still owed: {tr.remainingOwedSol.toFixed(4)} SOL
                              </span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Pay All Owed Button */}
                  {profitDistribution && profitDistribution.totalOwedSol > 0 && (
                    <div className="space-y-3">
                      <button
                        onClick={() => {
                          setDistributionAmount(profitDistribution.totalOwedSol.toFixed(4));
                        }}
                        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-yellow-500 text-black hover:bg-yellow-400 transition-all font-bold"
                      >
                        <Send className="w-4 h-4" />
                        Pay All Owed ({profitDistribution.totalOwedSol.toFixed(4)} SOL)
                      </button>
                      <p className="text-xs text-gray-500 text-center">
                        Or enter a custom amount below
                      </p>
                    </div>
                  )}

                  {/* Distribution Amount Input */}
                  <div className="space-y-3">
                    <div>
                      <label className="text-sm text-gray-400 mb-2 block">Custom Amount to Distribute (SOL)</label>
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        value={distributionAmount}
                        onChange={(e) => setDistributionAmount(e.target.value)}
                        placeholder="0.00"
                        className="w-full px-3 py-2 rounded-lg bg-gray-800/80 border border-gray-700 text-white placeholder-gray-500 focus:border-yellow-500/50 focus:outline-none"
                        disabled={distributionLoading}
                      />
                    </div>

                    {/* Distribution Preview */}
                    {profitDistribution && profitDistribution.rifts.filter(r => r.isTeamRift && r.remainingOwedSol > 0.0001).length > 0 && parseFloat(distributionAmount) > 0 && (
                      <div className="p-3 rounded-lg bg-gray-900/50 border border-yellow-500/20">
                        <div className="text-xs text-gray-400 mb-2">Distribution Preview:</div>
                        <div className="space-y-1.5">
                          {profitDistribution.rifts.filter(r => r.isTeamRift && r.remainingOwedSol > 0.0001).map((tr) => {
                            // Each team gets their proportional share based on what they're owed
                            const teamShare = profitDistribution.totalOwedSol > 0
                              ? (tr.remainingOwedSol / profitDistribution.totalOwedSol) * parseFloat(distributionAmount)
                              : parseFloat(distributionAmount) / profitDistribution.rifts.filter(r => r.isTeamRift).length;
                            return (
                              <div key={tr.riftId} className="flex items-center justify-between text-xs">
                                <span className="text-white">{tr.symbol || tr.underlying}</span>
                                <span className="text-yellow-400 font-mono">{teamShare.toFixed(4)} SOL</span>
                              </div>
                            );
                          })}
                          <div className="border-t border-gray-700 pt-1.5 mt-1.5 flex items-center justify-between text-sm font-semibold">
                            <span className="text-gray-300">Total to Send</span>
                            <span className="text-yellow-400 font-mono">
                              {parseFloat(distributionAmount).toFixed(4)} SOL
                            </span>
                          </div>
                        </div>
                      </div>
                    )}

                    <button
                      onClick={sendProfitDistribution}
                      disabled={distributionLoading || !distributionAmount || parseFloat(distributionAmount) <= 0}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-yellow-500/20 border border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed font-semibold"
                    >
                      {distributionLoading ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          Sending...
                        </>
                      ) : (
                        <>
                          <Send className="w-4 h-4" />
                          Send Custom Amount
                        </>
                      )}
                    </button>
                  </div>

                  {/* Distribution Result */}
                  {distributionResult && (
                    <div className={`mt-4 p-3 rounded-lg ${
                      distributionResult.success
                        ? 'bg-emerald-500/10 border border-emerald-500/30'
                        : 'bg-red-500/10 border border-red-500/30'
                    }`}>
                      <p className={`text-sm ${distributionResult.success ? 'text-emerald-400' : 'text-red-400'}`}>
                        {distributionResult.message}
                      </p>
                      {distributionResult.distributions && distributionResult.distributions.length > 0 && (
                        <div className="mt-2 space-y-1 max-h-24 overflow-y-auto">
                          {distributionResult.distributions.map((d, idx) => (
                            <div key={idx} className="flex items-center justify-between text-xs">
                              <span className="text-gray-400 font-mono">
                                {d.walletAddress.slice(0, 4)}...{d.walletAddress.slice(-4)}
                              </span>
                              {d.signature ? (
                                <span className="text-emerald-400">{d.amount.toFixed(4)} SOL ✓</span>
                              ) : (
                                <span className="text-red-400">{d.error || 'Failed'}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Refresh Button */}
                  <LuxuryButton
                    variant="ghost"
                    size="sm"
                    onClick={fetchProfitDistributionInfo}
                    icon={RefreshCw}
                    fullWidth
                    className="mt-3"
                  >
                    Refresh
                  </LuxuryButton>
                  </div>
                </LuxuryCard>
              )}

              {/* Claim Profits (Creator or LP) - Only show if user has bots */}
              {rifts.length > 0 && claimableRifts.length > 0 && (
                <LuxuryCard>
                  <div className="px-4 py-3 border-b border-emerald-500/20 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/30">
                        <DollarSign className="w-4 h-4 text-emerald-400" />
                      </div>
                      <span className="text-sm font-semibold text-white">Claim Profits</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-bold text-emerald-400">{totalClaimable.toFixed(4)} SOL</span>
                      <span className="text-xs text-gray-500">(${(totalClaimable * solPrice).toFixed(2)})</span>
                    </div>
                  </div>
                  <div className="p-4">

                  {/* Claimable Rifts */}
                  <div className="space-y-2">
                    {claimableRifts.map((rift) => (
                      <div key={rift.riftId} className="p-2.5 rounded-lg bg-black/40 border border-gray-800/50 hover:bg-white/[0.02] transition-colors">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-emerald-500/30 to-cyan-500/30 flex items-center justify-center border border-emerald-500/40">
                              <span className="font-bold text-xs text-emerald-400">r</span>
                            </div>
                            <div>
                              <div className="text-white font-medium text-sm">{rift.symbol || rift.underlying}</div>
                              <div className="text-[10px] text-gray-500">
                                {rift.isTeamRift ? `${rift.lpSplit}% team split` : `${rift.sharePct.toFixed(1)}% LP share`}
                              </div>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-emerald-400 font-bold text-sm">
                              {rift.claimableSol.toFixed(4)} SOL
                            </div>
                            <div className="text-[10px] text-gray-500">
                              ${(rift.claimableSol * solPrice).toFixed(2)}
                            </div>
                          </div>
                        </div>

                        {rift.isTeamRift && rift.teamWalletAddress && (
                          <div className="flex items-center justify-between text-[10px] text-gray-400 mb-2">
                            <span>Team Wallet:</span>
                            <span className="font-mono">
                              {rift.teamWalletAddress.slice(0, 6)}...{rift.teamWalletAddress.slice(-4)}
                            </span>
                          </div>
                        )}

                        {!rift.isTeamRift && rift.lpWalletAddress && (
                          <div className="flex items-center justify-between text-[10px] text-gray-400 mb-2">
                            <span>Claim Wallet:</span>
                            <span className="font-mono">
                              {rift.lpWalletAddress.slice(0, 6)}...{rift.lpWalletAddress.slice(-4)}
                            </span>
                          </div>
                        )}

                        <button
                          onClick={() => claimProfits(rift.riftId)}
                          disabled={claimLoading === rift.riftId || rift.claimableSol <= 0.001}
                          className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500 text-black text-xs font-semibold hover:bg-emerald-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {claimLoading === rift.riftId ? (
                            <>
                              <RefreshCw className="w-3 h-3 animate-spin" />
                              Claiming...
                            </>
                          ) : rift.claimableSol <= 0.001 ? (
                            'Nothing to claim'
                          ) : (
                            <>
                              <Send className="w-3 h-3" />
                              Claim {rift.claimableSol.toFixed(4)} SOL
                            </>
                          )}
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Claim Result */}
                  {claimResult && (
                    <div className={`mt-3 p-2 rounded-lg text-xs ${
                      claimResult.success
                        ? 'bg-emerald-500/10 border border-emerald-500/30'
                        : 'bg-red-500/10 border border-red-500/30'
                    }`}>
                      <p className={claimResult.success ? 'text-emerald-400' : 'text-red-400'}>
                        {claimResult.message}
                      </p>
                      {claimResult.signature && (
                        <a
                          href={`https://solscan.io/tx/${claimResult.signature}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-blue-400 hover:underline mt-1 block"
                        >
                          View →
                        </a>
                      )}
                    </div>
                  )}

                  {/* Refresh Button */}
                  <LuxuryButton
                    variant="ghost"
                    size="sm"
                    onClick={fetchClaimableInfo}
                    icon={RefreshCw}
                    fullWidth
                    className="mt-3"
                  >
                    Refresh
                  </LuxuryButton>
                  </div>
                </LuxuryCard>
              )}

              {/* Token Info */}
              {selectedRift && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                <LuxuryCard className="border-purple-500/30">
                  <div className="px-4 py-3 border-b border-purple-500/20 flex items-center gap-2">
                    <div className="p-1.5 rounded-lg bg-purple-500/20 border border-purple-500/30">
                      <Info className="w-4 h-4 text-purple-400" />
                    </div>
                    <span className="text-sm font-semibold text-white">Token Info</span>
                  </div>
                  <div className="p-4 space-y-2">
                    <div className="flex justify-between items-center py-1.5 px-2 rounded bg-black/40 text-xs">
                      <span className="text-gray-400">Wrap Fee</span>
                      <span className="text-white font-mono">{(selectedRift.wrapFeeBps / 100).toFixed(2)}%</span>
                    </div>
                    <div className="flex justify-between items-center py-1.5 px-2 rounded bg-black/40 text-xs">
                      <span className="text-gray-400">Unwrap Fee</span>
                      <span className="text-white font-mono">{(selectedRift.unwrapFeeBps / 100).toFixed(2)}%</span>
                    </div>
                    <div className="flex justify-between items-center py-1.5 px-2 rounded bg-black/40 text-xs">
                      <span className="text-gray-400">Transfer Fee</span>
                      <span className="text-white font-mono">{(selectedRift.transferFeeBps / 100).toFixed(2)}%</span>
                    </div>
                    <div className="flex justify-between items-center py-1.5 px-2 rounded bg-black/40 text-xs">
                      <span className="text-gray-400">Pools</span>
                      <span className="text-emerald-400 font-mono">{selectedRift.meteoraPools.length}</span>
                    </div>
                  </div>
                </LuxuryCard>
                </motion.div>
              )}
            </div>

            {/* Right Panel - Bot Control & Stats */}
            <div className="lg:col-span-2 space-y-4">
              {/* Bot Control */}
              <LuxuryCard>
                <div className="px-4 py-3 border-b border-emerald-500/20 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="p-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30">
                      <Bot className="w-5 h-5 text-emerald-400" />
                    </div>
                    <span className="text-sm font-semibold text-white">Bot Control</span>
                    {botStats.persistent && (
                      <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20" title="Synced to cloud - runs 24/7">
                        <Cloud className="w-3 h-3 text-blue-400" />
                        <span className="text-[9px] text-blue-400">24/7</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                      botStats.status === 'running' ? 'bg-emerald-500/20 text-emerald-400' :
                      botStats.status === 'starting' ? 'bg-yellow-500/20 text-yellow-400' :
                      botStats.status === 'stopping' ? 'bg-orange-500/20 text-orange-400' :
                      'bg-gray-500/20 text-gray-400'
                    }`}>
                      {botStats.status.toUpperCase()}
                    </span>
                  </div>
                </div>

                <div className="p-4">
                  {error && (
                    <div className="mb-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 text-red-400" />
                      <span className="text-red-400 text-xs">{error}</span>
                    </div>
                  )}

                  {!selectedRift ? (
                    <div className="py-8 text-center">
                      <Bot className="w-12 h-12 mx-auto text-emerald-500/30 mb-3" />
                      <h3 className="text-base font-semibold text-white mb-1">Select a Token</h3>
                      <p className="text-gray-400 text-xs max-w-sm mx-auto">
                        Choose a rift token from the list to start the arbitrage bot.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {/* Selected Rift Info */}
                      <div className="rounded-lg bg-black/40 border border-gray-800/50 p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500/30 to-cyan-500/30 flex items-center justify-center border border-emerald-500/40">
                            <span className="font-bold text-sm text-emerald-400">
                              {selectedRift.symbol.charAt(0).toLowerCase()}
                            </span>
                          </div>
                          <div>
                            <h3 className="text-sm font-semibold text-white">{selectedRift.rSymbol}</h3>
                            <p className="text-[10px] text-gray-400">{selectedRift.underlying}</p>
                          </div>
                          <div className="ml-auto text-right">
                            <div className={`text-xs font-semibold ${selectedRift.tvl >= minTvlUsd ? 'text-emerald-400' : 'text-red-400'}`}>
                              ${selectedRift.tvl >= 1000 ? `${(selectedRift.tvl / 1000).toFixed(1)}k` : selectedRift.tvl.toFixed(0)} TVL
                            </div>
                            <div className="text-[10px] text-gray-500">{selectedRift.programVersion}</div>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 gap-1 text-[10px]">
                          <div className="flex justify-between items-center py-1 px-2 rounded bg-black/40 group">
                            <span className="text-gray-500">Rift</span>
                            <button
                              onClick={() => copyToClipboard(selectedRift.id, 'rift')}
                              className="flex items-center gap-1.5 text-gray-300 font-mono hover:text-white transition-colors cursor-pointer"
                              title="Click to copy"
                            >
                              {selectedRift.id.slice(0, 8)}...{selectedRift.id.slice(-6)}
                              {copiedAddress === 'rift' ? (
                                <Check className="w-3 h-3 text-emerald-400" />
                              ) : (
                                <Copy className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                              )}
                            </button>
                          </div>
                          <div className="flex justify-between items-center py-1 px-2 rounded bg-black/40 group">
                            <span className="text-gray-500">rToken</span>
                            <button
                              onClick={() => copyToClipboard(selectedRift.riftMint, 'rToken')}
                              className="flex items-center gap-1.5 text-emerald-400 font-mono hover:text-emerald-300 transition-colors cursor-pointer"
                              title="Click to copy"
                            >
                              {selectedRift.riftMint.slice(0, 8)}...{selectedRift.riftMint.slice(-6)}
                              {copiedAddress === 'rToken' ? (
                                <Check className="w-3 h-3 text-emerald-400" />
                              ) : (
                                <Copy className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                              )}
                            </button>
                          </div>
                          <div className="flex justify-between items-center py-1 px-2 rounded bg-black/40 group">
                            <span className="text-gray-500">Underlying</span>
                            <button
                              onClick={() => copyToClipboard(selectedRift.underlyingMint, 'underlying')}
                              className="flex items-center gap-1.5 text-blue-400 font-mono hover:text-blue-300 transition-colors cursor-pointer"
                              title="Click to copy"
                            >
                              {selectedRift.underlyingMint.slice(0, 8)}...{selectedRift.underlyingMint.slice(-6)}
                              {copiedAddress === 'underlying' ? (
                                <Check className="w-3 h-3 text-emerald-400" />
                              ) : (
                                <Copy className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                              )}
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Start/Stop Button - Compact */}
                      <div className="flex flex-col items-center gap-2">
                        {botStats.status === 'stopped' ? (
                          <>
                            <button
                              onClick={startBot}
                              className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-emerald-500 text-black font-bold text-sm hover:bg-emerald-400 transition-all transform hover:scale-105"
                            >
                              <Play className="w-4 h-4" />
                              Start Bot
                            </button>
                            <p className="text-[10px] text-gray-500 flex items-center gap-1">
                              <Cloud className="w-3 h-3" />
                              Runs 24/7 in cloud
                            </p>
                          </>
                        ) : botStats.status === 'running' ? (
                          <>
                            <button
                              onClick={stopBot}
                              className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-red-500 text-white font-bold text-sm hover:bg-red-400 transition-all"
                            >
                              <Square className="w-4 h-4" />
                              Stop Bot
                            </button>
                            {botStats.persistent && (
                              <p className="text-[10px] text-blue-400 flex items-center gap-1">
                                <Cloud className="w-3 h-3" />
                                Running in cloud
                              </p>
                            )}
                          </>
                        ) : (
                          <button
                            disabled
                            className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-gray-700 text-gray-400 font-bold text-sm cursor-not-allowed"
                          >
                            <RefreshCw className="w-4 h-4 animate-spin" />
                            {botStats.status === 'starting' ? 'Starting...' : 'Stopping...'}
                          </button>
                        )}
                      </div>

                      {/* Stats Grid - Compact */}
                      <div className="grid grid-cols-3 gap-2">
                        <div className="px-2 py-2 rounded-lg bg-black/40 text-center">
                          <Clock className="w-4 h-4 text-blue-400 mx-auto mb-1" />
                          <div className="text-sm font-bold text-white font-mono">
                            {formatUptime(
                              getRunningSession(selectedRift.id || '')?.uptime ||
                              botStats.uptime
                            )}
                          </div>
                          <div className="text-[9px] text-gray-500">Uptime</div>
                        </div>
                        <div className="px-2 py-2 rounded-lg bg-black/40 text-center">
                          <TrendingUp className="w-4 h-4 text-purple-400 mx-auto mb-1" />
                          <div className="text-sm font-bold text-purple-400">
                            {botStats.opportunitiesFound}
                          </div>
                          <div className="text-[9px] text-gray-500">Opps</div>
                        </div>
                        <div className="px-2 py-2 rounded-lg bg-black/40 text-center">
                          <DollarSign className="w-4 h-4 text-yellow-400 mx-auto mb-1" />
                          {(() => {
                            const totalProfit = selectedRiftStats?.totalProfitSol != null
                              ? (selectedRiftStats.totalProfitSol * solPrice)
                              : botStats.totalProfit;
                            return (
                              <>
                                <div className="text-sm font-bold text-yellow-400">
                                  ${totalProfit.toFixed(2)}
                                </div>
                                <div className="text-[9px] text-gray-500">Profit</div>
                              </>
                            );
                          })()}
                        </div>
                      </div>

                      {/* Routes Info - Compact */}
                      <div className="rounded-lg bg-black/40 border border-gray-800/50 p-3">
                        <h3 className="text-xs font-semibold text-white mb-2 flex items-center gap-1.5">
                          <Gauge className="w-3.5 h-3.5 text-emerald-400" />
                          Arb Routes
                        </h3>
                        <div className="space-y-2 text-xs">
                          <div className="flex items-center gap-2 p-1.5 rounded bg-green-500/5">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-400"></span>
                            <span className="text-green-400 font-medium">WRAP</span>
                            <span className="text-gray-500 text-[10px]">{selectedRift.symbol} → r{selectedRift.symbol}</span>
                          </div>
                          <div className="flex items-center gap-2 p-1.5 rounded bg-blue-500/5">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-400"></span>
                            <span className="text-blue-400 font-medium">UNWRAP</span>
                            <span className="text-gray-500 text-[10px]">r{selectedRift.symbol} → {selectedRift.symbol}</span>
                          </div>
                        </div>
                      </div>

                      {/* Trade Executions Panel */}
                      <div className="rounded-lg bg-black/40 border border-gray-800/50 overflow-hidden">
                        <button
                          onClick={() => setShowTrades(!showTrades)}
                          className="w-full px-3 py-2 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
                        >
                          <h3 className="text-xs font-semibold text-white flex items-center gap-1.5">
                            <TrendingUp className="w-3.5 h-3.5 text-purple-400" />
                            Trades
                            {selectedRiftTrades.length > 0 && (
                              <span className="px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-400 text-[10px]">
                                {selectedRiftTrades.length}
                              </span>
                            )}
                          </h3>
                          <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform ${showTrades ? 'rotate-180' : ''}`} />
                        </button>
                        <AnimatePresence>
                          {showTrades && (
                            <motion.div
                              initial={{ height: 0 }}
                              animate={{ height: 'auto' }}
                              exit={{ height: 0 }}
                              className="overflow-hidden"
                            >
                              <div className="px-3 pb-3 max-h-48 overflow-y-auto space-y-1">
                                {selectedRiftTrades.length === 0 ? (
                                  <div className="text-gray-500 py-3 text-center text-[10px]">
                                    No trades yet
                                  </div>
                                ) : (
                                  selectedRiftTrades.slice(0, 20).map((trade) => (
                                    <div
                                      key={trade.id}
                                      className={`flex items-center justify-between py-1 px-1.5 rounded text-[10px] ${
                                        trade.success
                                          ? 'bg-emerald-500/10'
                                          : 'bg-red-500/10'
                                      }`}
                                    >
                                      <div className="flex items-center gap-2">
                                        <span className="text-gray-500 font-mono">
                                          {new Date(trade.createdAt).toLocaleTimeString()}
                                        </span>
                                        <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${
                                          trade.direction === 'wrap'
                                            ? 'bg-green-500/20 text-green-400'
                                            : 'bg-blue-500/20 text-blue-400'
                                        }`}>
                                          {trade.direction?.toUpperCase() || '?'}
                                        </span>
                                        <span className="text-white">{trade.rSymbol}</span>
                                      </div>
                                      <div className="flex items-center gap-2">
                                        <span className={`font-mono font-semibold ${
                                          trade.success ? 'text-emerald-400' : 'text-red-400'
                                        }`}>
                                          {trade.success ? '+' : ''}{trade.actualProfitSol?.toFixed(4) || '0'}
                                        </span>
                                        {trade.signature ? (
                                          <a
                                            href={`https://solscan.io/tx/${trade.signature}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-purple-400 hover:text-purple-300"
                                          >
                                            <ExternalLink className="w-3 h-3" />
                                          </a>
                                        ) : trade.success ? (
                                          <Check className="w-3 h-3 text-emerald-400" />
                                        ) : (
                                          <X className="w-3 h-3 text-red-400" />
                                        )}
                                      </div>
                                    </div>
                                  ))
                                )}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>

                      {/* Last Activity - Compact */}
                      {botStats.status === 'running' && (
                        <div className="text-center text-[10px] text-gray-500 py-1">
                          {botStats.scansCompleted || 0} scans • {botStats.lastCheck}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </LuxuryCard>
            </div>
          </div>
          </div>
          )}
        </div>
      </div>

      {/* LP Earnings Claims Modal */}
      <AnimatePresence>
        {showClaimsModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
            onClick={() => setShowClaimsModal(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-3xl w-full mx-4 max-h-[85vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex justify-between items-center mb-4">
                <div>
                  <h2 className="text-xl font-bold text-white">Claims Monitor</h2>
                  <p className="text-xs text-gray-500">Admin view of all pending claims</p>
                </div>
                <button
                  onClick={() => setShowClaimsModal(false)}
                  className="text-gray-400 hover:text-white transition-colors text-xl"
                >
                  ✕
                </button>
              </div>

              {claimsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <RefreshCw className="w-6 h-6 animate-spin text-blue-400" />
                  <span className="ml-2 text-gray-400">Loading earnings data...</span>
                </div>
              ) : claimsData ? (
                <>
                  {/* Grand Total Summary Cards */}
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <div className="bg-black/40 border border-gray-800 rounded-lg p-4">
                      <div className="text-sm text-gray-400 mb-1">Total Earned (All)</div>
                      <div className="text-2xl font-bold text-white">
                        {(claimsData.grandTotal?.earned || claimsData.totalEarned).toFixed(4)} SOL
                      </div>
                      <div className="text-xs text-gray-500">
                        ${((claimsData.grandTotal?.earned || claimsData.totalEarned) * solPrice).toFixed(2)}
                      </div>
                    </div>
                    <div className="bg-black/40 border border-gray-800 rounded-lg p-4">
                      <div className="text-sm text-gray-400 mb-1">Already Claimed</div>
                      <div className="text-2xl font-bold text-emerald-400">
                        {(claimsData.grandTotal?.claimed || claimsData.totalClaimed).toFixed(4)} SOL
                      </div>
                      <div className="text-xs text-gray-500">
                        ${((claimsData.grandTotal?.claimed || claimsData.totalClaimed) * solPrice).toFixed(2)}
                      </div>
                    </div>
                    <div className="bg-black/40 border border-yellow-500/30 rounded-lg p-4">
                      <div className="text-sm text-gray-400 mb-1">Pending Claims</div>
                      <div className="text-2xl font-bold text-yellow-400">
                        {(claimsData.grandTotal?.claimable || claimsData.totalClaimable).toFixed(4)} SOL
                      </div>
                      <div className="text-xs text-gray-500">
                        ${((claimsData.grandTotal?.claimable || claimsData.totalClaimable) * solPrice).toFixed(2)}
                      </div>
                    </div>
                  </div>

                  {/* Breakdown by Type */}
                  <div className="grid grid-cols-2 gap-3 mb-6">
                    <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3">
                      <div className="text-xs text-blue-400 mb-1">LP Earnings</div>
                      <div className="text-lg font-bold text-white">{claimsData.totalClaimable.toFixed(4)} SOL</div>
                      <div className="text-xs text-gray-500">{claimsData.lpCount} positions</div>
                    </div>
                    <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-3">
                      <div className="text-xs text-purple-400 mb-1">Referral Earnings</div>
                      <div className="text-lg font-bold text-white">{(claimsData.referrals?.totalClaimable || 0).toFixed(4)} SOL</div>
                      <div className="text-xs text-gray-500">{claimsData.referrals?.referrerCount || 0} referrers</div>
                    </div>
                  </div>

                  {/* Treasury Requirement Alert */}
                  {(() => {
                    const totalPending = claimsData.grandTotal?.claimable || claimsData.totalClaimable;
                    return totalPending > 0 && (
                      <div className={`mb-6 p-4 rounded-lg border ${
                        profitDistribution && profitDistribution.treasuryBalance >= totalPending
                          ? 'bg-emerald-500/10 border-emerald-500/30'
                          : 'bg-red-500/10 border-red-500/30'
                      }`}>
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-gray-300">Treasury needs at least:</span>
                          <span className="font-bold text-yellow-400">{totalPending.toFixed(4)} SOL</span>
                        </div>
                        <div className="flex justify-between items-center mt-1">
                          <span className="text-sm text-gray-300">Current treasury balance:</span>
                          <span className={`font-bold ${
                            profitDistribution && profitDistribution.treasuryBalance >= totalPending
                              ? 'text-emerald-400'
                              : 'text-red-400'
                          }`}>
                            {profitDistribution?.treasuryBalance.toFixed(4) || '0.0000'} SOL
                          </span>
                        </div>
                        {profitDistribution && profitDistribution.treasuryBalance < totalPending && (
                          <div className="mt-2 text-xs text-red-400">
                            ⚠️ Treasury is short by {(totalPending - profitDistribution.treasuryBalance).toFixed(4)} SOL
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Stats Row */}
                  <div className="flex gap-4 mb-4 text-xs">
                    <div className="bg-black/40 border border-gray-800 rounded px-3 py-2">
                      <span className="text-gray-500">Rifts:</span>
                      <span className="ml-1 text-white font-medium">{claimsData.riftCount}</span>
                    </div>
                    <div className="bg-black/40 border border-gray-800 rounded px-3 py-2">
                      <span className="text-gray-500">LPs:</span>
                      <span className="ml-1 text-white font-medium">{claimsData.lpCount}</span>
                    </div>
                  </div>

                  {/* View Mode Tabs */}
                  <div className="flex gap-2 mb-4">
                    <button
                      onClick={() => setClaimsViewMode('rift')}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        claimsViewMode === 'rift'
                          ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                          : 'bg-gray-800/50 text-gray-400 hover:bg-gray-800 border border-gray-700'
                      }`}
                    >
                      By Rift
                    </button>
                    <button
                      onClick={() => setClaimsViewMode('user')}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        claimsViewMode === 'user'
                          ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                          : 'bg-gray-800/50 text-gray-400 hover:bg-gray-800 border border-gray-700'
                      }`}
                    >
                      By User
                    </button>
                    <button
                      onClick={() => setClaimsViewMode('referrals')}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        claimsViewMode === 'referrals'
                          ? 'bg-purple-500/20 text-purple-400 border border-purple-500/40'
                          : 'bg-gray-800/50 text-gray-400 hover:bg-gray-800 border border-gray-700'
                      }`}
                    >
                      Referrals
                    </button>
                  </div>

                  {/* Breakdown Content */}
                  <div className="space-y-2">
                    {claimsViewMode === 'rift' ? (
                      <>
                        {/* By Rift View */}
                        <div className="text-xs text-gray-500 grid grid-cols-12 gap-2 px-2 pb-1 border-b border-gray-800">
                          <span className="col-span-3">Rift</span>
                          <span className="col-span-2 text-right">LPs</span>
                          <span className="col-span-2 text-right">Earned</span>
                          <span className="col-span-2 text-right">Claimed</span>
                          <span className="col-span-3 text-right">Claimable</span>
                        </div>
                        {claimsData.riftBreakdown.length === 0 ? (
                          <div className="text-center py-8 text-gray-500">
                            No earnings recorded yet
                          </div>
                        ) : (
                          claimsData.riftBreakdown.map((rift) => (
                            <div
                              key={rift.rift_id}
                              className="grid grid-cols-12 gap-2 px-2 py-2 rounded bg-gray-800/30 hover:bg-gray-800/50 transition-colors text-sm"
                            >
                              <div className="col-span-3 font-medium text-white truncate">
                                {rift.rift_symbol}
                              </div>
                              <div className="col-span-2 text-right text-gray-400">
                                {rift.lp_count}
                              </div>
                              <div className="col-span-2 text-right text-gray-300">
                                {rift.total_earned_sol.toFixed(4)}
                              </div>
                              <div className="col-span-2 text-right text-emerald-400">
                                {rift.claimed_sol.toFixed(4)}
                              </div>
                              <div className={`col-span-3 text-right font-medium ${rift.claimable > 0.0001 ? 'text-yellow-400' : 'text-gray-500'}`}>
                                {rift.claimable.toFixed(4)} SOL
                              </div>
                            </div>
                          ))
                        )}
                      </>
                    ) : claimsViewMode === 'user' ? (
                      <>
                        {/* By User View */}
                        <div className="text-xs text-gray-500 grid grid-cols-12 gap-2 px-2 pb-1 border-b border-gray-800">
                          <span className="col-span-2">Rift</span>
                          <span className="col-span-4">Wallet</span>
                          <span className="col-span-2 text-right">Earned</span>
                          <span className="col-span-2 text-right">Claimed</span>
                          <span className="col-span-2 text-right">Claimable</span>
                        </div>
                        {claimsData.earnings.length === 0 ? (
                          <div className="text-center py-8 text-gray-500">
                            No earnings recorded yet
                          </div>
                        ) : (
                          claimsData.earnings
                            .sort((a, b) => b.claimable - a.claimable)
                            .map((earning, idx) => (
                              <div
                                key={`${earning.rift_id}-${earning.wallet_address}-${idx}`}
                                className="grid grid-cols-12 gap-2 px-2 py-2 rounded bg-gray-800/30 hover:bg-gray-800/50 transition-colors text-sm"
                              >
                                <div className="col-span-2 font-medium text-white truncate">
                                  {earning.rift_symbol}
                                </div>
                                <div className="col-span-4 text-gray-400 font-mono text-xs truncate">
                                  {earning.wallet_address.slice(0, 4)}...{earning.wallet_address.slice(-4)}
                                </div>
                                <div className="col-span-2 text-right text-gray-300">
                                  {earning.total_earned_sol.toFixed(4)}
                                </div>
                                <div className="col-span-2 text-right text-emerald-400">
                                  {earning.claimed_sol.toFixed(4)}
                                </div>
                                <div className={`col-span-2 text-right font-medium ${earning.claimable > 0.0001 ? 'text-yellow-400' : 'text-gray-500'}`}>
                                  {earning.claimable.toFixed(4)}
                                </div>
                              </div>
                            ))
                        )}
                      </>
                    ) : (
                      <>
                        {/* Referrals View */}
                        <div className="text-xs text-gray-500 grid grid-cols-12 gap-2 px-2 pb-1 border-b border-gray-800">
                          <span className="col-span-5">Referrer Wallet</span>
                          <span className="col-span-2 text-right">Refs</span>
                          <span className="col-span-2 text-right">Earned</span>
                          <span className="col-span-3 text-right">Claimable</span>
                        </div>
                        {!claimsData.referrals?.breakdown?.length ? (
                          <div className="text-center py-8 text-gray-500">
                            No referral earnings yet
                          </div>
                        ) : (
                          claimsData.referrals.breakdown.map((referrer, idx) => (
                            <div
                              key={`${referrer.wallet}-${idx}`}
                              className="grid grid-cols-12 gap-2 px-2 py-2 rounded bg-gray-800/30 hover:bg-gray-800/50 transition-colors text-sm"
                            >
                              <div className="col-span-5 font-mono text-xs text-gray-300 truncate">
                                {referrer.wallet.slice(0, 6)}...{referrer.wallet.slice(-6)}
                              </div>
                              <div className="col-span-2 text-right text-purple-400">
                                {referrer.earnings_count}
                              </div>
                              <div className="col-span-2 text-right text-gray-300">
                                {referrer.total_earned.toFixed(4)}
                              </div>
                              <div className={`col-span-3 text-right font-medium ${referrer.claimable > 0.0001 ? 'text-yellow-400' : 'text-gray-500'}`}>
                                {referrer.claimable.toFixed(4)} SOL
                              </div>
                            </div>
                          ))
                        )}
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  Failed to load earnings data
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
