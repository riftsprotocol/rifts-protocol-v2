"use client";

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LucideIcon } from 'lucide-react';

interface LuxuryButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'success';
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  icon?: LucideIcon;
  iconPosition?: 'left' | 'right';
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  className?: string;
  pulse?: boolean;
  glow?: boolean;
}

export const LuxuryButton: React.FC<LuxuryButtonProps> = ({
  children,
  onClick,
  variant = 'primary',
  size = 'md',
  icon: Icon,
  iconPosition = 'left',
  disabled = false,
  loading = false,
  fullWidth = false,
  className = '',
  pulse = false,
  glow = false
}) => {
  const [isHovered, setIsHovered] = useState(false);

  const baseClasses = `
    relative inline-flex items-center justify-center
    font-medium tracking-wide uppercase
    transition-all duration-300 ease-out
    focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-black
    disabled:opacity-40 disabled:cursor-not-allowed
    overflow-hidden select-none cursor-pointer
    ${fullWidth ? 'w-full' : ''}
  `;
  
  const variants = {
    primary: `
      bg-emerald-500 text-black
      hover:bg-emerald-400 active:bg-emerald-600
      focus:ring-emerald-500
      shadow-[0_0_20px_rgba(16,185,129,0.5)]
      hover:shadow-[0_0_30px_rgba(16,185,129,0.7)]
      border border-emerald-400/50
    `,
    secondary: `
      bg-black text-emerald-500
      hover:bg-gray-900 active:bg-gray-950
      focus:ring-emerald-500
      shadow-[0_0_20px_rgba(0,0,0,0.5)]
      hover:shadow-[0_0_30px_rgba(16,185,129,0.3)]
      border border-emerald-500/30 hover:border-emerald-400/50
    `,
    outline: `
      bg-transparent text-emerald-500
      hover:bg-emerald-500/10 active:bg-emerald-500/20
      focus:ring-emerald-500
      border-2 border-emerald-500/50 hover:border-emerald-400
      shadow-[inset_0_0_20px_rgba(16,185,129,0.1)]
    `,
    ghost: `
      bg-transparent text-gray-300
      hover:text-emerald-400 hover:bg-white/5
      focus:ring-gray-500
      border border-transparent hover:border-gray-800
    `,
    danger: `
      bg-red-900/80 text-red-200
      hover:bg-red-800/80 active:bg-red-950/80
      focus:ring-red-500
      shadow-[0_0_20px_rgba(220,38,38,0.4)]
      hover:shadow-[0_0_30px_rgba(220,38,38,0.6)]
      border border-red-700/50
    `,
    success: `
      bg-emerald-600 text-white
      hover:bg-emerald-500 active:bg-emerald-700
      focus:ring-emerald-400
      shadow-[0_0_20px_rgba(5,150,105,0.5)]
      hover:shadow-[0_0_30px_rgba(16,185,129,0.7)]
      border border-emerald-500/50
    `
  };
  
  const sizes = {
    xs: "px-3 py-1.5 text-xs gap-1.5",
    sm: "px-4 py-2 text-sm gap-2",
    md: "px-6 py-2.5 text-sm gap-2.5",
    lg: "px-8 py-3 text-base gap-3",
    xl: "px-10 py-4 text-lg gap-3.5"
  };
  
  const iconSizes = {
    xs: "w-3 h-3",
    sm: "w-4 h-4", 
    md: "w-4 h-4",
    lg: "w-5 h-5",
    xl: "w-6 h-6"
  };

  return (
    <motion.button
      className={`${baseClasses} ${variants[variant]} ${sizes[size]} ${className}`}
      onClick={onClick}
      disabled={disabled || loading}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
    >
      {/* Luxury background patterns */}
      <div className="absolute inset-0 opacity-30">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
      </div>

      {/* Animated border glow */}
      <motion.div
        className="absolute inset-0 opacity-0"
        animate={{
          opacity: isHovered ? 1 : 0,
        }}
        transition={{ duration: 0.3 }}
      >
        <div className="absolute inset-[-2px] bg-emerald-500/20 blur-md rounded-lg" />
      </motion.div>

      {/* Pulse effect */}
      {pulse && !disabled && (
        <motion.div
          className="absolute inset-0 rounded-lg bg-emerald-500/20"
          animate={{
            scale: [1, 1.2, 1],
            opacity: [0.5, 0, 0.5],
          }}
          transition={{
            duration: 2,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
      )}

      {/* Luxury shine effect */}
      <motion.div
        className="absolute inset-0 -skew-x-12 bg-gradient-to-r from-transparent via-white/10 to-transparent"
        initial={{ x: '-200%' }}
        animate={{
          x: isHovered ? '200%' : '-200%',
        }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      />

      {/* Loading spinner */}
      <AnimatePresence>
        {loading && (
          <motion.div
            className="absolute inset-0 flex items-center justify-center bg-black/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="w-5 h-5 border-2 rounded-full border-emerald-500 border-t-transparent"
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
            />
          </motion.div>
        )}
      </AnimatePresence>
      
      {/* Content */}
      <div className={`relative z-10 flex items-center ${loading ? 'opacity-0' : 'opacity-100'} transition-opacity`}>
        {Icon && iconPosition === 'left' && (
          <motion.div
            animate={{
              x: isHovered ? -2 : 0,
              rotate: isHovered ? -10 : 0,
            }}
            transition={{ type: "spring", stiffness: 300 }}
          >
            <Icon className={iconSizes[size]} />
          </motion.div>
        )}
        
        <span className="relative">
          {children}
          {/* Underline effect */}
          <motion.div
            className="absolute bottom-0 left-0 right-0 h-[1px] bg-current origin-left"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: isHovered ? 1 : 0 }}
            transition={{ duration: 0.3 }}
          />
        </span>
        
        {Icon && iconPosition === 'right' && (
          <motion.div
            animate={{
              x: isHovered ? 2 : 0,
              rotate: isHovered ? 10 : 0,
            }}
            transition={{ type: "spring", stiffness: 300 }}
          >
            <Icon className={iconSizes[size]} />
          </motion.div>
        )}
      </div>

      {/* Corner accents */}
      <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-current opacity-50" />
      <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-current opacity-50" />
      <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-current opacity-50" />
      <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-current opacity-50" />

      {/* Glow effect */}
      {glow && (
        <div className="absolute inset-0 -z-10">
          <div className="absolute inset-0 bg-emerald-500/30 blur-xl" />
        </div>
      )}
    </motion.button>
  );
};