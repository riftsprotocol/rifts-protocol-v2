'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { 
  BarChart3, 
  Shield, 
  Zap, 
  Target, 
  TrendingUp, 
  Lock,
  Cpu,
  Database,
  LucideIcon
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

interface Feature {
  icon: LucideIcon;
  title: string;
  description: string;
  tech: string;
}

const Features: React.FC = () => {
  const { toast } = useToast();
  
  const handleFeatureClick = (): void => {
    toast({
        title: "🚧 Feature Details",
        description: "This feature isn't implemented yet—but don't worry! You can request it in your next prompt! 🚀"
    });
  };

  const features: Feature[] = [
    {
      icon: BarChart3,
      title: 'Volatility Farming',
      description: 'Harvest profits from market volatility using advanced algorithmic strategies.',
      tech: 'AI-Powered'
    },
    {
      icon: Shield,
      title: 'Risk Management',
      description: 'Multi-layered protection with real-time monitoring and automatic position sizing.',
      tech: 'Institutional Grade'
    },
    {
      icon: Zap,
      title: 'Auto-Compounding',
      description: 'Maximize returns with automated reinvestment and gas optimization.',
      tech: 'Smart Contracts'
    },
    {
      icon: Target,
      title: 'Precision Targeting',
      description: 'Target specific volatility ranges with customizable risk parameters.',
      tech: 'Machine Learning'
    },
    {
      icon: TrendingUp,
      title: 'Yield Optimization',
      description: 'Dynamic allocation across multiple strategies for maximum efficiency.',
      tech: 'Algorithmic'
    },
    {
      icon: Lock,
      title: 'Secure Vaults',
      description: 'Battle-tested smart contracts with multi-sig governance and insurance.',
      tech: 'Audited'
    },
    {
      icon: Cpu,
      title: 'MEV Protection',
      description: 'Advanced MEV protection and sandwich attack prevention mechanisms.',
      tech: 'Next-Gen'
    },
    {
      icon: Database,
      title: 'Data Analytics',
      description: 'Real-time analytics dashboard with comprehensive performance metrics.',
      tech: 'Real-Time'
    }
  ];

  return (
    <section id="features" className="py-20 relative bg-black">
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          viewport={{ once: true, amount: 0.5 }}
          className="text-center mb-16"
        >
          <h2 className="text-4xl md:text-5xl font-bold mb-6">
            Advanced <span className="text-glow">Features</span>
          </h2>
          <p className="text-xl text-white/70 max-w-3xl mx-auto">
            Cutting-edge technology meets institutional-grade security in our comprehensive DeFi protocol.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 50 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: index * 0.1 }}
              viewport={{ once: true, amount: 0.5 }}
              whileHover={{ y: -10, scale: 1.02 }}
              className="bg-white/5 border border-white/10 rounded-xl p-6 backdrop-blur-sm hover:bg-white/10 transition-all duration-300 tech-border group cursor-pointer"
              onClick={handleFeatureClick}
            >
              <div className="flex items-center justify-between mb-4">
                <feature.icon className="w-8 h-8 text-white group-hover:scale-110 transition-transform" />
                <span className="text-xs font-mono text-white/50 bg-white/10 px-2 py-1 rounded">
                  {feature.tech}
                </span>
              </div>
              
              <h3 className="text-lg font-semibold mb-3 group-hover:text-glow transition-all">
                {feature.title}
              </h3>
              
              <p className="text-white/60 text-sm leading-relaxed">
                {feature.description}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Features;