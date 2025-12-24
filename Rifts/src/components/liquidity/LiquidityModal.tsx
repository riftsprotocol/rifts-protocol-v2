'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { X, Plus, Minus, Info, Check, Loader2, Coins, Settings2, Copy, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { StrategyType as DLMMStrategyType } from '@/lib/solana/dlmm-liquidity-service';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_SOL_SUPPLY = 580_000_000; // Approx circulating SOL to fallback when supply API fails

// Copy to clipboard helper
const CopyableAddress: React.FC<{
  address: string;
  label?: string;
  short?: boolean;
}> = ({ address, label, short = true }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const displayAddress = short
    ? `${address.slice(0, 4)}...${address.slice(-4)}`
    : address;

  return (
    <div className="flex items-center gap-1.5 group">
      {label && <span className="text-gray-600 text-[10px]">{label}:</span>}
      <span className="font-mono text-gray-400 text-xs">{displayAddress}</span>
      <button
        onClick={handleCopy}
        className="p-0.5 rounded hover:bg-emerald-500/20 transition-colors opacity-50 group-hover:opacity-100"
        title="Copy address"
      >
        {copied ? (
          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
        ) : (
          <Copy className="w-3 h-3 text-gray-500 hover:text-emerald-400" />
        )}
      </button>
    </div>
  );
};

// DLMM Configuration Panel with Simplified UI - Exported for reuse
export const DLMMConfigPanel: React.FC<{
  dlmmStrategy: DLMMStrategyType;
  setDlmmStrategy: (strategy: DLMMStrategyType) => void;
  dlmmBinStep: string;
  setDlmmBinStep: (step: string) => void;
  dlmmRangeInterval: string;
  setDlmmRangeInterval: (interval: string) => void;
  dlmmFeeBps: string;
  setDlmmFeeBps: (fee: string) => void;
  currentPrice: number; // USD price
  currentPriceInSol?: number; // SOL price (calculated from USD)
  currentMcap?: number;
  underlyingMint?: string; // Main token mint address for auto-fetching supply
  singleSided: boolean;
  setSingleSided: (value: boolean) => void;
  // MCap range callback - passes calculated values to parent
  onMcapRangeChange?: (minMcap: number, maxMcap: number, supply: number, useCustomRange: boolean) => void;
  // Meteora pool info for fetching live price
  meteoraPoolAddress?: string;
  poolType?: 'cpamm' | 'dlmm';
  hideSingleSidedToggle?: boolean; // Hide the single-sided toggle (for monorifts where it's always single-sided)
  solPriceUSD?: number; // Current SOL price in USD for proper conversions
}> = ({
  dlmmStrategy,
  setDlmmStrategy,
  dlmmBinStep,
  setDlmmBinStep,
  dlmmRangeInterval,
  setDlmmRangeInterval,
  dlmmFeeBps,
  setDlmmFeeBps,
  currentPrice,
  currentPriceInSol = 0,
  currentMcap = 0,
  underlyingMint,
  singleSided,
  setSingleSided,
  onMcapRangeChange,
  meteoraPoolAddress,
  poolType,
  hideSingleSidedToggle = false,
  solPriceUSD = 0,
}) => {
  const [advancedMode, setAdvancedMode] = useState(false);
  const [priceRangePercent, setPriceRangePercent] = useState(50); // ±50% default
  const [useCustomRange, setUseCustomRange] = useState(true); // Default to Price mode
  const [customMinMcap, setCustomMinMcap] = useState('');
  const [customMaxMcap, setCustomMaxMcap] = useState('');
  const [mainTokenSupply, setMainTokenSupply] = useState(''); // Total supply of main token (e.g., 1B)
  const [isLoadingSupply, setIsLoadingSupply] = useState(false);
  const [autoFetchedSupply, setAutoFetchedSupply] = useState<number | null>(null);
  const [priceView, setPriceView] = useState<'USD' | 'SOL'>('USD'); // Toggle between USD and SOL
  const [customMinPriceSolInput, setCustomMinPriceSolInput] = useState('');
  const [customMaxPriceSolInput, setCustomMaxPriceSolInput] = useState('');
  const [meteoraPoolPrice, setMeteoraPoolPrice] = useState<number | null>(null);
  const [isLoadingPoolPrice, setIsLoadingPoolPrice] = useState(false);

  // Fetch Meteora pool price when pool address is available
  useEffect(() => {
    const fetchPoolPrice = async () => {
      if (!meteoraPoolAddress || !poolType) {
        setMeteoraPoolPrice(null);
        return;
      }

      setIsLoadingPoolPrice(true);
      try {
        const response = await fetch(`/api/meteora-pool-price?poolAddress=${meteoraPoolAddress}&poolType=${poolType}`);
        if (!response.ok) {
          setMeteoraPoolPrice(null);
          return;
        }

        const data = await response.json();
        setMeteoraPoolPrice(data.price || null);
      } catch (error) {
        setMeteoraPoolPrice(null);
      } finally {
        setIsLoadingPoolPrice(false);
      }
    };

    fetchPoolPrice();
  }, [meteoraPoolAddress, poolType]);

  // Hardcode SOL supply immediately for display when SOL is selected
  useEffect(() => {
    if (underlyingMint === WSOL_MINT) {
      setAutoFetchedSupply(DEFAULT_SOL_SUPPLY);
      setMainTokenSupply(`${(DEFAULT_SOL_SUPPLY / 1_000_000).toFixed(2)}M`);
    }
  }, [underlyingMint]);

  // Auto-fetch token supply when underlying mint is available
  useEffect(() => {
    const fetchTokenSupply = async () => {
      if (!underlyingMint || !useCustomRange) return;
      // For SOL, keep the hardcoded supply and skip network to avoid delays
      if (underlyingMint === WSOL_MINT) return;

      setIsLoadingSupply(true);
      try {
        console.log('[LIQUIDITY] Fetching token supply', underlyingMint);
        const response = await fetch(`/api/token-supply?mint=${underlyingMint}`);
        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          console.warn('[LIQUIDITY] Token supply fetch failed', response.status, errorBody);
          setAutoFetchedSupply(null);
          setMainTokenSupply('');
          return;
        }

        const data = await response.json();
        console.log('[LIQUIDITY] Token supply fetched', data);
        let supply = data.supply || 0;
        if (!supply && underlyingMint === WSOL_MINT) {
          // Hardcode SOL supply when RPC returns 0/missing
          supply = DEFAULT_SOL_SUPPLY;
        }
        setAutoFetchedSupply(supply);

        // Format the supply for display
        if (supply >= 1000000000) {
          setMainTokenSupply(`${(supply / 1000000000).toFixed(2)}B`);
        } else if (supply >= 1000000) {
          setMainTokenSupply(`${(supply / 1000000).toFixed(2)}M`);
        } else if (supply >= 1000) {
          setMainTokenSupply(`${(supply / 1000).toFixed(2)}K`);
        } else {
          setMainTokenSupply(supply.toString());
        }
      } catch (error) {
        console.error('Failed to fetch token supply:', error);
        if (underlyingMint === WSOL_MINT) {
          setAutoFetchedSupply(DEFAULT_SOL_SUPPLY);
          setMainTokenSupply(`${(DEFAULT_SOL_SUPPLY / 1000000).toFixed(2)}M`);
        }
      } finally {
        setIsLoadingSupply(false);
      }
    };

    fetchTokenSupply();
  }, [underlyingMint, useCustomRange]);

  // Calculate bin range based on price range percentage and current bin step
  // Bin step stays fixed (default 50), only range changes
  const calculateBinRange = (rangePercent: number, binStep: number) => {
    const priceMultiplier = 1 + rangePercent / 100;
    const multiplier = 1 + binStep / 10000;
    const binsNeeded = Math.ceil(Math.log(priceMultiplier) / Math.log(multiplier));
    const totalBins = binsNeeded * 2; // Both sides
    return { range: binsNeeded.toString(), totalBins };
  };

  // Legacy function for display purposes
  const autoCalculateParams = (rangePercent: number) => {
    const currentBinStep = parseInt(dlmmBinStep) || 50;
    const { range, totalBins } = calculateBinRange(rangePercent, currentBinStep);
    return { binStep: dlmmBinStep, range, totalBins };
  };

  // Update bin range when slider changes (bin step stays fixed)
  const handleRangeChange = (percent: number) => {
    setPriceRangePercent(percent);
    if (!advancedMode) {
      const currentBinStep = parseInt(dlmmBinStep) || 50;
      const { range } = calculateBinRange(percent, currentBinStep);
      setDlmmRangeInterval(range);
      setDlmmStrategy(DLMMStrategyType.Spot); // Always use Spot for simple mode
    }
  };

  // Parse number string (supports K, M, B suffixes)
  const parseNumber = (str: string): number => {
    if (!str) return 0;
    const cleaned = str.toUpperCase().replace(/[^0-9.KMB]/g, '');
    const num = parseFloat(cleaned.replace(/[KMB]/g, ''));
    if (isNaN(num)) return 0;
    if (cleaned.includes('B')) return num * 1000000000;
    if (cleaned.includes('M')) return num * 1000000;
    if (cleaned.includes('K')) return num * 1000;
    return num;
  };

  // Parse inputs
  const customMinMcapValue = parseNumber(customMinMcap);
  const customMaxMcapValue = parseNumber(customMaxMcap);
  const totalSupply = parseNumber(mainTokenSupply);

  // Calculate proper SOL price from USD price using actual SOL/USD rate
  // This is more accurate than using Meteora pool price which may be stale
  const calculatedPriceInSol = currentPrice > 0 && solPriceUSD > 0 ? currentPrice / solPriceUSD : currentPriceInSol;

  // Use calculated price as primary, fall back to Meteora pool price only if calculation not available
  const effectiveCurrentPriceSol = calculatedPriceInSol > 0 ? calculatedPriceInSol :
    ((meteoraPoolPrice !== null && meteoraPoolPrice > 0) ? meteoraPoolPrice : currentPriceInSol);

  // Use actual SOL/USD price if available, otherwise derive from prices (less accurate)
  const solUsdFromPrices = solPriceUSD > 0 ? solPriceUSD :
    (currentPrice > 0 && effectiveCurrentPriceSol > 0 ? currentPrice / effectiveCurrentPriceSol : 0);


  const parsePriceInput = (val: string) => {
    const parsed = parseFloat(val);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    // If viewing in USD, return as-is. If viewing in SOL, convert SOL → USD
    if (priceView === 'USD') return parsed;
    return solUsdFromPrices > 0 ? parsed * solUsdFromPrices : 0;
  };

  // Calculate prices from mcap using: price = mcap / totalSupply
  const mcapToPrice = (mcap: number): number => {
    if (totalSupply <= 0 || mcap <= 0) return 0;
    return mcap / totalSupply;
  };

  // Calculate current main token mcap from price: mcap = price * totalSupply
  const mainTokenMcap = totalSupply > 0 && currentPrice > 0 ? currentPrice * totalSupply : currentMcap;

  // Calculate display values based on mode
  const multiplier = 1 + priceRangePercent / 100;

  let minMcap: number, maxMcap: number;
  let minPriceUsd: number, maxPriceUsd: number;
  let minPriceSol: number, maxPriceSol: number;

  if (useCustomRange) {
    const parsedMinInput = parseFloat(customMinPriceSolInput) || 0;
    const parsedMaxInput = parseFloat(customMaxPriceSolInput) || 0;

    // If viewing in USD, inputs are USD prices - convert to SOL
    // If viewing in SOL, inputs are SOL prices - use directly
    if (priceView === 'USD') {
      // User entered USD prices, convert to SOL
      minPriceUsd = parsedMinInput;
      maxPriceUsd = parsedMaxInput;
      minPriceSol = solUsdFromPrices > 0 ? minPriceUsd / solUsdFromPrices : 0;
      maxPriceSol = solUsdFromPrices > 0 ? maxPriceUsd / solUsdFromPrices : 0;
    } else {
      // User entered SOL prices, use directly
      minPriceSol = parsedMinInput;
      maxPriceSol = parsedMaxInput;
      minPriceUsd = solUsdFromPrices > 0 ? minPriceSol * solUsdFromPrices : 0;
      maxPriceUsd = solUsdFromPrices > 0 ? maxPriceSol * solUsdFromPrices : 0;
    }

    minMcap = minPriceUsd > 0 && totalSupply > 0 ? minPriceUsd * totalSupply : 0;
    maxMcap = maxPriceUsd > 0 && totalSupply > 0 ? maxPriceUsd * totalSupply : 0;
  } else {
    // Percentage mode (SOL-based) - use effective price from Meteora if available
    console.log('[DLMM-CONFIG] Percentage mode MCap calculation:', {
      mainTokenMcap,
      multiplier,
      effectiveCurrentPriceSol,
      solUsdFromPrices
    });
    minMcap = mainTokenMcap > 0 ? mainTokenMcap / multiplier : 0;
    maxMcap = mainTokenMcap > 0 ? mainTokenMcap * multiplier : 0;
    minPriceSol = effectiveCurrentPriceSol > 0 ? effectiveCurrentPriceSol / multiplier : 0;
    maxPriceSol = effectiveCurrentPriceSol > 0 ? effectiveCurrentPriceSol * multiplier : 0;
    minPriceUsd = solUsdFromPrices > 0 ? minPriceSol * solUsdFromPrices : 0;
    maxPriceUsd = solUsdFromPrices > 0 ? maxPriceSol * solUsdFromPrices : 0;
    console.log('[DLMM-CONFIG] Calculated MCap range:', {
      minMcap,
      maxMcap,
      minPriceSol,
      maxPriceSol,
      minPriceUsd,
      maxPriceUsd
    });
  }

  // Notify parent of MCap range changes (always use SOL-denominated prices for Meteora)
  useEffect(() => {
    if (!onMcapRangeChange) return;
    const effectiveSupply = totalSupply > 0 ? totalSupply : 1;
    const derivedMinSol = minPriceSol > 0 ? minPriceSol * effectiveSupply : 0;
    const derivedMaxSol = maxPriceSol > 0 ? maxPriceSol * effectiveSupply : 0;

    if (derivedMinSol > 0 && derivedMaxSol > 0) {
      onMcapRangeChange(derivedMinSol, derivedMaxSol, effectiveSupply, useCustomRange);
    }
  }, [minPriceSol, maxPriceSol, totalSupply, useCustomRange, onMcapRangeChange]);

  // Calculate bins based on price range (always use USD for stability)
  const priceRangeForBins = currentPrice > 0 && maxPriceUsd > 0
    ? Math.max((maxPriceUsd / currentPrice - 1) * 100, (1 - minPriceUsd / currentPrice) * 100)
    : priceRangePercent;
  const { totalBins } = autoCalculateParams(priceRangeForBins || priceRangePercent);
  const estimatedTxs = Math.ceil(totalBins / 69);

  // Auto-update bin range when price range changes (bin step stays fixed)
  useEffect(() => {
    if (advancedMode) return; // Don't override in advanced mode
    if (priceRangeForBins > 0) {
      const currentBinStep = parseInt(dlmmBinStep) || 50;
      const { range } = calculateBinRange(priceRangeForBins, currentBinStep);
      setDlmmRangeInterval(range);
    }
  }, [priceRangeForBins, dlmmBinStep, advancedMode, setDlmmRangeInterval]);

  // Format market cap for display
  const formatMcap = (mcap: number) => {
    if (mcap === 0) return '?';
    if (mcap >= 1000000) return `$${(mcap / 1000000).toFixed(2)}M`;
    if (mcap >= 1000) return `$${(mcap / 1000).toFixed(1)}K`;
    return `$${mcap.toFixed(0)}`;
  };

  // Format USD price for display
  const formatPrice = (price: number) => {
    if (price === 0) return '$0';
    if (price >= 1) return `$${price.toFixed(4)}`;
    if (price >= 0.01) return `$${price.toFixed(4)}`;
    if (price >= 0.0001) return `$${price.toFixed(6)}`;
    return `$${price.toFixed(8)}`;
  };

  // Format SOL price for display
  const formatSolPrice = (price: number) => {
    if (price === 0) return '0 SOL';
    if (price >= 1) return `${price.toFixed(4)} SOL`;
    if (price >= 0.0001) return `${price.toFixed(6)} SOL`;
    return `${price.toFixed(8)} SOL`;
  };

  return (
    <div className="p-2 rounded-lg border border-purple-500/20 bg-black/30 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
          <Settings2 className="w-3 h-3" />
          <span>{poolType === 'cpamm' ? 'DAMM v2' : 'DLMM'}</span>
        </div>
        <div className="flex items-center gap-2">
          {/* USD/SOL Toggle */}
          <div className="flex items-center gap-1 px-1 py-1 border border-gray-700 rounded-full bg-black/30">
            <button
              onClick={() => setPriceView('USD')}
              className={`px-2 py-0.5 text-[9px] rounded-full transition-all ${
                priceView === 'USD'
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50'
                  : 'text-gray-500 hover:text-gray-400'
              }`}
            >USD</button>
            <button
              onClick={() => setPriceView('SOL')}
              className={`px-2 py-0.5 text-[9px] rounded-full transition-all ${
                priceView === 'SOL'
                  ? 'bg-purple-500/20 text-purple-400 border border-purple-500/50'
                  : 'text-gray-500 hover:text-gray-400'
              }`}
            >SOL</button>
          </div>
          {/* Two-Sided / One-Sided toggles - Hidden for monorifts */}
          {!hideSingleSidedToggle && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setSingleSided(false)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-full border transition-all ${
                  !singleSided
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                    : 'bg-black/30 border-gray-700 text-gray-500 hover:border-gray-600'
                }`}
                title="Provide both assets"
              >
                <div className={`w-2 h-2 rounded-full transition-colors ${
                  !singleSided ? 'bg-emerald-300' : 'bg-gray-600'
                }`} />
                <span className="text-[10px] font-medium">2-Sided (Asset)</span>
              </button>
              <button
                onClick={() => setSingleSided(true)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-full border transition-all ${
                  singleSided
                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                    : 'bg-black/30 border-gray-700 text-gray-500 hover:border-gray-600'
                }`}
                title="Provide a single asset"
              >
                <div className={`w-2 h-2 rounded-full transition-colors ${
                  singleSided ? 'bg-amber-300' : 'bg-gray-600'
                }`} />
                <span className="text-[10px] font-medium">1-Sided</span>
              </button>
            </div>
          )}
          {/* Advanced Toggle Switch */}
          <button
            onClick={() => setAdvancedMode(!advancedMode)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-full border transition-all ${
              advancedMode
                ? 'bg-purple-500/20 border-purple-500/50 text-purple-400'
                : 'bg-black/30 border-gray-700 text-gray-500 hover:border-gray-600'
            }`}
          >
            <div className={`w-2 h-2 rounded-full transition-colors ${
              advancedMode ? 'bg-purple-400' : 'bg-gray-600'
            }`} />
            <span className="text-[10px] font-medium">Advanced</span>
          </button>
        </div>
      </div>

      {/* Current price display with USD/SOL toggle */}
      <div className="flex items-center justify-between text-[10px] text-gray-400 px-1">
        <span>
          {meteoraPoolAddress && isLoadingPoolPrice ? (
            'Market Price: Loading...'
          ) : effectiveCurrentPriceSol > 0 ? (
            <>
              Market Price:{' '}
              {priceView === 'USD'
                ? formatPrice(effectiveCurrentPriceSol * solUsdFromPrices)
                : formatSolPrice(effectiveCurrentPriceSol)}
              {' '}
              <span className="text-emerald-400 text-[9px]">(Meteora)</span>
            </>
          ) : (
            <>
              Current Price:{' '}
              {priceView === 'USD'
                ? formatPrice(currentPrice)
                : formatSolPrice(currentPriceInSol || 0)}
            </>
          )}
        </span>
        <div className="flex gap-1">
          <button
            onClick={() => setPriceView('USD')}
            className={`px-1.5 py-0.5 text-[9px] rounded ${priceView === 'USD' ? 'bg-emerald-500/20 text-emerald-400' : 'text-gray-600'}`}
          >USD</button>
          <button
            onClick={() => setPriceView('SOL')}
            className={`px-1.5 py-0.5 text-[9px] rounded ${priceView === 'SOL' ? 'bg-purple-500/20 text-purple-400' : 'text-gray-600'}`}
          >SOL</button>
        </div>
      </div>

      {/* Simple Mode */}
      {!advancedMode && (
        <div className="space-y-2">
          {/* Percentage Mode */}
          {!useCustomRange && (
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-gray-500">±</span>
              <input
                type="text"
                inputMode="numeric"
                value={priceRangePercent || ''}
                onChange={(e) => handleRangeChange(parseInt(e.target.value.replace(/[^0-9]/g, '')) || 0)}
                onBlur={(e) => handleRangeChange(Math.max(1, parseInt(e.target.value) || 50))}
                className="w-12 px-1 py-0.5 bg-black/50 border border-purple-500/30 rounded text-purple-400 text-[10px] text-center outline-none"
              />
              <span className="text-[9px] text-gray-500">%</span>
              <input
                type="range"
                min="5"
                max="500"
                step="5"
                value={Math.min(500, priceRangePercent)}
                onChange={(e) => handleRangeChange(parseInt(e.target.value))}
                className="flex-1 h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
              />
              <span className="text-[9px] text-gray-600">({(1/multiplier).toFixed(1)}x-{multiplier.toFixed(1)}x)</span>
            </div>
          )}

          {/* Custom Price Mode */}
          {useCustomRange && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-gray-500 w-12">Range</span>
                <input
                  type="text"
                  placeholder={priceView === 'USD' ? '$0.0001' : '0.00002 SOL'}
                  value={customMinPriceSolInput}
                  onChange={(e) => setCustomMinPriceSolInput(e.target.value)}
                  className="flex-1 px-1.5 py-0.5 bg-black/50 border border-purple-500/30 rounded text-purple-400 text-[10px] outline-none placeholder-gray-600"
                />
                <span className="text-[9px] text-gray-600">→</span>
                <input
                  type="text"
                  placeholder={priceView === 'USD' ? '$0.01' : '0.001 SOL'}
                  value={customMaxPriceSolInput}
                  onChange={(e) => setCustomMaxPriceSolInput(e.target.value)}
                  className="flex-1 px-1.5 py-0.5 bg-black/50 border border-purple-500/30 rounded text-purple-400 text-[10px] outline-none placeholder-gray-600"
                />
              </div>
              {((priceView === 'USD' && (effectiveCurrentPriceSol > 0 || currentPrice > 0)) ||
                (priceView === 'SOL' && effectiveCurrentPriceSol > 0)) && (
                <div className="text-[9px] text-emerald-400 text-center">
                  {effectiveCurrentPriceSol > 0 ? (
                    <>
                      Market Price (Meteora):{' '}
                      {priceView === 'USD'
                        ? formatPrice(effectiveCurrentPriceSol * solUsdFromPrices)
                        : formatSolPrice(effectiveCurrentPriceSol)}
                    </>
                  ) : (
                    <>
                      Current Price:{' '}
                      {priceView === 'USD'
                        ? formatPrice(currentPrice)
                        : formatSolPrice(currentPriceInSol || 0)}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Range Preview - Compact with both USD and SOL */}
          <div className="flex items-center justify-between text-[9px] bg-black/40 rounded px-2 py-1">
            <div className="flex flex-col gap-0.5">
              {/* USD Range */}
              {(minPriceUsd > 0 || maxPriceUsd > 0) && (
                <div className="flex items-center gap-1">
                  <span className="text-gray-500 text-[8px]">USD:</span>
                  <span className="text-emerald-400">
                    {minPriceUsd > 0 ? formatPrice(minPriceUsd) : '?'} → {maxPriceUsd > 0 ? formatPrice(maxPriceUsd) : '?'}
                  </span>
                </div>
              )}
              {/* SOL Range */}
              {(minPriceSol > 0 || maxPriceSol > 0) && (
                <div className="flex items-center gap-1">
                  <span className="text-gray-500 text-[8px]">SOL:</span>
                  <span className="text-purple-400">
                    {minPriceSol > 0 ? formatSolPrice(minPriceSol) : '?'} → {maxPriceSol > 0 ? formatSolPrice(maxPriceSol) : '?'}
                  </span>
                </div>
              )}
            </div>
            <span className="text-gray-600">
              {minPriceUsd > 0 && maxPriceUsd > 0 ? `${totalBins} bins` : '—'}
            </span>
          </div>

          {/* Fee - Compact */}
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-gray-500">Fee:</span>
            {[
              { bps: '25', label: '0.25%' },
            ].map(({ bps, label }) => (
              <button
                key={bps}
                onClick={() => setDlmmFeeBps(bps)}
                className={`px-2 py-0.5 text-[9px] rounded ${
                  dlmmFeeBps === bps ? 'bg-purple-500/20 text-purple-400' : 'text-gray-600 hover:text-purple-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Advanced Mode - Compact */}
      {advancedMode && (
        <div className="space-y-1.5">
          {/* Strategy & Bin Step */}
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-gray-500 w-14">Strategy</span>
            {[
              { type: DLMMStrategyType.Spot, label: 'Spot' },
              { type: DLMMStrategyType.BidAsk, label: 'Bid' },
              { type: DLMMStrategyType.Curve, label: 'Curve' }
            ].map(({ type, label }) => (
              <button
                key={label}
                onClick={() => setDlmmStrategy(type)}
                className={`px-2 py-0.5 text-[9px] rounded ${dlmmStrategy === type ? 'bg-purple-500/20 text-purple-400' : 'text-gray-600'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-gray-500 w-14">Bin Step</span>
            {['1', '5', '10', '20', '50', '100', '200'].map((step) => (
              <button
                key={step}
                onClick={() => setDlmmBinStep(step)}
                className={`px-1.5 py-0.5 text-[9px] rounded ${dlmmBinStep === step ? 'bg-purple-500/20 text-purple-400' : 'text-gray-600'}`}
              >
                {step}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-gray-500 w-14">Range</span>
            <input
              type="number"
              value={dlmmRangeInterval}
              onChange={(e) => setDlmmRangeInterval(e.target.value)}
              min="1"
              max="500"
              className="w-16 px-1.5 py-0.5 bg-black/50 border border-purple-500/30 rounded text-purple-400 text-[10px] outline-none"
            />
            <span className="text-[9px] text-gray-600">bins</span>
            <span className="text-[9px] text-gray-500 ml-auto">Fee: 0.25%</span>
          </div>
        </div>
      )}
    </div>
  );
};

// Types
interface RiftData {
  id: string;
  symbol: string;
  underlying: string;
  underlyingMint?: string;
  riftMint?: string;
  liquidityPool?: any;
  meteoraPool?: any;
  meteoraPools?: any[];
  price?: number;
  mcap?: number;
  tvl?: number;
  riftTokenPrice?: number;
  underlyingTokenPrice?: number;
  totalRiftMinted?: number;
}

interface DepositQuote {
  wsolNeeded: number;
  riftNeeded: number;
  poolRatio: number;
  liquidityDelta: string;
}

interface LpPosition {
  address: string;
  poolAddress?: string;
  isDlmm?: boolean;
  nftMint?: string;
  unlockedLiquidity?: string;
  // DLMM-specific fields
  tokenXAmount?: number;
  tokenYAmount?: number;
}

interface DetailedPosition {
  address: string;
  percentageOfTotal: number;
  estimatedTokenA: number;
  estimatedTokenB: number;
}

interface PendingFees {
  tokenX?: number;
  tokenY?: number;
  tokenA?: number;
  tokenB?: number;
}

interface EstimatedWithdrawal {
  tokenA: number;
  tokenB: number;
}

interface LiquidityModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedRift: RiftData | null;
  allRifts?: RiftData[]; // All rifts for finding underlying rift pools
  // Wallet data
  walletBalance: number;
  riftsTokenBalance: number;
  usd1TokenBalance: number;
  selectedRiftBalance: number;
  // State values
  liquidityTab: 'add' | 'remove';
  setLiquidityTab: (tab: 'add' | 'remove') => void;
  liquidityTokenA: 'SOL' | 'USD1';
  setLiquidityTokenA: (token: 'SOL' | 'USD1') => void;
  poolType: 'cpamm' | 'dlmm';
  setPoolType: (type: 'cpamm' | 'dlmm') => void;
  solLiquidityAmount: string;
  setSolLiquidityAmount: (amount: string) => void;
  riftLiquidityAmount: string;
  setRiftLiquidityAmount: (amount: string) => void;
  // DLMM settings
  dlmmStrategy: DLMMStrategyType;
  setDlmmStrategy: (strategy: DLMMStrategyType) => void;
  dlmmBinStep: string;
  setDlmmBinStep: (step: string) => void;
  dlmmRangeInterval: string;
  setDlmmRangeInterval: (interval: string) => void;
  dlmmFeeBps: string;
  setDlmmFeeBps: (fee: string) => void;
  dlmmSingleSided: boolean;
  setDlmmSingleSided: (value: boolean) => void;
  // MCap range for DLMM bin calculation
  dlmmMinMcap: number;
  setDlmmMinMcap: (value: number) => void;
  dlmmMaxMcap: number;
  setDlmmMaxMcap: (value: number) => void;
  dlmmTokenSupply: number;
  setDlmmTokenSupply: (value: number) => void;
  dlmmUseMcapRange: boolean;
  setDlmmUseMcapRange: (value: boolean) => void;
  // Pool creation mode
  createNewPool: boolean;
  setCreateNewPool: (create: boolean) => void;
  // Price settings
  usePriceMode: boolean;
  setUsePriceMode: (mode: boolean) => void;
  initialPrice: string;
  setInitialPrice: (price: string) => void;
  liquidityRatio: number;
  setLiquidityRatio: (ratio: number) => void;
  dlmmPriceOverrideUsd?: number;
  // Quote & loading states
  depositQuote: DepositQuote | null;
  setDepositQuote: (quote: DepositQuote | null) => void;
  isLoadingQuote: boolean;
  quoteError: string | null;
  lastEditedField: 'sol' | 'rift' | null;
  setLastEditedField: (field: 'sol' | 'rift' | null) => void;
  // Remove liquidity
  removeMode: 'percentage' | 'positions';
  setRemoveMode: (mode: 'percentage' | 'positions') => void;
  removePercentage: string;
  setRemovePercentage: (pct: string) => void;
  userLpPositions: LpPosition[];
  selectedPositions: Set<string>;
  setSelectedPositions: (positions: Set<string>) => void;
  positionRemovalPercentages: Record<string, number>;
  setPositionRemovalPercentages: (percentages: Record<string, number>) => void;
  isLoadingLpBalance: boolean;
  detailedPositions: DetailedPosition[];
  estimatedWithdrawal: EstimatedWithdrawal | null;
  // Pool info
  poolTypeDetected: 'dlmm' | 'cpamm' | null;
  dlmmPendingFees: PendingFees | null;
  cpammPendingFees: PendingFees | null;
  // Actions
  isCreatingMeteoraPool: boolean;
  isClaimingLpFees: boolean;
  dlmmProgress: { current: number; total: number; status: string } | null;
  handleCreatePoolAndAddLiquidity: () => void;
  handleRemoveLiquidity: () => void;
  handleClaimLpFees: () => void;
  hasValidPool: (rift: RiftData | null) => boolean;
  // Pool selection (when multiple pools exist)
  selectedPoolAddress: string | null;
  setSelectedPoolAddress: (address: string | null) => void;
}

// Utility components
const TabButton: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  variant?: 'default' | 'danger';
}> = ({ active, onClick, children, variant = 'default' }) => (
  <button
    onClick={onClick}
    className={`
      flex-1 py-2 px-4 text-sm font-medium transition-all duration-150 rounded-md
      ${active
        ? variant === 'danger'
          ? 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20'
          : 'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/30'
        : 'text-gray-500 hover:text-emerald-400 hover:bg-emerald-500/5'
      }
    `}
  >
    {children}
  </button>
);

const SegmentButton: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  size?: 'sm' | 'md';
  className?: string;
  disabled?: boolean;
}> = ({ active, onClick, children, size = 'md', className = '', disabled = false }) => (
  <button
    onClick={disabled ? undefined : onClick}
    disabled={disabled}
    className={`
      ${size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-xs'}
      font-medium transition-all duration-150 rounded
      ${active
        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
        : 'text-gray-500 hover:text-emerald-400 hover:bg-emerald-500/10'
      }
      ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      ${className}
    `}
  >
    {children}
  </button>
);

const PercentButton: React.FC<{
  onClick: () => void;
  children: React.ReactNode;
  variant?: 'default' | 'primary';
}> = ({ onClick, children, variant = 'default' }) => (
  <button
    onClick={onClick}
    className={`
      px-2 py-1 text-xs font-medium rounded transition-all duration-150
      ${variant === 'primary'
        ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30'
        : 'text-gray-500 hover:text-emerald-400 hover:bg-emerald-500/10'
      }
    `}
  >
    {children}
  </button>
);

const TokenInput: React.FC<{
  symbol: string;
  balance: number;
  value: string;
  onChange: (value: string) => void;
  onPercentClick: (pct: number) => void;
  isLoading?: boolean;
  loadingText?: string;
}> = ({ symbol, balance, value, onChange, onPercentClick, isLoading, loadingText }) => (
  <div className="rounded-lg border border-emerald-500/20 bg-black/50 p-3">
    <div className="flex items-center justify-between mb-2">
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center">
          <span className="text-xs font-semibold text-emerald-400">{symbol[0]}</span>
        </div>
        <span className="text-sm font-medium text-white">{symbol}</span>
      </div>
      <span className="text-xs text-gray-400">
        Balance: {balance.toFixed(4)}
      </span>
    </div>
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0.00"
        className="flex-1 bg-transparent text-lg font-semibold text-emerald-400 placeholder-gray-600 outline-none"
      />
      <div className="flex items-center gap-1">
        {[25, 50, 75].map((pct) => (
          <PercentButton key={pct} onClick={() => onPercentClick(pct)}>
            {pct}%
          </PercentButton>
        ))}
        <PercentButton variant="primary" onClick={() => onPercentClick(100)}>
          MAX
        </PercentButton>
      </div>
    </div>
    {isLoading && (
      <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-400/70">
        <Loader2 className="w-3 h-3 animate-spin" />
        {loadingText || 'Calculating...'}
      </div>
    )}
  </div>
);

const Divider: React.FC<{ icon?: React.ReactNode }> = ({ icon }) => (
  <div className="flex justify-center -my-1.5 relative z-10">
    <div className="w-8 h-8 rounded-full bg-black border border-emerald-500/30 flex items-center justify-center">
      {icon || <Plus className="w-4 h-4 text-emerald-400" />}
    </div>
  </div>
);

export const LiquidityModal: React.FC<LiquidityModalProps> = ({
  isOpen,
  onClose,
  selectedRift,
  allRifts,
  walletBalance,
  riftsTokenBalance,
  usd1TokenBalance,
  selectedRiftBalance,
  liquidityTab,
  setLiquidityTab,
  liquidityTokenA,
  setLiquidityTokenA,
  poolType,
  setPoolType,
  solLiquidityAmount,
  setSolLiquidityAmount,
  riftLiquidityAmount,
  setRiftLiquidityAmount,
  dlmmStrategy,
  setDlmmStrategy,
  dlmmBinStep,
  setDlmmBinStep,
  dlmmRangeInterval,
  setDlmmRangeInterval,
  dlmmFeeBps,
  setDlmmFeeBps,
  dlmmSingleSided,
  setDlmmSingleSided,
  dlmmMinMcap,
  setDlmmMinMcap,
  dlmmMaxMcap,
  setDlmmMaxMcap,
  dlmmTokenSupply,
  setDlmmTokenSupply,
  dlmmUseMcapRange,
  setDlmmUseMcapRange,
  createNewPool,
  setCreateNewPool,
  usePriceMode,
  setUsePriceMode,
  initialPrice,
  setInitialPrice,
  liquidityRatio,
  setLiquidityRatio,
  dlmmPriceOverrideUsd,
  depositQuote,
  setDepositQuote,
  isLoadingQuote,
  quoteError,
  lastEditedField,
  setLastEditedField,
  removeMode,
  setRemoveMode,
  removePercentage,
  setRemovePercentage,
  userLpPositions,
  selectedPositions,
  setSelectedPositions,
  positionRemovalPercentages,
  setPositionRemovalPercentages,
  isLoadingLpBalance,
  detailedPositions,
  estimatedWithdrawal,
  poolTypeDetected,
  dlmmPendingFees,
  cpammPendingFees,
  isCreatingMeteoraPool,
  isClaimingLpFees,
  dlmmProgress,
  handleCreatePoolAndAddLiquidity,
  handleRemoveLiquidity,
  handleClaimLpFees,
  hasValidPool,
  selectedPoolAddress,
  setSelectedPoolAddress,
}) => {
  // Detect and lock pair based on existing pool
  const [detectedPair, setDetectedPair] = useState<'SOL' | 'USD1' | null>(null);
  // Local pool type detection (more accurate than prop-based detection)
  const [localPoolType, setLocalPoolType] = useState<'dlmm' | 'cpamm' | null>(null);

  useEffect(() => {
    const detectExistingPair = async () => {
      // Only detect if pool exists
      if (!selectedRift || !hasValidPool(selectedRift)) {
        setDetectedPair(null);
        setLocalPoolType(null);
        return;
      }

      console.log('🔍 Detecting pool pair for:', selectedRift.symbol);
      console.log('📊 selectedRift data:', {
        meteoraPools: selectedRift.meteoraPools,
        liquidityPool: (selectedRift as any).liquidityPool,
        meteoraPool: (selectedRift as any).meteoraPool,
        hasMeteoraPool: (selectedRift as any).hasMeteoraPool
      });

      try {
        // Collect all possible pool addresses to check
        const poolsToCheck: string[] = [];

        // 1. Check meteoraPools array (new format)
        if (selectedRift.meteoraPools && selectedRift.meteoraPools.length > 0) {
          poolsToCheck.push(...selectedRift.meteoraPools);
        }

        // 2. Fallback to legacy pool fields
        const legacyPool = (selectedRift as any).liquidityPool || (selectedRift as any).meteoraPool;
        if (legacyPool && !poolsToCheck.includes(legacyPool)) {
          poolsToCheck.push(legacyPool);
        }

        if (poolsToCheck.length === 0) {
          console.log('⚠️ No pools to check');
          setDetectedPair(null);
          return;
        }

        console.log('🔍 Pools to check:', poolsToCheck);

        // Try to detect which type of pool exists by checking the first valid pool
        const { Connection, PublicKey } = await import('@solana/web3.js');
        const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');

        const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=05cdb2bf-29b4-436b-afed-f757a4134fe6');
        const cpAmm = new CpAmm(connection as any);

        const WSOL_MINT = 'So11111111111111111111111111111111111111112';
        const USD1_MINT = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';

        for (const poolAddr of poolsToCheck) {
          if (!poolAddr || poolAddr === '11111111111111111111111111111111') continue;

          console.log('🔎 Checking pool:', poolAddr);

          // Try CP-AMM first
          try {
            const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddr));
            const tokenAMint = poolState.tokenAMint.toBase58();
            const tokenBMint = poolState.tokenBMint.toBase58();

            console.log('💰 CP-AMM Token A:', tokenAMint);
            console.log('💰 CP-AMM Token B:', tokenBMint);

            const hasWSOL = tokenAMint === WSOL_MINT || tokenBMint === WSOL_MINT;
            const hasUSD1 = tokenAMint === USD1_MINT || tokenBMint === USD1_MINT;

            // Set pool type for accurate link generation
            setLocalPoolType('cpamm');

            if (hasWSOL) {
              console.log('✅ Detected CP-AMM SOL pool - locking to SOL');
              setDetectedPair('SOL');
              setLiquidityTokenA('SOL');
              return;
            }
            if (hasUSD1) {
              console.log('✅ Detected CP-AMM USD1 pool - locking to USD1');
              setDetectedPair('USD1');
              setLiquidityTokenA('USD1');
              return;
            }
            console.log('⚠️ CP-AMM pool does not contain SOL or USD1');
            return; // Still a valid CP-AMM pool, just not SOL/USD1 paired
          } catch (cpAmmErr) {
            // CP-AMM failed, try DLMM
            console.log('📊 Not a CP-AMM pool, trying DLMM...');
            try {
              const DLMM = (await import('@meteora-ag/dlmm')).default;
              const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddr));

              const tokenXMint = dlmmPool.tokenX.publicKey.toBase58();
              const tokenYMint = dlmmPool.tokenY.publicKey.toBase58();

              console.log('💰 DLMM Token X:', tokenXMint);
              console.log('💰 DLMM Token Y:', tokenYMint);

              // Set pool type for accurate link generation
              setLocalPoolType('dlmm');

              const hasWSOL = tokenXMint === WSOL_MINT || tokenYMint === WSOL_MINT;
              const hasUSD1 = tokenXMint === USD1_MINT || tokenYMint === USD1_MINT;

              if (hasWSOL) {
                console.log('✅ Detected DLMM SOL pool - locking to SOL');
                setDetectedPair('SOL');
                setLiquidityTokenA('SOL');
                return;
              }
              if (hasUSD1) {
                console.log('✅ Detected DLMM USD1 pool - locking to USD1');
                setDetectedPair('USD1');
                setLiquidityTokenA('USD1');
                return;
              }
              console.log('⚠️ DLMM pool does not contain SOL or USD1');
              return; // Still a valid DLMM pool, just not SOL/USD1 paired
            } catch (dlmmErr) {
              console.log('❌ Not a valid CP-AMM or DLMM pool:', poolAddr);
              continue;
            }
          }
        }
        console.log('⚠️ No SOL or USD1 pools found');
      } catch (err) {
        console.error('Error detecting pool pair:', err);
      }
    };

    detectExistingPair();
  }, [isOpen, selectedRift, hasValidPool, setLiquidityTokenA]);

  // Get all available pools for this rift (filtered by pool type)
  // Monorifts use DLMM pools by default, or DAMMV2 if poolType === 'dammv2'
  // Regular rifts use DAMM V2 (CP-AMM) pools
  const [filteredPools, setFilteredPools] = useState<string[]>([]);
  const [isLoadingPools, setIsLoadingPools] = useState(false);

  // Filter pools by type based on rift type using Meteora API
  React.useEffect(() => {
    const filterPoolsByType = async () => {
      if (!selectedRift || !isOpen) {
        setFilteredPools([]);
        return;
      }

      const pools: string[] = [];

      // Collect all pools
      if (selectedRift.meteoraPools && Array.isArray(selectedRift.meteoraPools)) {
        pools.push(...selectedRift.meteoraPools.filter(p => p && p !== '11111111111111111111111111111111'));
      }
      const singlePool = selectedRift.liquidityPool || selectedRift.meteoraPool;
      if (singlePool && singlePool !== '11111111111111111111111111111111' && !pools.includes(singlePool)) {
        pools.unshift(singlePool);
      }

      const uniquePools = [...new Set(pools)];
      if (uniquePools.length === 0) {
        setFilteredPools([]);
        return;
      }

      // Detect monorift by prefixType only (1 = monorift)
      // mRIFTS = monorift, mrRIFTS = monorift of rift token, rRIFTS = regular rift
      const isMonorift = (selectedRift as any)?.prefixType === 1;

      // Check if this monorift uses DAMMV2 (saved poolType)
      // poolType might be at top level or inside raw_data depending on how data was saved/loaded
      const savedPoolType = (selectedRift as any)?.poolType || (selectedRift as any)?.raw_data?.poolType as string | undefined;
      const monoriftUsesDammv2 = isMonorift && savedPoolType === 'dammv2';

      console.log('[POOL-FILTER] Monorift check:', { isMonorift, savedPoolType, monoriftUsesDammv2, prefixType: (selectedRift as any)?.prefixType });

      setIsLoadingPools(true);

      try {
        // Fetch DLMM pools from our API proxy (avoids CORS issues)
        // Use refresh=true to ensure we get the latest pool list for newly created pools
        const dlmmResponse = await fetch('/api/dlmm-pools?refresh=true');
        const dlmmData = dlmmResponse.ok ? await dlmmResponse.json() : { pools: [] };
        const dlmmPoolAddresses = new Set(dlmmData.pools || []);

        // Check each pool - if it's in the DLMM API response, it's DLMM; otherwise it's CP-AMM
        const poolChecks = uniquePools.map((poolAddr) => ({
          pool: poolAddr,
          isDlmm: dlmmPoolAddresses.has(poolAddr)
        }));

        // Filter logic:
        // - Regular rifts: CP-AMM pools only (!isDlmm)
        // - Monorift with explicit DAMMV2: CP-AMM pools only (!isDlmm)
        // - Monorift with explicit DLMM: DLMM pools only (isDlmm)
        // - Monorift with unknown poolType: show ALL pools (don't filter)
        let filtered: string[];

        if (!isMonorift) {
          // Regular rifts: CPAMM only
          filtered = poolChecks.filter(({ isDlmm }) => !isDlmm).map(({ pool }) => pool);
        } else if (savedPoolType === 'dammv2') {
          // Monorift with explicit DAMMV2: CPAMM only
          filtered = poolChecks.filter(({ isDlmm }) => !isDlmm).map(({ pool }) => pool);
        } else if (savedPoolType === 'dlmm') {
          // Monorift with explicit DLMM: DLMM only
          filtered = poolChecks.filter(({ isDlmm }) => isDlmm).map(({ pool }) => pool);
        } else {
          // Monorift with unknown poolType: show all pools (fallback)
          console.log('[POOL-FILTER] Monorift has no saved poolType, showing all pools');
          filtered = uniquePools;
        }

        console.log(`[POOL-FILTER] Rift: ${selectedRift?.symbol}, prefixType: ${(selectedRift as any)?.prefixType}, isMonorift: ${isMonorift}, poolType: ${savedPoolType}`);
        console.log(`[POOL-FILTER] Pools to check:`, uniquePools);
        console.log(`[POOL-FILTER] Pool check results:`, poolChecks);
        console.log(`[POOL-FILTER] ${isMonorift ? (savedPoolType ? `Monorift (${savedPoolType.toUpperCase()})` : 'Monorift (unknown type)') : 'Regular rift'}: ${filtered.length}/${uniquePools.length} pools match type`);

        // If multiple pools, sort by liquidity (biggest first)
        if (filtered.length > 1) {
          try {
            console.log('[POOL-FILTER] Fetching liquidity for sorting...');
            const dlmmAddresses = poolChecks.filter(({ isDlmm }) => isDlmm).map(({ pool }) => pool);
            const liquidityResponse = await fetch('/api/pool-liquidity', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pools: filtered, dlmmPools: dlmmAddresses })
            });

            if (liquidityResponse.ok) {
              const liquidityData = await liquidityResponse.json();
              // The API already returns pools sorted by liquidity descending
              const sortedPools = liquidityData.pools.map((p: { pool: string }) => p.pool);
              console.log('[POOL-FILTER] Pools sorted by liquidity:', sortedPools.map((p: string, i: number) =>
                `${i + 1}. ${p.slice(0, 8)}... (${liquidityData.pools[i]?.liquidity?.toFixed(2)} SOL)`
              ));
              setFilteredPools(sortedPools);
            } else {
              console.log('[POOL-FILTER] Liquidity fetch failed, using unsorted pools');
              setFilteredPools(filtered);
            }
          } catch (sortError) {
            console.error('[POOL-FILTER] Error sorting by liquidity:', sortError);
            setFilteredPools(filtered);
          }
        } else {
          setFilteredPools(filtered);
        }
      } catch (error) {
        console.error('[POOL-FILTER] Error filtering pools:', error);
        setFilteredPools(uniquePools); // Fallback to all pools on error
      } finally {
        setIsLoadingPools(false);
      }
    };

    filterPoolsByType();
  }, [selectedRift, isOpen]);

  const availablePools = filteredPools;

  // Auto-select first pool when filtering completes, or clear if no matching pools
  React.useEffect(() => {
    if (!isOpen || isLoadingPools) return;

    if (availablePools.length > 0) {
      // If current selection is not in the filtered list, select first available
      if (!selectedPoolAddress || !availablePools.includes(selectedPoolAddress)) {
        setSelectedPoolAddress(availablePools[0]);
      }
    } else {
      // No matching pools - clear selection
      setSelectedPoolAddress(null);
    }
  }, [isOpen, isLoadingPools, availablePools, selectedPoolAddress, setSelectedPoolAddress]);

  // Calculate Meteora pool address for price fetching (use selected pool or fallback)
  // Also returns the pool type for the price pool (which may differ from the UI poolType for monorifts)
  const { meteoraPoolAddress, pricePoolType } = useMemo(() => {
    // If user selected a specific pool, use that with the current poolType
    if (selectedPoolAddress) return { meteoraPoolAddress: selectedPoolAddress, pricePoolType: poolType };

    if (!selectedRift) return { meteoraPoolAddress: undefined, pricePoolType: poolType };

    // Check if this is a monorift (prefixType 1 = monorift)
    const isMonorift = (selectedRift as any)?.prefixType === 1;

    // For monorifts, use the underlying token's pool price (e.g., rRIFTS pool for mrRIFTS)
    if (isMonorift && selectedRift?.underlyingMint && allRifts) {
      // This is a monorift, find the underlying rift's pool
      // The underlying rift is the one whose riftMint matches this monorift's underlyingMint
      const underlyingRift = allRifts.find((r: any) =>
        r.riftMint === selectedRift.underlyingMint
      );
      if (underlyingRift) {
        const poolAddr = underlyingRift.liquidityPool || underlyingRift.meteoraPool;
        // The underlying rift's pool is typically CP-AMM (DAMM V2), not DLMM
        // Regular rifts use CP-AMM, so use 'cpamm' for price fetching
        const underlyingPoolType = (underlyingRift as any)?.prefixType === 1 ? 'dlmm' : 'cpamm';
        console.log(`[PRICE] Monorift ${selectedRift.symbol} using underlying ${underlyingRift.symbol} pool: ${poolAddr} (type: ${underlyingPoolType})`);
        return { meteoraPoolAddress: poolAddr || undefined, pricePoolType: underlyingPoolType as 'cpamm' | 'dlmm' };
      } else {
        console.log(`[PRICE] Monorift ${selectedRift.symbol} - no underlying rift found for mint ${selectedRift.underlyingMint}`);
      }
    }

    // For regular rifts without their own pool, try to use an underlying rift's pool
    const ownPool = selectedRift?.liquidityPool || selectedRift?.meteoraPool;
    if (!ownPool && selectedRift?.underlyingMint && allRifts) {
      const underlyingRift = allRifts.find((r: any) =>
        r.riftMint === selectedRift.underlyingMint && r.id !== selectedRift.id
      );
      if (underlyingRift) {
        const poolAddr = underlyingRift.liquidityPool || underlyingRift.meteoraPool;
        if (poolAddr) {
          const underlyingPoolType = (underlyingRift as any)?.prefixType === 1 ? 'dlmm' : 'cpamm';
          console.log(`[PRICE] Regular rift ${selectedRift.symbol} using underlying ${underlyingRift.symbol} pool: ${poolAddr} (type: ${underlyingPoolType})`);
          return { meteoraPoolAddress: poolAddr, pricePoolType: underlyingPoolType as 'cpamm' | 'dlmm' };
        }
      }
    }

    return { meteoraPoolAddress: ownPool || undefined, pricePoolType: poolType };
  }, [selectedRift, allRifts, selectedPoolAddress, poolType]);

  // Early return check - after all hooks
  if (!isOpen || !selectedRift) return null;

  const tokenABalance = liquidityTokenA === 'SOL'
    ? walletBalance
    : usd1TokenBalance;
  const tokenASymbol = liquidityTokenA === 'SOL' ? 'SOL' : 'USD1';

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
        onClick={(e) => e.target === e.currentTarget && onClose()}
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
              <h2 className="text-base font-semibold text-emerald-400">Manage Liquidity</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                {tokenASymbol} / {selectedRift.symbol}
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Tab Navigation */}
          <div className="px-5 py-3 border-b border-emerald-500/20">
            <div className="flex gap-1 p-1 bg-black/50 rounded-lg border border-emerald-500/10">
              <TabButton
                active={liquidityTab === 'add'}
                onClick={() => setLiquidityTab('add')}
              >
                <span className="flex items-center gap-1.5">
                  <Plus className="w-3.5 h-3.5" />
                  Add
                </span>
              </TabButton>
              <TabButton
                active={liquidityTab === 'remove'}
                onClick={() => setLiquidityTab('remove')}
                variant="danger"
              >
                <span className="flex items-center gap-1.5">
                  <Minus className="w-3.5 h-3.5" />
                  Remove
                </span>
              </TabButton>
            </div>
          </div>

          {/* Pool Selector - always show pool status */}
          <div className="px-5 py-3 border-b border-emerald-500/20 bg-black/30">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-gray-500 flex items-center gap-1.5">
                <Coins className="w-3 h-3" />
                {isLoadingPools ? 'Detecting pools...' : availablePools.length > 1 ? `Select Pool (${availablePools.length} available)` : 'Pool'}
                {isLoadingPools && <Loader2 className="w-3 h-3 animate-spin" />}
              </label>
              {isLoadingPools ? (
                <div className="flex items-center gap-2 px-3 py-2 text-sm bg-black/50 border border-emerald-500/20 rounded-lg">
                  <span className="text-gray-400">Checking pool types...</span>
                </div>
              ) : availablePools.length === 0 ? (
                <div className="flex items-center gap-2 px-3 py-2 text-sm bg-amber-500/10 border border-amber-500/30 rounded-lg">
                  <span className="text-amber-400">
                    No pool found. Create a new pool to add liquidity.
                  </span>
                </div>
              ) : availablePools.length > 1 ? (
                <div className="flex items-center gap-2">
                  <select
                    value={selectedPoolAddress || ''}
                    onChange={(e) => setSelectedPoolAddress(e.target.value || null)}
                    className="flex-1 px-3 py-2 text-sm bg-[#0a0a0a] border border-emerald-500/20 rounded-lg text-white focus:outline-none focus:border-emerald-500/50 cursor-pointer [&>option]:bg-[#0a0a0a] [&>option]:text-white [&>option:hover]:bg-emerald-500/20 [&>option:checked]:bg-emerald-500/30"
                    style={{ backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%2310b981' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e")`, backgroundPosition: 'right 0.5rem center', backgroundRepeat: 'no-repeat', backgroundSize: '1.5em 1.5em', paddingRight: '2.5rem' }}
                  >
                    {availablePools.map((pool, index) => (
                      <option key={pool} value={pool}>
                        Pool {index + 1}: {pool.slice(0, 4)}...{pool.slice(-4)} {index === 0 ? '(Primary)' : ''}
                      </option>
                    ))}
                  </select>
                  {selectedPoolAddress && (
                    <a
                      href={`https://app.meteora.ag/${(localPoolType || poolTypeDetected) === 'dlmm' ? 'dlmm' : 'dammv2'}/${selectedPoolAddress}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2.5 py-2 text-emerald-400 hover:text-emerald-300 text-xs bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 rounded-lg transition-colors whitespace-nowrap"
                    >
                      View ↗
                    </a>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 px-3 py-2 text-sm bg-black/50 border border-emerald-500/20 rounded-lg">
                  <span className="text-white font-mono">{availablePools[0]?.slice(0, 4)}...{availablePools[0]?.slice(-4)}</span>
                  <a
                    href={`https://app.meteora.ag/${(localPoolType || poolTypeDetected) === 'dlmm' ? 'dlmm' : 'dammv2'}/${availablePools[0]}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-400 hover:text-emerald-300 text-xs"
                  >
                    View ↗
                  </a>
                </div>
              )}
              {availablePools.length > 1 && (
                <p className="text-[10px] text-gray-600">
                  Pools are sorted by TVL. Select a different pool if you want to add liquidity elsewhere.
                </p>
              )}
            </div>
          </div>

          {/* Content */}
          <div className="px-5 py-4 max-h-[60vh] overflow-y-auto space-y-4">
            {liquidityTab === 'add' ? (
              <AddLiquidityContent
                selectedRift={selectedRift}
                allRifts={allRifts}
                tokenASymbol={tokenASymbol}
                tokenABalance={tokenABalance}
                selectedRiftBalance={selectedRiftBalance}
                liquidityTokenA={liquidityTokenA}
                setLiquidityTokenA={setLiquidityTokenA}
                poolType={poolType}
                setPoolType={setPoolType}
                pricePoolType={pricePoolType}
                meteoraPoolAddress={meteoraPoolAddress}
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
                dlmmPriceOverrideUsd={dlmmPriceOverrideUsd}
                depositQuote={depositQuote}
                setDepositQuote={setDepositQuote}
                isLoadingQuote={isLoadingQuote}
                quoteError={quoteError}
                lastEditedField={lastEditedField}
                setLastEditedField={setLastEditedField}
                hasValidPool={hasValidPool}
                detectedPair={detectedPair}
                poolTypeDetected={poolTypeDetected}
              />
            ) : (
              <RemoveLiquidityContent
                selectedRift={selectedRift}
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
                isClaimingLpFees={isClaimingLpFees}
                handleClaimLpFees={handleClaimLpFees}
              />
            )}
          </div>

          {/* Footer Actions */}
          <div className="px-5 py-4 border-t border-emerald-500/20 bg-black/50">
            {liquidityTab === 'add' ? (
              <div className="flex gap-3">
                <button
                  onClick={onClose}
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-400 bg-black/50 border border-emerald-500/20 hover:border-emerald-500/40 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreatePoolAndAddLiquidity}
                  disabled={!riftLiquidityAmount || parseFloat(riftLiquidityAmount || '0') <= 0 || isCreatingMeteoraPool}
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-emerald-400 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 disabled:bg-black/30 disabled:border-gray-700 disabled:text-gray-600 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {isCreatingMeteoraPool ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {hasValidPool(selectedRift) ? 'Adding...' : 'Creating...'}
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4" />
                      {hasValidPool(selectedRift) ? 'Add Liquidity' : (() => {
                        const isMonorift = (selectedRift as any)?.prefixType === 1;
                        if (!isMonorift) return 'Create Pool';
                        const savedPoolType = (selectedRift as any)?.poolType || (selectedRift as any)?.raw_data?.poolType;
                        return savedPoolType === 'dammv2' ? 'Create DAMM V2 Pool' : 'Create DLMM Pool';
                      })()}
                    </>
                  )}
                </button>
              </div>
            ) : (
              <div className="flex gap-3">
                <button
                  onClick={onClose}
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-400 bg-black/50 border border-emerald-500/20 hover:border-emerald-500/40 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRemoveLiquidity}
                  disabled={
                    isLoadingLpBalance ||
                    isCreatingMeteoraPool ||
                    userLpPositions.length === 0 ||
                    (removeMode === 'positions' && selectedPositions.size === 0) ||
                    (removeMode === 'percentage' && !Object.values(positionRemovalPercentages).some(p => p > 0))
                  }
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 disabled:bg-black/30 disabled:border-gray-700 disabled:text-gray-600 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {isCreatingMeteoraPool || dlmmProgress ? (
                    <div className="flex flex-col items-center gap-1">
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {dlmmProgress ? (
                          <span className="text-xs">{dlmmProgress.status}</span>
                        ) : (
                          <span>Removing...</span>
                        )}
                      </div>
                      {dlmmProgress && dlmmProgress.total > 1 && (
                        <div className="w-full bg-red-900/30 rounded-full h-1.5 mt-1">
                          <div
                            className="bg-red-500 h-1.5 rounded-full transition-all duration-300"
                            style={{ width: `${(dlmmProgress.current / dlmmProgress.total) * 100}%` }}
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      <Minus className="w-4 h-4" />
                      {removeMode === 'percentage'
                        ? (() => {
                            // Only count positions that are in current userLpPositions list
                            const currentPositionAddresses = new Set(userLpPositions.map(p => p.address));
                            const positionsWithRemoval = Object.entries(positionRemovalPercentages)
                              .filter(([addr, pct]) => pct > 0 && currentPositionAddresses.has(addr));
                            if (positionsWithRemoval.length === 0) return 'Select positions to remove';
                            if (positionsWithRemoval.length === 1) {
                              return `Remove ${positionsWithRemoval[0][1]}% from 1 position`;
                            }
                            return `Remove from ${positionsWithRemoval.length} positions`;
                          })()
                        : `Remove ${selectedPositions.size} Position${selectedPositions.size !== 1 ? 's' : ''}`
                      }
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

// Add Liquidity Content Component
const AddLiquidityContent: React.FC<{
  selectedRift: RiftData;
  allRifts?: RiftData[];
  tokenASymbol: string;
  tokenABalance: number;
  selectedRiftBalance: number;
  liquidityTokenA: 'SOL' | 'USD1';
  setLiquidityTokenA: (token: 'SOL' | 'USD1') => void;
  poolType: 'cpamm' | 'dlmm';
  setPoolType: (type: 'cpamm' | 'dlmm') => void;
  pricePoolType?: 'cpamm' | 'dlmm'; // Pool type for price fetching (may differ for monorifts)
  meteoraPoolAddress?: string;
  solLiquidityAmount: string;
  setSolLiquidityAmount: (amount: string) => void;
  riftLiquidityAmount: string;
  setRiftLiquidityAmount: (amount: string) => void;
  dlmmStrategy: DLMMStrategyType;
  setDlmmStrategy: (strategy: DLMMStrategyType) => void;
  dlmmBinStep: string;
  setDlmmBinStep: (step: string) => void;
  dlmmRangeInterval: string;
  setDlmmRangeInterval: (interval: string) => void;
  dlmmFeeBps: string;
  setDlmmFeeBps: (fee: string) => void;
  dlmmSingleSided: boolean;
  setDlmmSingleSided: (value: boolean) => void;
  dlmmMinMcap: number;
  setDlmmMinMcap: (value: number) => void;
  dlmmMaxMcap: number;
  setDlmmMaxMcap: (value: number) => void;
  dlmmTokenSupply: number;
  setDlmmTokenSupply: (value: number) => void;
  dlmmUseMcapRange: boolean;
  setDlmmUseMcapRange: (value: boolean) => void;
  createNewPool: boolean;
  setCreateNewPool: (create: boolean) => void;
  usePriceMode: boolean;
  setUsePriceMode: (mode: boolean) => void;
  initialPrice: string;
  setInitialPrice: (price: string) => void;
  liquidityRatio: number;
  setLiquidityRatio: (ratio: number) => void;
  dlmmPriceOverrideUsd?: number;
  depositQuote: DepositQuote | null;
  setDepositQuote: (quote: DepositQuote | null) => void;
  isLoadingQuote: boolean;
  quoteError: string | null;
  lastEditedField: 'sol' | 'rift' | null;
  setLastEditedField: (field: 'sol' | 'rift' | null) => void;
  hasValidPool: (rift: RiftData | null) => boolean;
  detectedPair: 'SOL' | 'USD1' | null;
  poolTypeDetected: 'dlmm' | 'cpamm' | null;
}> = ({
  selectedRift,
  allRifts,
  tokenASymbol,
  tokenABalance,
  selectedRiftBalance,
  liquidityTokenA,
  setLiquidityTokenA,
  poolType,
  setPoolType,
  pricePoolType,
  meteoraPoolAddress,
  solLiquidityAmount,
  setSolLiquidityAmount,
  riftLiquidityAmount,
  setRiftLiquidityAmount,
  dlmmStrategy,
  setDlmmStrategy,
  dlmmBinStep,
  setDlmmBinStep,
  dlmmRangeInterval,
  setDlmmRangeInterval,
  dlmmFeeBps,
  setDlmmFeeBps,
  dlmmSingleSided,
  setDlmmSingleSided,
  dlmmMinMcap,
  setDlmmMinMcap,
  dlmmMaxMcap,
  setDlmmMaxMcap,
  dlmmTokenSupply,
  setDlmmTokenSupply,
  dlmmUseMcapRange,
  setDlmmUseMcapRange,
  createNewPool,
  setCreateNewPool,
  usePriceMode,
  setUsePriceMode,
  initialPrice,
  setInitialPrice,
  liquidityRatio,
  setLiquidityRatio,
  dlmmPriceOverrideUsd,
  depositQuote,
  setDepositQuote,
  isLoadingQuote,
  quoteError,
  lastEditedField: _lastEditedField,
  setLastEditedField,
  hasValidPool,
  detectedPair,
  poolTypeDetected,
}) => {
  void _lastEditedField; // Prop passed for state sync but not read here

  // SOL price for auto-calculating starting price
  const [solPriceUSD, setSolPriceUSD] = useState<number>(0);

  // Meteora pool price (in SOL)
  const [meteoraPoolPriceInSol, setMeteoraPoolPriceInSol] = useState<number | null>(null);

  // Live token price from Jupiter/Dexscreener (for new pool creation)
  const [liveTokenPriceUsd, setLiveTokenPriceUsd] = useState<number | null>(null);

  // Fetch SOL price on mount and when needed
  useEffect(() => {
    const fetchSolPrice = async () => {
      try {
        const response = await fetch('/api/prices?mint=So11111111111111111111111111111111111111112');
        if (response.ok) {
          const data = await response.json();
          if (data.price) {
            setSolPriceUSD(data.price);
          }
        }
      } catch (error) {
        console.error('[LiquidityModal] Failed to fetch SOL price:', error);
      }
    };
    fetchSolPrice();
    // Refresh every 30 seconds
    const interval = setInterval(fetchSolPrice, 30000);
    return () => clearInterval(interval);
  }, []);

  // Fetch live token price from Jupiter/Dexscreener when creating a new pool
  useEffect(() => {
    const fetchLiveTokenPrice = async () => {
      // Only fetch when creating new pool and we have a token mint
      if (!createNewPool || !selectedRift?.underlyingMint) {
        setLiveTokenPriceUsd(null);
        return;
      }

      try {
        // For monorifts, fetch the underlying token's price
        const mintToFetch = selectedRift.underlyingMint;
        console.log(`[LIVE-PRICE] Fetching live price for ${mintToFetch}`);

        const response = await fetch(`/api/prices?mint=${mintToFetch}`);
        if (response.ok) {
          const data = await response.json();
          if (data.price && data.price > 0) {
            console.log(`[LIVE-PRICE] Got live price: $${data.price}`);
            setLiveTokenPriceUsd(data.price);
          }
        }
      } catch (error) {
        console.error('[LIVE-PRICE] Failed to fetch:', error);
        setLiveTokenPriceUsd(null);
      }
    };

    fetchLiveTokenPrice();
  }, [createNewPool, selectedRift?.underlyingMint]);

  // Fetch Meteora pool price when pool address is available
  // Use pricePoolType (which correctly identifies the underlying pool type for monorifts)
  const effectivePricePoolType = pricePoolType || poolType;
  useEffect(() => {
    const fetchPoolPrice = async () => {
      if (!meteoraPoolAddress || !effectivePricePoolType) {
        setMeteoraPoolPriceInSol(null);
        return;
      }

      try {
        console.log(`[PRICE-FETCH] Fetching price for pool ${meteoraPoolAddress} with type ${effectivePricePoolType}`);
        const response = await fetch(`/api/meteora-pool-price?poolAddress=${meteoraPoolAddress}&poolType=${effectivePricePoolType}`);
        if (!response.ok) {
          console.log(`[PRICE-FETCH] Failed: ${response.status}`);
          setMeteoraPoolPriceInSol(null);
          return;
        }

        const data = await response.json();
        console.log(`[PRICE-FETCH] Got price: ${data.price}`);
        setMeteoraPoolPriceInSol(data.price || null);
      } catch (error) {
        console.error('[PRICE-FETCH] Error:', error);
        setMeteoraPoolPriceInSol(null);
      }
    };

    fetchPoolPrice();
  }, [meteoraPoolAddress, effectivePricePoolType]);

  // Handle MCap range updates from DLMMConfigPanel
  const handleMcapRangeChange = (minMcap: number, maxMcap: number, supply: number, useCustomRange: boolean) => {
    setDlmmMinMcap(minMcap);
    setDlmmMaxMcap(maxMcap);
    setDlmmTokenSupply(supply);
    setDlmmUseMcapRange(useCustomRange);
  };

  const poolExists = hasValidPool(selectedRift);

  // For monorifts without a pool, force the correct pool type based on rift's saved poolType
  // Only applies when creating a new pool - existing pools are auto-detected by RiftsApp
  const isMonoriftForPoolType = (selectedRift as any)?.prefixType === 1;
  // poolType might be at top level or inside raw_data
  const riftPoolType = ((selectedRift as any)?.poolType || (selectedRift as any)?.raw_data?.poolType) as string | undefined;
  const isMonoriftDammv2 = isMonoriftForPoolType && riftPoolType === 'dammv2';

  // Check if this is a monorift with DAMMV2 pool (either saved or detected)
  const isMonoriftWithDammv2Pool = isMonoriftForPoolType && (isMonoriftDammv2 || poolTypeDetected === 'cpamm');

  React.useEffect(() => {
    // Only override when there's NO existing pool (creating new pool)
    // When pool exists, let RiftsApp's auto-detection handle the poolType
    if (!poolExists) {
      if (isMonoriftForPoolType) {
        // MONORIFT (m-prefix): use DLMM or DAMMV2 based on saved pool type
        if (isMonoriftDammv2) {
          // Monorift with DAMMV2 pool type saved
          if (poolType !== 'cpamm') {
            setPoolType('cpamm');
          }
          // DAMMV2 monorifts are single-sided too
          if (!dlmmSingleSided) {
            setDlmmSingleSided(true);
          }
        } else {
          // Default: Monorift with DLMM pool
          if (poolType !== 'dlmm') {
            setPoolType('dlmm');
            setDlmmSingleSided(true);
          }
        }
      } else {
        // REGULAR RIFT (r-prefix): always use CPAMM (DAMM V2) with two-sided deposits
        if (poolType !== 'cpamm') {
          console.log('[POOL-TYPE] Regular rift detected - forcing CPAMM (DAMM V2)');
          setPoolType('cpamm');
        }
        if (dlmmSingleSided) {
          setDlmmSingleSided(false);
        }
      }
    }
  }, [poolExists, isMonoriftForPoolType, isMonoriftDammv2, poolType, dlmmSingleSided, setPoolType, setDlmmSingleSided]);

  // For existing monorift DAMMV2 pools, force single-sided mode
  React.useEffect(() => {
    if (poolExists && isMonoriftWithDammv2Pool && !dlmmSingleSided) {
      console.log('[MONORIFT-DAMMV2] Forcing single-sided mode for existing DAMMV2 monorift pool');
      setDlmmSingleSided(true);
    }
  }, [poolExists, isMonoriftWithDammv2Pool, dlmmSingleSided, setDlmmSingleSided]);

  // Force SOL pair for monorifts (they are always SOL-paired)
  React.useEffect(() => {
    if (isMonoriftForPoolType && liquidityTokenA !== 'SOL') {
      setLiquidityTokenA('SOL');
    }
  }, [isMonoriftForPoolType, liquidityTokenA, setLiquidityTokenA]);

  const handleClearAndSetTokenA = (token: 'SOL' | 'USD1') => {
    setLiquidityTokenA(token);
    setSolLiquidityAmount('');
    setRiftLiquidityAmount('');
    setDepositQuote(null);
  };

  return (
    <div className="space-y-4">
      <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-200">
        Smaller deposits leave less inventory for the arb bot to rotate, so expected arbitrage earnings drop sharply when you fund with tiny amounts.
      </div>
      {/* Configuration Row */}
      <div className="grid grid-cols-2 gap-3">
        {/* Pair Selection */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-gray-500">
            Pair
            <span className="ml-1.5 text-[10px] text-emerald-400">(locked)</span>
          </label>
          <div className="flex gap-1 p-1 bg-black/50 border border-emerald-500/10 rounded-lg">
            {/* Show USD1 option only when existing pool has USD1 detected */}
            {detectedPair === 'USD1' && (
              <SegmentButton
                active={true}
                onClick={() => {}}
                size="sm"
                disabled={true}
              >
                <span className="flex items-center gap-1">
                  USD1
                  <Check className="w-3 h-3 text-emerald-400" />
                </span>
              </SegmentButton>
            )}
            {/* SOL is always available - locked for new pools, monorifts, and SOL-detected pools */}
            {(detectedPair === 'SOL' || !detectedPair) && (
              <SegmentButton
                active={true}
                onClick={() => {}}
                size="sm"
                disabled={true}
              >
                <span className="flex items-center gap-1">
                  SOL
                  <Check className="w-3 h-3 text-emerald-400" />
                </span>
              </SegmentButton>
            )}
          </div>
        </div>

      </div>

      {/* Create New Pool Toggle - Only show when pool already exists */}
      {poolExists && (
        <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">Create New Pool</span>
              <div className="group relative">
                <Info className="w-3 h-3 text-gray-600 cursor-help" />
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-black/50 border border-emerald-500/20 rounded text-[10px] text-gray-300 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
                  A pool already exists. Enable this to create a new pool instead of adding to the existing one.
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {!createNewPool && (
                <span className="text-[10px] text-emerald-400">
                  Adding to existing pool
                </span>
              )}
              {createNewPool && (
                <span className="text-[10px] text-amber-400">
                  Creating new pool
                </span>
              )}
              <button
                onClick={() => setCreateNewPool(!createNewPool)}
                className={`relative w-8 h-4 rounded-full transition-colors ${
                  createNewPool ? 'bg-amber-500/30' : 'bg-black/50 border border-gray-700'
                }`}
              >
                <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform ${
                  createNewPool ? 'translate-x-4' : 'translate-x-0.5'
                }`} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pool Configuration - DLMM */}
      {poolType === 'dlmm' ? (() => {
        // For monorifts, find the underlying rift and use its price
        const currentPriceUsd = (() => {
          if ((selectedRift as any)?.prefixType === 1 && selectedRift?.underlyingMint && allRifts) {
            // Find the rift whose riftMint matches the monorift's underlyingMint
            // (e.g., for mRIFTS with underlyingMint=RIFTS mint, find the RIFTS rift)
            const underlyingRift = allRifts.find((r: any) =>
              r.riftMint === selectedRift.underlyingMint && r.id !== selectedRift.id
            );
            if (underlyingRift) {
              return underlyingRift.riftTokenPrice || underlyingRift.price || 0;
            }
          }
          return selectedRift?.riftTokenPrice || selectedRift?.price || 0;
        })();

        // Calculate price in SOL: riftPrice_USD / SOL_USD
        const calculatedPriceInSol = currentPriceUsd > 0 && solPriceUSD > 0
          ? currentPriceUsd / solPriceUSD
          : 0;

        // For monorifts, calculate mcap using the underlying rift's price
        // Use autoFetchedSupply (from token supply API) which is more accurate than totalRiftMinted
        const currentMcap = (() => {
          if ((selectedRift as any)?.prefixType === 1 && selectedRift?.underlyingMint && allRifts) {
            const underlyingRift = allRifts.find((r: any) =>
              r.riftMint === selectedRift.underlyingMint && r.id !== selectedRift.id
            );
            // Use dlmmTokenSupply if available (from API, more accurate), otherwise fall back to totalRiftMinted
            const underlyingSupply = dlmmTokenSupply > 0 ? dlmmTokenSupply : (underlyingRift?.totalRiftMinted || 0);
            if (underlyingRift && underlyingRift.riftTokenPrice && underlyingSupply > 0) {
              return underlyingSupply * underlyingRift.riftTokenPrice;
            }
          }
          // For non-monorifts, use the rift's own price and supply
          return selectedRift?.tvl || (selectedRift?.totalRiftMinted && selectedRift?.riftTokenPrice
            ? selectedRift.totalRiftMinted * selectedRift.riftTokenPrice
            : 0);
        })();

        return (
          <DLMMConfigPanel
            dlmmStrategy={dlmmStrategy}
            setDlmmStrategy={setDlmmStrategy}
            dlmmBinStep={dlmmBinStep}
            setDlmmBinStep={setDlmmBinStep}
            dlmmRangeInterval={dlmmRangeInterval}
            setDlmmRangeInterval={setDlmmRangeInterval}
            dlmmFeeBps={dlmmFeeBps}
            setDlmmFeeBps={setDlmmFeeBps}
            singleSided={dlmmSingleSided}
            setSingleSided={setDlmmSingleSided}
            hideSingleSidedToggle={true}
            currentPrice={currentPriceUsd}
            currentPriceInSol={calculatedPriceInSol}
            currentMcap={currentMcap}
            meteoraPoolAddress={meteoraPoolAddress}
            poolType={poolType}
            underlyingMint={selectedRift?.underlyingMint}
            onMcapRangeChange={handleMcapRangeChange}
            solPriceUSD={solPriceUSD}
          />
        );
      })() : null}

      {/* Token Inputs */}
      <div className="space-y-1">
        {/* Single-sided mode - Always active */}
        {dlmmSingleSided ? (
          <div className="p-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10">
            <div className="flex items-center gap-2 text-[10px] text-emerald-400">
              <span className="font-medium">Single-Sided Deposit</span>
              <span className="text-emerald-400/60">• No SOL pairing required</span>
            </div>
            <div className="text-[9px] text-gray-500 mt-1">
              {poolType === 'dlmm'
                ? 'Your tokens will be placed as sell orders above current price. No SOL needed.'
                : 'Depositing tokens only. Pool will handle price discovery automatically.'}
            </div>
          </div>
        ) : (
          <>
            <TokenInput
              symbol={tokenASymbol}
              balance={tokenABalance}
              value={solLiquidityAmount}
              onChange={(value) => {
                setSolLiquidityAmount(value);
                setLastEditedField('sol');
                // Auto-calculate rRIFT amount based on price when NOT in custom mode
                if (!depositQuote && value && !usePriceMode) {
                  const price = parseFloat(initialPrice);
                  const solVal = parseFloat(value);
                  if (price > 0 && !isNaN(solVal)) {
                    // initialPrice = SOL per rRIFT, so rRIFT = SOL / price
                    const riftVal = solVal / price;
                    setRiftLiquidityAmount(riftVal.toFixed(6));
                  }
                }
              }}
              onPercentClick={(pct) => {
                const value = (tokenABalance * pct / 100).toFixed(6);
                setSolLiquidityAmount(value);
                setLastEditedField('sol');
                if (!depositQuote && !usePriceMode) {
                  const price = parseFloat(initialPrice);
                  const solVal = parseFloat(value);
                  if (price > 0 && !isNaN(solVal)) {
                    const riftVal = solVal / price;
                    setRiftLiquidityAmount(riftVal.toFixed(6));
                  }
                }
              }}
              isLoading={isLoadingQuote}
            />
            <Divider />
          </>
        )}

        <TokenInput
          symbol={selectedRift.symbol}
          balance={selectedRiftBalance || 0}
          value={riftLiquidityAmount}
          onChange={(value) => {
            setRiftLiquidityAmount(value);
            setLastEditedField('rift');
            // Auto-calculate SOL amount based on price when NOT in custom mode
            if (!depositQuote && value && !usePriceMode) {
              const price = parseFloat(initialPrice);
              const riftVal = parseFloat(value);
              if (price > 0 && !isNaN(riftVal)) {
                // initialPrice = SOL per rRIFT, so SOL = rRIFT * price
                const solVal = riftVal * price;
                setSolLiquidityAmount(solVal.toFixed(6));
              }
            }
          }}
          onPercentClick={(pct) => {
            const value = ((selectedRiftBalance || 0) * pct / 100).toFixed(6);
            setRiftLiquidityAmount(value);
            setLastEditedField('rift');
            if (!depositQuote && !usePriceMode) {
              const price = parseFloat(initialPrice);
              const riftVal = parseFloat(value);
              if (price > 0 && !isNaN(riftVal)) {
                const solVal = riftVal * price;
                setSolLiquidityAmount(solVal.toFixed(6));
              }
            }
          }}
          isLoading={isLoadingQuote}
          loadingText={liquidityTokenA !== 'SOL' ? 'Searching for pool...' : 'Calculating...'}
        />
      </div>

      {/* Pool Price Display - Show for DAMMV2 SS when adding to existing pool (not creating new) */}
      {dlmmSingleSided && poolType !== 'dlmm' && poolExists && !createNewPool && meteoraPoolPriceInSol && meteoraPoolPriceInSol > 0 && (
        <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">Pool price:</span>
            <span className="text-xs text-emerald-400">
              1 {selectedRift?.symbol || 'Token'} = {meteoraPoolPriceInSol >= 1
                ? meteoraPoolPriceInSol.toFixed(4)
                : meteoraPoolPriceInSol >= 0.0001
                  ? meteoraPoolPriceInSol.toFixed(6)
                  : meteoraPoolPriceInSol >= 0.00001
                    ? meteoraPoolPriceInSol.toFixed(8)
                    : meteoraPoolPriceInSol.toFixed(10)} SOL
            </span>
          </div>
        </div>
      )}

      {/* Price Configuration - Show when creating new pool OR no pool exists OR DLMM (always new pool) */}
      {(createNewPool || !poolExists || poolType === 'dlmm') && (() => {
        // Calculate auto-fetched price in quote token terms (SOL or USD1)
        // For SOL pairs: need riftTokenPrice_USD / SOL_price_USD
        // For USD1 pairs: need riftTokenPrice_USD / 1.0 (USD1 is a stablecoin)

        // Get the quote token price
        let quoteTokenPriceUSD = 0;
        if (liquidityTokenA === 'SOL') {
          // Use fetched SOL price
          quoteTokenPriceUSD = solPriceUSD;
        } else if (liquidityTokenA === 'USD1') {
          // USD1 is a stablecoin, price is ~$1.00
          quoteTokenPriceUSD = 1.0;
        }

        // For monorifts, use the underlying token's price
        const riftTokenPriceUsd = (() => {
          if (dlmmPriceOverrideUsd) return dlmmPriceOverrideUsd;

          if ((selectedRift as any)?.prefixType === 1 && selectedRift?.underlyingMint && allRifts) {
            // First try: use the monorift's own underlyingTokenPrice (from database/cache)
            if (selectedRift.underlyingTokenPrice && selectedRift.underlyingTokenPrice > 0) {
              return selectedRift.underlyingTokenPrice;
            }
            // Fallback: find the underlying rift (whose riftMint matches this monorift's underlyingMint)
            const underlyingRift = allRifts.find((r: any) =>
              r.riftMint === selectedRift.underlyingMint && r.id !== selectedRift.id
            );
            if (underlyingRift) {
              const price = underlyingRift.riftTokenPrice || underlyingRift.underlyingTokenPrice || underlyingRift.price || 0;
              return price;
            }
          }
          // For regular rifts, try to find an underlying rift with price data
          if (selectedRift?.underlyingMint && allRifts) {
            // Look for a rift whose riftMint matches this rift's underlyingMint
            const underlyingRift = allRifts.find((r: any) =>
              r.riftMint === selectedRift.underlyingMint && r.id !== selectedRift.id
            );
            if (underlyingRift) {
              const price = underlyingRift.riftTokenPrice || underlyingRift.underlyingTokenPrice || underlyingRift.price || 0;
              if (price > 0) {
                return price;
              }
            }
          }
          // Final fallback: check all price fields on the rift itself
          return selectedRift?.riftTokenPrice || selectedRift?.underlyingTokenPrice || selectedRift?.price || 0;
        })();

        // Check if we're adding to an existing pool (not creating new)
        const isAddingToExistingPool = poolExists && !createNewPool;

        // Calculate auto price:
        // 1. If adding to existing pool: use actual pool price from Meteora
        // 2. For new pools: use LIVE price from Jupiter/Dexscreener (like DLMM does)
        // 3. Fallback: use Meteora pool price or cached USD prices
        const autoFetchedPrice = (() => {
          // For existing pools: use actual pool price from Meteora
          if (isAddingToExistingPool && meteoraPoolPriceInSol && meteoraPoolPriceInSol > 0) {
            return meteoraPoolPriceInSol;
          }
          // For new pools: use LIVE price from Jupiter/Dexscreener (same as DLMM)
          if (createNewPool && liveTokenPriceUsd && liveTokenPriceUsd > 0 && quoteTokenPriceUSD > 0) {
            const livePrice = liveTokenPriceUsd / quoteTokenPriceUSD;
            console.log(`[AUTO-PRICE] Using live price: $${liveTokenPriceUsd} / $${quoteTokenPriceUSD} = ${livePrice} SOL`);
            return livePrice;
          }
          // Fallback: use Meteora pool price if available
          if (meteoraPoolPriceInSol && meteoraPoolPriceInSol > 0 && liquidityTokenA === 'SOL') {
            return meteoraPoolPriceInSol;
          }
          // Last fallback: cached USD prices
          if (riftTokenPriceUsd && quoteTokenPriceUSD > 0) {
            return riftTokenPriceUsd / quoteTokenPriceUSD;
          }
          return 0;
        })();

        // Has valid auto price
        const hasAutoPrice = autoFetchedPrice > 0;

        // Auto-set initial price when we have a valid auto price and user hasn't manually set custom
        // Only auto-set if current value is default (1.0 or empty) OR if it matches the old auto value
        if (hasAutoPrice && !usePriceMode && (initialPrice === '1.0' || initialPrice === '' || parseFloat(initialPrice) <= 0)) {
          // Use setTimeout to avoid state update during render
          setTimeout(() => {
            setInitialPrice(autoFetchedPrice.toFixed(8));
            setLiquidityRatio(1 / autoFetchedPrice);
          }, 0);
        }

        // For display: format the auto price nicely
        const formatAutoPrice = (price: number) => {
          if (price === 0) return '—';
          if (price >= 1) return price.toFixed(4);
          if (price >= 0.0001) return price.toFixed(6);
          if (price >= 0.00001) return price.toFixed(8);
          // For very small prices, show up to 10 decimal places
          return price.toFixed(10);
        };

        return (
          <div className={`p-3 rounded-lg border bg-black/30 ${
            poolType === 'dlmm' && dlmmSingleSided ? 'border-amber-500/20' : 'border-emerald-500/20'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400">
                  {poolType === 'dlmm' ? 'Starting Price' : 'Custom Price'}
                </span>
                <div className="group relative">
                  <Info className="w-3 h-3 text-gray-600 cursor-help" />
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-black/50 border border-emerald-500/20 rounded text-[10px] text-gray-300 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
                    {isAddingToExistingPool
                      ? 'The current price from the existing pool.'
                      : poolType === 'dlmm'
                        ? 'The current market price. Enable Custom to set a different starting price.'
                        : 'Set a custom price ratio for the new pool. If disabled, price is determined by the amounts you enter.'}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {/* Show pool price when adding to existing pool, or auto-fetched price for new pools */}
                {hasAutoPrice && !usePriceMode && (
                  <span className="text-[10px] text-emerald-400">
                    ✓ {isAddingToExistingPool ? 'Pool Price' : 'Auto'}: {formatAutoPrice(autoFetchedPrice)} {tokenASymbol}
                  </span>
                )}
                {/* Show loading message when fetching price */}
                {!hasAutoPrice && solPriceUSD === 0 && (
                  <span className="text-[10px] text-gray-500">
                    Fetching price...
                  </span>
                )}
                {/* Show manual message when no auto price after fetch */}
                {!hasAutoPrice && solPriceUSD > 0 && (
                  <span className="text-[10px] text-amber-400">
                    Set price manually
                  </span>
                )}
                {/* Custom toggle - only show when auto price is available AND not adding to existing pool */}
                {hasAutoPrice && !isAddingToExistingPool && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] text-gray-500">Custom</span>
                    <button
                      onClick={() => {
                        const newMode = !usePriceMode;
                        setUsePriceMode(newMode);
                        if (!newMode) {
                          // Switching to auto mode - use fetched price
                          setInitialPrice(autoFetchedPrice.toString());
                          setLiquidityRatio(1 / autoFetchedPrice);
                        }
                      }}
                      className={`relative w-8 h-4 rounded-full transition-colors ${
                        usePriceMode ? 'bg-amber-500/30' : 'bg-black/50 border border-gray-700'
                      }`}
                    >
                      <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform ${
                        usePriceMode ? 'translate-x-4' : 'translate-x-0.5'
                      }`} />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Custom price input - show when custom mode is ON or no auto price available (but NOT when adding to existing pool) */}
            {!isAddingToExistingPool && (usePriceMode || !hasAutoPrice) && (
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-emerald-500/20">
                <span className="text-xs text-gray-500">1 {selectedRift.symbol} =</span>
                <input
                  type="number"
                  value={initialPrice}
                  onChange={(e) => {
                    setInitialPrice(e.target.value);
                    const price = parseFloat(e.target.value);
                    if (!isNaN(price) && price > 0) {
                      setLiquidityRatio(1 / price);
                    }
                  }}
                  placeholder="0.0001"
                  step="0.000001"
                  min="0"
                  className={`w-24 px-2 py-1 bg-black/50 border rounded text-white text-xs outline-none ${
                    poolType === 'dlmm' && dlmmSingleSided
                      ? 'border-amber-500/20 focus:border-amber-500/40'
                      : 'border-emerald-500/20 focus:border-emerald-500/40'
                  }`}
                />
                <span className="text-xs text-gray-500">{tokenASymbol}</span>
                {hasAutoPrice && (
                  <button
                    onClick={() => {
                      setInitialPrice(autoFetchedPrice.toString());
                      setLiquidityRatio(1 / autoFetchedPrice);
                    }}
                    className="px-1.5 py-0.5 text-[9px] text-emerald-400 hover:bg-emerald-500/10 rounded transition-colors"
                  >
                    Use Auto
                  </button>
                )}
              </div>
            )}

          {/* Display current effective price */}
          <div className="mt-2 text-[10px] text-gray-500">
            {(() => {
              const effective = (usePriceMode || !hasAutoPrice) ? parseFloat(initialPrice) || 0 : autoFetchedPrice;
              if (!effective || Number.isNaN(effective)) return `Pool price: 1 ${selectedRift.symbol} = —`;
              return `Pool price: 1 ${selectedRift.symbol} = ${formatAutoPrice(effective)} ${tokenASymbol}`;
            })()}
          </div>
        </div>
      );
    })()}

      {/* Deposit Quote Preview - Only show when adding to existing pool (not for single-sided DLMM) */}
      {poolExists && !createNewPool && depositQuote && !(poolType === 'dlmm' && dlmmSingleSided) && (
        <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
          <div className="flex items-center justify-between text-xs text-gray-400 mb-2">
            <span>Deposit Preview</span>
            <span className="font-mono">Ratio: {depositQuote.poolRatio >= 1 ? depositQuote.poolRatio.toFixed(2) : depositQuote.poolRatio.toFixed(4)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="p-2 bg-black/60 rounded text-center">
              <div className="text-[10px] text-gray-500">{tokenASymbol}</div>
              <div className="text-sm font-semibold text-white">{depositQuote.wsolNeeded.toFixed(6)}</div>
            </div>
            <div className="p-2 bg-black/60 rounded text-center">
              <div className="text-[10px] text-gray-500">{selectedRift.symbol}</div>
              <div className="text-sm font-semibold text-white">{depositQuote.riftNeeded.toFixed(6)}</div>
            </div>
          </div>
        </div>
      )}

      {/* Quote Error - hide for single-sided DLMM */}
      {hasValidPool(selectedRift) && quoteError && !(poolType === 'dlmm' && dlmmSingleSided) && (
        <div className="p-3 rounded-lg border border-red-900/50 bg-red-950/30">
          <p className="text-xs text-red-400">{quoteError}</p>
        </div>
      )}

      {/* Pool Info */}
      {!hasValidPool(selectedRift) && (
        <div className="p-2.5 rounded-lg border border-emerald-500/20 bg-black/30">
          <div className="flex items-center gap-2 text-xs">
            {poolType === 'dlmm' ? (
              <>
                <div className={`w-1.5 h-1.5 rounded-full ${dlmmSingleSided ? 'bg-amber-500' : 'bg-gray-500'}`} />
                <span className="text-gray-300">DLMM</span>
                {dlmmSingleSided && (
                  <>
                    <span className="text-emerald-500/30">|</span>
                    <span className="text-amber-400">1-sided</span>
                  </>
                )}
                <span className="text-emerald-500/30">|</span>
                <span className="text-gray-500">Fee: {(parseInt(dlmmFeeBps) / 100).toFixed(1)}%</span>
                <span className="text-emerald-500/30">|</span>
                <span className="text-gray-500">Bin: {dlmmBinStep}</span>
                <span className="text-emerald-500/30">|</span>
                <span className="text-gray-500">{dlmmSingleSided ? '+' : '+/-'}{dlmmRangeInterval} bins</span>
              </>
            ) : (
              <>
                <div className="w-1.5 h-1.5 rounded-full bg-gray-500" />
                <span className="text-gray-300">DAMM V2</span>
                <span className="text-emerald-500/30">|</span>
                <span className="text-gray-500">Fee: 0.25% (dynamic)</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// Remove Liquidity Content Component
const RemoveLiquidityContent: React.FC<{
  selectedRift: RiftData;
  removeMode: 'percentage' | 'positions';
  setRemoveMode: (mode: 'percentage' | 'positions') => void;
  removePercentage: string;
  setRemovePercentage: (pct: string) => void;
  userLpPositions: LpPosition[];
  selectedPositions: Set<string>;
  setSelectedPositions: (positions: Set<string>) => void;
  positionRemovalPercentages: Record<string, number>;
  setPositionRemovalPercentages: (percentages: Record<string, number>) => void;
  isLoadingLpBalance: boolean;
  detailedPositions: DetailedPosition[];
  estimatedWithdrawal: EstimatedWithdrawal | null;
  poolTypeDetected: 'dlmm' | 'cpamm' | null;
  dlmmPendingFees: PendingFees | null;
  cpammPendingFees: PendingFees | null;
  isClaimingLpFees: boolean;
  handleClaimLpFees: () => void;
}> = ({
  selectedRift,
  removeMode,
  setRemoveMode,
  removePercentage: _removePercentage,
  setRemovePercentage,
  userLpPositions,
  selectedPositions,
  setSelectedPositions,
  positionRemovalPercentages,
  setPositionRemovalPercentages,
  isLoadingLpBalance,
  detailedPositions,
  estimatedWithdrawal: _estimatedWithdrawal,
  poolTypeDetected,
  dlmmPendingFees,
  cpammPendingFees,
  isClaimingLpFees,
  handleClaimLpFees,
}) => {
  void _removePercentage; // Used for global percentage mode compatibility
  void _estimatedWithdrawal; // Calculated per-position now
  return (
    <div className="space-y-4">
      {/* Header Info */}
      <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center">
            <Minus className="w-4 h-4 text-red-400" />
          </div>
          <div>
            <span className="text-sm font-medium text-white">
              Remove from {selectedRift.underlying} / {selectedRift.symbol}
            </span>
          </div>
        </div>
      </div>

      {/* Mode Selector */}
      {!isLoadingLpBalance && userLpPositions.length > 0 && (
        <div className="flex gap-1 p-1 bg-black/50 border border-emerald-500/10 rounded-lg">
          <TabButton
            active={removeMode === 'percentage'}
            onClick={() => setRemoveMode('percentage')}
            variant="danger"
          >
            By Percentage
          </TabButton>
          <TabButton
            active={removeMode === 'positions'}
            onClick={() => setRemoveMode('positions')}
            variant="danger"
          >
            By Position
          </TabButton>
        </div>
      )}

      {/* Content */}
      {isLoadingLpBalance ? (
        <div className="p-6 rounded-lg border border-emerald-500/20 bg-black/30 flex items-center justify-center">
          <div className="flex items-center gap-2 text-gray-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading positions...</span>
          </div>
        </div>
      ) : userLpPositions.length === 0 ? (
        <div className="p-4 rounded-lg border border-amber-900/50 bg-amber-950/20">
          <p className="text-sm text-amber-400">
            You don't have any LP positions in this pool. Add liquidity first to earn trading fees.
          </p>
        </div>
      ) : removeMode === 'percentage' ? (
        <div className="space-y-4">
          {/* Quick Apply to All */}
          <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-400">
                Apply to All Positions
              </label>
              <div className="flex gap-1">
                {[25, 50, 100].map((pct) => (
                  <button
                    key={pct}
                    onClick={() => {
                      setRemovePercentage(pct.toString());
                      // Apply to all positions
                      const newPercentages: Record<string, number> = {};
                      userLpPositions.forEach(pos => {
                        newPercentages[pos.address] = pct;
                      });
                      setPositionRemovalPercentages(newPercentages);
                    }}
                    className={`px-2 py-1 text-xs font-medium rounded transition-colors ${
                      pct === 100
                        ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20'
                        : 'text-gray-500 hover:text-emerald-400 hover:bg-emerald-500/10'
                    }`}
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Individual Position Controls */}
          <div className="space-y-3 max-h-[300px] overflow-y-auto">
            {userLpPositions.map((position, idx) => {
              const detailed = detailedPositions.find(d => d.address === position.address);
              const removalPct = positionRemovalPercentages[position.address] || 0;

              return (
                <div
                  key={position.address}
                  className={`p-3 rounded-lg border transition-all ${
                    removalPct > 0
                      ? 'border-red-500/30 bg-red-500/5'
                      : 'border-emerald-500/20 bg-black/30'
                  }`}
                >
                  {/* Position Header */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white">Position #{idx + 1}</span>
                        {position.isDlmm && (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-purple-500/20 text-purple-400 rounded">DLMM</span>
                        )}
                        {!position.isDlmm && (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500/20 text-emerald-400 rounded">DAMM</span>
                        )}
                      </div>
                      <CopyableAddress address={position.address} label="Position" />
                      {position.poolAddress && (
                        <CopyableAddress address={position.poolAddress} label="Pool" />
                      )}
                    </div>
                    {detailed && (
                      <span className="text-xs text-gray-400">
                        {detailed.percentageOfTotal.toFixed(1)}% of total
                      </span>
                    )}
                  </div>

                  {/* Removal Percentage Slider */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-500">Remove:</span>
                      <span className={`text-sm font-semibold ${removalPct > 0 ? 'text-red-400' : 'text-gray-500'}`}>
                        {removalPct}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={removalPct}
                      onChange={(e) => {
                        const newPct = parseInt(e.target.value);
                        setPositionRemovalPercentages({
                          ...positionRemovalPercentages,
                          [position.address]: newPct
                        });
                      }}
                      className="w-full h-1.5 bg-black/50 rounded-lg appearance-none cursor-pointer accent-red-500"
                    />
                    <div className="flex gap-1">
                      {[0, 25, 50, 75, 100].map((pct) => (
                        <button
                          key={pct}
                          onClick={() => {
                            setPositionRemovalPercentages({
                              ...positionRemovalPercentages,
                              [position.address]: pct
                            });
                          }}
                          className={`flex-1 py-1 text-[10px] font-medium rounded transition-colors ${
                            removalPct === pct
                              ? pct === 100
                                ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                                : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                              : 'text-gray-600 hover:text-gray-400 hover:bg-black/30'
                          }`}
                        >
                          {pct === 0 ? 'Keep' : `${pct}%`}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Estimated Values */}
                  {removalPct > 0 && (
                    <div className="mt-3 pt-3 border-t border-emerald-500/10">
                      <p className="text-[10px] text-gray-500 mb-1">You'll receive from this position:</p>
                      {detailed ? (
                        <div className="flex gap-3 text-xs">
                          <span className="text-gray-400">
                            ~{(detailed.estimatedTokenA * removalPct / 100).toFixed(4)} {selectedRift.symbol}
                          </span>
                          <span className="text-gray-400">
                            ~{(detailed.estimatedTokenB * removalPct / 100).toFixed(4)} SOL
                          </span>
                        </div>
                      ) : (
                        <p className="text-xs text-gray-500 italic">Estimates not available for this position type</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Total Estimated Withdrawal */}
          {Object.values(positionRemovalPercentages).some(p => p > 0) && detailedPositions.length > 0 && (
            <div className="p-3 rounded-lg border border-red-500/20 bg-red-500/5">
              <p className="text-xs font-medium text-gray-400 mb-2">Total You Will Receive (from positions with estimates)</p>
              <div className="bg-black/50 rounded p-3 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{selectedRift.symbol}</span>
                  <span className="text-white font-medium">
                    ~{detailedPositions.reduce((sum, pos) => {
                      const pct = positionRemovalPercentages[pos.address] || 0;
                      return sum + (pos.estimatedTokenA * pct / 100);
                    }, 0).toFixed(6)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">SOL</span>
                  <span className="text-white font-medium">
                    ~{detailedPositions.reduce((sum, pos) => {
                      const pct = positionRemovalPercentages[pos.address] || 0;
                      return sum + (pos.estimatedTokenB * pct / 100);
                    }, 0).toFixed(6)}
                  </span>
                </div>
              </div>
              <p className="text-[10px] text-gray-600 mt-2">* Estimate based on current pool state. DLMM positions may not have estimates.</p>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Position Selection - "By Position" mode for full removal */}
          <div className="p-4 rounded-lg border border-emerald-500/20 bg-black/30">
            <div className="flex items-center justify-between mb-3">
              <label className="text-xs font-medium text-gray-400">
                Select Positions to Close (100% removal)
              </label>
              <div className="flex gap-2 text-xs">
                <button
                  onClick={() => setSelectedPositions(new Set(userLpPositions.map(p => p.address)))}
                  className="text-gray-400 hover:text-white transition-colors"
                >
                  Select All
                </button>
                <span className="text-emerald-500/30">|</span>
                <button
                  onClick={() => setSelectedPositions(new Set())}
                  className="text-red-400 hover:text-red-300 transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>

            <div className="space-y-2 max-h-48 overflow-y-auto">
              {userLpPositions.map((position, idx) => {
                const detailed = detailedPositions.find(d => d.address === position.address);

                return (
                  <div
                    key={position.address}
                    className={`p-3 rounded-lg border cursor-pointer transition-all ${
                      selectedPositions.has(position.address)
                        ? 'bg-red-500/5 border-red-500/30'
                        : 'bg-black/40 border-emerald-500/20 hover:border-emerald-500/40'
                    }`}
                    onClick={() => {
                      const newSelected = new Set(selectedPositions);
                      if (newSelected.has(position.address)) {
                        newSelected.delete(position.address);
                      } else {
                        newSelected.add(position.address);
                      }
                      setSelectedPositions(newSelected);
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                        selectedPositions.has(position.address)
                          ? 'bg-red-500 border-red-500'
                          : 'border-gray-600'
                      }`}>
                        {selectedPositions.has(position.address) && (
                          <Check className="w-3 h-3 text-white" />
                        )}
                      </div>
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-white">Position #{idx + 1}</span>
                          {position.isDlmm ? (
                            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-purple-500/20 text-purple-400 rounded">DLMM</span>
                          ) : (
                            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500/20 text-emerald-400 rounded">DAMM</span>
                          )}
                          {detailed && (
                            <span className="text-xs text-gray-500 ml-auto">
                              {detailed.percentageOfTotal.toFixed(1)}% of total
                            </span>
                          )}
                        </div>
                        <CopyableAddress address={position.address} label="Position" />
                        {position.poolAddress && (
                          <CopyableAddress address={position.poolAddress} label="Pool" />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Selection Summary */}
          {selectedPositions.size > 0 && (
            <div className="p-3 rounded-lg border border-red-500/20 bg-red-500/5">
              <h4 className="text-xs font-medium text-red-400 mb-2">
                Closing {selectedPositions.size} position{selectedPositions.size !== 1 ? 's' : ''} (100% removal)
              </h4>
              <p className="text-xs text-gray-500">
                Selected positions will be fully closed. You'll receive all tokens back.
              </p>
            </div>
          )}
        </div>
      )}

      {/* LP Fees Section - moved outside the conditional */}
      {poolTypeDetected && userLpPositions.length > 0 && (
        <div className="p-4 rounded-lg border border-emerald-500/20 bg-black/30">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${poolTypeDetected === 'dlmm' ? 'bg-purple-500' : 'bg-emerald-500'}`} />
              <span className="text-xs font-medium text-gray-300">
                {poolTypeDetected === 'dlmm' ? 'DLMM' : 'DAMM V2'} Pool Fees
              </span>
            </div>
            <button
              onClick={handleClaimLpFees}
              disabled={isClaimingLpFees || (poolTypeDetected === 'dlmm' ? !dlmmPendingFees : !cpammPendingFees)}
              className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-500/20 hover:bg-emerald-500/30 disabled:bg-black/50 disabled:text-gray-600 rounded transition-colors flex items-center gap-1.5"
            >
              {isClaimingLpFees ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Claiming...
                </>
              ) : (
                <>
                  <Coins className="w-3 h-3" />
                  Claim Fees
                </>
              )}
            </button>
          </div>

          <div className="p-3 rounded bg-black/60">
            <p className="text-[10px] font-medium text-gray-500 mb-2 uppercase tracking-wide">Accumulated Fees</p>
            {poolTypeDetected === 'dlmm' ? (
              dlmmPendingFees ? (
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="flex justify-between p-2 bg-gray-950/50 rounded">
                    <span className="text-gray-500">{selectedRift.symbol}</span>
                    <span className="text-white font-mono">{dlmmPendingFees.tokenX?.toFixed(6) || '0'}</span>
                  </div>
                  <div className="flex justify-between p-2 bg-gray-950/50 rounded">
                    <span className="text-gray-500">{selectedRift.underlying}</span>
                    <span className="text-white font-mono">{dlmmPendingFees.tokenY?.toFixed(6) || '0'}</span>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-gray-600">No pending fees</p>
              )
            ) : (
              cpammPendingFees ? (
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="flex justify-between p-2 bg-gray-950/50 rounded">
                    <span className="text-gray-500">{selectedRift.underlying}</span>
                    <span className="text-white font-mono">{cpammPendingFees.tokenA?.toFixed(6) || '0'}</span>
                  </div>
                  <div className="flex justify-between p-2 bg-gray-950/50 rounded">
                    <span className="text-gray-500">{selectedRift.symbol}</span>
                    <span className="text-white font-mono">{cpammPendingFees.tokenB?.toFixed(6) || '0'}</span>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-gray-600">No pending fees</p>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default LiquidityModal;
