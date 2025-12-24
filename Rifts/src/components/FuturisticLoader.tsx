'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Database, Cpu, Lock, Globe, Sparkles, Atom } from 'lucide-react';
import Image from 'next/image';

interface LoaderProps {
  onComplete: () => void;
}

const FuturisticLoader: React.FC<LoaderProps> = ({ onComplete }) => {
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState(0);
  const [particles, setParticles] = useState<Array<{id: number, x: number, y: number, delay: number}>>([]);

  const stages = [
    'Initializing Quantum Core...',
    'Connecting to Volatility Matrix...',
    'Calibrating Risk Algorithms...',
    'Loading Protocol Interface...',
    'Finalizing Secure Connection...'
  ];

  useEffect(() => {
    // Create floating particles - reduced count for performance
    const newParticles = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      delay: Math.random() * 2
    }));
    setParticles(newParticles);

    const timer = setInterval(() => {
      setProgress(prev => {
        const newProgress = prev + 2; // Increment by 2% every 100ms = 5 seconds total
        
        if (newProgress >= 20 && stage < 1) setStage(1);
        if (newProgress >= 40 && stage < 2) setStage(2);
        if (newProgress >= 60 && stage < 3) setStage(3);
        if (newProgress >= 80 && stage < 4) setStage(4);
        
        if (newProgress >= 100) {
          clearInterval(timer);
          setTimeout(onComplete, 300);
          return 100;
        }
        
        return newProgress;
      });
    }, 100); // 100ms interval, 2% increment = 5 seconds total

    return () => clearInterval(timer);
  }, [onComplete, stage]);

  return (
    <div className="fixed inset-0 bg-black z-[200] overflow-hidden ios-pointer-none">
      {/* Base gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-gray-900 via-black to-gray-800" />
      
      {/* Animated background grid */}
      <div className="absolute inset-0 opacity-30">
        <div 
          className="w-full h-full"
          style={{
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)
            `,
            backgroundSize: '40px 40px',
            animation: 'grid-pulse 4s ease-in-out infinite alternate'
          }}
        />
      </div>

      {/* Floating particles */}
      {particles.map((particle) => (
        <motion.div
          key={particle.id}
          className="absolute w-1 h-1 bg-white/60 rounded-full opacity-40"
          style={{
            left: `${particle.x}%`,
            top: `${particle.y}%`,
          }}
          animate={{
            y: [0, -20, 0],
            opacity: [0.3, 1, 0.3],
            scale: [0.5, 1.5, 0.5]
          }}
          transition={{
            duration: 3 + Math.random() * 2,
            repeat: Infinity,
            delay: particle.delay,
            ease: "easeInOut"
          }}
        />
      ))}

      {/* Main loader content */}
      <div className="flex items-center justify-center min-h-screen p-8">
        <div className="text-center space-y-12">
          
          {/* Logo with pulse effect */}
          <motion.div
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ duration: 1, type: "spring", bounce: 0.5 }}
            className="relative"
          >
            <div className="relative flex items-center justify-center mb-8">
              <motion.div
                animate={{ 
                  scale: [1, 1.2, 1],
                  boxShadow: [
                    '0 0 20px rgba(255, 255, 255, 0.2)',
                    '0 0 40px rgba(255, 255, 255, 0.4)',
                    '0 0 20px rgba(255, 255, 255, 0.2)'
                  ]
                }}
                transition={{ duration: 2, repeat: Infinity }}
                className="w-24 h-24 bg-white/5 backdrop-blur-sm border border-white/10 rounded-xl flex items-center justify-center relative overflow-hidden"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-white/10 via-transparent to-black/20" />
                <div className="relative z-10 flex items-center space-x-2">
                  <Image 
                    src="/Logo RIFTS.png" 
                    alt="RIFTS Protocol Logo" 
                    width={64} 
                    height={64} 
                    className="w-16 h-16 object-contain"
                  />
                </div>
              </motion.div>
            </div>
            
            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5, duration: 0.8 }}
              className="text-4xl md:text-6xl font-bold text-glow mb-4"
            >
              RIFTS
              <span className="block text-3xl md:text-5xl font-light text-white/80 mt-2">
                PROTOCOL
              </span>
            </motion.h1>
          </motion.div>

          {/* Progress section */}
          <div className="space-y-8">
            {/* Circular progress */}
            <div className="relative flex items-center justify-center">
              <svg className="w-48 h-48 -rotate-90" viewBox="0 0 200 200">
                {/* Background circle */}
                <circle
                  cx="100"
                  cy="100"
                  r="80"
                  stroke="rgba(255,255,255,0.1)"
                  strokeWidth="2"
                  fill="none"
                />
                
                {/* Progress circle */}
                <motion.circle
                  cx="100"
                  cy="100"
                  r="80"
                  stroke="url(#whiteGradient)"
                  strokeWidth="4"
                  fill="none"
                  strokeLinecap="round"
                  strokeDasharray={502.4}
                  animate={{
                    strokeDashoffset: 502.4 - (progress / 100) * 502.4,
                  }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                />
                
                {/* Gradient definition */}
                <defs>
                  <linearGradient id="whiteGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="rgba(255,255,255,0.8)" />
                    <stop offset="50%" stopColor="rgba(255,255,255,0.6)" />
                    <stop offset="100%" stopColor="rgba(255,255,255,0.4)" />
                  </linearGradient>
                </defs>
              </svg>
              
              {/* Progress percentage */}
              <div className="absolute inset-0 flex items-center justify-center">
                <motion.div
                  key={Math.floor(progress)}
                  initial={{ scale: 0.8, opacity: 0.8 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="text-center"
                >
                  <div className="text-4xl font-bold text-white mb-2">
                    {Math.floor(progress)}%
                  </div>
                  <div className="flex space-x-1">
                    {[...Array(4)].map((_, i) => (
                      <motion.div
                        key={i}
                        animate={{
                          height: [4, 16, 4],
                          backgroundColor: [
                            'rgba(255, 255, 255, 0.3)',
                            'rgba(255, 255, 255, 0.8)',
                            'rgba(255, 255, 255, 0.3)'
                          ]
                        }}
                        transition={{
                          duration: 1,
                          repeat: Infinity,
                          delay: i * 0.1
                        }}
                        className="w-1 bg-white/60 rounded"
                      />
                    ))}
                  </div>
                </motion.div>
              </div>
            </div>

            {/* Status text */}
            <AnimatePresence mode="wait">
              <motion.div
                key={stage}
                initial={{ opacity: 0, y: 20, filter: 'blur(4px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -20, filter: 'blur(4px)' }}
                transition={{ duration: 0.5 }}
                className="space-y-4"
              >
                <p className="text-xl text-white/80 font-medium">
                  {stages[stage]}
                </p>
                
                {/* Status indicators */}
                <div className="flex justify-center space-x-8">
                  {[
                    { icon: Database, label: 'Core', active: stage >= 0 },
                    { icon: Globe, label: 'Network', active: stage >= 1 },
                    { icon: Lock, label: 'Security', active: stage >= 2 },
                    { icon: Sparkles, label: 'Interface', active: stage >= 3 }
                  ].map((item, index) => (
                    <motion.div
                      key={index}
                      className="flex flex-col items-center space-y-2"
                      animate={{
                        scale: item.active ? 1.1 : 1,
                        opacity: item.active ? 1 : 0.4
                      }}
                      transition={{ duration: 0.3 }}
                    >
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                        item.active 
                          ? 'bg-white/20 backdrop-blur-sm shadow-lg shadow-white/20 border border-white/30' 
                          : 'bg-white/5 border border-white/10'
                      }`}>
                        <item.icon className={`w-5 h-5 ${item.active ? 'text-white' : 'text-white/40'}`} />
                      </div>
                      <span className={`text-xs font-medium ${
                        item.active ? 'text-white' : 'text-white/40'
                      }`}>
                        {item.label}
                      </span>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            </AnimatePresence>

            {/* Loading bar */}
            <div className="w-full max-w-md mx-auto">
              <div className="h-2 bg-white/10 rounded-full overflow-hidden backdrop-blur-sm">
                <motion.div
                  className="h-full bg-gradient-to-r from-white/60 via-white/80 to-white/60 rounded-full relative"
                  animate={{ width: `${progress}%` }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                >
                  <div className="absolute inset-0 bg-white/30 rounded-full animate-pulse" />
                  <motion.div
                    className="absolute right-0 top-0 w-4 h-full bg-white/50 rounded-full"
                    animate={{
                      x: [0, 8, 0],
                      opacity: [0.5, 1, 0.5]
                    }}
                    transition={{
                      duration: 1.5,
                      repeat: Infinity,
                      ease: "easeInOut"
                    }}
                  />
                </motion.div>
              </div>
            </div>
          </div>

          {/* Bottom decoration */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1 }}
            className="text-center space-y-4"
          >
            <div className="flex justify-center space-x-2">
              {[...Array(5)].map((_, i) => (
                <motion.div
                  key={i}
                  animate={{
                    y: [0, -10, 0],
                    opacity: [0.3, 1, 0.3]
                  }}
                  transition={{
                    duration: 1.5,
                    repeat: Infinity,
                    delay: i * 0.1
                  }}
                  className="w-2 h-2 bg-gradient-to-r from-white/60 to-white/80 rounded-full"
                />
              ))}
            </div>
            <p className="text-white/60 text-sm font-medium tracking-wider">
              LOADING VOLATILITY ENGINE
            </p>
          </motion.div>
        </div>
      </div>

      <style jsx>{`
        @keyframes grid-pulse {
          0%, 100% {
            opacity: 0.2;
          }
          50% {
            opacity: 0.4;
          }
        }
      `}</style>
    </div>
  );
};

export default FuturisticLoader;
