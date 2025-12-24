// components/rifts/RiftsUI.tsx - Professional RIFTS Detailed View

"use client";

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Zap, ArrowUpDown,
  DollarSign, Activity, Trash2, Info, TrendingUp
} from 'lucide-react';
import { LuxuryModal } from '../ui/luxury-modal';
import { LuxuryButton } from '../ui/luxury-button';
import { formatRiftAddress } from '../../utils';
import { TradingInterface } from '../trading/TradingInterface';

// Helper Components
// interface InfoRowProps {
//   label: string;
//   value: string;
//   copyable?: boolean;
// }

// const InfoRow: React.FC<InfoRowProps> = ({ label, value, copyable = false }) => {
//   const [copied, setCopied] = useState(false);

//   const handleCopy = () => {
//     if (copyable) {
//       navigator.clipboard.writeText(value);
//       setCopied(true);
//       setTimeout(() => setCopied(false), 2000);
//     }
//   };

//   return (
//     <div className="flex items-center justify-between py-3 border-b border-gray-100 last:border-b-0">
//       <span className="text-sm font-medium text-gray-600">{label}</span>
//       <div className="flex items-center gap-2">
//         <span className="px-2 py-1 font-mono text-sm text-gray-900 rounded bg-gray-50">{value}</span>
//         {copyable && (
//           <button
//             onClick={handleCopy}
//             className="p-1 text-gray-400 transition-colors rounded hover:text-blue-600 hover:bg-blue-50"
//           >
//             {copied ? (
//               <CheckCircle className="w-3 h-3 text-green-600" />
//             ) : (
//               <Copy className="w-3 h-3" />
//             )}
//           </button>
//         )}
//       </div>
//     </div>
//   );
// };

// interface DetailedInfoSectionProps {
//   title: string;
//   icon: React.ReactNode;
//   children: React.ReactNode;
//   isOpen: boolean;
// }

// const DetailedInfoSection: React.FC<DetailedInfoSectionProps> = ({ 
//   title, 
//   icon, 
//   children, 
//   isOpen: defaultOpen 
// }) => {
//   const [isOpen, setIsOpen] = useState(defaultOpen);

//   return (
//     <div className="overflow-hidden bg-white border border-gray-200 rounded-lg shadow-sm">
//       <button
//         onClick={() => setIsOpen(!isOpen)}
//         className="flex items-center justify-between w-full p-4 transition-colors hover:bg-gray-50"
//       >
//         <div className="flex items-center gap-3">
//           <div className="flex items-center justify-center w-10 h-10 bg-blue-100 rounded-lg">
//             <div className="text-blue-600">{icon}</div>
//           </div>
//           <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
//         </div>
//         <div className="flex items-center gap-2">
//           <span className="text-sm font-medium text-gray-500">
//             {isOpen ? 'Hide' : 'Show'}
//           </span>
//           {isOpen ? (
//             <ChevronUp className="w-5 h-5 text-gray-400" />
//           ) : (
//             <ChevronDown className="w-5 h-5 text-gray-400" />
//           )}
//         </div>
//       </button>
//       
//       <AnimatePresence>
//         {isOpen && (
//           <motion.div
//             initial={{ height: 0, opacity: 0 }}
//             animate={{ height: 'auto', opacity: 1 }}
//             exit={{ height: 0, opacity: 0 }}
//             transition={{ duration: 0.3 }}
//             className="overflow-hidden"
//           >
//             <div className="px-4 pb-4 border-t border-gray-100">
//               {children}
//             </div>
//           </motion.div>
//         )}
//       </AnimatePresence>
//     </div>
//   );
// };

interface RiftData {
  id?: string;
  symbol?: string;
  underlying?: string;
  risk?: string;
  apy?: number;
  tvl?: number;
  participants?: string | number;
  burnFee?: number;
  partnerFee?: number;
  backingRatio?: number;
  price?: number;
  oraclePrice?: number;
}

export interface RiftsUIProps {
  isOpen: boolean;
  onClose: () => void;
  rift: RiftData;
  wallet?: unknown;
  rifts?: unknown[];
  userPositions?: unknown[];
  claimRewards?: () => Promise<void>;
  compound?: () => Promise<void>;
  withdraw?: () => Promise<void>;
  stake?: () => Promise<void>;
  unstake?: () => Promise<void>;
  onWrap?: () => void;
  onUnwrap?: () => void;
  onCloseRift?: () => void;
  addToast?: (message: string, type: 'success' | 'error' | 'pending', signature?: string) => void;
}

export const RiftsUI: React.FC<RiftsUIProps> = ({
  isOpen,
  onClose,
  rift,
  wallet,
  rifts,
  onWrap,
  onUnwrap,
  onCloseRift,
  addToast
}) => {
  const [activeTab, setActiveTab] = useState<'details' | 'trading'>('details');

  if (!isOpen) return null;

  // Filter rifts to only show the current rift
  const filteredRifts = rifts ? rifts.filter((r: unknown) => (r as RiftData).id === rift?.id) : [];

  return (
    <LuxuryModal
      isOpen={isOpen}
      onClose={onClose}
      title={`r${rift?.symbol || 'TOKEN'}`}
      subtitle={rift?.id ? formatRiftAddress(rift.id, 8) : 'RIFTS Token Details'}
      size="xl"
      showSparkles={true}
    >
      {!rift ? (
        <div className="py-12 text-center text-gray-400">
          <Zap className="w-12 h-12 mx-auto mb-4 text-emerald-500/50" />
          <p>No rift data available</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Tab Navigation */}
          <div className="border-b border-gray-700">
            <div className="flex gap-4">
              <button
                onClick={() => setActiveTab('details')}
                className={`flex items-center gap-2 px-4 py-2 text-sm border-b-2 transition-colors ${
                  activeTab === 'details'
                    ? 'border-emerald-500 text-emerald-400'
                    : 'border-transparent text-gray-400 hover:text-white'
                }`}
              >
                <Info className="w-4 h-4" />
                Details
              </button>
              <button
                onClick={() => setActiveTab('trading')}
                className={`flex items-center gap-2 px-4 py-2 text-sm border-b-2 transition-colors ${
                  activeTab === 'trading'
                    ? 'border-emerald-500 text-emerald-400'
                    : 'border-transparent text-gray-400 hover:text-white'
                }`}
              >
                <TrendingUp className="w-4 h-4" />
                Trading
              </button>
            </div>
          </div>

          {/* Tab Content */}
          {activeTab === 'details' ? (
            <div className="space-y-6">
          {/* Key Metrics with Luxury Design */}
          <div className="grid grid-cols-5 gap-4">
            <motion.div 
              className="relative group"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <div className="absolute inset-0 transition-all duration-300 bg-emerald-500/20 blur-xl group-hover:bg-emerald-500/30" />
              <div className="relative p-4 text-center transition-all duration-300 bg-black border border-emerald-500/30 hover:border-emerald-400/50">
                <div className="mb-2 text-xs font-medium tracking-wider uppercase text-emerald-400">APY</div>
                <div className="text-3xl font-bold text-white">{rift?.apy?.toFixed(1) || '8.4'}%</div>
                <div className="absolute w-2 h-2 rounded-full top-1 right-1 bg-emerald-400 animate-pulse" />
              </div>
            </motion.div>
            
            <motion.div 
              className="relative group"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
            >
              <div className="absolute inset-0 transition-all duration-300 bg-emerald-500/20 blur-xl group-hover:bg-emerald-500/30" />
              <div className="relative p-4 text-center transition-all duration-300 bg-black border border-emerald-500/30 hover:border-emerald-400/50">
                <div className="mb-2 text-xs font-medium tracking-wider uppercase text-emerald-400">TVL</div>
                <div className="text-3xl font-bold text-white">${rift?.tvl ? (rift.tvl / 1000000).toFixed(1) : '10.1'}M</div>
                <div className="absolute w-2 h-2 rounded-full top-1 left-1 bg-emerald-400 animate-pulse" style={{ animationDelay: '0.5s' }} />
              </div>
            </motion.div>
            
            <motion.div 
              className="relative group"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
            >
              <div className="absolute inset-0 transition-all duration-300 bg-emerald-500/20 blur-xl group-hover:bg-emerald-500/30" />
              <div className="relative p-4 text-center transition-all duration-300 bg-black border border-emerald-500/30 hover:border-emerald-400/50">
                <div className="mb-2 text-xs font-medium tracking-wider uppercase text-emerald-400">Users</div>
                <div className="text-3xl font-bold text-white">{rift?.participants || 0}</div>
                <div className="absolute w-2 h-2 rounded-full bottom-1 right-1 bg-emerald-400 animate-pulse" style={{ animationDelay: '1s' }} />
              </div>
            </motion.div>
            
            <motion.div 
              className="relative group"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 }}
            >
              <div className="absolute inset-0 transition-all duration-300 bg-emerald-500/20 blur-xl group-hover:bg-emerald-500/30" />
              <div className="relative p-4 text-center transition-all duration-300 bg-black border border-emerald-500/30 hover:border-emerald-400/50">
                <div className="mb-2 text-xs font-medium tracking-wider uppercase text-emerald-400">Price</div>
                <div className="text-3xl font-bold text-white">${rift?.price?.toFixed(4) || '0.0000'}</div>
                <div className="absolute w-2 h-2 rounded-full bottom-1 left-1 bg-emerald-400 animate-pulse" style={{ animationDelay: '1.5s' }} />
              </div>
            </motion.div>
            
            <motion.div 
              className="relative group"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5 }}
            >
              <div className="absolute inset-0 transition-all duration-300 bg-emerald-500/20 blur-xl group-hover:bg-emerald-500/30" />
              <div className="relative p-4 text-center transition-all duration-300 bg-black border border-emerald-500/30 hover:border-emerald-400/50">
                <div className="mb-2 text-xs font-medium tracking-wider uppercase text-emerald-400">Oracle</div>
                <div className="text-3xl font-bold text-white">${rift?.oraclePrice?.toFixed(4) || '0.0000'}</div>
                <div className="absolute w-2 h-2 rounded-full top-1 left-1 bg-emerald-400 animate-pulse" style={{ animationDelay: '2s' }} />
              </div>
            </motion.div>
          </div>

          {/* Detailed Information with Luxury Design */}
          <div className="grid grid-cols-2 gap-6">
            <motion.div 
              className="relative"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.3 }}
            >
              <div className="absolute inset-0 bg-emerald-500/10 blur-2xl" />
              <div className="relative p-6 transition-all duration-300 border bg-black/80 backdrop-blur-sm border-emerald-500/20 hover:border-emerald-400/40">
                <h3 className="flex items-center gap-3 mb-4 text-lg font-bold tracking-wider text-white uppercase">
                  <DollarSign className="w-5 h-5 text-emerald-400" />
                  Fees & Economics
                </h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between group">
                    <span className="text-sm text-gray-400">Wrap Fee:</span>
                    <span className="font-medium transition-colors text-emerald-400 group-hover:text-emerald-300">0.3%</span>
                  </div>
                  <div className="flex items-center justify-between group">
                    <span className="text-sm text-gray-400">Unwrap Fee:</span>
                    <span className="font-medium transition-colors text-emerald-400 group-hover:text-emerald-300">0.5%</span>
                  </div>
                  <div className="flex items-center justify-between group">
                    <span className="text-sm text-gray-400">Burn Rate:</span>
                    <span className="font-medium transition-colors text-emerald-400 group-hover:text-emerald-300">10%</span>
                  </div>
                  <div className="flex items-center justify-between group">
                    <span className="text-sm text-gray-400">Staker Share:</span>
                    <span className="font-medium transition-colors text-emerald-400 group-hover:text-emerald-300">90%</span>
                  </div>
                </div>
                <div className="absolute top-0 right-0 w-16 h-16 border-t border-r border-emerald-500/30" />
                <div className="absolute bottom-0 left-0 w-16 h-16 border-b border-l border-emerald-500/30" />
              </div>
            </motion.div>

            <motion.div 
              className="relative"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4 }}
            >
              <div className="absolute inset-0 bg-emerald-500/10 blur-2xl" />
              <div className="relative p-6 transition-all duration-300 border bg-black/80 backdrop-blur-sm border-emerald-500/20 hover:border-emerald-400/40">
                <h3 className="flex items-center gap-3 mb-4 text-lg font-bold tracking-wider text-white uppercase">
                  <Activity className="w-5 h-5 text-emerald-400" />
                  Oracle & Liquidity
                </h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between group">
                    <span className="text-sm text-gray-400">Update Cycle:</span>
                    <span className="font-medium transition-colors text-emerald-400 group-hover:text-emerald-300">24h</span>
                  </div>
                  <div className="flex items-center justify-between group">
                    <span className="text-sm text-gray-400">Next Update:</span>
                    <span className="font-medium transition-colors text-emerald-400 group-hover:text-emerald-300">14h</span>
                  </div>
                  <div className="flex items-center justify-between group">
                    <span className="text-sm text-gray-400">Liquidity Depth:</span>
                    <span className="font-medium transition-colors text-emerald-400 group-hover:text-emerald-300">$10M</span>
                  </div>
                  <div className="flex items-center justify-between group">
                    <span className="text-sm text-gray-400">Pool Ratio:</span>
                    <span className="font-medium transition-colors text-emerald-400 group-hover:text-emerald-300">7:93</span>
                  </div>
                </div>
                <div className="absolute top-0 left-0 w-16 h-16 border-t border-l border-emerald-500/30" />
                <div className="absolute bottom-0 right-0 w-16 h-16 border-b border-r border-emerald-500/30" />
              </div>
            </motion.div>
          </div>

          {/* Action Buttons with Luxury Design */}
          <motion.div 
            className="flex gap-4 pt-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
          >
            <LuxuryButton
              variant="primary"
              size="lg"
              icon={Zap}
              onClick={onWrap}
              fullWidth
              pulse
              glow
            >
              Wrap Tokens
            </LuxuryButton>
            
            <LuxuryButton
              variant="secondary"
              size="lg"
              icon={ArrowUpDown}
              onClick={onUnwrap}
              fullWidth
            >
              Unwrap Tokens
            </LuxuryButton>

            {onCloseRift && (
              (rift as unknown as { vault?: string })?.vault === '11111111111111111111111111111111' ||
              ((rift as unknown as { burnFee?: number })?.burnFee ?? 0) > 10000 ||
              ((rift as unknown as { partnerFee?: number })?.partnerFee ?? 0) > 10000
            ) && (
              <LuxuryButton
                variant="danger"
                size="lg"
                icon={Trash2}
                onClick={onCloseRift}
                className="min-w-[140px]"
              >
                Close Rift
              </LuxuryButton>
            )}
            
          </motion.div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Trading Interface Tab */}
              <TradingInterface
                wallet={wallet as { publicKey: string; connected: boolean; sendTransaction?: (transaction: unknown) => Promise<unknown> }}
                rifts={filteredRifts}
                addToast={addToast}
              />
            </div>
          )}
        </div>
      )}
    </LuxuryModal>
  );
};


export default RiftsUI;