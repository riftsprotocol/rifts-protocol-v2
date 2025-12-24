// components/backgrounds/index.tsx - Complete Background Systems

"use client";

import React, { useEffect, useRef, useState } from 'react';

// ==================== WAVY BACKGROUND ====================

export const WavyBackground: React.FC<{
  children: React.ReactNode;
  className?: string;
  colors?: string[];
  waveWidth?: number;
  speed?: 'slow' | 'medium' | 'fast';
}> = ({ 
  children, 
  className = "", 
  colors = ["#1e40af", "#7c3aed", "#db2777", "#059669"],
  waveWidth = 50,
  speed = 'medium'
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const updateDimensions = () => {
      setDimensions({
        width: window.innerWidth,
        height: window.innerHeight
      });
    };

    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = dimensions.width;
    canvas.height = dimensions.height;

    let animationId: number;
    let time = 0;

    const speedMultiplier = {
      slow: 0.005,
      medium: 0.01,
      fast: 0.02
    };

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Create gradient background
      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
      gradient.addColorStop(0, 'rgba(3, 7, 18, 0.95)');
      gradient.addColorStop(1, 'rgba(16, 24, 39, 0.9)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw waves
      colors.forEach((color, index) => {
        ctx.beginPath();
        
        const amplitude = 30 + index * 10;
        const frequency = 0.01 + index * 0.002;
        const phase = time * speedMultiplier[speed] + index * Math.PI / 2;
        
        for (let x = 0; x <= canvas.width; x++) {
          const y = canvas.height / 2 + 
                   Math.sin(x * frequency + phase) * amplitude +
                   Math.sin(x * frequency * 2 + phase * 1.5) * amplitude * 0.5;
          
          if (x === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        
        ctx.lineTo(canvas.width, canvas.height);
        ctx.lineTo(0, canvas.height);
        ctx.closePath();
        
        const hexToRgba = (hex: string, alpha: number) => {
          const r = parseInt(hex.slice(1, 3), 16);
          const g = parseInt(hex.slice(3, 5), 16);
          const b = parseInt(hex.slice(5, 7), 16);
          return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        };
        
        ctx.fillStyle = hexToRgba(color, 0.1 - index * 0.02);
        ctx.fill();
      });

      time += 1;
      animationId = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [dimensions, colors, waveWidth, speed]);

  return (
    <div className={`relative ${className}`}>
      <canvas
        ref={canvasRef}
        className="fixed inset-0 z-0"
        style={{ pointerEvents: 'none' }}
      />
      <div className="relative z-10">
        {children}
      </div>
    </div>
  );
};

// ==================== LUXURY PARTICLE FIELD ====================

export const LuxuryParticleField: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const particles: Array<{
      x: number;
      y: number;
      vx: number;
      vy: number;
      size: number;
      opacity: number;
      hue: number;
      life: number;
    }> = [];

    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Create luxury particles with enhanced properties
    for (let i = 0; i < 150; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.8,
        vy: (Math.random() - 0.5) * 0.8,
        size: Math.random() * 3 + 1,
        opacity: Math.random() * 0.5 + 0.2,
        hue: Math.random() * 60 + 200, // Blue-purple spectrum
        life: Math.random() * 100
      });
    }

    const animate = () => {
      // Subtle fade instead of complete clear for trail effect
      ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      particles.forEach((particle, index) => {
        // Update particle physics
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.life += 0.5;

        // Boundary wrapping for seamless effect
        if (particle.x < 0) particle.x = canvas.width;
        if (particle.x > canvas.width) particle.x = 0;
        if (particle.y < 0) particle.y = canvas.height;
        if (particle.y > canvas.height) particle.y = 0;

        // Dynamic opacity breathing effect
        const alpha = Math.sin(particle.life * 0.02) * 0.3 + 0.4;

        // Advanced gradient rendering
        const gradient = ctx.createRadialGradient(
          particle.x, particle.y, 0,
          particle.x, particle.y, particle.size * 2
        );
        gradient.addColorStop(0, `hsla(${particle.hue}, 70%, 60%, ${alpha})`);
        gradient.addColorStop(1, `hsla(${particle.hue}, 70%, 60%, 0)`);

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
        ctx.fill();

        // Neural network connections
        particles.slice(index + 1).forEach(otherParticle => {
          const dx = particle.x - otherParticle.x;
          const dy = particle.y - otherParticle.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance < 100) {
            const connectionOpacity = (100 - distance) / 100 * 0.1;
            ctx.strokeStyle = `rgba(100, 150, 255, ${connectionOpacity})`;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(particle.x, particle.y);
            ctx.lineTo(otherParticle.x, otherParticle.y);
            ctx.stroke();
          }
        });
      });

      requestAnimationFrame(animate);
    };

    animate();

    return () => {
      window.removeEventListener('resize', resizeCanvas);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 z-0 pointer-events-none"
      style={{ 
        background: 'radial-gradient(circle at 50% 50%, rgba(16, 24, 39, 0.9) 0%, rgba(3, 7, 18, 0.95) 100%)',
        mixBlendMode: 'multiply'
      }}
    />
  );
};

// ==================== INTERACTIVE GRID ====================

export const InteractiveGrid: React.FC = () => {
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePos({ 
        x: (e.clientX / window.innerWidth) * 100,
        y: (e.clientY / window.innerHeight) * 100
      });
    };
    
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  return (
    <div className="fixed inset-0 z-0 opacity-30">
      <div 
        className="absolute inset-0 transition-all duration-1000 ease-out"
        style={{
          backgroundImage: `
            radial-gradient(circle at ${mousePos.x}% ${mousePos.y}%, 
              rgba(59, 130, 246, 0.15) 0%, 
              rgba(147, 51, 234, 0.1) 25%, 
              transparent 50%
            ),
            linear-gradient(90deg, rgba(59, 130, 246, 0.03) 1px, transparent 1px),
            linear-gradient(rgba(59, 130, 246, 0.03) 1px, transparent 1px)
          `,
          backgroundSize: '100% 100%, 60px 60px, 60px 60px',
          backgroundPosition: '0 0, 0 0, 0 0',
          backgroundRepeat: 'no-repeat, repeat, repeat'
        }}
      />
    </div>
  );
};

// ==================== FLOATING ORBS ====================

export const FloatingOrbs: React.FC<{ count?: number }> = ({ count = 8 }) => {
  const [orbs, setOrbs] = useState<Array<{
    width: number;
    height: number;
    left: string;
    top: string;
    animationDelay: string;
    animationDuration: string;
  }>>([]);

  useEffect(() => {
    const newOrbs = Array.from({ length: count }).map(() => ({
      width: Math.random() * 400 + 100,
      height: Math.random() * 400 + 100,
      left: `${Math.random() * 100}%`,
      top: `${Math.random() * 100}%`,
      animationDelay: `${Math.random() * 5}s`,
      animationDuration: `${Math.random() * 20 + 20}s`
    }));
    setOrbs(newOrbs);
  }, [count]);

  return (
    <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none">
      {orbs.map((orb, i) => (
        <div
          key={i}
          className="absolute rounded-full opacity-20 bg-gradient-to-r from-emerald-400 to-cyan-400 blur-xl animate-float"
          style={orb}
        />
      ))}
    </div>
  );
};

// ==================== AMBIENT GLOW EFFECTS ====================

export const AmbientGlow: React.FC<{ 
  color?: string; 
  intensity?: number; 
  position?: 'top' | 'bottom' | 'center';
}> = ({ 
  color = 'blue', 
  intensity = 0.3, 
  position = 'center' 
}) => {
  const positions = {
    top: 'top-0',
    bottom: 'bottom-0', 
    center: 'top-1/2 -translate-y-1/2'
  };

  const colors = {
    blue: 'from-blue-500/20 to-purple-500/20',
    green: 'from-emerald-500/20 to-teal-500/20',
    red: 'from-red-500/20 to-pink-500/20',
    purple: 'from-purple-500/20 to-violet-500/20'
  };

  return (
    <div 
      className={`absolute left-1/2 -translate-x-1/2 ${positions[position]} w-96 h-96 bg-gradient-radial ${colors[color as keyof typeof colors]} rounded-full blur-3xl pointer-events-none`}
      style={{ opacity: intensity }}
    />
  );
};