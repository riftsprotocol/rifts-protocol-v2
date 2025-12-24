'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { PieChart, Coins, TrendingUp, Lock, LucideIcon } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

interface DistributionItem {
  label: string;
  percentage: number;
  color: string;
}

interface TokenStat {
  icon: LucideIcon;
  title: string;
  value: string;
}

const Tokenomics: React.FC = () => {
  const { toast } = useToast();
  
  const handleTokenomicsClick = (): void => {
    toast({
        title: "🚧 Tokenomics Details",
        description: "This feature isn't implemented yet—but don't worry! You can request it in your next prompt! 🚀"
    });
  };

  const distribution: DistributionItem[] = [
    { label: 'Liquidity Mining', percentage: 40, color: 'bg-blue-500' },
    { label: 'Team & Advisors', percentage: 20, color: 'bg-purple-500' },
    { label: 'Treasury', percentage: 15, color: 'bg-green-500' },
    { label: 'Public Sale', percentage: 15, color: 'bg-yellow-500' },
    { label: 'Ecosystem', percentage: 10, color: 'bg-red-500' }
  ];

  const tokenStats: TokenStat[] = [
    { icon: Coins, title: 'Total Supply', value: '1,000,000,000 RIFTS' },
    { icon: TrendingUp, title: 'Initial Price', value: '$0.25 USD' },
    { icon: Lock, title: 'Vesting', value: 'Team tokens vested over 24 months' },
  ];

  return (
    <section id="tokenomics" className="py-20 relative">
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          viewport={{ once: true, amount: 0.5 }}
          className="text-center mb-16"
        >
          <h2 className="text-4xl md:text-5xl font-bold mb-6">
            <span className="text-glow">Tokenomics</span>
          </h2>
          <p className="text-xl text-white/70 max-w-3xl mx-auto">
            Sustainable token economics designed to align incentives and drive long-term protocol growth.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-12 items-center">
          <motion.div
            initial={{ opacity: 0, x: -50 }}
            whileInView={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            viewport={{ once: true, amount: 0.5 }}
            className="lg:col-span-3 bg-white/5 border border-white/10 rounded-xl p-8 backdrop-blur-sm tech-border cursor-pointer"
            onClick={handleTokenomicsClick}
          >
            <h3 className="text-2xl font-bold mb-8 flex items-center gap-3">
              <PieChart className="w-6 h-6" />
              Token Distribution
            </h3>
            
            <div className="space-y-4">
              {distribution.map((item, index) => (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, x: -20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.6, delay: index * 0.1 + 0.4 }}
                  viewport={{ once: true }}
                  className="flex items-center justify-between"
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-4 h-4 rounded-full ${item.color}`} />
                    <span className="text-white/80">{item.label}</span>
                  </div>
                  <span className="font-bold font-mono">{item.percentage}%</span>
                </motion.div>
              ))}
            </div>

            <div className="mt-8 h-4 bg-white/10 rounded-full overflow-hidden flex">
              {distribution.map((item, index) => (
                <motion.div
                  key={index}
                  className={item.color}
                  style={{ width: `${item.percentage}%` }}
                  initial={{ width: 0 }}
                  whileInView={{ width: `${item.percentage}%` }}
                  transition={{ duration: 1.5, delay: 0.5, ease: "easeInOut" }}
                  viewport={{ once: true }}
                />
              ))}
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 50 }}
            whileInView={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8, delay: 0.4 }}
            viewport={{ once: true, amount: 0.5 }}
            className="lg:col-span-2 space-y-6"
          >
            {tokenStats.map((stat, index) => (
              <div key={index} className="flex items-start gap-4">
                <div className="w-10 h-10 bg-white/10 rounded-lg flex items-center justify-center border border-white/20 flex-shrink-0">
                  <stat.icon className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h4 className="font-semibold text-white">{stat.title}</h4>
                  <p className="text-white/60 text-sm">{stat.value}</p>
                </div>
              </div>
            ))}
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default Tokenomics;