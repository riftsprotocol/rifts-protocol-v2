// types/index.ts - Core Type Definitions

export interface UserPosition {
  riftId: string;
  wrapped: number;
  lpStaked: number;
  rewards: number;
  totalValue: number;
  pnl: number;
}

export interface Token {
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  mintAddress: string;
  icon?: string;
  marketCap?: number;
  volume24h?: number;
}

export interface Rift {
  id: string;
  symbol: string;
  underlying: string;
  tvl: number;
  backingRatio: number;
  volume24h: number;
  burnFee: number;
  partnerFee: number;
  apy: number;
  nextRebalance: number;
  volumeProgress: number;
  strategy: string;
  risk: 'Very Low' | 'Low' | 'Medium' | 'High';
  maxCapacity: number;
  isActive: boolean;
  performance: number[];
  participants: number;
}

export interface RealTimeData {
  totalTvl: number;
  volume24h: number;
  activeRifts: number;
  riftsPrice: number;
  totalUsers: number;
  networkFees: number;
}

export interface WalletState {
  connected: boolean;
  publicKey: string | null;
  balance: number;
  isConnecting: boolean;
}

export interface AnimatedMetricProps {
  label: string;
  value: string | number;
  change?: string;
  trend?: 'up' | 'down' | 'neutral';
  icon: React.ComponentType<{ className?: string }>;
  prefix?: string;
  suffix?: string;
}

export interface LuxuryButtonProps {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
}

export interface GlassmorphismCardProps {
  children: React.ReactNode;
  className?: string;
  interactive?: boolean;
}

export interface AdvancedProgressBarProps {
  value: number;
  max?: number;
  className?: string;
  showLabel?: boolean;
  gradient?: boolean;
}

export interface RiftCardProps {
  rift: Rift;
  userPositions: UserPosition[];
  formatNumber: (num: number) => string;
  timeUntilRebalance: (timestamp: number) => string;
}

export type TabValue = 'overview' | 'rifts' | 'trade' | 'portfolio' | 'analytics';

export interface TabConfig {
  value: TabValue;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}