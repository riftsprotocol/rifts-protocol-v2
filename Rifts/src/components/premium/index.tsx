// components/premium/index.tsx - Premium Libraries Integration - COMPLETELY FIXED

"use client";

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ==================== MAGIC UI INSPIRED COMPONENTS ====================

// Magical Spotlight Card (Magic UI Style)
const MagicalSpotlightCard: React.FC<{
  children: React.ReactNode;
  className?: string;
  spotlightColor?: string;
}> = ({ children, className = "", spotlightColor = "#3b82f6" }) => {
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    setMousePosition({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  return (
    <div
      ref={cardRef}
      className={`relative group overflow-hidden rounded-3xl border border-white/10 bg-black/40 backdrop-blur-xl ${className}`}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Magical spotlight effect */}
      <AnimatePresence>
        {isHovered && (
          <motion.div
            className="absolute inset-0 transition-opacity duration-500 opacity-0 group-hover:opacity-100"
            style={{
              background: `radial-gradient(600px circle at ${mousePosition.x}px ${mousePosition.y}px, ${spotlightColor}15, transparent 40%)`,
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
        )}
      </AnimatePresence>

      {/* Border gradient */}
      <motion.div
        className="absolute inset-0 opacity-0 rounded-3xl group-hover:opacity-100"
        style={{
          background: `radial-gradient(600px circle at ${mousePosition.x}px ${mousePosition.y}px, ${spotlightColor}40, transparent 40%)`,
          padding: '1px',
          margin: '-1px',
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: isHovered ? 1 : 0 }}
        transition={{ duration: 0.3 }}
      />

      <div className="relative z-10 p-8">
        {children}
      </div>
    </div>
  );
};

// Floating Dock (Magic UI Style) - SMART POSITIONING
const FloatingDock: React.FC<{
  items: Array<{
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
  }>;
  position?: 'bottom' | 'top' | 'center-right';
  currentTab?: string;
}> = ({ items, position = 'bottom', currentTab }) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // Center-right positioning for overview tab
  if (position === 'center-right') {
    return (
      <div className="fixed z-50 -translate-y-1/2 right-8 top-1/2">
        <motion.div
          initial={{ x: 100, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
        >
          <div className="flex flex-col items-center gap-3 p-4 border shadow-2xl bg-white/10 backdrop-blur-2xl rounded-2xl border-white/20 shadow-black/20">
            {items.map((item, index) => (
              <motion.button
                key={index}
                className={`relative p-4 transition-all duration-300 rounded-xl border border-white/10 ${
                  currentTab === ['overview', 'rifts', 'trade', 'portfolio', 'analytics'][index]
                    ? 'text-white bg-gradient-to-r from-blue-500/30 to-purple-500/30 border-blue-400/50' 
                    : 'text-white/80 hover:text-white hover:bg-white/20'
                }`}
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex(null)}
                onClick={item.onClick}
                whileHover={{ x: -8, scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
              >
                <div className="relative z-10">
                  {item.icon}
                </div>
                
                {/* Active indicator */}
                {currentTab === ['overview', 'rifts', 'trade', 'portfolio', 'analytics'][index] && (
                  <motion.div
                    className="absolute inset-0 border-2 rounded-xl border-blue-400/50"
                    animate={{
                      scale: [1, 1.05, 1],
                      opacity: [0.5, 1, 0.5],
                    }}
                    transition={{ duration: 2, repeat: Infinity }}
                  />
                )}
                
                {/* Tooltip */}
                <AnimatePresence>
                  {hoveredIndex === index && (
                    <motion.div
                      className="absolute px-3 py-2 mr-3 text-sm text-white -translate-y-1/2 border rounded-lg right-full top-1/2 bg-black/90 whitespace-nowrap backdrop-blur-xl border-white/20"
                      initial={{ opacity: 0, x: 10, scale: 0.8 }}
                      animate={{ opacity: 1, x: 0, scale: 1 }}
                      exit={{ opacity: 0, x: 10, scale: 0.8 }}
                      transition={{ duration: 0.2 }}
                    >
                      {item.label}
                      <div className="absolute w-2 h-2 rotate-45 -translate-y-1/2 border-b border-r left-full top-1/2 bg-black/90 border-white/20" />
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.button>
            ))}
          </div>
        </motion.div>
      </div>
    );
  }

  // Original bottom/top positioning for other tabs
  return (
    <div
      className={`fixed inset-x-0 z-50 flex justify-center ${
        position === 'bottom' ? 'bottom-6' : 'top-8'
      }`}
    >
      <motion.div
        initial={{ y: position === 'bottom' ? 100 : -100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
      >
        <div className="flex items-center gap-3 p-4 border shadow-2xl bg-white/10 backdrop-blur-2xl rounded-2xl border-white/20 shadow-black/20">
          {items.map((item, index) => (
            <motion.button
              key={index}
              className="relative p-4 transition-all duration-300 border rounded-xl text-white/80 hover:text-white hover:bg-white/20 backdrop-blur-sm border-white/10"
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
              onClick={item.onClick}
              whileHover={{ y: -6, scale: 1.15 }}
              whileTap={{ scale: 0.95 }}
              style={{
                background: hoveredIndex === index 
                  ? 'linear-gradient(135deg, rgba(59, 130, 246, 0.3), rgba(147, 51, 234, 0.3))'
                  : 'rgba(255, 255, 255, 0.05)',
              }}
            >
              <div className="relative z-10">
                {item.icon}
              </div>
              
              {/* Active glow */}
              <motion.div
                className="absolute inset-0 rounded-xl"
                style={{
                  background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(147, 51, 234, 0.2))',
                  opacity: hoveredIndex === index ? 1 : 0,
                }}
                animate={{
                  opacity: hoveredIndex === index ? [0.2, 0.5, 0.2] : 0,
                  scale: hoveredIndex === index ? [1, 1.05, 1] : 1,
                }}
                transition={{ duration: 2, repeat: Infinity }}
              />
              
              {/* Tooltip */}
              <AnimatePresence>
                {hoveredIndex === index && (
                  <motion.div
                    className={`absolute ${
                      position === 'bottom' ? 'bottom-full mb-3' : 'top-full mt-3'
                    } left-1/2 -translate-x-1/2 px-3 py-2 bg-black/90 text-white text-sm rounded-lg whitespace-nowrap backdrop-blur-xl border border-white/20`}
                    initial={{ opacity: 0, y: position === 'bottom' ? 10 : -10, scale: 0.8 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: position === 'bottom' ? 10 : -10, scale: 0.8 }}
                    transition={{ duration: 0.2 }}
                  >
                    {item.label}
                    <div
                      className={`absolute ${
                        position === 'bottom' ? 'top-full' : 'bottom-full'
                      } left-1/2 -translate-x-1/2 w-2 h-2 bg-black/90 rotate-45 border-r border-b border-white/20`}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.button>
          ))}
        </div>
      </motion.div>
    </div>
  );
};

// ==================== REACT BITS INSPIRED COMPONENTS ====================

// Micro-interaction Button (React Bits Style)
const MicroInteractionButton: React.FC<{
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
}> = ({ children, onClick, variant = 'primary', size = 'md' }) => {
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number }>>([]);
  const [isPressed, setIsPressed] = useState(false);

  const createRipple = (e: React.MouseEvent) => {
    const button = e.currentTarget as HTMLButtonElement;
    const rect = button.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const newRipple = { id: Date.now(), x, y };
    setRipples(prev => [...prev, newRipple]);
    
    setTimeout(() => {
      setRipples(prev => prev.filter(ripple => ripple.id !== newRipple.id));
    }, 600);
  };

  const sizes = {
    sm: 'px-4 py-2 text-sm',
    md: 'px-6 py-3 text-base',
    lg: 'px-8 py-4 text-lg'
  };

  const variants = {
    primary: 'bg-gradient-to-r from-blue-600 to-purple-600 text-white shadow-lg shadow-blue-500/25',
    secondary: 'bg-white/10 text-white border border-white/20 backdrop-blur-sm'
  };

  return (
    <motion.button
      className={`relative overflow-hidden rounded-xl font-semibold transition-all duration-200 ${variants[variant]} ${sizes[size]}`}
      onClick={(e) => {
        createRipple(e);
        onClick?.();
      }}
      onMouseDown={() => setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      onMouseLeave={() => setIsPressed(false)}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      animate={{
        boxShadow: isPressed
          ? '0 4px 12px rgba(59, 130, 246, 0.4)'
          : '0 8px 24px rgba(59, 130, 246, 0.2)'
      }}
    >
      {/* Ripple effects */}
      {ripples.map(ripple => (
        <motion.span
          key={ripple.id}
          className="absolute rounded-full pointer-events-none bg-white/30"
          style={{
            left: ripple.x - 10,
            top: ripple.y - 10,
            width: 20,
            height: 20,
          }}
          initial={{ scale: 0, opacity: 1 }}
          animate={{ scale: 4, opacity: 0 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        />
      ))}
      
      {/* Button content */}
      <span className="relative z-10 flex items-center gap-2">
        {children}
      </span>
    </motion.button>
  );
};

// Elastic Card (React Bits Style)
const ElasticCard: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className = "" }) => {
  const [isPressed, setIsPressed] = useState(false);

  return (
    <motion.div
      className={`relative overflow-hidden rounded-2xl bg-white/5 backdrop-blur-xl border border-white/10 ${className}`}
      onMouseDown={() => setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      onMouseLeave={() => setIsPressed(false)}
      whileHover={{ 
        scale: 1.02,
        rotateX: 5,
        rotateY: 5,
      }}
      whileTap={{ scale: 0.98 }}
      animate={{
        rotateX: isPressed ? 10 : 0,
        rotateY: isPressed ? 10 : 0,
      }}
      transition={{ 
        type: "spring", 
        stiffness: 400, 
        damping: 30,
      }}
      style={{
        transformStyle: "preserve-3d",
        perspective: 1000,
      }}
    >
      {children}
    </motion.div>
  );
};

// ==================== ACETERNITY INSPIRED COMPONENTS ====================

// Meteor Effect (Aceternity Style)
const MeteorEffect: React.FC<{
  number?: number;
  className?: string;
}> = ({ number = 20, className = "" }) => {
  const meteors = Array.from({ length: number }, (_, i) => ({
    id: i,
    animationDelay: Math.random() * 0.6 + 0.2,
    animationDuration: Math.random() * 8 + 2,
    size: Math.random() * 2 + 1,
    left: Math.random() * 100,
  }));

  return (
    <div className={`absolute inset-0 overflow-hidden ${className}`}>
      {meteors.map((meteor) => (
        <motion.div
          key={meteor.id}
          className="absolute h-0.5 bg-gradient-to-l from-blue-500 via-blue-500 to-transparent rounded-full"
          style={{
            left: `${meteor.left}%`,
            width: `${meteor.size * 50}px`,
            animationDelay: `${meteor.animationDelay}s`,
            animationDuration: `${meteor.animationDuration}s`,
          }}
          animate={{
            x: ['-100px', '2000px'],
            y: ['0px', '300px'],
            opacity: [0, 1, 0],
          }}
          transition={{
            duration: meteor.animationDuration,
            repeat: Infinity,
            delay: meteor.animationDelay,
            ease: "linear",
          }}
        />
      ))}
    </div>
  );
};

// Lamp Effect (Aceternity Style)
const LampEffect: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className = "" }) => {
  return (
    <div className={`relative min-h-screen bg-black overflow-hidden ${className}`}>
      {/* Lamp beams */}
      <motion.div
        className="absolute top-0 -translate-x-1/2 left-1/2 w-96 h-96"
        initial={{ opacity: 0, scale: 0.5 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 1.5, ease: "easeOut" }}
      >
        <div className="absolute inset-0 rounded-full bg-gradient-conic from-blue-500 via-purple-500 to-pink-500 opacity-30 blur-3xl" />
        <div className="absolute rounded-full opacity-50 inset-8 bg-gradient-conic from-cyan-400 via-blue-500 to-purple-600 blur-2xl" />
        <div className="absolute rounded-full inset-16 bg-gradient-conic from-white via-blue-300 to-purple-400 opacity-70 blur-xl" />
      </motion.div>

      {/* Radial gradient overlay */}
      <div className="absolute inset-0 bg-gradient-radial from-transparent via-black/50 to-black" />

      {/* Content */}
      <div className="relative z-10">
        {children}
      </div>
    </div>
  );
};

// Wavy Background (Aceternity Style)
const WavyBackground: React.FC<{
  children: React.ReactNode;
  className?: string;
  containerClassName?: string;
  colors?: string[];
  waveWidth?: number;
  backgroundFill?: string;
  blur?: number;
  speed?: "slow" | "fast";
}> = ({
  children,
  className = "",
  containerClassName = "",
  colors = ["#38bdf8", "#818cf8", "#c084fc", "#e879f9", "#22d3ee"],
  blur = 10,
  speed = "fast"
}) => {

  useEffect(() => {
    // Safari detection removed as it was unused
  }, []);

  return (
    <div className={`h-screen flex flex-col items-center justify-center relative ${containerClassName}`}>
      <svg
        className="absolute inset-0 z-0"
        style={{
          filter: `blur(${blur}px)`,
        }}
        width="100%"
        height="100%"
        viewBox="0 0 100 20"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {colors.map((color, index) => (
            <linearGradient
              key={index}
              id={`gradient${index}`}
              x1="0%"
              y1="0%"
              x2="0%"
              y2="100%"
            >
              <stop offset="0%" stopColor={color} stopOpacity="0" />
              <stop offset="50%" stopColor={color} stopOpacity="0.5" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        
        {colors.map((color, index) => (
          <motion.path
            key={index}
            d={`M0,${10 + index * 2} Q25,${5 + index * 2} 50,${10 + index * 2} T100,${10 + index * 2}`}
            fill="none"
            stroke={`url(#gradient${index})`}
            strokeWidth="2"
            animate={{
              d: [
                `M0,${10 + index * 2} Q25,${5 + index * 2} 50,${10 + index * 2} T100,${10 + index * 2}`,
                `M0,${10 + index * 2} Q25,${15 + index * 2} 50,${10 + index * 2} T100,${10 + index * 2}`,
                `M0,${10 + index * 2} Q25,${5 + index * 2} 50,${10 + index * 2} T100,${10 + index * 2}`,
              ],
            }}
            transition={{
              duration: speed === "fast" ? 3 : 6,
              repeat: Infinity,
              delay: index * 0.2,
            }}
          />
        ))}
      </svg>
      
      <div className={`relative z-10 ${className}`}>
        {children}
      </div>
    </div>
  );
};

// ==================== UIVERSE INSPIRED COMPONENTS ====================

// Neon Button (UIverse Style)
const NeonButton: React.FC<{
  children: React.ReactNode;
  onClick?: () => void;
  color?: 'blue' | 'purple' | 'green' | 'pink';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
}> = ({ children, onClick, color = 'blue', size = 'md', disabled = false }) => {
  const [isGlowing, setIsGlowing] = useState(false);

  const colors = {
    blue: {
      bg: 'from-blue-500 to-cyan-500',
      shadow: 'shadow-blue-500/50',
      glow: '0 0 40px #3b82f6, 0 0 60px #3b82f6, 0 0 80px #3b82f6'
    },
    purple: {
      bg: 'from-purple-500 to-pink-500',
      shadow: 'shadow-purple-500/50',
      glow: '0 0 40px #a855f7, 0 0 60px #a855f7, 0 0 80px #a855f7'
    },
    green: {
      bg: 'from-emerald-500 to-teal-500',
      shadow: 'shadow-emerald-500/50',
      glow: '0 0 40px #10b981, 0 0 60px #10b981, 0 0 80px #10b981'
    },
    pink: {
      bg: 'from-pink-500 to-rose-500',
      shadow: 'shadow-pink-500/50',
      glow: '0 0 40px #ec4899, 0 0 60px #ec4899, 0 0 80px #ec4899'
    }
  };

  const sizes = {
    sm: 'px-4 py-2 text-sm',
    md: 'px-6 py-3 text-base',
    lg: 'px-8 py-4 text-lg'
  };

  return (
    <motion.button
      className={`
        relative overflow-hidden rounded-lg font-bold uppercase tracking-wider
        bg-gradient-to-r ${colors[color].bg} text-white border-2 border-current
        ${sizes[size]} ${colors[color].shadow}
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
      `}
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => !disabled && setIsGlowing(true)}
      onMouseLeave={() => setIsGlowing(false)}
      whileHover={!disabled ? { scale: 1.05 } : undefined}
      whileTap={!disabled ? { scale: 0.95 } : undefined}
      animate={{
        boxShadow: isGlowing && !disabled
          ? colors[color].glow
          : '0 4px 15px rgba(0, 0, 0, 0.2)'
      }}
      transition={{ duration: 0.3 }}
      disabled={disabled}
    >
      {/* Animated border */}
      <motion.div
        className="absolute inset-0 rounded-lg"
        animate={{
          background: isGlowing && !disabled
            ? `conic-gradient(from 0deg, transparent, ${color === 'blue' ? '#3b82f6' : color === 'purple' ? '#a855f7' : color === 'green' ? '#10b981' : '#ec4899'}, transparent)`
            : 'transparent'
        }}
        transition={{ duration: 0.3 }}
      />
      
      {/* Scanning line */}
      <motion.div
        className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent"
        animate={{ translateX: isGlowing && !disabled ? '200%' : '-100%' }}
        transition={{ duration: 0.8, ease: "easeInOut" }}
      />
      
      <span className="relative z-10">{children}</span>
    </motion.button>
  );
};

// Floating Card (UIverse Style)
const FloatingCard: React.FC<{
  children: React.ReactNode;
  className?: string;
  floatIntensity?: number;
}> = ({ children, className = "", floatIntensity = 10 }) => {
  return (
    <motion.div
      className={`relative ${className}`}
      animate={{
        y: [0, -floatIntensity, 0],
        rotateX: [0, 2, 0],
        rotateY: [0, 1, 0],
      }}
      transition={{
        duration: 4,
        repeat: Infinity,
        ease: "easeInOut",
      }}
      style={{
        transformStyle: "preserve-3d",
      }}
    >
      <div className="relative p-6 border shadow-2xl backdrop-blur-xl bg-white/5 border-white/10 rounded-2xl">
        {/* Floating particles around card */}
        {Array.from({ length: 6 }).map((_, i) => (
          <motion.div
            key={i}
            className="absolute w-1 h-1 bg-blue-400 rounded-full"
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
            }}
            animate={{
              y: [0, -20, 0],
              opacity: [0.3, 1, 0.3],
              scale: [0.5, 1, 0.5],
            }}
            transition={{
              duration: 3 + Math.random() * 2,
              repeat: Infinity,
              delay: Math.random() * 2,
            }}
          />
        ))}
        
        {children}
      </div>
    </motion.div>
  );
};

// Morphing Loader (UIverse Style)
const MorphingLoader: React.FC<{
  size?: number;
  color?: string;
}> = ({ size = 40, color = "#3b82f6" }) => {
  return (
    <div className="flex items-center justify-center">
      <motion.div
        className="relative"
        style={{ width: size, height: size }}
      >
        {/* Main morphing shape */}
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{ backgroundColor: color }}
          animate={{
            scale: [1, 1.2, 1],
            borderRadius: ["50%", "25%", "50%"],
            rotate: [0, 180, 360],
          }}
          transition={{
            duration: 2,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
        
        {/* Orbiting particles */}
        {Array.from({ length: 3 }).map((_, i) => (
          <motion.div
            key={i}
            className="absolute w-2 h-2 rounded-full"
            style={{
              backgroundColor: color,
              opacity: 0.6,
              transformOrigin: `${size / 2}px ${size / 4}px`,
            }}
            animate={{
              rotate: [0, 360],
              scale: [0.8, 1.2, 0.8],
            }}
            transition={{
              duration: 1.5,
              repeat: Infinity,
              delay: i * 0.2,
            }}
          />
        ))}
      </motion.div>
    </div>
  );
};

// Beautiful Animated Text (Much More Attractive)
const HolographicText: React.FC<{ 
  children: React.ReactNode; 
  className?: string;
  intensity?: 'subtle' | 'medium' | 'strong';
}> = ({ children, className = "", intensity = 'medium' }) => {
  const intensityConfig = {
    subtle: {
      colors: ['#60a5fa', '#a78bfa', '#f472b6'],
      glowSize: '20px',
      animationSpeed: 8
    },
    medium: {
      colors: ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b'],
      glowSize: '30px',
      animationSpeed: 6
    },
    strong: {
      colors: ['#1d4ed8', '#7c3aed', '#be185d', '#dc2626', '#059669'],
      glowSize: '40px',
      animationSpeed: 4
    }
  };

  const config = intensityConfig[intensity];

  return (
    <motion.span 
      className={`relative inline-block font-bold ${className}`}
      whileHover={{ scale: 1.05 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
    >
      {/* Main text with animated gradient */}
      <motion.span
        className="relative z-10 text-transparent bg-clip-text"
        style={{
          background: `linear-gradient(45deg, ${config.colors.join(', ')})`,
          backgroundSize: '300% 300%',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}
        animate={{
          backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'],
        }}
        transition={{
          duration: config.animationSpeed,
          repeat: Infinity,
          ease: "linear",
        }}
      >
        {children}
      </motion.span>

      {/* Glowing background layers */}
      <motion.span
        className="absolute inset-0 blur-sm opacity-60"
        style={{
          background: `linear-gradient(45deg, ${config.colors.join(', ')})`,
          backgroundSize: '300% 300%',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}
        animate={{
          backgroundPosition: ['100% 50%', '0% 50%', '100% 50%'],
        }}
        transition={{
          duration: config.animationSpeed * 1.2,
          repeat: Infinity,
          ease: "linear",
        }}
      >
        {children}
      </motion.span>

      {/* Outer glow */}
      <motion.span
        className="absolute inset-0 blur-lg opacity-30"
        style={{
          background: `linear-gradient(45deg, ${config.colors.join(', ')})`,
          backgroundSize: '400% 400%',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}
        animate={{
          backgroundPosition: ['0% 0%', '100% 100%', '0% 0%'],
          scale: [1, 1.1, 1],
        }}
        transition={{
          duration: config.animationSpeed * 1.5,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      >
        {children}
      </motion.span>

      {/* Sparkle effect */}
      <motion.div
        className="absolute inset-0 pointer-events-none"
        animate={{
          opacity: [0, 1, 0],
        }}
        transition={{
          duration: 2,
          repeat: Infinity,
          delay: Math.random() * 2,
        }}
      >
        {Array.from({ length: 3 }).map((_, i) => (
          <motion.div
            key={i}
            className="absolute w-1 h-1 bg-white rounded-full"
            style={{
              left: `${20 + i * 30}%`,
              top: `${10 + i * 20}%`,
            }}
            animate={{
              scale: [0, 1, 0],
              rotate: [0, 180, 360],
              opacity: [0, 1, 0],
            }}
            transition={{
              duration: 1.5,
              repeat: Infinity,
              delay: i * 0.3 + Math.random(),
            }}
          />
        ))}
      </motion.div>
    </motion.span>
  );
};

// ==================== ADVANCED PATTERN COMPONENTS ====================

// Particle System (Advanced)
const AdvancedParticleSystem: React.FC<{
  particleCount?: number;
  colors?: string[];
  interactive?: boolean;
}> = ({ particleCount = 50, colors = ['#3b82f6', '#8b5cf6', '#ec4899'], interactive = true }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setMousePosition({
          x: ((e.clientX - rect.left) / rect.width) * 100,
          y: ((e.clientY - rect.top) / rect.height) * 100,
        });
      }
    };

    if (interactive) {
      window.addEventListener('mousemove', handleMouseMove);
      return () => window.removeEventListener('mousemove', handleMouseMove);
    }
  }, [interactive]);

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden pointer-events-none">
      {Array.from({ length: particleCount }).map((_, i) => (
        <motion.div
          key={i}
          className="absolute w-1 h-1 rounded-full"
          style={{
            backgroundColor: colors[i % colors.length],
            left: `${Math.random() * 100}%`,
            top: `${Math.random() * 100}%`,
          }}
          animate={{
            x: interactive ? [0, mousePosition.x - 50, 0] : [0, Math.random() * 100 - 50, 0],
            y: interactive ? [0, mousePosition.y - 50, 0] : [0, Math.random() * 100 - 50, 0],
            opacity: [0, 1, 0],
            scale: [0, Math.random() + 0.5, 0],
          }}
          transition={{
            duration: Math.random() * 3 + 2,
            repeat: Infinity,
            delay: Math.random() * 2,
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  );
};

// Magnetic Button Group (Advanced)
const MagneticButtonGroup: React.FC<{
  buttons: Array<{
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
  }>;
}> = ({ buttons }) => {
  const [activeIndex, setActiveIndex] = useState(0);

  return (
    <div className="flex items-center gap-4 p-4 border bg-black/40 backdrop-blur-xl rounded-2xl border-white/10">
      {buttons.map((button, index) => (
        <motion.button
          key={index}
          className={`relative p-4 rounded-xl transition-all duration-300 ${
            activeIndex === index 
              ? 'bg-gradient-to-r from-blue-500 to-purple-500 text-white' 
              : 'text-white/70 hover:text-white hover:bg-white/10'
          }`}
          onClick={() => {
            setActiveIndex(index);
            button.onClick();
          }}
          whileHover={{ 
            scale: 1.1,
            rotateZ: activeIndex === index ? 0 : Math.random() * 10 - 5,
          }}
          whileTap={{ scale: 0.9 }}
          layout
        >
          {button.icon}
          
          {/* Magnetic field effect */}
          <motion.div
            className="absolute inset-0 border-2 rounded-xl border-blue-400/30"
            animate={{
              scale: activeIndex === index ? [1, 1.2, 1] : 1,
              opacity: activeIndex === index ? [0.3, 0.7, 0.3] : 0,
            }}
            transition={{ duration: 2, repeat: Infinity }}
          />
          
          {/* Label */}
          <motion.span
            className="absolute text-xs -translate-x-1/2 -bottom-8 left-1/2 whitespace-nowrap"
            initial={{ opacity: 0, y: 10 }}
            animate={{ 
              opacity: activeIndex === index ? 1 : 0,
              y: activeIndex === index ? 0 : 10,
            }}
          >
            {button.label}
          </motion.span>
        </motion.button>
      ))}
    </div>
  );
};

export {
  MagicalSpotlightCard,
  FloatingDock,
  MicroInteractionButton,
  ElasticCard,
  MeteorEffect,
  LampEffect,
  WavyBackground,
  NeonButton,
  FloatingCard,
  MorphingLoader,
  HolographicText,
  AdvancedParticleSystem,
  MagneticButtonGroup,
};