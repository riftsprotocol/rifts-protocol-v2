'use client';

import React, { useState } from 'react';
import { Copy, Check, ExternalLink } from 'lucide-react';
import { motion } from 'framer-motion';

interface ContractAddressProps {
  label: string;
  address: string;
  network?: 'mainnet' | 'devnet' | 'testnet';
  className?: string;
}

export const ContractAddress: React.FC<ContractAddressProps> = ({
  label,
  address,
  network = 'devnet',
  className = '',
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const getExplorerUrl = () => {
    const baseUrl = 'https://explorer.solana.com/address';
    const cluster = network === 'mainnet' ? '' : `?cluster=${network}`;
    return `${baseUrl}/${address}${cluster}`;
  };

  const shortenAddress = (addr: string) => {
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`group relative flex items-center justify-between gap-3 p-4 bg-black/20 border border-white/10 rounded-lg hover:border-white/30 transition-all duration-300 ${className}`}
    >
      {/* Label */}
      <div className="flex-shrink-0">
        <span className="text-sm font-medium text-white/70">{label}</span>
      </div>

      {/* Address Display */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <a
          href={getExplorerUrl()}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-md transition-all duration-200 group/link flex-1 min-w-0"
          title={`View ${label} on Solana Explorer`}
        >
          <code className="text-xs font-mono text-white/90 truncate">
            {shortenAddress(address)}
          </code>
          <ExternalLink className="w-3.5 h-3.5 text-white/40 group-hover/link:text-white/70 flex-shrink-0" />
        </a>

        {/* Copy Button */}
        <button
          onClick={handleCopy}
          className="flex items-center justify-center w-9 h-9 bg-white/5 hover:bg-white/10 border border-white/10 rounded-md transition-all duration-200 flex-shrink-0"
          title="Copy address"
        >
          {copied ? (
            <Check className="w-4 h-4 text-green-400" />
          ) : (
            <Copy className="w-4 h-4 text-white/60 group-hover:text-white/90" />
          )}
        </button>
      </div>

      {/* Tooltip on full address */}
      <div className="absolute left-0 bottom-full mb-2 px-3 py-1.5 bg-black/90 border border-white/20 rounded-md opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-50 whitespace-nowrap">
        <code className="text-xs font-mono text-white/90">{address}</code>
      </div>
    </motion.div>
  );
};

interface ContractAddressListProps {
  addresses: Array<{
    label: string;
    address: string;
  }>;
  network?: 'mainnet' | 'devnet' | 'testnet';
  title?: string;
  className?: string;
}

export const ContractAddressList: React.FC<ContractAddressListProps> = ({
  addresses,
  network = 'devnet',
  title,
  className = '',
}) => {
  return (
    <div className={`space-y-3 ${className}`}>
      {title && (
        <h3 className="text-lg font-semibold text-white/90 mb-4">{title}</h3>
      )}
      {addresses.map((item, index) => (
        <ContractAddress
          key={index}
          label={item.label}
          address={item.address}
          network={network}
        />
      ))}
    </div>
  );
};
