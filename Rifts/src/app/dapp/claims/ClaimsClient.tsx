"use client"

import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Wallet, ExternalLink, Copy, Check, RefreshCw,
  TrendingUp, Users, Layers, Send, ChevronDown, ChevronUp,
  Coins, Gift, Share2
} from 'lucide-react';
import nextDynamic from 'next/dynamic';
import { useRealWallet } from '@/hooks/useWalletAdapter';
import { useUserProfile } from '@/hooks/useUserProfile';
import DappSidebar from '@/components/dapp/DappSidebar';
import { LuxuryButton } from '@/components/ui/luxury-button';

const RippleGrid = nextDynamic(
  () => import('@/components/reactbits/backgrounds/RippleGrid/RippleGrid'),
  { ssr: false, loading: () => <div className="w-full h-full bg-black" /> }
);

interface ClaimableItem {
  type: 'lp' | 'team' | 'referral' | 'legacy_lp' | 'legacy_team';
  riftId?: string;
  symbol?: string;
  amount: number;
  source: 'treasury' | 'legacy_wallet';
  walletAddress?: string;
}

interface LpPosition {
  riftId: string;
  symbol: string;
  underlying: string;
  riftMint: string;
  underlyingMint: string | null;
  tvl: number;
  sharePct: number;
  lpWalletAddress: string;
  poolAddress: string | null;
  poolType: string | null;
  isSingleSided?: boolean;
  poolLink: string | null;
  totalArbProfit: number;
  claimable: number;
  source: 'new' | 'legacy';
}

interface CreatedRift {
  riftId: string;
  symbol: string;
  underlying: string;
  riftMint: string;
  underlyingMint: string | null;
  tvl: number;
  teamWalletAddress: string | null;
  poolAddress: string | null;
  poolType: string | null;
  isSingleSided?: boolean;
  poolLink: string | null;
  totalArbProfit: number;
  teamClaimable: number;
}

interface ClaimsData {
  totalClaimable: number;
  items: ClaimableItem[];
  breakdown: {
    newSystem: number;
    newSystemLp: number;
    newSystemTeam: number;
    legacyLp: number;
    legacyTeam: number;
    referral: number;
  };
  portfolio: {
    lpPositions: LpPosition[];
    createdRifts: CreatedRift[];
  };
}

interface ReferralData {
  referrals: { referred_wallet: string; created_at: string }[];
  referredRifts: { rift_id: string; referrer_wallet: string }[];
  totalEarned: number;
  totalClaimed: number;
  claimable: number;
  stats: {
    totalReferrals: number;
    activeReferrals: number;
    totalRiftsFromReferrals: number;
    currentRate: number;
    nextTierRefs: number | null;
    nextTierRate: number | null;
  };
}

// Luxury Card Component
function LuxuryCard({ children, className = '', onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) {
  return (
    <motion.div
      className={`relative bg-black/90 backdrop-blur-md border border-emerald-500/30 rounded-xl overflow-hidden ${className}`}
      whileHover={onClick ? { scale: 1.01, borderColor: 'rgba(52, 211, 153, 0.5)' } : undefined}
      onClick={onClick}
    >
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
    </motion.div>
  );
}

// Stat Card with luxury styling
function StatCard({
  label,
  value,
  subValue,
  icon: Icon,
  color = 'emerald'
}: {
  label: string;
  value: string;
  subValue?: string;
  icon: React.ComponentType<{ className?: string }>;
  color?: 'emerald' | 'blue' | 'purple' | 'amber';
}) {
  const colorMap = {
    emerald: { border: 'border-emerald-500/30', icon: 'bg-emerald-500/20 text-emerald-400', value: 'text-emerald-400' },
    blue: { border: 'border-blue-500/30', icon: 'bg-blue-500/20 text-blue-400', value: 'text-blue-400' },
    purple: { border: 'border-purple-500/30', icon: 'bg-purple-500/20 text-purple-400', value: 'text-purple-400' },
    amber: { border: 'border-amber-500/30', icon: 'bg-amber-500/20 text-amber-400', value: 'text-amber-400' },
  };
  const colors = colorMap[color];

  return (
    <div className={`relative bg-black/90 backdrop-blur-md border ${colors.border} rounded-xl p-4 overflow-hidden`}>
      {/* Background pattern */}
      <div className="absolute inset-0 opacity-20 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(16,185,129,0.15)_0%,transparent_70%)]" />
      </div>
      {/* Corner accents */}
      <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-current opacity-30 pointer-events-none" />
      <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-current opacity-30 pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-current opacity-30 pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-current opacity-30 pointer-events-none" />

      <div className="relative z-10">
        <div className="flex items-center gap-2 mb-2">
          <div className={`p-2 rounded-lg ${colors.icon}`}>
            <Icon className="w-4 h-4" />
          </div>
          <span className="text-xs text-gray-400 uppercase tracking-wider">{label}</span>
        </div>
        <p className={`text-xl font-bold ${colors.value}`}>{value}</p>
        {subValue && <p className="text-xs text-gray-500 mt-1">{subValue}</p>}
      </div>
    </div>
  );
}

// Rift Position Card with luxury styling
function RiftPositionCard({
  rift,
  type,
  solPrice
}: {
  rift: LpPosition | CreatedRift;
  type: 'lp' | 'team';
  solPrice: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const isLp = type === 'lp';
  const lpRift = rift as LpPosition;
  const teamRift = rift as CreatedRift;
  const claimable = isLp ? lpRift.claimable : teamRift.teamClaimable;

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.div
      className={`relative bg-black/90 backdrop-blur-md border rounded-xl overflow-hidden transition-all ${
        isLp ? 'border-blue-500/30 hover:border-blue-400/50' : 'border-purple-500/30 hover:border-purple-400/50'
      }`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
    >
      {/* Background pattern */}
      <div className="absolute inset-0 opacity-20 pointer-events-none">
        <div className={`absolute inset-0 ${isLp
          ? 'bg-[radial-gradient(circle_at_30%_50%,rgba(59,130,246,0.1)_0%,transparent_50%)]'
          : 'bg-[radial-gradient(circle_at_30%_50%,rgba(168,85,247,0.1)_0%,transparent_50%)]'
        }`} />
      </div>

      {/* Header - Clickable */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between text-left relative z-10"
      >
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center border ${
            isLp ? 'bg-blue-500/20 border-blue-500/30' : 'bg-purple-500/20 border-purple-500/30'
          }`}>
            <span className={`text-sm font-bold ${isLp ? 'text-blue-400' : 'text-purple-400'}`}>
              {rift.symbol?.slice(0, 2) || '??'}
            </span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white">{rift.symbol}</span>
              <span className="text-xs text-gray-500">/ {rift.underlying}</span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                isLp ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'
              }`}>
                {isLp ? `${lpRift.sharePct.toFixed(2)}% LP` : 'Creator'}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xs text-gray-500">TVL: ${rift.tvl.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
              {rift.poolType && (
                <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-800 text-gray-400 uppercase">
                  {rift.poolType}{(isLp ? lpRift.isSingleSided : teamRift.isSingleSided) ? ' SS' : ''}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-sm font-bold text-emerald-400">{rift.totalArbProfit.toFixed(4)} SOL</p>
            <p className="text-[10px] text-gray-500">total profit</p>
          </div>
          <motion.div
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={{ duration: 0.2 }}
          >
            <ChevronDown className="w-4 h-4 text-gray-500" />
          </motion.div>
        </div>
      </button>

      {/* Expanded Details */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 border-t border-gray-800/50">
              <div className="grid grid-cols-4 gap-3 mt-3">
                <div className="text-center p-2 bg-gray-900/50 rounded-lg">
                  <p className="text-[10px] text-gray-500 uppercase">TVL</p>
                  <p className="text-sm font-medium text-white">${rift.tvl.toLocaleString()}</p>
                </div>
                <div className="text-center p-2 bg-gray-900/50 rounded-lg">
                  <p className="text-[10px] text-gray-500 uppercase">Arb Profit</p>
                  <p className="text-sm font-medium text-emerald-400">{rift.totalArbProfit.toFixed(4)}</p>
                </div>
                <div className="text-center p-2 bg-gray-900/50 rounded-lg">
                  <p className="text-[10px] text-gray-500 uppercase">Claimable</p>
                  <p className={`text-sm font-medium ${claimable > 0 ? 'text-emerald-400' : 'text-gray-600'}`}>
                    {claimable.toFixed(4)}
                  </p>
                </div>
                <div className="text-center p-2 bg-gray-900/50 rounded-lg">
                  <p className="text-[10px] text-gray-500 uppercase">USD Value</p>
                  <p className="text-sm font-medium text-white">${(claimable * solPrice).toFixed(2)}</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 mt-3">
                <button
                  onClick={() => handleCopy(rift.riftMint)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-all ${
                    copied
                      ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
                      : 'bg-gray-900/80 hover:bg-gray-800/80 border-gray-700 text-gray-300'
                  }`}
                >
                  <span className="font-mono">{rift.riftMint.slice(0, 4)}...{rift.riftMint.slice(-4)}</span>
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                </button>
                <a
                  href={`https://solscan.io/token/${rift.riftMint}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs bg-gray-900/80 hover:bg-gray-800/80 border border-gray-700 text-gray-300 transition-all"
                >
                  Solscan <ExternalLink className="w-3 h-3" />
                </a>
                {rift.poolLink && (
                  <a
                    href={rift.poolLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-all ${
                      isLp
                        ? 'bg-blue-500/20 border-blue-500/40 text-blue-400 hover:bg-blue-500/30'
                        : 'bg-purple-500/20 border-purple-500/40 text-purple-400 hover:bg-purple-500/30'
                    }`}
                  >
                    Meteora Pool <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Corner accents */}
      <div className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-emerald-500/30 pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-emerald-500/30 pointer-events-none" />
    </motion.div>
  );
}

// Collapsible Rift List with Show More/Less
function CollapsibleRiftList({
  title,
  icon,
  rifts,
  type,
  solPrice,
  initialLimit = 3
}: {
  title: string;
  icon: React.ReactNode;
  rifts: (LpPosition | CreatedRift)[];
  type: 'lp' | 'team';
  solPrice: number;
  initialLimit?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const displayedRifts = showAll ? rifts : rifts.slice(0, initialLimit);
  const hasMore = rifts.length > initialLimit;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white flex items-center gap-2">
          {icon}
          {title}
        </h2>
        <span className="text-xs text-gray-500 px-2 py-1 bg-gray-900/50 rounded-lg">
          {rifts.length} rift{rifts.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="space-y-3">
        <AnimatePresence>
          {displayedRifts.map((rift, idx) => (
            <RiftPositionCard key={idx} rift={rift} type={type} solPrice={solPrice} />
          ))}
        </AnimatePresence>
      </div>

      {hasMore && (
        <motion.button
          onClick={() => setShowAll(!showAll)}
          className="w-full py-2.5 px-4 rounded-lg bg-gray-900/50 border border-gray-800 hover:border-gray-700 text-sm text-gray-400 hover:text-white transition-all flex items-center justify-center gap-2"
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.99 }}
        >
          <motion.div
            animate={{ rotate: showAll ? 180 : 0 }}
            transition={{ duration: 0.2 }}
          >
            <ChevronDown className="w-4 h-4" />
          </motion.div>
          {showAll ? `Show Less` : `Show ${rifts.length - initialLimit} More`}
        </motion.button>
      )}
    </div>
  );
}

export default function ClaimsClient() {
  const wallet = useRealWallet();
  const { user } = useUserProfile(wallet.publicKey?.toString() || null);

  const [solPrice, setSolPrice] = useState(180);
  const [copied, setCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isClaiming, setIsClaiming] = useState(false);
  const [claimsData, setClaimsData] = useState<ClaimsData | null>(null);
  const [referralData, setReferralData] = useState<ReferralData | null>(null);
  const [claimResult, setClaimResult] = useState<{
    success: boolean;
    message: string;
    totalClaimed?: number;
    results?: any[];
  } | null>(null);

  // Fetch SOL price
  useEffect(() => {
    const fetchPrice = async () => {
      try {
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        const data = await response.json();
        setSolPrice(data.solana?.usd || 180);
      } catch {
        // Keep default
      }
    };
    fetchPrice();
    const interval = setInterval(fetchPrice, 60000);
    return () => clearInterval(interval);
  }, []);

  // Fetch claimable data
  const fetchClaimsData = useCallback(async () => {
    if (!wallet.publicKey) return;

    setIsLoading(true);
    try {
      const [claimsResponse, referralsResponse] = await Promise.all([
        fetch(`/api/claims?wallet=${wallet.publicKey}`),
        fetch(`/api/referrals?wallet=${wallet.publicKey}`)
      ]);

      if (claimsResponse.ok) {
        const data = await claimsResponse.json();
        setClaimsData(data);
      }

      if (referralsResponse.ok) {
        const data = await referralsResponse.json();
        setReferralData(data);
      }
    } catch (err) {
      console.error('Failed to fetch claims data:', err);
    } finally {
      setIsLoading(false);
    }
  }, [wallet.publicKey]);

  useEffect(() => {
    fetchClaimsData();
  }, [fetchClaimsData]);

  // Claim all
  const handleClaimAll = async () => {
    if (!wallet.publicKey || !claimsData || claimsData.totalClaimable < 0.001) return;

    setIsClaiming(true);
    setClaimResult(null);

    try {
      const response = await fetch('/api/claims', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: wallet.publicKey.toString() }),
      });

      const data = await response.json();

      if (data.success) {
        setClaimResult({
          success: true,
          message: `Successfully claimed ${data.totalClaimed.toFixed(4)} SOL`,
          totalClaimed: data.totalClaimed,
          results: data.results,
        });
        await fetchClaimsData();
      } else {
        setClaimResult({
          success: false,
          message: data.error || 'Failed to claim',
        });
      }
    } catch (err) {
      setClaimResult({
        success: false,
        message: err instanceof Error ? err.message : 'Failed to claim',
      });
    } finally {
      setIsClaiming(false);
    }
  };

  // Get referral link
  const getReferralLink = () => {
    const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';
    const refId = user?.userId || wallet.publicKey?.toString() || '';
    return `${baseUrl}/dapp?ref=${refId}`;
  };

  const copyReferralLink = () => {
    navigator.clipboard.writeText(getReferralLink());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Calculate earnings by type
  const lpEarnings = (claimsData?.breakdown.legacyLp || 0) + (claimsData?.breakdown.newSystemLp || 0);
  const teamEarnings = (claimsData?.breakdown.legacyTeam || 0) + (claimsData?.breakdown.newSystemTeam || 0);
  const referralEarnings = claimsData?.breakdown.referral || 0;

  // Portfolio data
  const lpPositions = claimsData?.portfolio?.lpPositions || [];
  const createdRifts = claimsData?.portfolio?.createdRifts || [];

  return (
    <div className="relative flex w-full min-h-screen text-white">
      {/* Background */}
      <div className="fixed inset-0 z-0 bg-black">
        <RippleGrid />
      </div>

      {/* Sidebar */}
      <div className="relative z-20">
        <DappSidebar
          user={user}
          wallet={{
            connected: wallet.connected,
            connecting: wallet.connecting,
            publicKey: wallet.publicKey?.toString(),
            connect: () => wallet.connect(),
            disconnect: () => wallet.disconnect(),
          }}
        />
      </div>

      {/* Main Content */}
      <div className="relative z-10 flex-1 overflow-y-auto">
        <div className="p-6 md:p-8 max-w-5xl mx-auto">

          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-white flex items-center gap-3">
                <div className="p-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30">
                  <Coins className="w-6 h-6 text-emerald-400" />
                </div>
                Claims
              </h1>
              <p className="text-sm text-gray-400 mt-1">LP profits, creator earnings & referral rewards</p>
            </div>
            {wallet.publicKey && (
              <LuxuryButton
                variant="secondary"
                size="sm"
                onClick={fetchClaimsData}
                disabled={isLoading}
                icon={RefreshCw}
                loading={isLoading}
              >
                Refresh
              </LuxuryButton>
            )}
          </div>

          {!wallet.publicKey ? (
            /* Connect Wallet */
            <LuxuryCard className="py-16 px-8">
              <div className="flex flex-col items-center justify-center text-center">
                <div className="w-20 h-20 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center mb-6">
                  <Wallet className="w-10 h-10 text-emerald-400" />
                </div>
                <h2 className="text-xl font-bold text-white mb-2">Connect Your Wallet</h2>
                <p className="text-gray-400 text-sm max-w-md mb-6">
                  Connect your wallet to view and claim your LP profits, creator shares, and referral rewards.
                </p>
                <LuxuryButton
                  variant="primary"
                  size="lg"
                  onClick={() => wallet.connect()}
                  icon={Wallet}
                >
                  Connect Wallet
                </LuxuryButton>
              </div>
            </LuxuryCard>
          ) : (
            <div className="space-y-6">

              {/* Total Claimable Card */}
              <LuxuryCard className="p-6">
                <div className="flex items-center justify-between gap-6">
                  <div>
                    <p className="text-sm text-gray-400 mb-2 uppercase tracking-wider">Total Claimable</p>
                    <div className="flex items-baseline gap-3">
                      <span className="text-4xl font-bold text-white tabular-nums">
                        {isLoading ? '—' : (claimsData?.totalClaimable || 0).toFixed(4)}
                      </span>
                      <span className="text-lg text-emerald-400 font-medium">SOL</span>
                    </div>
                    <p className="text-sm text-gray-500 mt-1">
                      ≈ ${((claimsData?.totalClaimable || 0) * solPrice).toFixed(2)} USD
                    </p>
                  </div>
                  <LuxuryButton
                    variant="primary"
                    size="lg"
                    onClick={handleClaimAll}
                    disabled={isClaiming || !claimsData || claimsData.totalClaimable < 0.001}
                    loading={isClaiming}
                    icon={Send}
                    pulse={!!(claimsData && claimsData.totalClaimable >= 0.001)}
                  >
                    {isClaiming ? 'Claiming...' : 'Claim All'}
                  </LuxuryButton>
                </div>

                {/* Claim Result */}
                <AnimatePresence>
                  {claimResult && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className={`mt-4 p-4 rounded-lg border ${
                        claimResult.success
                          ? 'bg-emerald-500/10 border-emerald-500/30'
                          : 'bg-red-500/10 border-red-500/30'
                      }`}
                    >
                      <p className={`text-sm font-medium ${claimResult.success ? 'text-emerald-400' : 'text-red-400'}`}>
                        {claimResult.message}
                      </p>
                      {claimResult.results?.map((r, i) => r.signature && (
                        <a
                          key={i}
                          href={`https://solscan.io/tx/${r.signature}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 mt-2 text-sm text-emerald-400 hover:text-emerald-300"
                        >
                          View transaction <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </LuxuryCard>

              {/* Stats Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <StatCard
                  label="LP Earnings"
                  value={`${lpEarnings.toFixed(4)} SOL`}
                  subValue={`≈ $${(lpEarnings * solPrice).toFixed(2)}`}
                  icon={Layers}
                  color="blue"
                />
                <StatCard
                  label="Creator Earnings"
                  value={`${teamEarnings.toFixed(4)} SOL`}
                  subValue={`≈ $${(teamEarnings * solPrice).toFixed(2)}`}
                  icon={Users}
                  color="purple"
                />
                <StatCard
                  label="Referral Earnings"
                  value={`${referralEarnings.toFixed(4)} SOL`}
                  subValue={`≈ $${(referralEarnings * solPrice).toFixed(2)}`}
                  icon={Gift}
                  color="amber"
                />
              </div>

              {/* LP Positions */}
              {lpPositions.length > 0 && (
                <CollapsibleRiftList
                  title="LP Positions"
                  icon={<Layers className="w-5 h-5 text-blue-400" />}
                  rifts={lpPositions}
                  type="lp"
                  solPrice={solPrice}
                  initialLimit={3}
                />
              )}

              {/* Created Rifts */}
              {createdRifts.length > 0 && (
                <CollapsibleRiftList
                  title="Your Rifts"
                  icon={<Users className="w-5 h-5 text-purple-400" />}
                  rifts={createdRifts}
                  type="team"
                  solPrice={solPrice}
                  initialLimit={3}
                />
              )}

              {/* Referral Section */}
              <LuxuryCard className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-amber-500/20 border border-amber-500/30">
                      <Share2 className="w-5 h-5 text-amber-400" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-white">Referral Program</h3>
                      <p className="text-xs text-gray-500">Earn SOL by referring new users</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-gray-500">Your Rate</p>
                    <p className="text-2xl font-bold text-amber-400">{referralData?.stats?.currentRate || 5}%</p>
                  </div>
                </div>

                {/* Referral Stats */}
                <div className="grid grid-cols-4 gap-3 mb-4">
                  <div className="text-center p-3 bg-gray-900/50 rounded-lg border border-gray-800">
                    <p className="text-xl font-bold text-white">{referralData?.stats?.totalReferrals || 0}</p>
                    <p className="text-[10px] text-gray-500 uppercase">Total Refs</p>
                  </div>
                  <div className="text-center p-3 bg-gray-900/50 rounded-lg border border-gray-800">
                    <p className="text-xl font-bold text-emerald-400">{referralData?.stats?.activeReferrals || 0}</p>
                    <p className="text-[10px] text-gray-500 uppercase">Active</p>
                  </div>
                  <div className="text-center p-3 bg-gray-900/50 rounded-lg border border-gray-800">
                    <p className="text-xl font-bold text-white">{referralData?.stats?.totalRiftsFromReferrals || 0}</p>
                    <p className="text-[10px] text-gray-500 uppercase">Their Rifts</p>
                  </div>
                  <div className="text-center p-3 bg-gray-900/50 rounded-lg border border-gray-800">
                    <p className="text-xl font-bold text-amber-400">{(referralData?.totalEarned || 0).toFixed(4)}</p>
                    <p className="text-[10px] text-gray-500 uppercase">Total Earned</p>
                  </div>
                </div>

                {/* Next Tier Progress */}
                {referralData?.stats?.nextTierRefs && (
                  <div className="mb-4 p-3 bg-gray-900/50 rounded-lg border border-gray-800">
                    <div className="flex items-center justify-between text-sm mb-2">
                      <span className="text-gray-400">
                        {referralData.stats.nextTierRefs - (referralData?.stats?.activeReferrals || 0)} more active referrals for {referralData.stats.nextTierRate}%
                      </span>
                      <span className="text-amber-400 font-medium">
                        {referralData?.stats?.activeReferrals || 0}/{referralData.stats.nextTierRefs}
                      </span>
                    </div>
                    <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                      <motion.div
                        className="h-full bg-gradient-to-r from-amber-500 to-amber-400 rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.min(100, ((referralData?.stats?.activeReferrals || 0) / referralData.stats.nextTierRefs) * 100)}%` }}
                        transition={{ duration: 0.5, ease: 'easeOut' }}
                      />
                    </div>
                  </div>
                )}

                {/* Referral Link */}
                <div className="flex gap-2">
                  <div className="flex-1 px-4 py-3 bg-gray-900/80 border border-gray-700 rounded-lg overflow-hidden">
                    <p className="text-sm font-mono text-gray-300 truncate">{getReferralLink()}</p>
                  </div>
                  <LuxuryButton
                    variant={copied ? 'success' : 'secondary'}
                    size="md"
                    onClick={copyReferralLink}
                    icon={copied ? Check : Copy}
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </LuxuryButton>
                </div>
              </LuxuryCard>

              {/* Empty State */}
              {!isLoading && claimsData && claimsData.totalClaimable < 0.001 && lpPositions.length === 0 && createdRifts.length === 0 && (
                <LuxuryCard className="py-12 px-8">
                  <div className="flex flex-col items-center justify-center text-center">
                    <div className="w-16 h-16 rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center mb-4">
                      <Wallet className="w-8 h-8 text-gray-500" />
                    </div>
                    <h3 className="text-lg font-bold text-white mb-2">No Earnings Yet</h3>
                    <p className="text-gray-400 text-sm max-w-md">
                      Provide liquidity to rifts or refer users to start earning SOL rewards.
                    </p>
                  </div>
                </LuxuryCard>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
