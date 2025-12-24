// components/transactions/index.tsx - Real Transaction Components

"use client";

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  AlertCircle, 
  CheckCircle, 
  Clock, 
  ExternalLink,
  TrendingUp,
  TrendingDown,
  Plus,
  Minus,
  Gift,
  Zap,
  Flame,
  Users,
  Info
} from 'lucide-react';
import { useRiftOperations, useTransactionToast, useRealWallet } from '@/hooks/useWallet';

// ==================== TRANSACTION TOAST NOTIFICATIONS ====================

export const TransactionToasts: React.FC = () => {
  const { toasts, removeToast } = useTransactionToast();

  return (
    <div className="fixed top-4 right-4 z-[100] space-y-2">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, x: 300, scale: 0.8 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 300, scale: 0.8 }}
            className={`p-4 rounded-xl backdrop-blur-xl border max-w-sm ${
              toast.type === 'success' 
                ? 'bg-emerald-900/20 border-emerald-500/30 text-emerald-400'
                : toast.type === 'error'
                ? 'bg-red-900/20 border-red-500/30 text-red-400'
                : 'bg-blue-900/20 border-blue-500/30 text-blue-400'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-0.5">
                {toast.type === 'success' && <CheckCircle className="w-5 h-5" />}
                {toast.type === 'error' && <AlertCircle className="w-5 h-5" />}
                {toast.type === 'pending' && (
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                  >
                    <Clock className="w-5 h-5" />
                  </motion.div>
                )}
              </div>
              
              <div className="flex-1">
                <p className="text-sm font-medium">{toast.message}</p>
                {toast.signature && (
                  <a
                    href={`https://solscan.io/tx/${toast.signature}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 mt-1 text-xs transition-opacity opacity-70 hover:opacity-100"
                  >
                    View on Solscan
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
              
              <button
                onClick={() => removeToast(toast.id)}
                className="transition-colors text-white/50 hover:text-white/80"
              >
                ×
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};

// ==================== WRAP MODAL ====================

interface WrapModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  rift: {
    id: string;
    symbol: string;
    underlying: string;
    burnFee: number;
    partnerFee: number;
    backingRatio: number;
    tvl: number;
    volume24h: number;
  };
  userBalance: number;
}

export const WrapModal: React.FC<WrapModalProps> = ({ 
  isOpen, 
  onClose, 
  onSuccess,
  rift, 
  userBalance 
}) => {
  const [amount, setAmount] = useState('');
  const { wrap, loading, error, clearError } = useRiftOperations();
  const { notifyTransaction } = useTransactionToast();
  const { refreshBalance } = useRealWallet();

  const handleWrap = async () => {
    const wrapAmount = parseFloat(amount);
    
    if (isNaN(wrapAmount) || wrapAmount <= 0) {
      return;
    }

    if (wrapAmount > userBalance) {
      return;
    }

    clearError();
    
    // Show pending notification
    notifyTransaction('pending', 'Processing wrap transaction...');
    
    try {
      const result = await wrap(rift.id, wrapAmount);
      
      if (result.success) {
        notifyTransaction('success', `Successfully wrapped ${amount} ${rift.underlying} to r${rift.underlying}`, result.signature);
        
        // Auto-refresh wallet balance
        try {
          await refreshBalance();
        } catch (refreshError) {
          
        }
        
        // Call success callback to refresh positions
        if (onSuccess) {
          try {
            await onSuccess();
          } catch (successError) {
            
          }
        }
        
        onClose();
        setAmount('');
      } else {
        notifyTransaction('error', 'Wrap transaction failed. Please try again.');
      }
    } catch {
      notifyTransaction('error', 'Wrap transaction failed. Please try again.');
    }
  };

  const setMaxAmount = () => {
    setAmount(userBalance.toString());
  };

  // Calculate fees and output
  const wrapFee = parseFloat(amount || '0') * 0.007; // 0.7% wrap fee
  const amountAfterFee = parseFloat(amount || '0') - wrapFee;
  const rTokensReceived = amountAfterFee / rift.backingRatio; // Account for backing ratio

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <motion.div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      
      <motion.div
        className="relative w-full max-w-md p-6 mx-4 border bg-black/90 backdrop-blur-xl border-white/20 rounded-2xl"
        initial={{ opacity: 0, scale: 0.8, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.8, y: 20 }}
      >
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-xl font-bold text-white">Wrap {rift.underlying} → r{rift.underlying}</h3>
          <button
            onClick={onClose}
            className="transition-colors text-white/60 hover:text-white"
          >
            ×
          </button>
        </div>

        <div className="space-y-4">
          {/* Rift Info */}
          <div className="p-4 border bg-white/5 rounded-xl border-white/10">
            <div className="flex items-center justify-between mb-2">
              <span className="text-gray-400">Backing Ratio</span>
              <span className="font-bold text-emerald-400">{rift.backingRatio.toFixed(4)}x</span>
            </div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-gray-400">Burn Fee</span>
              <span className="font-bold text-orange-400">{rift.burnFee}%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-400">24h Volume</span>
              <span className="font-bold text-blue-400">${(rift.volume24h / 1000).toFixed(1)}k</span>
            </div>
          </div>

          {/* Amount Input */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm text-gray-400">Amount ({rift.underlying})</label>
              <span className="text-xs text-gray-500">
                Balance: {userBalance.toFixed(4)} {rift.underlying}
              </span>
            </div>
            
            <div className="relative">
              <input
                type="number"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                }}
                placeholder="0.00"
                className="w-full px-4 py-3 text-white placeholder-gray-500 border bg-white/5 border-white/20 rounded-xl focus:outline-none focus:border-blue-400/50"
              />
              <button
                onClick={setMaxAmount}
                className="absolute px-2 py-1 text-xs text-blue-400 transition-colors -translate-y-1/2 rounded right-3 top-1/2 bg-blue-500/20 hover:bg-blue-500/30"
              >
                MAX
              </button>
            </div>
          </div>

          {/* Wrap Summary */}
          {amount && !isNaN(parseFloat(amount)) && (
            <div className="p-4 border bg-blue-900/10 border-blue-500/20 rounded-xl">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-4 h-4 text-blue-400" />
                <span className="text-sm font-medium text-blue-400">Wrap Summary</span>
              </div>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Wrap Fee (0.7%)</span>
                  <span className="text-red-400">
                    -{wrapFee.toFixed(6)} {rift.underlying}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">You Will Receive</span>
                  <span className="font-bold text-emerald-400">
                    {rTokensReceived.toFixed(6)} r{rift.underlying}
                  </span>
                </div>
                <div className="flex justify-between pt-2 border-t border-white/10">
                  <span className="text-gray-400">Burn Mechanism</span>
                  <span className="text-orange-400">
                    {rift.burnFee}% of fees burn r{rift.underlying}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Error Display */}
          {error && (
            <div className="p-3 border bg-red-900/20 border-red-500/30 rounded-xl">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400" />
                <span className="text-sm text-red-400">{error}</span>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-3 text-white transition-colors bg-white/10 rounded-xl hover:bg-white/20"
            >
              Cancel
            </button>
            
            <button
              onClick={handleWrap}
              disabled={loading || !amount || parseFloat(amount) <= 0 || parseFloat(amount) > userBalance}
              className="flex items-center justify-center flex-1 gap-2 px-4 py-3 text-white transition-all duration-200 bg-gradient-to-r from-blue-500 to-purple-500 rounded-xl hover:from-blue-600 hover:to-purple-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                >
                  <Clock className="w-4 h-4" />
                </motion.div>
              ) : (
                <Plus className="w-4 h-4" />
              )}
              {loading ? 'Processing...' : 'Wrap'}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

// ==================== UNWRAP MODAL ====================

interface UnwrapModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  rift: {
    id: string;
    symbol: string;
    underlying: string;
    backingRatio: number;
    burnFee: number;
  };
  userPosition: {
    rTokenAmount: number;
    underlyingValue: number;
    burnRewards: number;
  };
}

export const UnwrapModal: React.FC<UnwrapModalProps> = ({ 
  isOpen, 
  onClose, 
  onSuccess,
  rift, 
  userPosition 
}) => {
  const [amount, setAmount] = useState('');
  const [unwrapType, setUnwrapType] = useState<'partial' | 'full'>('partial');
  const { unwrap, loading, error, clearError } = useRiftOperations();
  const { notifyTransaction } = useTransactionToast();
  const { refreshBalance } = useRealWallet();

  const handleUnwrap = async () => {
    const unwrapAmount = unwrapType === 'full' ? userPosition.rTokenAmount : parseFloat(amount);
    
    if (isNaN(unwrapAmount) || unwrapAmount <= 0) {
      return;
    }

    if (unwrapAmount > userPosition.rTokenAmount) {
      return;
    }

    clearError();
    
    notifyTransaction('pending', 'Processing unwrap transaction...');
    
    try {
      const result = await unwrap(rift.id, unwrapAmount);
      
      if (result.success) {
        const underlyingReceived = unwrapAmount * rift.backingRatio;
        notifyTransaction('success', `Successfully unwrapped ${unwrapAmount.toFixed(4)} r${rift.underlying} for ${underlyingReceived.toFixed(4)} ${rift.underlying}`, result.signature);
        
        // Auto-refresh wallet balance
        try {
          await refreshBalance();
        } catch (refreshError) {
          
        }
        
        // Call success callback to refresh positions
        if (onSuccess) {
          try {
            await onSuccess();
          } catch (successError) {
            
          }
        }
        
        onClose();
        setAmount('');
      } else {
        notifyTransaction('error', 'Unwrap transaction failed. Please try again.');
      }
    } catch {
      notifyTransaction('error', 'Unwrap transaction failed. Please try again.');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <motion.div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      
      <motion.div
        className="relative w-full max-w-md p-6 mx-4 border bg-black/90 backdrop-blur-xl border-white/20 rounded-2xl"
        initial={{ opacity: 0, scale: 0.8, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.8, y: 20 }}
      >
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-xl font-bold text-white">Unwrap r{rift.underlying} → {rift.underlying}</h3>
          <button
            onClick={onClose}
            className="transition-colors text-white/60 hover:text-white"
          >
            ×
          </button>
        </div>

        <div className="space-y-4">
          {/* Position Info */}
          <div className="p-4 border bg-white/5 rounded-xl border-white/10">
            <div className="flex items-center justify-between mb-2">
              <span className="text-gray-400">Your r{rift.underlying} Balance</span>
              <span className="font-bold text-white">{userPosition.rTokenAmount.toFixed(4)} r{rift.underlying}</span>
            </div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-gray-400">Redeemable For</span>
              <span className="font-bold text-emerald-400">{(userPosition.rTokenAmount * rift.backingRatio).toFixed(4)} {rift.underlying}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-400">Backing Ratio</span>
              <span className="font-bold text-blue-400">{rift.backingRatio.toFixed(4)}x</span>
            </div>
          </div>

          {/* Unwrap Type Selection */}
          <div className="flex gap-2">
            <button
              onClick={() => setUnwrapType('partial')}
              className={`flex-1 p-3 rounded-xl transition-all ${
                unwrapType === 'partial'
                  ? 'bg-purple-500/20 border border-purple-400/50 text-purple-400'
                  : 'bg-white/5 border border-white/20 text-gray-400 hover:text-white'
              }`}
            >
              Partial
            </button>
            <button
              onClick={() => setUnwrapType('full')}
              className={`flex-1 p-3 rounded-xl transition-all ${
                unwrapType === 'full'
                  ? 'bg-orange-500/20 border border-orange-400/50 text-orange-400'
                  : 'bg-white/5 border border-white/20 text-gray-400 hover:text-white'
              }`}
            >
              Full
            </button>
          </div>

          {/* Amount Input for Partial Unwrap */}
          {unwrapType === 'partial' && (
            <div className="space-y-2">
              <label className="text-sm text-gray-400">Amount (r{rift.underlying})</label>
              <div className="relative">
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  max={userPosition.rTokenAmount}
                  className="w-full px-4 py-3 text-white placeholder-gray-500 border bg-white/5 border-white/20 rounded-xl focus:outline-none focus:border-purple-400/50"
                />
                <button
                  onClick={() => setAmount(userPosition.rTokenAmount.toString())}
                  className="absolute px-2 py-1 text-xs text-purple-400 transition-colors -translate-y-1/2 rounded right-3 top-1/2 bg-purple-500/20 hover:bg-purple-500/30"
                >
                  MAX
                </button>
              </div>
            </div>
          )}

          {/* Unwrap Summary */}
          <div className="p-4 border bg-purple-900/10 border-purple-500/20 rounded-xl">
            <div className="flex items-center gap-2 mb-2">
              <TrendingDown className="w-4 h-4 text-purple-400" />
              <span className="text-sm font-medium text-purple-400">Unwrap Summary</span>
            </div>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">r{rift.underlying} to Unwrap</span>
                <span className="text-white">
                  {unwrapType === 'full' 
                    ? userPosition.rTokenAmount.toFixed(4) 
                    : (amount || '0')} r{rift.underlying}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Unwrap Fee (0.7%)</span>
                <span className="text-red-400">
                  -{((unwrapType === 'full' ? userPosition.rTokenAmount : parseFloat(amount || '0')) * rift.backingRatio * 0.007).toFixed(6)} {rift.underlying}
                </span>
              </div>
              <div className="flex justify-between pt-2 border-t border-white/10">
                <span className="text-gray-400">You Will Receive</span>
                <span className="font-bold text-emerald-400">
                  {((unwrapType === 'full' ? userPosition.rTokenAmount : parseFloat(amount || '0')) * rift.backingRatio * 0.993).toFixed(6)} {rift.underlying}
                </span>
              </div>
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <div className="p-3 border bg-red-900/20 border-red-500/30 rounded-xl">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400" />
                <span className="text-sm text-red-400">{error}</span>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-3 text-white transition-colors bg-white/10 rounded-xl hover:bg-white/20"
            >
              Cancel
            </button>
            
            <button
              onClick={handleUnwrap}
              disabled={loading || (unwrapType === 'partial' && (!amount || parseFloat(amount) <= 0))}
              className="flex items-center justify-center flex-1 gap-2 px-4 py-3 text-white transition-all duration-200 bg-gradient-to-r from-purple-500 to-pink-500 rounded-xl hover:from-purple-600 hover:to-pink-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                >
                  <Clock className="w-4 h-4" />
                </motion.div>
              ) : (
                <Minus className="w-4 h-4" />
              )}
              {loading ? 'Processing...' : 'Unwrap'}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

// ==================== CLAIM RIFTS REWARDS BUTTON ====================

interface ClaimRewardsButtonProps {
  rewards: number;
  lpTokenSymbol: string;
}

export const ClaimRewardsButton: React.FC<ClaimRewardsButtonProps> = ({ 
  rewards, 
  lpTokenSymbol 
}) => {
  const { claimRewards, loading } = useRiftOperations();
  const { notifyTransaction } = useTransactionToast();

  const handleClaim = async () => {
    notifyTransaction('pending', 'Claiming RIFTS rewards...');
    
    try {
      const result = await claimRewards();
      
      if (result.success) {
        notifyTransaction('success', `Successfully claimed ${rewards.toFixed(4)} RIFTS tokens from ${lpTokenSymbol} staking`, result.signature);
      } else {
        notifyTransaction('error', 'Failed to claim RIFTS rewards. Please try again.');
      }
    } catch {
      notifyTransaction('error', 'Failed to claim RIFTS rewards. Please try again.');
    }
  };

  if (rewards <= 0) return null;

  return (
    <button
      onClick={handleClaim}
      disabled={loading}
      className="inline-flex items-center gap-2 px-3 py-2 text-sm text-white transition-all duration-200 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {loading ? (
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
        >
          <Clock className="w-4 h-4" />
        </motion.div>
      ) : (
        <Gift className="w-4 h-4" />
      )}
      {loading ? 'Claiming...' : `Claim ${rewards.toFixed(2)} RIFTS`}
    </button>
  );
};

// ==================== CREATE RIFT MODAL ====================

interface CreateRiftModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRiftCreated?: () => void;
}

export const CreateRiftModal: React.FC<CreateRiftModalProps> = ({ 
  isOpen, 
  onClose,
  onRiftCreated
}) => {
  const [tokenAddress, setTokenAddress] = useState('');
  const [tokenSymbol, setTokenSymbol] = useState('');
  const [burnFee, setBurnFee] = useState('0.45'); // Default 0.45%
  const [partnerFee, setPartnerFee] = useState('0'); // Default 0%
  const [partnerWallet, setPartnerWallet] = useState('');
  const { createRift, loading, error, clearError } = useRiftOperations();
  const { notifyTransaction } = useTransactionToast();
  const { publicKey } = useRealWallet();

  // Auto-fill partner wallet with creator's wallet when partner fees are enabled
  useEffect(() => {
    if (parseFloat(partnerFee) > 0 && !partnerWallet && publicKey) {
      setPartnerWallet(publicKey);
    }
  }, [partnerFee, partnerWallet, publicKey]);

  const handleCreate = async () => {
    if (!tokenAddress || !tokenSymbol) {
      return;
    }

    const burnFeeNum = parseFloat(burnFee);
    const partnerFeeNum = parseFloat(partnerFee);

    if (burnFeeNum < 0 || burnFeeNum > 0.45) {
      return;
    }

    if (partnerFeeNum < 0 || partnerFeeNum > 0.05) {
      return;
    }

    const resolvedPartnerWallet = partnerFeeNum > 0 ? (partnerWallet || publicKey) : undefined;

    if (partnerFeeNum > 0 && !resolvedPartnerWallet) {
      return;
    }

    clearError();
    
    notifyTransaction('pending', 'Creating new rift...');
    
    try {
      const result = await createRift({
        tokenAddress,
        tokenSymbol,
        burnFee: burnFeeNum,
        partnerFee: partnerFeeNum,
        partnerWallet: resolvedPartnerWallet
      });
      
      if (result.success) {
        notifyTransaction('success', `Successfully created r${tokenSymbol} rift`, result.signature);
        onClose();
        // Reset form
        setTokenAddress('');
        setTokenSymbol('');
        setBurnFee('45');
        setPartnerFee('0');
        setPartnerWallet('');
        // Notify parent to refresh rifts list
        onRiftCreated?.();
      } else {
        notifyTransaction('error', 'Failed to create rift. Please try again.');
      }
    } catch {
      notifyTransaction('error', 'Failed to create rift. Please try again.');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <motion.div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      
      <motion.div
        className="relative w-full max-w-md p-6 mx-4 border bg-black/90 backdrop-blur-xl border-white/20 rounded-2xl"
        initial={{ opacity: 0, scale: 0.8, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.8, y: 20 }}
      >
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Zap className="w-6 h-6 text-yellow-400" />
            <h3 className="text-xl font-bold text-white">Create New Rift</h3>
          </div>
          <button
            onClick={onClose}
            className="transition-colors text-white/60 hover:text-white"
          >
            ×
          </button>
        </div>

        <div className="space-y-4">
          {/* Token Input */}
          <div className="space-y-2">
            <label className="text-sm text-gray-400">Token Address</label>
            <input
              type="text"
              value={tokenAddress}
              onChange={(e) => setTokenAddress(e.target.value)}
              placeholder="Enter token mint address"
              className="w-full px-4 py-3 text-white placeholder-gray-500 border bg-white/5 border-white/20 rounded-xl focus:outline-none focus:border-yellow-400/50"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm text-gray-400">Token Symbol</label>
            <input
              type="text"
              value={tokenSymbol}
              onChange={(e) => setTokenSymbol(e.target.value.toUpperCase())}
              placeholder="e.g., SOL, USDC"
              className="w-full px-4 py-3 text-white placeholder-gray-500 border bg-white/5 border-white/20 rounded-xl focus:outline-none focus:border-yellow-400/50"
            />
          </div>

          {/* Fee Configuration */}
          <div className="p-4 border bg-white/5 rounded-xl border-white/10">
            <div className="flex items-center gap-2 mb-3">
              <Flame className="w-4 h-4 text-orange-400" />
              <span className="text-sm font-medium text-white">Fee Configuration</span>
            </div>

            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm text-gray-400">Burn Fee (%)</label>
                  <span className="text-xs text-orange-400">{burnFee}% of fees burn r{tokenSymbol || 'TOKEN'}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="0.45"
                  step="0.01"
                  value={burnFee}
                  onChange={(e) => setBurnFee(e.target.value)}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-gray-500 mt-1">
                  <span>0%</span>
                  <span>0.45% (max)</span>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm text-gray-400">Partner Fee (%)</label>
                  <span className="text-xs text-purple-400">{partnerFee}% to partner wallet</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="0.05"
                  step="0.01"
                  value={partnerFee}
                  onChange={(e) => setPartnerFee(e.target.value)}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-gray-500 mt-1">
                  <span>0%</span>
                  <span>0.05% (max)</span>
                </div>
              </div>

              {parseFloat(partnerFee) > 0 && (
                <div className="space-y-2 pt-2">
                  <label className="text-sm text-gray-400">Partner Wallet Address</label>
                  <input
                    type="text"
                    value={partnerWallet}
                    onChange={(e) => setPartnerWallet(e.target.value)}
                    placeholder="Enter partner wallet address"
                    className="w-full px-3 py-2 text-sm text-white placeholder-gray-500 border bg-white/5 border-white/20 rounded-lg focus:outline-none focus:border-purple-400/50"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Info Box */}
          <div className="p-3 bg-blue-900/20 border border-blue-500/30 rounded-xl">
            <div className="flex gap-2">
              <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-blue-300">
                <p>Rifts charge 0.7% on wrap and unwrap. Fees are distributed:</p>
                <ul className="mt-1 space-y-0.5 ml-3">
                  <li>• {burnFee}% burns r{tokenSymbol || 'TOKEN'} (increases backing ratio)</li>
                  <li>• {partnerFee}% to partner wallet</li>
                  <li>• 5% to treasury</li>
                  <li>• {95 - parseFloat(burnFee) - parseFloat(partnerFee)}% buys & distributes RIFTS</li>
                </ul>
              </div>
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <div className="p-3 border bg-red-900/20 border-red-500/30 rounded-xl">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400" />
                <span className="text-sm text-red-400">{error}</span>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-3 text-white transition-colors bg-white/10 rounded-xl hover:bg-white/20"
            >
              Cancel
            </button>
            
            <button
              onClick={handleCreate}
              disabled={loading || !tokenAddress || !tokenSymbol || (parseFloat(partnerFee) > 0 && !partnerWallet)}
              className="flex items-center justify-center flex-1 gap-2 px-4 py-3 text-white transition-all duration-200 bg-gradient-to-r from-yellow-500 to-orange-500 rounded-xl hover:from-yellow-600 hover:to-orange-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                >
                  <Clock className="w-4 h-4" />
                </motion.div>
              ) : (
                <Zap className="w-4 h-4" />
              )}
              {loading ? 'Creating...' : 'Create Rift'}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
};
