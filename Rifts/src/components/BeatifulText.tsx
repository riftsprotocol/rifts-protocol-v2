// BeautifulText.tsx - Modern Attractive Text Component

"use client";

import React from 'react';
import { motion } from 'framer-motion';

// Beautiful Modern Text Component - Much More Attractive
const BeautifulText: React.FC<{ 
  children: React.ReactNode; 
  className?: string;
  variant?: 'glow' | 'rainbow' | 'neon' | 'gradient' | 'crystal';
  size?: 'sm' | 'md' | 'lg' | 'xl';
}> = ({ children, className = "", variant = 'glow', size = 'md' }) => {

  const sizeClasses = {
    sm: 'text-lg',
    md: 'text-2xl', 
    lg: 'text-3xl',
    xl: 'text-4xl'
  };

  // Glow Variant - Soft, elegant glow effect
  if (variant === 'glow') {
    return (
      <motion.div
        className={`relative inline-block font-bold ${sizeClasses[size]} ${className}`}
        whileHover={{ scale: 1.02 }}
        transition={{ type: "spring", stiffness: 300, damping: 20 }}
      >
        <motion.span
          className="relative z-10 text-white"
          style={{
            textShadow: '0 0 20px rgba(59, 130, 246, 0.8), 0 0 40px rgba(147, 51, 234, 0.6), 0 0 60px rgba(236, 72, 153, 0.4)',
          }}
          animate={{
            textShadow: [
              '0 0 20px rgba(59, 130, 246, 0.8), 0 0 40px rgba(147, 51, 234, 0.6), 0 0 60px rgba(236, 72, 153, 0.4)',
              '0 0 30px rgba(147, 51, 234, 0.9), 0 0 50px rgba(236, 72, 153, 0.7), 0 0 70px rgba(59, 130, 246, 0.5)',
              '0 0 20px rgba(59, 130, 246, 0.8), 0 0 40px rgba(147, 51, 234, 0.6), 0 0 60px rgba(236, 72, 153, 0.4)',
            ]
          }}
          transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
        >
          {children}
        </motion.span>
      </motion.div>
    );
  }

  // Rainbow Variant - Flowing rainbow colors
  if (variant === 'rainbow') {
    return (
      <motion.div
        className={`relative inline-block font-bold ${sizeClasses[size]} ${className}`}
        whileHover={{ scale: 1.02 }}
      >
        <motion.span
          className="text-transparent bg-clip-text"
          style={{
            background: 'linear-gradient(45deg, #ff0000, #ff8000, #ffff00, #80ff00, #00ff00, #00ff80, #00ffff, #0080ff, #0000ff, #8000ff, #ff00ff, #ff0080)',
            backgroundSize: '300% 300%',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
          animate={{
            backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'],
          }}
          transition={{
            duration: 5,
            repeat: Infinity,
            ease: "linear",
          }}
        >
          {children}
        </motion.span>
      </motion.div>
    );
  }

  // Neon Variant - Electric neon sign effect
  if (variant === 'neon') {
    return (
      <motion.div
        className={`relative inline-block font-bold ${sizeClasses[size]} ${className}`}
        whileHover={{ scale: 1.02 }}
      >
        <motion.span
          className="relative z-10 text-cyan-400"
          style={{
            textShadow: '0 0 5px #00ffff, 0 0 10px #00ffff, 0 0 15px #00ffff, 0 0 20px #00ffff',
            fontFamily: 'monospace',
            letterSpacing: '0.1em',
          }}
          animate={{
            textShadow: [
              '0 0 5px #00ffff, 0 0 10px #00ffff, 0 0 15px #00ffff, 0 0 20px #00ffff',
              '0 0 2px #00ffff, 0 0 5px #00ffff, 0 0 8px #00ffff, 0 0 12px #00ffff',
              '0 0 5px #00ffff, 0 0 10px #00ffff, 0 0 15px #00ffff, 0 0 20px #00ffff',
            ]
          }}
          transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
        >
          {children}
        </motion.span>
        
        {/* Flickering effect */}
        <motion.span
          className="absolute inset-0 opacity-50 text-cyan-400"
          style={{
            textShadow: '0 0 10px #00ffff',
            fontFamily: 'monospace',
            letterSpacing: '0.1em',
          }}
          animate={{
            opacity: [0.5, 0.8, 0.3, 0.9, 0.5],
          }}
          transition={{
            duration: 0.15,
            repeat: Infinity,
            repeatType: "mirror",
          }}
        >
          {children}
        </motion.span>
      </motion.div>
    );
  }

  // Gradient Variant - Smooth flowing gradient
  if (variant === 'gradient') {
    return (
      <motion.div
        className={`relative inline-block font-bold ${sizeClasses[size]} ${className}`}
        whileHover={{ scale: 1.02 }}
      >
        <motion.span
          className="text-transparent bg-clip-text"
          style={{
            background: 'linear-gradient(90deg, #667eea 0%, #764ba2 25%, #f093fb 50%, #f5576c 75%, #4facfe 100%)',
            backgroundSize: '200% 200%',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
          animate={{
            backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'],
          }}
          transition={{
            duration: 4,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        >
          {children}
        </motion.span>
        
        {/* Subtle glow */}
        <span
          className="absolute inset-0 blur-sm opacity-40"
          style={{
            background: 'linear-gradient(90deg, #667eea 0%, #764ba2 25%, #f093fb 50%, #f5576c 75%, #4facfe 100%)',
            backgroundSize: '200% 200%',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          {children}
        </span>
      </motion.div>
    );
  }

  // Crystal Variant - Glass-like crystal effect
  if (variant === 'crystal') {
    return (
      <motion.div
        className={`relative inline-block font-bold ${sizeClasses[size]} ${className}`}
        whileHover={{ scale: 1.02, rotateY: 5 }}
        style={{ perspective: 1000 }}
      >
        <motion.span
          className="relative z-10"
          style={{
            background: 'linear-gradient(135deg, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.3) 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            textShadow: '0 1px 3px rgba(0,0,0,0.3)',
            filter: 'drop-shadow(0 4px 8px rgba(59, 130, 246, 0.3))',
          }}
          animate={{
            filter: [
              'drop-shadow(0 4px 8px rgba(59, 130, 246, 0.3))',
              'drop-shadow(0 6px 12px rgba(147, 51, 234, 0.4))',
              'drop-shadow(0 4px 8px rgba(59, 130, 246, 0.3))',
            ]
          }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          {children}
        </motion.span>
        
        {/* Crystal reflections */}
        <motion.span
          className="absolute inset-0 opacity-30"
          style={{
            background: 'linear-gradient(45deg, transparent 30%, rgba(255,255,255,0.5) 50%, transparent 70%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
          animate={{
            backgroundPosition: ['-100% 0%', '200% 0%', '-100% 0%'],
          }}
          transition={{
            duration: 3,
            repeat: Infinity,
            ease: "linear",
          }}
        >
          {children}
        </motion.span>
      </motion.div>
    );
  }

  // Default fallback
  return <span className={`font-bold text-white ${sizeClasses[size]} ${className}`}>{children}</span>;
};

export default BeautifulText;