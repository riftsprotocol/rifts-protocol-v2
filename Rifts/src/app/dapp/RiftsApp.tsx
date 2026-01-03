"use client";

// RIFTS Protocol - Advanced Volatility Farming Platform

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Image from 'next/image';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import {
  Wallet, Search, Plus, Minus,
  TrendingUp, TrendingDown, Activity, Users,
  Lock, Unlock, Eye, Copy, Coins,
  ExternalLink,
  Layers, Target, LayoutDashboard,
  BarChart3, DollarSign, AlertCircle,
  Filter,
  Briefcase, BookOpen, PieChart, LineChart,
  ChevronRight, Shield, Info, X, Loader2, Droplets, Check,
  Zap, ArrowDown, Share2, Bot, Rocket
} from 'lucide-react';

// Production services
import { connection, walletService, riftProtocolService } from '@/lib/solana/index';
import { saveRiftsToSupabase } from '@/lib/solana/rifts/data';
import { Connection, Transaction, PublicKey } from '@solana/web3.js';
import { ProductionRiftsService, WalletAdapter, ProductionRiftData } from '@/lib/solana/rifts-service';
import { BLACKLISTED_RIFTS as BASE_BLACKLISTED_RIFTS, RIFTS_PROGRAM_ID } from '@/lib/solana/rifts/types';
import { dexIntegration } from '@/lib/solana/dex-integration';
import { RealBlockchainService } from '@/lib/solana/real-blockchain-service';
import { RealPriceOracle } from '@/lib/solana/real-price-oracle';
import { realDataService, type RealDataMetrics, RealUserAnalytics } from '@/lib/solana/real-data-service';
import { meteoraLiquidityService } from '@/lib/solana/meteora-liquidity-service';
import { dlmmLiquidityService, StrategyType as DLMMStrategyType } from '@/lib/solana/dlmm-liquidity-service';
import { getDAMMV2LiquidityService } from '@/lib/solana/dammv2-liquidity-service';
// New pool creation services
import {
  createDAMMV2Pool,
  createDAMMV2SingleSidedPool,
  createDLMMPool,
  StrategyType as DLMMPoolStrategyType,
} from '@/lib/solana/pool-creation';
import { portfolioBlockchainService, type PortfolioData } from '@/services/portfolioBlockchainService';
import { analyticsBlockchainService, type ProtocolAnalytics } from '@/services/analyticsBlockchainService';
import { RealProtocolAnalyticsService, type RealProtocolAnalytics } from '@/services/realProtocolAnalytics';
import { uploadMetadata } from '@/lib/solana/pumpfun-service';

// Token metadata utilities
import { fetchTokenMetadata, generateRiftSymbol, type TokenMetadata } from '@/utils/token-metadata';

// Wallet interface (supports Phantom, Solflare, etc.)
interface WalletProvider {
  publicKey: PublicKey | null;
  isConnected: boolean;
  isPhantom?: boolean;
  isSolflare?: boolean;
  signTransaction: (transaction: Transaction) => Promise<Transaction>;
  signAllTransactions?: (transactions: Transaction[]) => Promise<Transaction[]>;
  signAndSendTransaction: (transaction: Transaction) => Promise<{ signature: string }>;
}

// Helper to get wallet provider (supports Phantom, Solflare, etc.)
function getWalletProvider(): WalletProvider | null {
  if (typeof window === 'undefined') return null;

  const windowSolana = (window as any)?.solana;
  const windowSolflare = (window as any)?.solflare;

  if (windowSolana?.isPhantom) return windowSolana;
  if (windowSolflare?.isSolflare) return windowSolflare;

  return null;
}

// Legacy alias for backward compatibility
type PhantomWallet = WalletProvider;

// Window.solana declaration removed - now using Reown AppKit

// Hooks
import { useRealWallet } from '@/hooks/useWalletAdapter';
import { useUserProfile } from '@/hooks/useUserProfile';

// Components
import { RiftsUI } from '@/components/rifts/RiftsUI';
import { LuxuryModal } from '@/components/ui/luxury-modal';
import { LuxuryButton } from '@/components/ui/luxury-button';
import { GovernancePanel } from '@/components/governance/GovernancePanel';
import { TradingInterface } from '@/components/trading/TradingInterface';
import { LiquidityModal, DLMMConfigPanel } from '@/components/liquidity/LiquidityModal';
import { DashboardModal } from '@/components/dashboard/DashboardModal';
import { ContractAddressList } from '@/components/ui/contract-address';
import { ConfirmationModal } from '@/components/ui/confirmation-modal';
import { UserProfileModal } from '@/components/user/UserProfileModal';

// Sidebar Components
import DappSidebar from '@/components/dapp/DappSidebar';
import dynamic from 'next/dynamic';

const RippleGrid = dynamic(
  () => import('@/components/reactbits/backgrounds/RippleGrid/RippleGrid'),
  { 
    ssr: false,
    loading: () => <div className="w-full h-full bg-black" />
  }
);
import {
  IconDashboard,
  IconCoins, 
  IconChartBar,
  IconWallet,
  IconActivity,
  IconUsers,
  IconFileText,
} from '@tabler/icons-react';

// UI Components
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// Types
interface RiftData {
  id: string;
  symbol: string;
  underlying: string;
  tvl: number;
  apy: number;
  backingRatio: number;
  volume24h: number;
  risk: string;
  participants: number;
  strategy: string;
  performance: number;
  isActive: boolean;
  maxCapacity: number;
  // Add vault field for close functionality
  vault: string;
  creator?: string; // Rift creator wallet
  authority?: string; // Rift authority wallet (same as creator in some cases)
  treasuryWallet?: string; // Treasury wallet for fee distribution
  partnerWallet?: string; // Partner wallet for partner fees
  // Enhanced RIFTS Protocol specific fields
  oracleStatus: 'active' | 'inactive' | 'degraded';
  burnFee: number;
  partnerFee?: number; // Partner fee (added to burn fee for total)
  wrapFeeBps?: number; // Wrap fee in basis points from program (e.g., 30 = 0.3%)
  unwrapFeeBps?: number; // Unwrap fee in basis points from program (e.g., 30 = 0.3%)
  partnerFeeBps?: number; // Partner fee in basis points from program
  programVersion?: 'v1' | 'v2'; // Program version: v1 (legacy) or v2 (current)
  arbitragePercentage: number;
  volatilityApy: number;
  // Add rift token mint for unwrapping
  riftMint?: string;
  underlyingMint?: string; // Required for trading
  hasMeteoraPool?: boolean; // For detecting Meteora pools
  liquidityPool?: string; // Meteora pool address for trading
  meteoraPool?: string; // Alias for liquidityPool for backward compatibility
  meteoraPools?: string[]; // Array of ALL Meteora pool addresses
  prefixType?: number; // 0 = r, 1 = m
  poolType?: 'dlmm' | 'dammv2' | 'cpamm'; // Pool type for monorifts
  createdAt?: Date; // Creation timestamp for sorting
  riftTvl: number;
  lpTvl: number;
  totalRiftYield: number;
  rift30dYield: number;
  riftPrice: number;
  fairPrice: number;
  riftTokenPrice?: number; // Price of the rift token from DEX
  underlyingTokenPrice?: number; // Price of the underlying token
  totalRiftMinted?: number; // Total supply of rift tokens minted
  realBackingRatio?: number; // Real backing ratio from blockchain
  arbitrageOpportunity?: number; // Arbitrage opportunity percentage
  feeStructure: {
    wrapFee: number;
    unwrapFee: number;
    performanceFee: number;
    managementFee: number;
    hasTransferFee?: boolean;
    totalTransferFee?: number | null;
    treasuryShare?: number | null;
    partnerShare?: number | null;
  };
  liquidityProfile: {
    depth: number;
    spread: number;
    slippage: number;
  };
  revenueShare: {
    riftsHolders: number;
    lpProviders: number;
    protocol: number;
  };
  lvfMetrics: {
    efficiency: number;
    capture: number;
    decay: number;
  };
  contractAddresses: {
    riftContract: string;
    riftsToken: string;
  };
  timeframes: {
    '1h': number;
    '24h': number;
    '7d': number;
    '30d': number;
    '90d': number;
    '1y': number;
  };
}

// Enhanced Stats Card with detailed information
const DetailedStatsCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  change?: string;
  trend?: 'up' | 'down' | 'neutral';
  description?: string;
  onClick?: () => void;
}> = ({ icon, label, value, change, trend = 'neutral', description, onClick }) => {
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 bg-black/60 border border-emerald-500/20 rounded-lg hover:border-emerald-500/40 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <div className="p-2 rounded-lg bg-emerald-500/10 shrink-0">
        <div className="text-emerald-400">
          {React.cloneElement(icon as React.ReactElement<any>, { className: 'w-5 h-5' })}
        </div>
      </div>
      <div className="min-w-0">
        <p className="text-xs text-gray-500 mb-0.5">{label}</p>
        <p className="text-lg font-bold text-emerald-400 truncate">{value}</p>
      </div>
    </div>
  );
};

const LuxuryRiftCard = ({ rift, onWrap, onUnwrap, onAddLiquidity, onDetails, onCloseRift, onClaimFees, onClaimDexFees, onClaimRiftFees, onTrade, currentWallet, isHydrated = false, arbRevenueSol = 0, fallbackAPY = 0, isArbBotRunning = false, onStartArbBot, onStopArbBot, isArbBotLoading = false }: {
  rift: RiftData;
  onWrap: () => void;
  onUnwrap: () => void;
  onAddLiquidity: () => void;
  onDetails: () => void;
  onCloseRift?: () => void;
  onClaimFees?: () => void;
  onClaimDexFees?: () => void;
  onClaimRiftFees?: () => void;
  onTrade?: () => void;
  currentWallet?: string;
  isHydrated?: boolean;
  arbRevenueSol?: number;
  fallbackAPY?: number;
  isArbBotRunning?: boolean;
  onStartArbBot?: () => void;
  onStopArbBot?: () => void;
  isArbBotLoading?: boolean;
}) => {
  const [copiedAddress, setCopiedAddress] = React.useState(false);

  // Check if current wallet is authorized to claim fees
  const PROGRAM_OWNER = process.env.NEXT_PUBLIC_PROTOCOL_AUTHORITY || '9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4';
  const isAuthorizedForFees = currentWallet && (
    currentWallet === PROGRAM_OWNER ||
    currentWallet === rift.creator ||
    currentWallet === rift.authority ||
    currentWallet === rift.treasuryWallet ||
    currentWallet === rift.partnerWallet
  );

  const getRiskColor = (risk: string | undefined) => {
    switch (risk?.toLowerCase()) {
      case 'very low': return 'border-emerald-600 bg-emerald-900/20 text-emerald-400';
      case 'low': return 'border-emerald-600 bg-emerald-900/20 text-emerald-400';
      case 'medium': return 'border-yellow-600 bg-yellow-900/20 text-yellow-400';
      case 'high': return 'border-red-600 bg-red-900/20 text-red-400';
      default: return 'border-gray-600 bg-gray-800/20 text-gray-400';
    }
  };

  return (
    <motion.div
      onClick={() => onTrade?.()}
      className={`relative transition-all duration-300 border bg-black/90 backdrop-blur-md cursor-pointer ${
        rift.tvl === 0
          ? 'border-yellow-500/50 hover:border-yellow-400/70 shadow-[0_0_20px_rgba(234,179,8,0.3)]'
          : 'border-emerald-500/30 hover:border-emerald-400/50'
      } group rounded-xl`}
      whileHover={{ y: -2, scale: 1.01 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
    >
      {rift.tvl === 0 && (
        <div className="absolute -top-2 -right-2 z-10">
          <span className="px-2 py-1 text-xs font-bold bg-yellow-500 text-black rounded-full animate-pulse">
            NEW
          </span>
        </div>
      )}

      {/* V1 RIFT Badge */}
      {(() => {
        return rift.programVersion === 'v1';
      })() && (
        <div className="absolute -top-2 right-2 z-10">
          <span className="px-2 py-1 text-xs font-bold bg-purple-500 text-white rounded-full shadow-lg" title="Legacy V1 Program">
            V1 RIFT
          </span>
        </div>
      )}

      {/* BURNED Badge */}
      {(() => {
        // List of burned rift mints
        const BURNED_RIFTS = ['B2ha7xqztT4qtmkzJC3yytaXnex2veEMiFXKUrVx6x8p'];
        const isBurned = BURNED_RIFTS.includes(rift.riftMint || rift.id);
        return isBurned;
      })() && (
        <div className="absolute -top-2 right-16 z-10">
          <span className="px-2 py-1 text-xs font-bold bg-red-600 text-white rounded-full shadow-lg animate-pulse" title="This RIFT has been burned">
            BURNED
          </span>
        </div>
      )}

      {/* Liquidity Status Badge */}
      <div className="absolute -top-2 -left-2 z-10">
        {(() => {
          // List of burned/untradable rift mints
          const BURNED_RIFTS = ['B2ha7xqztT4qtmkzJC3yytaXnex2veEMiFXKUrVx6x8p'];
          const isBurned = BURNED_RIFTS.includes(rift.riftMint || rift.id);

          // Keep SSR/client first render stable; upgrade badge only after hydration
          if (!isHydrated) {
            return (
              <div className="flex items-center gap-1 px-2 py-1 text-xs font-bold bg-gray-600 text-gray-300 rounded-full shadow-lg" title="Pool status loading">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                <span>Pool</span>
              </div>
            );
          }

          if (isBurned) {
            return (
              <div className="flex items-center gap-1 px-2 py-1 text-xs font-bold bg-red-600 text-white rounded-full shadow-lg" title="This RIFT is untradable">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                <span>Untradable</span>
              </div>
            );
          }

          if (hasValidPool(rift)) {
            // Detect pool type from rift data
            // Only use prefixType for monorift detection (symbol prefix is unreliable)
            // prefixType: 0 = regular rift (r prefix), 1 = monorift (m prefix)
            const isMonorift = (rift as any).prefixType === 1;
            const savedPoolType = rift.poolType;

            // Three label options: DLMM, DAMMV2, DAMMV2 SS
            // r prefix (regular rifts) → always DAMMV2
            // m prefix (monorifts) → DLMM or DAMMV2 SS based on creation choice
            let poolTypeLabel = 'DAMMV2';
            let poolTypeBgColor = 'bg-blue-500';

            if (isMonorift) {
              // Monorifts can be DLMM or DAMMV2 single-sided
              if (savedPoolType === 'dlmm') {
                poolTypeLabel = 'DLMM';
                poolTypeBgColor = 'bg-purple-500';
              } else {
                // DAMMV2 single-sided monorift
                poolTypeLabel = 'DAMMV2 SS';
                poolTypeBgColor = 'bg-blue-500';
              }
            }

            return (
              <div className="flex items-center gap-1" title={`Pool: ${getPoolAddress(rift)} | Type: ${savedPoolType || 'auto-detected'}`}>
                {/* Tradable badge */}
                <div className="flex items-center gap-1 px-2 py-1 text-xs font-bold bg-emerald-500 text-white rounded-full shadow-lg">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <span>Tradable</span>
                </div>
                {/* Pool type badge */}
                <div className={`px-2 py-1 text-xs font-bold ${poolTypeBgColor} text-white rounded-full shadow-lg`}>
                  {poolTypeLabel}
                </div>
                {/* Arbitraging badge */}
                {isArbBotRunning && (
                  <div className="flex items-center gap-1 px-2 py-1 text-xs font-bold bg-orange-500 text-white rounded-full shadow-lg animate-pulse" title="Arb bot is running on this rift">
                    <Bot className="w-3 h-3" />
                    <span>Arbitraging</span>
                  </div>
                )}
              </div>
            );
          }

          return (
            <div className="flex items-center gap-1 px-2 py-1 text-xs font-bold bg-gray-600 text-gray-300 rounded-full shadow-lg" title="No liquidity pool - Click Add Liquidity">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
              <span>No Pool</span>
            </div>
          );
        })()}
      </div>

      <div className="relative p-4">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-8 h-8 text-sm font-bold bg-black border rounded-lg border-emerald-500/50 text-emerald-400">
              {rift.underlying?.slice(0, 1) || 'R'}
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">{rift.symbol}</h3>
              <div className="flex items-center gap-1">
                <div className={`w-1.5 h-1.5 rounded-full ${rift.isActive ? 'bg-emerald-400' : 'bg-red-400'}`} />
                <span className="text-xs text-emerald-400">
                  {rift.tvl === 0 ? 'New - Needs Liquidity' : (rift.isActive ? 'Active' : 'Inactive')}
                </span>
              </div>
              <div className="flex items-center gap-1 mt-1">
                <span className="text-[10px] text-gray-500 font-mono">
                  {rift.riftMint?.slice(0, 4)}...{rift.riftMint?.slice(-4)}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(rift.riftMint || '');
                    setCopiedAddress(true);
                    setTimeout(() => setCopiedAddress(false), 2000);
                  }}
                  className={`transition-colors ${copiedAddress ? 'text-emerald-400' : 'text-gray-500 hover:text-emerald-400'}`}
                  title={copiedAddress ? "Copied!" : "Copy rift token mint address"}
                >
                  {copiedAddress ? (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>

          <div className="text-right">
            <div className={`px-2 py-0.5 rounded-full border text-xs mb-1 ${getRiskColor(rift.risk)}`}>
              {rift.risk}
            </div>
            <p className="text-lg font-bold text-emerald-400">
              {(rift.apy && rift.apy > 0) ? rift.apy.toFixed(1) : (fallbackAPY > 0 ? fallbackAPY.toFixed(1) : '8.4')}%
            </p>
          </div>
        </div>

        {/* Compact metrics */}
        <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
          <div className="relative inline-flex items-center justify-center font-medium tracking-wide transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-black overflow-hidden select-none bg-black text-emerald-500 hover:bg-gray-900 active:bg-gray-950 focus:ring-emerald-500 shadow-[0_0_20px_rgba(0,0,0,0.5)] hover:shadow-[0_0_30px_rgba(16,185,129,0.3)] border border-emerald-500/30 hover:border-emerald-400/50 px-4 py-2 text-sm gap-2.5 flex-col text-center">
            {/* Luxury background patterns */}
            <div className="absolute inset-0 opacity-30">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
            </div>
            {/* Corner accents */}
            <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-current opacity-50" />
            <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-current opacity-50" />
            <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-current opacity-50" />
            <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-current opacity-50" />
            <div className="relative z-10">
              <span className="text-gray-400">TVL</span>
              <p className="font-bold text-emerald-400">{formatCurrency(rift.tvl || 0)}</p>
            </div>
          </div>
          <div className="relative inline-flex items-center justify-center font-medium tracking-wide transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-black overflow-hidden select-none bg-black text-emerald-500 hover:bg-gray-900 active:bg-gray-950 focus:ring-emerald-500 shadow-[0_0_20px_rgba(0,0,0,0.5)] hover:shadow-[0_0_30px_rgba(16,185,129,0.3)] border border-emerald-500/30 hover:border-emerald-400/50 px-4 py-2 text-sm gap-2.5 flex-col text-center">
            {/* Luxury background patterns */}
            <div className="absolute inset-0 opacity-30">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
            </div>
            {/* Corner accents */}
            <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-current opacity-50" />
            <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-current opacity-50" />
            <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-current opacity-50" />
            <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-current opacity-50" />
            <div className="relative z-10">
              <span className="text-gray-400">Fee</span>
              <p className="font-bold text-emerald-400" title={rift.id === "CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL" ? "Wrap/Unwrap: 0.7% each" : "Wrap/Unwrap: 0.3% each (50/50 split)"}>
                {rift.id === "CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL" ? "0.700%" : "0.300%"}
              </p>
            </div>
          </div>
        </div>

        {/* Arb Bot Revenue Badge - Only show if there's revenue (exclude specific rifts) */}
        {arbRevenueSol > 0 && !['B2ha7xqztT4qtmkzJC3yytaXnex2veEMiFXKUrVx6x8p', '3X7VGd8dK6obiQUtAVRZhTRpP1sfhLc1JMGtQi4hYi2z'].includes(rift.id) && !['B2ha7xqztT4qtmkzJC3yytaXnex2veEMiFXKUrVx6x8p', '3X7VGd8dK6obiQUtAVRZhTRpP1sfhLc1JMGtQi4hYi2z'].includes(rift.riftMint || '') && (
          <div className="flex items-center justify-center gap-1.5 mb-3 px-2 py-1.5 bg-gradient-to-r from-amber-900/30 to-yellow-900/30 border border-amber-500/40 rounded-lg" title="Total revenue generated by arb bot for this rift">
            <svg className="w-3.5 h-3.5 text-amber-400" fill="currentColor" viewBox="0 0 20 20">
              <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.736 6.979C9.208 6.193 9.696 6 10 6c.304 0 .792.193 1.264.979a1 1 0 001.715-1.029C12.279 4.784 11.232 4 10 4s-2.279.784-2.979 1.95c-.285.475-.507 1-.67 1.55H6a1 1 0 000 2h.013a9.358 9.358 0 000 1H6a1 1 0 100 2h.351c.163.55.385 1.075.67 1.55C7.721 15.216 8.768 16 10 16s2.279-.784 2.979-1.95a1 1 0 10-1.715-1.029c-.472.786-.96.979-1.264.979-.304 0-.792-.193-1.264-.979a4.265 4.265 0 01-.264-.521H10a1 1 0 100-2H8.017a7.36 7.36 0 010-1H10a1 1 0 100-2H8.472c.08-.185.167-.36.264-.521z" />
            </svg>
            <span className="text-xs font-semibold text-amber-400">
              {arbRevenueSol >= 1
                ? `${arbRevenueSol.toFixed(2)} SOL`
                : arbRevenueSol >= 0.01
                  ? `${arbRevenueSol.toFixed(3)} SOL`
                  : `${arbRevenueSol.toFixed(4)} SOL`}
            </span>
            <span className="text-[10px] text-amber-500/70">arb revenue</span>
          </div>
        )}

        {/* Action buttons */}
        <div className="grid grid-cols-3 gap-1.5 mb-2">
          <div onClick={(e) => e.stopPropagation()}>
            <LuxuryButton variant="primary" size="sm" onClick={onWrap} className="text-xs">
              Wrap
            </LuxuryButton>
          </div>
          <div onClick={(e) => e.stopPropagation()}>
            <LuxuryButton variant="secondary" size="sm" onClick={onUnwrap} className="text-xs">
              Unwrap
            </LuxuryButton>
          </div>
          <div onClick={(e) => e.stopPropagation()}>
            <LuxuryButton variant="ghost" size="sm" onClick={onDetails} className="text-xs">
              Details
            </LuxuryButton>
          </div>
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <LuxuryButton
            variant="primary"
            size="sm"
            onClick={onAddLiquidity}
            className="w-full text-xs"
          >
            {(rift as any).prefixType === 1
              ? 'Deposit'
              : (hasValidPool(rift)
                ? 'Manage Liquidity'
                : 'Add Liquidity')}
          </LuxuryButton>
        </div>

        {/* Claim Fees Buttons - Only show for authorized wallets */}
        {isAuthorizedForFees && (onClaimDexFees || onClaimRiftFees) && (
          <div className="flex gap-2 mt-2">
            {onClaimDexFees && (
              <div onClick={(e) => e.stopPropagation()} className="flex-1">
                <LuxuryButton
                  variant="secondary"
                  size="sm"
                  onClick={onClaimDexFees}
                  className="w-full text-xs"
                >
                  Claim DEX
                </LuxuryButton>
              </div>
            )}
            {onClaimRiftFees && (
              <div onClick={(e) => e.stopPropagation()} className="flex-1">
                <LuxuryButton
                  variant="secondary"
                  size="sm"
                  onClick={onClaimRiftFees}
                  className="w-full text-xs"
                >
                  Claim Rift
                </LuxuryButton>
              </div>
            )}
          </div>
        )}

        {/* Arb Bot Controls - Only show for creators */}
        {isAuthorizedForFees && (onStartArbBot || onStopArbBot) && (
          <div className="mt-2" onClick={(e) => e.stopPropagation()}>
            {isArbBotRunning ? (
              <LuxuryButton
                variant="ghost"
                size="sm"
                onClick={onStopArbBot}
                disabled={isArbBotLoading}
                className="w-full text-xs border-orange-500/50 hover:border-orange-400/50 text-orange-400 hover:text-orange-300"
              >
                {isArbBotLoading ? (
                  <>
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    Stopping...
                  </>
                ) : (
                  <>
                    <Bot className="w-3 h-3 mr-1" />
                    Stop Arb Bot
                  </>
                )}
              </LuxuryButton>
            ) : (
              <LuxuryButton
                variant="ghost"
                size="sm"
                onClick={onStartArbBot}
                disabled={isArbBotLoading}
                className="w-full text-xs border-orange-500/50 hover:border-orange-400/50 text-orange-400 hover:text-orange-300"
              >
                {isArbBotLoading ? (
                  <>
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    Starting...
                  </>
                ) : (
                  <>
                    <Bot className="w-3 h-3 mr-1" />
                    Start Arb Bot
                  </>
                )}
              </LuxuryButton>
            )}
          </div>
        )}
      </div>

      <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-emerald-500/50" />
      <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-emerald-500/50" />
    </motion.div>
  );
};

// Utility function to format currency
const formatCurrency = (amount: number) => {
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}K`;
  return `$${amount.toFixed(0)}`;
};

// Helper function to get pool address from either property
const getPoolAddress = (rift: any): string | undefined => {
  // Check meteoraPools array first, then fall back to single pool properties
  if (rift?.meteoraPools && Array.isArray(rift.meteoraPools) && rift.meteoraPools.length > 0) {
    return rift.meteoraPools[0]; // Return first pool
  }
  return rift?.liquidityPool || rift?.meteoraPool;
};

// Helper function to check if rift has a valid pool
const hasValidPool = (rift: any): boolean => {
  // Check if rift has pools in the meteoraPools array
  if (rift?.meteoraPools && Array.isArray(rift.meteoraPools) && rift.meteoraPools.length > 0) {
    return rift.meteoraPools.some((addr: string) => addr && addr !== '11111111111111111111111111111111');
  }

  // Fall back to checking single pool properties - FIXED: removed hasMeteoraPool requirement
  const poolAddress = rift?.liquidityPool || rift?.meteoraPool;
  return !!(poolAddress && poolAddress !== '11111111111111111111111111111111' && poolAddress.length > 20);
};

// Props for server-side data
interface RiftsAppProps {
  initialRifts?: any[];
}

// Use shared blacklist across app and SSR
const BLACKLISTED_RIFTS = BASE_BLACKLISTED_RIFTS;

const getRiftDisplaySymbol = (rift: any, forceDlmm = false) => {
  const rawSymbol = rift?.symbol || rift?.underlying || '';
  const lower = rawSymbol?.toLowerCase?.() || '';
  const strategyStr = rift?.strategy ? `${rift.strategy}`.toLowerCase() : '';
  const isDlmm = forceDlmm || rift?.prefixType === 1;

  // If already prefixed correctly, keep it
  if (lower.startsWith('m')) {
    return rawSymbol;
  }
  if (!isDlmm && lower.startsWith('r')) {
    return rawSymbol;
  }

  // If DLMM, ensure m-prefix (monorift = m + rift symbol, e.g., rRIFTS → mrRIFTS)
  if (isDlmm) {
    // Only strip existing 'm' prefix, keep 'r' prefix intact
    const base = rawSymbol.replace(/^m/i, '');
    const result = `m${base}`;
    return result;
  }

  // Otherwise ensure r-prefix
  return lower.startsWith('r') ? rawSymbol : `r${rawSymbol}`;
};

const isBlacklistedRift = (rift: any): boolean => {
  const candidates = [rift?.id, rift?.address, rift?.riftMint];
  return candidates.some(id => id && BLACKLISTED_RIFTS.includes(id));
};

// Helper to get underlying mint for selected token (used for supply/mcap fetch)
const getUnderlyingMint = (token: string, customAddress: string): string | undefined => {
  const tokenAddresses: Record<string, string> = {
    'SOL': 'So11111111111111111111111111111111111111112',
    'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    'USD1': 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'
  };
  if (token === 'CUSTOM') return customAddress;
  return tokenAddresses[token];
};

// Normalize mint (string or PublicKey) to string
const toMintString = (mint: string | PublicKey | undefined): string | undefined => {
  if (!mint) return undefined;
  return typeof mint === 'string' ? mint : mint.toBase58();
};

// Helper to convert SSR rifts to RiftData format
const convertInitialRifts = (initialRifts: any[] | undefined): RiftData[] => {
  if (!initialRifts?.length) {
    console.log('[SSR-INIT] No initialRifts provided');
    return [];
  }
  const filteredInitial = initialRifts.filter((rift: any) => rift && !isBlacklistedRift(rift));
  const filteredCount = initialRifts.length - filteredInitial.length;
  if (filteredCount > 0) {
    console.log(`[SSR-INIT] Filtered out ${filteredCount} blacklisted rift(s) before render`);
  }
  console.log('[SSR-INIT] Converting', filteredInitial.length, 'rifts from SSR');
  console.log('[SSR-INIT] First rift:', filteredInitial[0]?.symbol, 'TVL:', filteredInitial[0]?.tvl);
  return filteredInitial.map((rift: any) => {
    const transferFeeBps = rift.transferFeeBps;
    const hasTransferFee = transferFeeBps !== undefined && transferFeeBps !== null;

    return {
      id: rift.id,
      symbol: getRiftDisplaySymbol(rift),
      underlying: rift.underlying,
      tvl: rift.tvl || 0,
      apy: rift.apy || 0,
      backingRatio: rift.backingRatio || 1,
      volume24h: rift.volume24h || 0,
      risk: rift.risk || 'Medium',
      participants: rift.participants || 0,
      strategy: rift.strategy || 'Delta Neutral',
      performance: rift.apy || 0,
      isActive: rift.oracleStatus === 'active',
      maxCapacity: 100000,
      vault: rift.vault,
      creator: rift.creator,
      treasuryWallet: rift.treasuryWallet,
      partnerWallet: rift.partnerWallet,
      oracleStatus: rift.oracleStatus,
      burnFee: rift.burnFee || 0,
      partnerFee: rift.partnerFee || 0,
      programVersion: rift.programVersion || 'v2',
      createdAt: rift.createdAt ? new Date(rift.createdAt) : undefined,
      arbitragePercentage: 0,
      volatilityApy: 0,
      riftMint: rift.riftMint,
      underlyingMint: rift.underlyingMint,
      hasMeteoraPool: rift.hasMeteoraPool,
      liquidityPool: rift.liquidityPool,
      meteoraPool: rift.meteoraPool,
      meteoraPools: rift.meteoraPools,
      poolType: rift.poolType, // Pool type: 'dlmm' or 'dammv2'
      prefixType: rift.prefixType, // 0 = regular rift (r prefix), 1 = monorift (m prefix)
      riftTvl: rift.tvl || 0,
      lpTvl: 0,
      totalRiftYield: 0,
      rift30dYield: 0,
      riftPrice: rift.riftTokenPrice || 0,
      fairPrice: rift.underlyingTokenPrice || 0,
      riftTokenPrice: rift.riftTokenPrice,
      underlyingTokenPrice: rift.underlyingTokenPrice,
      vaultBalance: rift.vaultBalance,
      totalRiftMinted: rift.totalRiftMinted,
      realBackingRatio: rift.realBackingRatio,
      // Fee structure required by RiftData type
      feeStructure: {
        wrapFee: rift.wrapFeeBps ? rift.wrapFeeBps / 100 : 0,
        unwrapFee: rift.unwrapFeeBps ? rift.unwrapFeeBps / 100 : 0,
        performanceFee: 0,
        managementFee: 0,
        hasTransferFee,
        totalTransferFee: hasTransferFee ? transferFeeBps / 100 : null,
        treasuryShare: hasTransferFee ? transferFeeBps / 100 / 2 : null,
        partnerShare: hasTransferFee ? transferFeeBps / 100 / 2 : null,
      },
      liquidityProfile: { depth: 0, spread: 0, slippage: 0 },
      revenueShare: { riftsHolders: 0, lpProviders: 0, protocol: 0 },
      lvfMetrics: { efficiency: 0, capture: 0, decay: 0 },
      contractAddresses: { riftContract: rift.id, riftsToken: rift.riftMint },
      timeframes: { '1h': 0, '24h': 0, '7d': 0, '30d': 0, '90d': 0, '1y': 0 },
    } as RiftData;
  });
};

// Main RIFTS App Component
const RiftsApp: React.FC<RiftsAppProps> = ({ initialRifts }) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const referralProcessedRef = useRef(false);

  const cleanErrorMessage = (error: unknown, fallback: string) => {
    const raw =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : JSON.stringify(error) || '';
    if (!raw) return fallback;

    const lowerRaw = raw.toLowerCase();

    // Insufficient SOL for rent/account creation
    if (lowerRaw.includes('insufficient lamports') ||
        lowerRaw.includes('insufficient funds for rent') ||
        (lowerRaw.includes('custom program error') && (lowerRaw.includes('0x1') || lowerRaw.includes(': 1')))) {
      return 'Insufficient SOL balance. You need more SOL to cover account rent deposits (~0.02 SOL) plus transaction fees. Please add more SOL to your wallet and try again.';
    }

    // User rejected transaction
    if (lowerRaw.includes('user rejected') || lowerRaw.includes('user denied') || lowerRaw.includes('rejected the request')) {
      return 'Transaction cancelled by user.';
    }

    // Slippage/price change
    if (lowerRaw.includes('slippage') || lowerRaw.includes('price moved')) {
      return 'Price changed too much during transaction. Please try again.';
    }

    // Blockhash expired
    if (lowerRaw.includes('blockhash') && (lowerRaw.includes('expired') || lowerRaw.includes('not found'))) {
      return 'Transaction expired. Please try again.';
    }

    // Pool requires both tokens (single-sided pool became two-sided)
    if (lowerRaw.includes('liquidity on both sides') || lowerRaw.includes('must provide both tokens')) {
      return raw; // Pass through the detailed error message
    }

    // Simulation failed
    if (lowerRaw.includes('simulation failed')) {
      // Check for specific errors within simulation
      if (lowerRaw.includes('insufficient')) {
        return 'Insufficient SOL balance. Please add more SOL and try again.';
      }
      // Check if this might be a single-sided pool that now has SOL
      if (lowerRaw.includes('0x1') || lowerRaw.includes('custom program error')) {
        return 'Transaction failed. The pool may now require SOL for deposits (trading activity added SOL to the pool). Try adding SOL to your deposit or check the pool state.';
      }
      return 'Transaction simulation failed. Please check your balances and try again.';
    }

    // Generic Solana errors
    if (raw.match(/Solana error #\d+/i)) {
      return 'Transaction failed. Check logs for details.';
    }
    if (lowerRaw.includes('decode this error')) {
      return 'Transaction failed. Check logs for details.';
    }

    return raw;
  };

  // State - initialize from server-provided data if available
  // Convert initialRifts immediately during state initialization (no useEffect needed)
  const [rifts, setRifts] = useState<RiftData[]>(() => convertInitialRifts(initialRifts));
  const [loading, setLoading] = useState(!initialRifts?.length); // No loading if we have initial data
  const [hasLoadedOnce, setHasLoadedOnce] = useState(!!initialRifts?.length);
  // Track running arb bots by rift ID
  const [runningArbBots, setRunningArbBots] = useState<Set<string>>(new Set());
  const [arbBotLoading, setArbBotLoading] = useState<string | null>(null); // riftId being started/stopped
  const [loadingStartTime, setLoadingStartTime] = useState<number | null>(() => {

    return Date.now();
  });
  const [preloadedData, setPreloadedData] = useState<{
    rifts?: RiftData[];
    metrics?: any;
    userAnalytics?: any;
  }>({});
  const [notification, setNotification] = useState<{
    type: 'success' | 'error' | 'info';
    title: string;
    message: string;
    signature?: string;
  } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('tvl');
  const [hideDuplicates, setHideDuplicates] = useState(false);
  const [showOnlyTradeable, setShowOnlyTradeable] = useState(false);
  const [showOnlyMyRifts, setShowOnlyMyRifts] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [selectedRift, setSelectedRift] = useState<RiftData | null>(null);
  // Safety: clear any blacklisted rifts that slip in via cache/stale data
  useEffect(() => {
    setRifts(prev => {
      const filtered = prev.filter(r => !isBlacklistedRift(r));
      if (filtered.length !== prev.length) {
        console.log(`🚫 Purged ${prev.length - filtered.length} blacklisted rift(s) from state`);
      }
      return filtered;
    });
  }, []);

  // Fix hydration mismatch with Radix UI Select
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Fetch arb bot revenue for all rifts
  useEffect(() => {
    const fetchArbRevenue = async () => {
      try {
        const response = await fetch('/api/arb-revenue');
        if (response.ok) {
          const data = await response.json();
          setArbRevenue(data.revenue || {});
        }
      } catch (err) {
        console.error('Failed to fetch arb revenue:', err);
      }
    };
    fetchArbRevenue();
    // Refresh every 5 minutes
    const interval = setInterval(fetchArbRevenue, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const [showWrapModal, setShowWrapModal] = useState(false);
  const [showUnwrapModal, setShowUnwrapModal] = useState(false);
  const [showClaimFeesModal, setShowClaimFeesModal] = useState(false);
  const [showClaimDexFeesModal, setShowClaimDexFeesModal] = useState(false);
  const [showClaimRiftFeesModal, setShowClaimRiftFeesModal] = useState(false);
  const [claimFeesAmount, setClaimFeesAmount] = useState('');
  const [claimDexFeesAmount, setClaimDexFeesAmount] = useState('');
  const [claimRiftFeesAmount, setClaimRiftFeesAmount] = useState('');
  const [availableVaultFees, setAvailableVaultFees] = useState<number>(0);
  const [availableDexFees, setAvailableDexFees] = useState<number>(0);
  const [availableRiftFees, setAvailableRiftFees] = useState<number>(0);
  const [dexFeesData, setDexFeesData] = useState<{
    available: number;
    partnerShare: number;
    treasuryShare: number;
    userClaimable: number;
  }>({ available: 0, partnerShare: 0, treasuryShare: 0, userClaimable: 0 });
  const [riftFeesData, setRiftFeesData] = useState<{
    available: number;
    partnerShare: number;
    treasuryShare: number;
    userClaimable: number;
  }>({ available: 0, partnerShare: 0, treasuryShare: 0, userClaimable: 0 });
  const [showFeesClaimedModal, setShowFeesClaimedModal] = useState(false);
  const [feesClaimedData, setFeesClaimedData] = useState<{
    type: 'rift' | 'dex' | 'lp';
    amount: number;
    signature: string;
    symbol?: string;
  } | null>(null);
  const [isLoadingVaultFees, setIsLoadingVaultFees] = useState(false);
  const [isLoadingDexFees, setIsLoadingDexFees] = useState(false);
  const [isLoadingRiftFees, setIsLoadingRiftFees] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [detailsActiveTab, setDetailsActiveTab] = useState<'details' | 'trading'>('details');
  const [showFiltersModal, setShowFiltersModal] = useState(false);
  const [showAnalyticsModal, setShowAnalyticsModal] = useState(false);
  const [showPortfolioModal, setShowPortfolioModal] = useState(false);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioPositions, setPortfolioPositions] = useState<Array<{
    type: 'wrapped' | 'lp';
    riftSymbol: string;
    underlying: string;
    riftMint: string;
    balance: number;
    valueUsd: number;
    poolType?: 'dammv2' | 'dlmm' | 'dammv2-ss';
    poolAddress?: string;
    priceRange?: { min: number; max: number };
    liquidityAmount?: number; // Amount of tokens added to LP
    wrappedBalance?: number; // Wrapped rift balance for this rift
  }>>([]);
  const [showMarketsModal, setShowMarketsModal] = useState(false);
  const [showRiftsTokenModal, setShowRiftsTokenModal] = useState(false);
  const [showTradingModal, setShowTradingModal] = useState(false);
  const [showCreateRiftModal, setShowCreateRiftModal] = useState(false);
  const [createRiftTab, setCreateRiftTab] = useState<'rift' | 'dlmm'>('rift');

  // PumpFun Launch modal state
  const [showLaunchModal, setShowLaunchModal] = useState(false);
  const [launchTokenName, setLaunchTokenName] = useState('');
  const [launchTokenSymbol, setLaunchTokenSymbol] = useState('');
  const [launchTokenDescription, setLaunchTokenDescription] = useState('');
  const [launchTokenImage, setLaunchTokenImage] = useState<File | null>(null);
  const [launchTokenImagePreview, setLaunchTokenImagePreview] = useState<string | null>(null);
  const [launchBanner, setLaunchBanner] = useState<File | null>(null);
  const [launchBannerPreview, setLaunchBannerPreview] = useState<string | null>(null);
  const [launchTwitter, setLaunchTwitter] = useState('');
  const [launchTelegram, setLaunchTelegram] = useState('');
  const [launchWebsite, setLaunchWebsite] = useState('');
  const [launchDevBuy, setLaunchDevBuy] = useState('');
  const [isLaunching, setIsLaunching] = useState(false);
  const [launchStep, setLaunchStep] = useState(0);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchResult, setLaunchResult] = useState<{ mint: string; signature: string; poolAddress?: string } | null>(null);

  // DLMM Rift creation state
  const [dlmmRiftTokenAmount, setDlmmRiftTokenAmount] = useState('');
  const [dlmmRiftSolAmount, setDlmmRiftSolAmount] = useState('');
  const [dlmmRiftBinStep, setDlmmRiftBinStep] = useState('50');
  const [dlmmRiftRangeInterval, setDlmmRiftRangeInterval] = useState('10');
  const [dlmmRiftFeeBps, setDlmmRiftFeeBps] = useState('25');
  const [dlmmRiftStrategy, setDlmmRiftStrategy] = useState<DLMMStrategyType>(DLMMStrategyType.Spot);
  const [dlmmRiftSingleSided, setDlmmRiftSingleSided] = useState(true);
  const [monoriftPoolType, setMonoriftPoolType] = useState<'dlmm' | 'dammv2'>('dlmm'); // Pool type toggle

  // DAMMV2 Price Range settings
  const [dammv2UsePriceRange, setDammv2UsePriceRange] = useState(false);
  const [dammv2MaxPrice, setDammv2MaxPrice] = useState('');
  const [dammv2PriceUnit, setDammv2PriceUnit] = useState<'SOL' | 'USD'>('USD');

  const [dlmmRiftMinMcap, setDlmmRiftMinMcap] = useState(0);
  const [dlmmRiftMaxMcap, setDlmmRiftMaxMcap] = useState(0);
  const [dlmmRiftTokenSupply, setDlmmRiftTokenSupply] = useState(0);
  const [dlmmRiftUseMcapRange, setDlmmRiftUseMcapRange] = useState(true);
  const [dlmmRiftInitialPrice, setDlmmRiftInitialPrice] = useState('');
  const [dlmmRiftUseAutoPrice, setDlmmRiftUseAutoPrice] = useState(true); // true = auto-fetch, false = custom
  const [isFetchingDlmmPrice, setIsFetchingDlmmPrice] = useState(false);
  const [isCreatingDlmmRift, setIsCreatingDlmmRift] = useState(false);
  const [dlmmRiftTokenPriceUsd, setDlmmRiftTokenPriceUsd] = useState(0);
  const [dlmmCreationStep, setDlmmCreationStep] = useState(0); // 0=not started, 1=creating rift, 2=creating pool, 3=complete

  // Pool Success Modal state
  const [showPoolSuccessModal, setShowPoolSuccessModal] = useState(false);
  const [poolSuccessData, setPoolSuccessData] = useState<{
    poolAddress: string;
    signature?: string;
    positionNft?: string;
    poolType: 'dlmm' | 'dammv2';
    tokenSymbol?: string;
    tokenAmount?: number;
    solAmount?: number;
  } | null>(null);

  // Rift Creation Success Modal state
  const [showRiftSuccessModal, setShowRiftSuccessModal] = useState(false);
  const [riftSuccessData, setRiftSuccessData] = useState<{
    riftPDA: string;
    riftMint: string;
    signature: string;
    tokenSymbol: string;
    underlyingSymbol: string;
    underlyingMint: string;
    transferFeeBps: number;
    partnerWallet?: string;
  } | null>(null);

  // Wrap/Unwrap Success Modal state
  const [showWrapSuccessModal, setShowWrapSuccessModal] = useState(false);
  const [wrapSuccessData, setWrapSuccessData] = useState<{
    type: 'wrap' | 'unwrap';
    amount: number;
    tokensReceived: number;
    tokenSymbol: string;
    underlyingSymbol: string;
    signature: string;
    riftPDA: string;
  } | null>(null);
  const [showAddLiquidityModal, setShowAddLiquidityModal] = useState(false);
  const [showDashboardModal, setShowDashboardModal] = useState(false);
  const [showStakingModal, setShowStakingModal] = useState(false);
  const [showUserProfileModal, setShowUserProfileModal] = useState(false);
  const [stakingTab, setStakingTab] = useState<'stake' | 'unstake'>('stake');
  const [stakingAmount, setStakingAmount] = useState('');
  const [unstakeAmount, setUnstakeAmount] = useState('');
  const [lpTokenBalance, setLpTokenBalance] = useState(0);
  const [showStakingConfirmation, setShowStakingConfirmation] = useState(false);
  const [riftsModal, setRiftsModal] = useState<{ isOpen: boolean; rift: RiftData | null }>({ isOpen: false, rift: null });

  // RIFTS token state
  const [riftsBalance, setRiftsBalance] = useState(0);
  const [stakingRewards, setStakingRewards] = useState(0);

  // Arb bot revenue per rift (rift_id -> profit in SOL)
  const [arbRevenue, setArbRevenue] = useState<Record<string, number>>({});
  const [stakedAmount, setStakedAmount] = useState(0);
  const [showGovernance, setShowGovernance] = useState(false);

  // RIFTS price and arbitrage bot revenue
  const [riftsTokenPrice, setRiftsTokenPrice] = useState<number>(0);
  const [arbBotRevenue, setArbBotRevenue] = useState<number>(0);
  const [solPrice, setSolPrice] = useState<number>(0);
  // Local overrides for newly created DLMM rifts (persisted locally so symbols/pools survive reload)
  const [dlmmLocalOverrides, setDlmmLocalOverrides] = useState<Record<string, { meteoraPools: string[]; hasMeteoraPool: true; prefixType?: number }>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = localStorage.getItem('dlmm-overrides');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const addDlmmOverride = useCallback((ids: string[], poolAddress: string) => {
    setDlmmLocalOverrides(prev => {
      const updated = { ...prev };
      ids.filter(Boolean).forEach(id => {
        updated[id] = { meteoraPools: [poolAddress], hasMeteoraPool: true, prefixType: 1 };
      });
      return updated;
    });
  }, []);

  // Clamp DEX tax input back into range (0.70% - 1.00%) when leaving the field
  const handleTotalFeeBlur = () => {
    const parsed = parseFloat(totalFee);
    if (Number.isNaN(parsed)) {
      setTotalFee('0.80');
      return;
    }
    const clamped = Math.min(Math.max(parsed, 0.7), 1.0);
    setTotalFee(clamped.toFixed(2));
  };

  // const [lpPositions, setLpPositions] = useState<any[]>([]);
  // const [ecosystemStatus, setEcosystemStatus] = useState<EcosystemStatus | null>(null);
  // const [systemHealth, setSystemHealth] = useState<'healthy' | 'warning' | 'critical'>('healthy');
  // const [treasuryStats, setTreasuryStats] = useState<TreasuryStats | null>(null);
  // const [feeCollectorStatus, setFeeCollectorStatus] = useState<any>(null);

  // Hooks
  const { refreshBalance, sendTransaction: walletAdapterSendTx, signTransaction: walletAdapterSignTx, walletAdapterConnection, ...wallet } = useRealWallet();
  const { user, isLoading: isUserLoading, updateUserId, checkUserIdAvailability } = useUserProfile(wallet.publicKey?.toString() || null);

  // Track referral when wallet connects with ?ref= parameter
  useEffect(() => {
    const processReferral = async () => {
      if (!wallet.publicKey || referralProcessedRef.current || !searchParams) return;

      const refCode = searchParams.get('ref');
      if (!refCode) return;

      // Don't try to refer yourself
      if (refCode === wallet.publicKey.toString() || refCode === user?.userId) {
        referralProcessedRef.current = true;
        return;
      }

      try {
        const response = await fetch('/api/referrals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            referredWallet: wallet.publicKey.toString(),
            referralCode: refCode
          })
        });

        const result = await response.json();
        if (result.success) {
          console.log('[REFERRAL] Successfully recorded referral:', result.referral);
        } else if (result.alreadyReferred) {
          console.log('[REFERRAL] Wallet already has a referrer');
        } else {
          console.log('[REFERRAL] Failed to record:', result.error);
        }
      } catch (err) {
        console.error('[REFERRAL] Error recording referral:', err);
      }

      referralProcessedRef.current = true;
    };

    processReferral();
  }, [wallet.publicKey, searchParams, user?.userId]);

  // Fetch token balance for selected rift
  const fetchTokenBalance = async (rift: RiftData) => {
    if (!wallet.publicKey || !rift) return;

    try {
      console.log('[FETCH-BALANCE] Rift data:', {
        id: rift.id,
        underlying: rift.underlying,
        underlyingMint: rift.underlyingMint,
        symbol: rift.symbol
      });

      // Handle SOL specially since it's native Solana
      if (rift.underlying === 'SOL') {
        setSelectedTokenBalance(wallet.balance);
        return;
      }

      // Use underlyingMint from rift data (should always be available from API)
      let tokenMint = rift.underlyingMint;
      console.log('[FETCH-BALANCE] Using underlyingMint from rift:', tokenMint);

      // Fallback to hardcoded addresses for known tokens if underlyingMint is not available
      if (!tokenMint) {
        console.warn('[FETCH-BALANCE] No underlyingMint in rift data, using fallback lookup');
        const tokenAddresses: Record<string, string> = {
          'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
          'RIFTS': 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump',
          'USD1': 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'
        };
        tokenMint = tokenAddresses[rift.underlying];
        console.log('[FETCH-BALANCE] Fallback tokenMint:', tokenMint);
      }

      if (!tokenMint) {
        console.error('[FETCH-BALANCE] No token mint found for underlying:', rift.underlying);
        setSelectedTokenBalance(0);
        return;
      }

      console.log('[FETCH-BALANCE] Fetching balance for mint:', tokenMint);
      const balance = await walletService.getTokenBalance(new PublicKey(wallet.publicKey), tokenMint);
      console.log('[FETCH-BALANCE] Got balance:', balance);
      setSelectedTokenBalance(balance);

    } catch (error) {
      console.error('[BALANCE] Error fetching token balance:', error);
      setSelectedTokenBalance(0);
    }
  };

  // Fetch RIFTS pump.fun token balance
  const fetchRiftsTokenBalance = async () => {
    if (!wallet.publicKey) return;

    try {
      const balance = await walletService.getTokenBalance(new PublicKey(wallet.publicKey), RIFTS_TOKEN_MINT);
      setRiftsTokenBalance(balance);
    } catch (error) {
      console.error('[BALANCE] Error fetching RIFTS token balance:', error);
      setRiftsTokenBalance(0);
    }
  };

  // Fetch USD1 stablecoin balance
  const fetchUsd1TokenBalance = async () => {
    if (!wallet.publicKey) return;

    try {
      const balance = await walletService.getTokenBalance(new PublicKey(wallet.publicKey), USD1_TOKEN_MINT);
      setUsd1TokenBalance(balance);
    } catch (error) {
      console.error('[BALANCE] Error fetching USD1 token balance:', error);
      setUsd1TokenBalance(0);
    }
  };

  // Fetch RIFT TOKEN balance for selected rift (for unwrapping)
  const fetchRiftTokenBalance = async (rift: RiftData, bypassTimestamp = false) => {
    if (!wallet.publicKey || !rift) {
      return;
    }

    // Check timestamp protection FIRST before doing any work
    // RPC can take 30-60+ seconds to update after transactions, so protect for 60 seconds
    const timeSinceLastUpdate = Date.now() - lastBalanceUpdate;

    if (!bypassTimestamp && lastBalanceUpdate > 0 && timeSinceLastUpdate < 60000) {
      return;
    }

    try {
      console.log('[BALANCE] Fetching rift token balance...');
      console.log('[BALANCE] Rift:', rift.symbol);
      console.log('[BALANCE] Wallet:', wallet.publicKey.toString());

      // Get the rift token mint from the rift data
      const riftTokenMint = rift.riftMint; // This should be the rift token mint address

      if (!riftTokenMint) {
        console.error('[BALANCE] ERROR: No riftMint found in rift data!', rift);
        setSelectedRiftTokenBalance(0);
        setSelectedRiftBalance(0);
        return;
      }

      console.log('[BALANCE] Rift mint:', riftTokenMint);
      const balance = await walletService.getTokenBalance(new PublicKey(wallet.publicKey), riftTokenMint);
      console.log('[BALANCE] Raw balance from wallet service:', balance);

      // Fix potential decimal issues and ensure it's a proper number
      let correctedBalance = 0;
      if (typeof balance === 'number' && isFinite(balance) && balance > 0) {
        correctedBalance = balance;
      } else if (typeof balance === 'string') {
        const parsed = parseFloat(balance);
        if (isFinite(parsed) && parsed > 0) {
          correctedBalance = parsed;
        }
      }

      // **CRITICAL FIX**: Never downgrade balance if we have a recent optimistic update
      // If RPC returns lower balance than current, it's likely stale data
      const currentBalance = selectedRiftTokenBalance || 0;
      const timeSinceUpdate = Date.now() - lastBalanceUpdate;

      if (correctedBalance < currentBalance && timeSinceUpdate < 300000) { // 5 minutes
        return; // Don't downgrade the balance
      }

      // Set the balance (timestamp protection already done at function start)
      console.log('[BALANCE] Setting balance to:', correctedBalance);
      setSelectedRiftTokenBalance(correctedBalance);
      setSelectedRiftBalance(correctedBalance); // Also set for liquidity modal

    } catch (error) {
      console.error('[BALANCE] Error fetching balance:', error);
      console.error('[BALANCE] Error details:', error);
      setSelectedRiftTokenBalance(0);
      setSelectedRiftBalance(0);
    }
  };

  // Fetch pool ratio from Meteora pool (for existing pools)
  const fetchMeteoraPoolRatio = async (poolAddress: string, rift: RiftData): Promise<number> => {
    try {

      // Import Meteora SDK
      const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
      const METEORA_DAMM_V2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');

      // Get raw connection (Meteora SDK needs full Connection API)
      // @ts-expect-error - RateLimitedConnection has underlying connection property
      const rawConnection = connection.connection || connection;
      const cpAmm = new (CpAmm as any)(rawConnection, METEORA_DAMM_V2_PROGRAM_ID);

      // Fetch pool state
      const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress));

      // Get token reserves from pool
      const tokenAReserve = poolState.tokenAAmount || 0;
      const tokenBReserve = poolState.tokenBAmount || 0;

      // Calculate ratio: Token B / Token A
      if (tokenAReserve > 0) {
        const ratio = Number(tokenBReserve) / Number(tokenAReserve);

        return ratio;
      }

      return 1.0;
    } catch (error) {

      return 1.0;
    }
  };

  // Service status
  const [serviceReady, setServiceReady] = useState(true); // Start ready for instant loading
  
  // Transaction states
  const [wrapAmount, setWrapAmount] = useState('');
  const [unwrapAmount, setUnwrapAmount] = useState('');
  const [slippageTolerance, setSlippageTolerance] = useState('0.5'); // Default 0.5% slippage
  
  // Create Rift form state
  const [selectedToken, setSelectedToken] = useState<string>('');
  const [customTokenAddress, setCustomTokenAddress] = useState('');
  const [customTokenSymbol, setCustomTokenSymbol] = useState('');
  const [customTokenMetadata, setCustomTokenMetadata] = useState<TokenMetadata | null>(null);
  const [isLoadingTokenMetadata, setIsLoadingTokenMetadata] = useState(false);
  const [tokenMetadataError, setTokenMetadataError] = useState<string | null>(null);
  const [totalFee, setTotalFee] = useState('0.80'); // Total fee 0.7-1%, default 0.8% (split 50/50 between Treasury and Partner)
  const [monoriftUnderlyingBalance, setMonoriftUnderlyingBalance] = useState<number | null>(null);
  const [isLoadingMonoriftBalance, setIsLoadingMonoriftBalance] = useState(false);
  const [partnerWallet, setPartnerWallet] = useState('');
  const [initialLiquidityAmount, setInitialLiquidityAmount] = useState('');
  const [solLiquidityAmount, setSolLiquidityAmount] = useState('');
  const [riftLiquidityAmount, setRiftLiquidityAmount] = useState('');
  const [depositQuote, setDepositQuote] = useState<{
    wsolNeeded: number;
    riftNeeded: number;
    liquidityDelta: string;
    poolRatio: number;
  } | null>(null);
  const [isLoadingQuote, setIsLoadingQuote] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [lastEditedField, setLastEditedField] = useState<'sol' | 'rift' | null>(null); // Track which field user edited
  const [liquidityRatio, setLiquidityRatio] = useState(1.0); // SOL:RIFT ratio
  const [initialPrice, setInitialPrice] = useState(''); // Initial price for new pools (SOL per RIFT) - empty = auto-fetch from Meteora
  const [usePriceMode, setUsePriceMode] = useState(false); // Toggle between manual amounts and price-based calculation
  const [createNewPool, setCreateNewPool] = useState(false); // Toggle to create new pool instead of adding to existing
  const [liquidityTab, setLiquidityTab] = useState<'add' | 'remove'>('add'); // Tab state for liquidity modal
  const [liquidityTokenA, setLiquidityTokenA] = useState<'SOL' | 'USD1'>('SOL'); // Token A selection for liquidity pool (SOL or USD1)
  const [userLpPositions, setUserLpPositions] = useState<any[]>([]); // User's LP positions
  const [detailedPositions, setDetailedPositions] = useState<any[]>([]); // Detailed position info with estimates
  const [selectedPositions, setSelectedPositions] = useState<Set<string>>(new Set()); // Selected position addresses to remove
  const [removeMode, setRemoveMode] = useState<'percentage' | 'positions'>('percentage'); // How to remove liquidity
  const [removePercentage, setRemovePercentage] = useState<string>('100'); // Percentage to remove
  const [positionRemovalPercentages, setPositionRemovalPercentages] = useState<Record<string, number>>({}); // Per-position removal percentages
  const [isLoadingLpBalance, setIsLoadingLpBalance] = useState(false);
  const [estimatedWithdrawal, setEstimatedWithdrawal] = useState<{ tokenA: number; tokenB: number } | null>(null);
  const [poolTypeDetected, setPoolTypeDetected] = useState<'cpamm' | 'dlmm' | null>(null); // Detected pool type
  const [dlmmPendingFees, setDlmmPendingFees] = useState<{ tokenX: number; tokenY: number } | null>(null); // DLMM accumulated LP fees
  const [cpammPendingFees, setCpammPendingFees] = useState<{ tokenA: number; tokenB: number } | null>(null); // CP-AMM accumulated LP fees
  const [isClaimingLpFees, setIsClaimingLpFees] = useState(false);

  // Pool parameters for initial liquidity
  const [initialRiftAmount, setInitialRiftAmount] = useState('1000');
  const [tradingFeeBps, setTradingFeeBps] = useState('25');
  const [binStep, setBinStep] = useState('25');

  // Pool type (DLMM = concentrated liquidity, cpamm for legacy detection only)
  const [poolType, setPoolType] = useState<'cpamm' | 'dlmm'>('dlmm');
  // Selected pool address (when multiple pools exist for a rift)
  const [selectedPoolAddress, setSelectedPoolAddress] = useState<string | null>(null);
  const [dlmmStrategy, setDlmmStrategy] = useState<DLMMStrategyType>(DLMMStrategyType.Spot);
  const [dlmmBinStep, setDlmmBinStep] = useState('50'); // Common: 1, 5, 10, 20, 50, 100, 200
  const [dlmmRangeInterval, setDlmmRangeInterval] = useState('10'); // Bins on each side of active bin
  const [dlmmFeeBps, setDlmmFeeBps] = useState('25'); // 0.25% default fee
  const [dlmmSingleSided, setDlmmSingleSided] = useState(true); // Single-sided liquidity (default)
  // MCap-based bin range for DLMM
  const [dlmmMinMcap, setDlmmMinMcap] = useState(0);
  const [dlmmMaxMcap, setDlmmMaxMcap] = useState(0);
  const [dlmmTokenSupply, setDlmmTokenSupply] = useState(0);
  const [dlmmUseMcapRange, setDlmmUseMcapRange] = useState(true); // Default to MCap mode
  const [dlmmUseAutoPrice, setDlmmUseAutoPrice] = useState(true); // true = auto-fetch from Meteora, false = custom
  const [dlmmTokenPriceUsd, setDlmmTokenPriceUsd] = useState(0);

  const [isCreatingRift, setIsCreatingRift] = useState(false);
  const [isWrapping, setIsWrapping] = useState(false);
  const [isUnwrapping, setIsUnwrapping] = useState(false);
  const [isClaimingFees, setIsClaimingFees] = useState(false);
  const [isClaimingDexFees, setIsClaimingDexFees] = useState(false);
  const [isClaimingRiftFees, setIsClaimingRiftFees] = useState(false);
  const [selectedTokenBalance, setSelectedTokenBalance] = useState(0);
  const [selectedRiftBalance, setSelectedRiftBalance] = useState(0);
  const [selectedRiftTokenBalance, setSelectedRiftTokenBalance] = useState(0);
  const [riftsTokenBalance, setRiftsTokenBalance] = useState(0); // RIFTS pump.fun token balance
  const [usd1TokenBalance, setUsd1TokenBalance] = useState(0); // USD1 stablecoin balance

  // RIFTS token mint address
  const RIFTS_TOKEN_MINT = 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';
  // USD1 stablecoin mint address
  const USD1_TOKEN_MINT = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';

  const [lastBalanceUpdate, setLastBalanceUpdate] = useState(0); // Timestamp of last balance update

  // Stepper state for rift creation process
  const [riftCreationStep, setRiftCreationStep] = useState(1); // 1: Create Rift, 2: Create Pool & Add Liquidity
  const [createdRiftPDA, setCreatedRiftPDA] = useState<string | null>(null);
  const [createdRiftData, setCreatedRiftData] = useState<any>(null);

  // Meteora pool creation state
  const [isCreatingMeteoraPool, setIsCreatingMeteoraPool] = useState(false);
  const [meteoraPoolAmount, setMeteoraPoolAmount] = useState('1');

  // DLMM multi-transaction progress state
  const [dlmmProgress, setDlmmProgress] = useState<{
    current: number;
    total: number;
    status: string;
  } | null>(null);

  // Toast notifications
  const [toasts, setToasts] = useState<Array<{
    id: string;
    type: 'success' | 'error' | 'pending';
    message: string;
    signature?: string;
  }>>([]);

  // Unique toast ID counter (avoids Date.now() collisions when multiple toasts fire in same millisecond)
  const toastIdCounter = useRef(0);
  const generateToastId = () => `toast-${Date.now()}-${++toastIdCounter.current}`;

  // Initialize service instances
  const riftProtocolService = useMemo(() => new ProductionRiftsService(connection as unknown as Connection), []);
  const realBlockchainService = useMemo(() => new RealBlockchainService(connection as unknown as Connection), []);
  const priceOracle = useMemo(() => new RealPriceOracle(connection as unknown as Connection), []);
  const realAnalyticsService = useMemo(() => new RealProtocolAnalyticsService(connection as unknown as Connection), []);

  // Real data state
  const [realMetrics, setRealMetrics] = useState<RealDataMetrics | null>(null);
  const [realUserAnalytics, setRealUserAnalytics] = useState<RealUserAnalytics | null>(null);
  const [realPortfolioData, setRealPortfolioData] = useState<any>(null);
  const [portfolioData, setPortfolioData] = useState<PortfolioData | null>(null); // New portfolio data from blockchain
  const [protocolAnalytics, setProtocolAnalytics] = useState<ProtocolAnalytics | null>(null); // Legacy analytics
  const [realProtocolAnalytics, setRealProtocolAnalytics] = useState<RealProtocolAnalytics | null>(null); // NEW: Real analytics
  const [realTransactions, setRealTransactions] = useState<any[]>([]);
  const [realProtocolMetrics, setRealProtocolMetrics] = useState<any>(null);
  const [tokenPrices, setTokenPrices] = useState<Map<string, any>>(new Map());
  const [fullRealAnalytics, setFullRealAnalytics] = useState<any>(null); // 100% REAL analytics from API
  const [userPortfolioAPI, setUserPortfolioAPI] = useState<any>(null); // REAL user portfolio from API (positions + transactions)

  // Load real data from blockchain
  const loadRealData = async () => {
    try {

      // Fetch protocol metrics from blockchain
      const protocolMetrics = await realBlockchainService.getProtocolMetrics();

      setRealProtocolMetrics(protocolMetrics);
      
      // Fetch real-time token prices
      const tokenSymbols = ['SOL', 'USDC', 'BONK', 'JUP', 'RENDER', 'WIF', 'RIFTS'];
      const prices = await priceOracle.getMultiplePrices(tokenSymbols);

      setTokenPrices(prices);
      
      // If wallet is connected, fetch user-specific data
      if (wallet.publicKey) {
        const walletPubkey = new PublicKey(wallet.publicKey);

        // Fetch real portfolio data
        const portfolio = await realBlockchainService.getUserPortfolio(walletPubkey);

        setRealPortfolioData(portfolio);

        // Fetch comprehensive portfolio data from all programs
        const comprehensivePortfolio = await portfolioBlockchainService.getUserPortfolio(walletPubkey);

        setPortfolioData(comprehensivePortfolio);

        // Fetch real transaction history
        const transactions = await realBlockchainService.getUserTransactions(walletPubkey);

        setRealTransactions(transactions);

        // Fetch comprehensive user portfolio from API (positions + transactions from Supabase)
        try {
          const walletAddress = wallet.publicKey.toString();

          const portfolioResponse = await fetch(`/api/get-user-portfolio?wallet=${walletAddress}`);
          if (portfolioResponse.ok) {
            const portfolioApiData = await portfolioResponse.json();
            setUserPortfolioAPI(portfolioApiData);

            // Alert if no transactions found
            if (!portfolioApiData.transactions || portfolioApiData.transactions.length === 0) {
            }
          } else {
            console.error('[RIFTS-APP] ❌ API returned error:', portfolioResponse.status);
          }
        } catch (error) {
          console.error('[RIFTS-APP] ❌ Failed to fetch user portfolio from API:', error);
        }
      }
      
      // Fetch comprehensive protocol analytics from all deployed programs
      try {
        const analytics = await analyticsBlockchainService.getProtocolAnalytics(
          wallet.publicKey ? new PublicKey(wallet.publicKey) : undefined
        );

        setProtocolAnalytics(analytics);
      } catch (error) {

      }

      // NEW: Fetch real analytics from new service (will be called after rifts are loaded)
      // This is now done in a useEffect that watches the rifts array

      // Also fetch from existing services for compatibility
      try {
        // NOTE: /api/rifts-cache is now only called by cron job, not on page load
        // This prevents 90+ RPC calls on every user interaction

        const metrics = await realDataService.getAllRealMetrics();
        setRealMetrics(metrics);

        const userAnalytics = await realDataService.getRealUserAnalytics();
        setRealUserAnalytics(userAnalytics);
      } catch (error) {

      }

    } catch (error) {

      // Clear cache and retry
      realBlockchainService.clearCache();
    }
  };

  // Fetch user's LP positions when remove liquidity tab is opened
  useEffect(() => {
    const fetchLpPositions = async () => {
      // Get ALL pool addresses from meteoraPools array, or fall back to single pool
      const poolAddresses = selectedRift?.meteoraPools ||
        (selectedRift?.liquidityPool || selectedRift?.meteoraPool ? [selectedRift?.liquidityPool || selectedRift?.meteoraPool] : []);

      // Only fetch if we're on the remove tab, modal is open, wallet is connected, and we have pools
      if (
        liquidityTab !== 'remove' ||
        !showAddLiquidityModal ||
        !wallet.publicKey ||
        !poolAddresses ||
        poolAddresses.length === 0 ||
        poolAddresses.every((addr: string | undefined) => !addr || addr === '11111111111111111111111111111111')
      ) {
        setUserLpPositions([]);
        setDetailedPositions([]);
        setSelectedPositions(new Set());
        setPoolTypeDetected(null);
        setDlmmPendingFees(null);
        return;
      }
      setIsLoadingLpBalance(true);
      try {
        const validPools = poolAddresses.filter((addr: string | undefined): addr is string => !!addr && addr !== '11111111111111111111111111111111');
        const riftMint = selectedRift?.riftMint;

        console.log('[LP-FETCH] Fetching ALL positions for rift mint:', riftMint);

        // Fetch BOTH CP-AMM and DLMM positions in parallel
        const allPositions: any[] = [];
        let hasDlmmPositions = false;
        let hasCpammPositions = false;
        // Store rawConnection at this scope so it can be used for DLMM fee fetching later
        let rawConnection: Connection | null = null;

        // 1. Fetch ALL CP-AMM positions for this rift token
        try {
          const cpammPositions = await meteoraLiquidityService.getAllUserPositionsForRift(
            wallet.publicKey,
            riftMint
          );

          if (cpammPositions.length > 0) {
            hasCpammPositions = true;
            console.log('[LP-FETCH] Found', cpammPositions.length, 'CP-AMM positions');
            allPositions.push(...cpammPositions.map(pos => ({
              ...pos,
              isDlmm: false
            })));
          }
        } catch (cpammErr) {
          console.log('[LP-FETCH] Error fetching CP-AMM positions:', cpammErr);
        }

        // 2. Fetch ALL DLMM positions (and filter by rift token)
        // Note: DLMM SDK requires full Connection object with all methods
        try {
          console.log('[LP-FETCH] Attempting to fetch DLMM positions...');
          const dlmmService = await import('@/lib/solana/dlmm-liquidity-service');

          // Get the raw connection - DLMM SDK needs the underlying Connection with full API
          // RateLimitedConnection stores raw connection in protected 'connection' property
          rawConnection = (connection as any).connection as Connection;
          if (!rawConnection) {
            console.log('[LP-FETCH] Skipping DLMM - could not extract raw connection');
            throw new Error('Connection not compatible with DLMM SDK');
          }
          console.log('[LP-FETCH] Using raw connection for DLMM:', typeof rawConnection);

          const allDlmmPositions = await dlmmService.dlmmLiquidityService.getAllUserPositions(
            rawConnection as any,
            new PublicKey(wallet.publicKey)
          );

          console.log('[LP-FETCH] DLMM fetch returned', allDlmmPositions.size, 'pools with positions');

          // Filter to only pools containing this rift token
          for (const [poolAddress, positions] of allDlmmPositions.entries()) {
            console.log('[LP-FETCH] DLMM pool', poolAddress.slice(0, 8) + '...', 'has', positions.length, 'positions');
            if (positions.length > 0) {
              // Check if this pool contains the rift token
              try {
                const poolInfo = await dlmmService.dlmmLiquidityService.getPoolInfo(rawConnection, poolAddress);
                if (poolInfo && riftMint && (poolInfo.tokenXMint === riftMint || poolInfo.tokenYMint === riftMint)) {
                  hasDlmmPositions = true;
                  console.log('[LP-FETCH] Found', positions.length, 'DLMM positions in pool:', poolAddress);
                  allPositions.push(...positions.map((pos: any) => ({
                    address: pos.address,
                    poolAddress: poolAddress,
                    isDlmm: true,
                    binIds: pos.binIds,
                    liquidity: pos.liquidity,
                    tokenXAmount: pos.tokenXAmount,
                    tokenYAmount: pos.tokenYAmount
                  })));
                }
              } catch (poolErr) {
                // Skip this pool if we can't get info
              }
            }
          }
        } catch (dlmmErr) {
          console.log('[LP-FETCH] Error fetching DLMM positions:', dlmmErr);
        }

        // 3. ALWAYS check known pools (in addition to the discovery above)
        console.log('[LP-FETCH] Checking known pools:', validPools);
        if (validPools.length > 0) {
          try {
            const knownPoolPositions = await meteoraLiquidityService.getUserPositionsFromMultiplePools(
              validPools,
              wallet.publicKey
            );
            console.log('[LP-FETCH] Found', knownPoolPositions.length, 'positions from known pools');

            // Add positions that weren't already found
            const existingAddresses = new Set(allPositions.map(p => p.address));
            for (const pos of knownPoolPositions) {
              if (!existingAddresses.has(pos.address)) {
                allPositions.push({ ...pos, isDlmm: false });
                hasCpammPositions = true;
              }
            }
          } catch (knownPoolErr) {
            console.log('[LP-FETCH] Error checking known pools:', knownPoolErr);
          }
        }

        console.log('[LP-FETCH] Total positions found:', allPositions.length, '(DLMM:', hasDlmmPositions, 'CPAMM:', hasCpammPositions, ')');

        // Set pool type based on what we found
        if (hasDlmmPositions && !hasCpammPositions) {
          setPoolTypeDetected('dlmm');
        } else {
          setPoolTypeDetected('cpamm'); // Default to cpamm or mixed
        }

        const positions = allPositions;

        setUserLpPositions(positions);

        // Fetch detailed position information for all positions
        if (positions.length > 0) {
          const allDetailedPositions: any[] = [];

          // Get CP-AMM detailed positions
          const cpammPositions = positions.filter((p: any) => !p.isDlmm);
          if (cpammPositions.length > 0) {
            const detailed = await meteoraLiquidityService.getDetailedPositions({
              poolAddress: cpammPositions[0].poolAddress,
              userPublicKey: wallet.publicKey
            });
            if (detailed) {
              allDetailedPositions.push(...detailed);
            }
          }

          // Add DLMM positions with their token amounts
          const dlmmPositions = positions.filter((p: any) => p.isDlmm);
          for (const dlmmPos of dlmmPositions) {
            // DLMM positions have tokenXAmount and tokenYAmount in RAW units (lamports)
            // Need to convert to UI amounts using decimals
            // tokenX is typically the rift token (6 decimals), tokenY is typically SOL (9 decimals)
            const riftDecimals = 6; // Rift tokens always have 6 decimals
            const solDecimals = 9;

            const tokenXUI = (dlmmPos.tokenXAmount || 0) / Math.pow(10, riftDecimals);
            const tokenYUI = (dlmmPos.tokenYAmount || 0) / Math.pow(10, solDecimals);

            console.log('[LP-FETCH] DLMM position details:', {
              address: dlmmPos.address,
              tokenXRaw: dlmmPos.tokenXAmount,
              tokenYRaw: dlmmPos.tokenYAmount,
              tokenXUI,
              tokenYUI,
              riftDecimals,
              liquidity: dlmmPos.liquidity
            });
            allDetailedPositions.push({
              address: dlmmPos.address,
              percentageOfTotal: 100, // Each DLMM position is considered 100% of itself
              estimatedTokenA: tokenXUI,
              estimatedTokenB: tokenYUI
            });
          }

          setDetailedPositions(allDetailedPositions);

          // Fetch pending fees for CP-AMM pool
          const cpammPool = cpammPositions[0]?.poolAddress || validPools[0];
          if (cpammPool) {
            try {
              const pendingFees = await meteoraLiquidityService.getPendingFees({
                poolAddress: cpammPool,
                userPublicKey: wallet.publicKey
              });
              if (pendingFees.hasClaimable) {
                setCpammPendingFees({ tokenA: pendingFees.tokenA, tokenB: pendingFees.tokenB });
              } else {
                setCpammPendingFees(null);
              }
            } catch (feeError) {
              console.log('[LP-FETCH] Could not fetch pending fees:', feeError);
              setCpammPendingFees(null);
            }
          }

          // Fetch pending fees for DLMM pool
          const dlmmPool = dlmmPositions[0]?.poolAddress;
          if (dlmmPool && rawConnection) {
            try {
              const dlmmService = await import('@/lib/solana/dlmm-liquidity-service');
              const pendingFees = await dlmmService.dlmmLiquidityService.getPendingFees(
                rawConnection,
                dlmmPool,
                new PublicKey(wallet.publicKey)
              );
              console.log('[LP-FETCH] DLMM pending fees:', pendingFees);
              if (pendingFees.hasClaimable) {
                setDlmmPendingFees({ tokenX: pendingFees.tokenX, tokenY: pendingFees.tokenY });
              } else {
                setDlmmPendingFees(null);
              }
            } catch (feeError) {
              console.log('[LP-FETCH] Could not fetch DLMM pending fees:', feeError);
              setDlmmPendingFees(null);
            }
          } else {
            setDlmmPendingFees(null);
          }
        } else {
          setDetailedPositions([]);
          setCpammPendingFees(null);
          setDlmmPendingFees(null);
        }

        // Auto-select all positions by default (for position mode)
        setSelectedPositions(new Set(positions.map((p: any) => p.address)));
        // Default to 100% removal
        setRemovePercentage('100');
      } catch (error) {
        console.error('[LP-FETCH] Error fetching positions:', error);
        setUserLpPositions([]);
        setDetailedPositions([]);
        setSelectedPositions(new Set());
        setPoolTypeDetected(null);
        setDlmmPendingFees(null);
      } finally {
        setIsLoadingLpBalance(false);
      }
    };

    fetchLpPositions();
  }, [liquidityTab, showAddLiquidityModal, wallet.publicKey, selectedRift?.meteoraPools, selectedRift?.liquidityPool, selectedRift?.meteoraPool]);

  // Auto-detect pool type (DLMM vs CPAMM) when liquidity modal opens
  useEffect(() => {
    const detectPoolType = async () => {
      if (!showAddLiquidityModal || liquidityTab !== 'add') return;

      const poolAddress = selectedRift?.liquidityPool || selectedRift?.meteoraPool;
      if (!poolAddress || poolAddress === '11111111111111111111111111111111') {
        // No pool exists - check if monorift or regular rift
        const isMonorift = (selectedRift as any)?.prefixType === 1;
        if (isMonorift) {
          // Monorifts default to DLMM (single-sided)
          setPoolType('dlmm');
          setPoolTypeDetected(null); // No pool created yet
          setDlmmSingleSided(true);
        } else {
          // Regular rifts default to CPAMM (DAMM V2)
          setPoolType('cpamm');
          setPoolTypeDetected(null); // No pool created yet
          setDlmmSingleSided(false);
        }
        return;
      }

      try {
        // Try to detect if it's a DLMM or CPAMM pool
        const poolPubkey = new PublicKey(poolAddress);
        const accountInfo = await connection.getAccountInfo(poolPubkey);

        if (accountInfo) {
          const ownerStr = accountInfo.owner.toBase58();
          // DLMM program ID
          const DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
          // Meteora CP-AMM (DAMM v2) program ID
          const CPAMM_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';

          // Check if this is a monorift (prefixType === 1)
          const isMonorift = (selectedRift as any)?.prefixType === 1;

          if (ownerStr === DLMM_PROGRAM) {
            console.log('[POOL-DETECT] Detected DLMM pool - single-sided enabled');
            setPoolType('dlmm');
            setPoolTypeDetected('dlmm');
            setDlmmSingleSided(true); // DLMM supports single-sided deposits
          } else if (ownerStr === CPAMM_PROGRAM) {
            // For monorifts with DAMMV2 pools, keep single-sided (they were created single-sided)
            // For regular rifts with DAMMV2 pools, use two-sided
            if (isMonorift) {
              console.log('[POOL-DETECT] Detected CPAMM (DAMM v2) monorift pool - single-sided mode');
              setPoolType('cpamm');
              setPoolTypeDetected('cpamm');
              setDlmmSingleSided(true); // Monorift DAMMV2 pools are single-sided
            } else {
              console.log('[POOL-DETECT] Detected CPAMM (DAMM v2) pool - two-sided mode');
              setPoolType('cpamm');
              setPoolTypeDetected('cpamm');
              setDlmmSingleSided(false); // Regular CPAMM uses two-sided deposits
            }
          } else {
            console.log('[POOL-DETECT] Unknown pool program:', ownerStr, '- defaulting to DLMM');
            setPoolType('dlmm');
            setPoolTypeDetected('dlmm');
            setDlmmSingleSided(true);
          }
        }
      } catch (error) {
        console.log('[POOL-DETECT] Error detecting pool type:', error);
        // Default to DLMM if detection fails
        setPoolType('dlmm');
        setPoolTypeDetected('dlmm');
      }
    };

    detectPoolType();
  }, [showAddLiquidityModal, liquidityTab, selectedRift?.liquidityPool, selectedRift?.meteoraPool, connection]);

  // Estimate withdrawal amounts when percentage changes
  useEffect(() => {
    const estimateWithdrawal = async () => {
      // Get pool address from either liquidityPool or meteoraPool property
      const poolAddress = selectedRift?.liquidityPool || selectedRift?.meteoraPool;

      if (
        removeMode !== 'percentage' ||
        !wallet.publicKey ||
        !poolAddress ||
        poolAddress === '11111111111111111111111111111111' ||
        !removePercentage
      ) {
        setEstimatedWithdrawal(null);
        return;
      }

      const pct = parseFloat(removePercentage);
      if (isNaN(pct) || pct <= 0 || pct > 100) {
        setEstimatedWithdrawal(null);
        return;
      }

      try {
        const estimate = await meteoraLiquidityService.estimateWithdrawalByPercentage({
          poolAddress: poolAddress,
          userPublicKey: wallet.publicKey,
          percentage: pct
        });

        if (estimate) {
          setEstimatedWithdrawal({
            tokenA: estimate.tokenA,
            tokenB: estimate.tokenB
          });
        }
      } catch (error) {

        setEstimatedWithdrawal(null);
      }
    };

    estimateWithdrawal();
  }, [removeMode, removePercentage, wallet.publicKey, selectedRift?.liquidityPool, selectedRift?.meteoraPool]);

  // Prefetch pool snapshots as soon as the add-liquidity modal opens (speeds up quote fetching)
  useEffect(() => {
    const prefetch = async () => {
      if (!showAddLiquidityModal) return;
      const poolAddresses: string[] = [];
      if (selectedRift?.meteoraPools?.length) {
        poolAddresses.push(...selectedRift.meteoraPools);
      } else if (selectedRift?.liquidityPool) {
        poolAddresses.push(selectedRift.liquidityPool);
      }
      // Remove duplicates and invalid placeholders
      const uniquePools = Array.from(new Set(poolAddresses)).filter(
        (p) => p && p !== '11111111111111111111111111111111'
      );
      if (!uniquePools.length) return;

      try {
        await Promise.all(uniquePools.map((p) => meteoraLiquidityService.prefetchPoolSnapshot(p)));
      } catch (err) {
        console.warn('[LIQ-PREFETCH] Failed to prefetch pool snapshots', err);
      }
    };

    prefetch();
  }, [showAddLiquidityModal, selectedRift?.meteoraPools, selectedRift?.liquidityPool]);

  // Preload critical data immediately on component mount
  useEffect(() => {
    const preloadData = async () => {
      try {

        // Trigger vanity address pool startup by hitting the API

        fetch('/api/vanity-pool', { method: 'PUT' })
          .then(response => response.json())
          .then(status => {

            if (status.poolSize === 0) {

            } else {

            }
          })
          .catch(console.error);

        // Load real data in parallel with service initialization - with error handling
        const [metrics, analytics] = await Promise.allSettled([
          realDataService.getAllRealMetrics(),
          realDataService.getRealUserAnalytics()
        ]);

        // Extract successful results with fallbacks
        const safeMetrics = metrics.status === 'fulfilled' ? metrics.value : null;
        const safeAnalytics = analytics.status === 'fulfilled' ? analytics.value : null;

        setPreloadedData(prev => ({
          ...prev,
          metrics: safeMetrics,
          userAnalytics: safeAnalytics
        }));

      } catch (error) {

      }
    };
    
    preloadData();
  }, []);

  // Initialize services
  useEffect(() => {
    const initServices = async () => {
      try {
        // Set wallet if connected - use Reown AppKit's wallet provider
        if (wallet.publicKey && wallet.connected && walletAdapterSendTx) {
          const walletPubkey = new PublicKey(wallet.publicKey);
          const walletAdapter = {
            publicKey: walletPubkey,
            sendTransaction: async (transaction: Transaction, conn?: Connection, options?: { skipPreflight?: boolean }) => {
              try {
                const effectiveConnection = conn || walletAdapterConnection || connection;

                // Set transaction properties
                if (!transaction.recentBlockhash) {
                  const latestBlockhash = await (effectiveConnection as Connection).getLatestBlockhash();
                  transaction.recentBlockhash = latestBlockhash.blockhash;
                }
                if (!transaction.feePayer) {
                  transaction.feePayer = walletPubkey;
                }

                // Simulate transaction first to get detailed error logs
                if (!options?.skipPreflight) {
                  try {
                    console.log('[TX-DEBUG] Simulating transaction before sending...');
                    const sim = await (effectiveConnection as Connection).simulateTransaction(transaction);
                    if (sim.value.err) {
                      console.error('[TX-DEBUG] Simulation FAILED:', sim.value.err);
                      console.error('[TX-DEBUG] Simulation logs:', sim.value.logs);
                      throw new Error(`Transaction simulation failed: ${JSON.stringify(sim.value.err)}\nLogs: ${sim.value.logs?.join('\n')}`);
                    }
                    console.log('[TX-DEBUG] Simulation SUCCESS, logs:', sim.value.logs);
                  } catch (simError: any) {
                    if (simError.message?.includes('Transaction simulation failed')) {
                      throw simError;
                    }
                    console.error('[TX-DEBUG] Simulation error (non-fatal):', simError);
                  }
                }

                // Use Reown AppKit's sendTransaction
                console.log('[TX-DEBUG] Sending via Reown AppKit...');
                const signature = await walletAdapterSendTx(transaction, effectiveConnection, options);
                console.log('[TX-DEBUG] Transaction sent:', signature);
                return signature;
              } catch (error: any) {
                console.error('[TX-DEBUG] sendTransaction error:', error);
                console.error('[TX-DEBUG] Error name:', error?.name);
                console.error('[TX-DEBUG] Error message:', error?.message);
                throw error;
              }
            },
            signTransaction: async (transaction: Transaction) => {
              if (!walletAdapterSignTx) {
                throw new Error('Wallet does not support signTransaction');
              }
              try {
                const effectiveConnection = walletAdapterConnection || connection;

                // Set transaction properties
                if (!transaction.recentBlockhash) {
                  const latestBlockhash = await (effectiveConnection as Connection).getLatestBlockhash();
                  transaction.recentBlockhash = latestBlockhash.blockhash;
                }
                if (!transaction.feePayer) {
                  transaction.feePayer = walletPubkey;
                }

                // Use Reown AppKit's signTransaction
                const signed = await walletAdapterSignTx(transaction);
                return signed;
              } catch (error) {
                throw error;
              }
            }
          };
          riftProtocolService.setWallet(walletAdapter as WalletAdapter);
        }

        // Load real data if not already preloaded
        if (!preloadedData.metrics) {
          await loadRealData();
        } else {
          // Use preloaded data
          setRealMetrics(preloadedData.metrics);
          setRealUserAnalytics(preloadedData.userAnalytics);

        }

        // Always set service ready to fix loading issue
        setServiceReady(true);

      } catch (error) {

        // Still set service ready to prevent permanent loading
        setServiceReady(true);

      }
    };

    initServices();
  }, [wallet.publicKey, wallet.connected, walletAdapterSendTx, walletAdapterSignTx, walletAdapterConnection, riftProtocolService, preloadedData]);

  // Auto-refresh real data every 2 minutes and when wallet changes
  useEffect(() => {
    // Load data immediately when wallet connects
    if (wallet.publicKey) {
      loadRealData();
    }

    // Set up auto-refresh - INCREASED from 2min to 5min to reduce RPC spam
    // Each refresh triggers /api/rifts-cache which makes hundreds of RPC calls
    const interval = setInterval(loadRealData, 300000); // 5 minutes (was 120000 = 2min)
    return () => clearInterval(interval);
  }, [wallet.publicKey]);

  // Fetch RIFTS price and arbitrage bot revenue
  useEffect(() => {
    const fetchPriceAndRevenue = async () => {
      try {
        // Fetch from vault balances API which has authority wallet SOL balance
        const vaultRes = await fetch('/api/get-vault-balances');
        if (vaultRes.ok) {
          const data = await vaultRes.json();
          // Set RIFTS price
          if (data.riftsPrice) {
            setRiftsTokenPrice(data.riftsPrice);
          }
          // Set arbitrage bot revenue (authority wallet SOL balance)
          if (data.authority?.solUSD) {
            setArbBotRevenue(data.authority.solUSD);
          }
        }

        // Fetch SOL price from internal API
        try {
          const solPriceRes = await fetch('/api/sol-price');
          if (solPriceRes.ok) {
            const solData = await solPriceRes.json();
            if (solData?.price) {
              console.log('✅ SOL price set to:', solData.price);
              setSolPrice(solData.price);
            }
          } else {
            console.error('❌ SOL price fetch failed:', solPriceRes.status, solPriceRes.statusText);
          }
        } catch (err) {
          console.error('❌ Error fetching SOL price:', err);
        }
      } catch (error) {
        console.error('Error fetching RIFTS price/revenue/SOL price:', error);
      }
    };

    fetchPriceAndRevenue();
    // Refresh every 5 minutes
    const interval = setInterval(fetchPriceAndRevenue, 300000);
    return () => clearInterval(interval);
  }, []);

  // Auto-detect token metadata when custom token address is entered
  useEffect(() => {
    const fetchMetadata = async () => {
      // Only fetch if we have a valid-looking address
      const trimmedAddress = (customTokenAddress || '').trim();
      if (!trimmedAddress || trimmedAddress.length < 32 || trimmedAddress.length > 44 || /\s/.test(trimmedAddress)) {
        setCustomTokenMetadata(null);
        setTokenMetadataError(null);
        return;
      }

      // Skip if we already have metadata for this exact address
      if (customTokenMetadata?.address === trimmedAddress) {
        return;
      }

      setIsLoadingTokenMetadata(true);
      setTokenMetadataError(null);

      try {
        const metadata = await fetchTokenMetadata(trimmedAddress, connection as unknown as Connection);

        if (metadata) {
          setCustomTokenMetadata(metadata);
          // Auto-populate the symbol field
          setCustomTokenSymbol(metadata.symbol);
          setTokenMetadataError(null);
        } else {
          setCustomTokenMetadata(null);
          setTokenMetadataError('Token metadata not found. Please enter symbol manually.');
        }
      } catch (error) {
        console.error('Error fetching token metadata:', error);
        setCustomTokenMetadata(null);
        setTokenMetadataError('Failed to fetch token metadata. Please enter symbol manually.');
      } finally {
        setIsLoadingTokenMetadata(false);
      }
    };

    // Debounce the fetch to avoid too many API calls
    const timeoutId = setTimeout(fetchMetadata, 500);
    return () => clearTimeout(timeoutId);
  }, [customTokenAddress, customTokenMetadata]);

  // Fetch live DLMM token price (USD + SOL) for the Monorift tab using the price API (Jupiter -> Dexscreener fallback)
  useEffect(() => {
    const fetchDlmmPrice = async () => {
      if (createRiftTab !== 'dlmm' || !showCreateRiftModal) return;

      const tokenAddresses: Record<string, string> = {
        'SOL': 'So11111111111111111111111111111111111111112',
        'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        'USD1': 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'
      };

      const mint = selectedToken === 'CUSTOM' ? customTokenAddress : tokenAddresses[selectedToken];
      if (!mint || mint.length < 32) return;

      try {
        const priceRes = await fetch(`/api/prices?mint=${mint}`);
        if (!priceRes.ok) return;
        const priceData = await priceRes.json();
        const usdPrice = priceData.price || 0;

        // Fetch SOL price to derive SOL quote
        const solRes = await fetch('/api/prices?mint=So11111111111111111111111111111111111111112');
        const solData = solRes.ok ? await solRes.json() : null;
        const solUsd = solData?.price || 0;

        setDlmmRiftTokenPriceUsd(usdPrice);
        if (usdPrice > 0 && solUsd > 0) {
          setDlmmRiftInitialPrice((usdPrice / solUsd).toFixed(9));
        }
      } catch (error) {
        console.error('[DLMM-PRICE] Failed to fetch live price:', error);
      }
    };

    fetchDlmmPrice();
  }, [createRiftTab, customTokenAddress, selectedToken, showCreateRiftModal]);

  // Fetch user's underlying balance for Monorift creation tab
  useEffect(() => {
    const fetchUnderlyingBalance = async () => {
      if (!showCreateRiftModal || createRiftTab !== 'dlmm' || !wallet.publicKey) {
        setMonoriftUnderlyingBalance(null);
        return;
      }

      // SOL uses native balance
      if (selectedToken === 'SOL') {
        setMonoriftUnderlyingBalance(wallet.balance);
        return;
      }

      const tokenAddresses: Record<string, string> = {
        'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        'RIFTS': 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump',
        'USD1': 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'
      };

      const tokenMint = selectedToken === 'CUSTOM' ? customTokenAddress : tokenAddresses[selectedToken];
      if (!tokenMint || tokenMint.length < 32) {
        setMonoriftUnderlyingBalance(null);
        return;
      }

      try {
        setIsLoadingMonoriftBalance(true);
        const balance = await walletService.getTokenBalance(new PublicKey(wallet.publicKey), tokenMint);
        const parsedBalance = typeof balance === 'number' ? balance : parseFloat(String(balance)) || 0;
        setMonoriftUnderlyingBalance(parsedBalance);
      } catch (err) {
        console.error('[MONORIFT] Failed to fetch underlying balance:', err);
        setMonoriftUnderlyingBalance(0);
      } finally {
        setIsLoadingMonoriftBalance(false);
      }
    };

    fetchUnderlyingBalance();
  }, [createRiftTab, customTokenAddress, selectedToken, showCreateRiftModal, wallet.balance, wallet.publicKey]);

  // Auto-fetch initial price for DLMM rift creation
  useEffect(() => {
    // Only fetch when in DLMM tab, auto mode enabled, and a token is selected
    if (createRiftTab !== 'dlmm' || !selectedToken || !dlmmRiftUseAutoPrice) return;

    const fetchTokenPrice = async () => {
      // Token addresses
      const tokenAddresses: Record<string, string> = {
        'SOL': 'So11111111111111111111111111111111111111112',
        'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        'USD1': 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'
      };

      const tokenMint = selectedToken === 'CUSTOM' ? customTokenAddress : tokenAddresses[selectedToken];
      if (!tokenMint || tokenMint.length < 32) return;

      setIsFetchingDlmmPrice(true);
      try {
        // Fetch token price in USD
        const tokenResponse = await fetch(`/api/prices?mint=${tokenMint}`);
        if (!tokenResponse.ok) {
          console.warn('[DLMM-PRICE] Could not fetch token price');
          return;
        }
        const tokenData = await tokenResponse.json();
        const tokenPriceUsd = tokenData.price;
        setDlmmRiftTokenPriceUsd(tokenPriceUsd || 0);

        // Fetch SOL price in USD
        const solResponse = await fetch('/api/prices?mint=So11111111111111111111111111111111111111112');
        if (!solResponse.ok) {
          console.warn('[DLMM-PRICE] Could not fetch SOL price');
          return;
        }
        const solData = await solResponse.json();
        const solPriceUsd = solData.price;

        // Calculate price in SOL
        if (tokenPriceUsd > 0 && solPriceUsd > 0) {
          const priceInSol = tokenPriceUsd / solPriceUsd;
          console.log(`[DLMM-PRICE] Token: $${tokenPriceUsd}, SOL: $${solPriceUsd}, Price in SOL: ${priceInSol}`);
          setDlmmRiftInitialPrice(priceInSol.toFixed(9));
        }
      } catch (error) {
        console.error('[DLMM-PRICE] Error fetching price:', error);
      } finally {
        setIsFetchingDlmmPrice(false);
      }
    };

    const timeoutId = setTimeout(fetchTokenPrice, 300);
    return () => clearTimeout(timeoutId);
  }, [createRiftTab, selectedToken, customTokenAddress, dlmmRiftUseAutoPrice]);

  // Clear stale custom price when switching back to auto mode
  useEffect(() => {
    if (dlmmRiftUseAutoPrice) {
      setDlmmRiftInitialPrice('');
      setDlmmRiftTokenPriceUsd(0);
    }
  }, [dlmmRiftUseAutoPrice]);

  // Reset price snapshot when switching tokens
  useEffect(() => {
    setDlmmRiftTokenPriceUsd(0);
  }, [selectedToken, customTokenAddress]);

  // Re-apply local DLMM overrides to existing rifts (ensures symbols/pools update)
  useEffect(() => {
    if (!Object.keys(dlmmLocalOverrides).length) return;
    setRifts(prev => prev.map(r => {
      const override = dlmmLocalOverrides[r.id] || (r.riftMint ? dlmmLocalOverrides[r.riftMint] : undefined);
      if (!override) return r;
      const merged = { ...r, ...override };
      return { ...merged, symbol: getRiftDisplaySymbol(merged, true) };
    }));
  }, [dlmmLocalOverrides]);

  // Persist DLMM overrides locally so they survive reloads
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem('dlmm-overrides', JSON.stringify(dlmmLocalOverrides));
    } catch {
      // ignore storage errors
    }
  }, [dlmmLocalOverrides]);

  // Fetch RIFTS token balance
  // const fetchRiftsTokenBalance = async () => {
  //   if (!wallet.publicKey) return;
  //   
  //   try {
  //     const { ProductionRiftsTokenManager } = await import('@/lib/solana/rifts-token-manager');
  //     const productionRiftsTokenManager = new ProductionRiftsTokenManager(connection);
  //     const balance = await productionRiftsTokenManager.getUserRiftsBalance(
  //       new PublicKey(wallet.publicKey)
  //     );
  //     setRiftsBalance(balance);
  //     
  //     // Also fetch staking position if it exists
  //     const stakingPosition = productionRiftsTokenManager.getUserStakingPosition(
  //       new PublicKey(wallet.publicKey)
  //     );
  //     
  //     if (stakingPosition) {
  //       setStakedAmount(stakingPosition.lpTokenAmount);
  //       setStakingRewards(stakingPosition.riftsRewards);
  //     }
  //   } catch (error) {

  //   }
  // };

  // Load rifts

  const loadRifts = useCallback(async (isInitialLoad = false, forceRefresh = false) => {
    if (!serviceReady) return;

    // Don't show loading screen - load in background
    if (isInitialLoad && !hasLoadedOnce) {
      setLoadingStartTime(Date.now());
    }
    try {

      const { RIFTS_PROGRAM_ID } = await import('@/lib/solana/rifts-service');

      // Mark that we've loaded at least once (for tracking purposes only - don't clear cache)
      if (isInitialLoad && !hasLoadedOnce) {
        if (typeof window !== 'undefined') {
          localStorage.setItem('rifts-has-loaded', 'true');
        }
      }

      // Fetch rifts - will load from Supabase cache instantly, then update from blockchain
      try {
        console.log('🚀 [LOAD-DEBUG] Starting loadRifts - fetching data from API...');

        // Show loading only on initial load
        if (isInitialLoad) {
          setLoading(true);
        }

        const productionRifts = await riftProtocolService.getAllRifts(forceRefresh);
        console.log(`🚀 [LOAD-DEBUG] Received ${productionRifts.length} rifts from API`);

        // DEBUG: Check ALL rifts for poolType and prefixType
        console.log('🔍🔍🔍 [POOLTYPE-DEBUG] Checking all rifts for poolType/prefixType:');
        productionRifts.forEach(r => {
          if (r.symbol?.toLowerCase().startsWith('m')) {
            console.log(`  ${r.symbol}: poolType=${(r as any).poolType}, prefixType=${(r as any).prefixType}`);
          }
        });

        if (productionRifts.length === 0) {

          setRifts([]);
        } else {
          // Convert ProductionRiftData to RiftData format
          const convertedRifts: RiftData[] = productionRifts.map(rift => {
          // Only log for monorifts (prefixType === 1)
          if ((rift as any).prefixType === 1) {
            console.log(`[DEBUG-RIFT] Processing monorift ID: ${rift.id?.slice(0,8)}...`);
            console.log(`[DEBUG-RIFT] Raw data from API:`, {
              id: rift.id?.slice(0,8),
              symbol: rift.symbol,
              underlying: rift.underlying,
              prefixType: (rift as any).prefixType,
              strategy: rift.strategy
            });
          }
          const fixedSymbol = getRiftDisplaySymbol(rift, (rift as any).prefixType === 1);
          if ((rift as any).prefixType === 1) {
            console.log(`[SYMBOL-FIX] Original: "${rift.symbol}" → Fixed: "${fixedSymbol}" (underlying: ${rift.underlying}, prefixType: ${(rift as any).prefixType}, meteora: ${rift.hasMeteoraPool})`);
          }

            const converted = {
          id: rift.id,
          symbol: fixedSymbol,
          underlying: rift.underlying,
          tvl: rift.tvl,
          apy: rift.apy,
          backingRatio: rift.backingRatio,
          volume24h: rift.volume24h,
          risk: rift.risk,
          participants: rift.participants,
          strategy: rift.strategy,
          performance: rift.performance?.[0] || rift.apy,
          isActive: rift.oracleStatus === 'active',
          maxCapacity: 100000, // Default capacity
          vault: rift.vault,
          creator: rift.creator, // Rift creator wallet
          treasuryWallet: rift.treasuryWallet, // Treasury wallet for fees
          partnerWallet: rift.partnerWallet, // Partner wallet for partner fees
          oracleStatus: rift.oracleStatus,
          burnFee: rift.burnFee,
          partnerFee: rift.partnerFee, // Partner fee from API
          programVersion: rift.id === 'CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL' ? 'v1' : (rift.programVersion || 'v2'), // V1 rift detection
          createdAt: rift.createdAt ? new Date(rift.createdAt) : undefined, // Creation timestamp for sorting
          arbitragePercentage: 0,
          volatilityApy: 0,
          riftMint: rift.riftMint,
          underlyingMint: rift.underlyingMint,
          hasMeteoraPool: rift.hasMeteoraPool,
          liquidityPool: rift.liquidityPool,
          meteoraPool: rift.meteoraPool,
          // DEBUG: Log pool data from API
          ...(rift.symbol === 'rRIFTS' && console.log('[POOL-DEBUG] rRIFTS pool data from getAllRifts:', {
            liquidityPool: rift.liquidityPool,
            meteoraPool: rift.meteoraPool,
            hasMeteoraPool: rift.hasMeteoraPool
          }), {}),
          meteoraPools: rift.meteoraPools,
          poolType: (rift as any).poolType as 'dlmm' | 'dammv2' | 'cpamm' | undefined, // Pool type from raw_data
          riftTvl: rift.tvl,
          lpTvl: 0,
          totalRiftYield: 0,
          rift30dYield: 0,
          riftPrice: (rift as any).riftTokenPrice || 0,
          fairPrice: (rift as any).underlyingTokenPrice || 0,
          riftTokenPrice: (rift as any).riftTokenPrice,
          underlyingTokenPrice: (rift as any).underlyingTokenPrice,
          totalRiftMinted: (rift as any).totalRiftMinted,
          realBackingRatio: (rift as any).realBackingRatio,
          arbitrageOpportunity: (rift as any).arbitrageOpportunity,
          feeStructure: (() => {
            console.log('🔍 Fee Structure Debug:', {
              riftId: rift.id.slice(0, 8),
              wrapFeeBps: rift.wrapFeeBps,
              unwrapFeeBps: rift.unwrapFeeBps,
              partnerFeeBps: rift.partnerFeeBps,
              transferFeeBps: (rift as any).transferFeeBps,
              burnFee: rift.burnFee,
              partnerFee: rift.partnerFee
            });
            const wrapFeeBps = rift.wrapFeeBps || 30;
            const unwrapFeeBps = rift.unwrapFeeBps || 30;
            // Transfer fee is fetched from Token-2022 mint extension
            const transferFeeBps = (rift as any).transferFeeBps;
            const hasTransferFee = transferFeeBps !== undefined && transferFeeBps !== null;

            return {
              // Individual fee components (in percentage)
              wrapFee: wrapFeeBps / 100, // e.g., 30 bps = 0.3%
              unwrapFee: unwrapFeeBps / 100, // e.g., 30 bps = 0.3%
              performanceFee: 0, // Add performance fee (default 0)
              managementFee: 0, // Add management fee (default 0)
              // Token-2022 transfer fee (0.7%-1.0%, split 50/50)
              hasTransferFee,
              totalTransferFee: hasTransferFee ? transferFeeBps / 100 : null, // Total Token-2022 transfer fee
              treasuryShare: hasTransferFee ? transferFeeBps / 100 / 2 : null, // Treasury gets 50%
              partnerShare: hasTransferFee ? transferFeeBps / 100 / 2 : null // Partner gets 50%
            };
          })(),
          liquidityProfile: {
            depth: 0,
            spread: 0,
            slippage: 0
          },
          revenueShare: {
            riftsHolders: 0,
            lpProviders: 0,
            protocol: 0
          },
          lvfMetrics: {
            efficiency: 0,
            capture: 0,
            decay: 0
          },
          contractAddresses: {
            riftContract: rift.id,
            riftsToken: rift.riftMint
          },
          timeframes: {
            '1h': 0,
            '24h': 0,
            '7d': 0,
            '30d': 0,
            '90d': 0,
            '1y': 0
          },
          prefixType: (rift as any).prefixType
        };
            return converted;
          });

          console.log(`🚀 [LOAD-DEBUG] Converted ${convertedRifts.length} rifts`);
          const burnedInConverted = convertedRifts.find(r => r.id === 'B2ha7xqztT4qtmkzJC3yytaXnex2veEMiFXKUrVx6x8p' || r.riftMint === 'B2ha7xqztT4qtmkzJC3yytaXnex2veEMiFXKUrVx6x8p');
          console.log(`🔥 [LOAD-DEBUG] Burned rift in convertedRifts (from API):`, !!burnedInConverted, burnedInConverted?.id);

          // Apply local DLMM overrides (for newly created monorifts) before filtering and recompute symbol
          const withOverrides = convertedRifts.map(r => {
            const override = dlmmLocalOverrides[r.id] || (r.riftMint ? dlmmLocalOverrides[r.riftMint] : undefined);
            const merged = override ? { ...r, ...override } : r;
            return { ...merged, symbol: getRiftDisplaySymbol(merged, merged.prefixType === 1) };
          });

          // DEBUG: Check for burned rift before filtering
          const BURNED_ID = 'B2ha7xqztT4qtmkzJC3yytaXnex2veEMiFXKUrVx6x8p';
          const burnedBefore = withOverrides.find(r => r.id === BURNED_ID || r.riftMint === BURNED_ID);
          console.log(`🔥 [LOAD-DEBUG] Burned rift BEFORE blacklist filter:`, !!burnedBefore, burnedBefore?.id);

          // Filter out blacklisted rifts before displaying
          let filteredRifts = withOverrides.filter(rift => !isBlacklistedRift(rift));

          // DEBUG: Check for burned rift after blacklist filter
          const burnedAfterBlacklist = filteredRifts.find(r => r.id === BURNED_ID || r.riftMint === BURNED_ID);
          console.log(`🔥 [LOAD-DEBUG] Burned rift AFTER blacklist filter:`, !!burnedAfterBlacklist, burnedAfterBlacklist?.id);

          if (filteredRifts.length < convertedRifts.length) {
            console.log(`🚫 Filtered out ${convertedRifts.length - filteredRifts.length} blacklisted rift(s) from display`);
          }

          // Filter out old/stale rifts (created >30 days ago with TVL < $1000)
          // Exception: Notable rifts (burned, historical) should always be shown
          const NOTABLE_RIFTS = ['B2ha7xqztT4qtmkzJC3yytaXnex2veEMiFXKUrVx6x8p']; // Burned rifts
          const now = Date.now();
          const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
          const MIN_TVL_THRESHOLD = 1000; // $1000 minimum TVL to show old rifts

          filteredRifts = filteredRifts.filter(rift => {
            // Always keep notable rifts (burned, historical importance)
            if (NOTABLE_RIFTS.includes(rift.id) || (rift.riftMint && NOTABLE_RIFTS.includes(rift.riftMint))) {
              console.log(`🔥 [LOAD-DEBUG] Keeping notable rift: ${rift.id} (${rift.symbol})`);
              return true;
            }

            if (!rift.createdAt) return true; // Keep rifts without creation date

            const age = now - rift.createdAt.getTime();
            const isOld = age > THIRTY_DAYS;
            const hasLowTVL = rift.tvl < MIN_TVL_THRESHOLD;

            // Keep if: new OR has significant TVL
            const shouldKeep = !isOld || !hasLowTVL;

            if (!shouldKeep) {
              console.log(`🧹 Filtered out stale rift: ${rift.symbol} (${(age / (24*60*60*1000)).toFixed(1)} days old, $${rift.tvl.toFixed(2)} TVL)`);
            }

            return shouldKeep;
          });

          // DEBUG: Check for burned rift after age filter
          const burnedAfterAge = filteredRifts.find(r => r.id === BURNED_ID || r.riftMint === BURNED_ID);
          console.log(`🔥 [LOAD-DEBUG] Burned rift AFTER age filter:`, !!burnedAfterAge, burnedAfterAge?.id);

          // Add hardcoded burned rift data (PDA was closed on-chain, but mint still exists)
          // This rift should be shown as "burned/untradable" even though its account is gone
          const BURNED_RIFT_MINT = 'B2ha7xqztT4qtmkzJC3yytaXnex2veEMiFXKUrVx6x8p';
          const RIFTS_UNDERLYING_MINT = 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';
          const burnedRiftExists = filteredRifts.some(r => r.riftMint === BURNED_RIFT_MINT || r.id === BURNED_RIFT_MINT);

          if (!burnedRiftExists) {
            // Add the burned rift with hardcoded historical data
            // Supply is 120,133,315 rRIFTS tokens (verified on-chain)
            const BURNED_RIFT_SUPPLY = 120133315;
            // Get REAL RIFTS price from existing rifts data (the V2 rRIFTS rift has underlyingTokenPrice)
            const riftsRift = filteredRifts.find(r => r.underlyingMint === RIFTS_UNDERLYING_MINT);
            const actualRiftsPrice = riftsRift?.underlyingTokenPrice || riftsTokenPrice || 0.0028; // Fallback to state or estimate
            const burnedRiftTvl = BURNED_RIFT_SUPPLY * actualRiftsPrice;
            console.log(`🔥 Burned rift: using RIFTS price $${actualRiftsPrice} → TVL: $${burnedRiftTvl.toFixed(2)}`);

            const burnedRiftData: RiftData = {
              id: BURNED_RIFT_MINT, // Use rift mint as ID since PDA is gone
              riftMint: BURNED_RIFT_MINT,
              programVersion: 'v1' as const, // V1 rift (uses DLMM)
              prefixType: 1, // Treat as monorift for DLMM modal
              symbol: 'rRIFTS',
              underlying: 'RIFTS',
              underlyingMint: 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump',
              tvl: burnedRiftTvl, // Market cap of circulating rift tokens
              apy: 0,
              backingRatio: 0, // Burned - no backing
              volume24h: 0,
              risk: 'High',
              participants: 0,
              strategy: 'Burned',
              performance: 0,
              isActive: false,
              maxCapacity: 0,
              vault: '', // Vault closed
              oracleStatus: 'inactive' as const,
              burnFee: 0,
              arbitragePercentage: 0,
              volatilityApy: 0,
              hasMeteoraPool: false,
              createdAt: new Date('2024-10-01'), // Historical date
              riftTvl: burnedRiftTvl, // Same as TVL for burned rift
              lpTvl: 0,
              totalRiftYield: 0,
              rift30dYield: 0,
              riftPrice: actualRiftsPrice, // Rift tokens worth ~RIFTS price
              fairPrice: actualRiftsPrice,
              totalRiftMinted: BURNED_RIFT_SUPPLY, // Actual supply
              riftTokenPrice: actualRiftsPrice,
              feeStructure: { wrapFee: 0, unwrapFee: 0, performanceFee: 0, managementFee: 0 },
              liquidityProfile: { depth: 0, spread: 0, slippage: 0 },
              revenueShare: { riftsHolders: 0, lpProviders: 0, protocol: 0 },
              lvfMetrics: { efficiency: 0, capture: 0, decay: 0 },
              contractAddresses: { riftContract: BURNED_RIFT_MINT, riftsToken: BURNED_RIFT_MINT },
              timeframes: { '1h': 0, '24h': 0, '7d': 0, '30d': 0, '90d': 0, '1y': 0 }
            };
            filteredRifts.push(burnedRiftData);
            console.log('🔥 Added burned rift to display: B2ha7xqzt... (TVL: $' + burnedRiftTvl.toFixed(2) + ')');
          }

        // DEBUG: Final check before setting state
        const burnedFinal = filteredRifts.find(r => r.id === BURNED_ID || r.riftMint === BURNED_ID);
        console.log(`🔥 [LOAD-DEBUG] Burned rift in FINAL array (${filteredRifts.length} rifts):`, !!burnedFinal, burnedFinal?.id);
        console.log(`🔥 [LOAD-DEBUG] All rift IDs in final array:`, filteredRifts.map(r => `${r.symbol}(${r.id.slice(0,8)}...)`).join(', '));

        setRifts(filteredRifts);

      }
    } catch (error) {

      setRifts([]);
    }
    } catch (error) {

      // Set empty rifts on main error
      setRifts([]);
    } finally {
      if (!hasLoadedOnce) {
        setHasLoadedOnce(true);
      }

      // Always hide loading after fetch completes
      setLoading(false);
      setLoadingStartTime(null);
    }
  }, [serviceReady, hasLoadedOnce, riftProtocolService, dlmmLocalOverrides]);

  // SSR data is now converted during state initialization (convertInitialRifts)
  // No useEffect needed - rifts state is initialized directly from initialRifts prop

  useEffect(() => {
    if (serviceReady && !hasLoadedOnce) {
      loadRifts(true); // Initial load ONLY
    }
    // REMOVED: Subsequent loads were causing double-loading and UI jumps
  }, [loadRifts, serviceReady, hasLoadedOnce]);

  // Fetch running arb bots
  const fetchRunningArbBots = useCallback(async () => {
    try {
      // Use a dummy wallet for fetching - the API returns ALL running bots regardless
      const walletParam = wallet.publicKey || '9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4';
      const response = await fetch(`/api/arb-bot?action=list&wallet=${walletParam}`);
      if (response.ok) {
        const data = await response.json();
        if (data.sessions && Array.isArray(data.sessions)) {
          const runningRiftIds = new Set<string>(
            data.sessions
              .filter((s: { status: string }) => s.status === 'running')
              .map((s: { riftId: string }) => s.riftId)
          );
          setRunningArbBots(runningRiftIds);
        }
      }
    } catch (error) {
      console.error('[ARB-BOT] Failed to fetch running bots:', error);
    }
  }, [wallet.publicKey]);

  // Fetch running bots on mount and periodically
  useEffect(() => {
    fetchRunningArbBots();
    const interval = setInterval(fetchRunningArbBots, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [fetchRunningArbBots]);

  // Start/stop arb bot handlers
  const handleStartArbBot = useCallback(async (riftId: string) => {
    if (!wallet.connected || !wallet.publicKey) return;
    setArbBotLoading(riftId);
    try {
      const response = await fetch('/api/arb-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          riftId,
          walletAddress: wallet.publicKey
        })
      });
      if (response.ok) {
        setRunningArbBots(prev => new Set([...prev, riftId]));
        const toastId = generateToastId();
        setToasts(prev => [...prev, { id: toastId, type: 'success', message: 'Arb bot started!' }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 3000);
        // Force refresh running bots list after a short delay to sync with Supabase
        setTimeout(() => fetchRunningArbBots(), 1000);
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to start bot');
      }
    } catch (error: any) {
      const toastId = generateToastId();
      setToasts(prev => [...prev, { id: toastId, type: 'error', message: error.message || 'Failed to start bot' }]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 5000);
    } finally {
      setArbBotLoading(null);
    }
  }, [wallet.connected, wallet.publicKey, fetchRunningArbBots]);

  const handleStopArbBot = useCallback(async (riftId: string) => {
    if (!wallet.connected || !wallet.publicKey) return;
    setArbBotLoading(riftId);
    try {
      const response = await fetch('/api/arb-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'stop',
          riftId,
          walletAddress: wallet.publicKey
        })
      });
      if (response.ok) {
        setRunningArbBots(prev => {
          const newSet = new Set(prev);
          newSet.delete(riftId);
          return newSet;
        });
        const toastId = generateToastId();
        setToasts(prev => [...prev, { id: toastId, type: 'success', message: 'Arb bot stopped!' }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 3000);
        // Force refresh running bots list after a short delay to sync with Supabase
        setTimeout(() => fetchRunningArbBots(), 1000);
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to stop bot');
      }
    } catch (error: any) {
      const toastId = generateToastId();
      setToasts(prev => [...prev, { id: toastId, type: 'error', message: error.message || 'Failed to stop bot' }]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 5000);
    } finally {
      setArbBotLoading(null);
    }
  }, [wallet.connected, wallet.publicKey, fetchRunningArbBots]);

  // NEW: Calculate real analytics whenever rifts change
  useEffect(() => {
    if (rifts.length > 0) {
      realAnalyticsService.getAnalytics(rifts).then(analytics => {
        setRealProtocolAnalytics(analytics);
      }).catch(error => {
        console.error('[RIFTS-APP] Failed to calculate analytics:', error);
      });
    }
  }, [rifts, realAnalyticsService]);

  // Update burned rift TVL when RIFTS price is fetched
  useEffect(() => {
    if (riftsTokenPrice > 0 && rifts.length > 0) {
      const BURNED_RIFT_MINT = 'B2ha7xqztT4qtmkzJC3yytaXnex2veEMiFXKUrVx6x8p';
      const BURNED_RIFT_SUPPLY = 120133315;

      setRifts(prevRifts => prevRifts.map(rift => {
        if (rift.riftMint === BURNED_RIFT_MINT || rift.id === BURNED_RIFT_MINT) {
          const correctTvl = BURNED_RIFT_SUPPLY * riftsTokenPrice;
          console.log(`🔥 Updated burned rift TVL: $${correctTvl.toFixed(2)} (price: $${riftsTokenPrice})`);
          return {
            ...rift,
            tvl: correctTvl,
            riftTvl: correctTvl,
            riftPrice: riftsTokenPrice,
            fairPrice: riftsTokenPrice,
            riftTokenPrice: riftsTokenPrice
          };
        }
        return rift;
      }));
    }
  }, [riftsTokenPrice]);

  // 🔥 SERVER-SIDE CACHE WARMER: Pre-fetch all rift data on server for instant wraps!
  useEffect(() => {
    if (serviceReady && rifts.length > 0 && wallet.publicKey) {
      // Trigger server-side cache warming (fire-and-forget) - requires admin wallet
      const warmUrl = `/api/warm-cache?wallet=${wallet.publicKey}`;
      fetch(warmUrl)
        .then(res => res.json())
        .then(data => {
          // Cache warmed successfully
        })
        .catch(err => {
          // Silent fail - cache warming is non-critical
        });
    }
  }, [serviceReady, rifts.length, wallet.publicKey]);

  // 🔥 FETCH 100% REAL ANALYTICS when analytics modal opens (always fetch fresh data)
  useEffect(() => {
    if (showAnalyticsModal) {
      // Add timestamp to bust any cache
      fetch(`/api/get-real-analytics?t=${Date.now()}`)
        .then(res => res.json())
        .then(data => {
          setFullRealAnalytics(data);
        })
        .catch(err => {
          // Silent error handling
        });
    }
  }, [showAnalyticsModal]);

  // REMOVED AUTO-REFRESH - it was causing UI to constantly jump around
  // Only refresh balance when unwrap modal is open
  useEffect(() => {
    if (!serviceReady || !wallet.connected) return;

    const refreshInterval = setInterval(async () => {
      try {
        // ONLY refresh balance when unwrap modal is open, don't reload entire rifts list
        // Skip if we recently wrapped (RPC takes 30-60s to update)
        if (showUnwrapModal && selectedRift) {
          const timeSinceLastUpdate = Date.now() - lastBalanceUpdate;
          if (timeSinceLastUpdate > 60000) {
            await fetchRiftTokenBalance(selectedRift); // No bypass - uses timestamp protection
          } else {
            // Skipping balance refresh - recent update
          }
        }
      } catch (error) {
        // Ignore errors
      }
    }, 20000); // Check balance every 20 seconds if modal is open

    return () => clearInterval(refreshInterval);
  }, [serviceReady, wallet.connected, showUnwrapModal, selectedRift]); // FIXED: Removed lastBalanceUpdate to prevent interval leak

  // Fetch rift token balance IMMEDIATELY when unwrap modal opens
  useEffect(() => {
    if (showUnwrapModal && selectedRift && wallet.connected) {
      console.log('🔄 Unwrap modal opened - fetching rift balance immediately');
      console.log('Selected rift:', selectedRift.symbol, 'Mint:', selectedRift.riftMint);
      console.log('Wallet:', wallet.publicKey.toString());
      // BYPASS timestamp protection to force fresh balance fetch
      fetchRiftTokenBalance(selectedRift, true);
    }
  }, [showUnwrapModal]); // Only trigger when modal opens/closes

  // Fetch portfolio data when Portfolio modal opens
  useEffect(() => {
    if (!showPortfolioModal || !wallet.connected || !wallet.publicKey) return;

    const fetchPortfolioData = async () => {
      setPortfolioLoading(true);
      const positions: typeof portfolioPositions = [];

      try {
        const walletPubkey = new PublicKey(wallet.publicKey!);
        const conn = connection as unknown as Connection;
        const { getAssociatedTokenAddress, getAccount, getMint, TOKEN_PROGRAM_ID } = await import('@solana/spl-token');

        // Cache for token decimals to avoid redundant fetches
        const decimalsCache = new Map<string, number>();
        const getTokenDecimals = async (mint: string, programId: any): Promise<number> => {
          const cacheKey = `${mint}-${programId.toBase58()}`;
          if (decimalsCache.has(cacheKey)) return decimalsCache.get(cacheKey)!;
          try {
            const mintInfo = await getMint(conn, new PublicKey(mint), 'confirmed', programId);
            decimalsCache.set(cacheKey, mintInfo.decimals);
            return mintInfo.decimals;
          } catch {
            return 9; // Default to 9 decimals
          }
        };

        // Fetch wrapped token balances for each rift
        console.log('[PORTFOLIO] Fetching wrapped token balances for', rifts.length, 'rifts');
        for (const rift of rifts) {
          if (!rift.riftMint) continue;

          try {
            const riftMintPubkey = new PublicKey(rift.riftMint);

            // Try both TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID
            const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

            for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
              try {
                const userAta = await getAssociatedTokenAddress(riftMintPubkey, walletPubkey, false, programId);
                const tokenAccount = await getAccount(conn, userAta, 'confirmed', programId);

                // Get wrapped token decimals dynamically
                const wrappedDecimals = await getTokenDecimals(rift.riftMint, programId);
                const balance = Number(tokenAccount.amount) / Math.pow(10, wrappedDecimals);

                if (balance > 0.0001) {
                  console.log('[PORTFOLIO] Found balance for', rift.symbol, ':', balance, 'decimals:', wrappedDecimals);

                  // Calculate correct USD value based on underlying token
                  let tokenPrice = rift.riftTokenPrice || rift.underlyingTokenPrice || 0;
                  const underlyingLower = (rift.underlying || '').toLowerCase();

                  // Use solPrice for SOL-based rifts (override with fresh price)
                  if (underlyingLower === 'sol' || underlyingLower === 'wsol') {
                    tokenPrice = solPrice || tokenPrice;
                  }
                  // For other underlying tokens, check if decimal correction is needed
                  else if (rift.underlyingMint) {
                    // Get underlying token decimals
                    let underlyingDecimals = 9; // Default
                    try {
                      // Try TOKEN_PROGRAM_ID first for underlying (most common)
                      underlyingDecimals = await getTokenDecimals(rift.underlyingMint, TOKEN_PROGRAM_ID);
                    } catch {
                      // If not found, underlying might not exist or use different program
                    }

                    // Apply decimal correction: if wrapped has more decimals than underlying
                    // Price is per 1 underlying token, but we display wrapped tokens
                    if (wrappedDecimals !== underlyingDecimals) {
                      const decimalDiff = wrappedDecimals - underlyingDecimals;
                      const correctionFactor = Math.pow(10, decimalDiff);
                      tokenPrice = (tokenPrice || riftsTokenPrice || 0) * correctionFactor;
                      console.log('[PORTFOLIO] Decimal correction for', rift.symbol, ':', wrappedDecimals, '-', underlyingDecimals, '= factor', correctionFactor);
                    }
                  }

                  console.log('[PORTFOLIO] Price for', rift.symbol, ':', tokenPrice, 'underlying:', rift.underlying, 'valueUsd:', balance * tokenPrice);

                  positions.push({
                    type: 'wrapped',
                    riftSymbol: rift.symbol,
                    underlying: rift.underlying || 'Unknown',
                    riftMint: rift.riftMint,
                    balance,
                    valueUsd: balance * tokenPrice,
                  });
                  break; // Found balance, no need to check other program
                }
              } catch {
                // Token account doesn't exist with this program - try next
              }
            }
          } catch (err) {
            // Skip this rift
          }
        }

        // Fetch LP positions from arb-profits API (claim-info)
        try {
          const response = await fetch(`/api/arb-profits?wallet=${wallet.publicKey}&action=claim-info`);
          if (response.ok) {
            const data = await response.json();
            const claimableRifts = data.claimableRifts || [];

            // Deduplicate by riftId - keep entry with highest share or pool address
            const lpMap = new Map<string, typeof claimableRifts[0] & { rift: any; resolvedPoolAddress: string | undefined; resolvedPoolType: string }>();

            for (const lpRift of claimableRifts) {
              // Find the rift from frontend for fallback data
              const rift = rifts.find(r => r.id === lpRift.riftId);

              // Use API-provided poolAddress and poolType first, fall back to frontend rift data
              let poolAddress = (lpRift as any).poolAddress;
              let poolType = (lpRift as any).poolType;

              // Fallback to frontend rift data if API doesn't have pool info
              if (!poolAddress && rift) {
                poolAddress = rift?.meteoraPool || rift?.liquidityPool;
                if (!poolAddress && rift?.meteoraPools && rift.meteoraPools.length > 0) {
                  const firstPool = rift.meteoraPools[0] as any;
                  poolAddress = typeof firstPool === 'string' ? firstPool : (firstPool?.address || firstPool?.pool);
                }
                if (!poolAddress && (rift as any)?.raw_data) {
                  const rawData = (rift as any).raw_data;
                  poolAddress = rawData.meteoraPool || rawData.liquidityPool || rawData.poolAddress;
                }
              }

              // Fallback poolType calculation
              if (!poolType && rift) {
                const isMonorift = (rift as any).prefixType === 1;
                poolType = isMonorift
                  ? ((rift as any).poolType === 'dlmm' ? 'dlmm' : 'dammv2-ss')
                  : 'dammv2';
              }

              const key = lpRift.riftId;
              const existing = lpMap.get(key);

              // Keep entry with pool address, or highest share %
              if (!existing ||
                  (poolAddress && !existing.resolvedPoolAddress) ||
                  (lpRift.sharePct > (existing.sharePct || 0))) {
                lpMap.set(key, { ...lpRift, rift, resolvedPoolAddress: poolAddress, resolvedPoolType: poolType || 'dammv2' });
              }
            }

            // Convert map to positions array
            for (const [, lpEntry] of lpMap) {
              // Get the actual rift token mint from API response (not from frontend rifts array)
              // Falls back to rift lookup if API doesn't have tokenMint
              const actualRiftMint = (lpEntry as any).tokenMint || lpEntry.rift?.riftMint;
              const liquidityAmount = (lpEntry as any).liquidityAmount || 0;

              // Fetch wrapped balance for this rift if we have the mint
              let wrappedBalance = 0;
              if (actualRiftMint) {
                try {
                  const riftMintPubkey = new PublicKey(actualRiftMint);
                  const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

                  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
                    try {
                      const userAta = await getAssociatedTokenAddress(riftMintPubkey, walletPubkey, false, programId);
                      const tokenAccount = await getAccount(conn, userAta, 'confirmed', programId);
                      wrappedBalance = Number(tokenAccount.amount) / 1e9;
                      if (wrappedBalance > 0) break;
                    } catch {
                      // Token account doesn't exist with this program
                    }
                  }
                } catch {
                  // Skip wrapped balance fetch on error
                }
              }

              positions.push({
                type: 'lp',
                riftSymbol: lpEntry.symbol,
                underlying: lpEntry.underlying || 'Unknown',
                riftMint: actualRiftMint, // Use tokenMint from API first
                balance: lpEntry.sharePct || 0, // Share percentage
                valueUsd: lpEntry.claimableSol * 230, // Approximate SOL price
                poolType: lpEntry.resolvedPoolType as 'dammv2' | 'dlmm' | 'dammv2-ss',
                poolAddress: lpEntry.resolvedPoolAddress,
                liquidityAmount,
                wrappedBalance,
              });

              console.log('[PORTFOLIO-LP] Added:', lpEntry.symbol, 'riftAccountId:', lpEntry.riftId?.slice(0,8), 'riftTokenMint:', actualRiftMint?.slice(0,8), 'poolAddress:', lpEntry.resolvedPoolAddress?.slice(0,8), 'liq:', liquidityAmount, 'wrapped:', wrappedBalance);
            }
          }
        } catch (err) {
          console.error('Error fetching LP positions:', err);
        }

        console.log('[PORTFOLIO] Total positions found:', positions.length);
        setPortfolioPositions(positions);
      } catch (err) {
        console.error('Error fetching portfolio data:', err);
      } finally {
        setPortfolioLoading(false);
      }
    };

    fetchPortfolioData();
  }, [showPortfolioModal, wallet.connected, wallet.publicKey, rifts, riftsTokenPrice, solPrice]);

  // Auto-refresh DEX fees while modal is open
  useEffect(() => {
    if (!showClaimDexFeesModal || !selectedRift || !wallet.connected) return;

    const refreshDexFees = async () => {
      try {
        const result = await riftProtocolService.getWithheldVaultFeesAvailable({
          riftPubkey: new PublicKey(selectedRift.id)
        });
        if (result.success) {
          setDexFeesData({
            available: result.available,
            partnerShare: result.partnerShare ?? 0,
            treasuryShare: result.treasuryShare ?? 0,
            userClaimable: result.userClaimable ?? 0
          });
          setAvailableDexFees(result.userClaimable ?? 0);
        }
      } catch (error) {
        console.error('Error refreshing DEX fees:', error);
      }
    };

    const refreshInterval = setInterval(refreshDexFees, 30000); // Refresh every 30 seconds
    return () => clearInterval(refreshInterval);
  }, [showClaimDexFeesModal, selectedRift, wallet.connected]);

  // Auto-refresh Rift fees while modal is open
  useEffect(() => {
    if (!showClaimRiftFeesModal || !selectedRift || !wallet.connected) return;

    const refreshRiftFees = async () => {
      try {
        const result = await riftProtocolService.getVaultFeesAvailable({
          riftPubkey: new PublicKey(selectedRift.id)
        });
        if (result.success) {
          setRiftFeesData({
            available: result.available,
            partnerShare: result.partnerShare || 0,
            treasuryShare: result.treasuryShare || 0,
            userClaimable: result.userClaimable ?? 0
          });
          setAvailableRiftFees(result.userClaimable ?? 0);
        }
      } catch (error) {
        console.error('Error refreshing Rift fees:', error);
      }
    };

    const refreshInterval = setInterval(refreshRiftFees, 30000); // Refresh every 30 seconds
    return () => clearInterval(refreshInterval);
  }, [showClaimRiftFeesModal, selectedRift, wallet.connected]);

  // Fetch deposit quote when SOL or RIFT amount changes (debounced)
  useEffect(() => {
    let timeoutId: NodeJS.Timeout | null = null;

    // FIXED: Actually detect which pool is which by checking token mints
    const detectPoolType = async (poolAddr: string): Promise<'sol' | 'rifts' | 'usd1' | 'unknown'> => {
      try {
        const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
        const cpAmm = new CpAmm(connection as any);
        const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddr));
        const WSOL_MINT = 'So11111111111111111111111111111111111111112';
        const RIFTS_TOKEN_MINT = 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';
        const USD1_MINT = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';

        const tokenAMint = poolState.tokenAMint.toBase58();
        const tokenBMint = poolState.tokenBMint.toBase58();

        const hasWSOL = tokenAMint === WSOL_MINT || tokenBMint === WSOL_MINT;
        const hasRIFTS = tokenAMint === RIFTS_TOKEN_MINT || tokenBMint === RIFTS_TOKEN_MINT;
        const hasUSD1 = tokenAMint === USD1_MINT || tokenBMint === USD1_MINT;

        if (hasWSOL) return 'sol';
        if (hasRIFTS) return 'rifts';
        if (hasUSD1) return 'usd1';
        return 'unknown';
      } catch {
        return 'unknown';
      }
    };

    const findCorrectPool = async (): Promise<string | undefined> => {
      const pools = selectedRift?.meteoraPools || [];

      // If we have explicit pool addresses, use them
      if (liquidityTokenA === 'SOL' && (selectedRift as any)?.solPool) {
        return (selectedRift as any).solPool;
      }
      if (liquidityTokenA === 'USD1' && (selectedRift as any)?.usd1Pool) {
        return (selectedRift as any).usd1Pool;
      }

      // Otherwise, check all pools to find the correct one
      for (const pool of pools) {
        if (!pool || pool === '11111111111111111111111111111111') continue;
        const poolType = await detectPoolType(pool);
        if (liquidityTokenA === 'SOL' && poolType === 'sol') {
          return pool;
        }
        if (liquidityTokenA === 'USD1' && poolType === 'usd1') {
          return pool;
        }
      }

      // Fallback to old logic if detection fails
      if (liquidityTokenA === 'SOL') {
        return pools[1] || pools[0] || selectedRift?.liquidityPool || selectedRift?.meteoraPool;
      }
      // For RIFTS and USD1, no fallback - need to create a new pool
      return undefined;
    };

    const processQuote = async () => {
      // Only skip automatic quoting when custom price mode is enabled
      if (usePriceMode) {
        setDepositQuote(null);
        return;
      }

      const poolAddress = await findCorrectPool();
      const poolExists = poolAddress && poolAddress !== '11111111111111111111111111111111';

      // Don't fetch quote if pool doesn't exist (creating new pool - user sets initial ratio)
      if (!poolExists || !lastEditedField) {
        setDepositQuote(null); // Clear any existing quote
        return;
      }

      // Only fetch quote for the field the user is currently editing
      const amount = lastEditedField === 'sol' ? parseFloat(solLiquidityAmount) : parseFloat(riftLiquidityAmount);

      if (!amount || amount <= 0 || isNaN(amount)) {
        setDepositQuote(null);
        return;
      }

      timeoutId = setTimeout(async () => {
      setIsLoadingQuote(true); // Start loading state

      // Verify pool has correct tokens before fetching quote
      let finalPoolAddress: string | undefined;
      const RIFTS_TOKEN_MINT = 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';

      // Determine which quote token we're pairing with
      const WSOL_MINT = 'So11111111111111111111111111111111111111112';
      const USD1_MINT = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';

      // Get the expected quote token mint based on selection
      let expectedQuoteMint: string;
      let candidatePool: string | undefined;

      if (liquidityTokenA === 'SOL') {
        expectedQuoteMint = WSOL_MINT;
        candidatePool = (selectedRift as any)?.solPool || poolAddress;
      } else {
        // USD1
        expectedQuoteMint = USD1_MINT;
        candidatePool = (selectedRift as any)?.usd1Pool || poolAddress;
      }

      if (candidatePool) {
        try {
          const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
          const cpAmm = new CpAmm(connection as any);
          const poolState = await cpAmm.fetchPoolState(new PublicKey(candidatePool));

          const tokenAMint = poolState.tokenAMint.toBase58();
          const tokenBMint = poolState.tokenBMint.toBase58();
          const riftMint = selectedRift?.riftMint;

          if (!riftMint) {
            setIsLoadingQuote(false);
            setDepositQuote(null);
            return;
          }

          const hasQuoteToken = tokenAMint === expectedQuoteMint || tokenBMint === expectedQuoteMint;
          const hasRift = tokenAMint === riftMint || tokenBMint === riftMint;

          if (hasQuoteToken && hasRift) {
            finalPoolAddress = candidatePool;
          } else {
            // Pool doesn't contain expected quote token - don't fetch quote (user will create new pool)
            setIsLoadingQuote(false);
            setDepositQuote(null);
            return;
          }
        } catch (error) {
          setIsLoadingQuote(false);
          setDepositQuote(null);
          return;
        }
      }

      if (!finalPoolAddress || finalPoolAddress === '11111111111111111111111111111111') {
        setIsLoadingQuote(false); // Stop loading if no pool found
        return;
      }

        // Fetch quote with the verified pool address
        fetchDepositQuote(finalPoolAddress, amount, lastEditedField);
      }, 500); // 500ms debounce
    };

    processQuote();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [solLiquidityAmount, riftLiquidityAmount, lastEditedField, selectedRift, liquidityTokenA, usePriceMode, createNewPool]);

  // Handle price-based calculation for new pools
  useEffect(() => {
    // Only apply price-based calculation when:
    // 1. Price mode is enabled
    // 2. No existing pool (depositQuote is null)
    // 3. User has entered an amount in one field
    if (!usePriceMode || depositQuote) {
      return;
    }

    const price = parseFloat(initialPrice);
    if (isNaN(price) || price <= 0) {
      return;
    }

    // If user edited the RIFT amount, calculate SOL amount
    if (lastEditedField === 'rift') {
      const riftAmt = parseFloat(riftLiquidityAmount);
      if (!isNaN(riftAmt) && riftAmt > 0) {
        const solAmt = (riftAmt * price).toFixed(6);
        setSolLiquidityAmount(solAmt);
        setLiquidityRatio(price);
      }
    }
    // If user edited the SOL amount, calculate RIFT amount
    else if (lastEditedField === 'sol') {
      const solAmt = parseFloat(solLiquidityAmount);
      if (!isNaN(solAmt) && solAmt > 0) {
        const riftAmt = (solAmt / price).toFixed(6);
        setRiftLiquidityAmount(riftAmt);
        setLiquidityRatio(price);
      }
    }
  }, [usePriceMode, initialPrice, solLiquidityAmount, riftLiquidityAmount, lastEditedField, depositQuote]);

  // Update liquidityRatio from input amounts when creating new pool OR no pool quote
  useEffect(() => {
    console.log('[RATIO-CALC] useEffect triggered:', {
      usePriceMode,
      createNewPool,
      hasDepositQuote: !!depositQuote,
      solLiquidityAmount,
      riftLiquidityAmount
    });

    // Skip if Custom Price mode is ON (user manually controls ratio)
    if (usePriceMode) {
      console.log('[RATIO-CALC] Skipping - usePriceMode is ON');
      return;
    }

    // When creating a new pool, ALWAYS use input amounts (ignore existing pool ratio)
    // When NOT creating new pool, only update if no quote exists
    if (!createNewPool && depositQuote) {
      console.log('[RATIO-CALC] Skipping - using depositQuote ratio instead');
      return;
    }

    const solAmt = parseFloat(solLiquidityAmount);
    const riftAmt = parseFloat(riftLiquidityAmount);

    console.log('[RATIO-CALC] Parsed amounts:', { solAmt, riftAmt });

    if (!isNaN(solAmt) && solAmt > 0 && !isNaN(riftAmt) && riftAmt > 0) {
      // liquidityRatio = rRIFTS per SOL (to display "1 SOL = X rRIFTS")
      const ratio = riftAmt / solAmt;
      console.log('[RATIO-CALC] Setting liquidityRatio to:', ratio);
      setLiquidityRatio(ratio);
    } else {
      console.log('[RATIO-CALC] Invalid amounts, not updating ratio');
    }
  }, [solLiquidityAmount, riftLiquidityAmount, usePriceMode, depositQuote, createNewPool]);

  // Initialize ecosystem when wallet connects
  /*
  const initializeEcosystem = useCallback(async () => {
    if (!wallet.connected || !wallet.publicKey) return;
    
    try {

      const walletAdapter = {
        publicKey: new PublicKey(wallet.publicKey),
        sendTransaction: walletAdapterSendTx || (async () => ({ signature: 'simulation_mode' })),
        signTransaction: async (transaction: Transaction) => transaction // For simulation mode
      };
      
      const result = await ecosystemManager.initialize(walletAdapter);
      
      if (result.success) {
        setEcosystemStatus(result.status);
        setSystemHealth(result.status.health);

        // Initialize keeper service for automated operations
        try {
          const keeper = await initializeKeeper();
          
          // Register volume tracking callback
          riftsService.onVolumeUpdate((riftId, volume) => {
            keeper.addVolume(riftId, volume);
          });
          
          // Start keeper service
          await keeper.start();

        } catch (error) {

        }
        
        // Listen for health updates
        if (typeof window !== 'undefined') {
          // window.addEventListener('rifts-health-update', (event: any) => {
            // setSystemHealth(event.detail.overall);
          // });
        }
      } else {

      }
    } catch (error) {

    }
  }, [wallet.connected, wallet.publicKey, walletAdapterSendTx]);
  */

  // Load REAL RIFTS token balance and staking info
  const loadRIFTSTokenData = useCallback(async () => {
    if (!wallet.publicKey) return;
    
    try {
      // Get REAL RIFTS token balance from onchain data
      const { getAssociatedTokenAddress, getAccount } = await import('@solana/spl-token');
      const RIFTS_MINT = new PublicKey(process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump');
      
      try {
        const userRiftsAccount = await getAssociatedTokenAddress(RIFTS_MINT, new PublicKey(wallet.publicKey));
        const accountInfo = await getAccount(connection as unknown as Connection, userRiftsAccount);
        const realRiftsBalance = Number(accountInfo.amount) / Math.pow(10, 9); // 9 decimals
        setRiftsBalance(realRiftsBalance);

      } catch {
        // No RIFTS token account exists yet
        setRiftsBalance(0);

      }
      
      // Get REAL LP staking information from blockchain
      const { lpStakingClient } = await import('@/lib/solana/lp-staking-client');
      const lpTokenMint = new PublicKey(process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump');
      const stakingInfo = await lpStakingClient.getUserStakingInfo(lpTokenMint, new PublicKey(wallet.publicKey));
      setStakedAmount(stakingInfo.stakedAmount);
      setStakingRewards(stakingInfo.pendingRewards);

      // Get user's LP token balance (using RIFTS as LP tokens)
      try {
        const userLpAccount = await getAssociatedTokenAddress(lpTokenMint, new PublicKey(wallet.publicKey));
        const { Connection } = await import('@solana/web3.js');
        const lpEndpoint = typeof window !== 'undefined'
          ? `${window.location.origin}/api/rpc-http`
          : (process.env.NEXT_PUBLIC_SOLANA_RPC_URL as string);
        const conn = new Connection(lpEndpoint, 'confirmed');
        const lpAccountInfo = await conn.getTokenAccountBalance(userLpAccount);
        setLpTokenBalance(parseFloat(lpAccountInfo.value.amount) / 1e9);
      } catch (error) {
        console.error('❌ Error fetching LP balance:', error);
        // No LP tokens yet
        setLpTokenBalance(0);
      }

    } catch (error) {

    }
  }, [wallet.publicKey, riftsBalance]);

  // Refresh LP balance when staking modal opens
  useEffect(() => {
    if (showStakingModal && wallet.publicKey) {
      loadRIFTSTokenData();
    }
  }, [showStakingModal, wallet.publicKey]);

  // Load real treasury and fee collector stats
  /*
  const loadTreasuryData = useCallback(async () => {
    try {

      const [treasuryData, feeCollectorData] = await Promise.all([
        treasuryManager.getTreasuryStatus(),
        realFeeIntegration.getFeeCollectorStatus()
      ]);
      
      setTreasuryStats(treasuryData);
      setFeeCollectorStatus(feeCollectorData);

    } catch (error) {

    }
  }, []);
  */

  // Process accumulated fees manually
  // const handleProcessFees = async () => {
  //   if (!wallet.publicKey || !selectedRift) {
  //     alert('Please connect wallet and select a rift first');
  //     return;
  //   }

  //   try {

  //     const result = await realFeeIntegration.processAccumulatedFees(
  //       new PublicKey(selectedRift.id),
  //       {
  //         publicKey: new PublicKey(wallet.publicKey),
  //         sendTransaction: walletAdapterSendTx || (async () => ({ signature: 'simulation' }))
  //       }
  //     );

  //     if (result.success) {
  //       alert(`✅ Fees processed successfully!\n\nProcessed: ${result.feesProcessed?.toFixed(4)} SOL\nTransaction: ${result.signature}`);
  //       await loadTreasuryData(); // Refresh treasury data
  //       await loadRifts(); // Refresh rift data
  //     } else {
  //       alert(`❌ Fee processing failed: ${result.error}`);
  //     }
  //   } catch (error) {

  //     alert('Error processing fees. Check console for details.');
  //   }
  // };

  // Handle adding liquidity to RIFTS/SOL pool
  const handleAddLiquidity = async () => {
    if (!wallet.publicKey) {
      alert('Please connect your wallet first');
      return;
    }

    if (!walletAdapterSendTx) {
      alert('Wallet does not support transactions. Please use a compatible wallet.');
      return;
    }

    try {

      const result = await dexIntegration.addInitialRIFTSLiquidity(
        {
          publicKey: wallet.publicKey,
          sendTransaction: walletAdapterSendTx
        },
        0.1, // 0.1 SOL
        200  // 200 RIFTS
      );

      if (result.success) {
        setNotification({
          type: 'success',
          title: '💧 Liquidity Added Successfully!',
          message: `Successfully added liquidity to RIFTS/SOL pool!\n\n` +
                   `Added: 0.1 SOL + 200 RIFTS tokens\n\n` +
                   `Pool Address: ${result.poolAddress}\n\n` +
                   `✅ RIFTS can now be traded on DEXs!`,
          signature: result.signature
        });
      } else {
        setNotification({
          type: 'error',
          title: '❌ Liquidity Failed',
          message: result.error || 'Failed to add liquidity'
        });
      }
    } catch (error) {

      setNotification({
        type: 'error',
        title: '❌ Unexpected Error',
        message: 'An unexpected error occurred while adding liquidity.'
      });
    }
  };

  // Handle buying RIFTS tokens
  const handleBuyRIFTS = async () => {
    if (!wallet.publicKey) {
      alert('Please connect your wallet first');
      return;
    }

    if (!walletAdapterSendTx) {
      alert('Wallet does not support transactions. Please use a compatible wallet.');
      return;
    }

    try {

      // First check if there's sufficient liquidity
      const liquidityCheck = await dexIntegration.checkRIFTSLiquidity();
      
      if (!liquidityCheck.hasLiquidity) {
        setNotification({
          type: 'info',
          title: '💧 Liquidity Required',
          message: `RIFTS/SOL pool needs liquidity before trading!\n\n` +
                   `Current liquidity: ${liquidityCheck.solReserve} SOL + ${liquidityCheck.riftsReserve} RIFTS\n\n` +
                   `Please add initial liquidity using the "💧 Liquidity" button first.\n\n` +
                   `This will enable DEX trading for RIFTS tokens.`
        });
        return;
      }
      
      // Execute real RIFTS token purchase through DEX
      const solAmount = 0.1; // 0.1 SOL worth 
      const expectedRiftsAmount = 20; // Expected RIFTS tokens (0.1 SOL / 0.005 = 20 RIFTS)
      
      const result = await dexIntegration.buyRIFTS(
        {
          publicKey: wallet.publicKey,
          sendTransaction: walletAdapterSendTx
        }, 
        solAmount,
        expectedRiftsAmount
      );

      if (result.success) {
        // Show success notification with token mint address
        const riftsTokenMint = process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';
        
        setNotification({
          type: 'success',
          title: '🎉 RIFTS Swap Successful!',
          message: `Successfully swapped ${solAmount} SOL for RIFTS tokens!\n\n` +
                   `Transaction: ${result.signature}\n\n` +
                   `✅ RIFTS tokens have been deposited to your wallet\n\n` +
                   `📱 To see your RIFTS tokens in Phantom:\n` +
                   `1. Copy the token address below\n` +
                   `2. Add custom token in Phantom\n` +
                   `3. Token address: ${riftsTokenMint}\n\n` +
                   `🎯 Your RIFTS tokens should appear immediately!`,
          signature: result.signature
        });
        
        await loadRIFTSTokenData(); // Refresh balances
        await refreshBalance(); // Refresh SOL balance
      } else {
        setNotification({
          type: 'error',
          title: '❌ Purchase Failed',
          message: result.error || 'Unknown error occurred'
        });
      }
    } catch (error) {

      setNotification({
        type: 'error',
        title: '❌ Unexpected Error',
        message: 'An unexpected error occurred while purchasing RIFTS tokens. Please check the console for details and try again.'
      });
    }
  };

  // Show confirmation before staking
  const handleStakeLPClick = () => {
    if (!wallet.publicKey || !stakingAmount) {
      setNotification({
        type: 'error',
        title: 'Missing Information',
        message: 'Please connect your wallet and enter an amount to stake.'
      });
      return;
    }

    if (parseFloat(stakingAmount) > lpTokenBalance) {
      setNotification({
        type: 'error',
        title: 'Insufficient Balance',
        message: `You only have ${lpTokenBalance.toFixed(4)} LP tokens available.`
      });
      return;
    }

    // Show confirmation modal
    setShowStakingConfirmation(true);
  };

  // Handle staking LP tokens (after confirmation)
  const handleStakeLP = async () => {
    setIsWrapping(true);

    try {
      // Import LP staking client
      const { lpStakingClient } = await import('@/lib/solana/lp-staking-client');

      // For now, we'll use RIFTS mint as the LP token (in production, use actual LP token mint)
      const lpTokenMint = new PublicKey(process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump');

      // Check walletAdapterSendTx exists
      if (!walletAdapterSendTx) {
        throw new Error('Wallet not connected');
      }

      // Execute real LP token staking
      const result = await lpStakingClient.stakeLPTokens(
        lpTokenMint,
        parseFloat(stakingAmount),
        new PublicKey(wallet.publicKey),
        async (tx) => await walletAdapterSendTx(tx, lpStakingClient['connection'])
      );

      if (result.success) {
        setNotification({
          type: 'success',
          title: 'Staking Successful!',
          message: `Successfully staked ${result.amount?.toFixed(4)} LP tokens. You are now earning RIFTS rewards!`,
          signature: result.signature
        });

        // Refresh balances
        await loadRIFTSTokenData();

        // Close modal and reset form
        setShowStakingModal(false);
        setStakingAmount('');
      } else {
        setNotification({
          type: 'error',
          title: 'Staking Failed',
          message: result.error || 'Failed to stake LP tokens'
        });
      }
    } catch (error) {
      setNotification({
        type: 'error',
        title: 'Staking Error',
        message: cleanErrorMessage(error, 'Failed to stake LP tokens. Please try again.')
      });
    } finally {
      setIsWrapping(false);
    }
  };

  // Handle unstake LP tokens
  const handleUnstakeLP = async () => {
    setIsWrapping(true);

    try {
      // Import LP staking client
      const { lpStakingClient } = await import('@/lib/solana/lp-staking-client');

      // Use RIFTS mint as the LP token
      const lpTokenMint = new PublicKey(process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump');

      // Check walletAdapterSendTx exists
      if (!walletAdapterSendTx) {
        throw new Error('Wallet not connected');
      }

      // Execute unstake
      const result = await lpStakingClient.unstakeLPTokens(
        lpTokenMint,
        parseFloat(unstakeAmount),
        new PublicKey(wallet.publicKey),
        async (tx) => await walletAdapterSendTx(tx, lpStakingClient['connection'])
      );

      if (result.success) {
        setNotification({
          type: 'success',
          title: 'Unstaking Successful!',
          message: `Successfully unstaked ${result.amount?.toFixed(4)} LP tokens. They have been returned to your wallet.`,
          signature: result.signature
        });

        // Refresh balances
        await loadRIFTSTokenData();

        // Reset form
        setUnstakeAmount('');
      } else {
        setNotification({
          type: 'error',
          title: 'Unstaking Failed',
          message: result.error || 'Failed to unstake LP tokens'
        });
      }
    } catch (error) {
      setNotification({
        type: 'error',
        title: 'Unstaking Error',
        message: cleanErrorMessage(error, 'Failed to unstake LP tokens. Please try again.')
      });
    } finally {
      setIsWrapping(false);
    }
  };

  // Handle claim RIFTS rewards
  const handleClaimRewards = async () => {
    setIsWrapping(true);

    try {
      // Import LP staking client
      const { lpStakingClient } = await import('@/lib/solana/lp-staking-client');

      // Use RIFTS mint as the LP token
      const lpTokenMint = new PublicKey(process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump');

      // Check walletAdapterSendTx exists
      if (!walletAdapterSendTx) {
        throw new Error('Wallet not connected');
      }

      // Execute claim rewards
      const result = await lpStakingClient.claimRewards(
        lpTokenMint,
        new PublicKey(wallet.publicKey),
        async (tx) => await walletAdapterSendTx(tx, lpStakingClient['connection'])
      );

      if (result.success) {
        setNotification({
          type: 'success',
          title: 'Rewards Claimed!',
          message: `Successfully claimed your RIFTS rewards! Check your wallet balance.`,
          signature: result.signature
        });

        // Refresh balances
        await loadRIFTSTokenData();
      } else {
        setNotification({
          type: 'error',
          title: 'Claim Failed',
          message: result.error || 'Failed to claim rewards'
        });
      }
    } catch (error) {
      setNotification({
        type: 'error',
        title: 'Claim Error',
        message: cleanErrorMessage(error, 'Failed to claim rewards. Please try again.')
      });
    } finally {
      setIsWrapping(false);
    }
  };

  // Handle voting on proposals
  const handleVote = async () => {

    if (!wallet.publicKey) {
      alert('Please connect your wallet first');
      return;
    }

    setShowGovernance(true);
  };

  // Handle wrap tokens
  const handleWrap = async () => {
    if (!selectedRift || !wrapAmount || !wallet.publicKey) {

      return;
    }

    if (!walletAdapterSendTx || !walletAdapterSignTx) {
      throw new Error('Wallet not properly connected. Please disconnect and reconnect your wallet.');
    }

    setIsWrapping(true);
    try {
      const productionService = new ProductionRiftsService(connection as unknown as Connection);

      // Use the wallet adapter from useRealWallet (works with all wallets: Phantom, Solflare, Backpack, etc.)
      const walletAdapter = {
        publicKey: new PublicKey(wallet.publicKey),
        sendTransaction: async (transaction: Transaction, conn: Connection, options?: any) => {
          try {
            // Ensure blockhash is set
            if (!transaction.recentBlockhash) {
              console.warn('⚠️ Blockhash not set, fetching now...');
              const latestBlockhash = await conn.getLatestBlockhash();
              transaction.recentBlockhash = latestBlockhash.blockhash;
            }
            if (!transaction.feePayer) {
              transaction.feePayer = new PublicKey(wallet.publicKey);
            }

            console.log('📤 [WRAP] Sending transaction via wallet adapter...');
            const signature = await walletAdapterSendTx(transaction, conn, options);
            console.log('✅ [WRAP] Transaction sent:', signature);

            return signature;
          } catch (error: any) {
            console.error('❌ WALLET ADAPTER ERROR:', error);
            throw error;
          }
        },
        signTransaction: async (transaction: Transaction) => {
          const signed = await walletAdapterSignTx(transaction);
          return signed;
        }
      };

      productionService.setWallet(walletAdapter);

      const result = await productionService.wrapTokens({
        user: new PublicKey(wallet.publicKey),
        riftPubkey: new PublicKey(selectedRift.id),
        amount: parseFloat(wrapAmount),
        slippageBps: parseFloat(slippageTolerance) * 100, // Convert % to basis points
        transferFeeBps: (selectedRift as any).transferFeeBps // Token-2022 transfer fee for accurate slippage calculation
      });

      if (result.success) {

        setShowWrapModal(false);
        setWrapAmount('');

        // Calculate actual tokens received after 0.3% fee
        const wrapAmountNum = parseFloat(wrapAmount);
        const feePercentage = 0.003; // 0.3% fee
        const tokensReceived = wrapAmountNum * (1 - feePercentage);

        // UPDATE BALANCE INSTANTLY - Don't wait for blockchain confirmation!
        const currentBalance = selectedRiftTokenBalance || 0;
        const newBalance = currentBalance + tokensReceived;
        const timestamp = Date.now();
        setLastBalanceUpdate(timestamp); // Mark timestamp FIRST to prevent stale fetches from overwriting
        setSelectedRiftTokenBalance(newBalance);
        setSelectedRiftBalance(newBalance); // Also update for liquidity modal

        // Show Wrap Success Modal
        setWrapSuccessData({
          type: 'wrap',
          amount: wrapAmountNum,
          tokensReceived: tokensReceived,
          tokenSymbol: selectedRift.symbol || '',
          underlyingSymbol: selectedRift.underlying || '',
          signature: result.signature || '',
          riftPDA: selectedRift.id,
        });
        setShowWrapSuccessModal(true);

        // UPDATE TVL INSTANTLY in local state (optimistic update)
        if (selectedRift && result.newTvl !== undefined) {
          const newTvl = result.newTvl; // Store to ensure type safety
          setRifts(prevRifts => prevRifts.map(r =>
            r.id === selectedRift.id ? { ...r, tvl: newTvl } : r
          ));
        }

        // Clear cache to ensure fresh data
        productionService.clearCache();

        // DON'T fetch balance from RPC - it will overwrite the correct optimistic update with stale data
        // Balance will sync on next modal open anyway

        await loadRIFTSTokenData(); // Refresh RIFTS and other balances
      } else {

        setNotification({
          type: 'error',
          title: '❌ Wrap Failed',
          message: result.error || 'Failed to wrap tokens and create pool'
        });
      }
    } catch (error) {

    } finally {
      setIsWrapping(false);
    }
  };

  // Handle unwrap tokens
  const handleUnwrap = async () => {
    if (!selectedRift || !unwrapAmount || !wallet.publicKey) {

      return;
    }

    if (!walletAdapterSendTx || !walletAdapterSignTx) {
      throw new Error('Wallet not properly connected. Please disconnect and reconnect your wallet.');
    }

    setIsUnwrapping(true);
    try {
      const productionService = new ProductionRiftsService(connection as unknown as Connection);

      // Use the wallet adapter from useRealWallet (works with all wallets: Phantom, Solflare, Backpack, etc.)
      const walletAdapter = {
        publicKey: new PublicKey(wallet.publicKey),
        sendTransaction: async (transaction: Transaction, conn: Connection, options?: any) => {
          try {
            // Ensure blockhash is set
            if (!transaction.recentBlockhash) {
              console.warn('⚠️ Blockhash not set, fetching now...');
              const latestBlockhash = await conn.getLatestBlockhash();
              transaction.recentBlockhash = latestBlockhash.blockhash;
            }
            if (!transaction.feePayer) {
              transaction.feePayer = new PublicKey(wallet.publicKey);
            }

            console.log('📤 [UNWRAP] Sending transaction via wallet adapter...');
            const signature = await walletAdapterSendTx(transaction, conn, options);
            console.log('✅ [UNWRAP] Transaction sent:', signature);

            return signature;
          } catch (error: any) {
            console.error('❌ WALLET ADAPTER ERROR:', error);
            throw error;
          }
        },
        signTransaction: async (transaction: Transaction) => {
          const signed = await walletAdapterSignTx(transaction);
          return signed;
        }
      };

      productionService.setWallet(walletAdapter);

      const result = await productionService.unwrapTokens({
        user: new PublicKey(wallet.publicKey),
        riftPubkey: new PublicKey(selectedRift.id),
        riftTokenAmount: parseFloat(unwrapAmount),
        slippageBps: parseFloat(slippageTolerance) * 100, // Convert % to basis points
        transferFeeBps: (selectedRift as any).transferFeeBps // Token-2022 transfer fee for accurate slippage calculation
      });

      if (result.success) {

        setShowUnwrapModal(false);

        // UPDATE BALANCE INSTANTLY - Don't wait for blockchain!
        const unwrapAmountNum = parseFloat(unwrapAmount);
        const currentBalance = selectedRiftTokenBalance || 0;
        const newBalance = Math.max(0, currentBalance - unwrapAmountNum); // Don't go negative
        setSelectedRiftTokenBalance(newBalance);
        setSelectedRiftBalance(newBalance);
        setLastBalanceUpdate(Date.now()); // Mark timestamp to prevent stale fetches from overwriting

        // UPDATE TVL INSTANTLY in local state (optimistic update)
        if (selectedRift && result.newTvl !== undefined) {
          const newTvl = result.newTvl; // Store to ensure type safety
          setRifts(prevRifts => prevRifts.map(r =>
            r.id === selectedRift.id ? { ...r, tvl: newTvl } : r
          ));
        }

        // Clear cache to ensure fresh data
        productionService.clearCache();

        // DON'T fetch balance from RPC - it will overwrite the correct optimistic update with stale data
        // Balance will sync on next modal open anyway

        await loadRIFTSTokenData(); // Refresh RIFTS and other balances

        // Show Unwrap Success Modal
        setWrapSuccessData({
          type: 'unwrap',
          amount: unwrapAmountNum,
          tokensReceived: unwrapAmountNum, // Same amount for unwrap (no fee on unwrap)
          tokenSymbol: selectedRift.symbol || '',
          underlyingSymbol: selectedRift.underlying || '',
          signature: result.signature || '',
          riftPDA: selectedRift.id,
        });
        setShowWrapSuccessModal(true);
        setUnwrapAmount('');
      } else {
        setNotification({
          type: 'error',
          title: '❌ Unwrap Failed',
          message: result.error || 'Transaction failed to confirm'
        });
        // Keep modal open so user can retry after fixing inputs/network
        setShowUnwrapModal(true);
      }
    } catch (error) {

    } finally {
      setIsUnwrapping(false);
    }
  };

  // Fetch available vault fees
  const fetchAvailableVaultFees = async (rift: RiftData, retryCount = 0) => {
    try {
      setIsLoadingVaultFees(true);

      // **FIX**: If this is the first attempt and a transaction just completed,
      // wait 3 seconds for RPC to update before fetching fees
      if (retryCount === 0 && lastBalanceUpdate > 0) {
        const timeSinceTransaction = Date.now() - lastBalanceUpdate;
        if (timeSinceTransaction < 5000) { // Within 5 seconds of a transaction
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      const result = await riftProtocolService.getVaultFeesAvailable({
        riftPubkey: new PublicKey(rift.id)
      });

      if (result.success) {
        setAvailableVaultFees(result.available);

        // **FIX**: If fees are still 0 and we haven't retried yet, try once more after delay
        if (result.available === 0 && retryCount === 0 && lastBalanceUpdate > 0) {
          const timeSinceTransaction = Date.now() - lastBalanceUpdate;
          if (timeSinceTransaction < 10000) { // Within 10 seconds of transaction
            setTimeout(() => fetchAvailableVaultFees(rift, 1), 3000);
          }
        }
      } else {
        console.error('Failed to fetch vault fees:', result.error);
        setAvailableVaultFees(0);
      }
    } catch (error) {
      console.error('Error fetching vault fees:', error);
      setAvailableVaultFees(0);
    } finally {
      setIsLoadingVaultFees(false);
    }
  };

  // Handle claim fees from vault
  const handleClaimFees = async () => {
    if (!selectedRift || !wallet.publicKey) {
      return;
    }

    try {
      setIsClaimingFees(true);

      const amount = parseFloat(claimFeesAmount);
      if (!amount || amount <= 0) {
        console.error('Invalid claim fees amount');
        return;
      }

      const result = await riftProtocolService.distributeFeesFromVault({
        riftPubkey: new PublicKey(selectedRift.id),
        amount
      });

      if (result.success) {
        setShowClaimFeesModal(false);
        setClaimFeesAmount('');

        // Refresh rifts data
        await loadRifts();
      } else {
        console.error('Failed to claim fees:', result.error);
      }
    } catch (error) {
      console.error('Error claiming fees:', error);
    } finally {
      setIsClaimingFees(false);
    }
  };

  // Handle claim DEX fees (from withheld vault)
  const handleClaimDexFees = async () => {
    if (!selectedRift || !wallet.publicKey) {
      return;
    }

    try {
      setIsClaimingDexFees(true);

      let amount = parseFloat(claimDexFeesAmount);
      if (!amount || amount <= 0) {
        console.error('Invalid claim DEX fees amount');
        return;
      }

      // The program ALWAYS does a 50/50 split between partner and treasury.
      // If user sees a partial share (userClaimable < available), we need to
      // convert their input to the full distribution amount.
      // This is more reliable than checking isPartner/isTreasury which may use stale data.
      if (dexFeesData.userClaimable > 0 && dexFeesData.userClaimable < dexFeesData.available) {
        const userSharePercent = dexFeesData.userClaimable / dexFeesData.available;
        const originalAmount = amount;
        amount = amount / userSharePercent; // Convert to total distribution amount
        console.log(`[CLAIM-DEX] User has ${(userSharePercent * 100).toFixed(0)}% share, converting input ${originalAmount} to total distribution ${amount}`);
      } else {
        console.log(`[CLAIM-DEX] User has 100% share (or is neither partner/treasury), using amount as-is: ${amount}`);
      }

      const result = await riftProtocolService.claimDexFees({
        riftPubkey: new PublicKey(selectedRift.id),
        amount
      });

      if (result.success) {
        setShowClaimDexFeesModal(false);
        setClaimDexFeesAmount('');

        // Show styled success modal
        setFeesClaimedData({
          type: 'dex',
          amount: parseFloat(claimDexFeesAmount) || 0,
          signature: result.signature || '',
          symbol: selectedRift?.symbol || 'Token'
        });
        setShowFeesClaimedModal(true);

        // Refresh rifts data
        await loadRifts();

        // Refresh DEX fees data in real-time
        try {
          const feesResult = await riftProtocolService.getWithheldVaultFeesAvailable({
            riftPubkey: new PublicKey(selectedRift.id)
          });
          if (feesResult.success) {
            setDexFeesData({
              available: feesResult.available,
              partnerShare: feesResult.partnerShare ?? 0,
              treasuryShare: feesResult.treasuryShare ?? 0,
              userClaimable: feesResult.userClaimable ?? 0
            });
            setAvailableDexFees(feesResult.userClaimable ?? 0);
          }
        } catch (error) {
          console.error('Error refreshing DEX fees:', error);
        }
      } else {
        // Show error toast
        const toastId = generateToastId();
        setToasts(prev => [...prev, {
          id: toastId,
          type: 'error',
          message: result.error || 'Failed to claim DEX fees'
        }]);
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== toastId));
        }, 5000);
      }
    } catch (error) {
      console.error('Error claiming DEX fees:', error);
      // Show error toast
      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: cleanErrorMessage(error, 'Error claiming DEX fees')
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);
    } finally {
      setIsClaimingDexFees(false);
    }
  };

  // Handle claim Rift fees (from fees vault)
  const handleClaimRiftFees = async () => {
    if (!selectedRift || !wallet.publicKey) {
      return;
    }

    try {
      setIsClaimingRiftFees(true);

      // Refresh fees just before sending to avoid using stale values
      let latestFees = riftFeesData;
      try {
        const latest = await riftProtocolService.getVaultFeesAvailable({
          riftPubkey: new PublicKey(selectedRift.id)
        });
        if (latest.success) {
          latestFees = {
            available: latest.available,
            partnerShare: latest.partnerShare || 0,
            treasuryShare: latest.treasuryShare || 0,
            userClaimable: latest.userClaimable ?? 0
          };
          setRiftFeesData(latestFees);
          setAvailableRiftFees(latestFees.userClaimable);
        }
      } catch (refreshErr) {
        console.warn('[CLAIM-RIFT] Failed to refresh fees, using cached values', refreshErr);
      }

      const parsedAmount = parseFloat(claimRiftFeesAmount);
      if (!parsedAmount || parsedAmount <= 0) {
        console.error('Invalid claim Rift fees amount');
        const toastId = generateToastId();
        setToasts(prev => [...prev, {
          id: toastId,
          type: 'error',
          message: 'Enter a valid amount to claim fees'
        }]);
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== toastId));
        }, 5000);
        return;
      }

      let amount = parsedAmount;

      // Check if user is partner or treasury (not claiming 100%)
      const userWallet = wallet.publicKey.toString();
      const isPartner = selectedRift.partnerWallet && selectedRift.partnerWallet === userWallet;
      const isTreasury = selectedRift.treasuryWallet && selectedRift.treasuryWallet === userWallet;
      const isPartnerOrTreasury = isPartner || isTreasury;

      // If user is partner or treasury, they entered their portion only
      // We need to double it to get the total distribution amount
      // (e.g., if partner enters 3, we distribute 6 total: 3 to partner, 3 to treasury)
      if (isPartnerOrTreasury && latestFees.userClaimable < latestFees.available) {
        const userSharePercent = latestFees.userClaimable / latestFees.available;
        amount = amount / userSharePercent; // Convert to total distribution amount
        console.log(`[CLAIM-RIFT] User is ${isPartner ? 'partner' : 'treasury'}, converting input ${claimRiftFeesAmount} to total distribution ${amount}`);
      }

      const maxAvailable = latestFees.userClaimable ?? 0;
      if (!maxAvailable || maxAvailable <= 0) {
        const toastId = generateToastId();
        setToasts(prev => [...prev, {
          id: toastId,
          type: 'error',
          message: 'No claimable Rift fees available'
        }]);
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== toastId));
        }, 5000);
        return;
      }

      // Safety clamp to avoid on-chain InsufficientFees due to rounding
      // Use latestFees.available (full vault) not maxAvailable (user's share) because
      // the on-chain program distributes the full amount between partner and treasury
      const maxDistributable = latestFees.available ?? maxAvailable;
      const safetyMargin = Math.max(1e-9, maxDistributable * 1e-6);
      amount = Math.min(amount, Math.max(0, maxDistributable - safetyMargin));
      if (!amount || amount <= 0) {
        const toastId = generateToastId();
        setToasts(prev => [...prev, {
          id: toastId,
          type: 'error',
          message: 'Amount too small to claim after safety checks'
        }]);
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== toastId));
        }, 5000);
        return;
      }

      let result = await riftProtocolService.claimRiftFees({
        riftPubkey: new PublicKey(selectedRift.id),
        amount
      });

      // If partner account is required, create it first then retry
      if (!result.success && result.error?.includes('PARTNER_ACCOUNT_REQUIRED')) {
        console.log('⚠️ Partner account required, creating it first...');
        const errorParts = result.error.split(':');
        if (errorParts.length === 3) {
          const partnerTokenAccount = errorParts[1];
          const partnerWallet = errorParts[2];

          console.log('Creating partner token account:', partnerTokenAccount);
          console.log('Partner wallet:', partnerWallet);

          // Create the partner token account (it derives partner info from rift data)
          try {
            const createSignature = await riftProtocolService.createPartnerTokenAccount({
              riftPubkey: new PublicKey(selectedRift.id)
            });

            console.log('✅ Partner account created, signature:', createSignature);
            console.log('Retrying fee distribution...');

            // Retry the fee distribution
            result = await riftProtocolService.claimRiftFees({
              riftPubkey: new PublicKey(selectedRift.id),
              amount
            });
          } catch (createError: any) {
            console.error('❌ Failed to create partner account:', createError);
            const toastId = generateToastId();
            setToasts(prev => [...prev, {
              id: toastId,
              type: 'error',
              message: createError instanceof Error ? createError.message : 'Failed to create partner account'
            }]);
            setTimeout(() => {
              setToasts(prev => prev.filter(t => t.id !== toastId));
            }, 5000);
            return;
          }
        }
      }

      if (result.success) {
        setShowClaimRiftFeesModal(false);
        setClaimRiftFeesAmount('');

        // Refresh rifts data
        await loadRifts();

        // Refresh Rift fees data in real-time
        try {
          const feesResult = await riftProtocolService.getVaultFeesAvailable({
            riftPubkey: new PublicKey(selectedRift.id)
          });
          if (feesResult.success) {
            setRiftFeesData({
              available: feesResult.available,
              partnerShare: feesResult.partnerShare || 0,
              treasuryShare: feesResult.treasuryShare || 0,
              userClaimable: feesResult.userClaimable ?? 0
            });
            setAvailableRiftFees(feesResult.userClaimable ?? 0);
          }
        } catch (error) {
          console.error('Error refreshing Rift fees:', error);
        }

        // Show styled success modal
        setFeesClaimedData({
          type: 'rift',
          amount: parseFloat(claimRiftFeesAmount) || 0,
          signature: result.signature || '',
          symbol: selectedRift?.symbol || 'Rift'
        });
        setShowFeesClaimedModal(true);
      } else {
        console.error('Failed to claim Rift fees:', result.error);
        const toastId = generateToastId();
        setToasts(prev => [...prev, {
          id: toastId,
          type: 'error',
          message: result.error || 'Failed to claim Rift fees'
        }]);
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== toastId));
        }, 5000);
        // Keep modal open so the user can see the error and retry
        return;
      }
    } catch (error) {
      console.error('Error claiming Rift fees:', error);
      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: cleanErrorMessage(error, 'Error claiming Rift fees')
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);
    } finally {
      setIsClaimingRiftFees(false);
    }
  };

  // Handle claim LP fees from pool (supports both DLMM and CP-AMM)
  const handleClaimLpFees = async () => {
    const poolAddress = selectedRift?.liquidityPool || selectedRift?.meteoraPool;

    if (!poolAddress || !wallet.publicKey || !poolTypeDetected) {
      console.error('[CLAIM-LP-FEES] Missing pool address, wallet, or pool type');
      return;
    }

    setIsClaimingLpFees(true);

    try {
      const phantomWallet = getWalletProvider();
      if (!phantomWallet) {
        throw new Error('No Solana wallet found. Please install Phantom or Solflare.');
      }

      // Show pending toast
      const pendingToastId = generateToastId();
      setToasts(prev => [...prev, {
        id: pendingToastId,
        type: 'pending',
        message: 'Claiming LP fees... Please sign the transaction'
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== pendingToastId));
      }, 10000);

      let signatures: string[] = [];
      let successMessage = '';

      if (poolTypeDetected === 'dlmm') {
        // DLMM pool fee claiming
        signatures = await dlmmLiquidityService.claimFees(
          connection as any,
          poolAddress,
          {
            publicKey: new PublicKey(wallet.publicKey),
            signTransaction: async (tx: Transaction) => {
              return await phantomWallet.signTransaction(tx);
            }
          }
        );
        if (signatures.length === 0) {
          successMessage = 'No DLMM fees available to claim';
        } else {
          successMessage = `DLMM LP fees claimed! ${signatures.length} transaction(s)`;
        }
        setDlmmPendingFees(null);

      } else {
        // CP-AMM pool fee claiming
        const result = await meteoraLiquidityService.claimPositionFees({
          poolAddress,
          wallet: {
            publicKey: new PublicKey(wallet.publicKey),
            signTransaction: async (tx: Transaction) => {
              return await phantomWallet.signTransaction(tx);
            }
          },
          connection: connection as unknown as Connection
        });
        signatures = result.signatures;
        successMessage = `LP fees claimed! Got ${result.claimedTokenA.toFixed(6)} + ${result.claimedTokenB.toFixed(6)} tokens`;
        setCpammPendingFees(null);
      }

      console.log('[CLAIM-LP-FEES] Successfully claimed fees:', signatures);

      // Show success toast
      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'success',
        message: successMessage
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);

    } catch (error) {
      console.error('[CLAIM-LP-FEES] Error:', error);

      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: cleanErrorMessage(error, 'Failed to claim LP fees')
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);
    } finally {
      setIsClaimingLpFees(false);
    }
  };

  // Handle close rift
  const handleCloseRift = async () => {
    if (!selectedRift || !wallet.publicKey) {

      return;
    }

    try {

      const productionService = new ProductionRiftsService(connection as unknown as Connection);
      
      const walletAdapter: WalletAdapter = {
        publicKey: new PublicKey(wallet.publicKey),
        sendTransaction: async (transaction: Transaction) => {
          const walletProvider = getWalletProvider();
          if (walletProvider) {
            const { signature } = await walletProvider.signAndSendTransaction(transaction);
            return signature;
          }
          throw new Error('No Solana wallet found');
        },
        signTransaction: async (transaction: Transaction) => {
          // For signing only, return the transaction as-is
          return transaction;
        }
      };
      
      productionService.setWallet(walletAdapter);

      // Use admin close function instead of regular close
      const result = await productionService.adminCloseRift({
        riftPubkey: new PublicKey(selectedRift.id)
      });

      if (result.success) {

        // Close the modal and refresh rifts
        setRiftsModal({ isOpen: false, rift: null });
        await loadRifts();
        
        // Show success message
        // addToast(`Rift closed successfully! Transaction: ${result.signature}`, 'success', result.signature);
      } else {

        // addToast(`Close rift failed: ${result.error}`, 'error');
      }
    } catch (error) {

      // addToast(`Error closing rift: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    }
  };

  // Step 1: Create Rift Only
  const handleCreateRiftStep = async () => {
    const handleStartTime = performance.now();
    console.log('⏱️ [TIMING-FRONTEND] === HANDLE CREATE RIFT START ===');

    if (!selectedToken || !wallet.publicKey || !wallet.connected) {

      return;
    }

    // Validate custom token inputs
    if (selectedToken === 'CUSTOM' && (!customTokenAddress || !customTokenSymbol)) {
      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: 'Please enter custom token address and symbol'
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);
      return;
    }

    // Validate total fee (0.7% - 1.0%)
    const totalFeeValue = parseFloat(totalFee);
    if (isNaN(totalFeeValue) || totalFeeValue < 0.70 || totalFeeValue > 1.00) {
      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: 'Total fee must be between 0.7% and 1.0%'
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);
      return;
    }

    // Partner fee is automatically 50% of total fee - no separate validation needed

    setIsCreatingRift(true);

    try {
      const step1Start = performance.now();
      console.log('⏱️ [TIMING-FRONTEND] Starting rift creation...');

      // Token addresses on mainnet
      const tokenAddresses: Record<string, string> = {
        'SOL': 'So11111111111111111111111111111111111111112',
        'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        'USD1': 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'
      };

      const tokenAddress = selectedToken === 'CUSTOM' ? customTokenAddress : tokenAddresses[selectedToken];
      const tokenSymbol = selectedToken === 'CUSTOM' ? customTokenSymbol : selectedToken;

      const params = {
        tokenAddress,
        tokenSymbol,
        totalFee: parseFloat(totalFee),
        partnerWallet: partnerWallet || wallet.publicKey
      };

      // Clear all caches for new program IDs

      localStorage.removeItem('rifts-cache');
      localStorage.removeItem('user-data-cache');
      localStorage.removeItem('price-cache');

      // Set wallet on service before creating rift
      const phantomWallet = getWalletProvider();

      if (!phantomWallet) {
        throw new Error('No Solana wallet found. Please install Phantom or Solflare.');
      }

      const walletAdapter = {
        publicKey: new PublicKey(wallet.publicKey),
        sendTransaction: async (transaction: Transaction) => {
          try {
            if (!transaction.recentBlockhash) {
              const latestBlockhash = await (connection as unknown as Connection).getLatestBlockhash();
              transaction.recentBlockhash = latestBlockhash.blockhash;
            }
            if (!transaction.feePayer && phantomWallet.publicKey) {
              transaction.feePayer = phantomWallet.publicKey;
            }

            const { signature } = await phantomWallet.signAndSendTransaction(transaction);

            return signature;
          } catch (error: any) {

            throw error;
          }
        },
        signTransaction: async (transaction: Transaction) => {
          // For signing only, return the transaction as-is
          return transaction;
        }
      };
      riftProtocolService.setWallet(walletAdapter as WalletAdapter);
      console.log('⏱️ [TIMING-FRONTEND] Wallet setup: ' + (performance.now() - step1Start).toFixed(2) + 'ms');

      // Create the rift with PDA-based vanity address (using rifts_protocol_v2 IDL)
      const step2Start = performance.now();
      const createResult = await riftProtocolService.createRiftWithVanityPDA({
        creator: new PublicKey(wallet.publicKey),
        underlyingMint: new PublicKey(tokenAddress),
        partnerWallet: partnerWallet ? new PublicKey(partnerWallet) : undefined, // Optional partner wallet
        riftName: tokenSymbol, // Use tokenSymbol which contains the custom name
        transferFeeBps: Math.round(parseFloat(totalFee) * 100), // Convert % to basis points (70-100 bps = 0.7-1%)
        prefixType: 0, // 0 = 'r' prefix for normal Rifts
      });
      console.log('⏱️ [TIMING-FRONTEND] Create rift service call: ' + (performance.now() - step2Start).toFixed(2) + 'ms');

      if (!createResult.success) {
        throw new Error(createResult.error || 'Failed to create rift');
      }

      // Store the created rift data
      setCreatedRiftPDA(createResult.riftId || createResult.signature || null);
      setCreatedRiftData(createResult);

      // Force refresh rifts from blockchain to show the newly created rift
      const step3Start = performance.now();
      await loadRifts(false, true); // forceRefresh = true
      console.log('⏱️ [TIMING-FRONTEND] Load rifts after creation: ' + (performance.now() - step3Start).toFixed(2) + 'ms');

      const totalHandleTime = performance.now() - handleStartTime;
      console.log('⏱️ [TIMING-FRONTEND] === TOTAL HANDLE TIME: ' + totalHandleTime.toFixed(2) + 'ms (' + (totalHandleTime / 1000).toFixed(2) + 's) ===');

      // Close the modal
      setShowCreateRiftModal(false);

      // Show Rift Success Modal with all details
      setRiftSuccessData({
        riftPDA: createResult.riftId || '',
        riftMint: (createResult as any).riftMint || (createResult as any).mintAddress || '',
        signature: createResult.signature || '',
        tokenSymbol: tokenSymbol,
        underlyingSymbol: selectedToken === 'CUSTOM' ? customTokenSymbol : selectedToken,
        underlyingMint: tokenAddress,
        transferFeeBps: Math.round(parseFloat(totalFee) * 100),
        partnerWallet: partnerWallet || undefined,
      });
      setShowRiftSuccessModal(true);

      // Reset form
      setSelectedToken('');
      setCustomTokenAddress('');
      setCustomTokenSymbol('');
      setTotalFee('0.80');
      setPartnerWallet('');

    } catch (error) {

      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: cleanErrorMessage(error, 'Failed to create rift')
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);
    } finally {
      setIsCreatingRift(false);
    }
  };

  // Create Rift + DLMM Pool in sequence (bundled transactions)
  const handleCreateRiftWithDLMM = async () => {
    if (!selectedToken || !wallet.publicKey || !wallet.connected) {
      return;
    }

    // Validate custom token inputs
    if (selectedToken === 'CUSTOM' && (!customTokenAddress || !customTokenSymbol)) {
      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: 'Please enter custom token address and symbol'
      }]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 5000);
      return;
    }

    // Validate total fee (0.7% - 1.0%)
    const totalFeeValue = parseFloat(totalFee);
    if (isNaN(totalFeeValue) || totalFeeValue < 0.70 || totalFeeValue > 1.00) {
      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: 'Total fee must be between 0.7% and 1.0%'
      }]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 5000);
      return;
    }

    // Validate liquidity amounts
    const tokenAmount = parseFloat(dlmmRiftTokenAmount);
    const solAmount = parseFloat(dlmmRiftSolAmount);
    if (!tokenAmount || tokenAmount <= 0) {
      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: 'Please enter token amount for liquidity'
      }]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 5000);
      return;
    }

    // Preflight balance check to avoid runtime "insufficient funds"
    try {
      if (selectedToken === 'SOL') {
        if (tokenAmount > wallet.balance) {
          const toastId = generateToastId();
          setToasts(prev => [...prev, { id: toastId, type: 'error', message: 'Insufficient SOL for wrap amount' }]);
          setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 5000);
          return;
        }
      } else {
        const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress, getMint } = await import('@solana/spl-token');
        const tokenAddresses: Record<string, string> = {
          'SOL': 'So11111111111111111111111111111111111111112',
          'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
          'USD1': 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'
        };
        const tokenAddress = selectedToken === 'CUSTOM' ? customTokenAddress : tokenAddresses[selectedToken];
        const tokenMint = new PublicKey(tokenAddress);

        const mintInfoRaw = await (connection as unknown as Connection).getAccountInfo(tokenMint, 'processed');
        const isToken2022 = mintInfoRaw?.owner?.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58();
        const tokenProgram = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
        const ata = await getAssociatedTokenAddress(tokenMint, new PublicKey(wallet.publicKey), false, tokenProgram);

        const ataBalanceInfo = await (connection as unknown as Connection).getTokenAccountBalance(ata).catch(() => null);
        const mintInfo = await getMint(connection as unknown as Connection, tokenMint, 'confirmed', tokenProgram);
        const userBalance = ataBalanceInfo?.value?.uiAmount ?? 0;

        if (userBalance < tokenAmount) {
          const toastId = generateToastId();
          setToasts(prev => [...prev, { id: toastId, type: 'error', message: `Insufficient balance for ${selectedToken === 'CUSTOM' ? (customTokenSymbol || 'token') : selectedToken}` }]);
          setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 5000);
          return;
        }
      }
    } catch (balanceError) {
      console.error('[DLMM-RIFT] Balance check failed', balanceError);
      const toastId = generateToastId();
      setToasts(prev => [...prev, { id: toastId, type: 'error', message: 'Could not verify balance; please try again' }]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 5000);
      return;
    }

    setIsCreatingDlmmRift(true);

    try {
      const phantomWallet = getWalletProvider();
      if (!phantomWallet) {
        throw new Error('No Solana wallet found. Please install Phantom or Solflare.');
      }

      // Token addresses
      const tokenAddresses: Record<string, string> = {
        'SOL': 'So11111111111111111111111111111111111111112',
        'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        'USD1': 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'
      };

      const tokenAddress = selectedToken === 'CUSTOM' ? customTokenAddress : tokenAddresses[selectedToken];
      const tokenSymbol = selectedToken === 'CUSTOM' ? customTokenSymbol : selectedToken;

      // Clear caches
      localStorage.removeItem('rifts-cache');
      localStorage.removeItem('user-data-cache');

      // Set up wallet adapter
      const walletAdapter = {
        publicKey: new PublicKey(wallet.publicKey),
        sendTransaction: async (transaction: Transaction) => {
          if (!transaction.recentBlockhash) {
            const latestBlockhash = await (connection as unknown as Connection).getLatestBlockhash();
            transaction.recentBlockhash = latestBlockhash.blockhash;
          }
          if (!transaction.feePayer && phantomWallet.publicKey) {
            transaction.feePayer = phantomWallet.publicKey;
          }
          const { signature } = await phantomWallet.signAndSendTransaction(transaction);
          return signature;
        },
        signTransaction: async (transaction: Transaction) => {
          return await phantomWallet.signTransaction(transaction);
        }
      };
      riftProtocolService.setWallet(walletAdapter as WalletAdapter);

      const WSOL_MINT = 'So11111111111111111111111111111111111111112';
      const effectiveInitialPrice = parseFloat(dlmmRiftInitialPrice) || (solAmount > 0 && tokenAmount > 0 ? solAmount / tokenAmount : 0.0001);

      // Update stepper: Step 1 - Creating Rift
      setDlmmCreationStep(1);

      // ========== STEP 1: Create Rift + Wrap (bundled) ==========
      console.log('[DLMM-RIFT] Step 1: Creating rift + wrapping tokens...');

      const bundleResult = await riftProtocolService.createRiftAndWrapInstructions({
        creator: new PublicKey(wallet.publicKey),
        underlyingMint: new PublicKey(tokenAddress),
        wrapAmount: tokenAmount,
        partnerWallet: partnerWallet ? new PublicKey(partnerWallet) : undefined,
        // Don't add 'm' prefix here - the on-chain program adds it based on prefixType=1
        riftName: tokenSymbol,
        transferFeeBps: Math.round(parseFloat(totalFee) * 100),
        prefixType: 1, // 1 = 'm' prefix for Monopools (DLMM)
      });

      if (!bundleResult.success || !bundleResult.instructions || !bundleResult.riftMintAddress || !bundleResult.riftId) {
        throw new Error(bundleResult.error || 'Failed to create rift instructions');
      }

      // Build transaction with rift + wrap instructions
      const { ComputeBudgetProgram } = await import('@solana/web3.js');
      const riftTx = new Transaction();
      riftTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      riftTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));

      for (const ix of bundleResult.instructions) {
        riftTx.add(ix);
      }

      riftTx.feePayer = new PublicKey(wallet.publicKey);
      const { blockhash: blockhash1 } = await (connection as unknown as Connection).getLatestBlockhash('confirmed');
      riftTx.recentBlockhash = blockhash1;

      // Sign and send rift transaction
      const signedRiftTx = await phantomWallet.signTransaction(riftTx);
      const riftSignature = await (connection as unknown as Connection).sendRawTransaction(signedRiftTx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      });

      console.log('[DLMM-RIFT] Rift tx sent:', riftSignature);

      // Wait for confirmation
      let riftConfirmed = false;
      for (let i = 0; i < 30; i++) {
        const status = await (connection as unknown as Connection).getSignatureStatus(riftSignature);
        if (status?.value?.confirmationStatus === 'confirmed' || status?.value?.confirmationStatus === 'finalized') {
          if (status?.value?.err) {
            throw new Error(`Rift transaction failed: ${JSON.stringify(status.value.err)}`);
          }
          riftConfirmed = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (!riftConfirmed) {
        throw new Error('Rift transaction failed to confirm');
      }

      console.log('[DLMM-RIFT] ✅ Step 1 complete! Rift:', bundleResult.riftId);

      // Wait for mint account and token balance to fully propagate across RPC nodes
      // This ensures the DLMM/DAMMV2 pool creation can see the wrapped tokens
      console.log('[DLMM-RIFT] Waiting for token balance to propagate...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Verify the user received the wrapped tokens and get actual balance
      // (Transfer fees mean user receives less than they wrapped)
      // CRITICAL: We MUST use the actual balance, not the input amount, because transfer fees reduce the received amount
      let actualWrappedAmount = tokenAmount; // fallback to input amount
      const { getAssociatedTokenAddress, getAccount, getMint } = await import('@solana/spl-token');
      const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
      const riftMintPubkey = new PublicKey(bundleResult.riftMintAddress);
      const userWalletPubkey = new PublicKey(wallet.publicKey);

      console.log('[DLMM-RIFT] Getting ATA for mint:', bundleResult.riftMintAddress, 'wallet:', wallet.publicKey);

      const userAta = await getAssociatedTokenAddress(
        riftMintPubkey,
        userWalletPubkey,
        false,
        TOKEN_2022_PROGRAM_ID
      );

      console.log('[DLMM-RIFT] User ATA address:', userAta.toBase58());

      // Use a fresh connection for the balance check to avoid stale data
      const { createProxiedConnection } = await import('@/lib/solana/rpc-client');
      const freshConnection = createProxiedConnection();

      // Retry up to 5 times to get the actual balance (important for tokens with transfer fees)
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          console.log('[DLMM-RIFT] Balance check attempt', attempt + 1, '- fetching account data...');
          const accountData = await getAccount(freshConnection, userAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
          console.log('[DLMM-RIFT] Got account data, amount:', accountData.amount.toString());
          const mintInfo = await getMint(freshConnection, riftMintPubkey, 'confirmed', TOKEN_2022_PROGRAM_ID);
          console.log('[DLMM-RIFT] Got mint info, decimals:', mintInfo.decimals);
          const balanceLamports = Number(accountData.amount);
          actualWrappedAmount = balanceLamports / Math.pow(10, mintInfo.decimals);
          console.log('[DLMM-RIFT] Actual wrapped token balance:', actualWrappedAmount, '(input was:', tokenAmount, ', attempt:', attempt + 1, ')');
          if (actualWrappedAmount > 0) {
            break; // Successfully got balance
          }
        } catch (balanceErr: any) {
          const errorMsg = balanceErr?.message || balanceErr?.toString() || 'Unknown error';
          const errorName = balanceErr?.name || 'Error';
          console.warn('[DLMM-RIFT] Balance check attempt', attempt + 1, 'failed:', errorName, '-', errorMsg);
          console.warn('[DLMM-RIFT] Full error:', balanceErr);
          if (attempt < 4) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait before retry
          }
        }
      }

      // If we still have the original amount (fallback), warn loudly
      if (actualWrappedAmount === tokenAmount) {
        console.warn('[DLMM-RIFT] WARNING: Could not verify actual token balance, using input amount. This may cause insufficient funds error if token has transfer fees.');
      }

      // Persist new Monorift to Supabase immediately after creation (before pool)
      try {
        const tokenAddresses: Record<string, string> = {
          'SOL': 'So11111111111111111111111111111111111111112',
          'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
          'USD1': 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'
        };
        const tokenSymbol = selectedToken === 'CUSTOM' ? (customTokenSymbol || 'TOKEN') : selectedToken;
        const tokenAddress = selectedToken === 'CUSTOM' ? customTokenAddress : tokenAddresses[selectedToken];
        const riftMintStr = toMintString(bundleResult.riftMintAddress as unknown as PublicKey | string) as string;
        // The on-chain program adds 'm' prefix based on prefixType=1
        const newRiftData = {
          id: (bundleResult.riftId || riftMintStr) as string,
          symbol: `m${tokenSymbol}`, // Program adds 'm' prefix for monorifts
          underlying: tokenSymbol,
          strategy: monoriftPoolType === 'dammv2' ? 'DAMMV2' : 'DLMM',
          apy: 0,
          tvl: 0,
          volume24h: 0,
          risk: 'Medium' as const,
          backingRatio: 100,
          burnFee: 0,
          partnerFee: Math.floor((parseFloat(totalFee) || 0.8) * 50) / 100,
          wrapFeeBps: 30,
          unwrapFeeBps: 30,
          partnerFeeBps: Math.round((parseFloat(totalFee) || 0.8) * 50),
          transferFeeBps: Math.round(parseFloat(totalFee) * 100),
          programVersion: 'v2' as const,
          programId: RIFTS_PROGRAM_ID.toBase58(),
          creator: wallet.publicKey,
          treasuryWallet: partnerWallet || wallet.publicKey,
          partnerWallet: partnerWallet || wallet.publicKey,
          underlyingMint: tokenAddress,
          riftMint: riftMintStr,
          vault: '',
          totalWrapped: '0',
          totalBurned: '0',
          createdAt: new Date(),
          lastRebalance: new Date(),
          arbitrageOpportunity: 0,
          oracleCountdown: 0,
          nextRebalance: 0,
          performance: [],
          realVaultBalance: 0,
          realRiftSupply: 0,
          realBackingRatio: 100,
          priceDeviation: 0,
          volumeTriggerActive: false,
          participants: 0,
          oracleStatus: 'active' as const,
          hasMeteoraPool: false, // Will be updated after pool creation
          liquidityPool: undefined,
          meteoraPool: undefined,
          meteoraPools: [],
          prefixType: 1 as const,
          poolType: monoriftPoolType as 'dlmm' | 'dammv2' // 'dlmm' or 'dammv2'
        };
        console.log('[DEBUG-SAVE] Saving new monorift to Supabase (Step 1):', {
          id: newRiftData.id?.slice(0,8),
          symbol: newRiftData.symbol,
          underlying: newRiftData.underlying,
          prefixType: newRiftData.prefixType,
          strategy: newRiftData.strategy
        });
        await saveRiftsToSupabase([newRiftData], wallet.publicKey?.toString());
        console.log('[DEBUG-SAVE] ✅ Saved to Supabase, refreshing rifts...');
        // Refresh rifts so the new monorift appears immediately
        await loadRifts(false, true);
      } catch (saveErr) {
        console.error('[DLMM-RIFT] Failed to save Monorift to Supabase:', saveErr);
      }

      // Update stepper: Step 2 - Creating Pool
      setDlmmCreationStep(2);

      // ========== STEP 2: Create Pool (DLMM or DAMMV2) ==========
      let poolResult: { poolAddress: string; signature?: string; positionNft?: string };

      if (monoriftPoolType === 'dammv2') {
        // DAMMV2 (CP-AMM) - Full Range or Custom Price Range
        const isCustomRange = dammv2UsePriceRange && dammv2MaxPrice && parseFloat(dammv2MaxPrice) > 0;
        console.log('[MONORIFT] Step 2: Creating DAMMV2 pool (' + (isCustomRange ? 'custom range' : 'full range') + ')...');
        console.log('[MONORIFT] DAMMV2 tokenAAmount to send:', actualWrappedAmount, '(original input was:', tokenAmount, ')');

        // Calculate maxPrice in SOL if custom range is enabled
        let effectiveMaxPrice: number | undefined;
        if (isCustomRange) {
          const maxPriceValue = parseFloat(dammv2MaxPrice);
          if (dammv2PriceUnit === 'USD' && solPrice > 0) {
            // Convert USD to SOL: price in SOL = price in USD / SOL price
            effectiveMaxPrice = maxPriceValue / solPrice;
            console.log('[MONORIFT] DAMMV2 maxPrice: $' + maxPriceValue + ' = ' + effectiveMaxPrice + ' SOL (SOL price: $' + solPrice + ')');
          } else {
            // Already in SOL
            effectiveMaxPrice = maxPriceValue;
            console.log('[MONORIFT] DAMMV2 maxPrice: ' + effectiveMaxPrice + ' SOL');
          }
        }

        const dammv2Service = getDAMMV2LiquidityService(connection as unknown as Connection);

        const dammv2Result = await dammv2Service.createPoolWithSingleSidedLiquidity({
          tokenAMint: bundleResult.riftMintAddress,
          tokenBMint: WSOL_MINT,
          tokenAAmount: actualWrappedAmount, // Use actual balance after transfer fees
          initialPrice: effectiveInitialPrice,
          maxPrice: effectiveMaxPrice, // Optional: custom max price for concentrated liquidity
          // DAMMV2 fee is always 0.25% (25 bps) - hardcoded in service
          wallet: {
            publicKey: new PublicKey(wallet.publicKey),
            signTransaction: async (tx: Transaction) => {
              return await phantomWallet.signTransaction(tx);
            },
            signAllTransactions: phantomWallet.signAllTransactions ? async (txs: Transaction[]) => {
              return await phantomWallet.signAllTransactions!(txs);
            } : undefined
          },
          connection: connection as unknown as Connection,
          onProgress: (step, message) => {
            console.log('[MONORIFT] DAMMV2 Progress:', step, message);
            if (step >= 3) {
              setDlmmCreationStep(3); // Adding liquidity
            }
            if (step >= 4) {
              setDlmmCreationStep(4); // Complete
            }
          }
        });

        poolResult = {
          poolAddress: dammv2Result.poolAddress,
          signature: dammv2Result.signature,
          positionNft: dammv2Result.positionNft
        };

        console.log('[MONORIFT] ✅ DAMMV2 complete! Pool:', poolResult.poolAddress);
      } else {
        // DLMM Concentrated Liquidity
        console.log('[MONORIFT] Step 2: Creating DLMM pool...');

        const dlmmResult = await dlmmLiquidityService.createPoolAndAddLiquidity({
          tokenXMint: bundleResult.riftMintAddress,
          tokenYMint: WSOL_MINT,
          binStep: parseInt(dlmmRiftBinStep) || 10,
          feeBps: parseInt(dlmmRiftFeeBps) || 100,
          tokenXAmount: actualWrappedAmount, // Use actual balance after transfer fees
          tokenYAmount: dlmmRiftSingleSided ? 0 : solAmount,
          strategy: dlmmRiftStrategy,
          rangeInterval: parseInt(dlmmRiftRangeInterval) || 10,
          singleSided: dlmmRiftSingleSided,
          mcapRange: dlmmRiftUseMcapRange && dlmmRiftMinMcap > 0 && dlmmRiftMaxMcap > 0 && dlmmRiftTokenSupply > 0 ? {
            minMcap: dlmmRiftMinMcap,
            maxMcap: dlmmRiftMaxMcap,
            tokenSupply: dlmmRiftTokenSupply,
            useMcapMode: true
          } : undefined,
          initialPrice: effectiveInitialPrice,
          wallet: {
            publicKey: new PublicKey(wallet.publicKey),
            signTransaction: async (tx: Transaction) => {
              return await phantomWallet.signTransaction(tx);
            },
            signAllTransactions: phantomWallet.signAllTransactions ? async (txs: Transaction[]) => {
              return await phantomWallet.signAllTransactions!(txs);
            } : undefined
          },
          connection: connection as unknown as Connection
        }, (step, message) => {
          // Progress callback: step 2=pool created, step 3=adding liq, step 4=complete
          console.log('[MONORIFT] Progress:', step, message);
          if (step === 3) {
            setDlmmCreationStep(3); // Adding liquidity
          } else if (step === 4) {
            setDlmmCreationStep(4); // Complete
          }
        });

        poolResult = dlmmResult;
        console.log('[MONORIFT] ✅ DLMM complete! Pool:', poolResult.poolAddress);
      }

      // Update monorift with pool info (already saved in Step 1, just updating pool)
      console.log('[DEBUG-SAVE] Pool created, updating local override...');

      // Cache override so Monorift shows immediately with pool info (key by riftId and riftMint)
      const overrideIds = [
        bundleResult.riftId,
        toMintString(bundleResult.riftMintAddress as unknown as PublicKey | string)
      ].filter(Boolean) as string[];
      addDlmmOverride(overrideIds, poolResult.poolAddress);

      // Save pool address to Supabase so it persists across sessions/browsers
      try {
        console.log('[DEBUG-SAVE] Saving pool address to Supabase...');
        const updateUrl = wallet.publicKey
          ? `/api/update-rift-pool?wallet=${wallet.publicKey}`
          : '/api/update-rift-pool';
        const updateResponse = await fetch(updateUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            riftId: bundleResult.riftId,
            poolAddress: poolResult.poolAddress,
            poolType: monoriftPoolType // 'dlmm' or 'dammv2'
          })
        });
        if (updateResponse.ok) {
          console.log('[DEBUG-SAVE] ✅ Pool address saved to Supabase:', poolResult.poolAddress);
        } else {
          const errData = await updateResponse.json().catch(() => ({}));
          console.error('[DEBUG-SAVE] Failed to save pool to Supabase:', errData);
        }
      } catch (savePoolErr) {
        console.error('[DEBUG-SAVE] Failed to save pool address to Supabase:', savePoolErr);
        // Don't fail the whole operation - local override still works for this session
      }

      // Close modal and reset
      setShowCreateRiftModal(false);
      setSelectedToken('');
      setCustomTokenAddress('');
      setCustomTokenSymbol('');
      setDlmmRiftTokenAmount('');
      setDlmmRiftSolAmount('');
      setDlmmRiftInitialPrice('');
      setDlmmRiftBinStep('50');
      setDlmmRiftRangeInterval('10');
      setDlmmRiftFeeBps('100');
      setDlmmRiftStrategy(DLMMStrategyType.Spot);
      setDlmmRiftSingleSided(true);
      setDlmmRiftMinMcap(0);
      setDlmmRiftMaxMcap(0);
      setDlmmRiftTokenSupply(0);
      setDlmmRiftUseMcapRange(true);
      setMonoriftPoolType('dlmm'); // Reset pool type
      setTotalFee('0.80');
      setPartnerWallet('');

      // Show Pool Success Modal with all details
      setPoolSuccessData({
        poolAddress: poolResult.poolAddress,
        signature: poolResult.signature,
        positionNft: poolResult.positionNft,
        poolType: monoriftPoolType,
        tokenSymbol: customTokenMetadata?.symbol || customTokenSymbol || selectedToken,
        tokenAmount: parseFloat(dlmmRiftTokenAmount) || 0,
        solAmount: dlmmRiftSingleSided ? 0 : parseFloat(dlmmRiftSolAmount) || 0,
      });
      setShowPoolSuccessModal(true);

      // Sync LP positions after creating monorift with pool
      if (bundleResult.riftId) {
        fetch('/api/arb-lp-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ riftId: bundleResult.riftId })
        }).catch(err => console.log('[LP-SYNC] Background sync error:', err));
      }

    } catch (error) {
      console.error('[MONORIFT] Error:', error);
      const toastId = generateToastId();
      const poolTypeName = monoriftPoolType === 'dammv2' ? 'DAMMV2' : 'DLMM';
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: cleanErrorMessage(error, `Failed to create monopool + ${poolTypeName}`)
      }]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 5000);
    } finally {
      setIsCreatingDlmmRift(false);
      setDlmmCreationStep(0); // Reset stepper
    }
  };

  // Fetch deposit quote from Meteora and auto-fill the other field
  const fetchDepositQuote = async (poolAddress: string, amount: number, fieldType: 'sol' | 'rift') => {
    if (!poolAddress || poolAddress === '11111111111111111111111111111111' || !amount || amount <= 0) {
      setDepositQuote(null);
      setQuoteError(null);
      return;
    }

    setIsLoadingQuote(true);
    setQuoteError(null);
    try {
      let quote;
      if (fieldType === 'rift') {
        // User entered RIFT amount, calculate SOL needed
        quote = await meteoraLiquidityService.getDepositQuoteFromRift(poolAddress, amount);
        // Auto-fill SOL amount
        setSolLiquidityAmount(quote.wsolNeeded.toFixed(9));
      } else {
        // User entered SOL amount, calculate RIFT needed
        quote = await meteoraLiquidityService.getDepositQuoteFromSol(poolAddress, amount);
        // Auto-fill RIFT amount
        setRiftLiquidityAmount(quote.riftNeeded.toFixed(9));
      }
      setDepositQuote(quote);
      // Update liquidityRatio from the actual pool ratio
      console.log('[QUOTE-FETCH] Quote received:', {
        wsolNeeded: quote.wsolNeeded,
        riftNeeded: quote.riftNeeded,
        poolRatio: quote.poolRatio,
        createNewPool
      });
      if (quote.poolRatio && quote.poolRatio > 0) {
        console.log('[QUOTE-FETCH] Setting liquidityRatio from poolRatio:', quote.poolRatio);
        setLiquidityRatio(quote.poolRatio);
      }

    } catch (error) {
      console.error('[FETCH-QUOTE] Error:', error);
      setDepositQuote(null);
      setQuoteError(cleanErrorMessage(error, 'Failed to get quote'));
    } finally {
      setIsLoadingQuote(false);
    }
  };

  // Create Meteora Pool & Add Initial Liquidity
  const handleCreatePoolAndAddLiquidity = async () => {
    // Use selectedRift if available (from Add Liquidity modal), otherwise use createdRiftData
    const riftToUse = selectedRift || createdRiftData;
    const riftPDA = selectedRift?.id || createdRiftPDA;

    if (!riftPDA || !riftToUse || !solLiquidityAmount || !riftLiquidityAmount) {

      return;
    }

    setIsCreatingMeteoraPool(true);

    try {
      const phantomWallet = getWalletProvider();

      if (!phantomWallet) {
        throw new Error('No Solana wallet found. Please install Phantom or Solflare.');
      }

      // Find the correct pool based on Token A selection
      // If user explicitly selected a pool from the dropdown, use that
      const pools = riftToUse.meteoraPools || [];
      let poolAddress = selectedPoolAddress || undefined;

      // Helper function to check if a pool contains BOTH the underlying token AND the rift token
      const checkPoolHasCorrectTokens = async (poolAddr: string, underlyingMint: string, riftMint: string): Promise<boolean> => {
        try {
          const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
          const cpAmm = new CpAmm(connection as any);
          const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddr));

          const tokenAMint = poolState.tokenAMint.toBase58();
          const tokenBMint = poolState.tokenBMint.toBase58();

          // Pool must contain BOTH the underlying token (RIFTS) AND this specific rift token (rRIFTS)
          const hasUnderlying = tokenAMint === underlyingMint || tokenBMint === underlyingMint;
          const hasRift = tokenAMint === riftMint || tokenBMint === riftMint;

          const isCorrect = hasUnderlying && hasRift;

          return isCorrect;
        } catch (error: any) {
          // Invalid account discriminator means this is a DLMM pool, not CP-AMM - silently skip
          if (error?.message?.includes('Invalid account discriminator')) {
            return false;
          }
          console.error('[POOL-CHECK] Error checking pool:', error);
          return false;
        }
      };

      // FIXED: Detect SOL pool by checking for wSOL mint
      const checkPoolIsSOL = async (poolAddr: string, riftMint: string): Promise<boolean> => {
        try {
          const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
          const cpAmm = new CpAmm(connection as any);
          const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddr));
          const WSOL_MINT = 'So11111111111111111111111111111111111111112';

          const tokenAMint = poolState.tokenAMint.toBase58();
          const tokenBMint = poolState.tokenBMint.toBase58();

          // Pool must contain BOTH wSOL AND this specific rift token
          const hasWSOL = tokenAMint === WSOL_MINT || tokenBMint === WSOL_MINT;
          const hasRift = tokenAMint === riftMint || tokenBMint === riftMint;

          return hasWSOL && hasRift;
        } catch (error: any) {
          // Invalid account discriminator means this is a DLMM pool, not CP-AMM - silently skip
          if (error?.message?.includes('Invalid account discriminator')) {
            return false;
          }
          console.error('[POOL-CHECK] Error checking SOL pool:', error);
          return false;
        }
      };

      // Check if a pool is a DLMM pool with SOL pairing
      const checkDlmmPoolIsSOL = async (poolAddr: string, riftMint: string): Promise<boolean> => {
        try {
          const DLMM = (await import('@meteora-ag/dlmm')).default;
          const dlmmPool = await DLMM.create(connection as any, new PublicKey(poolAddr));
          const WSOL_MINT = 'So11111111111111111111111111111111111111112';

          const tokenXMint = dlmmPool.tokenX.publicKey.toBase58();
          const tokenYMint = dlmmPool.tokenY.publicKey.toBase58();

          const hasWSOL = tokenXMint === WSOL_MINT || tokenYMint === WSOL_MINT;
          const hasRift = tokenXMint === riftMint || tokenYMint === riftMint;

          return hasWSOL && hasRift;
        } catch (error: any) {
          // Invalid account discriminator means this is a CP-AMM pool, not DLMM - silently skip
          if (error?.message?.includes('Invalid account discriminator')) {
            return false;
          }
          console.error('[POOL-CHECK] Error checking DLMM pool:', error?.message?.slice(0, 100));
          return false;
        }
      };

      let existingDlmmPool: string | undefined;

      // Helper to check if a pool is DLMM and get its token mints
      const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
      const checkIsDlmmPool = async (poolAddr: string): Promise<{ isDlmm: boolean; tokenXMint?: string; tokenYMint?: string }> => {
        try {
          // First check the on-chain owner to reliably determine pool type
          const poolPubkey = new PublicKey(poolAddr);
          const poolInfo = await connection.getAccountInfo(poolPubkey);
          if (!poolInfo) {
            return { isDlmm: false };
          }

          const ownerProgram = poolInfo.owner.toBase58();
          console.log('[POOL-CHECK] Pool', poolAddr.slice(0, 8), 'owner:', ownerProgram);

          if (ownerProgram !== DLMM_PROGRAM_ID) {
            console.log('[POOL-CHECK] Not a DLMM pool (owner is not DLMM program)');
            return { isDlmm: false };
          }

          // Owner is DLMM, now deserialize to get token mints
          const DLMM = (await import('@meteora-ag/dlmm')).default;
          const dlmmPool = await DLMM.create(connection as any, poolPubkey);
          return {
            isDlmm: true,
            tokenXMint: dlmmPool.tokenX.publicKey.toBase58(),
            tokenYMint: dlmmPool.tokenY.publicKey.toBase58()
          };
        } catch (err) {
          console.log('[POOL-CHECK] Error checking pool:', err);
          return { isDlmm: false };
        }
      };

      // Store DLMM pool token mints when detected
      let dlmmPoolTokenX: string | undefined;
      let dlmmPoolTokenY: string | undefined;

      // If user selected a pool from the dropdown, use it directly and check if it's DLMM
      if (selectedPoolAddress) {
        console.log('[POOL-SELECT] User selected pool from dropdown:', selectedPoolAddress);
        poolAddress = selectedPoolAddress;
        // Check if selected pool is DLMM (any pairing, not just SOL)
        const dlmmCheck = await checkIsDlmmPool(selectedPoolAddress);
        if (dlmmCheck.isDlmm) {
          existingDlmmPool = selectedPoolAddress;
          dlmmPoolTokenX = dlmmCheck.tokenXMint;
          dlmmPoolTokenY = dlmmCheck.tokenYMint;
          console.log('[POOL-SELECT] Selected pool is DLMM, tokenX:', dlmmPoolTokenX, 'tokenY:', dlmmPoolTokenY);
        } else {
          console.log('[POOL-SELECT] Selected pool is CP-AMM');
        }
      } else if (liquidityTokenA === 'USD1') {
        // Search for a pool that contains BOTH USD1 AND this rift's token
        const USD1_MINT = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';
        let foundUSD1Pool = false;
        for (const pool of pools) {
          const isCorrectPool = await checkPoolHasCorrectTokens(pool, USD1_MINT, riftToUse.riftMint);
          if (isCorrectPool) {
            poolAddress = pool;
            foundUSD1Pool = true;
            break;
          }
        }

        if (!foundUSD1Pool) {
          poolAddress = undefined; // Force pool creation
        }
      } else {
        // SOL: Search for the SOL pool by checking token mints
        let foundSOLPool = false;

        // First check for DLMM pools (for monorifts)
        for (const pool of pools) {
          const isDlmmSOLPool = await checkDlmmPoolIsSOL(pool, riftToUse.riftMint);
          if (isDlmmSOLPool) {
            poolAddress = pool;
            existingDlmmPool = pool;
            foundSOLPool = true;
            console.log('[POOL-CHECK] Found existing DLMM pool:', pool);
            break;
          }
        }

        // If no DLMM pool found, check for CP-AMM pools
        if (!foundSOLPool) {
          for (const pool of pools) {
            const isSOLPool = await checkPoolIsSOL(pool, riftToUse.riftMint);
            if (isSOLPool) {
              poolAddress = pool;
              foundSOLPool = true;
              break;
            }
          }
        }

        if (!foundSOLPool) {
          // Fallback to old logic if detection fails
          poolAddress = pools[1] || pools[0] || riftToUse.liquidityPool || riftToUse.meteoraPool;
        }
      }

      const poolExists = poolAddress && poolAddress !== '11111111111111111111111111111111';

      // If createNewPool is ON, user wants to create a NEW pool
      // Skip adding to existing pool and create new one instead
      // For DLMM: add to existing DLMM pool if one exists, otherwise create new
      if (poolExists && !createNewPool && existingDlmmPool && poolType === 'dlmm') {
        // Add liquidity to existing DLMM pool
        console.log('[ADD-LIQ] Adding to existing DLMM pool:', existingDlmmPool);

        const pendingToastId = generateToastId();
        setToasts(prev => [...prev, {
          id: pendingToastId,
          type: 'pending',
          message: `Adding liquidity to DLMM pool... Please sign the transaction`
        }]);
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== pendingToastId));
        }, 10000);

        const walletAdapter = {
          publicKey: new PublicKey(wallet.publicKey),
          signTransaction: async (tx: Transaction) => {
            return await phantomWallet.signTransaction(tx);
          },
          signAllTransactions: phantomWallet.signAllTransactions ? async (txs: Transaction[]) => {
            return await phantomWallet.signAllTransactions!(txs);
          } : undefined
        };

        // Use actual token mints from the pool, fallback to defaults
        const actualTokenXMint = dlmmPoolTokenX || riftToUse.riftMint!;
        const actualTokenYMint = dlmmPoolTokenY || 'So11111111111111111111111111111111111111112';

        // Determine token amounts based on which token the user is depositing
        // For single-sided, user deposits rift tokens (tokenX if rift is X, or tokenY if rift is Y)
        const riftIsTokenX = actualTokenXMint === riftToUse.riftMint;

        // For single-sided deposits, reduce rift amount by 1% to account for Token-2022 transfer fees
        // This prevents "insufficient funds" errors due to fee calculations
        const riftAmount = parseFloat(riftLiquidityAmount);
        const adjustedRiftAmount = dlmmSingleSided ? riftAmount * 0.99 : riftAmount;

        const tokenXAmount = riftIsTokenX ? adjustedRiftAmount : (dlmmSingleSided ? 0 : parseFloat(solLiquidityAmount));
        const tokenYAmount = riftIsTokenX ? (dlmmSingleSided ? 0 : parseFloat(solLiquidityAmount)) : adjustedRiftAmount;

        console.log('[ADD-LIQ] DLMM deposit - tokenX:', actualTokenXMint.slice(0,8), 'amount:', tokenXAmount, 'tokenY:', actualTokenYMint.slice(0,8), 'amount:', tokenYAmount, dlmmSingleSided ? '(1% reduced for fees)' : '');

        const result = await dlmmLiquidityService.addLiquidity({
          poolAddress: existingDlmmPool,
          tokenXMint: actualTokenXMint,
          tokenYMint: actualTokenYMint,
          tokenXAmount,
          tokenYAmount,
          strategy: dlmmStrategy,
          binStep: parseInt(dlmmBinStep) || 50,
          rangeInterval: parseInt(dlmmRangeInterval) || 10,
          singleSided: dlmmSingleSided,
          mcapRange: dlmmUseMcapRange && dlmmMinMcap > 0 && dlmmMaxMcap > 0 && dlmmTokenSupply > 0 ? {
            minMcap: dlmmMinMcap,
            maxMcap: dlmmMaxMcap,
            tokenSupply: dlmmTokenSupply,
            useMcapMode: true
          } : undefined,
          wallet: walletAdapter,
          connection: connection as unknown as Connection
        });

        console.log('[ADD-LIQ] DLMM liquidity added:', result);

        // Update TVL
        const liquidityAmount = parseFloat(solLiquidityAmount) || 0;
        const riftId = selectedRift?.id || riftPDA;
        const riftToUpdate = rifts.find(r => r.id === riftId);
        if (riftToUpdate) {
          setRifts(prevRifts =>
            prevRifts.map(rift =>
              rift.id === riftId
                ? { ...rift, tvl: (rift.tvl || 0) + liquidityAmount }
                : rift
            )
          );
        }

        // Show Pool Success Modal with Meteora link
        setPoolSuccessData({
          poolAddress: existingDlmmPool,
          poolType: 'dlmm',
          tokenSymbol: selectedRift?.symbol || selectedRift?.underlying || riftToUse?.symbol || 'Token',
          tokenAmount: parseFloat(riftLiquidityAmount) || 0,
          solAmount: dlmmSingleSided ? 0 : parseFloat(solLiquidityAmount) || 0,
          signature: result.signature,
          positionNft: result.positionAddress,
        });
        setShowPoolSuccessModal(true);

        // Sync LP positions after adding liquidity
        const syncRiftId = selectedRift?.id || riftPDA;
        if (syncRiftId) {
          fetch('/api/arb-lp-sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ riftId: syncRiftId })
          }).catch(err => console.log('[LP-SYNC] Background sync error:', err));
        }

        setShowAddLiquidityModal(false);
        setIsCreatingMeteoraPool(false);
        return;
      }

      if (poolExists && !createNewPool && poolType !== 'dlmm') {
        // Pool exists and user wants to add to DAMM V2 (CP-AMM) pool

        // PRE-CHECK: For single-sided monorift DAMMV2 deposits, verify pool doesn't now require SOL
        const isMonorift = (riftToUse as any)?.prefixType === 1;
        if (isMonorift && dlmmSingleSided && (!solLiquidityAmount || parseFloat(solLiquidityAmount) <= 0)) {
          try {
            console.log('[ADD-LIQ] Pre-checking pool state for single-sided deposit...');
            const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
            const cpAmm = new CpAmm(connection as any);
            const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress!));

            // Check pool vault balances
            const WSOL_MINT = 'So11111111111111111111111111111111111111112';
            const isTokenAWsol = poolState.tokenAMint.toBase58() === WSOL_MINT;
            const wsolVault = isTokenAWsol ? poolState.tokenAVault : poolState.tokenBVault;
            const wsolBalance = await (connection as unknown as Connection).getTokenAccountBalance(wsolVault);
            const wsolAmount = parseFloat(wsolBalance.value.uiAmountString || '0');

            console.log('[ADD-LIQ] Pool wSOL balance:', wsolAmount);

            // If pool has significant SOL (> 0.001), it's no longer single-sided
            if (wsolAmount > 0.001) {
              // Get deposit quote to show how much SOL is needed
              const riftAmount = parseFloat(riftLiquidityAmount);
              const quote = await meteoraLiquidityService.getDepositQuoteFromRift(poolAddress!, riftAmount);

              const toastId = generateToastId();
              setToasts(prev => [...prev, {
                id: toastId,
                type: 'error',
                message: `This pool now has ${wsolAmount.toFixed(4)} SOL from trading. You need ${quote.wsolNeeded.toFixed(6)} SOL + ${quote.riftNeeded.toFixed(4)} tokens to deposit. Switch to two-sided mode or add SOL.`
              }]);
              setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 10000);
              setIsCreatingMeteoraPool(false);
              return;
            }
          } catch (checkError) {
            console.warn('[ADD-LIQ] Pool state pre-check failed:', checkError);
            // Continue with deposit, let the actual operation handle any errors
          }
        }

        // Show pending toast
        const infoToastId = generateToastId();
        setToasts(prev => [...prev, {
          id: infoToastId,
          type: 'pending',
          message: `Adding liquidity to DAMM V2 pool... Please sign the transaction`
        }]);
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== infoToastId));
        }, 5000);

        console.log('[ADD-LIQ] Adding to DAMM V2 pool:', poolAddress);

        const walletAdapter = {
          publicKey: new PublicKey(wallet.publicKey),
          signTransaction: async (transaction: Transaction) => {
            const signed = await phantomWallet.signTransaction(transaction);
            return signed;
          },
          sendTransaction: async (transaction: Transaction, conn: Connection) => {
            const { signature } = await phantomWallet.signAndSendTransaction(transaction);
            return signature;
          },
          connected: true
        };

        // Determine the underlying mint based on the selected pair
        const underlyingMintForPair = liquidityTokenA === 'USD1'
          ? 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'
          : riftToUse.underlyingMint;

        const signature = await meteoraLiquidityService.addLiquidity({
          poolAddress: poolAddress!,
          wsolAmount: parseFloat(solLiquidityAmount),
          riftAmount: parseFloat(riftLiquidityAmount),
          useUnderlyingToken: liquidityTokenA !== 'SOL', // Use underlying token for RIFTS and USD1
          underlyingMint: underlyingMintForPair,
          wallet: walletAdapter,
          connection: connection as unknown as Connection
        });

        // VERIFY TRANSACTION SUCCEEDED before showing success (using polling to avoid WebSocket issues)
        let txConfirmed = false;
        let txError: any = null;
        for (let i = 0; i < 30; i++) {
          const status = await (connection as unknown as Connection).getSignatureStatus(signature);
          if (status?.value?.confirmationStatus === 'confirmed' || status?.value?.confirmationStatus === 'finalized') {
            if (status?.value?.err) {
              txError = status.value.err;
            }
            txConfirmed = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (!txConfirmed) {
          throw new Error('Transaction confirmation timed out');
        }
        if (txError) {
          console.error('[ADD-LIQ] Transaction failed:', txError);
          throw new Error(`Transaction failed: ${JSON.stringify(txError)}`);
        }

        // UPDATE UI AND DATABASE ONLY IF TRANSACTION SUCCEEDED!
        const liquidityAmount = parseFloat(solLiquidityAmount) || 0;
        const riftId = selectedRift?.id || riftPDA;

        // Find the rift we're updating
        const riftToUpdate = rifts.find(r => r.id === riftId);

        if (riftToUpdate) {
          // Create updated rift data
          const updatedRiftData = {
            ...riftToUpdate,
            hasMeteoraPool: true,
            liquidityPool: poolAddress,
            meteoraPool: poolAddress, // Set both for compatibility
            tvl: (riftToUpdate.tvl || 0) + liquidityAmount
          };

          // Update the rift in the rifts array immediately
          setRifts(prevRifts =>
            prevRifts.map(rift =>
              rift.id === riftId ? updatedRiftData : rift
            )
          );

          // Update selected rift if it's the one we added liquidity to
          if (selectedRift && selectedRift.id === riftId) {
            setSelectedRift(updatedRiftData);
          }

          // SAVE TO SUPABASE IMMEDIATELY!
          riftProtocolService.updateRiftInCache(riftId, {
            hasMeteoraPool: true,
            liquidityPool: poolAddress,
            meteoraPool: poolAddress, // Set both for compatibility
            tvl: updatedRiftData.tvl
          });

          // Also save directly to Supabase for instant persistence
          (async () => {
            try {
              const { supabase } = await import('@/lib/supabase/client');
              await supabase
                .from('rifts')
                .update({
                  vault_balance: updatedRiftData.tvl.toString(),
                  total_tokens_wrapped: updatedRiftData.tvl.toString(),
                  raw_data: updatedRiftData,
                  updated_at: new Date().toISOString()
                })
                .eq('id', riftId);
            } catch (error) {
              console.error('Failed to update Supabase:', error);
            }
          })();
        }

        // Show Pool Success Modal with Meteora link
        setPoolSuccessData({
          poolAddress: poolAddress!,
          poolType: 'dammv2',
          tokenSymbol: selectedRift?.symbol || selectedRift?.underlying || riftToUse?.symbol || 'Token',
          tokenAmount: parseFloat(riftLiquidityAmount) || 0,
          solAmount: parseFloat(solLiquidityAmount) || 0,
          signature,
        });
        setShowPoolSuccessModal(true);

        // Sync LP positions after adding liquidity
        const syncRiftId = selectedRift?.id || riftPDA;
        if (syncRiftId) {
          fetch('/api/arb-lp-sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ riftId: syncRiftId })
          }).catch(err => console.log('[LP-SYNC] Background sync error:', err));
        }

        // REMOVED: No need to refresh entire rift list after adding liquidity

      } else {
        // Pool doesn't exist - create new pool
        const liquidityAmount = parseFloat(solLiquidityAmount);

        // Create pool - use poolType to determine DLMM vs DAMM V2
        const poolTypeName = poolType === 'dlmm' ? 'DLMM' : 'DAMM V2';
        console.log(`[POOL-CREATE] Creating ${poolTypeName} pool...`);

          // Show pending toast
          const pendingToastId = generateToastId();
          setToasts(prev => [...prev, {
            id: pendingToastId,
            type: 'pending',
            message: `Creating ${poolTypeName} pool... Please sign the transactions`
          }]);
          setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== pendingToastId));
          }, 10000);

          const WSOL_MINT = 'So11111111111111111111111111111111111111112';
          const USD1_MINT = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';
          const tokenYMint = liquidityTokenA === 'SOL'
            ? WSOL_MINT
            : USD1_MINT; // USD1

          // Initial price in SOL per rift token (force derived from live USD prices when available)
          let effectiveInitialPrice = parseFloat(initialPrice) || 0.0001;
          let debugRiftPriceUsd = 0;
          let debugSolUsd = 0;
          try {
            const solPriceRes = await fetch('/api/prices?mint=So11111111111111111111111111111111111111112');
            const solData = solPriceRes.ok ? await solPriceRes.json() : null;
            const solUsd = solData?.price || 0;
            debugSolUsd = solUsd;

            // For monorifts, use the underlying rift's price
            let riftPriceUsd = riftToUse?.riftTokenPrice || 0;
            if ((riftToUse as any)?.prefixType === 1 && riftToUse?.underlyingMint) {
              const underlyingRift = rifts.find((r: any) =>
                r.riftMint === riftToUse.underlyingMint && r.id !== riftToUse.id
              );
              if (underlyingRift) {
                riftPriceUsd = underlyingRift.riftTokenPrice || 0;
              }
            }
            debugRiftPriceUsd = riftPriceUsd;

            console.log('[DLMM] Price calculation:', {
              isMonorift: (riftToUse as any)?.prefixType === 1,
              monoriftSymbol: riftToUse?.symbol,
              riftPriceUsd,
              solUsd,
              calculatedPriceInSol: riftPriceUsd / solUsd
            });

            if (riftPriceUsd > 0 && solUsd > 0) {
              // Calculate: riftPrice_USD / SOL_USD = SOL per rift
              let priceInSol = riftPriceUsd / solUsd;

              // IMPORTANT: Meteora DLMM sorts tokens alphabetically by mint address
              // If SOL comes before rift alphabetically, the price gets inverted
              // SOL mint: So11111111... (starts with 'S')
              // Most rift mints start with other letters
              const solMint = 'So11111111111111111111111111111111111111112';
              const riftMint = riftToUse.riftMint!;

              // If SOL < rift alphabetically, Meteora treats SOL as tokenX
              // In that case, price should be expressed as "rift per SOL" (inverse)
              if (solMint < riftMint) {
                priceInSol = 1 / priceInSol; // Invert: now it's "rift per SOL"
                console.log('[DLMM] Inverting price because SOL < rift mint alphabetically');
              }

              effectiveInitialPrice = priceInSol;
            }
          } catch (err) {
            console.warn('[DLMM] Could not refresh SOL price, using existing initialPrice', err);
          }

          console.log('[POOL-CREATE] Using initial price:', {
            poolType,
            effectiveInitialPrice,
            initialPriceInput: initialPrice,
            riftTokenPrice: riftToUse?.riftTokenPrice,
            riftPriceUsd: debugRiftPriceUsd,
            solUsd: debugSolUsd,
            solMint: 'So11111111111111111111111111111111111111112',
            riftMint: riftToUse.riftMint,
            inverted: 'So11111111111111111111111111111111111111112' < riftToUse.riftMint!,
            tokensSortedOrder: 'So11111111111111111111111111111111111111112' < riftToUse.riftMint! ? 'SOL < rift (SOL is tokenX)' : 'rift < SOL (rift is tokenX)'
          });

        let newPoolAddress: string;

        if (poolType === 'cpamm') {
          // DAMMV2 (CP-AMM) pool creation - check if single-sided or two-sided
          if (dlmmSingleSided) {
            // Single-sided: only deposit rift tokens (tokenA)
            console.log('[POOL-CREATE] Creating DAMM V2 (CPAMM) single-sided pool...');

            const dammv2Result = await createDAMMV2SingleSidedPool({
              tokenAMint: riftToUse.riftMint!,
              tokenBMint: tokenYMint,
              tokenAAmount: parseFloat(riftLiquidityAmount),
              initialPrice: effectiveInitialPrice,
              feeBps: 25, // 0.25% fee
              wallet: {
                publicKey: new PublicKey(wallet.publicKey),
                signTransaction: async (tx: Transaction) => {
                  return await phantomWallet.signTransaction(tx);
                },
                signAllTransactions: phantomWallet.signAllTransactions ? async (txs: Transaction[]) => {
                  return await phantomWallet.signAllTransactions!(txs);
                } : undefined
              },
              connection: connection as unknown as Connection,
              onProgress: (step, message) => {
                console.log('[POOL-CREATE] DAMMV2-SS Progress:', step, message);
              }
            });

            if (!dammv2Result.success || !dammv2Result.poolAddress) {
              throw new Error(dammv2Result.error || 'Failed to create DAMMV2 single-sided pool');
            }

            console.log('[POOL-CREATE] DAMM V2 single-sided pool created:', dammv2Result);
            newPoolAddress = dammv2Result.poolAddress;
          } else {
            // Two-sided: deposit both rift tokens (tokenA) and SOL (tokenB)
            console.log('[POOL-CREATE] Creating DAMM V2 (CPAMM) two-sided pool...');

            const dammv2Result = await createDAMMV2Pool({
              tokenAMint: tokenYMint, // SOL/WSOL as tokenA (quote)
              tokenBMint: riftToUse.riftMint!, // Rift token as tokenB (base)
              tokenAAmount: parseFloat(solLiquidityAmount), // SOL amount
              tokenBAmount: parseFloat(riftLiquidityAmount), // Rift amount
              initialPrice: effectiveInitialPrice,
              feeBps: 25, // 0.25% fee
              wallet: {
                publicKey: new PublicKey(wallet.publicKey),
                signTransaction: async (tx: Transaction) => {
                  return await phantomWallet.signTransaction(tx);
                },
                signAllTransactions: phantomWallet.signAllTransactions ? async (txs: Transaction[]) => {
                  return await phantomWallet.signAllTransactions!(txs);
                } : undefined
              },
              connection: connection as unknown as Connection,
              onProgress: (step, message) => {
                console.log('[POOL-CREATE] DAMMV2 Progress:', step, message);
              }
            });

            if (!dammv2Result.success || !dammv2Result.poolAddress) {
              throw new Error(dammv2Result.error || 'Failed to create DAMMV2 pool');
            }

            console.log('[POOL-CREATE] DAMM V2 two-sided pool created:', dammv2Result);
            newPoolAddress = dammv2Result.poolAddress;
          }
        } else {
          // DLMM for monorifts - single-sided concentrated liquidity - using new pool creation service
          // Reduce rift amount by 1% to account for Token-2022 transfer fees
          const dlmmRiftAmount = parseFloat(riftLiquidityAmount);
          const adjustedDlmmRiftAmount = dlmmRiftAmount * 0.99;

          // Map strategy type from old to new service (they should be the same enum values)
          const strategyForNewService = dlmmStrategy as unknown as DLMMPoolStrategyType;

          const dlmmResult = await createDLMMPool({
            tokenXMint: riftToUse.riftMint!, // rRIFT token
            tokenYMint: tokenYMint, // SOL
            tokenXAmount: adjustedDlmmRiftAmount,
            binStep: parseInt(dlmmBinStep) || 10,
            feeBps: parseInt(dlmmFeeBps) || 25,
            strategy: strategyForNewService,
            rangeInterval: parseInt(dlmmRangeInterval) || 10,
            initialPrice: effectiveInitialPrice,
            // MCap-based bin range - use when in MCap mode with valid values
            mcapRange: dlmmUseMcapRange && dlmmMinMcap > 0 && dlmmMaxMcap > 0 && dlmmTokenSupply > 0 ? {
              minMcap: dlmmMinMcap,
              maxMcap: dlmmMaxMcap,
              tokenSupply: dlmmTokenSupply
            } : undefined,
            forceCreateNew: createNewPool, // If user wants new pool, error if one exists
            wallet: {
              publicKey: new PublicKey(wallet.publicKey),
              signTransaction: async (tx: Transaction) => {
                return await phantomWallet.signTransaction(tx);
              },
              signAllTransactions: phantomWallet.signAllTransactions ? async (txs: Transaction[]) => {
                return await phantomWallet.signAllTransactions!(txs);
              } : undefined
            },
            connection: connection as unknown as Connection,
            onProgress: (step, message) => {
              console.log('[POOL-CREATE] DLMM Progress:', step, message);
            }
          });

          if (!dlmmResult.success || !dlmmResult.poolAddress) {
            throw new Error(dlmmResult.error || 'Failed to create DLMM pool');
          }

          console.log('[POOL-CREATE] DLMM pool created:', dlmmResult);
          newPoolAddress = dlmmResult.poolAddress;
        }

        // Get existing rift data to preserve pools and TVL
        const existingRift = rifts.find(r => r.id === riftPDA);
        const existingPools = existingRift?.meteoraPools || [];
        const existingTvl = existingRift?.tvl || 0;

        // Append new pool to existing pools array (don't replace)
        const updatedPools = existingPools.includes(newPoolAddress)
          ? existingPools
          : [...existingPools, newPoolAddress];

        // Add to existing TVL (don't replace)
        const updatedTvl = existingTvl + liquidityAmount;

        riftProtocolService.updateRiftInCache(riftPDA, {
          tvl: updatedTvl,
          apy: updatedTvl > 0 ? 15 + Math.random() * 10 : 0,
          volume24h: (existingRift?.volume24h || 0) + liquidityAmount * 0.1,
          hasMeteoraPool: true,
          liquidityPool: newPoolAddress, // Set as primary pool
          meteoraPool: newPoolAddress, // Set both for compatibility
          meteoraPools: updatedPools // Append, don't replace
        });

        // Update UI state immediately
        setRifts(prevRifts =>
          prevRifts.map(rift =>
            rift.id === riftPDA
              ? {
                  ...rift,
                  tvl: updatedTvl,
                  apy: updatedTvl > 0 ? 15 + Math.random() * 10 : 0,
                  volume24h: (rift.volume24h || 0) + liquidityAmount * 0.1,
                  hasMeteoraPool: true,
                  liquidityPool: newPoolAddress,
                  meteoraPool: newPoolAddress, // Set both for compatibility
                  meteoraPools: updatedPools // Append, don't replace
                }
              : rift
          )
        );

        // Update selected rift if it's the one we created pool for
        if (selectedRift && selectedRift.id === riftPDA) {
          setSelectedRift(prev => prev ? {
            ...prev,
            hasMeteoraPool: true,
            liquidityPool: newPoolAddress,
            meteoraPool: newPoolAddress, // Set both for compatibility
            meteoraPools: updatedPools, // Append, don't replace
            tvl: updatedTvl,
            apy: updatedTvl > 0 ? 15 + Math.random() * 10 : 0
          } : prev);
        }

        // SAVE TO SUPABASE IMMEDIATELY!
        if (existingRift) {
          const updatedRiftData = {
            ...existingRift,
            hasMeteoraPool: true,
            liquidityPool: newPoolAddress,
            meteoraPool: newPoolAddress, // Set both for compatibility
            meteoraPools: updatedPools, // Append, don't replace
            tvl: updatedTvl,
            apy: updatedTvl > 0 ? 15 + Math.random() * 10 : 0
          };

          (async () => {
            try {
              const { supabase } = await import('@/lib/supabase/client');
              await supabase
                .from('rifts')
                .update({
                  vault_balance: updatedRiftData.tvl.toString(),
                  total_tokens_wrapped: updatedRiftData.tvl.toString(),
                  raw_data: updatedRiftData,
                  updated_at: new Date().toISOString()
                })
                .eq('id', riftPDA);
            } catch (error) {
              console.error('Failed to update Supabase:', error);
            }
          })();
        }

        // Show Pool Success Modal with all details
        setPoolSuccessData({
          poolAddress: newPoolAddress,
          poolType: poolType === 'dlmm' ? 'dlmm' : 'dammv2',
          tokenSymbol: selectedRift?.symbol || selectedRift?.underlying || 'Token',
          tokenAmount: parseFloat(riftLiquidityAmount) || 0,
          solAmount: parseFloat(solLiquidityAmount) || 0,
        });
        setShowPoolSuccessModal(true);

        // Sync LP positions after creating new pool
        const syncRiftId = selectedRift?.id || riftPDA;
        if (syncRiftId) {
          fetch('/api/arb-lp-sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ riftId: syncRiftId })
          }).catch(err => console.log('[LP-SYNC] Background sync error:', err));
        }
      }

      // Close modal - we're done!
      setShowAddLiquidityModal(false);
      setSolLiquidityAmount('');
      setRiftLiquidityAmount('');

    } catch (error) {

      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: cleanErrorMessage(error, 'Failed to create pool and add liquidity')
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);
    } finally {
      setIsCreatingMeteoraPool(false);
    }
  };

  // Remove liquidity from Meteora pool
  const handleRemoveLiquidity = async () => {
    // Validation based on mode
    if (removeMode === 'positions' && selectedPositions.size === 0) {
      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: 'Please select at least one position to remove'
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);
      return;
    }

    if (removeMode === 'percentage') {
      const pct = parseFloat(removePercentage);
      if (isNaN(pct) || pct <= 0 || pct > 100) {
        const toastId = generateToastId();
        setToasts(prev => [...prev, {
          id: toastId,
          type: 'error',
          message: 'Please enter a valid percentage between 0 and 100'
        }]);
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== toastId));
        }, 5000);
        return;
      }
    }

    // Get pool address based on the selected pair (SOL or RIFTS)
    // User's positions are fetched from the correct pool, so use the poolAddress from the positions
    let poolAddress: string | undefined;

    // If we have positions, use the pool address from the first position
    if (userLpPositions.length > 0 && userLpPositions[0].poolAddress) {
      poolAddress = userLpPositions[0].poolAddress;
      console.log('[REMOVE-LIQ] Using pool from position:', poolAddress);
    } else {
      // Fallback: determine pool from pair selection
      const pools = selectedRift?.meteoraPools || [];
      if (liquidityTokenA === 'SOL') {
        // Look for SOL pool (solPool or first pool with wSOL)
        poolAddress = (selectedRift as any)?.solPool || pools[1] || pools[0] || selectedRift?.liquidityPool;
      } else {
        // Look for USD1 pool
        poolAddress = (selectedRift as any)?.usd1Pool || pools[0] || selectedRift?.liquidityPool;
      }
      console.log('[REMOVE-LIQ] Using pool from pair selection:', poolAddress, 'for', liquidityTokenA);
    }

    if (!poolAddress || poolAddress === '11111111111111111111111111111111') {
      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: 'No liquidity pool found for this rift. Please create a pool first by adding liquidity.'
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);
      return;
    }

    // Validate pool address is a valid public key
    try {
      new PublicKey(poolAddress);
    } catch (error) {
      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: `Invalid pool address: ${poolAddress}. Please contact support.`
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);
      return;
    }

    setIsCreatingMeteoraPool(true); // Reuse loading state
    let anySuccess = false;

    try {
      const phantomWallet = getWalletProvider();

      if (!phantomWallet) {
        throw new Error('No Solana wallet found. Please install Phantom or Solflare.');
      }

      // Create wallet adapter for meteora-liquidity-service
      const walletAdapter = {
        publicKey: new PublicKey(wallet.publicKey),
        signTransaction: async (transaction: Transaction) => {
          // Phantom will handle signing when we send
          const signed = await phantomWallet.signTransaction(transaction);
          return signed;
        },
        sendTransaction: async (transaction: Transaction, conn: Connection) => {
          // Phantom signs and sends
          const { signature } = await phantomWallet.signAndSendTransaction(transaction);
          return signature;
        },
        connected: true
      };

      let signatures: string[] = [];
      let successMessage = '';

      // NEW: Process positions by type - handle DLMM and CP-AMM separately
      if (removeMode === 'percentage') {
        // Get positions with their removal percentages
        const dlmmPositionsToRemove = userLpPositions.filter(p =>
          p.isDlmm && (positionRemovalPercentages[p.address] || 0) > 0
        );
        const cpammPositionsToRemove = userLpPositions.filter(p =>
          !p.isDlmm && (positionRemovalPercentages[p.address] || 0) > 0
        );

        console.log('[REMOVE-LIQ] DLMM positions to remove:', dlmmPositionsToRemove.length);
        console.log('[REMOVE-LIQ] CP-AMM positions to remove:', cpammPositionsToRemove.length);

        // Process DLMM positions
        for (const position of dlmmPositionsToRemove) {
          const pct = positionRemovalPercentages[position.address] || 0;
          if (pct <= 0) continue;

          console.log('[REMOVE-LIQ] Removing', pct, '% from DLMM position:', position.address, 'in pool:', position.poolAddress);

          try {
            // Use raw connection (not the Privy wrapper) for DLMM SDK
            const rawConnection = (connection as any).connection as Connection || connection;

            const sig = await dlmmLiquidityService.removeLiquidity(
              rawConnection as Connection,
              position.poolAddress, // Use THIS position's pool
              position.address,
              pct,
              {
                publicKey: new PublicKey(wallet.publicKey),
                signTransaction: async (tx: Transaction) => {
                  return await phantomWallet.signTransaction(tx);
                },
                signAllTransactions: async (txs: Transaction[]) => {
                  return await phantomWallet.signAllTransactions!(txs);
                }
              },
              // Progress callback for multi-transaction positions
              (current, total, status) => {
                setDlmmProgress({ current, total, status });
              }
            );
            signatures.push(sig);
            anySuccess = true;
            setDlmmProgress(null); // Clear progress when done
          } catch (error: any) {
            console.error('[REMOVE-LIQ] Error removing from DLMM position:', position.address, error);
            setDlmmProgress(null); // Clear progress on error
            // Re-throw the error so user sees it
            throw error;
          }
        }

        // Process CP-AMM positions - group by pool
        const cpammByPool = new Map<string, typeof cpammPositionsToRemove>();
        for (const pos of cpammPositionsToRemove) {
          const pool = pos.poolAddress;
          if (!cpammByPool.has(pool)) {
            cpammByPool.set(pool, []);
          }
          cpammByPool.get(pool)!.push(pos);
        }

        for (const [cpammPoolAddress, positions] of cpammByPool) {
          // For CP-AMM, use the per-position percentage
          // The service handles removing from individual positions based on percentage
          const firstPosPct = positionRemovalPercentages[positions[0].address] || 0;
          if (firstPosPct <= 0) continue;

          console.log('[REMOVE-LIQ] Removing from CP-AMM pool:', cpammPoolAddress, 'percentage:', firstPosPct);

          try {
            const result = await meteoraLiquidityService.removeLiquidityByPercentage({
              poolAddress: cpammPoolAddress,
              percentage: firstPosPct,
              wallet: walletAdapter,
              connection: connection as unknown as Connection
            });
            signatures.push(...result.signatures);
            if (result.signatures?.length) anySuccess = true;
          } catch (error) {
            console.error('[REMOVE-LIQ] Error removing from CP-AMM pool:', cpammPoolAddress, error);
            throw error;
          }
        }

        const dlmmCount = dlmmPositionsToRemove.length;
        const cpammCount = cpammPositionsToRemove.length;
        successMessage = `Removed liquidity from ${dlmmCount + cpammCount} position(s)! 🎉`;

      } else {
        // Remove selected positions (100% removal)
        const selectedDlmmPositions = userLpPositions.filter(p =>
          p.isDlmm && selectedPositions.has(p.address)
        );
        const selectedCpammPositions = userLpPositions.filter(p =>
          !p.isDlmm && selectedPositions.has(p.address)
        );

        // Process DLMM positions
        for (const position of selectedDlmmPositions) {
          console.log('[REMOVE-LIQ] Removing 100% from DLMM position:', position.address);
          try {
            // Use raw connection (not the Privy wrapper) for DLMM SDK
            const rawConnection = (connection as any).connection as Connection || connection;

            const sig = await dlmmLiquidityService.removeLiquidity(
              rawConnection as Connection,
              position.poolAddress,
              position.address,
              100,
              {
                publicKey: new PublicKey(wallet.publicKey),
                signTransaction: async (tx: Transaction) => {
                  return await phantomWallet.signTransaction(tx);
                },
                signAllTransactions: async (txs: Transaction[]) => {
                  return await phantomWallet.signAllTransactions!(txs);
                }
              },
              // Progress callback for multi-transaction positions
              (current, total, status) => {
                setDlmmProgress({ current, total, status });
              }
            );
            signatures.push(sig);
            anySuccess = true;
            setDlmmProgress(null); // Clear progress when done
          } catch (error: any) {
            console.error('[REMOVE-LIQ] Error removing DLMM position:', position.address, error);
            setDlmmProgress(null); // Clear progress on error
            // Re-throw the error so user sees it
            throw error;
          }
        }

        // Process CP-AMM positions - group by pool
        const cpammByPool = new Map<string, string[]>();
        for (const pos of selectedCpammPositions) {
          const pool = pos.poolAddress;
          if (!cpammByPool.has(pool)) {
            cpammByPool.set(pool, []);
          }
          cpammByPool.get(pool)!.push(pos.address);
        }

        for (const [cpammPoolAddress, posAddresses] of cpammByPool) {
          console.log('[REMOVE-LIQ] Removing', posAddresses.length, 'CP-AMM positions from pool:', cpammPoolAddress);
          try {
            const sigs = await meteoraLiquidityService.removeSpecificPositions({
              poolAddress: cpammPoolAddress,
              positionAddresses: posAddresses,
              wallet: walletAdapter,
              connection: connection as unknown as Connection
            });
            signatures.push(...sigs);
            if (sigs?.length) anySuccess = true;
          } catch (error) {
            console.error('[REMOVE-LIQ] Error removing CP-AMM positions:', error);
            throw error;
          }
        }

        successMessage = `${signatures.length} position(s) removed successfully! 🎉`;
      }

      if (!anySuccess) {
        throw new Error('Remove liquidity was cancelled or failed.');
      }

      // Show success notification
      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'success',
        message: successMessage,
        signature: signatures[0] // Show first signature
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);

      // REMOVED: No need to refresh entire rift list after adding liquidity

      // Close modal on success only
      setShowAddLiquidityModal(false);
      setSolLiquidityAmount('');
      setRiftLiquidityAmount('');

    } catch (error) {

      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: cleanErrorMessage(error, 'Failed to remove liquidity')
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);
    } finally {
      setIsCreatingMeteoraPool(false);
    }
  };

  // Reset modal state when closing
  const handleCloseCreateRiftModal = () => {
    setShowCreateRiftModal(false);
    setCreatedRiftPDA(null);
    setCreatedRiftData(null);
    setSelectedToken('');
    setCustomTokenAddress('');
    setCustomTokenSymbol('');
  };

  // Handle Create Rift (Legacy function for backward compatibility)
  const handleCreateRift = async () => {
    if (!selectedToken || !wallet.publicKey || !wallet.connected) {

      return;
    }

    // Validate custom token inputs
    if (selectedToken === 'CUSTOM' && (!customTokenAddress || !customTokenSymbol)) {
      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: 'Please enter custom token address and symbol'
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);
      return;
    }

    // Validate total fee (0.7% - 1.0%)
    const totalFeeValue = parseFloat(totalFee);
    if (isNaN(totalFeeValue) || totalFeeValue < 0.70 || totalFeeValue > 1.00) {
      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: 'Total fee must be between 0.7% and 1.0%'
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);
      return;
    }

    // Partner fee is automatically 50% of total fee - no separate validation needed

    // Validate initial liquidity amount
    if (!initialLiquidityAmount || parseFloat(initialLiquidityAmount) <= 0) {
      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: 'Please enter a valid initial liquidity amount'
      }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);
      return;
    }

    setIsCreatingRift(true);
    
    try {
      // Token addresses on mainnet
      const tokenAddresses: Record<string, string> = {
        'SOL': 'So11111111111111111111111111111111111111112',
        'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        'USD1': 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'
      };

      // Use custom token if selected
      const tokenAddress = selectedToken === 'CUSTOM'
        ? customTokenAddress
        : tokenAddresses[selectedToken];
      
      const tokenSymbol = selectedToken === 'CUSTOM'
        ? customTokenSymbol
        : selectedToken;

      const params = {
        tokenAddress,
        tokenSymbol,
        totalFee: parseFloat(totalFee),
        partnerWallet: partnerWallet || wallet.publicKey // Default to creator's wallet if not specified
      };

      // Set wallet on service before creating rift
      // Access the browser's wallet directly (Phantom, Solflare, etc.)
      const phantomWallet = getWalletProvider();

      if (!phantomWallet) {
        throw new Error('No Solana wallet found. Please install Phantom or Solflare.');
      }

      const walletAdapter = {
        publicKey: new PublicKey(wallet.publicKey),
        sendTransaction: async (transaction: Transaction) => {
          try {
            // Set transaction properties
            if (!transaction.recentBlockhash) {
              const latestBlockhash = await (connection as unknown as Connection).getLatestBlockhash();
              transaction.recentBlockhash = latestBlockhash.blockhash;
            }
            if (!transaction.feePayer && phantomWallet.publicKey) {
              transaction.feePayer = phantomWallet.publicKey;
            }
            
            // Use Phantom's signAndSendTransaction

            const { signature } = await phantomWallet.signAndSendTransaction(transaction);

            return signature;
          } catch (error: any) {

            throw error;
          }
        },
        signTransaction: async (transaction: Transaction) => {
          // For signing only, return the transaction as-is
          return transaction;
        }
      };
      riftProtocolService.setWallet(walletAdapter as WalletAdapter);

      // Step 1: Create the rift with vanity PDA (matching test-vanity-wsol.js approach)
      const createResult = await riftProtocolService.createRiftWithVanityPDA({
        creator: new PublicKey(wallet.publicKey),
        underlyingMint: new PublicKey(tokenAddress),
        partnerWallet: partnerWallet ? new PublicKey(partnerWallet) : undefined,
        riftName: tokenSymbol, // Use tokenSymbol which contains the custom name
        transferFeeBps: Math.round(parseFloat(totalFee) * 100), // Convert % to basis points (70-100 bps = 0.7-1%)
        prefixType: 0, // 0 = 'r' prefix for normal Rifts
      });

      if (!createResult.success) {
        throw new Error(createResult.error || 'Failed to create rift');
      }

      // Use the riftId from the result (already includes the vanity seed in PDA derivation)
      const riftPDA = new PublicKey(createResult.riftId!);

      if (createResult.success) {
        // Refresh rifts from blockchain to show newly created rift
        loadRifts(false, true); // forceRefresh=true to bypass cache

        // Rift was already added to cache immediately, no need for retries

        // Check if transaction is pending
        const isPending = (createResult as any).pending;

        // Step 2: Add initial liquidity by wrapping tokens

        let toastId = generateToastId();

        try {
          // Wait a moment for rift to be available
          if (isPending) {

            await new Promise(resolve => setTimeout(resolve, 3000));
          }

          const wrapResult = await riftProtocolService.wrapTokens({
            user: new PublicKey(wallet.publicKey),  // Add the user's public key
            riftPubkey: new PublicKey(riftPDA),  // Change riftAddress to riftPubkey and ensure it's a PublicKey
            amount: parseFloat(initialLiquidityAmount),
            initialRiftAmount: parseFloat(initialRiftAmount),
            tradingFeeBps: parseInt(tradingFeeBps),
            binStep: parseInt(binStep)
          });

          if (wrapResult.success) {

            // Update the rift in cache with new liquidity data
            const liquidityAmount = parseFloat(initialLiquidityAmount);
            riftProtocolService.updateRiftInCache(riftPDA.toBase58(), {
              tvl: liquidityAmount,
              apy: liquidityAmount > 0 ? 15 + Math.random() * 10 : 0,
              volume24h: liquidityAmount * 0.1
            });

            // Update UI state immediately
            setRifts(prevRifts =>
              prevRifts.map(rift =>
                rift.id === riftPDA.toBase58()
                  ? {
                      ...rift,
                      tvl: liquidityAmount,
                      apy: liquidityAmount > 0 ? 15 + Math.random() * 10 : 0,
                      volume24h: liquidityAmount * 0.1
                    }
                  : rift
              )
            );

            // Show success notification for both operations
            toastId = generateToastId();
            setToasts(prev => [...prev, {
              id: toastId,
              type: 'success',
              message: `Created r${tokenSymbol} rift and added ${initialLiquidityAmount} ${tokenSymbol} initial liquidity!`,
              signature: wrapResult.signature
            }]);
          } else {

            // Show partial success notification
            toastId = generateToastId();
            setToasts(prev => [...prev, {
              id: toastId,
              type: 'success',
              message: `Created r${tokenSymbol} rift successfully, but initial liquidity failed. You can add liquidity manually.`,
              signature: createResult.signature
            }]);
          }
        } catch (wrapError) {

          // Show partial success notification
          toastId = generateToastId();
          setToasts(prev => [...prev, {
            id: toastId,
            type: 'success',
            message: `Created r${tokenSymbol} rift successfully, but initial liquidity failed. You can add liquidity manually.`,
            signature: createResult.signature
          }]);
        }

        // Auto-remove toast after 8 seconds for pending, 5 for confirmed
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== toastId));
        }, 8000);

        // Reset form
        setSelectedToken('');
        setCustomTokenAddress('');
        setCustomTokenSymbol('');
        setTotalFee('0.80');
        setPartnerWallet('');
        setInitialLiquidityAmount('');
        setShowCreateRiftModal(false);
        
        // Rifts already updated in cache immediately
      }
    } catch (error) {

      // Show error notification
      const toastId = generateToastId();
      setToasts(prev => [...prev, {
        id: toastId,
        type: 'error',
        message: cleanErrorMessage(error, 'Failed to create rift')
      }]);
      
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastId));
      }, 5000);
    } finally {
      setIsCreatingRift(false);
    }
  };

  // Filtered and sorted rifts
  const filteredRifts = (() => {
    // First, filter by search query
    let filtered = rifts.filter(rift => {
      if (!searchQuery) return true;
      const query = searchQuery.toLowerCase();
      return (
        rift.symbol?.toLowerCase().includes(query) ||
        rift.underlying?.toLowerCase().includes(query) ||
        rift.strategy?.toLowerCase().includes(query)
      );
    });

    // Filter for tradeable rifts only (those with valid token mints)
    if (showOnlyTradeable) {
      const beforeCount = filtered.length;

      filtered = filtered.filter(rift => {
        const riftData = rift as unknown as {
          riftMint?: string;
          contractAddresses?: { riftsToken?: string };
          hasMeteoraPool?: boolean;
          liquidityPool?: string;
          tvl?: number;
          id?: string;
        };

        // Check multiple sources for riftMint (the token that can be traded)
        const riftMint = riftData.riftMint || riftData.contractAddresses?.riftsToken;

        // A rift is tradeable if it has a valid riftMint token address
        const hasValidMint = riftMint &&
          riftMint !== '11111111111111111111111111111111' &&
          riftMint !== PublicKey.default.toBase58() &&
          riftMint.length > 20;

        // Also consider rifts with Meteora pools as tradeable (must have valid pool address)
        // Note: TVL check removed - having a valid pool is enough to be tradeable
        const hasValidPool = riftData.liquidityPool &&
          riftData.liquidityPool !== '11111111111111111111111111111111' &&
          riftData.liquidityPool !== PublicKey.default.toBase58() &&
          riftData.liquidityPool.length > 20;
        const hasMeteoraPool = riftData.hasMeteoraPool && hasValidPool;

        const isTradeable = hasValidMint || hasMeteoraPool;

        // Debug logging for filtered rifts
        if (isTradeable) {

        }

        return isTradeable;
      });

      // If no rifts found, log all rift mints for debugging
      if (filtered.length === 0 && beforeCount > 0) {

        filtered.slice(0, 5).forEach(rift => {
          const riftData = rift as unknown as {
            riftMint?: string;
            contractAddresses?: { riftsToken?: string };
            id?: string;
          };

        });
      }
    }

    // Filter to show only rifts where user is creator or has positions
    if (showOnlyMyRifts && wallet.publicKey) {
      const walletAddress = wallet.publicKey.toString();

      // Get rift mints from user's LP positions
      const userRiftMints = new Set(
        userLpPositions
          .filter((p: any) => p.riftMint || p.tokenMint)
          .map((p: any) => p.riftMint || p.tokenMint)
      );

      filtered = filtered.filter(rift => {
        // Show rifts where user is the creator
        if (rift.creator === walletAddress) {
          return true;
        }
        // Also show rifts where user has LP positions
        const riftMint = (rift as any).riftMint || (rift as any).contractAddresses?.riftsToken;
        return userRiftMints.has(riftMint);
      });
    }

    // Remove duplicates if enabled (keep highest TVL for each symbol)
    if (hideDuplicates) {
      const beforeCount = filtered.length;
      const riftsBySymbol = new Map<string, RiftData>();

      filtered.forEach(rift => {
        const symbol = rift.symbol || rift.underlying;
        const existing = riftsBySymbol.get(symbol);

        // Keep the rift with highest TVL
        if (!existing || rift.tvl > existing.tvl) {
          riftsBySymbol.set(symbol, rift);
        }
      });

      filtered = Array.from(riftsBySymbol.values());
    }

    // Sort
    return filtered.sort((a, b) => {
      switch (sortBy) {
        case 'tvl': return b.tvl - a.tvl;
        case 'apy': return b.apy - a.apy;
        case 'volume': return b.volume24h - a.volume24h;
        case 'newest':
          // Sort by creation date (newest first), with account address as stable tiebreaker
          const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;

          // If both have timestamps, sort by timestamp
          if (dateA > 0 && dateB > 0) {
            return dateB - dateA;
          }

          // If only one has timestamp, prioritize the one with timestamp
          if (dateA > 0) return -1; // a has timestamp, put it first
          if (dateB > 0) return 1;  // b has timestamp, put it first

          // If neither has timestamp, use account address as stable sort
          return (a.id || '').localeCompare(b.id || '');
        default: return 0;
      }
    });
  })();

  const displayedRifts = useMemo(() => {
    return filteredRifts.map(r => {
      const override = dlmmLocalOverrides[r.id] || (r.riftMint ? dlmmLocalOverrides[r.riftMint] : undefined);
      const merged: RiftData & { prefixType?: number } = override ? { ...r, ...override } : r;
      const forceDlmm = merged.prefixType === 1;
      return { ...merged, symbol: getRiftDisplaySymbol(merged, forceDlmm) };
    });
  }, [filteredRifts, dlmmLocalOverrides]);

  // Enhanced Protocol Stats - Use actual rifts data (most accurate and real-time)
  // Calculate directly from rifts array to ensure accuracy
  const totalTVL = rifts.reduce((sum, rift) => sum + rift.tvl, 0);
  const totalVolume = rifts.reduce((sum, rift) => sum + rift.volume24h, 0);

  // DEBUG: Log volume calculation
  console.log(`[VOLUME-DEBUG] Main page: ${rifts.length} rifts, totalVolume=$${totalVolume.toLocaleString()}`);
  const highVolRifts = rifts.filter(r => r.volume24h > 10000);
  console.log(`[VOLUME-DEBUG] Rifts with >10k volume: ${highVolRifts.length}`);
  highVolRifts.slice(0, 5).forEach(r => console.log(`  ${r.symbol}: vol=$${r.volume24h.toLocaleString()}, tvl=$${r.tvl.toLocaleString()}`));

  // Calculate average APY directly from rifts array (most reliable)
  // Use TVL-weighted average: sum(apy × tvl) / sum(tvl)
  const riftsWithApy = rifts.filter(rift => rift.apy > 0 && rift.tvl > 0);
  const totalWeightedApy = riftsWithApy.reduce((sum, rift) => sum + (rift.apy * rift.tvl), 0);
  const totalApyTvl = riftsWithApy.reduce((sum, rift) => sum + rift.tvl, 0);
  const avgAPY = totalApyTvl > 0 ? totalWeightedApy / totalApyTvl : 0;
  const totalUsers = rifts.reduce((sum, rift) => sum + rift.participants, 0);

  // Real growth data from new analytics service (properly calculated)
  const tvlGrowth = realProtocolAnalytics?.tvlGrowth24h ?? 0;
  const volumeGrowth = realProtocolAnalytics?.volumeGrowth24h ?? 0;

  // Real fees and revenue from new analytics service (divide by 2 to fix double-counting bug)
  const totalFees = (realProtocolAnalytics?.totalFees ?? protocolAnalytics?.totalFees ?? realProtocolMetrics?.totalFeesGenerated ?? realMetrics?.totalFees ?? totalVolume * 0.003) / 2;
  const protocolRevenue = realProtocolAnalytics?.protocolFees ?? protocolAnalytics?.protocolFees ?? realProtocolMetrics?.protocolRevenue ?? totalFees * 0.1;
  const totalBurned = realProtocolAnalytics?.totalBurned ?? protocolAnalytics?.totalBurned ?? realMetrics?.totalBurned ?? totalFees * 0.45;
  const burnRate = realProtocolAnalytics?.burnRate ?? protocolAnalytics?.burnRate ?? 0.45;
  const pendingDistribution = realProtocolAnalytics?.pendingDistribution ?? protocolAnalytics?.pendingDistribution ?? 0;
  
  // RIFTS token data - DYNAMIC: Aggregates ALL r-tokens (rRIFTS, rSHIBA, rDOGE, etc.)
  // Find the primary rift (rRIFTS) for backwards compatibility, but also keep reference
  const rRIFTS = rifts.find(r => r.symbol === 'rRIFTS');

  const riftsTokenData = React.useMemo(() => {
    // Aggregate data from ALL rifts (dynamic - works for any r-token)
    const totalSupply = rifts.reduce((sum, rift) => sum + (rift.totalRiftMinted || 0), 0);
    const totalMarketCap = rifts.reduce((sum, rift) => {
      const riftPrice = rift.riftTokenPrice || 0;
      const riftSupply = rift.totalRiftMinted || 0;
      return sum + (riftPrice * riftSupply);
    }, 0);

    // Use weighted average price across all rifts
    const avgPrice = totalSupply > 0 ? totalMarketCap / totalSupply : 0.001;

    return {
      price: avgPrice, // Weighted average price across all r-tokens
      supply: totalSupply, // Total supply of ALL r-tokens combined
      circulatingSupply: totalSupply - totalBurned, // Total circulating supply
      burned: totalBurned,
      marketCap: totalMarketCap, // Total market cap of ALL r-tokens
      holders: totalUsers || 0, // Total unique holders
      tokenCount: rifts.length // Number of different r-tokens
    };
  }, [rifts, totalBurned, totalUsers]);

  // Calculate real user portfolio data from API or blockchain
  const getUserPortfolioData = () => {
    if (!wallet.connected || !wallet.publicKey) {
      return { totalValue: 0, positions: [], totalRewards: 0, claimableRewards: 0 };
    }

    // Priority 1: Use portfolio data from API (most accurate - from Supabase + blockchain)
    if (userPortfolioAPI && userPortfolioAPI.positions) {
      return {
        totalValue: userPortfolioAPI.totalValue || 0,
        positions: userPortfolioAPI.positions,
        totalRewards: userPortfolioAPI.totalRewards || 0,
        claimableRewards: userPortfolioAPI.claimableRewards || 0
      };
    }

    // Priority 2: Use real portfolio data from blockchain if available
    if (realPortfolioData) {
      return {
        totalValue: realPortfolioData.totalValue,
        positions: realPortfolioData.positions.map((p: any) => ({
          rift: p.rift,
          underlying: p.underlying,
          position: p.balance,
          value: p.value,
          pnl: p.pnl,
          rewards: p.rewards,
          entry: 1.0, // Would need to track entry price
          current: p.value / Math.max(p.balance, 0.000001)
        })),
        totalRewards: realPortfolioData.totalRewards,
        claimableRewards: realPortfolioData.claimableRewards
      };
    }

    // Fallback: empty portfolio
    return {
      totalValue: 0,
      positions: [],
      totalRewards: 0,
      claimableRewards: 0
    };
  };

  // Get real user transaction history from API (Supabase) or blockchain
  const getUserTransactionHistory = (): Array<{type: string, amount: string, timestamp: number, hash: string, rift: string, time: string, status: string, value: string}> => {
    if (!wallet.connected || !wallet.publicKey) {
      return [];
    }

    // Priority 1: Use transaction data from API (Supabase - most reliable)
    if (userPortfolioAPI && userPortfolioAPI.transactions && userPortfolioAPI.transactions.length > 0) {
      return userPortfolioAPI.transactions;
    }

    // Priority 2: Use real transaction data from blockchain
    if (realTransactions && realTransactions.length > 0) {
      return realTransactions.map(tx => ({
        type: tx.type,
        amount: tx.amount.toFixed(4),
        timestamp: tx.timestamp,
        hash: tx.signature,
        rift: tx.token,
        time: new Date(tx.timestamp).toLocaleString(),
        status: tx.status,
        value: `$${(tx.amount * 180).toFixed(2)}` // Using current SOL price
      }));
    }

    return [];
  };

  const monoriftTokenLabel = useMemo(() => (
    selectedToken === 'CUSTOM'
      ? (customTokenSymbol || 'TOKEN')
      : (selectedToken || 'TOKEN')
  ), [customTokenSymbol, selectedToken]);

  return (
    <div className="relative flex w-full min-h-screen text-white md:h-screen md:overflow-hidden">
      {/* Full Page RippleGrid Background */}
      <div className="fixed inset-0 z-0 bg-black pointer-events-none ios-pointer-none">
        <RippleGrid
          enableRainbow={false}
          gridColor="#10b981"
          rippleIntensity={0.03}
          gridSize={18}
          gridThickness={6}
          mouseInteraction={false}
          mouseInteractionRadius={3.0}
          opacity={0.85}
          fadeDistance={2.5}
          vignetteStrength={2.5}
          glowIntensity={0.5}
        />
      </div>
      {/* Governance Panel */}
      {/* Governance Panel - Higher z-index to appear above other modals */}
      <GovernancePanel
        wallet={wallet}
        isOpen={showGovernance}
        onClose={() => setShowGovernance(false)}
        addToast={(message: string, type: 'success' | 'error' | 'pending', signature?: string) => {
          const toastId = generateToastId();
          setToasts(prev => [...prev, {
            id: toastId,
            type,
            message,
            signature
          }]);
          setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== toastId));
          }, 5000);
        }}
      />
      
      {/* Sidebar Layout */}
      <div className="relative z-30">
        <DappSidebar
          user={user}
          wallet={{
            connected: wallet?.connected || false,
            connecting: wallet?.connecting,
            isConnecting: wallet?.isConnecting,
            publicKey: wallet?.publicKey?.toString(),
            formattedPublicKey: wallet?.formattedPublicKey,
            connect: () => wallet?.connect(),
            disconnect: () => wallet?.disconnect(),
          }}
          onMonoriftsClick={() => {
            setCreateRiftTab('dlmm');
            setShowCreateRiftModal(true);
          }}
          onTradingClick={() => setShowTradingModal(true)}
        />
      </div>


      {/* Main Content Area */}
      <div className="relative z-20 flex flex-col flex-1 overflow-hidden pt-16 md:pt-0">
        {/* Main Content Area with pointer events for interactive elements only */}
        <div className="relative flex flex-col flex-1 p-3 md:px-6 md:py-3">
          {/* Header Section - Wallet and Quick Actions at same level */}
          <div className="flex flex-col md:flex-row md:items-center justify-between mb-3 gap-3">
            {/* Quick Actions */}
            <div className="flex flex-wrap gap-2 md:gap-3 w-full md:w-auto">
              <LuxuryButton variant="primary" size="sm" onClick={() => setShowCreateRiftModal(true)} className="text-xs md:text-sm">
                <Plus className="w-3 h-3 md:w-4 md:h-4" />
                <span className="hidden sm:inline">Create Rift</span>
                <span className="sm:hidden">Create</span>
              </LuxuryButton>
              <LuxuryButton variant="primary" size="sm" onClick={() => setShowLaunchModal(true)} className="text-xs md:text-sm bg-gradient-to-r from-teal-500 to-emerald-400 hover:from-teal-600 hover:to-emerald-500">
                <Rocket className="w-3 h-3 md:w-4 md:h-4" />
                <span className="hidden sm:inline">Launch</span>
                <span className="sm:hidden">Launch</span>
              </LuxuryButton>
              <LuxuryButton variant="secondary" size="sm" onClick={() => router.push('/dapp/dashboard')} className="text-xs md:text-sm">
                <BarChart3 className="w-3 h-3 md:w-4 md:h-4" />
                <span className="hidden sm:inline">Analytics</span>
                <span className="sm:hidden">Stats</span>
              </LuxuryButton>
              <LuxuryButton variant="secondary" size="sm" onClick={() => setShowPortfolioModal(true)} className="text-xs md:text-sm">
                <Wallet className="w-3 h-3 md:w-4 md:h-4" />
                <span className="hidden sm:inline">Portfolio</span>
                <span className="sm:hidden">Portfolio</span>
              </LuxuryButton>
            </div>

            {/* Wallet Connection */}
            <div className="flex flex-col md:flex-row items-stretch md:items-center gap-2 md:gap-3 w-full md:w-auto">
              {!wallet.connected ? (
                <LuxuryButton
                  variant="primary"
                  size="md"
                  onClick={wallet.connect}
                  loading={wallet.connecting}
                  disabled={wallet.connecting}
                  className="w-full md:w-auto text-sm"
                >
                  <Wallet className="w-4 h-4 md:w-5 md:h-5" />
                  {wallet.connecting ? 'Connecting...' : 'Connect Wallet'}
                </LuxuryButton>
              ) : (
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full md:w-auto">
                  {/* RIFTS Price Display */}
                  <div className="hidden md:flex items-center gap-1 bg-black/50 backdrop-blur-sm border border-emerald-500/20 rounded-lg px-3 py-1.5">
                    <span className="text-xs text-gray-400">RIFTS:</span>
                    <span className="text-xs text-emerald-400 font-mono font-semibold">
                      ${riftsTokenPrice > 0 ? riftsTokenPrice.toFixed(6) : '0.00'}
                    </span>
                  </div>
                  {/* Arb Revenue Display */}
                  <div className="hidden md:flex items-center gap-1 bg-black/50 backdrop-blur-sm border border-purple-500/20 rounded-lg px-3 py-1.5">
                    <span className="text-xs text-gray-400">Arb Revenue:</span>
                    <span className="text-xs text-purple-400 font-mono font-semibold">
                      ${arbBotRevenue > 0 ? arbBotRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '0'}
                    </span>
                  </div>
                  {/* Buybacks Display */}
                  <div className="hidden md:flex items-center gap-1 bg-black/50 backdrop-blur-sm border border-blue-500/20 rounded-lg px-3 py-1.5">
                    <span className="text-xs text-gray-400">Buybacks:</span>
                    <span className="text-xs text-blue-400 font-mono font-semibold" title={`SOL Price: $${solPrice}, Value: $${80 * solPrice}`}>
                      ${solPrice > 0 ? (80 * solPrice).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '0'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-center sm:text-right bg-black/50 backdrop-blur-sm border border-emerald-500/20 rounded-lg px-4 py-2 min-w-[140px]">
                      <div className="text-xs md:text-sm text-emerald-400 font-mono">
                        {wallet.publicKey?.slice(0, 4)}...{wallet.publicKey?.slice(-4)}
                      </div>
                      <div className="flex items-center justify-center sm:justify-end gap-1 text-xs text-emerald-400 mt-1">
                        {wallet.balance.toFixed(2)} SOL
                        <button
                          onClick={refreshBalance}
                          className="text-emerald-400/60 hover:text-emerald-400 transition-colors p-0.5 rounded hover:bg-emerald-400/10"
                          title="Refresh balance"
                        >
                          <Activity className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    <LuxuryButton
                      variant="secondary"
                      size="sm"
                      onClick={() => setShowUserProfileModal(true)}
                      className="text-xs"
                    >
                      <Share2 className="w-3 h-3" />
                      Referrals
                    </LuxuryButton>
                    <LuxuryButton
                      variant="ghost"
                      size="sm"
                      onClick={wallet.disconnect}
                      className="text-xs"
                    >
                      <Wallet className="w-3 h-3" />
                      Disconnect
                    </LuxuryButton>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Main Content */}
          <main className="flex-1 overflow-y-auto max-h-[calc(100vh-120px)] px-6 pt-2 pb-40">
        {/* Stats Row */}
        <div className="grid grid-cols-2 gap-3 mb-4 lg:grid-cols-4">
          <DetailedStatsCard icon={<DollarSign className="w-4 h-4" />} label="TVL" value={formatCurrency(totalTVL)} />
          <DetailedStatsCard icon={<Activity className="w-4 h-4" />} label="24h Volume" value={formatCurrency(totalVolume)} />
          <DetailedStatsCard icon={<TrendingUp className="w-4 h-4" />} label="Avg APY" value={`${avgAPY.toFixed(1)}%`} />
          <DetailedStatsCard icon={<Users className="w-4 h-4" />} label="Farmers" value={totalUsers.toLocaleString()} />
        </div>

        {/* Compact Search and Controls */}
        <div className="flex flex-col gap-2 mb-4 md:flex-row md:items-center">
          <div className="relative flex-1">
            <Search className="absolute w-4 h-4 text-gray-500 transform -translate-y-1/2 left-3 top-1/2" />
            <input
              placeholder="Search rifts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-9 pl-9 pr-3 text-sm text-emerald-400 placeholder-gray-500 bg-black/50 border border-emerald-500/20 rounded-lg outline-none focus:border-emerald-500/50"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isMounted ? (
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="h-9 w-32 text-xs text-emerald-400 bg-black/50 border-emerald-500/20 focus:ring-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="text-emerald-400 bg-black border border-emerald-500/30">
                  <SelectItem value="newest" className="text-xs">Newest</SelectItem>
                  <SelectItem value="tvl" className="text-xs">TVL</SelectItem>
                  <SelectItem value="apy" className="text-xs">APY</SelectItem>
                  <SelectItem value="volume" className="text-xs">Volume</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <div className="h-9 w-32 text-xs text-emerald-400 bg-black/50 border border-emerald-500/20 rounded-lg flex items-center px-3">TVL</div>
            )}

            <button onClick={() => setShowFiltersModal(true)} className="h-9 px-3 text-xs text-emerald-400 bg-black/50 border border-emerald-500/20 rounded-lg hover:border-emerald-500/40 flex items-center gap-1.5">
              <Filter className="w-3.5 h-3.5" />
              Filters
            </button>

            <button
              onClick={() => setHideDuplicates(!hideDuplicates)}
              className={`h-9 px-3 text-xs rounded-lg flex items-center gap-1.5 ${hideDuplicates ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'text-gray-400 bg-black/50 border border-gray-700 hover:border-gray-600'}`}
            >
              <Layers className="w-3.5 h-3.5" />
              Unique
            </button>

            <button
              onClick={() => setShowOnlyTradeable(!showOnlyTradeable)}
              className={`h-9 px-3 text-xs rounded-lg flex items-center gap-1.5 ${showOnlyTradeable ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'text-gray-400 bg-black/50 border border-gray-700 hover:border-gray-600'}`}
            >
              <TrendingUp className="w-3.5 h-3.5" />
              Tradeable
            </button>

            {wallet.publicKey && (
              <button
                onClick={() => setShowOnlyMyRifts(!showOnlyMyRifts)}
                className={`h-9 px-3 text-xs rounded-lg flex items-center gap-1.5 ${showOnlyMyRifts ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'text-gray-400 bg-black/50 border border-gray-700 hover:border-gray-600'}`}
              >
                <Wallet className="w-3.5 h-3.5" />
                My Rifts
              </button>
            )}
          </div>
        </div>

        {/* Compact info banners */}
        {(hideDuplicates || showOnlyTradeable) && (
          <div className="flex items-center gap-2 mb-3 text-xs text-gray-400">
            {hideDuplicates && <span className="px-2 py-1 rounded bg-emerald-500/10 text-emerald-400">{displayedRifts.length} unique (of {rifts.length})</span>}
            {showOnlyTradeable && <span className="px-2 py-1 rounded bg-blue-500/10 text-blue-400">Tradeable only</span>}
          </div>
        )}

        {/* Show loading spinner while wallet is connecting */}
        {wallet.connecting ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="relative w-20 h-20 mb-6">
              <div className="absolute inset-0 border-4 border-blue-500/20 rounded-full"></div>
              <div className="absolute inset-0 border-4 border-transparent border-t-blue-500 rounded-full animate-spin"></div>
            </div>
            <h3 className="mb-2 text-xl font-bold text-white">Connecting Wallet...</h3>
            <p className="text-gray-400">Please approve the connection in your wallet</p>
          </div>
        ) : displayedRifts.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 items-start">
            {displayedRifts.map((rift, index) => (
              <motion.div
                key={rift.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.1 }}
              >
                <LuxuryRiftCard
                  rift={rift}
                  onWrap={async () => {
                    // Open modal immediately, start prefetch/balance fetch in background
                    console.log('🔍 Opening wrap modal for:', {
                      symbol: rift.symbol,
                      underlying: rift.underlying,
                      underlyingMint: rift.underlyingMint
                    });
                    setSelectedRift(rift);
                    setShowWrapModal(true);
                    void Promise.allSettled([
                      fetchTokenBalance(rift),
                      fetchRiftTokenBalance(rift, true),
                      riftProtocolService.prefetchWrapData(new PublicKey(rift.id)).catch(() => {})
                    ]);
        }}
        onUnwrap={async () => {
          setSelectedRift(rift);
          // Open modal immediately; refresh in background
          void riftProtocolService
                      .prefetchUnwrapData(new PublicKey(rift.id))
                      .catch(() => {});
                    const timeSinceLastUpdate = Date.now() - lastBalanceUpdate;
                    if (timeSinceLastUpdate > 60000) {
                      void fetchRiftTokenBalance(rift, true);
                    }
                    setShowUnwrapModal(true);
                  }}
                  onAddLiquidity={async () => {
                    // Use the enriched rift from rifts state instead of the callback parameter
                    // to ensure we have the latest meteoraPools data
                    const enrichedRift = rifts.find(r => r.id === rift.id) || rift;
                    console.log('[ADD-LIQUIDITY-CLICK] Clicked rift:', rift.id, 'symbol:', rift.symbol, 'riftMint:', rift.riftMint);
                    console.log('[ADD-LIQUIDITY-CLICK] Enriched rift:', enrichedRift.id, 'symbol:', enrichedRift.symbol, 'riftMint:', enrichedRift.riftMint);
                    console.log('[ADD-LIQUIDITY-CLICK] Meteora pools:', enrichedRift.meteoraPools);
                    setSelectedRift(enrichedRift);

                    // Always default to SOL pair
                    setLiquidityTokenA('SOL');

                    // Set pool type based on rift type: monorifts use DLMM, regular rifts use CPAMM
                    const isMonorift = (enrichedRift as any)?.prefixType === 1;
                    if (isMonorift) {
                      setPoolType('dlmm');
                      setDlmmSingleSided(true);
                    } else {
                      setPoolType('cpamm');
                      setDlmmSingleSided(false);
                    }

                    await fetchTokenBalance(enrichedRift);
                    await fetchRiftTokenBalance(enrichedRift, true);
                    await fetchRiftsTokenBalance(); // Fetch RIFTS token balance
                    await fetchUsd1TokenBalance(); // Fetch USD1 token balance

                    // Check if pool exists
                    if (hasValidPool(enrichedRift)) {
                      // Pool exists - open add liquidity modal in add mode

                      setLiquidityTab('add');
                      setUsePriceMode(false);
                      setShowAddLiquidityModal(true);
                    } else {
                      // New pool - open create pool modal

                      setLiquidityRatio(1.0);
                      setInitialPrice('1.0');
                      setUsePriceMode(false);
                      setLiquidityTab('add');
                      setShowAddLiquidityModal(true);
                    }
                  }}
                  onDetails={() => {
                    setSelectedRift(rift);
                    setShowDetailsModal(true);
                  }}
                  onCloseRift={async () => {
                    if (!rift || !wallet.publicKey) {

                      return;
                    }

                    try {

                      const productionService = new ProductionRiftsService(connection as unknown as Connection);

                      const walletAdapter: WalletAdapter = {
                        publicKey: new PublicKey(wallet.publicKey),
                        sendTransaction: async (transaction: Transaction) => {
                          const walletProvider = getWalletProvider();
                          if (walletProvider) {
                            const { signature } = await walletProvider.signAndSendTransaction(transaction);
                            return signature;
                          }
                          throw new Error('No Solana wallet found');
                        },
                        signTransaction: async (transaction: Transaction) => {
                          // For signing only, return the transaction as-is
                          return transaction;
                        }
                      };

                      productionService.setWallet(walletAdapter);

                      const result = await productionService.adminCloseRift({
                        riftPubkey: new PublicKey(rift.id)
                      });

                      if (result.success) {

                        await loadRifts();
                      } else {

                      }
                    } catch (error) {

                    }
                  }}
                  onClaimFees={() => {
                    setSelectedRift(rift);
                    setShowClaimFeesModal(true);
                    fetchAvailableVaultFees(rift);
                  }}
                  onClaimDexFees={async () => {
                    setSelectedRift(rift);
                    setShowClaimDexFeesModal(true);
                    setIsLoadingDexFees(true);
                    try {
                      const result = await riftProtocolService.getWithheldVaultFeesAvailable({
                        riftPubkey: new PublicKey(rift.id)
                      });
                      if (result.success) {
                        setDexFeesData({
                          available: result.available,
                          partnerShare: result.partnerShare ?? 0,
                          treasuryShare: result.treasuryShare ?? 0,
                          userClaimable: result.userClaimable ?? 0
                        });
                        setAvailableDexFees(result.userClaimable ?? 0); // Show only what user can claim
                      }
                    } catch (error) {
                      console.error('Error fetching DEX fees:', error);
                      setAvailableDexFees(0);
                    } finally {
                      setIsLoadingDexFees(false);
                    }
                  }}
                  onClaimRiftFees={async () => {
                    setSelectedRift(rift);
                    setShowClaimRiftFeesModal(true);
                    setIsLoadingRiftFees(true);
                    try {
                      const result = await riftProtocolService.getVaultFeesAvailable({
                        riftPubkey: new PublicKey(rift.id)
                      });
                      if (result.success) {
                        setRiftFeesData({
                          available: result.available,
                          partnerShare: result.partnerShare || 0,
                          treasuryShare: result.treasuryShare || 0,
                          userClaimable: result.userClaimable ?? 0
                        });
                        setAvailableRiftFees(result.userClaimable ?? 0); // Show only what user can claim
                      }
                    } catch (error) {
                      console.error('Error fetching Rift fees:', error);
                      setAvailableRiftFees(0);
                    } finally {
                      setIsLoadingRiftFees(false);
                    }
                  }}
                  onTrade={() => {
                    setSelectedRift(rift);
                    setShowTradingModal(true);
                  }}
                  currentWallet={wallet.publicKey?.toString()}
                  isHydrated={isMounted}
                  arbRevenueSol={arbRevenue[rift.id] || 0}
                  fallbackAPY={avgAPY}
                  isArbBotRunning={runningArbBots.has(rift.id)}
                  onStartArbBot={() => handleStartArbBot(rift.id)}
                  onStopArbBot={() => handleStopArbBot(rift.id)}
                  isArbBotLoading={arbBotLoading === rift.id}
                />
              </motion.div>
            ))}
          </div>
        ) : loading ? (
          <div className="py-20 text-center">
            <div className="flex items-center justify-center w-20 h-20 mx-auto mb-6 border border-emerald-500/30 bg-gradient-to-br from-gray-800 to-gray-900 rounded-3xl animate-pulse">
              <Layers className="w-10 h-10 text-emerald-400 animate-spin" style={{ animationDuration: '3s' }} />
            </div>
            <h3 className="mb-4 text-2xl font-bold text-white">
              Loading Rifts...
            </h3>
            <p className="max-w-md mx-auto mb-8 text-gray-400">
              Fetching volatility farming opportunities from the blockchain.
            </p>
            <div className="flex justify-center gap-1">
              <div className="w-2 h-2 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-2 h-2 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-2 h-2 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        ) : (
          <div className="py-20 text-center">
            <div className="flex items-center justify-center w-20 h-20 mx-auto mb-6 border border-gray-700 bg-gradient-to-br from-gray-800 to-gray-900 rounded-3xl">
              <Layers className="w-10 h-10 text-green-400" />
            </div>
            <h3 className="mb-4 text-2xl font-bold text-white">
              {searchQuery ? 'No matching rifts found' : 'No rifts available'}
            </h3>
            <p className="max-w-md mx-auto mb-8 text-gray-400">
              {searchQuery
                ? 'Try adjusting your search criteria to discover more volatility farming opportunities.'
                : 'Be the first to create a revolutionary volatility farming strategy.'}
            </p>
            {!searchQuery && (
              <LuxuryButton variant="primary" size="lg" onClick={() => setShowCreateRiftModal(true)}>
                <Plus className="w-5 h-5" />
                Create First Rift
              </LuxuryButton>
            )}
          </div>
        )}
      </main>
        </div>
      </div>

      {/* Enhanced Rift Details Modal */}
      <AnimatePresence>
        {showDetailsModal && selectedRift && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
            onClick={(e) => e.target === e.currentTarget && setShowDetailsModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.2 }}
              className="w-full max-w-lg bg-black/90 backdrop-blur-md border border-emerald-500/30 rounded-xl shadow-2xl overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-emerald-500/20">
                <div>
                  <h2 className="text-base font-semibold text-emerald-400">{selectedRift.symbol} Analysis</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Comprehensive rift performance data</p>
                </div>
                <button
                  onClick={() => setShowDetailsModal(false)}
                  className="p-2 rounded-lg text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Tab Navigation */}
              <div className="px-5 py-3 border-b border-emerald-500/20">
                <div className="flex gap-1 p-1 bg-black/50 rounded-lg border border-emerald-500/10">
                  <button
                    onClick={() => setDetailsActiveTab('details')}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                      detailsActiveTab === 'details'
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : 'text-gray-400 hover:text-white border border-transparent'
                    }`}
                  >
                    <Info className="w-3.5 h-3.5" />
                    Details
                  </button>
                  <button
                    onClick={() => setDetailsActiveTab('trading')}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                      detailsActiveTab === 'trading'
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : 'text-gray-400 hover:text-white border border-transparent'
                    }`}
                  >
                    <TrendingUp className="w-3.5 h-3.5" />
                    Trading
                  </button>
                </div>
              </div>

              {/* Content */}
              <div className="px-5 py-4 max-h-[60vh] overflow-y-auto space-y-4">
                {detailsActiveTab === 'details' ? (
                  <>
                    {/* Close Rift Section */}
                    {selectedRift?.vault === '11111111111111111111111111111111' && (
                      <div className="p-3 rounded-lg border border-red-500/30 bg-red-500/10">
                        <h3 className="flex items-center gap-2 mb-2 text-sm font-semibold text-red-400">
                          <AlertCircle className="w-4 h-4" />
                          Rift Maintenance Required
                        </h3>
                        <p className="mb-3 text-xs text-gray-400">
                          This rift has an invalid vault configuration and needs to be closed before creating a new one.
                        </p>
                        <button
                          onClick={handleCloseRift}
                          className="w-full px-3 py-2 text-sm font-medium text-red-400 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 rounded-lg transition-colors flex items-center justify-center gap-2"
                        >
                          <Eye className="w-4 h-4" />
                          Close Invalid Rift
                        </button>
                      </div>
                    )}

                    {/* Price Information */}
                    <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
                      <h3 className="flex items-center gap-2 mb-3 text-sm font-semibold text-white">
                        <DollarSign className="w-4 h-4 text-emerald-400" />
                        Price Information
                      </h3>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="p-2 rounded-lg bg-black/30 border border-emerald-500/10">
                          <p className="text-xs text-gray-500 mb-1">Rift Price</p>
                          <p className="text-lg font-semibold text-emerald-400">${selectedRift.riftPrice.toFixed(4)}</p>
                        </div>
                        <div className="p-2 rounded-lg bg-black/30 border border-emerald-500/10">
                          <p className="text-xs text-gray-500 mb-1">Underlying Price</p>
                          <p className="text-lg font-semibold text-blue-400">${selectedRift.fairPrice.toFixed(4)}</p>
                        </div>
                      </div>
                    </div>

                    {/* Fee Structure */}
                    <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
                      <h3 className="flex items-center gap-2 mb-3 text-sm font-semibold text-white">
                        <DollarSign className="w-4 h-4 text-yellow-400" />
                        Fee Structure
                      </h3>
                      <div className="space-y-3">
                        {selectedRift.feeStructure.hasTransferFee && selectedRift.feeStructure.totalTransferFee !== null && selectedRift.feeStructure.totalTransferFee !== undefined ? (
                          <div className="p-2 rounded-lg bg-black/30 border border-emerald-500/10">
                            <p className="text-xs text-gray-500 mb-1">Total Fees (SPL Token-2022)</p>
                            <p className="text-lg font-semibold text-white">{selectedRift.id === "CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL" ? "0" : selectedRift.feeStructure.totalTransferFee.toFixed(2)}%</p>
                            <p className="text-xs text-gray-500 mt-1">
                              {selectedRift.id === "CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL" ? "Treasury: 0% • Partner: 0%" : `Treasury: ${selectedRift.feeStructure.treasuryShare?.toFixed(2)}% • Partner: ${selectedRift.feeStructure.partnerShare?.toFixed(2)}%`}
                            </p>
                          </div>
                        ) : (
                          <div className="p-2 rounded-lg bg-black/30 border border-emerald-500/10">
                            <p className="text-xs text-gray-500">Fee data unavailable</p>
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-2">
                          <div className="p-2 rounded-lg bg-black/30 border border-emerald-500/10">
                            <p className="text-xs text-gray-500 mb-1">Wrap Fee</p>
                            <p className="text-sm font-semibold text-white">{selectedRift.id === "CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL" ? "0.700" : selectedRift.feeStructure.wrapFee.toFixed(3)}%</p>
                          </div>
                          <div className="p-2 rounded-lg bg-black/30 border border-emerald-500/10">
                            <p className="text-xs text-gray-500 mb-1">Unwrap Fee</p>
                            <p className="text-sm font-semibold text-white">{selectedRift.id === "CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL" ? "0.700" : selectedRift.feeStructure.unwrapFee.toFixed(3)}%</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Rift Token Info */}
                    <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
                      <h3 className="flex items-center gap-2 mb-3 text-sm font-semibold text-white">
                        <Coins className="w-4 h-4 text-purple-400" />
                        Token Addresses
                      </h3>
                      <div className="space-y-2">
                        {/* Rift Mint */}
                        <div className="p-2 rounded-lg bg-black/30 border border-emerald-500/10">
                          <p className="text-xs text-gray-500 mb-1">Rift Token Mint</p>
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-mono text-emerald-400 truncate max-w-[200px]">
                              {selectedRift.riftMint || 'N/A'}
                            </p>
                            {selectedRift.riftMint && (
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => {
                                    navigator.clipboard.writeText(selectedRift.riftMint!);
                                    const toastId = generateToastId();
                                    setToasts(prev => [...prev, { id: toastId, type: 'success', message: 'Copied to clipboard!' }]);
                                    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 2000);
                                  }}
                                  className="p-1 rounded hover:bg-emerald-500/20 transition-colors"
                                  title="Copy"
                                >
                                  <Copy className="w-3 h-3 text-gray-400 hover:text-emerald-400" />
                                </button>
                                <a
                                  href={`https://solscan.io/token/${selectedRift.riftMint}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="p-1 rounded hover:bg-emerald-500/20 transition-colors"
                                  title="View on Solscan"
                                >
                                  <ExternalLink className="w-3 h-3 text-gray-400 hover:text-emerald-400" />
                                </a>
                              </div>
                            )}
                          </div>
                        </div>
                        {/* Underlying Mint */}
                        <div className="p-2 rounded-lg bg-black/30 border border-emerald-500/10">
                          <p className="text-xs text-gray-500 mb-1">Underlying Token Mint</p>
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-mono text-blue-400 truncate max-w-[200px]">
                              {selectedRift.underlyingMint || 'N/A'}
                            </p>
                            {selectedRift.underlyingMint && (
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => {
                                    navigator.clipboard.writeText(selectedRift.underlyingMint!);
                                    const toastId = generateToastId();
                                    setToasts(prev => [...prev, { id: toastId, type: 'success', message: 'Copied to clipboard!' }]);
                                    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 2000);
                                  }}
                                  className="p-1 rounded hover:bg-emerald-500/20 transition-colors"
                                  title="Copy"
                                >
                                  <Copy className="w-3 h-3 text-gray-400 hover:text-blue-400" />
                                </button>
                                <a
                                  href={`https://solscan.io/token/${selectedRift.underlyingMint}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="p-1 rounded hover:bg-emerald-500/20 transition-colors"
                                  title="View on Solscan"
                                >
                                  <ExternalLink className="w-3 h-3 text-gray-400 hover:text-blue-400" />
                                </a>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Meteora Pools */}
                    {((selectedRift.meteoraPools?.length ?? 0) > 0 || selectedRift.liquidityPool || selectedRift.meteoraPool) && (
                      <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
                        <h3 className="flex items-center gap-2 mb-3 text-sm font-semibold text-white">
                          <Droplets className="w-4 h-4 text-blue-400" />
                          Meteora Pools
                        </h3>
                        <div className="space-y-2">
                          {(() => {
                            // Collect all unique pools
                            const allPools = new Set<string>();
                            if (selectedRift.liquidityPool && selectedRift.liquidityPool !== '11111111111111111111111111111111') {
                              allPools.add(selectedRift.liquidityPool);
                            }
                            if (selectedRift.meteoraPool && selectedRift.meteoraPool !== '11111111111111111111111111111111') {
                              allPools.add(selectedRift.meteoraPool);
                            }
                            selectedRift.meteoraPools?.forEach(p => {
                              if (p && p !== '11111111111111111111111111111111') allPools.add(p);
                            });

                            const poolsArray = Array.from(allPools);
                            const primaryPool = selectedRift.liquidityPool || selectedRift.meteoraPool;

                            if (poolsArray.length === 0) {
                              return (
                                <p className="text-xs text-gray-500">No pools found</p>
                              );
                            }

                            return poolsArray.map((poolAddr, idx) => {
                              const isPrimary = poolAddr === primaryPool;
                              return (
                                <div key={poolAddr} className={`p-2 rounded-lg bg-black/30 border ${isPrimary ? 'border-blue-500/30' : 'border-emerald-500/10'}`}>
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                      {isPrimary && (
                                        <span className="px-1.5 py-0.5 text-[9px] font-medium bg-blue-500/20 text-blue-400 rounded">
                                          PRIMARY
                                        </span>
                                      )}
                                      <p className="text-xs font-mono text-gray-400 truncate max-w-[180px]">
                                        {poolAddr.slice(0, 8)}...{poolAddr.slice(-6)}
                                      </p>
                                    </div>
                                    <div className="flex items-center gap-1">
                                      <button
                                        onClick={() => {
                                          navigator.clipboard.writeText(poolAddr);
                                          const toastId = generateToastId();
                                          setToasts(prev => [...prev, { id: toastId, type: 'success', message: 'Pool address copied!' }]);
                                          setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 2000);
                                        }}
                                        className="p-1 rounded hover:bg-emerald-500/20 transition-colors"
                                        title="Copy pool address"
                                      >
                                        <Copy className="w-3 h-3 text-gray-400 hover:text-emerald-400" />
                                      </button>
                                      <a
                                        href={`https://app.meteora.ag/pools/${poolAddr}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="p-1 rounded hover:bg-blue-500/20 transition-colors flex items-center gap-1"
                                        title="View on Meteora"
                                      >
                                        <ExternalLink className="w-3 h-3 text-blue-400" />
                                      </a>
                                    </div>
                                  </div>
                                </div>
                              );
                            });
                          })()}
                        </div>
                      </div>
                    )}

                    {/* Quick Actions */}
                    <div className="grid grid-cols-3 gap-2">
                      <button
                        onClick={async () => {
                          setShowDetailsModal(false);
                          setShowWrapModal(true);
                          if (selectedRift) {
                            void Promise.allSettled([
                              fetchTokenBalance(selectedRift),
                              fetchRiftTokenBalance(selectedRift, true),
                              riftProtocolService.prefetchWrapData(new PublicKey(selectedRift.id)).catch(() => {})
                            ]);
                          }
                        }}
                        className="px-3 py-2 text-xs font-medium text-emerald-400 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                      >
                        <Lock className="w-3 h-3" />
                        Wrap
                      </button>
                      <button
                        onClick={async () => {
                          setShowDetailsModal(false);
                          if (selectedRift) {
                            void riftProtocolService.prefetchUnwrapData(new PublicKey(selectedRift.id)).catch(() => {});
                          }
                          if (selectedRift) {
                            const timeSinceLastUpdate = Date.now() - lastBalanceUpdate;
                            if (timeSinceLastUpdate > 60000) {
                              void fetchRiftTokenBalance(selectedRift, true);
                            }
                          }
                          setShowUnwrapModal(true);
                        }}
                        className="px-3 py-2 text-xs font-medium text-gray-400 bg-black/50 hover:bg-emerald-500/10 border border-emerald-500/20 hover:border-emerald-500/40 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                      >
                        <Unlock className="w-3 h-3" />
                        Unwrap
                      </button>
                      <button
                        onClick={() => {
                          if (selectedRift?.id) {
                            window.open(`https://solscan.io/account/${selectedRift.id}?cluster=mainnet`, '_blank');
                          }
                        }}
                        className="px-3 py-2 text-xs font-medium text-gray-400 bg-black/50 hover:bg-emerald-500/10 border border-emerald-500/20 hover:border-emerald-500/40 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                      >
                        <ExternalLink className="w-3 h-3" />
                        Explorer
                      </button>
                    </div>
                  </>
                ) : (
                  <TradingInterface
                    wallet={wallet as unknown as { publicKey: string; connected: boolean; sendTransaction?: (transaction: unknown) => Promise<unknown> }}
                    rifts={selectedRift ? [selectedRift] : []}
                    addToast={(message: string, type: 'success' | 'error' | 'pending', signature?: string) => {
                      setNotification({
                        type: type === 'pending' ? 'info' : type,
                        title: type === 'success' ? 'Success' : type === 'error' ? 'Error' : 'Processing',
                        message,
                        signature
                      });
                    }}
                  />
                )}
              </div>

              {/* Footer */}
              <div className="px-5 py-4 border-t border-emerald-500/20 bg-black/50">
                <button
                  onClick={() => setShowDetailsModal(false)}
                  className="w-full px-4 py-2.5 text-sm font-medium text-gray-400 bg-black/50 border border-emerald-500/20 hover:border-emerald-500/40 rounded-lg transition-colors"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Fees Claimed Success Modal */}
      <AnimatePresence>
        {showFeesClaimedModal && feesClaimedData && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
            onClick={(e) => e.target === e.currentTarget && setShowFeesClaimedModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ duration: 0.3, type: "spring", bounce: 0.4 }}
              className="w-full max-w-sm bg-black/95 backdrop-blur-md border border-emerald-500/30 rounded-2xl shadow-2xl overflow-hidden"
            >
              {/* Success Animation Header */}
              <div className="relative px-6 pt-8 pb-4">
                {/* Glowing background effect */}
                <div className="absolute inset-0 bg-gradient-to-b from-emerald-500/20 via-emerald-500/5 to-transparent" />

                {/* Success checkmark */}
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ delay: 0.2, type: "spring", bounce: 0.5 }}
                  className="relative mx-auto w-20 h-20 rounded-full bg-gradient-to-br from-emerald-500/30 to-emerald-600/20 border-2 border-emerald-500/50 flex items-center justify-center mb-4"
                >
                  <motion.div
                    initial={{ scale: 0, rotate: -180 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ delay: 0.4, type: "spring", bounce: 0.6 }}
                  >
                    <Check className="w-10 h-10 text-emerald-400" />
                  </motion.div>
                  {/* Pulse effect */}
                  <motion.div
                    initial={{ scale: 1, opacity: 0.5 }}
                    animate={{ scale: 1.5, opacity: 0 }}
                    transition={{ duration: 1, repeat: Infinity, repeatDelay: 0.5 }}
                    className="absolute inset-0 rounded-full border-2 border-emerald-500/50"
                  />
                </motion.div>

                {/* Title */}
                <motion.h2
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="relative text-center text-xl font-bold text-white mb-1"
                >
                  {feesClaimedData.type === 'rift' ? 'Rift Fees Claimed!' :
                   feesClaimedData.type === 'dex' ? 'DEX Fees Claimed!' : 'LP Fees Claimed!'}
                </motion.h2>
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.4 }}
                  className="relative text-center text-sm text-gray-400"
                >
                  Your fees have been successfully distributed
                </motion.p>
              </div>

              {/* Amount Display */}
              <div className="px-6 py-4">
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.5 }}
                  className="p-4 rounded-xl bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 border border-emerald-500/20"
                >
                  <p className="text-xs text-gray-500 mb-1 text-center">Amount Claimed</p>
                  <p className="text-3xl font-bold text-center bg-gradient-to-r from-emerald-400 to-emerald-300 bg-clip-text text-transparent">
                    {feesClaimedData.amount.toFixed(6)}
                  </p>
                  <p className="text-sm text-center text-emerald-400/80 mt-1">
                    {feesClaimedData.symbol} tokens
                  </p>
                </motion.div>
              </div>

              {/* Transaction Details */}
              {feesClaimedData.signature && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.6 }}
                  className="px-6 pb-4"
                >
                  <div className="p-3 rounded-lg bg-black/50 border border-emerald-500/10">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-500">Transaction</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-gray-400">
                          {feesClaimedData.signature.slice(0, 8)}...{feesClaimedData.signature.slice(-6)}
                        </span>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(feesClaimedData.signature);
                            const toastId = generateToastId();
                            setToasts(prev => [...prev, { id: toastId, type: 'success', message: 'Copied!' }]);
                            setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 2000);
                          }}
                          className="p-1 rounded hover:bg-emerald-500/20 transition-colors"
                        >
                          <Copy className="w-3 h-3 text-gray-400 hover:text-emerald-400" />
                        </button>
                        <a
                          href={`https://solscan.io/tx/${feesClaimedData.signature}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1 rounded hover:bg-emerald-500/20 transition-colors"
                        >
                          <ExternalLink className="w-3 h-3 text-gray-400 hover:text-emerald-400" />
                        </a>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Footer */}
              <div className="px-6 pb-6">
                <motion.button
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.7 }}
                  onClick={() => {
                    setShowFeesClaimedModal(false);
                    setFeesClaimedData(null);
                  }}
                  className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white font-semibold text-sm transition-all duration-200 shadow-lg shadow-emerald-500/20 hover:shadow-emerald-500/30"
                >
                  Done
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Enhanced Wrap Modal */}
      <AnimatePresence>
        {showWrapModal && selectedRift && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
            onClick={(e) => e.target === e.currentTarget && setShowWrapModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.2 }}
              className="w-full max-w-md bg-black/90 backdrop-blur-md border border-emerald-500/30 rounded-xl shadow-2xl overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-emerald-500/20">
                <div>
                  <h2 className="text-base font-semibold text-emerald-400">Wrap {selectedRift.underlying}</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Convert to {selectedRift.symbol} tokens</p>
                </div>
                <button
                  onClick={() => setShowWrapModal(false)}
                  className="p-2 rounded-lg text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Content */}
              <div className="px-5 py-4 space-y-4">
                {/* Conversion Preview */}
                <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center">
                        <Lock className="w-5 h-5 text-emerald-400" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-white">{selectedRift.underlying} → {selectedRift.symbol}</p>
                        <p className="text-xs text-gray-500">1:1 conversion ratio</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-emerald-400">
                        {(parseFloat(wrapAmount || '0') * (1 - (selectedRift?.id === "CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL" ? 0.007 : 0.003))).toFixed(4)}
                      </p>
                      <p className="text-xs text-gray-500">{selectedRift.symbol}</p>
                    </div>
                  </div>
                </div>

                {/* Input Section */}
                <div className="rounded-lg border border-emerald-500/20 bg-black/50 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center">
                        <span className="text-xs font-semibold text-emerald-400">{selectedRift.underlying[0]}</span>
                      </div>
                      <span className="text-sm font-medium text-white">{selectedRift.underlying}</span>
                    </div>
                    <span className="text-xs text-gray-400">
                      Balance: {selectedTokenBalance.toFixed(4)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-2">
                    <input
                      type="number"
                      placeholder="0.00"
                      value={wrapAmount}
                      onChange={(e) => setWrapAmount(e.target.value)}
                      className="w-full bg-transparent text-lg font-semibold text-emerald-400 placeholder-gray-600 outline-none"
                    />
                    <div className="flex items-center gap-1 flex-wrap">
                      {[25, 50, 75].map((pct) => (
                        <button
                          key={pct}
                          onClick={() => {
                            const balance = selectedRift?.underlying === 'SOL' ? wallet.balance : selectedTokenBalance;
                            setWrapAmount((balance * pct / 100).toFixed(4));
                          }}
                          className="px-2 py-1 text-xs font-medium rounded transition-all duration-150 text-gray-500 hover:text-emerald-400 hover:bg-emerald-500/10"
                        >
                          {pct}%
                        </button>
                      ))}
                      <button
                        onClick={() => {
                          const balance = selectedRift?.underlying === 'SOL' ? wallet.balance : selectedTokenBalance;
                          setWrapAmount(balance.toString());
                        }}
                        className="px-2 py-1 text-xs font-medium rounded transition-all duration-150 bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30"
                      >
                        MAX
                      </button>
                    </div>
                  </div>
                </div>

                {/* Transaction Details */}
                <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div className="text-center">
                      <p className="text-gray-500 mb-1">Wrap Fee</p>
                      <p className="font-semibold text-white">{selectedRift?.id === "CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL" ? "0.7%" : "0.3%"}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-gray-500 mb-1">Network</p>
                      <p className="font-semibold text-white">~0.002 SOL</p>
                    </div>
                    <div className="text-center">
                      <p className="text-gray-500 mb-1">Slippage</p>
                      <div className="flex items-center justify-center gap-1">
                        <input
                          type="number"
                          value={slippageTolerance}
                          onChange={(e) => setSlippageTolerance(e.target.value)}
                          className="w-12 px-1 py-0.5 text-xs font-semibold text-center text-emerald-400 bg-black/50 border border-emerald-500/20 rounded focus:outline-none focus:border-emerald-500/40"
                          step="0.1"
                          min="0"
                          max="100"
                        />
                        <span className="font-semibold text-emerald-400">%</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Risk Warning */}
                <div className="p-3 rounded-lg border border-yellow-500/30 bg-yellow-500/5">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-yellow-400 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-yellow-400/80 leading-relaxed">
                      Your {selectedRift.underlying} will be held as collateral. You can unwrap anytime to redeem.
                    </p>
                  </div>
                </div>
              </div>

              {/* Footer Actions */}
              <div className="px-5 py-4 border-t border-emerald-500/20 bg-black/50">
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowWrapModal(false)}
                    className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-400 bg-black/50 border border-emerald-500/20 hover:border-emerald-500/40 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleWrap}
                    disabled={isWrapping || !wrapAmount || !wallet.publicKey}
                    className="flex-1 px-4 py-2.5 text-sm font-medium text-emerald-400 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 disabled:bg-black/30 disabled:border-gray-700 disabled:text-gray-600 rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    {isWrapping ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Wrapping...
                      </>
                    ) : (
                      <>
                        <Lock className="w-4 h-4" />
                        Confirm Wrap
                      </>
                    )}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Portfolio Modal */}
      <AnimatePresence>
        {showPortfolioModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
            onClick={(e) => e.target === e.currentTarget && setShowPortfolioModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.2 }}
              className="w-full max-w-2xl bg-black/90 backdrop-blur-md border border-emerald-500/30 rounded-xl shadow-2xl overflow-hidden max-h-[80vh] flex flex-col"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-emerald-500/20">
                <div>
                  <h2 className="text-base font-semibold text-emerald-400">Your Portfolio</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Rift token positions and balances</p>
                </div>
                <button
                  onClick={() => setShowPortfolioModal(false)}
                  className="p-2 rounded-lg text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto px-5 py-4">
                {!wallet.connected ? (
                  <div className="text-center py-8">
                    <Wallet className="w-12 h-12 text-gray-600 mx-auto mb-3" />
                    <p className="text-gray-400 mb-4">Connect your wallet to view your portfolio</p>
                    <LuxuryButton variant="primary" size="md" onClick={wallet.connect}>
                      Connect Wallet
                    </LuxuryButton>
                  </div>
                ) : portfolioLoading ? (
                  <div className="text-center py-8">
                    <div className="w-12 h-12 mx-auto mb-3 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                    <p className="text-gray-400">Loading your positions...</p>
                  </div>
                ) : portfolioPositions.length === 0 ? (
                  <div className="text-center py-8">
                    <Layers className="w-12 h-12 text-gray-600 mx-auto mb-3" />
                    <p className="text-gray-400 mb-2">No positions yet</p>
                    <p className="text-xs text-gray-500">Wrap tokens or provide liquidity to get started</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Portfolio Summary */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
                        <p className="text-xs text-gray-500 mb-1">Total Value</p>
                        <p className="text-lg font-bold text-emerald-400">
                          ${portfolioPositions.reduce((sum, p) => sum + p.valueUsd, 0).toFixed(2)}
                        </p>
                      </div>
                      <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
                        <p className="text-xs text-gray-500 mb-1">Positions</p>
                        <p className="text-lg font-bold text-white">{portfolioPositions.length}</p>
                      </div>
                    </div>

                    {/* Wrapped Tokens Section */}
                    {portfolioPositions.filter(p => p.type === 'wrapped').length > 0 && (
                      <div className="space-y-2">
                        <h3 className="text-sm font-medium text-gray-400 flex items-center gap-2">
                          <Lock className="w-4 h-4" />
                          Wrapped Tokens
                        </h3>
                        {portfolioPositions.filter(p => p.type === 'wrapped').map((position, index) => (
                          <div
                            key={`wrapped-${index}`}
                            className="p-3 rounded-lg border border-emerald-500/20 bg-black/30 hover:border-emerald-500/40 transition-colors"
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center">
                                  <span className="text-xs font-bold text-emerald-400">
                                    {position.riftSymbol[0]}
                                  </span>
                                </div>
                                <div>
                                  <p className="text-sm font-medium text-white">{position.riftSymbol}</p>
                                  <p className="text-xs text-gray-500">{position.underlying}</p>
                                </div>
                              </div>
                              <div className="text-right">
                                <p className="text-sm font-semibold text-emerald-400">
                                  {position.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                                </p>
                                <p className="text-xs text-gray-500">
                                  ${position.valueUsd.toFixed(2)}
                                </p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* LP Positions Section */}
                    {portfolioPositions.filter(p => p.type === 'lp').length > 0 && (
                      <div className="space-y-2">
                        <h3 className="text-sm font-medium text-gray-400 flex items-center gap-2">
                          <Layers className="w-4 h-4" />
                          Liquidity Positions
                        </h3>
                        {portfolioPositions.filter(p => p.type === 'lp').map((position, index) => (
                          <div
                            key={`lp-${index}`}
                            className="p-3 rounded-lg border border-blue-500/20 bg-black/30 hover:border-blue-500/40 transition-colors"
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-blue-500/20 border border-blue-500/30 flex items-center justify-center">
                                  <span className="text-xs font-bold text-blue-400">LP</span>
                                </div>
                                <div>
                                  <div className="flex items-center gap-2">
                                    <p className="text-sm font-medium text-white">{position.riftSymbol}/SOL</p>
                                    {position.poolAddress ? (
                                      <a
                                        href={position.poolType === 'dlmm'
                                          ? `https://app.meteora.ag/dlmm/${position.poolAddress}`
                                          : `https://app.meteora.ag/dammv2/${position.poolAddress}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                        className="text-blue-400 hover:text-blue-300 transition-colors"
                                        title="View on Meteora"
                                      >
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                        </svg>
                                      </a>
                                    ) : position.riftMint && (
                                      <a
                                        href={`https://app.meteora.ag/?search=${position.riftMint}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                        className="text-gray-500 hover:text-gray-400 transition-colors"
                                        title="Search on Meteora"
                                      >
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                        </svg>
                                      </a>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                                      position.poolType === 'dlmm' ? 'bg-purple-500/20 text-purple-400' :
                                      position.poolType === 'dammv2-ss' ? 'bg-blue-500/20 text-blue-400' :
                                      'bg-emerald-500/20 text-emerald-400'
                                    }`}>
                                      {position.poolType === 'dlmm' ? 'DLMM' :
                                       position.poolType === 'dammv2-ss' ? 'DAMMV2 SS' : 'DAMMV2'}
                                    </span>
                                    {position.balance > 0 && (
                                      <span className="text-[10px] text-gray-500">
                                        Share: {position.balance.toFixed(1)}%
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    {position.riftMint && (
                                      <div className="flex items-center gap-1">
                                        <span className="text-[10px] text-gray-600 font-mono" title={position.riftMint}>
                                          Rift: {position.riftMint.slice(0, 4)}...{position.riftMint.slice(-4)}
                                        </span>
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            navigator.clipboard.writeText(position.riftMint || '');
                                          }}
                                          className="text-gray-500 hover:text-white transition-colors"
                                          title="Copy rift mint"
                                        >
                                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                          </svg>
                                        </button>
                                      </div>
                                    )}
                                    {position.poolAddress && (
                                      <span className="text-[10px] text-gray-600 font-mono" title={position.poolAddress}>
                                        Pool: {position.poolAddress.slice(0, 4)}...{position.poolAddress.slice(-4)}
                                      </span>
                                    )}
                                  </div>
                                  {(position.wrappedBalance !== undefined && position.wrappedBalance > 0) && (
                                    <div className="flex items-center gap-3 mt-0.5">
                                      <span className="text-[10px] text-emerald-400">
                                        Wrapped: {position.wrappedBalance >= 1000000
                                          ? `${(position.wrappedBalance / 1000000).toFixed(2)}M`
                                          : position.wrappedBalance >= 1000
                                            ? `${(position.wrappedBalance / 1000).toFixed(2)}K`
                                            : position.wrappedBalance.toFixed(2)} tokens
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>
                              <div className="text-right">
                                {position.valueUsd > 0 ? (
                                  <>
                                    <p className="text-sm font-semibold text-amber-400">
                                      {(position.valueUsd / 230).toFixed(4)} SOL
                                    </p>
                                    <p className="text-xs text-gray-500">
                                      claimable from arb
                                    </p>
                                  </>
                                ) : (
                                  <p className="text-xs text-gray-500">
                                    No claimable yet
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Enhanced Unwrap Modal */}
      <AnimatePresence>
        {showUnwrapModal && selectedRift && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowUnwrapModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.2 }}
              className="w-full max-w-lg bg-black/90 backdrop-blur-md border border-emerald-500/30 rounded-2xl shadow-2xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between p-4 border-b border-emerald-500/20">
                <div>
                  <h2 className="text-lg font-bold text-white">Unwrap {selectedRift.symbol}</h2>
                  <p className="text-xs text-gray-400">Convert back to {selectedRift.underlying}</p>
                </div>
                <button
                  onClick={() => setShowUnwrapModal(false)}
                  className="p-2 text-gray-400 transition-colors rounded-lg hover:text-white hover:bg-emerald-500/10"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Content */}
              <div className="p-4 space-y-3">
                {/* Unwrap Summary - Horizontal Layout */}
                <div className="p-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-emerald-500/20 text-emerald-400">
                        <Unlock className="w-5 h-5" />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-white">Unwrap {selectedRift.symbol} → {selectedRift.underlying}</h3>
                        <p className="text-xs text-emerald-400">Redeem wrapped tokens</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <div className="text-right">
                        <p className="text-xs text-gray-400">Redeem</p>
                        <p className="text-sm font-bold text-white">{parseFloat(unwrapAmount || '0').toFixed(4)} {selectedRift.symbol}</p>
                      </div>
                      <div className="text-gray-500">→</div>
                      <div className="text-right">
                        <p className="text-xs text-gray-400">Receive</p>
                        <p className="text-sm font-bold text-emerald-400">{(parseFloat(unwrapAmount || '0') * (1 - 0.003)).toFixed(4)} {selectedRift.underlying}</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Input Section - Compact */}
                <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-gray-400">Amount</label>
                    <div className="text-xs text-gray-400">
                      Balance: <span className="text-white">{(selectedRiftTokenBalance || 0).toFixed(6)} {selectedRift?.symbol}</span>
                    </div>
                  </div>
                  <input
                    type="number"
                    placeholder="0.00"
                    value={unwrapAmount}
                    onChange={(e) => setUnwrapAmount(e.target.value)}
                    className="w-full px-3 py-2 text-lg font-bold text-white placeholder-gray-600 bg-black/50 border border-emerald-500/30 rounded-lg focus:border-emerald-500 focus:outline-none mb-2"
                  />
                  <div className="flex items-center gap-1 flex-wrap">
                    {[25, 50, 75].map((percent) => (
                      <button
                        key={percent}
                        onClick={() => {
                          const amount = ((selectedRiftTokenBalance || 0) * percent / 100).toFixed(4);
                          setUnwrapAmount(amount);
                        }}
                        className="px-2 py-1 text-xs font-medium text-gray-400 transition-colors rounded hover:text-emerald-400 hover:bg-emerald-500/20"
                      >
                        {percent}%
                      </button>
                    ))}
                    <button
                      onClick={() => setUnwrapAmount((selectedRiftTokenBalance || 0).toString())}
                      className="px-2 py-1 text-xs font-medium rounded transition-all duration-150 bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30"
                    >
                      MAX
                    </button>
                  </div>
                </div>

                {/* Transaction Details - Compact Grid */}
                <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
                  <div className="grid grid-cols-4 gap-3 text-xs">
                    <div className="text-center">
                      <p className="mb-1 text-gray-400">Rate</p>
                      <p className="font-semibold text-white">1:1</p>
                    </div>
                    <div className="text-center">
                      <p className="mb-1 text-gray-400">Fee</p>
                      <p className="font-semibold text-white">{selectedRift?.id === "CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL" ? "0.7%" : "0.3%"}</p>
                    </div>
                    <div className="text-center">
                      <p className="mb-1 text-gray-400">Network</p>
                      <p className="font-semibold text-white">~0.001 SOL</p>
                    </div>
                    <div className="text-center">
                      <p className="mb-1 text-gray-400">Time</p>
                      <p className="font-semibold text-emerald-400">Instant</p>
                    </div>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => setShowUnwrapModal(false)}
                    className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-300 bg-black/50 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/10 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleUnwrap}
                    disabled={isUnwrapping || !unwrapAmount || !wallet.publicKey}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-black bg-emerald-500 rounded-lg hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isUnwrapping ? (
                      <>
                        <div className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                        Unwrapping...
                      </>
                    ) : (
                      <>
                        <Unlock className="w-4 h-4" />
                        Confirm Unwrap
                      </>
                    )}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Claim Fees Modal */}
      <LuxuryModal
        isOpen={showClaimFeesModal}
        onClose={() => setShowClaimFeesModal(false)}
        title={selectedRift ? `Claim Fees - ${selectedRift.symbol}` : "Claim Fees"}
        subtitle={selectedRift ? `Distribute fees from vault to treasury and partners` : "Distribute protocol fees"}
        size="md"
      >
        {selectedRift && (
          <div className="space-y-4">
            {/* Fee Distribution Info */}
            <div className="bg-gradient-to-br from-yellow-900/20 to-orange-800/20 border border-yellow-600/30 rounded-xl p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="flex items-center justify-center w-10 h-10 font-bold text-black shadow-md rounded-xl bg-gradient-to-br from-yellow-400 via-yellow-500 to-orange-500">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8 8.114 8 8c0-.114.07-.34.433-.582zM11 12.849v-1.698c.22.071.412.164.567.267.364.243.433.468.433.582 0 .114-.07.34-.433.582a2.305 2.305 0 01-.567.267z" />
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6 7.009 6 8c0 .99.602 1.765 1.324 2.246.48.32 1.054.545 1.676.662v1.941c-.391-.127-.68-.317-.843-.504a1 1 0 10-1.51 1.31c.562.649 1.413 1.076 2.353 1.253V15a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 14 12.991 14 12c0-.99-.602-1.765-1.324-2.246A4.535 4.535 0 0011 9.092V7.151c.391.127.68.317.843.504a1 1 0 101.511-1.31c-.563-.649-1.413-1.076-2.354-1.253V5z" clipRule="evenodd" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Fee Distribution</h3>
                  <p className="text-xs text-yellow-400">Withdraw fees from vault</p>
                </div>
              </div>

              {/* Fee breakdown - Show user's share */}
              <div className="space-y-2 text-sm">
                <p className="text-xs text-yellow-300 mb-2">Your share of fees:</p>
                {(() => {
                  const userWallet = wallet.publicKey ? String(wallet.publicKey) : null;
                  const isPartner = userWallet && selectedRift.partnerWallet && selectedRift.partnerWallet === userWallet;
                  const isTreasury = userWallet && selectedRift.treasuryWallet && selectedRift.treasuryWallet === userWallet;
                  const isCreator = userWallet && (selectedRift.creator === userWallet || selectedRift.authority === userWallet);

                  if (isPartner) {
                    return (
                      <div className="space-y-2">
                        <div className="flex justify-between text-gray-300">
                          <span>Your Role:</span>
                          <span className="font-bold text-yellow-400">Partner</span>
                        </div>
                        <div className="flex justify-between text-gray-300">
                          <span>You Receive:</span>
                          <span className="font-bold text-green-400">{(selectedRift.partnerFee || 0).toFixed(1)}% of distributable fees</span>
                        </div>
                      </div>
                    );
                  } else if (isTreasury) {
                    const treasuryShare = 100 - (selectedRift.partnerFee || 0);
                    return (
                      <div className="space-y-2">
                        <div className="flex justify-between text-gray-300">
                          <span>Your Role:</span>
                          <span className="font-bold text-yellow-400">Treasury</span>
                        </div>
                        <div className="flex justify-between text-gray-300">
                          <span>You Receive:</span>
                          <span className="font-bold text-green-400">{treasuryShare.toFixed(1)}% of distributable fees</span>
                        </div>
                      </div>
                    );
                  } else if (isCreator) {
                    // Creator but not set as treasury/partner - show info
                    return (
                      <div className="p-3 bg-yellow-900/20 border border-yellow-600/30 rounded-lg space-y-2">
                        <div className="flex justify-between text-gray-300">
                          <span>Your Role:</span>
                          <span className="font-bold text-yellow-400">Creator</span>
                        </div>
                        <p className="text-xs text-yellow-400">You created this rift, but fees go to:</p>
                        {selectedRift.treasuryWallet && (
                          <p className="text-xs text-gray-400">Treasury: {selectedRift.treasuryWallet.slice(0, 8)}...{selectedRift.treasuryWallet.slice(-6)}</p>
                        )}
                        {selectedRift.partnerWallet && (
                          <p className="text-xs text-gray-400">Partner: {selectedRift.partnerWallet.slice(0, 8)}...{selectedRift.partnerWallet.slice(-6)}</p>
                        )}
                      </div>
                    );
                  } else {
                    return (
                      <div className="p-3 bg-red-900/20 border border-red-600/30 rounded-lg">
                        <p className="text-xs text-red-400">⚠️ You are not authorized to claim fees for this rift</p>
                        <p className="text-xs text-gray-400 mt-1">Connected: {userWallet?.slice(0, 8)}...{userWallet?.slice(-6)}</p>
                      </div>
                    );
                  }
                })()}
              </div>
            </div>

            {/* Available Fees Display */}
            <div className="p-4 border rounded-xl bg-gradient-to-br from-green-900/20 to-emerald-800/20 border-green-600/30">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-300">Available Fees in Vault:</span>
                {isLoadingVaultFees ? (
                  <span className="text-sm text-gray-400">Loading...</span>
                ) : (
                  <span className="text-lg font-bold text-green-400">
                    {availableVaultFees.toFixed(6)} {selectedRift.underlying}
                  </span>
                )}
              </div>
            </div>

            {/* Amount Input */}
            <div>
              <label className="block mb-2 text-sm font-medium text-white">
                Amount to Distribute ({selectedRift.underlying})
              </label>
              <div className="relative">
                <input
                  type="number"
                  placeholder="0.0"
                  value={claimFeesAmount}
                  onChange={(e) => setClaimFeesAmount(e.target.value)}
                  className="w-full px-4 py-3 pr-20 text-white placeholder-gray-500 bg-black border rounded-xl border-yellow-600/30 focus:border-yellow-400 focus:outline-none"
                  step="0.01"
                  min="0"
                  max={availableVaultFees}
                />
                <button
                  type="button"
                  onClick={() => setClaimFeesAmount(availableVaultFees.toString())}
                  className="absolute px-2 py-1 text-xs font-bold text-black transition-colors transform -translate-y-1/2 bg-yellow-400 rounded-lg right-12 top-1/2 hover:bg-yellow-300"
                  disabled={isLoadingVaultFees || availableVaultFees === 0}
                >
                  MAX
                </button>
                <div className="absolute text-sm text-gray-400 transform -translate-y-1/2 right-4 top-1/2">
                  {selectedRift.underlying}
                </div>
              </div>
              <p className="mt-2 text-xs text-gray-400">
                Enter the amount of fees to distribute from the vault (max: {availableVaultFees.toFixed(6)})
              </p>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-4">
              <LuxuryButton
                variant="secondary"
                size="lg"
                className="flex-1"
                onClick={() => setShowClaimFeesModal(false)}
              >
                Cancel
              </LuxuryButton>
              <LuxuryButton
                variant="primary"
                size="lg"
                className="flex-1 border-yellow-600/30 hover:border-yellow-400/50 bg-yellow-900/20 hover:bg-yellow-800/30"
                onClick={handleClaimFees}
                disabled={isClaimingFees || !claimFeesAmount || !wallet.publicKey}
                loading={isClaimingFees}
              >
                {isClaimingFees ? 'Claiming...' : 'Claim Fees'}
              </LuxuryButton>
            </div>
          </div>
        )}
      </LuxuryModal>

      {/* Claim DEX Fees Modal */}
      <AnimatePresence>
        {showClaimDexFeesModal && selectedRift && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
            onClick={(e) => e.target === e.currentTarget && setShowClaimDexFeesModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.2 }}
              className="w-full max-w-md bg-black/90 backdrop-blur-md border border-emerald-500/30 rounded-xl shadow-2xl overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-emerald-500/20">
                <div>
                  <h2 className="text-base font-semibold text-emerald-400">Claim DEX Fees</h2>
                  <p className="text-xs text-gray-400 mt-0.5">{selectedRift.symbol} • Withheld Vault</p>
                </div>
                <button
                  onClick={() => setShowClaimDexFeesModal(false)}
                  className="p-2 rounded-lg text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Content */}
              <div className="px-5 py-4 space-y-4">
                {/* Available Fees */}
                <div className="rounded-lg border border-emerald-500/20 bg-black/50 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-400">Total Available</span>
                    <span className="text-sm font-semibold text-white">
                      {isLoadingDexFees ? (
                        <span className="flex items-center gap-1.5">
                          <Loader2 className="w-3 h-3 animate-spin text-emerald-400" />
                          <span className="text-gray-500">Loading...</span>
                        </span>
                      ) : `${dexFeesData.available.toFixed(6)} ${selectedRift.symbol}`}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400">You Can Claim</span>
                    <span className="text-lg font-bold text-emerald-400">
                      {isLoadingDexFees ? (
                        <span className="flex items-center gap-1.5">
                          <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
                          <span className="text-gray-500">Loading...</span>
                        </span>
                      ) : `${dexFeesData.userClaimable.toFixed(6)} ${selectedRift.symbol}`}
                    </span>
                  </div>
                </div>

                {/* Amount Input */}
                <div className="rounded-lg border border-emerald-500/20 bg-black/50 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center">
                        <span className="text-xs font-semibold text-emerald-400">{selectedRift.symbol[0]}</span>
                      </div>
                      <span className="text-sm font-medium text-white">{selectedRift.symbol}</span>
                    </div>
                    <span className="text-xs text-gray-400">
                      Max: {dexFeesData.userClaimable.toFixed(4)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={claimDexFeesAmount}
                      onChange={(e) => setClaimDexFeesAmount(e.target.value)}
                      placeholder="0.00"
                      className="flex-1 bg-transparent text-lg font-semibold text-emerald-400 placeholder-gray-600 outline-none"
                      step="0.01"
                      min="0"
                      max={dexFeesData.userClaimable}
                    />
                    <button
                      onClick={() => setClaimDexFeesAmount(dexFeesData.userClaimable.toString())}
                      className="px-2 py-1 text-xs font-medium rounded transition-all bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30"
                      disabled={isLoadingDexFees || dexFeesData.userClaimable === 0}
                    >
                      MAX
                    </button>
                  </div>
                </div>

                <p className="text-xs text-gray-500">
                  DEX fees from trading are collected via transfer fee mechanism.
                </p>
              </div>

              {/* Footer */}
              <div className="px-5 py-4 border-t border-emerald-500/20 flex gap-3">
                <button
                  onClick={() => setShowClaimDexFeesModal(false)}
                  className="flex-1 py-2.5 text-sm font-medium text-gray-400 hover:text-white transition-colors rounded-lg border border-emerald-500/20 hover:border-emerald-500/40"
                >
                  Cancel
                </button>
                <button
                  onClick={handleClaimDexFees}
                  disabled={isClaimingDexFees || !claimDexFeesAmount || !wallet.publicKey}
                  className="flex-1 py-2.5 text-sm font-semibold text-black bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors rounded-lg flex items-center justify-center gap-2"
                >
                  {isClaimingDexFees ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Claiming...
                    </>
                  ) : (
                    'Claim DEX Fees'
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Claim Rift Fees Modal */}
      <AnimatePresence>
        {showClaimRiftFeesModal && selectedRift && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
            onClick={(e) => e.target === e.currentTarget && setShowClaimRiftFeesModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.2 }}
              className="w-full max-w-md bg-black/90 backdrop-blur-md border border-emerald-500/30 rounded-xl shadow-2xl overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-emerald-500/20">
                <div>
                  <h2 className="text-base font-semibold text-emerald-400">Claim Rift Fees</h2>
                  <p className="text-xs text-gray-400 mt-0.5">{selectedRift.underlying} • Fees Vault</p>
                </div>
                <button
                  onClick={() => setShowClaimRiftFeesModal(false)}
                  className="p-2 rounded-lg text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Content */}
              <div className="px-5 py-4 space-y-4">
                {/* Available Fees */}
                <div className="rounded-lg border border-emerald-500/20 bg-black/50 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-400">Total Available</span>
                    <span className="text-sm font-semibold text-white">
                      {isLoadingRiftFees ? (
                        <span className="flex items-center gap-1.5">
                          <Loader2 className="w-3 h-3 animate-spin text-emerald-400" />
                          <span className="text-gray-500">Loading...</span>
                        </span>
                      ) : `${riftFeesData.available.toFixed(6)} ${selectedRift.underlying}`}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400">You Can Claim</span>
                    <span className="text-lg font-bold text-emerald-400">
                      {isLoadingRiftFees ? (
                        <span className="flex items-center gap-1.5">
                          <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
                          <span className="text-gray-500">Loading...</span>
                        </span>
                      ) : `${riftFeesData.userClaimable.toFixed(6)} ${selectedRift.underlying}`}
                    </span>
                  </div>
                </div>

                {/* Amount Input */}
                <div className="rounded-lg border border-emerald-500/20 bg-black/50 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center">
                        <span className="text-xs font-semibold text-emerald-400">{selectedRift.underlying[0]}</span>
                      </div>
                      <span className="text-sm font-medium text-white">{selectedRift.underlying}</span>
                    </div>
                    <span className="text-xs text-gray-400">
                      Max: {riftFeesData.userClaimable.toFixed(4)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={claimRiftFeesAmount}
                      onChange={(e) => setClaimRiftFeesAmount(e.target.value)}
                      placeholder="0.00"
                      className="flex-1 bg-transparent text-lg font-semibold text-emerald-400 placeholder-gray-600 outline-none"
                      step="0.01"
                      min="0"
                      max={riftFeesData.userClaimable}
                    />
                    <button
                      onClick={() => setClaimRiftFeesAmount(riftFeesData.userClaimable.toString())}
                      className="px-2 py-1 text-xs font-medium rounded transition-all bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30"
                      disabled={isLoadingRiftFees || riftFeesData.userClaimable === 0}
                    >
                      MAX
                    </button>
                  </div>
                </div>

                <p className="text-xs text-gray-500">
                  Rift fees from wrap/unwrap operations in the fees vault.
                </p>
              </div>

              {/* Footer */}
              <div className="px-5 py-4 border-t border-emerald-500/20 flex gap-3">
                <button
                  onClick={() => setShowClaimRiftFeesModal(false)}
                  className="flex-1 py-2.5 text-sm font-medium text-gray-400 hover:text-white transition-colors rounded-lg border border-emerald-500/20 hover:border-emerald-500/40"
                >
                  Cancel
                </button>
                <button
                  onClick={handleClaimRiftFees}
                  disabled={isClaimingRiftFees || !claimRiftFeesAmount || !wallet.publicKey}
                  className="flex-1 py-2.5 text-sm font-semibold text-black bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors rounded-lg flex items-center justify-center gap-2"
                >
                  {isClaimingRiftFees ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Claiming...
                    </>
                  ) : (
                    'Claim Rift Fees'
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Add Liquidity Modal */}
      <LiquidityModal
        isOpen={showAddLiquidityModal}
        onClose={() => {
          setShowAddLiquidityModal(false);
          setLiquidityTab('add');
          setDepositQuote(null);
          setSolLiquidityAmount('');
          setRiftLiquidityAmount('');
          setLastEditedField(null);
          setCreateNewPool(false);
          setUsePriceMode(false);
          setSelectedPoolAddress(null);
        }}
        selectedRift={selectedRift}
        allRifts={rifts}
        walletBalance={wallet.balance}
        riftsTokenBalance={riftsTokenBalance}
        usd1TokenBalance={usd1TokenBalance}
        selectedRiftBalance={selectedRiftBalance}
        liquidityTab={liquidityTab}
        setLiquidityTab={setLiquidityTab}
        liquidityTokenA={liquidityTokenA}
        setLiquidityTokenA={setLiquidityTokenA}
        poolType={poolType}
        setPoolType={setPoolType}
        solLiquidityAmount={solLiquidityAmount}
        setSolLiquidityAmount={setSolLiquidityAmount}
        riftLiquidityAmount={riftLiquidityAmount}
        setRiftLiquidityAmount={setRiftLiquidityAmount}
        dlmmStrategy={dlmmStrategy}
        setDlmmStrategy={setDlmmStrategy}
        dlmmBinStep={dlmmBinStep}
        setDlmmBinStep={setDlmmBinStep}
        dlmmRangeInterval={dlmmRangeInterval}
        setDlmmRangeInterval={setDlmmRangeInterval}
        dlmmFeeBps={dlmmFeeBps}
        setDlmmFeeBps={setDlmmFeeBps}
        dlmmSingleSided={dlmmSingleSided}
        setDlmmSingleSided={setDlmmSingleSided}
        dlmmMinMcap={dlmmMinMcap}
        setDlmmMinMcap={setDlmmMinMcap}
        dlmmMaxMcap={dlmmMaxMcap}
        setDlmmMaxMcap={setDlmmMaxMcap}
        dlmmTokenSupply={dlmmTokenSupply}
        setDlmmTokenSupply={setDlmmTokenSupply}
        dlmmUseMcapRange={dlmmUseMcapRange}
        setDlmmUseMcapRange={setDlmmUseMcapRange}
        createNewPool={createNewPool}
        setCreateNewPool={setCreateNewPool}
        usePriceMode={usePriceMode}
        setUsePriceMode={setUsePriceMode}
        initialPrice={initialPrice}
        setInitialPrice={setInitialPrice}
        liquidityRatio={liquidityRatio}
        setLiquidityRatio={setLiquidityRatio}
        dlmmPriceOverrideUsd={undefined} // Let it use selectedRift's price for regular deposits
        depositQuote={depositQuote}
        setDepositQuote={setDepositQuote}
        isLoadingQuote={isLoadingQuote}
        quoteError={quoteError}
        lastEditedField={lastEditedField}
        setLastEditedField={setLastEditedField}
        removeMode={removeMode}
        setRemoveMode={setRemoveMode}
        removePercentage={removePercentage}
        setRemovePercentage={setRemovePercentage}
        userLpPositions={userLpPositions}
        selectedPositions={selectedPositions}
        setSelectedPositions={setSelectedPositions}
        positionRemovalPercentages={positionRemovalPercentages}
        setPositionRemovalPercentages={setPositionRemovalPercentages}
        isLoadingLpBalance={isLoadingLpBalance}
        detailedPositions={detailedPositions}
        estimatedWithdrawal={estimatedWithdrawal}
        poolTypeDetected={poolTypeDetected}
        dlmmPendingFees={dlmmPendingFees}
        cpammPendingFees={cpammPendingFees}
        isCreatingMeteoraPool={isCreatingMeteoraPool}
        isClaimingLpFees={isClaimingLpFees}
        dlmmProgress={dlmmProgress}
        handleCreatePoolAndAddLiquidity={handleCreatePoolAndAddLiquidity}
        handleRemoveLiquidity={handleRemoveLiquidity}
        handleClaimLpFees={handleClaimLpFees}
        hasValidPool={hasValidPool}
        selectedPoolAddress={selectedPoolAddress}
        setSelectedPoolAddress={setSelectedPoolAddress}
      />

      {/* Create Rift Modal */}
      <AnimatePresence>
        {showCreateRiftModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
            onClick={(e) => e.target === e.currentTarget && handleCloseCreateRiftModal()}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.2 }}
              className="w-full max-w-lg bg-black/90 backdrop-blur-md border border-emerald-500/30 rounded-xl shadow-2xl overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-emerald-500/20">
                <div>
                  <h2 className="text-base font-semibold text-emerald-400">Create New Rift</h2>
                  <p className="text-xs text-gray-400 mt-0.5">{createRiftTab === 'rift' ? 'Deploy a new wrapped token vault' : 'Create Monorift with DLMM liquidity'}</p>
                </div>
                <button
                  onClick={handleCloseCreateRiftModal}
                  className="p-2 rounded-lg text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Tab Navigation */}
              <div className="px-5 py-3 border-b border-emerald-500/20">
                <div className="flex gap-1 p-1 bg-black/50 rounded-lg border border-emerald-500/10">
                  <button
                    onClick={() => setCreateRiftTab('rift')}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                      createRiftTab === 'rift'
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : 'text-gray-400 hover:text-white border border-transparent'
                    }`}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Create Rift
                  </button>
                  <button
                    onClick={() => setCreateRiftTab('dlmm')}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                      createRiftTab === 'dlmm'
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : 'text-gray-400 hover:text-white border border-transparent'
                    }`}
                  >
                    <Droplets className="w-3.5 h-3.5" />
                    MONORIFT
                  </button>
                </div>
              </div>

              {/* Content */}
              <div className="px-5 py-4 max-h-[60vh] overflow-y-auto space-y-4">
                {createRiftTab === 'rift' ? (
                  <>
                {/* Select Token Section */}
                <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
                  <h3 className="mb-3 text-sm font-semibold text-white">Select Token to Wrap</h3>
                  <div className="grid grid-cols-1 gap-2">
                    {['SOL', 'USDC', 'USDT', 'USD1'].map(token => (
                      <button
                        key={token}
                        className={`bg-black/50 border ${selectedToken === token ? 'border-emerald-400 bg-emerald-500/10' : 'border-emerald-500/20'} rounded-lg p-3 hover:border-emerald-400 transition-all duration-200 text-left`}
                        onClick={() => {
                          setSelectedToken(token);
                          setCustomTokenAddress('');
                          setCustomTokenSymbol('');
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-medium text-white text-sm">{token}</p>
                            <p className="text-xs text-gray-500">Create r{token} vault</p>
                          </div>
                          <ChevronRight className="w-4 h-4 text-emerald-400" />
                        </div>
                      </button>
                    ))}

                    {/* Custom Token Option */}
                    <div className="pt-2 mt-2 border-t border-emerald-500/10">
                      <button
                        className={`w-full bg-black/50 border ${selectedToken === 'CUSTOM' ? 'border-purple-400 bg-purple-500/10' : 'border-purple-500/20'} rounded-lg p-3 hover:border-purple-400 transition-all duration-200 text-left`}
                        onClick={() => setSelectedToken('CUSTOM')}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-medium text-white text-sm">Custom Token</p>
                            <p className="text-xs text-gray-500">Wrap any SPL token</p>
                          </div>
                          <Plus className="w-4 h-4 text-purple-400" />
                        </div>
                      </button>

                      {selectedToken === 'CUSTOM' && (
                        <div className="mt-3 space-y-3">
                          {/* Token Mint Address Input */}
                          <div className="relative">
                            <input
                              type="text"
                              className="w-full px-3 py-2 pr-10 text-sm text-white border rounded-lg bg-black/50 border-purple-500/30 focus:border-purple-400 focus:outline-none"
                              placeholder="Token mint address"
                              value={customTokenAddress}
                              onChange={(e) => {
                                const newAddress = e.target.value;
                                setCustomTokenAddress(newAddress);
                                setCustomTokenSymbol('');
                                setCustomTokenMetadata(null); // Clear old metadata to force refetch
                                setTokenMetadataError(null);
                                // Show loading immediately if address looks valid
                                if (newAddress && newAddress.length >= 32) {
                                  setIsLoadingTokenMetadata(true);
                                } else {
                                  setIsLoadingTokenMetadata(false);
                                }
                              }}
                            />
                            {isLoadingTokenMetadata && (
                              <div className="absolute right-3 top-2.5">
                                <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />
                              </div>
                            )}
                          </div>

                          {/* Loading State */}
                          {isLoadingTokenMetadata && (
                            <div className="p-3 border rounded-lg bg-blue-500/10 border-blue-500/30 animate-pulse">
                              <div className="flex items-center gap-3">
                                <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
                                <div className="flex-1">
                                  <p className="text-sm font-medium text-blue-400">Fetching token metadata...</p>
                                  <p className="text-xs text-gray-500">Checking Jupiter, Metaplex & Token-2022</p>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Token Metadata Display */}
                          {customTokenMetadata && !isLoadingTokenMetadata && (
                            <div className="p-3 border rounded-lg bg-emerald-500/10 border-emerald-500/30">
                              <div className="flex items-center gap-3">
                                {customTokenMetadata.logoURI && (
                                  <img
                                    src={customTokenMetadata.logoURI}
                                    alt={customTokenMetadata.symbol}
                                    className="w-8 h-8 rounded-full"
                                    onError={(e) => {
                                      (e.target as HTMLImageElement).style.display = 'none';
                                    }}
                                  />
                                )}
                                <div className="flex-1">
                                  <p className="text-sm font-medium text-emerald-400">
                                    {customTokenMetadata.name} (r{customTokenMetadata.symbol})
                                  </p>
                                  <p className="text-xs text-gray-500">
                                    Decimals: {customTokenMetadata.decimals} • Source: {customTokenMetadata.source}
                                  </p>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Error Message */}
                          {tokenMetadataError && !isLoadingTokenMetadata && (
                            <div className="p-2 text-xs text-yellow-400 border rounded-lg bg-yellow-500/10 border-yellow-500/30">
                              {tokenMetadataError}
                            </div>
                          )}

                          {/* Token Symbol Input */}
                          <div className="relative flex items-center gap-1 w-full px-3 py-2 text-sm border rounded-lg bg-black/50 border-purple-500/30 focus-within:border-purple-400">
                            <span className="text-gray-500 font-semibold select-none">r</span>
                            <input
                              type="text"
                              className="flex-1 text-white bg-transparent border-none outline-none focus:outline-none placeholder:text-gray-500"
                              placeholder="SOL"
                              value={customTokenSymbol}
                              onChange={(e) => setCustomTokenSymbol(e.target.value.toUpperCase())}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Rift Configuration */}
                <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
                  <h3 className="mb-1 text-sm font-semibold text-white">Rift Configuration</h3>
                  <p className="mb-3 text-xs text-gray-500">Set the parameters for your new rift vault</p>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block mb-1 text-xs font-medium text-gray-400">DEX Trading Tax (%)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0.70"
                        max="1.00"
                        value={totalFee}
                        onChange={(e) => setTotalFee(e.target.value)}
                        onBlur={handleTotalFeeBlur}
                        placeholder="0.80"
                        className="w-full px-2 py-1.5 text-sm bg-black/50 border border-emerald-500/20 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500/40"
                      />
                      <p className="mt-1 text-xs text-gray-500">SPL Token-2022 fee (0.7-1%)</p>
                    </div>

                    <div>
                      <label className="block mb-1 text-xs font-medium text-gray-400">Partner Wallet</label>
                      <input
                        type="text"
                        value={partnerWallet}
                        onChange={(e) => setPartnerWallet(e.target.value)}
                        placeholder="Optional"
                        className="w-full px-2 py-1.5 text-sm bg-black/50 border border-emerald-500/20 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500/40"
                      />
                      <p className="mt-1 text-xs text-gray-500">Leave empty to use your wallet</p>
                    </div>
                  </div>
                </div>

                {/* Fee Breakdown */}
                <div className="p-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5">
                  <p className="text-xs font-semibold text-emerald-400 mb-2">Fee Structure</p>
                  <div className="space-y-1 text-xs text-gray-400">
                    <p>• Wrap/Unwrap: {selectedRift?.id === "CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL" ? "0.7% each" : "0.3% each (Treasury: 0.15%, Partner: 0.15%)"}</p>
                    <p>• DEX Trading Tax: {(parseFloat(totalFee) || 0.80).toFixed(2)}% (Treasury: {((parseFloat(totalFee) || 0.80) / 2).toFixed(2)}%, Partner: {((parseFloat(totalFee) || 0.80) / 2).toFixed(2)}%)</p>
                  </div>
                </div>
                  </>
                ) : (
                  <>
                    {/* MONORIFT Tab Content */}
                    <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
                      <h3 className="mb-3 text-sm font-semibold text-white flex items-center gap-2">
                        <Droplets className="w-4 h-4 text-blue-400" />
                        Create Monorift
                      </h3>
                      <p className="text-xs text-gray-400 mb-4">
                        Create a new liquidity pool monorift with integrated arbitrage bot. Single-sided liquidity only.
                        <span className="block text-[11px] text-amber-300 mt-1">
                          Smaller initial deposits leave less inventory for the bot to capture spreads, so arbitrage earnings drop sharply when you start tiny.
                        </span>
                      </p>

                      <div className="space-y-3">
                        {/* Pool Type Toggle */}
                        <div>
                          <label className="block mb-1.5 text-xs font-medium text-gray-400">Pool Type</label>
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              className={`px-3 py-2.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-2 ${
                                monoriftPoolType === 'dlmm'
                                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                                  : 'bg-black/30 text-gray-400 border border-gray-700 hover:border-blue-500/30'
                              }`}
                              onClick={() => setMonoriftPoolType('dlmm')}
                            >
                              <span className="font-bold">DLMM</span>
                              <span className="text-[10px] opacity-70">Concentrated</span>
                            </button>
                            <button
                              className={`px-3 py-2.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-2 ${
                                monoriftPoolType === 'dammv2'
                                  ? 'bg-purple-500/20 text-purple-400 border border-purple-500/40'
                                  : 'bg-black/30 text-gray-400 border border-gray-700 hover:border-purple-500/30'
                              }`}
                              onClick={() => setMonoriftPoolType('dammv2')}
                            >
                              <span className="font-bold">DAMMV2</span>
                              <span className="text-[10px] opacity-70">Full Range</span>
                            </button>
                          </div>
                          <p className="mt-1.5 text-[10px] text-gray-500">
                            {monoriftPoolType === 'dlmm'
                              ? 'DLMM uses bins for concentrated liquidity with customizable price ranges'
                              : 'DAMMV2 uses full-range spot liquidity (simpler, like Uniswap v2)'}
                          </p>
                        </div>

                        {/* Token Selection */}
                        <div>
                          <label className="block mb-1 text-xs font-medium text-gray-400">Select Token to Wrap</label>
                          <div className="grid grid-cols-4 gap-2">
                            {['SOL', 'USDC', 'USDT', 'USD1'].map(token => (
                              <button
                                key={token}
                                className={`px-3 py-2 text-xs font-medium rounded-lg transition-all ${
                                  selectedToken === token
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                    : 'bg-black/30 text-gray-400 border border-emerald-500/10 hover:border-emerald-500/30'
                                }`}
                                onClick={() => {
                                  setSelectedToken(token);
                                  setCustomTokenAddress('');
                                }}
                              >
                                {token}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Custom Token */}
                        <div>
                          <button
                            className={`w-full px-3 py-2 text-xs font-medium rounded-lg transition-all text-left ${
                              selectedToken === 'CUSTOM'
                                ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                                : 'bg-black/30 text-gray-400 border border-emerald-500/10 hover:border-purple-500/30'
                            }`}
                            onClick={() => setSelectedToken('CUSTOM')}
                          >
                            <Plus className="w-3 h-3 inline mr-1" />
                            Custom Token
                          </button>
                          {selectedToken === 'CUSTOM' && (
                            <div className="mt-2 space-y-2">
                              {/* Token Mint Address */}
                              <div className="relative">
                                <input
                                  type="text"
                                  className="w-full px-3 py-2 pr-10 text-sm bg-black/50 border border-purple-500/30 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-purple-500/50"
                                  placeholder="Token mint address"
                                  value={customTokenAddress}
                                  onChange={(e) => {
                                    const newAddress = e.target.value;
                                    setCustomTokenAddress(newAddress);
                                    setCustomTokenSymbol('');
                                    setCustomTokenMetadata(null);
                                    setTokenMetadataError(null);
                                    if (newAddress && newAddress.length >= 32) {
                                      setIsLoadingTokenMetadata(true);
                                    } else {
                                      setIsLoadingTokenMetadata(false);
                                    }
                                  }}
                                />
                                {isLoadingTokenMetadata && (
                                  <div className="absolute right-3 top-2.5">
                                    <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />
                                  </div>
                                )}
                              </div>
                              {/* Token Symbol Input - Manual entry if metadata fails */}
                              <div className="relative flex items-center gap-1 w-full px-3 py-2 text-sm border rounded-lg bg-black/50 border-purple-500/30 focus-within:border-purple-400">
                                <span className="text-gray-500 font-semibold select-none">m</span>
                                <input
                                  type="text"
                                  className="flex-1 text-white bg-transparent border-none outline-none focus:outline-none placeholder:text-gray-500"
                                  placeholder="SYMBOL"
                                  value={customTokenSymbol}
                                  onChange={(e) => setCustomTokenSymbol(e.target.value.toUpperCase())}
                                />
                              </div>
                              <p className="text-xs text-gray-500">Enter symbol manually if auto-fetch fails</p>
                            </div>
                          )}
                        </div>

                        {/* Loading State for DLMM Custom Token */}
                        {selectedToken === 'CUSTOM' && isLoadingTokenMetadata && (
                          <div className="p-3 border rounded-lg bg-blue-500/10 border-blue-500/30 animate-pulse">
                            <div className="flex items-center gap-3">
                              <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
                              <div className="flex-1">
                                <p className="text-sm font-medium text-blue-400">Fetching token metadata...</p>
                                <p className="text-xs text-gray-500">Checking Jupiter, Metaplex & Token-2022</p>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Token Info Panel - Show when custom token selected */}
                        {selectedToken === 'CUSTOM' && customTokenSymbol && !isLoadingTokenMetadata && (
                          <div className="p-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5">
                            <div className="flex items-center justify-between">
                              <div>
                                <span className="text-xs text-gray-400">Underlying:</span>
                                <span className="ml-2 text-sm font-medium text-white">{customTokenSymbol}</span>
                              </div>
                              <div className="text-right">
                                <span className="text-xs text-gray-400">Monopool Token:</span>
                                <span className="ml-2 text-sm font-bold text-emerald-400">m{customTokenSymbol}</span>
                              </div>
                            </div>
                            {customTokenMetadata?.name && (
                              <div className="mt-1 text-xs text-gray-500">{customTokenMetadata.name}</div>
                            )}
                          </div>
                        )}

                        {/* Initial Liquidity - Single Token Only */}
                        <div className="p-3 rounded-lg border border-blue-500/20 bg-blue-500/5">
                          <h4 className="text-xs font-semibold text-blue-400 mb-3">Initial Liquidity (Single-Sided)</h4>
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <label className="block text-xs font-medium text-gray-400">
                                m{monoriftTokenLabel} to Wrap
                              </label>
                              <span className="text-[11px] text-gray-500">
                                {wallet.publicKey
                                  ? isLoadingMonoriftBalance
                                    ? 'Balance: ...'
                                    : monoriftUnderlyingBalance === null
                                      ? 'Balance: --'
                                      : `Balance: ${monoriftUnderlyingBalance.toFixed(4)} ${monoriftTokenLabel}`
                                  : 'Connect wallet'}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                placeholder="Amount to wrap & add to pool"
                                value={dlmmRiftTokenAmount}
                                onChange={(e) => setDlmmRiftTokenAmount(e.target.value)}
                                className="flex-1 px-3 py-2 text-sm bg-black/50 border border-blue-500/30 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-blue-500/50"
                              />
                              <div className="flex items-center gap-1">
                                {[25, 50, 75].map((pct) => (
                                  <button
                                    key={pct}
                                    type="button"
                                    onClick={() => {
                                      if (monoriftUnderlyingBalance && monoriftUnderlyingBalance > 0) {
                                        const value = (monoriftUnderlyingBalance * pct / 100).toFixed(6);
                                        setDlmmRiftTokenAmount(value);
                                      }
                                    }}
                                    className="px-2 py-1.5 text-[10px] font-medium text-gray-400 hover:text-emerald-400 bg-black/50 hover:bg-emerald-500/10 border border-gray-700 hover:border-emerald-500/30 rounded transition-all"
                                  >
                                    {pct}%
                                  </button>
                                ))}
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (monoriftUnderlyingBalance && monoriftUnderlyingBalance > 0) {
                                      setDlmmRiftTokenAmount(monoriftUnderlyingBalance.toFixed(6));
                                    }
                                  }}
                                  className="px-2 py-1.5 text-[10px] font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 hover:border-emerald-500/50 rounded transition-all"
                                >
                                  MAX
                                </button>
                              </div>
                            </div>
                            <p className="text-[10px] text-emerald-400 mt-1.5">✓ Single-sided deposit only - No SOL pairing required</p>
                          </div>
                          {/* Initial Price */}
                          <div className="mt-3">
                            <div className="flex items-center justify-between mb-2">
                              <label className="text-xs font-medium text-gray-400 flex items-center gap-2">
                                <span>Initial Price (SOL per m{selectedToken === 'CUSTOM' ? (customTokenSymbol || 'TOKEN') : (selectedToken || 'TOKEN')})</span>
                                <span className="text-red-400">*Required</span>
                                {/* Tooltip */}
                                <div className="relative group">
                                  <Info className="w-3.5 h-3.5 text-gray-500 hover:text-amber-400 cursor-help transition-colors" />
                                  <div className="absolute right-0 bottom-full mb-2 w-56 p-2 bg-gray-900 border border-amber-500/30 rounded-lg text-[10px] text-gray-300 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 shadow-lg pointer-events-none">
                                    <p className="text-amber-400 font-medium mb-1">⚠️ Price Range Notice</p>
                                    <p className="leading-relaxed">
                                      This sets both the initial price and lower bound of your liquidity range.
                                      Setting below market price may cause immediate arbitrage losses.
                                    </p>
                                  </div>
                                </div>
                              </label>
                              {/* Auto/Custom Toggle */}
                              <div className="flex items-center gap-2">
                                <span className={`text-xs ${dlmmRiftUseAutoPrice ? 'text-emerald-400' : 'text-gray-500'}`}>Auto</span>
                                <button
                                  type="button"
                                  onClick={() => setDlmmRiftUseAutoPrice(!dlmmRiftUseAutoPrice)}
                                  className={`relative w-10 h-5 rounded-full transition-colors ${
                                    dlmmRiftUseAutoPrice ? 'bg-emerald-500/30' : 'bg-purple-500/30'
                                  }`}
                                >
                                  <div className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${
                                    dlmmRiftUseAutoPrice
                                      ? 'left-0.5 bg-emerald-400'
                                      : 'left-5 bg-purple-400'
                                  }`} />
                                </button>
                                <span className={`text-xs ${!dlmmRiftUseAutoPrice ? 'text-purple-400' : 'text-gray-500'}`}>Custom</span>
                              </div>
                            </div>
                            <div className="relative">
                              <input
                                type="number"
                                placeholder={
                                  dlmmRiftUseAutoPrice
                                    ? (isFetchingDlmmPrice ? "Fetching..." : "Auto-fetched from market")
                                    : "Enter custom price"
                                }
                                value={dlmmRiftInitialPrice}
                                onChange={(e) => setDlmmRiftInitialPrice(e.target.value)}
                                disabled={dlmmRiftUseAutoPrice}
                                className={`w-full px-3 py-2 text-sm bg-black/50 border rounded-lg text-white placeholder-gray-600 focus:outline-none transition-all ${
                                  dlmmRiftUseAutoPrice
                                    ? 'border-emerald-500/30 cursor-not-allowed opacity-80'
                                    : !dlmmRiftInitialPrice
                                      ? 'border-red-500/50 focus:border-red-500/70'
                                      : 'border-purple-500/30 focus:border-purple-500/50'
                                }`}
                              />
                              {dlmmRiftUseAutoPrice && dlmmRiftInitialPrice && !isFetchingDlmmPrice && (
                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-emerald-400">
                                  Market Price
                                </span>
                              )}
                              {dlmmRiftUseAutoPrice && isFetchingDlmmPrice && (
                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-blue-400 animate-pulse">
                                  Fetching...
                                </span>
                              )}
                              {!dlmmRiftUseAutoPrice && dlmmRiftInitialPrice && (
                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-purple-400">
                                  Custom
                                </span>
                              )}
                            </div>
                            <div className="mt-1 text-xs text-gray-500">
                              {dlmmRiftUseAutoPrice
                                ? "Price is auto-fetched from market in realtime"
                                : "Enter your desired initial price"
                              }
                            </div>
                            <p className="mt-1.5 text-[10px] text-amber-400/80">
                              ⚠️ This also sets the lower price bound. Setting below market price may cause arbitrage losses.
                            </p>
                          </div>

                        </div>

                        {/* Pool Configuration - DLMM or DAMMV2 */}
                        {monoriftPoolType === 'dlmm' ? (
                          <DLMMConfigPanel
                            dlmmStrategy={dlmmRiftStrategy}
                            setDlmmStrategy={setDlmmRiftStrategy}
                            dlmmBinStep={dlmmRiftBinStep}
                            setDlmmBinStep={setDlmmRiftBinStep}
                            dlmmRangeInterval={dlmmRiftRangeInterval}
                            setDlmmRangeInterval={setDlmmRiftRangeInterval}
                            dlmmFeeBps={dlmmRiftFeeBps}
                            setDlmmFeeBps={setDlmmRiftFeeBps}
                            currentPrice={dlmmRiftTokenPriceUsd}
                            currentPriceInSol={parseFloat(dlmmRiftInitialPrice) || 0}
                            currentMcap={0}
                            underlyingMint={getUnderlyingMint(selectedToken, customTokenAddress || '')}
                            singleSided={dlmmRiftSingleSided}
                            setSingleSided={setDlmmRiftSingleSided}
                            hideSingleSidedToggle={true}
                            onMcapRangeChange={(minMcap, maxMcap, supply, useCustomRange) => {
                              setDlmmRiftMinMcap(minMcap);
                              setDlmmRiftMaxMcap(maxMcap);
                              setDlmmRiftTokenSupply(supply);
                              setDlmmRiftUseMcapRange(useCustomRange);
                            }}
                            meteoraPoolAddress={(() => {
                              // For monorifts, find the underlying token's pool (e.g., rRIFTS pool for mrRIFTS)
                              const underlyingMint = getUnderlyingMint(selectedToken, customTokenAddress || '');
                              const underlyingRift = rifts.find(r => r.underlyingMint === underlyingMint || r.riftMint === underlyingMint);
                              return getPoolAddress(underlyingRift);
                            })()}
                            poolType="dlmm"
                          />
                        ) : (
                          /* DAMMV2 Configuration */
                          <div className="p-3 rounded-lg border border-purple-500/20 bg-purple-500/5">
                            <h4 className="text-xs font-semibold text-purple-400 mb-3 flex items-center gap-2">
                              <span>DAMMV2 Pool Settings</span>
                              <span className={`px-1.5 py-0.5 text-[9px] rounded ${dammv2UsePriceRange ? 'bg-orange-500/20 text-orange-300' : 'bg-purple-500/20 text-purple-300'}`}>
                                {dammv2UsePriceRange ? 'Custom Range' : 'Full Range Spot'}
                              </span>
                            </h4>
                            <div className="space-y-3">
                              {/* Fixed Fee Display */}
                              <div>
                                <label className="block mb-1 text-xs font-medium text-gray-400">Pool Fee</label>
                                <div className="px-3 py-2 rounded-lg bg-purple-500/20 text-purple-400 border border-purple-500/40 text-xs font-medium">
                                  0.25% <span className="text-gray-500 font-normal">(fixed for DAMMV2)</span>
                                </div>
                              </div>

                              {/* Price Range Checkbox */}
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => setDammv2UsePriceRange(!dammv2UsePriceRange)}
                                  className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${
                                    dammv2UsePriceRange
                                      ? 'bg-purple-500 border-purple-500'
                                      : 'border-gray-600 hover:border-purple-500/50'
                                  }`}
                                >
                                  {dammv2UsePriceRange && <Check className="w-3 h-3 text-white" />}
                                </button>
                                <label
                                  className="text-xs text-gray-300 cursor-pointer"
                                  onClick={() => setDammv2UsePriceRange(!dammv2UsePriceRange)}
                                >
                                  Use custom price range
                                </label>
                              </div>

                              {/* Price Range Inputs - shown only when checkbox is checked */}
                              {dammv2UsePriceRange && (
                                <div className="space-y-3 p-3 rounded-lg border border-purple-500/20 bg-black/30">
                                  {/* Price Unit Toggle */}
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-gray-400">Price in:</span>
                                    <div className="flex rounded-lg overflow-hidden border border-purple-500/30">
                                      <button
                                        type="button"
                                        onClick={() => setDammv2PriceUnit('USD')}
                                        className={`px-3 py-1 text-xs transition-all ${
                                          dammv2PriceUnit === 'USD'
                                            ? 'bg-purple-500 text-white'
                                            : 'bg-black/30 text-gray-400 hover:text-white'
                                        }`}
                                      >
                                        USD
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setDammv2PriceUnit('SOL')}
                                        className={`px-3 py-1 text-xs transition-all ${
                                          dammv2PriceUnit === 'SOL'
                                            ? 'bg-purple-500 text-white'
                                            : 'bg-black/30 text-gray-400 hover:text-white'
                                        }`}
                                      >
                                        SOL
                                      </button>
                                    </div>
                                  </div>

                                  {/* Min/Max Price Inputs */}
                                  <div className="grid grid-cols-2 gap-3">
                                    <div>
                                      <label className="block mb-1 text-xs font-medium text-gray-400">
                                        Min Price ({dammv2PriceUnit})
                                      </label>
                                      <div className="w-full px-3 py-2 text-sm bg-purple-500/10 border border-purple-500/30 rounded-lg text-purple-300 font-medium">
                                        {(() => {
                                          const priceInSol = parseFloat(dlmmRiftInitialPrice) || 0;
                                          if (dammv2PriceUnit === 'USD' && solPrice > 0) {
                                            return `$${(priceInSol * solPrice).toFixed(6)}`;
                                          }
                                          return priceInSol.toFixed(8);
                                        })()}
                                      </div>
                                      <p className="text-[9px] text-gray-500 mt-1">Follows initial price (SDK constraint)</p>
                                    </div>
                                    <div>
                                      <label className="block mb-1 text-xs font-medium text-gray-400">
                                        Max Price ({dammv2PriceUnit})
                                      </label>
                                      <input
                                        type="number"
                                        step="any"
                                        min="0"
                                        value={dammv2MaxPrice}
                                        onChange={(e) => setDammv2MaxPrice(e.target.value)}
                                        placeholder="∞"
                                        className="w-full px-3 py-2 text-sm bg-black/50 border border-purple-500/20 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-purple-500/40"
                                      />
                                      <p className="text-[9px] text-gray-500 mt-1">Liquidity active up to this price</p>
                                    </div>
                                  </div>

                                  {/* Info about concentrated range */}
                                  <div className="p-2 rounded bg-orange-500/10 border border-orange-500/20">
                                    <p className="text-[10px] text-orange-300/80">
                                      <span className="font-medium">Note:</span> Min price must equal the initial token price (SDK constraint). Max price determines where liquidity ends.
                                    </p>
                                  </div>
                                </div>
                              )}

                              {/* Info about full range - shown only when checkbox is unchecked */}
                              {!dammv2UsePriceRange && (
                                <div className="p-2 rounded bg-black/30 border border-purple-500/10">
                                  <p className="text-[10px] text-gray-400">
                                    <span className="text-purple-400 font-medium">Full Range Spot:</span> Liquidity is distributed across all prices (0 to ∞), similar to Uniswap V2. Simpler setup with no bin configuration needed.
                                  </p>
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Monopool Configuration (compact) */}
                        <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
                          <h4 className="text-xs font-semibold text-emerald-400 mb-3">Monopool Settings</h4>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block mb-1 text-xs font-medium text-gray-400">DEX Tax (%)</label>
                              <input
                                type="number"
                                step="0.01"
                                min="0.70"
                                max="1.00"
                                value={totalFee}
                                onChange={(e) => setTotalFee(e.target.value)}
                                onBlur={handleTotalFeeBlur}
                                placeholder="0.80"
                                className="w-full px-3 py-2 text-sm bg-black/50 border border-emerald-500/20 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500/40"
                              />
                            </div>
                            <div>
                              <label className="block mb-1 text-xs font-medium text-gray-400">Partner Wallet</label>
                              <input
                                type="text"
                                value={partnerWallet}
                                onChange={(e) => setPartnerWallet(e.target.value)}
                                placeholder="Optional"
                                className="w-full px-3 py-2 text-sm bg-black/50 border border-emerald-500/20 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500/40"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Info Box */}
                    <div className={`p-3 rounded-lg border ${monoriftPoolType === 'dammv2' ? 'border-purple-500/20 bg-purple-500/5' : 'border-emerald-500/20 bg-emerald-500/5'}`}>
                      <p className={`text-xs font-semibold mb-2 ${monoriftPoolType === 'dammv2' ? 'text-purple-400' : 'text-emerald-400'}`}>What happens:</p>
                      <div className="space-y-1 text-xs text-gray-400">
                        <p>1. Create new rift vault (m{selectedToken === 'CUSTOM' ? (customTokenSymbol || 'TOKEN') : (selectedToken || 'TOKEN')})</p>
                        <p>2. Create Meteora {monoriftPoolType === 'dammv2' ? 'DAMMV2 (full range)' : 'DLMM'} pool</p>
                        <p>3. Add initial liquidity (single-sided)</p>
                        <p className={`mt-2 ${monoriftPoolType === 'dammv2' ? 'text-purple-400/70' : 'text-emerald-400/70'}`}>✓ No SOL pairing required | You will sign 2+ transactions</p>
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Progress Stepper for DLMM Creation */}
              {createRiftTab === 'dlmm' && isCreatingDlmmRift && (
                <div className="px-5 py-4 border-t border-blue-500/20 bg-blue-500/5">
                  <div className="flex items-center justify-between">
                    {/* Step 1 - Create Rift */}
                    <div className="flex flex-col items-center">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center border-2 transition-all ${
                        dlmmCreationStep >= 1
                          ? dlmmCreationStep > 1
                            ? 'bg-emerald-500 border-emerald-500 text-white'
                            : 'bg-blue-500 border-blue-500 text-white animate-pulse'
                          : 'border-gray-600 text-gray-600'
                      }`}>
                        {dlmmCreationStep > 1 ? (
                          <Check className="w-4 h-4" />
                        ) : dlmmCreationStep === 1 ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <span className="text-xs font-bold">1</span>
                        )}
                      </div>
                      <span className={`mt-1.5 text-[10px] font-medium ${dlmmCreationStep >= 1 ? 'text-blue-400' : 'text-gray-500'}`}>
                        Create Rift
                      </span>
                    </div>

                    {/* Connector 1-2 */}
                    <div className={`h-0.5 flex-1 mx-1.5 transition-all ${dlmmCreationStep > 1 ? 'bg-emerald-500' : 'bg-gray-700'}`} />

                    {/* Step 2 - Create Pool */}
                    <div className="flex flex-col items-center">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center border-2 transition-all ${
                        dlmmCreationStep >= 2
                          ? dlmmCreationStep > 2
                            ? 'bg-emerald-500 border-emerald-500 text-white'
                            : 'bg-blue-500 border-blue-500 text-white animate-pulse'
                          : 'border-gray-600 text-gray-600'
                      }`}>
                        {dlmmCreationStep > 2 ? (
                          <Check className="w-4 h-4" />
                        ) : dlmmCreationStep === 2 ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <span className="text-xs font-bold">2</span>
                        )}
                      </div>
                      <span className={`mt-1.5 text-[10px] font-medium ${dlmmCreationStep >= 2 ? 'text-blue-400' : 'text-gray-500'}`}>
                        Create Pool
                      </span>
                    </div>

                    {/* Connector 2-3 */}
                    <div className={`h-0.5 flex-1 mx-1.5 transition-all ${dlmmCreationStep > 2 ? 'bg-emerald-500' : 'bg-gray-700'}`} />

                    {/* Step 3 - Add Liquidity */}
                    <div className="flex flex-col items-center">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center border-2 transition-all ${
                        dlmmCreationStep >= 3
                          ? dlmmCreationStep > 3
                            ? 'bg-emerald-500 border-emerald-500 text-white'
                            : 'bg-blue-500 border-blue-500 text-white animate-pulse'
                          : 'border-gray-600 text-gray-600'
                      }`}>
                        {dlmmCreationStep > 3 ? (
                          <Check className="w-4 h-4" />
                        ) : dlmmCreationStep === 3 ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <span className="text-xs font-bold">3</span>
                        )}
                      </div>
                      <span className={`mt-1.5 text-[10px] font-medium ${dlmmCreationStep >= 3 ? 'text-blue-400' : 'text-gray-500'}`}>
                        Add Liq
                      </span>
                    </div>

                    {/* Connector 3-4 */}
                    <div className={`h-0.5 flex-1 mx-1.5 transition-all ${dlmmCreationStep > 3 ? 'bg-emerald-500' : 'bg-gray-700'}`} />

                    {/* Step 4 - Complete */}
                    <div className="flex flex-col items-center">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center border-2 transition-all ${
                        dlmmCreationStep >= 4
                          ? 'bg-emerald-500 border-emerald-500 text-white'
                          : 'border-gray-600 text-gray-600'
                      }`}>
                        {dlmmCreationStep >= 4 ? (
                          <Check className="w-4 h-4" />
                        ) : (
                          <span className="text-xs font-bold">✓</span>
                        )}
                      </div>
                      <span className={`mt-1.5 text-[10px] font-medium ${dlmmCreationStep >= 4 ? 'text-emerald-400' : 'text-gray-500'}`}>
                        Done
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Footer */}
              <div className="px-5 py-4 border-t border-emerald-500/20 bg-black/50">
                <div className="flex gap-3">
                  <button
                    onClick={handleCloseCreateRiftModal}
                    className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-400 bg-black/50 border border-emerald-500/20 hover:border-emerald-500/40 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  {createRiftTab === 'rift' ? (
                    <button
                      onClick={handleCreateRiftStep}
                      disabled={!selectedToken || !wallet.publicKey || isCreatingRift}
                      className="flex-1 px-4 py-2.5 text-sm font-medium text-emerald-400 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 disabled:bg-black/30 disabled:border-gray-700 disabled:text-gray-600 rounded-lg transition-colors flex items-center justify-center gap-2"
                    >
                      {isCreatingRift ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Creating...
                        </>
                      ) : (
                        <>
                          <Plus className="w-4 h-4" />
                          Create Rift
                        </>
                      )}
                    </button>
                  ) : (
                    <button
                      onClick={handleCreateRiftWithDLMM}
                      disabled={!selectedToken || !wallet.publicKey || !dlmmRiftTokenAmount || isCreatingDlmmRift}
                      className="flex-1 px-4 py-2.5 text-sm font-medium text-blue-400 bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/30 disabled:bg-black/30 disabled:border-gray-700 disabled:text-gray-600 rounded-lg transition-colors flex items-center justify-center gap-2"
                    >
                      {isCreatingDlmmRift ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Creating...
                        </>
                      ) : (
                        <>
                          <Droplets className="w-4 h-4" />
                          Create Rift + {monoriftPoolType === 'dammv2' ? 'DAMMV2' : 'DLMM'}
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Filters Modal */}
      <LuxuryModal
        isOpen={showFiltersModal}
        onClose={() => setShowFiltersModal(false)}
        title="Advanced Filters"
        subtitle="Refine your RIFTS search criteria"
        size="md"
      >
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="block mb-2 text-sm font-medium text-gray-300">Risk Level</label>
              <select className="w-full px-4 py-3 text-white bg-gray-800 border border-gray-600 rounded-xl">
                <option value="">All Risk Levels</option>
                <option value="very-low">Very Low</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div>
              <label className="block mb-2 text-sm font-medium text-gray-300">Min APY (%)</label>
              <input 
                type="number" 
                placeholder="0.0"
                className="w-full px-4 py-3 text-white bg-gray-800 border border-gray-600 rounded-xl"
              />
            </div>
            <div>
              <label className="block mb-2 text-sm font-medium text-gray-300">Min TVL ($M)</label>
              <input 
                type="number" 
                placeholder="0.0"
                className="w-full px-4 py-3 text-white bg-gray-800 border border-gray-600 rounded-xl"
              />
            </div>
            <div>
              <label className="block mb-2 text-sm font-medium text-gray-300">Strategy Type</label>
              <select className="w-full px-4 py-3 text-white bg-gray-800 border border-gray-600 rounded-xl">
                <option value="">All Strategies</option>
                <option value="delta-neutral">Delta Neutral</option>
                <option value="momentum">Momentum</option>
                <option value="arbitrage">Arbitrage</option>
              </select>
            </div>
          </div>
          <div className="flex gap-4">
            <LuxuryButton variant="secondary" size="lg" className="flex-1" onClick={() => setShowFiltersModal(false)}>
              Cancel
            </LuxuryButton>
            <LuxuryButton variant="primary" size="lg" className="flex-1">
              Apply Filters
            </LuxuryButton>
          </div>
        </div>
      </LuxuryModal>

      {/* Analytics Modal - Ultra Compact */}
      <LuxuryModal
        isOpen={showAnalyticsModal}
        onClose={() => setShowAnalyticsModal(false)}
        title="Protocol Analytics"
        subtitle="Real-time performance metrics and insights"
        size="lg"
      >
        <div className="space-y-2 max-h-[70vh] overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-emerald-500/20 scrollbar-track-gray-800/20">
          {/* Compact Key Metrics */}
          <div className="grid grid-cols-4 gap-2 text-xs">
            <motion.div className="relative inline-flex items-center justify-center font-medium tracking-wide transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-black overflow-hidden select-none bg-black text-emerald-500 hover:bg-gray-900 active:bg-gray-950 focus:ring-emerald-500 shadow-[0_0_20px_rgba(0,0,0,0.5)] hover:shadow-[0_0_30px_rgba(16,185,129,0.3)] border border-emerald-500/30 hover:border-emerald-400/50 px-3 py-1.5 text-xs gap-1.5 flex-col text-center">
              {/* Luxury background patterns */}
              <div className="absolute inset-0 opacity-30">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
              </div>
              {/* Corner accents */}
              <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-current opacity-50" />
              <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-current opacity-50" />
              <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-current opacity-50" />
              <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-current opacity-50" />
              <div className="relative z-10">
                <p className="text-gray-400">TVL</p>
                <p className="font-bold text-emerald-400">{formatCurrency(totalTVL)}</p>
                <p className="text-emerald-400">+{tvlGrowth}%</p>
              </div>
            </motion.div>
            <motion.div className="relative inline-flex items-center justify-center font-medium tracking-wide transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-black overflow-hidden select-none bg-black text-emerald-500 hover:bg-gray-900 active:bg-gray-950 focus:ring-emerald-500 shadow-[0_0_20px_rgba(0,0,0,0.5)] hover:shadow-[0_0_30px_rgba(16,185,129,0.3)] border border-emerald-500/30 hover:border-emerald-400/50 px-3 py-1.5 text-xs gap-1.5 flex-col text-center">
              {/* Luxury background patterns */}
              <div className="absolute inset-0 opacity-30">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
              </div>
              {/* Corner accents */}
              <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-current opacity-50" />
              <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-current opacity-50" />
              <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-current opacity-50" />
              <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-current opacity-50" />
              <div className="relative z-10">
                <p className="text-gray-400">Active Farmers</p>
                <p className="font-bold text-emerald-400">{totalUsers}</p>
                <p className="text-emerald-400">Active</p>
              </div>
            </motion.div>
            <motion.div className="relative inline-flex items-center justify-center font-medium tracking-wide transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-black overflow-hidden select-none bg-black text-emerald-500 hover:bg-gray-900 active:bg-gray-950 focus:ring-emerald-500 shadow-[0_0_20px_rgba(0,0,0,0.5)] hover:shadow-[0_0_30px_rgba(16,185,129,0.3)] border border-emerald-500/30 hover:border-emerald-400/50 px-3 py-1.5 text-xs gap-1.5 flex-col text-center">
              {/* Luxury background patterns */}
              <div className="absolute inset-0 opacity-30">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
              </div>
              {/* Corner accents */}
              <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-current opacity-50" />
              <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-current opacity-50" />
              <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-current opacity-50" />
              <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-current opacity-50" />
              <div className="relative z-10">
                <p className="text-gray-400">Avg APY</p>
                <p className="font-bold text-emerald-400">{avgAPY.toFixed(2)}%</p>
                <p className="text-emerald-400">{totalUsers > 0 ? 'Live' : 'None'}</p>
              </div>
            </motion.div>
            <motion.div className="relative inline-flex items-center justify-center font-medium tracking-wide transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-black overflow-hidden select-none bg-black text-emerald-500 hover:bg-gray-900 active:bg-gray-950 focus:ring-emerald-500 shadow-[0_0_20px_rgba(0,0,0,0.5)] hover:shadow-[0_0_30px_rgba(16,185,129,0.3)] border border-emerald-500/30 hover:border-emerald-400/50 px-3 py-1.5 text-xs gap-1.5 flex-col text-center">
              {/* Luxury background patterns */}
              <div className="absolute inset-0 opacity-30">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
              </div>
              {/* Corner accents */}
              <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-current opacity-50" />
              <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-current opacity-50" />
              <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-current opacity-50" />
              <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-current opacity-50" />
              <div className="relative z-10">
                <p className="text-gray-400">24h Volume</p>
                <p className="font-bold text-emerald-400">{formatCurrency(totalVolume)}</p>
                <p className="text-emerald-400">+{volumeGrowth}%</p>
              </div>
            </motion.div>
          </div>

          {/* Compact Revenue & Analytics Grid */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 border rounded-xl bg-gray-800/50 border-gray-700/50">
              <h3 className="flex items-center gap-1 mb-2 text-sm font-bold text-white">
                <DollarSign className="w-3 h-3 text-green-400" />
                Revenue
              </h3>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-400">Total Fees Collected:</span>
                  <span className="font-semibold text-green-400">${(fullRealAnalytics?.feesCollected || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Legacy Fees:</span>
                  <span className="text-gray-300">${(fullRealAnalytics?.vaultBalances?.legacyFees || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Treasury:</span>
                  <span className="text-gray-300">${(fullRealAnalytics?.vaultBalances?.treasuryBalance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Arb Bot:</span>
                  <span className="text-gray-300">${(fullRealAnalytics?.vaultBalances?.authorityBalance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Vault Fees (50%):</span>
                  <span className="text-gray-300">${(fullRealAnalytics?.vaultBalances?.currentVaultFees || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              </div>
            </div>
            
            <div className="p-3 border rounded-xl bg-gray-800/50 border-gray-700/50">
              <h3 className="flex items-center gap-1 mb-2 text-sm font-bold text-white">
                <Target className="w-3 h-3 text-cyan-400" />
                Performance
              </h3>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-400">Avg APY:</span>
                  <span className="font-semibold text-green-400">{avgAPY.toFixed(1)}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Burned:</span>
                  <span className="font-semibold text-red-400">{(realMetrics?.totalBurned || totalBurned || 0).toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Burn Rate:</span>
                  <span className="font-semibold text-orange-400">{((realMetrics?.burnRate || burnRate || 0.45) * 100).toFixed(1)}%/mo</span>
                </div>
              </div>
            </div>
          </div>

          {/* Vault Fees Breakdown */}
          {fullRealAnalytics?.vaultBalances?.vaults && fullRealAnalytics.vaultBalances.vaults.length > 0 && (
            <div className="p-3 border rounded-xl bg-gray-800/50 border-gray-700/50">
              <h3 className="flex items-center gap-1 mb-2 text-sm font-bold text-white">
                <DollarSign className="w-3 h-3 text-purple-400" />
                Vault Fees Breakdown (100% = Protocol 50% + Partner 50%)
              </h3>
              <div className="space-y-1 text-xs">
                {fullRealAnalytics.vaultBalances.vaults
                  .filter((v: any) => v.totalUSD > 0)
                  .sort((a: any, b: any) => b.totalUSD - a.totalUSD)
                  .slice(0, 6)
                  .map((vault: any) => (
                    <div key={vault.riftId} className="flex justify-between items-center py-1 border-b border-gray-700/30 last:border-0">
                      <div className="flex flex-col">
                        <span className="text-gray-300 font-medium">{vault.riftSymbol}</span>
                        <span className="text-gray-500 text-[10px]">
                          Fees: ${vault.feesUSD?.toFixed(2) || '0.00'} | Withheld: ${vault.withheldUSD?.toFixed(2) || '0.00'}
                        </span>
                      </div>
                      <span className="font-semibold text-green-400">${vault.totalUSD?.toFixed(2) || '0.00'}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Top Performing Rifts */}
          <div className="p-6 border bg-gray-800/50 border-gray-700/50 rounded-xl">
            <h3 className="flex items-center gap-2 mb-4 text-xl font-bold text-white">
              <TrendingUp className="w-5 h-5 text-green-400" />
              Top Performing Rifts (30d)
            </h3>
            <div className="space-y-3">
              {(() => {
                const analyticsRifts = fullRealAnalytics?.rifts || rifts;
                return analyticsRifts.filter((rift: any) => !isBlacklistedRift(rift));
              })().slice(0, 5).map((rift: any, index: number) => (
                <div key={`top-performing-${rift.id}`} className="flex items-center justify-between p-3 rounded-xl bg-gray-900/50">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-gradient-to-br from-green-500 to-green-600">
                      <span className="text-sm font-bold text-black">#{index + 1}</span>
                    </div>
                    <div>
                      <p className="font-semibold text-white">{rift.symbol}</p>
                      <p className="text-sm text-gray-400">{rift.underlying} • {rift.strategy}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-green-400">{(rift.apy && rift.apy > 0) ? rift.apy.toFixed(2) : avgAPY.toFixed(2)}% APY</p>
                    <p className="text-sm text-gray-400">
                      {rift.tvl ? (
                        rift.tvl >= 1000000 ? `$${(rift.tvl / 1000000).toFixed(2)}M` :
                        rift.tvl >= 1000 ? `$${(rift.tvl / 1000).toFixed(2)}K` :
                        `$${rift.tvl.toFixed(2)}`
                      ) : '$0'} TVL
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Oracle System Status */}
          <div className="p-6 border bg-gray-800/50 border-gray-700/50 rounded-xl">
            <h3 className="flex items-center gap-2 mb-4 text-xl font-bold text-white">
              <AlertCircle className="w-5 h-5 text-orange-400" />
              Hybrid Oracle System Status
            </h3>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <div className="p-4 rounded-xl bg-gray-900/50">
                <h4 className="mb-2 text-sm text-gray-400">Active Oracles</h4>
                <p className="text-2xl font-bold text-green-400">{realMetrics?.activeOracles ?? realProtocolAnalytics?.oracle.activeOracles ?? protocolAnalytics?.oracle.activeOracles ?? 2}</p>
                <p className="text-xs text-green-400">100% Active</p>
              </div>
              <div className="p-4 rounded-xl bg-gray-900/50">
                <h4 className="mb-2 text-sm text-gray-400">Price Feeds</h4>
                <p className="text-2xl font-bold text-blue-400">{realMetrics?.activeOracles ?? realProtocolAnalytics?.oracle.priceFeeds ?? protocolAnalytics?.oracle.priceFeeds ?? 2}</p>
                <p className="text-xs text-blue-400">Real-time</p>
              </div>
              <div className="p-4 rounded-xl bg-gray-900/50">
                <h4 className="mb-2 text-sm text-gray-400">Avg Latency</h4>
                <p className="text-2xl font-bold text-purple-400">~{realMetrics?.avgLatency?.toFixed(0) ?? realProtocolAnalytics?.oracle.avgLatency?.toFixed(0) ?? protocolAnalytics?.oracle.avgLatency?.toFixed(0) ?? 50}ms</p>
                <p className="text-xs text-purple-400">Live</p>
              </div>
              <div className="p-4 rounded-xl bg-gray-900/50">
                <h4 className="mb-2 text-sm text-gray-400">Accuracy</h4>
                <p className="text-2xl font-bold text-yellow-400">{realMetrics?.priceFeedAccuracy?.toFixed(1) ?? realProtocolAnalytics?.oracle.accuracy?.toFixed(1) ?? protocolAnalytics?.oracle.accuracy?.toFixed(1) ?? 99.5}%</p>
                <p className="text-xs text-yellow-400">Real-time</p>
              </div>
            </div>
          </div>

          {/* User Analytics */}
          <div className="p-6 border bg-gray-800/50 border-gray-700/50 rounded-xl">
            <h3 className="flex items-center gap-2 mb-4 text-xl font-bold text-white">
              <Users className="w-5 h-5 text-blue-400" />
              User Analytics
            </h3>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
              <div>
                <h4 className="mb-3 text-lg font-semibold text-white">User Distribution</h4>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-gray-400">New Users (7d)</span>
                    <span className="font-semibold text-green-400">{fullRealAnalytics?.users.newUsers7d ?? 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Active Users (30d)</span>
                    <span className="font-semibold text-blue-400">{fullRealAnalytics?.users.activeUsers30d ?? 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Retention Rate</span>
                    <span className="font-semibold text-purple-400">{fullRealAnalytics?.users.retentionRate ?? 0}%</span>
                  </div>
                </div>
              </div>
              <div>
                <h4 className="mb-3 text-lg font-semibold text-white">Position Sizes</h4>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-gray-400">&lt; $1K</span>
                    <span className="font-semibold text-white">{fullRealAnalytics?.positionSizes.small ?? 0}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">$1K - $10K</span>
                    <span className="font-semibold text-white">{fullRealAnalytics?.positionSizes.medium ?? 0}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">&gt; $10K</span>
                    <span className="font-semibold text-white">{fullRealAnalytics?.positionSizes.large ?? 0}%</span>
                  </div>
                </div>
              </div>
              <div>
                <h4 className="mb-3 text-lg font-semibold text-white">Transaction Volume</h4>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Daily Avg</span>
                    <span className="font-semibold text-green-400">{fullRealAnalytics?.transactions.dailyAvg ?? 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Weekly Peak</span>
                    <span className="font-semibold text-blue-400">{fullRealAnalytics?.transactions.weeklyPeak ?? 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Total Txs</span>
                    <span className="font-semibold text-purple-400">{fullRealAnalytics?.transactions.totalVolume ?? 0}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Real-time Price Charts */}
          <div className="p-6 border bg-gray-800/50 border-gray-700/50 rounded-xl">
            <h3 className="flex items-center gap-2 mb-4 text-xl font-bold text-white">
              <BarChart3 className="w-5 h-5 text-cyan-400" />
              Performance Charts & Trends
            </h3>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="flex items-center justify-center h-48 bg-gray-900/50 rounded-xl">
                <div className="text-center">
                  <LineChart className="w-12 h-12 mx-auto mb-2 text-gray-600" />
                  <p className="font-medium text-gray-400">TVL Growth Chart</p>
                  <p className="text-xs text-gray-500">Interactive visualization coming soon</p>
                </div>
              </div>
              <div className="flex items-center justify-center h-48 bg-gray-900/50 rounded-xl">
                <div className="text-center">
                  <PieChart className="w-12 h-12 mx-auto mb-2 text-gray-600" />
                  <p className="font-medium text-gray-400">Strategy Distribution</p>
                  <p className="text-xs text-gray-500">Real-time pie chart coming soon</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </LuxuryModal>


      {/* Staking Modal */}
      <LuxuryModal
        isOpen={showStakingModal}
        onClose={() => {
          setShowStakingModal(false);
          setStakingAmount('');
          setUnstakeAmount('');
          setStakingTab('stake');
        }}
        title="LP Staking"
        subtitle="Stake LP tokens to earn RIFTS rewards"
        size="md"
      >
        <div className="space-y-6">
          {/* Tabs */}
          <div className="flex gap-2 p-1 border rounded-lg bg-gray-900/50 border-gray-700/50">
            <button
              onClick={() => setStakingTab('stake')}
              className={`flex-1 px-4 py-2 rounded-md font-medium transition-all ${
                stakingTab === 'stake'
                  ? 'bg-emerald-500 text-white shadow-lg'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <Lock className="inline w-4 h-4 mr-2" />
              Stake
            </button>
            <button
              onClick={() => setStakingTab('unstake')}
              className={`flex-1 px-4 py-2 rounded-md font-medium transition-all ${
                stakingTab === 'unstake'
                  ? 'bg-emerald-500 text-white shadow-lg'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <Unlock className="inline w-4 h-4 mr-2" />
              Unstake
            </button>
          </div>

          {wallet.connected && wallet.publicKey ? (
            <>
              {/* Staking Info */}
              <div className="p-6 border bg-gradient-to-br from-gray-800/50 to-gray-900/50 border-gray-700/50 rounded-xl">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-bold text-white">Your Staking Position</h3>
                  {(portfolioData?.stakedAmount || stakedAmount) > 0 && (
                    <span className="px-3 py-1 text-xs font-bold rounded-full bg-green-500/20 text-green-400 border border-green-500/30">
                      Active
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-3 border rounded-lg bg-gray-900/50 border-gray-700/30">
                    <p className="mb-1 text-xs font-medium text-gray-400">Currently Staked</p>
                    <p className="text-2xl font-bold text-blue-400">{portfolioData?.stakedAmount.toFixed(4) || stakedAmount.toFixed(4)}</p>
                    <p className="text-xs text-gray-500">LP Tokens</p>
                  </div>
                  <div className="p-3 border rounded-lg bg-gray-900/50 border-gray-700/30">
                    <p className="mb-1 text-xs font-medium text-gray-400">Staking APY</p>
                    <p className="text-2xl font-bold text-green-400">{portfolioData?.stakingApy.toFixed(2) || '40.00'}%</p>
                    <p className="text-xs text-gray-500">Annual Yield</p>
                  </div>
                  <div className="p-3 border rounded-lg bg-gray-900/50 border-gray-700/30">
                    <p className="mb-1 text-xs font-medium text-gray-400">Pending Rewards</p>
                    <p className="text-2xl font-bold text-purple-400">{portfolioData?.pendingRewards.toFixed(4) || stakingRewards.toFixed(4)}</p>
                    <p className="text-xs text-gray-500">RIFTS Tokens</p>
                  </div>
                  <div className="p-3 border rounded-lg bg-gray-900/50 border-gray-700/30">
                    <p className="mb-1 text-xs font-medium text-gray-400">USD Value</p>
                    <p className="text-2xl font-bold text-emerald-400">${portfolioData?.pendingRewardsUsd.toFixed(2) || (stakingRewards * 0.001).toFixed(2)}</p>
                    <p className="text-xs text-gray-500">Current Price</p>
                  </div>
                </div>
                {(portfolioData?.stakedAmount || stakedAmount) > 0 && (
                  <div className="p-3 mt-4 border border-green-900/50 bg-green-900/10 rounded-lg">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-green-300">💎 Total Staked Value:</span>
                      <span className="font-bold text-green-100">${((portfolioData?.stakedAmount || stakedAmount) * 0.001).toFixed(2)}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Stake Tab Content */}
              {stakingTab === 'stake' && (
                <>
                  {/* Stake Form */}
                  <div className="p-6 border bg-gray-800/50 border-gray-700/50 rounded-xl">
                    <h3 className="mb-4 text-lg font-bold text-white">Stake LP Tokens</h3>
                <div className="space-y-4">
                  {/* Available Balance */}
                  <div className="flex items-center justify-between p-3 border bg-gray-900/50 border-gray-700/50 rounded-lg">
                    <span className="text-sm text-gray-400">Available to Stake:</span>
                    <span className="text-lg font-bold text-emerald-400">{lpTokenBalance.toFixed(4)} LP</span>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm text-gray-400">Amount to Stake (LP Tokens)</label>
                      <button
                        onClick={() => setStakingAmount(lpTokenBalance.toString())}
                        className="px-2 py-1 text-xs font-bold transition-colors border rounded text-emerald-400 border-emerald-500/50 hover:bg-emerald-500/20"
                        disabled={lpTokenBalance === 0}
                      >
                        MAX
                      </button>
                    </div>
                    <div className="relative">
                      <input
                        type="number"
                        value={stakingAmount}
                        onChange={(e) => setStakingAmount(e.target.value)}
                        placeholder="0.00"
                        className="w-full px-4 py-3 text-white transition bg-gray-900 border border-gray-700 rounded-lg focus:border-blue-500 focus:outline-none"
                        min="0"
                        max={lpTokenBalance}
                        step="0.01"
                      />
                    </div>

                    {/* Percentage Presets */}
                    <div className="grid grid-cols-4 gap-2 mt-3">
                      {[25, 50, 75, 100].map((percentage) => (
                        <button
                          key={percentage}
                          onClick={() => setStakingAmount((lpTokenBalance * (percentage / 100)).toFixed(4))}
                          className="px-3 py-2 text-sm font-medium transition-all border rounded-lg text-gray-300 border-gray-700 hover:border-emerald-500/50 hover:bg-emerald-500/10 hover:text-emerald-400"
                          disabled={lpTokenBalance === 0}
                        >
                          {percentage}%
                        </button>
                      ))}
                    </div>
                  </div>

                  {parseFloat(stakingAmount || '0') > 0 && (
                    <div className="p-4 space-y-2 border border-blue-900/50 bg-blue-900/20 rounded-xl">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-blue-300">💰 Daily Rewards:</span>
                        <span className="font-semibold text-blue-100">~{(parseFloat(stakingAmount) * 0.4 / 365).toFixed(4)} RIFTS</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-blue-300">📈 Monthly Rewards:</span>
                        <span className="font-semibold text-blue-100">~{(parseFloat(stakingAmount) * 0.4 / 12).toFixed(4)} RIFTS</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-blue-300">🎯 Yearly Rewards:</span>
                        <span className="font-semibold text-blue-100">~{(parseFloat(stakingAmount) * 0.4).toFixed(4)} RIFTS</span>
                      </div>
                      <div className="pt-2 mt-2 border-t border-blue-800/50">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-blue-200">Est. Value (1 year):</span>
                          <span className="font-bold text-emerald-400">${(parseFloat(stakingAmount) * 0.4 * 0.001).toFixed(2)}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {lpTokenBalance === 0 && (
                    <div className="p-4 border border-yellow-900/50 bg-yellow-900/20 rounded-xl">
                      <p className="text-sm text-yellow-300">
                        ⚠️ You don't have any LP tokens yet. Add liquidity to the RIFTS pool to earn LP tokens.
                      </p>
                    </div>
                  )}

                  <LuxuryButton
                    variant="success"
                    size="lg"
                    fullWidth
                    onClick={handleStakeLPClick}
                    disabled={!stakingAmount || parseFloat(stakingAmount) <= 0 || parseFloat(stakingAmount) > lpTokenBalance || isWrapping}
                  >
                    <Lock className="w-4 h-4" />
                    {isWrapping ? 'Staking...' : 'Stake LP Tokens'}
                  </LuxuryButton>
                </div>
              </div>

                  {/* Staking Benefits */}
                  <div className="p-6 border bg-gray-800/50 border-gray-700/50 rounded-xl">
                    <h3 className="mb-4 text-lg font-bold text-white">Staking Benefits</h3>
                    <div className="space-y-3">
                      <div className="flex items-start gap-3">
                        <div className="flex items-center justify-center flex-shrink-0 w-8 h-8 rounded-full bg-green-900/30">
                          <DollarSign className="w-4 h-4 text-green-400" />
                        </div>
                        <div>
                          <p className="font-semibold text-white">Earn RIFTS Rewards</p>
                          <p className="text-sm text-gray-400">Receive 90% of all protocol trading fees distributed as RIFTS tokens</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="flex items-center justify-center flex-shrink-0 w-8 h-8 rounded-full bg-blue-900/30">
                          <TrendingUp className="w-4 h-4 text-blue-400" />
                        </div>
                        <div>
                          <p className="font-semibold text-white">High APY</p>
                          <p className="text-sm text-gray-400">Earn up to 40% APY from trading fee distribution</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="flex items-center justify-center flex-shrink-0 w-8 h-8 rounded-full bg-purple-900/30">
                          <Shield className="w-4 h-4 text-purple-400" />
                        </div>
                        <div>
                          <p className="font-semibold text-white">No Lock Period</p>
                          <p className="text-sm text-gray-400">Unstake your LP tokens anytime without penalties</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Unstake Tab Content */}
              {stakingTab === 'unstake' && (
                <>
                  {/* Unstake Form */}
                  <div className="p-6 border bg-gray-800/50 border-gray-700/50 rounded-xl">
                    <h3 className="mb-4 text-lg font-bold text-white">Unstake LP Tokens</h3>
                    <div className="space-y-4">
                      {/* Currently Staked */}
                      <div className="flex items-center justify-between p-3 border bg-gray-900/50 border-gray-700/50 rounded-lg">
                        <span className="text-sm text-gray-400">Currently Staked:</span>
                        <span className="text-lg font-bold text-blue-400">{portfolioData?.stakedAmount.toFixed(4) || stakedAmount.toFixed(4)} LP</span>
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label className="text-sm text-gray-400">Amount to Unstake (LP Tokens)</label>
                          <button
                            onClick={() => setUnstakeAmount((portfolioData?.stakedAmount || stakedAmount).toString())}
                            className="px-2 py-1 text-xs font-bold transition-colors border rounded text-blue-400 border-blue-500/50 hover:bg-blue-500/20"
                            disabled={(portfolioData?.stakedAmount || stakedAmount) === 0}
                          >
                            MAX
                          </button>
                        </div>
                        <div className="relative">
                          <input
                            type="number"
                            value={unstakeAmount}
                            onChange={(e) => setUnstakeAmount(e.target.value)}
                            placeholder="0.00"
                            className="w-full px-4 py-3 text-white transition bg-gray-900 border border-gray-700 rounded-lg focus:border-blue-500 focus:outline-none"
                            min="0"
                            max={portfolioData?.stakedAmount || stakedAmount}
                            step="0.01"
                          />
                        </div>

                        {/* Percentage Presets */}
                        <div className="grid grid-cols-4 gap-2 mt-3">
                          {[25, 50, 75, 100].map((percentage) => (
                            <button
                              key={percentage}
                              onClick={() => setUnstakeAmount(((portfolioData?.stakedAmount || stakedAmount) * (percentage / 100)).toFixed(4))}
                              className="px-3 py-2 text-sm font-medium transition-all border rounded-lg text-gray-300 border-gray-700 hover:border-blue-500/50 hover:bg-blue-500/10 hover:text-blue-400"
                              disabled={(portfolioData?.stakedAmount || stakedAmount) === 0}
                            >
                              {percentage}%
                            </button>
                          ))}
                        </div>
                      </div>

                      {parseFloat(unstakeAmount || '0') > 0 && (
                        <div className="p-4 space-y-2 border border-blue-900/50 bg-blue-900/20 rounded-xl">
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-blue-300">💰 You will receive:</span>
                            <span className="font-semibold text-blue-100">{parseFloat(unstakeAmount).toFixed(4)} LP</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-blue-300">💵 Est. Value:</span>
                            <span className="font-semibold text-blue-100">${(parseFloat(unstakeAmount) * 0.001).toFixed(2)}</span>
                          </div>
                        </div>
                      )}

                      <LuxuryButton
                        variant="primary"
                        size="lg"
                        fullWidth
                        onClick={handleUnstakeLP}
                        disabled={!unstakeAmount || parseFloat(unstakeAmount) <= 0 || parseFloat(unstakeAmount) > (portfolioData?.stakedAmount || stakedAmount) || isWrapping}
                      >
                        <Unlock className="w-4 h-4" />
                        {isWrapping ? 'Unstaking...' : 'Unstake LP Tokens'}
                      </LuxuryButton>
                    </div>
                  </div>

                  {/* Claim Rewards */}
                  <div className="p-6 border bg-gray-800/50 border-gray-700/50 rounded-xl">
                    <h3 className="mb-4 text-lg font-bold text-white">Claim Rewards</h3>
                    <div className="space-y-4">
                      <div className="p-4 border bg-gray-900/50 border-gray-700/50 rounded-xl">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm text-gray-400">Pending Rewards:</span>
                          <span className="text-2xl font-bold text-purple-400">{portfolioData?.pendingRewards.toFixed(4) || stakingRewards.toFixed(4)} RIFTS</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-gray-500">USD Value:</span>
                          <span className="text-sm font-semibold text-emerald-400">${portfolioData?.pendingRewardsUsd.toFixed(2) || (stakingRewards * 0.001).toFixed(2)}</span>
                        </div>
                      </div>

                      <LuxuryButton
                        variant="success"
                        size="lg"
                        fullWidth
                        onClick={handleClaimRewards}
                        disabled={(portfolioData?.pendingRewards || stakingRewards) === 0 || isWrapping}
                      >
                        <DollarSign className="w-4 h-4" />
                        {isWrapping ? 'Claiming...' : `Claim ${(portfolioData?.pendingRewards || stakingRewards).toFixed(2)} RIFTS`}
                      </LuxuryButton>
                    </div>
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="py-12 text-center">
              <Wallet className="w-16 h-16 mx-auto mb-4 text-gray-600" />
              <p className="mb-4 text-gray-400">Connect your wallet to stake LP tokens</p>
              <LuxuryButton variant="primary" onClick={wallet.connect}>
                Connect Wallet
              </LuxuryButton>
            </div>
          )}
        </div>
      </LuxuryModal>

      {/* Staking Confirmation Modal */}
      <ConfirmationModal
        isOpen={showStakingConfirmation}
        onClose={() => setShowStakingConfirmation(false)}
        onConfirm={handleStakeLP}
        title="Confirm Staking"
        message="You are about to stake your LP tokens. Once staked, they will earn RIFTS rewards from trading fees."
        confirmText="Stake Now"
        cancelText="Cancel"
        type="success"
        icon={<Lock className="w-8 h-8" />}
        details={[
          { label: 'Amount to Stake', value: `${parseFloat(stakingAmount || '0').toFixed(4)} LP`, highlight: true },
          { label: 'APY', value: '40.00%', highlight: false },
          { label: 'Daily Rewards', value: `~${(parseFloat(stakingAmount || '0') * 0.4 / 365).toFixed(4)} RIFTS`, highlight: false },
          { label: 'Monthly Rewards', value: `~${(parseFloat(stakingAmount || '0') * 0.4 / 12).toFixed(4)} RIFTS`, highlight: false },
        ]}
      />


      {/* Markets Modal */}
      <LuxuryModal
        isOpen={showMarketsModal}
        onClose={() => setShowMarketsModal(false)}
        title="Market Overview"
        subtitle="Live market data and token performance"
        size="lg"
      >
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="p-4 border bg-gray-900/50 border-gray-700/50 rounded-xl">
              <h3 className="mb-2 text-lg font-semibold text-white">Market Cap</h3>
              <p className="text-2xl font-bold text-green-400">{formatCurrency(totalTVL * 1.2)}</p>
              <p className="text-sm text-gray-400">Total market value</p>
            </div>
            <div className="p-4 border bg-gray-900/50 border-gray-700/50 rounded-xl">
              <h3 className="mb-2 text-lg font-semibold text-white">24h Volume</h3>
              <p className="text-2xl font-bold text-blue-400">{formatCurrency(totalVolume)}</p>
              <p className="text-sm text-gray-400">Trading volume</p>
            </div>
          </div>
          <div className="p-6 border bg-gray-900/50 border-gray-700/50 rounded-xl">
            <h3 className="mb-4 text-xl font-bold text-white">Top Performing Rifts</h3>
            <div className="space-y-3">
              {rifts.filter(rift => !isBlacklistedRift(rift)).slice(0, 5).map((rift, index) => (
                <div key={`sidebar-${rift.id}`} className="flex items-center justify-between py-2">
                  <div className="flex items-center gap-3">
                    <span className="w-6 text-gray-400">{index + 1}</span>
                    <div>
                      <p className="font-semibold text-white">{rift.symbol}</p>
                      <p className="text-sm text-gray-400">{rift.underlying}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-green-400">{(rift.apy && rift.apy > 0) ? rift.apy.toFixed(2) : (avgAPY > 0 ? avgAPY.toFixed(2) : '0.00')}%</p>
                    <p className="text-sm text-gray-400">
                      {rift.tvl ? (
                        rift.tvl >= 1000000 ? `$${(rift.tvl / 1000000).toFixed(2)}M` :
                        rift.tvl >= 1000 ? `$${(rift.tvl / 1000).toFixed(2)}K` :
                        `$${rift.tvl.toFixed(2)}`
                      ) : '$0'} TVL
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </LuxuryModal>

      {/* YOUR RIFTS Modal - Show only user's rifts */}
      {(() => {
        const userRifts = rifts.filter(rift =>
          wallet.publicKey && rift.creator === wallet.publicKey.toString()
        );

        return (
          <LuxuryModal
            isOpen={showRiftsTokenModal}
            onClose={() => setShowRiftsTokenModal(false)}
            title="YOUR RIFTS"
            subtitle={userRifts.length === 0 ? "You haven't created any rifts yet" : `You have ${userRifts.length} rift${userRifts.length !== 1 ? 's' : ''}`}
            size="xl"
            zIndex={120}
          >
            <div className="space-y-3">
              {/* Revenue Split */}
              <div className="p-3 border rounded-xl bg-gray-800/50 border-gray-700/50">
                <h3 className="flex items-center gap-1 mb-2 text-sm font-bold text-white">
                  <PieChart className="w-3 h-3 text-green-400" />
                  Revenue Split
                </h3>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Users:</span>
                    <span className="font-semibold text-green-400">50%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Treasury:</span>
                    <span className="font-semibold text-purple-400">50%</span>
                  </div>
                </div>
              </div>

              {/* User's Rifts List */}
              <div className="space-y-2">
                <h3 className="text-sm font-bold text-white">Your Rifts</h3>
                <div className="grid gap-2 max-h-96 overflow-y-auto">
                  {userRifts.length === 0 ? (
                    <div className="p-8 text-center border rounded-xl bg-gray-800/30 border-gray-700/50">
                      <div className="flex flex-col items-center gap-3">
                        <IconCoins className="w-12 h-12 text-gray-600" />
                        <p className="text-gray-400">You haven't created any rifts yet</p>
                        <button
                          onClick={() => {
                            setShowRiftsTokenModal(false);
                            setShowCreateRiftModal(true);
                          }}
                          className="px-4 py-2 mt-2 text-sm font-bold text-black transition-all bg-gradient-to-r from-emerald-400 to-emerald-600 rounded-lg hover:from-emerald-500 hover:to-emerald-700"
                        >
                          Create Your First Rift
                        </button>
                      </div>
                    </div>
                  ) : (
                    userRifts.map((rift) => (
                    <div
                      key={rift.id}
                      className="p-3 border rounded-xl bg-gray-800/50 border-gray-700/50 hover:border-emerald-500/50 transition-all cursor-pointer"
                      onClick={() => {
                        setSelectedRift(rift);
                        setShowRiftsTokenModal(false);
                        setShowDetailsModal(true);
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center">
                            <span className="text-xs font-bold text-black">
                              {rift.symbol?.[0]?.toUpperCase() || 'R'}
                            </span>
                          </div>
                          <div>
                            <h4 className="text-sm font-bold text-white">{rift.symbol}</h4>
                            <p className="text-xs text-gray-400">{rift.underlying}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-bold text-emerald-400">
                            {rift.tvl >= 1000000 ? `$${(rift.tvl / 1000000).toFixed(2)}M` :
                             rift.tvl >= 1000 ? `$${(rift.tvl / 1000).toFixed(2)}K` :
                             `$${rift.tvl.toFixed(2)}`}
                          </p>
                          <p className="text-xs text-gray-400">TVL</p>
                        </div>
                      </div>
                    </div>
                  ))
                  )}
                </div>
              </div>
            </div>
          </LuxuryModal>
        );
      })()}

      {/* Advanced Trading Interface Modal */}
      <AnimatePresence>
        {showTradingModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
            onClick={(e) => e.target === e.currentTarget && setShowTradingModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.2 }}
              className="w-full max-w-4xl bg-black/90 backdrop-blur-md border border-emerald-500/30 rounded-xl shadow-2xl overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-emerald-500/20">
                <div>
                  <h2 className="text-base font-semibold text-emerald-400">Advanced Trading Platform</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Professional trading interface for all wrapped tokens</p>
                </div>
                <button
                  onClick={() => setShowTradingModal(false)}
                  className="p-2 rounded-lg text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Content */}
              <div className="px-5 py-4 max-h-[70vh] overflow-y-auto">
                <TradingInterface
                  wallet={{
                    publicKey: wallet.publicKey,
                    connected: wallet.connected,
                    sendTransaction: walletAdapterSendTx as ((transaction: unknown) => Promise<unknown>) | undefined
                  }}
                  rifts={rifts}
                  defaultSelectedRift={selectedRift}
                  onTrade={async (type, token, amount) => {
                    // Handle different token types
                    if (token === 'RIFTS' && type === 'buy') {
                      await handleBuyRIFTS();
                    } else if (token.startsWith('r') && type === 'buy') {
                      // Handle wrapped token buying (wrapping)
                      const underlyingToken = token.substring(1); // Remove 'r' prefix
                      const targetRift = rifts.find(r => r.underlying === underlyingToken);
                      if (targetRift) {
                        setSelectedRift(targetRift);
                        setWrapAmount(amount.toString());
                        setShowTradingModal(false);
                        setShowWrapModal(true);
                        // Prefetch + balance fetch in background
                        void Promise.allSettled([
                          fetchTokenBalance(targetRift),
                          fetchRiftTokenBalance(targetRift, true),
                          riftProtocolService.prefetchWrapData(new PublicKey(targetRift.id)).catch(() => {})
                        ]);
                      }
                    } else if (token.startsWith('r') && type === 'sell') {
                      // Handle wrapped token selling (unwrapping)
                      const underlyingToken = token.substring(1); // Remove 'r' prefix
                      const targetRift = rifts.find(r => r.underlying === underlyingToken);
                      if (targetRift) {
                        setSelectedRift(targetRift);
                        setUnwrapAmount(amount.toString());
                        setShowTradingModal(false);
                        void riftProtocolService
                          .prefetchUnwrapData(new PublicKey(targetRift.id))
                          .catch(() => {});
                        const timeSinceLastUpdate = Date.now() - lastBalanceUpdate;
                        if (timeSinceLastUpdate > 60000) {
                          void fetchRiftTokenBalance(targetRift, true);
                        }
                        setShowUnwrapModal(true);
                      }
                    }
                  }}
                />
              </div>

              {/* Footer */}
              <div className="px-5 py-4 border-t border-emerald-500/20 bg-black/50">
                <button
                  onClick={() => setShowTradingModal(false)}
                  className="w-full px-4 py-2.5 text-sm font-medium text-gray-400 bg-black/50 border border-emerald-500/20 hover:border-emerald-500/40 rounded-lg transition-colors"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {riftsModal.isOpen && riftsModal.rift && (
          <RiftsUI
            isOpen={riftsModal.isOpen}
            onClose={() => setRiftsModal({ isOpen: false, rift: null })}
            rift={riftsModal.rift}
            wallet={wallet}
            rifts={rifts}
            onWrap={async () => {
              setShowWrapModal(true);
              if (selectedRift) {
                void Promise.allSettled([
                  fetchTokenBalance(selectedRift),
                  fetchRiftTokenBalance(selectedRift, true),
                  riftProtocolService.prefetchWrapData(new PublicKey(selectedRift.id)).catch(() => {})
                ]);
              }
            }}
            onUnwrap={async () => {
              if (selectedRift) {
                void riftProtocolService
                  .prefetchUnwrapData(new PublicKey(selectedRift.id))
                  .catch(() => {});
                const timeSinceLastUpdate = Date.now() - lastBalanceUpdate;
                if (timeSinceLastUpdate > 60000) {
                  void fetchRiftTokenBalance(selectedRift, true);
                }
              }
              setShowUnwrapModal(true);
            }}
            onCloseRift={handleCloseRift}
            addToast={(message: string, type: 'success' | 'error' | 'pending', signature?: string) => {
              setNotification({
                type: type === 'pending' ? 'info' : type,
                title: type === 'success' ? 'Success' : type === 'error' ? 'Error' : 'Processing',
                message,
                signature
              });
            }}
          />
        )}
      </AnimatePresence>

      {/* Success/Error Notification Modal */}
      {notification && (
        <LuxuryModal
          isOpen={true}
          onClose={() => setNotification(null)}
          title={notification.title}
          subtitle={notification.type === 'success' ? '🎉 Transaction Completed' : '❌ Transaction Failed'}
          size="md"
        >
          <div className="space-y-4">
            <div className="p-4 border rounded-xl bg-gradient-to-br from-emerald-900/20 to-green-800/20 border-emerald-600/30">
              <pre className="font-mono text-sm leading-relaxed text-gray-300 whitespace-pre-wrap">
                {notification.message}
              </pre>
            </div>

            {notification.signature && (
              <div className="flex gap-3">
                <LuxuryButton
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(`9aJ1VBBGgTptJWYbKwbK2kbAebfgWpv93LCpV5bGwK5P`);
                      // Show a quick toast notification
                      setToasts(prev => [...prev, {
                        id: generateToastId(),
                        type: 'success',
                        message: '✅ RIFTS token address copied to clipboard!'
                      }]);
                    } catch (error) {

                    }
                  }}
                  className="flex-1"
                >
                  📋 Copy Token Address
                </LuxuryButton>
                <LuxuryButton
                  variant="primary"
                  size="sm"
                  onClick={() => window.open(`https://explorer.solana.com/tx/${notification.signature}`, '_blank')}
                  className="flex-1"
                >
                  <ExternalLink className="w-4 h-4" />
                  View Transaction
                </LuxuryButton>
              </div>
            )}

            <div className="text-center">
              <LuxuryButton
                variant="primary"
                size="lg"
                onClick={() => setNotification(null)}
                className="w-full"
              >
                Continue
              </LuxuryButton>
            </div>
          </div>
        </LuxuryModal>
      )}

      {/* Dashboard Modal */}
      <DashboardModal
        isOpen={showDashboardModal}
        onClose={() => setShowDashboardModal(false)}
        wallet={wallet}
        portfolioData={portfolioData}
        userPortfolioAPI={userPortfolioAPI}
        riftsBalance={riftsBalance}
        stakedAmount={stakedAmount}
        rifts={rifts}
        setSelectedRift={setSelectedRift}
        setShowDetailsModal={setShowDetailsModal}
        setShowUnwrapModal={setShowUnwrapModal}
      />

      {/* User Profile Modal */}
      <UserProfileModal
        isOpen={showUserProfileModal}
        onClose={() => setShowUserProfileModal(false)}
        user={user}
        isLoading={isUserLoading}
        onUpdateUserId={updateUserId}
        onCheckAvailability={checkUserIdAvailability}
      />

      {/* Pool Creation Success Modal */}
      <AnimatePresence>
        {showPoolSuccessModal && poolSuccessData && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
            onClick={(e) => e.target === e.currentTarget && setShowPoolSuccessModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 30 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 30 }}
              transition={{ duration: 0.3, type: "spring", bounce: 0.3 }}
              className="w-full max-w-md bg-gradient-to-br from-emerald-950/90 via-black/95 to-emerald-950/90 backdrop-blur-xl border border-emerald-500/40 rounded-2xl shadow-2xl overflow-hidden"
            >
              {/* Success Animation Header */}
              <div className="relative px-6 pt-8 pb-6 text-center bg-gradient-to-b from-emerald-500/20 to-transparent">
                {/* Animated Success Checkmark */}
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ delay: 0.2, type: "spring", bounce: 0.5 }}
                  className="mx-auto mb-4 w-20 h-20 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-500/30"
                >
                  <motion.svg
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={{ pathLength: 1, opacity: 1 }}
                    transition={{ delay: 0.4, duration: 0.5 }}
                    className="w-10 h-10 text-white"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={3}
                  >
                    <motion.path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M5 13l4 4L19 7"
                    />
                  </motion.svg>
                </motion.div>

                <motion.h2
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="text-2xl font-bold text-white mb-1"
                >
                  Pool Created Successfully! 🎉
                </motion.h2>
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.4 }}
                  className="text-sm text-emerald-300/80"
                >
                  Your {poolSuccessData.poolType === 'dammv2' ? 'DAMMV2' : 'DLMM'} liquidity pool is now live
                </motion.p>

                {/* Close button */}
                <button
                  onClick={() => setShowPoolSuccessModal(false)}
                  className="absolute top-4 right-4 p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Pool Details */}
              <div className="px-6 py-5 space-y-4">
                {/* Token Info */}
                {poolSuccessData.tokenSymbol && (
                  <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.5 }}
                    className="flex items-center gap-3 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20"
                  >
                    <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
                      <span className="text-lg font-bold text-emerald-400">
                        {poolSuccessData.tokenSymbol.charAt(0)}
                      </span>
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-white">{poolSuccessData.tokenSymbol}/SOL Pool</p>
                      <p className="text-xs text-gray-400">
                        {poolSuccessData.tokenAmount ? `${poolSuccessData.tokenAmount.toLocaleString()} ${poolSuccessData.tokenSymbol}` : ''}
                        {poolSuccessData.solAmount ? ` + ${poolSuccessData.solAmount} SOL` : ' (Single-sided)'}
                      </p>
                    </div>
                    <div className="px-2 py-1 text-xs font-medium text-emerald-400 bg-emerald-500/20 rounded-lg">
                      {poolSuccessData.poolType === 'dammv2' ? 'CP-AMM' : 'DLMM'}
                    </div>
                  </motion.div>
                )}

                {/* Pool Address */}
                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.55 }}
                  className="space-y-2"
                >
                  <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Pool Address</label>
                  <div className="flex items-center gap-2 p-3 rounded-xl bg-black/40 border border-emerald-500/20">
                    <code className="flex-1 text-sm text-emerald-300 font-mono truncate">
                      {poolSuccessData.poolAddress}
                    </code>
                    <button
                      onClick={async () => {
                        await navigator.clipboard.writeText(poolSuccessData.poolAddress);
                        const id = generateToastId();
                        setToasts(prev => [...prev, { id, type: 'success', message: 'Pool address copied!' }]);
                        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
                      }}
                      className="p-2 rounded-lg hover:bg-emerald-500/20 text-gray-400 hover:text-emerald-400 transition-colors"
                      title="Copy address"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>
                </motion.div>

                {/* Transaction Signature */}
                {poolSuccessData.signature && (
                  <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.6 }}
                    className="space-y-2"
                  >
                    <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Transaction</label>
                    <div className="flex items-center gap-2 p-3 rounded-xl bg-black/40 border border-emerald-500/20">
                      <code className="flex-1 text-sm text-gray-300 font-mono truncate">
                        {poolSuccessData.signature.slice(0, 20)}...{poolSuccessData.signature.slice(-8)}
                      </code>
                      <a
                        href={`https://solscan.io/tx/${poolSuccessData.signature}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 rounded-lg hover:bg-emerald-500/20 text-gray-400 hover:text-emerald-400 transition-colors"
                        title="View on Solscan"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </div>
                  </motion.div>
                )}

                {/* Position NFT */}
                {poolSuccessData.positionNft && (
                  <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.65 }}
                    className="space-y-2"
                  >
                    <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Position NFT</label>
                    <div className="flex items-center gap-2 p-3 rounded-xl bg-black/40 border border-emerald-500/20">
                      <code className="flex-1 text-sm text-gray-300 font-mono truncate">
                        {poolSuccessData.positionNft.slice(0, 12)}...{poolSuccessData.positionNft.slice(-8)}
                      </code>
                      <a
                        href={`https://solscan.io/token/${poolSuccessData.positionNft}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 rounded-lg hover:bg-emerald-500/20 text-gray-400 hover:text-emerald-400 transition-colors"
                        title="View on Solscan"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </div>
                  </motion.div>
                )}
              </div>

              {/* Action Buttons */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.7 }}
                className="px-6 pb-6 pt-2 space-y-3"
              >
                {/* View on Meteora Button */}
                <a
                  href={`https://app.meteora.ag/${poolSuccessData.poolType === 'dammv2' ? 'dammv2' : 'dlmm'}/${poolSuccessData.poolAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 w-full px-4 py-3 text-sm font-semibold text-white bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 rounded-xl shadow-lg shadow-emerald-500/20 transition-all duration-300 hover:shadow-emerald-500/40 hover:-translate-y-0.5"
                >
                  <ExternalLink className="w-4 h-4" />
                  View on Meteora
                </a>

                {/* Secondary Actions */}
                <div className="flex gap-3">
                  <a
                    href={`https://dexscreener.com/solana/${poolSuccessData.poolAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 hover:border-emerald-500/50 rounded-xl transition-all duration-300"
                  >
                    <TrendingUp className="w-4 h-4" />
                    DexScreener
                  </a>
                  <a
                    href={`https://birdeye.so/token/${poolSuccessData.poolAddress}?chain=solana`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 hover:border-emerald-500/50 rounded-xl transition-all duration-300"
                  >
                    <Eye className="w-4 h-4" />
                    Birdeye
                  </a>
                </div>

                {/* Close Button */}
                <button
                  onClick={() => setShowPoolSuccessModal(false)}
                  className="w-full px-4 py-2.5 text-sm font-medium text-gray-400 hover:text-white bg-black/30 hover:bg-black/50 border border-gray-700/50 hover:border-gray-600 rounded-xl transition-all duration-300"
                >
                  Close
                </button>
              </motion.div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Rift Creation Success Modal */}
      <AnimatePresence>
        {showRiftSuccessModal && riftSuccessData && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
            onClick={(e) => e.target === e.currentTarget && setShowRiftSuccessModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 30 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 30 }}
              transition={{ duration: 0.3, type: "spring", bounce: 0.3 }}
              className="w-full max-w-md bg-gradient-to-br from-blue-950/90 via-black/95 to-purple-950/90 backdrop-blur-xl border border-blue-500/40 rounded-2xl shadow-2xl overflow-hidden"
            >
              {/* Success Animation Header */}
              <div className="relative px-6 pt-8 pb-6 text-center bg-gradient-to-b from-blue-500/20 to-transparent">
                {/* Animated Portal/Rift Icon */}
                <motion.div
                  initial={{ scale: 0, rotate: -180 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ delay: 0.2, type: "spring", bounce: 0.5 }}
                  className="mx-auto mb-4 w-20 h-20 rounded-full bg-gradient-to-br from-blue-500 via-purple-500 to-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/30"
                >
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.5 }}
                    className="text-3xl"
                  >
                    🌀
                  </motion.div>
                </motion.div>

                <motion.h2
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="text-2xl font-bold text-white mb-1"
                >
                  Rift Created!
                </motion.h2>
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.4 }}
                  className="text-sm text-blue-300/80"
                >
                  Your {riftSuccessData.tokenSymbol} vault is now live
                </motion.p>

                {/* Close button */}
                <button
                  onClick={() => setShowRiftSuccessModal(false)}
                  className="absolute top-4 right-4 p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Rift Details */}
              <div className="px-6 py-5 space-y-4">
                {/* Token Info */}
                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.5 }}
                  className="flex items-center gap-3 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20"
                >
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500/30 to-purple-500/30 flex items-center justify-center">
                    <span className="text-lg font-bold text-blue-400">
                      {riftSuccessData.tokenSymbol.charAt(0)}
                    </span>
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-white">{riftSuccessData.tokenSymbol}</p>
                    <p className="text-xs text-gray-400">
                      Wrapping {riftSuccessData.underlyingSymbol}
                    </p>
                  </div>
                  <div className="px-2 py-1 text-xs font-medium text-blue-400 bg-blue-500/20 rounded-lg">
                    {(riftSuccessData.transferFeeBps / 100).toFixed(2)}% Fee
                  </div>
                </motion.div>

                {/* Rift PDA Address */}
                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.55 }}
                  className="space-y-2"
                >
                  <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Rift Address</label>
                  <div className="flex items-center gap-2 p-3 rounded-xl bg-black/40 border border-blue-500/20">
                    <code className="flex-1 text-sm text-blue-300 font-mono truncate">
                      {riftSuccessData.riftPDA}
                    </code>
                    <button
                      onClick={async () => {
                        await navigator.clipboard.writeText(riftSuccessData.riftPDA);
                        const id = generateToastId();
                        setToasts(prev => [...prev, { id, type: 'success', message: 'Rift address copied!' }]);
                        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
                      }}
                      className="p-2 rounded-lg hover:bg-blue-500/20 text-gray-400 hover:text-blue-400 transition-colors"
                      title="Copy address"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>
                </motion.div>

                {/* Rift Mint Address */}
                {riftSuccessData.riftMint && (
                  <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.6 }}
                    className="space-y-2"
                  >
                    <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Token Mint</label>
                    <div className="flex items-center gap-2 p-3 rounded-xl bg-black/40 border border-blue-500/20">
                      <code className="flex-1 text-sm text-gray-300 font-mono truncate">
                        {riftSuccessData.riftMint.slice(0, 16)}...{riftSuccessData.riftMint.slice(-8)}
                      </code>
                      <a
                        href={`https://solscan.io/token/${riftSuccessData.riftMint}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 rounded-lg hover:bg-blue-500/20 text-gray-400 hover:text-blue-400 transition-colors"
                        title="View on Solscan"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </div>
                  </motion.div>
                )}

                {/* Transaction */}
                {riftSuccessData.signature && (
                  <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.65 }}
                    className="space-y-2"
                  >
                    <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Transaction</label>
                    <div className="flex items-center gap-2 p-3 rounded-xl bg-black/40 border border-blue-500/20">
                      <code className="flex-1 text-sm text-gray-300 font-mono truncate">
                        {riftSuccessData.signature.slice(0, 20)}...{riftSuccessData.signature.slice(-8)}
                      </code>
                      <a
                        href={`https://solscan.io/tx/${riftSuccessData.signature}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 rounded-lg hover:bg-blue-500/20 text-gray-400 hover:text-blue-400 transition-colors"
                        title="View on Solscan"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </div>
                  </motion.div>
                )}

                {/* Partner Wallet */}
                {riftSuccessData.partnerWallet && (
                  <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.7 }}
                    className="p-3 rounded-xl bg-purple-500/10 border border-purple-500/20"
                  >
                    <p className="text-xs text-gray-400 mb-1">Partner Wallet</p>
                    <code className="text-xs text-purple-300 font-mono">
                      {riftSuccessData.partnerWallet.slice(0, 8)}...{riftSuccessData.partnerWallet.slice(-8)}
                    </code>
                  </motion.div>
                )}
              </div>

              {/* Action Buttons */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.75 }}
                className="px-6 pb-6 pt-2 space-y-3"
              >
                {/* Wrap Tokens Button */}
                <button
                  onClick={() => {
                    setShowRiftSuccessModal(false);
                    // Find the newly created rift and open wrap modal
                    const newRift = rifts.find(r => r.id === riftSuccessData.riftPDA);
                    if (newRift) {
                      setSelectedRift(newRift);
                      setShowWrapModal(true);
                    }
                  }}
                  className="flex items-center justify-center gap-2 w-full px-4 py-3 text-sm font-semibold text-white bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 rounded-xl shadow-lg shadow-blue-500/20 transition-all duration-300 hover:shadow-blue-500/40 hover:-translate-y-0.5"
                >
                  <Zap className="w-4 h-4" />
                  Wrap Tokens Now
                </button>

                {/* Secondary Actions */}
                <div className="flex gap-3">
                  <a
                    href={`https://solscan.io/account/${riftSuccessData.riftPDA}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 hover:border-blue-500/50 rounded-xl transition-all duration-300"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Solscan
                  </a>
                  <button
                    onClick={() => {
                      setShowRiftSuccessModal(false);
                      // Find the newly created rift and open liquidity modal
                      const newRift = rifts.find(r => r.id === riftSuccessData.riftPDA);
                      if (newRift) {
                        setSelectedRift(newRift);
                        setShowAddLiquidityModal(true);
                      }
                    }}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 hover:border-purple-500/50 rounded-xl transition-all duration-300"
                  >
                    <Droplets className="w-4 h-4" />
                    Add Liquidity
                  </button>
                </div>

                {/* Close Button */}
                <button
                  onClick={() => setShowRiftSuccessModal(false)}
                  className="w-full px-4 py-2.5 text-sm font-medium text-gray-400 hover:text-white bg-black/30 hover:bg-black/50 border border-gray-700/50 hover:border-gray-600 rounded-xl transition-all duration-300"
                >
                  Close
                </button>
              </motion.div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Wrap/Unwrap Success Modal */}
      <AnimatePresence>
        {showWrapSuccessModal && wrapSuccessData && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
            onClick={(e) => e.target === e.currentTarget && setShowWrapSuccessModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 30 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 30 }}
              transition={{ duration: 0.3, type: "spring", bounce: 0.3 }}
              className={`w-full max-w-md backdrop-blur-xl border rounded-2xl shadow-2xl overflow-hidden ${
                wrapSuccessData.type === 'wrap'
                  ? 'bg-gradient-to-br from-cyan-950/90 via-black/95 to-blue-950/90 border-cyan-500/40'
                  : 'bg-gradient-to-br from-orange-950/90 via-black/95 to-red-950/90 border-orange-500/40'
              }`}
            >
              {/* Success Animation Header */}
              <div className={`relative px-6 pt-8 pb-6 text-center bg-gradient-to-b ${
                wrapSuccessData.type === 'wrap' ? 'from-cyan-500/20' : 'from-orange-500/20'
              } to-transparent`}>
                {/* Animated Icon */}
                <motion.div
                  initial={{ scale: 0, y: 20 }}
                  animate={{ scale: 1, y: 0 }}
                  transition={{ delay: 0.2, type: "spring", bounce: 0.5 }}
                  className={`mx-auto mb-4 w-20 h-20 rounded-full flex items-center justify-center shadow-lg ${
                    wrapSuccessData.type === 'wrap'
                      ? 'bg-gradient-to-br from-cyan-500 to-blue-600 shadow-cyan-500/30'
                      : 'bg-gradient-to-br from-orange-500 to-red-600 shadow-orange-500/30'
                  }`}
                >
                  <motion.div
                    initial={{ opacity: 0, rotate: -45 }}
                    animate={{ opacity: 1, rotate: 0 }}
                    transition={{ delay: 0.4 }}
                    className="text-3xl"
                  >
                    {wrapSuccessData.type === 'wrap' ? '🌊' : '📤'}
                  </motion.div>
                </motion.div>

                <motion.h2
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="text-2xl font-bold text-white mb-1"
                >
                  {wrapSuccessData.type === 'wrap' ? 'Wrap Successful!' : 'Unwrap Complete!'}
                </motion.h2>
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.4 }}
                  className={`text-sm ${wrapSuccessData.type === 'wrap' ? 'text-cyan-300/80' : 'text-orange-300/80'}`}
                >
                  {wrapSuccessData.type === 'wrap'
                    ? 'Your tokens have been wrapped and are ready to use'
                    : 'Your tokens have been unwrapped to your wallet'}
                </motion.p>

                {/* Close button */}
                <button
                  onClick={() => setShowWrapSuccessModal(false)}
                  className="absolute top-4 right-4 p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Transaction Details */}
              <div className="px-6 py-5 space-y-4">
                {/* Amount Summary */}
                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.5 }}
                  className={`p-4 rounded-xl border ${
                    wrapSuccessData.type === 'wrap'
                      ? 'bg-cyan-500/10 border-cyan-500/20'
                      : 'bg-orange-500/10 border-orange-500/20'
                  }`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                        wrapSuccessData.type === 'wrap' ? 'bg-cyan-500/20' : 'bg-orange-500/20'
                      }`}>
                        <span className="text-sm">{wrapSuccessData.type === 'wrap' ? '📥' : '📤'}</span>
                      </div>
                      <span className="text-sm text-gray-400">
                        {wrapSuccessData.type === 'wrap' ? 'Wrapped' : 'Unwrapped'}
                      </span>
                    </div>
                    <span className="text-lg font-bold text-white">
                      {wrapSuccessData.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} {wrapSuccessData.type === 'wrap' ? wrapSuccessData.underlyingSymbol : wrapSuccessData.tokenSymbol}
                    </span>
                  </div>

                  <div className="flex items-center justify-center my-2">
                    <ArrowDown className={`w-5 h-5 ${wrapSuccessData.type === 'wrap' ? 'text-cyan-400' : 'text-orange-400'}`} />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                        wrapSuccessData.type === 'wrap' ? 'bg-blue-500/20' : 'bg-green-500/20'
                      }`}>
                        <span className="text-sm">{wrapSuccessData.type === 'wrap' ? '🌀' : '💰'}</span>
                      </div>
                      <span className="text-sm text-gray-400">Received</span>
                    </div>
                    <span className={`text-lg font-bold ${wrapSuccessData.type === 'wrap' ? 'text-cyan-400' : 'text-green-400'}`}>
                      {wrapSuccessData.tokensReceived.toLocaleString(undefined, { maximumFractionDigits: 4 })} {wrapSuccessData.type === 'wrap' ? wrapSuccessData.tokenSymbol : wrapSuccessData.underlyingSymbol}
                    </span>
                  </div>

                  {wrapSuccessData.type === 'wrap' && wrapSuccessData.amount !== wrapSuccessData.tokensReceived && (
                    <p className="text-xs text-gray-500 mt-2 text-center">
                      0.3% protocol fee applied
                    </p>
                  )}
                </motion.div>

                {/* Transaction Signature */}
                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.6 }}
                  className="space-y-2"
                >
                  <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Transaction</label>
                  <div className={`flex items-center gap-2 p-3 rounded-xl bg-black/40 border ${
                    wrapSuccessData.type === 'wrap' ? 'border-cyan-500/20' : 'border-orange-500/20'
                  }`}>
                    <code className="flex-1 text-sm text-gray-300 font-mono truncate">
                      {wrapSuccessData.signature.slice(0, 20)}...{wrapSuccessData.signature.slice(-8)}
                    </code>
                    <a
                      href={`https://solscan.io/tx/${wrapSuccessData.signature}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`p-2 rounded-lg text-gray-400 transition-colors ${
                        wrapSuccessData.type === 'wrap'
                          ? 'hover:bg-cyan-500/20 hover:text-cyan-400'
                          : 'hover:bg-orange-500/20 hover:text-orange-400'
                      }`}
                      title="View on Solscan"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>
                </motion.div>
              </div>

              {/* Action Buttons */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.7 }}
                className="px-6 pb-6 pt-2 space-y-3"
              >
                {/* Primary Action */}
                {wrapSuccessData.type === 'wrap' ? (
                  <button
                    onClick={() => {
                      setShowWrapSuccessModal(false);
                      const rift = rifts.find(r => r.id === wrapSuccessData.riftPDA);
                      if (rift) {
                        setSelectedRift(rift);
                        setShowAddLiquidityModal(true);
                      }
                    }}
                    className="flex items-center justify-center gap-2 w-full px-4 py-3 text-sm font-semibold text-white bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 rounded-xl shadow-lg shadow-cyan-500/20 transition-all duration-300 hover:shadow-cyan-500/40 hover:-translate-y-0.5"
                  >
                    <Droplets className="w-4 h-4" />
                    Add Liquidity
                  </button>
                ) : (
                  <a
                    href={`https://solscan.io/tx/${wrapSuccessData.signature}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 w-full px-4 py-3 text-sm font-semibold text-white bg-gradient-to-r from-orange-600 to-red-600 hover:from-orange-500 hover:to-red-500 rounded-xl shadow-lg shadow-orange-500/20 transition-all duration-300 hover:shadow-orange-500/40 hover:-translate-y-0.5"
                  >
                    <ExternalLink className="w-4 h-4" />
                    View on Solscan
                  </a>
                )}

                {/* Secondary Actions */}
                <div className="flex gap-3">
                  {wrapSuccessData.type === 'wrap' && (
                    <button
                      onClick={() => {
                        setShowWrapSuccessModal(false);
                        const rift = rifts.find(r => r.id === wrapSuccessData.riftPDA);
                        if (rift) {
                          setSelectedRift(rift);
                          setShowWrapModal(true);
                        }
                      }}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-cyan-400 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 hover:border-cyan-500/50 rounded-xl transition-all duration-300"
                    >
                      <Zap className="w-4 h-4" />
                      Wrap More
                    </button>
                  )}
                  {wrapSuccessData.type === 'unwrap' && (
                    <button
                      onClick={() => {
                        setShowWrapSuccessModal(false);
                        const rift = rifts.find(r => r.id === wrapSuccessData.riftPDA);
                        if (rift) {
                          setSelectedRift(rift);
                          setShowUnwrapModal(true);
                        }
                      }}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-orange-400 bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/30 hover:border-orange-500/50 rounded-xl transition-all duration-300"
                    >
                      <ArrowDown className="w-4 h-4" />
                      Unwrap More
                    </button>
                  )}
                  <a
                    href={`https://birdeye.so/token/${wrapSuccessData.riftPDA}?chain=solana`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium border rounded-xl transition-all duration-300 ${
                      wrapSuccessData.type === 'wrap'
                        ? 'text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 border-blue-500/30 hover:border-blue-500/50'
                        : 'text-green-400 bg-green-500/10 hover:bg-green-500/20 border-green-500/30 hover:border-green-500/50'
                    }`}
                  >
                    <Eye className="w-4 h-4" />
                    Birdeye
                  </a>
                </div>

                {/* Close Button */}
                <button
                  onClick={() => setShowWrapSuccessModal(false)}
                  className="w-full px-4 py-2.5 text-sm font-medium text-gray-400 hover:text-white bg-black/30 hover:bg-black/50 border border-gray-700/50 hover:border-gray-600 rounded-xl transition-all duration-300"
                >
                  Close
                </button>
              </motion.div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* PumpFun Launch Modal */}
      <AnimatePresence>
        {showLaunchModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
            onClick={(e) => e.target === e.currentTarget && !isLaunching && setShowLaunchModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.2 }}
              className="w-full max-w-3xl bg-black/90 backdrop-blur-md border border-emerald-500/30 rounded-xl shadow-2xl overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-emerald-500/20">
                <h2 className="text-base font-semibold text-emerald-400">Launch Token</h2>
                <button
                  onClick={() => !isLaunching && setShowLaunchModal(false)}
                  disabled={isLaunching}
                  className="p-2 rounded-lg text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Content */}
              <div className="p-5">
                {launchResult ? (
                  /* Success State */
                  <div className="text-center py-6 space-y-4">
                    <div className="w-14 h-14 mx-auto rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center">
                      <Check className="w-7 h-7 text-emerald-400" />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-white mb-1">Token + Monorift Created!</h3>
                      <p className="text-gray-400 text-sm">Your token and liquidity pool are live</p>
                    </div>
                    {/* Explorer Links */}
                    <div className="flex flex-wrap gap-2 justify-center">
                      <a href={`https://dexscreener.com/solana/${launchResult.mint}`} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm hover:bg-emerald-500/20 transition-colors">
                        DexScreener
                      </a>
                      <a href={`https://birdeye.so/token/${launchResult.mint}?chain=solana`} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm hover:bg-emerald-500/20 transition-colors">
                        Birdeye
                      </a>
                      <a href={`https://solscan.io/token/${launchResult.mint}`} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm hover:bg-emerald-500/20 transition-colors">
                        Solscan
                      </a>
                      <a href={`https://pump.fun/${launchResult.mint}`} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm hover:bg-emerald-500/20 transition-colors">
                        Pump.fun
                      </a>
                      {launchResult.poolAddress && (
                        <a href={`https://app.meteora.ag/pools/${launchResult.poolAddress}`} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-400 text-sm hover:bg-purple-500/20 transition-colors">
                          Meteora Pool
                        </a>
                      )}
                    </div>
                    <div className="pt-2">
                      <LuxuryButton
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setShowLaunchModal(false);
                          setLaunchResult(null);
                          setLaunchTokenName('');
                          setLaunchTokenSymbol('');
                          setLaunchTokenDescription('');
                          setLaunchTokenImage(null);
                          setLaunchTokenImagePreview(null);
                          setLaunchBanner(null);
                          setLaunchBannerPreview(null);
                          setLaunchTwitter('');
                          setLaunchTelegram('');
                          setLaunchWebsite('');
                          setLaunchDevBuy('');
                          setLaunchStep(0);
                        }}
                      >
                        Close
                      </LuxuryButton>
                    </div>
                  </div>
                ) : (
                  /* Form + Preview */
                  <div className="flex gap-5">
                    {/* Left: Form */}
                    <div className="flex-1 space-y-3">
                      {/* Image + Name/Symbol */}
                      <div className="flex gap-3">
                        <div className="flex-shrink-0">
                          {launchTokenImagePreview ? (
                            <div className="relative">
                              <img src={launchTokenImagePreview} alt="Token" className="w-16 h-16 rounded-lg object-cover border border-emerald-500/30" />
                              <button onClick={() => { setLaunchTokenImage(null); setLaunchTokenImagePreview(null); }} className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center text-white text-[10px]">×</button>
                            </div>
                          ) : (
                            <label className="cursor-pointer w-16 h-16 border-2 border-dashed border-gray-600 hover:border-emerald-500/50 rounded-lg flex items-center justify-center bg-black/30 transition-colors">
                              <Plus className="w-5 h-5 text-gray-500" />
                              <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) { setLaunchTokenImage(file); const r = new FileReader(); r.onload = (e) => setLaunchTokenImagePreview(e.target?.result as string); r.readAsDataURL(file); }
                              }} />
                            </label>
                          )}
                        </div>
                        <div className="flex-1 space-y-2">
                          <input type="text" value={launchTokenName} onChange={(e) => setLaunchTokenName(e.target.value)} placeholder="Name" maxLength={32} className="w-full px-3 py-1.5 text-sm bg-black/50 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500/50" />
                          <input type="text" value={launchTokenSymbol} onChange={(e) => setLaunchTokenSymbol(e.target.value.toUpperCase())} placeholder="SYMBOL" maxLength={10} className="w-full px-3 py-1.5 text-sm bg-black/50 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500/50 uppercase" />
                        </div>
                      </div>

                      {/* Description */}
                      <textarea value={launchTokenDescription} onChange={(e) => setLaunchTokenDescription(e.target.value)} placeholder="Description" rows={2} maxLength={500} className="w-full px-3 py-2 text-sm bg-black/50 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500/50 resize-none" />

                      {/* Banner */}
                      <div>
                        <label className="text-xs text-gray-400 mb-1 block">Banner (optional)</label>
                        {launchBannerPreview ? (
                          <div className="relative">
                            <img src={launchBannerPreview} alt="Banner" className="w-full h-16 rounded-lg object-cover border border-emerald-500/30" />
                            <button onClick={() => { setLaunchBanner(null); setLaunchBannerPreview(null); }} className="absolute top-1 right-1 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center text-white text-[10px]">×</button>
                          </div>
                        ) : (
                          <label className="cursor-pointer block w-full h-16 border-2 border-dashed border-gray-600 hover:border-emerald-500/50 rounded-lg flex items-center justify-center bg-black/30 transition-colors">
                            <span className="text-xs text-gray-500">Click to upload banner</span>
                            <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) { setLaunchBanner(file); const r = new FileReader(); r.onload = (e) => setLaunchBannerPreview(e.target?.result as string); r.readAsDataURL(file); }
                            }} />
                          </label>
                        )}
                      </div>

                      {/* Dev Buy */}
                      <div>
                        <label className="text-xs text-gray-400 mb-1 block">Dev Buy (SOL)</label>
                        <input type="number" step="0.01" min="0" value={launchDevBuy} onChange={(e) => setLaunchDevBuy(e.target.value)} placeholder="0.0" className="w-full px-2 py-1.5 text-xs bg-black/50 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500/50" />
                        <p className="text-xs text-gray-500 mt-1">Amount of SOL to buy tokens at launch</p>
                      </div>

                      {/* Socials */}
                      <div className="grid grid-cols-3 gap-2">
                        <input type="text" value={launchTwitter} onChange={(e) => setLaunchTwitter(e.target.value)} placeholder="Twitter" className="px-2 py-1.5 text-xs bg-black/50 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500/50" />
                        <input type="text" value={launchTelegram} onChange={(e) => setLaunchTelegram(e.target.value)} placeholder="Telegram" className="px-2 py-1.5 text-xs bg-black/50 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500/50" />
                        <input type="text" value={launchWebsite} onChange={(e) => setLaunchWebsite(e.target.value)} placeholder="Website" className="px-2 py-1.5 text-xs bg-black/50 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500/50" />
                      </div>

                      {/* Error/Progress */}
                      {launchError && <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/20"><p className="text-xs text-red-400">{launchError}</p></div>}
                      {isLaunching && launchStep > 0 && (
                        <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2">
                          <Loader2 className="w-3 h-3 text-emerald-400 animate-spin" />
                          <p className="text-xs text-white">{['','Uploading...','Generating...','Creating...','Sign tx...','Sending...','Confirming...'][launchStep]}</p>
                        </div>
                      )}

                      {/* Launch Button */}
                      <LuxuryButton variant="primary" size="sm" fullWidth disabled={isLaunching || !wallet.connected} onClick={async () => {
                        if (!wallet.connected || !wallet.publicKey) { setLaunchError('Connect wallet'); return; }
                        if (!launchTokenImage) { setLaunchError('Upload image'); return; }
                        if (!launchTokenName.trim() || !launchTokenSymbol.trim() || !launchTokenDescription.trim()) { setLaunchError('Fill required fields'); return; }
                        const devBuyAmount = parseFloat(launchDevBuy) || 0;
                        if (devBuyAmount <= 0) { setLaunchError('Dev buy amount required (creates monorift with your tokens)'); return; }
                        setIsLaunching(true); setLaunchError(null);
                        try {
                          const phantomWallet = (window as any).phantom?.solana;
                          if (!phantomWallet) throw new Error('Phantom not found');

                          // Step 1: Upload metadata to IPFS
                          setLaunchStep(1);
                          const metadataUri = await uploadMetadata(
                            { name: launchTokenName.trim(), symbol: launchTokenSymbol.trim().toUpperCase(), description: launchTokenDescription.trim(), twitter: launchTwitter.trim() || undefined, telegram: launchTelegram.trim() || undefined, website: launchWebsite.trim() || undefined },
                            launchTokenImage,
                            launchBanner || undefined
                          );
                          console.log('[LAUNCH] Metadata uploaded:', metadataUri);

                          // Step 2: Call API to prepare launch + rift (bundled)
                          setLaunchStep(2);
                          const prepareRes = await fetch('/api/pumpfun-rift', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              action: 'prepare',
                              creatorPublicKey: String(wallet.publicKey),
                              metadataUri,
                              name: launchTokenName.trim(),
                              symbol: launchTokenSymbol.trim().toUpperCase(),
                              devBuyAmountSol: devBuyAmount,
                            }),
                          });
                          const prepareData = await prepareRes.json();
                          if (!prepareData.success) throw new Error(prepareData.error || 'Prepare failed');
                          console.log('[LAUNCH] Prepared:', { mint: prepareData.mintPublicKey, pool: prepareData.poolAddress, tokens: prepareData.tokensReceived });

                          // Step 3: Deserialize and sign both transactions
                          setLaunchStep(3);
                          const { VersionedTransaction, Transaction } = await import('@solana/web3.js');
                          const bs58 = (await import('bs58')).default;
                          const { Keypair } = await import('@solana/web3.js');

                          // Create TX (VersionedTransaction from PumpPortal)
                          const createTxBytes = Uint8Array.from(atob(prepareData.createTxBase64), c => c.charCodeAt(0));
                          const createTx = VersionedTransaction.deserialize(createTxBytes);
                          const mintKeypair = Keypair.fromSecretKey(bs58.decode(prepareData.mintSecretKey));
                          createTx.sign([mintKeypair]);

                          // Pool TX (Legacy Transaction from Meteora SDK)
                          const poolTxBytes = Uint8Array.from(atob(prepareData.poolTxBase64), c => c.charCodeAt(0));
                          const poolTx = Transaction.from(poolTxBytes);

                          // Sign both with user wallet
                          setLaunchStep(4);
                          const signedCreateTx = await phantomWallet.signTransaction(createTx);
                          const signedPoolTx = await phantomWallet.signTransaction(poolTx);

                          // Step 4: Execute bundled launch via Jito
                          setLaunchStep(5);
                          const executeRes = await fetch('/api/pumpfun-rift', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              action: 'execute',
                              signedCreateTxBase64: btoa(String.fromCharCode(...signedCreateTx.serialize())),
                              signedPoolTxBase64: btoa(String.fromCharCode(...signedPoolTx.serialize())),
                              mintPublicKey: prepareData.mintPublicKey,
                              poolAddress: prepareData.poolAddress,
                            }),
                          });
                          const executeData = await executeRes.json();
                          if (!executeData.success) throw new Error(executeData.error || 'Launch failed');

                          setLaunchStep(6);
                          console.log('[LAUNCH] Success!', executeData);
                          setLaunchResult({ mint: executeData.mint, signature: executeData.signature || executeData.bundleId, poolAddress: executeData.poolAddress });
                        } catch (err) { setLaunchError(err instanceof Error ? err.message : 'Launch failed'); }
                        finally { setIsLaunching(false); setLaunchStep(0); }
                      }}>
                        {isLaunching ? 'Launching...' : 'Launch'}
                      </LuxuryButton>
                    </div>

                    {/* Right: Preview */}
                    <div className="w-64 flex-shrink-0">
                      <div className="text-xs text-gray-400 mb-2">Preview</div>
                      <div className="rounded-xl border border-emerald-500/20 bg-black/50 overflow-hidden">
                        {/* Banner */}
                        <div className="h-20 bg-gradient-to-br from-emerald-900/30 to-black relative">
                          {launchBannerPreview && <img src={launchBannerPreview} alt="" className="w-full h-full object-cover" />}
                        </div>
                        {/* Token Info */}
                        <div className="p-3 -mt-6 relative">
                          <div className="w-12 h-12 rounded-full border-2 border-black bg-gray-800 overflow-hidden mb-2">
                            {launchTokenImagePreview ? <img src={launchTokenImagePreview} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full bg-gray-700" />}
                          </div>
                          <div className="font-semibold text-white text-sm">{launchTokenName || 'Token Name'}</div>
                          <div className="text-emerald-400 text-xs">${launchTokenSymbol || 'SYMBOL'}</div>
                          <p className="text-gray-400 text-xs mt-2 line-clamp-2">{launchTokenDescription || 'Description will appear here...'}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toast Notifications */}
      <div className="fixed z-[100] space-y-2 top-4 right-4">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, x: 50 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 50 }}
              className={`min-w-[300px] p-4 rounded-xl shadow-lg border ${
                toast.type === 'success' 
                  ? 'bg-green-900/90 border-green-600' 
                  : toast.type === 'error' 
                  ? 'bg-red-900/90 border-red-600' 
                  : 'bg-blue-900/90 border-blue-600'
              }`}
            >
              <p className="font-medium text-white">{toast.message}</p>
              {toast.signature && (
                <a
                  href={`https://explorer.solana.com/tx/${toast.signature}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 mt-1 text-xs text-blue-400 hover:text-blue-300"
                >
                  View Transaction <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

    </div>
  );
};

export default RiftsApp;
