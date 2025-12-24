// utils/index.ts - Utility Functions & Helpers

import { Rift, Token } from '@/types';

// ==================== FORMATTING UTILITIES ====================

export const formatNumber = (num: number): string => {
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
  return num.toFixed(2);
};

export const formatCurrency = (
  amount: number, 
  currency: string = 'USD',
  minimumFractionDigits: number = 2
): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits,
    maximumFractionDigits: minimumFractionDigits,
  }).format(amount);
};

export const formatPercentage = (
  value: number, 
  decimals: number = 2,
  showSign: boolean = true
): string => {
  const formatted = value.toFixed(decimals);
  const sign = showSign && value > 0 ? '+' : '';
  return `${sign}${formatted}%`;
};

export const formatAddress = (
  address: string | null,
  startChars: number = 6,
  endChars: number = 4
): string => {
  if (!address) return '';
  if (address.length <= startChars + endChars) return address;
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
};

export const formatRiftAddress = (
  address: string | null,
  startChars: number = 6
): string => {
  if (!address) return '';
  if (address.length <= startChars + 4) return address; // If too short, return as-is
  return `${address.slice(0, startChars)}...rift`;
};

export const formatTimeRemaining = (timestamp: number): string => {
  const diff = timestamp - Date.now();
  if (diff <= 0) return 'Expired';
  
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

export const formatDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

// ==================== VALIDATION UTILITIES ====================

export const isValidAddress = (address: string): boolean => {
  // Basic Solana address validation
  const solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return solanaAddressRegex.test(address);
};

export const isValidAmount = (amount: string, maxDecimals: number = 18): boolean => {
  if (!amount || amount === '0' || amount === '.') return false;
  
  const numericRegex = new RegExp(`^\\d+(\\.\\d{1,${maxDecimals}})?$`);
  return numericRegex.test(amount) && parseFloat(amount) > 0;
};

export const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// ==================== CALCULATION UTILITIES ====================

export const calculateTotalValue = (
  amount: number, 
  price: number, 
  fees: number = 0
): number => {
  return (amount * price) * (1 - fees);
};

export const calculatePnL = (
  currentValue: number, 
  initialValue: number
): { amount: number; percentage: number } => {
  const amount = currentValue - initialValue;
  const percentage = initialValue > 0 ? (amount / initialValue) * 100 : 0;
  return { amount, percentage };
};

export const calculateAPY = (
  principal: number,
  finalAmount: number,
  timeInDays: number
): number => {
  if (principal <= 0 || timeInDays <= 0) return 0;
  const rate = (finalAmount / principal) - 1;
  return (Math.pow(1 + rate, 365 / timeInDays) - 1) * 100;
};

export const calculateCompoundInterest = (
  principal: number,
  rate: number,
  time: number,
  compoundingFrequency: number = 365
): number => {
  return principal * Math.pow(1 + rate / compoundingFrequency, compoundingFrequency * time);
};

export const calculateSlippage = (
  expectedAmount: number,
  actualAmount: number
): number => {
  if (expectedAmount <= 0) return 0;
  return ((expectedAmount - actualAmount) / expectedAmount) * 100;
};

// ==================== SORTING UTILITIES ====================

export const sortRiftsByApy = (rifts: Rift[], ascending: boolean = false): Rift[] => {
  return [...rifts].sort((a, b) => ascending ? a.apy - b.apy : b.apy - a.apy);
};

export const sortRiftsByTvl = (rifts: Rift[], ascending: boolean = false): Rift[] => {
  return [...rifts].sort((a, b) => ascending ? a.tvl - b.tvl : b.tvl - a.tvl);
};

export const sortTokensByPrice = (tokens: Token[], ascending: boolean = false): Token[] => {
  return [...tokens].sort((a, b) => ascending ? a.price - b.price : b.price - a.price);
};

export const sortByRisk = (rifts: Rift[]): Rift[] => {
  const riskOrder = { 'Very Low': 0, 'Low': 1, 'Medium': 2, 'High': 3 };
  return [...rifts].sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk]);
};

// ==================== FILTER UTILITIES ====================

export const filterRiftsByRisk = (rifts: Rift[], risks: string[]): Rift[] => {
  return rifts.filter(rift => risks.includes(rift.risk));
};

export const filterRiftsByMinApy = (rifts: Rift[], minApy: number): Rift[] => {
  return rifts.filter(rift => rift.apy >= minApy);
};

export const filterRiftsByMinTvl = (rifts: Rift[], minTvl: number): Rift[] => {
  return rifts.filter(rift => rift.tvl >= minTvl);
};

export const searchRifts = (rifts: Rift[], query: string): Rift[] => {
  const lowercaseQuery = query.toLowerCase();
  return rifts.filter(rift => 
    rift.symbol.toLowerCase().includes(lowercaseQuery) ||
    rift.underlying.toLowerCase().includes(lowercaseQuery) ||
    rift.strategy.toLowerCase().includes(lowercaseQuery)
  );
};

// ==================== COLOR UTILITIES ====================

export const getRiskColor = (risk: string): string => {
  const colors = {
    'Very Low': 'emerald',
    'Low': 'blue',
    'Medium': 'yellow',
    'High': 'red'
  };
  return colors[risk as keyof typeof colors] || 'gray';
};

export const getTrendColor = (value: number): string => {
  if (value > 0) return 'emerald';
  if (value < 0) return 'red';
  return 'gray';
};

export const getPerformanceColor = (percentage: number): string => {
  if (percentage >= 20) return 'emerald';
  if (percentage >= 10) return 'blue';
  if (percentage >= 0) return 'yellow';
  return 'red';
};

// ==================== ANIMATION UTILITIES ====================

export const staggerChildren = {
  animate: {
    transition: {
      staggerChildren: 0.1
    }
  }
};

export const fadeInUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -20 }
};

export const slideInFromRight = {
  initial: { opacity: 0, x: 100 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -100 }
};

export const scaleIn = {
  initial: { opacity: 0, scale: 0.8 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.8 }
};

export const rotateIn = {
  initial: { opacity: 0, rotate: -180 },
  animate: { opacity: 1, rotate: 0 },
  exit: { opacity: 0, rotate: 180 }
};

// ==================== ERROR HANDLING UTILITIES ====================

export const handleAsyncError = async <T>(
  asyncFn: () => Promise<T>,
  fallbackValue?: T
): Promise<T | undefined> => {
  try {
    return await asyncFn();
  } catch (error) {
    // Async operation failed - error handled silently
    return fallbackValue;
  }
};

export const createErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'An unexpected error occurred';
};

// ==================== DEBOUNCE UTILITY ====================

export const debounce = <T extends (...args: unknown[]) => void>(
  func: T,
  wait: number
): T => {
  let timeout: NodeJS.Timeout;
  
  return ((...args: unknown[]) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...(args as Parameters<T>)), wait);
  }) as T;
};

// ==================== LOCAL STORAGE UTILITIES ====================

export const safeLocalStorageGet = <T>(key: string, defaultValue: T): T => {
  if (typeof window === 'undefined') return defaultValue;

  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : defaultValue;
  } catch {
    return defaultValue;
  }
};

export const safeLocalStorageSet = <T>(key: string, value: T): boolean => {
  if (typeof window === 'undefined') return false;

  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

// ==================== TOKEN UTILITIES ====================

export { fetchTokenMetadata, generateRiftSymbol, generateRiftName, type TokenMetadata } from './token-metadata';