'use client';

import React from 'react';
import { motion, Variants } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';

const Hero: React.FC = () => {
  const router = useRouter();

  const handleLaunchApp = (): void => {
    router.push('/dapp');
  };

  const handleLearnMore = (): void => {
    const protocolSection = document.getElementById('protocol');
    if (protocolSection) {
      protocolSection.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const containerVariants: Variants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1, // Faster stagger
      },
    },
  };

  const itemVariants: Variants = {
    hidden: { opacity: 0, y: 20 }, // Reduced movement
    visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" } }, // Faster
  };

  return (
    <section className="relative min-h-screen flex items-center justify-center pt-32 pb-20 overflow-hidden">
      <div className="container mx-auto px-6 text-center relative z-10">
        <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-3xl p-8 md:p-12 shadow-2xl relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-white/10 via-transparent to-black/20" />
          <div className="relative z-10">
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          className="max-w-4xl mx-auto"
        >
           <motion.div variants={itemVariants}>
             <span className="inline-flex items-center gap-2 px-4 py-2 bg-white/5 border border-white/10 rounded-full text-sm font-mono mb-6 tech-border hover:bg-white/10">
               <motion.div 
                 className="w-2 h-2 rounded-full bg-green-400"
                 animate={{ scale: [1, 1.2, 1], opacity: [0.5, 1, 0.5] }}
                 transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
               />
               VOLATILITY CORE: ONLINE
             </span>
           </motion.div>

          <motion.h1
            variants={itemVariants}
            className="text-5xl md:text-7xl font-bold mb-6 text-glow"
          >
            RIFTS
            <span className="block text-4xl md:text-6xl font-light text-white/80 mt-2">
              PROTOCOL
            </span>
          </motion.h1>

          <motion.p
            variants={itemVariants}
            className="text-xl md:text-2xl text-white/80 mb-8 max-w-3xl mx-auto"
          >
            Revolutionary volatility farming with wrapped tokens. Advanced DeFi strategies for institutional-grade yield generation and risk management.
          </motion.p>

          <motion.div
            variants={itemVariants}
            className="flex flex-col sm:flex-row gap-4 justify-center mb-12"
          >
            <Button
              size="lg"
              onClick={handleLaunchApp}
              className="bg-white text-black hover:bg-white/90 px-8 text-lg font-semibold group relative overflow-hidden transition-all duration-300 ease-in-out hover:shadow-[0_0_20px_rgba(255,255,255,0.5)]"
            >
              <span className="relative z-10">Launch App</span>
              <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform z-10" />
            </Button>
            <Button
              variant="outline"
              size="lg"
              onClick={handleLearnMore}
              className="border-white/20 text-white bg-transparent hover:bg-white/10 px-8 text-lg hover:border-white/40 hover:text-glow transition-all"
            >
              Learn More
            </Button>
          </motion.div>
        </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Hero;