'use client';

import React, { useEffect, useState, memo } from 'react';
import { motion, useInView, animate } from 'framer-motion';
import { TrendingUp, DollarSign, Users, Zap, LucideIcon } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { realDataService } from '@/lib/solana/real-data-service';
import type { RealDataMetrics } from '@/lib/solana/real-data-service';

interface AnimatedNumberProps {
  value: number;
  prefix?: string;
  suffix?: string;
}

const AnimatedNumber: React.FC<AnimatedNumberProps> = memo(({ value, prefix = "", suffix = "" }) => {
  const ref = React.useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true });
  const [displayValue, setDisplayValue] = useState<number>(0);

  useEffect(() => {
    if (isInView) {
      const controls = animate(0, value, {
        duration: 1.5, // Reduced animation time for faster feel
        ease: "easeOut",
        onUpdate: (latest) => {
          setDisplayValue(latest);
        },
      });
      return controls.stop;
    }
  }, [isInView, value]);

  const formatNumber = (num: number): string => {
    if (num >= 1000) {
      return num.toLocaleString(undefined, { maximumFractionDigits: 0 });
    }
    if (num % 1 !== 0) {
      return num.toFixed(1);
    }
    return num.toFixed(0);
  };
  
  return <span ref={ref}>{prefix}{formatNumber(displayValue)}{suffix}</span>;
});

interface Stat {
  icon: LucideIcon;
  label: string;
  value: number;
  prefix?: string;
  suffix?: string;
  change: string;
  color: string;
}

interface Activity {
  action: string;
  amount: string;
  user: string;
  time: string;
}

const Stats: React.FC = () => {
  const { toast } = useToast();
  const [realMetrics, setRealMetrics] = useState<RealDataMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [recentActivity, setRecentActivity] = useState<Activity[]>([]);
  
  useEffect(() => {
    const fetchRealData = async () => {
      try {
        console.log('🔄 Fetching real blockchain data...');
        const [metrics, activity] = await Promise.all([
          realDataService.getAllRealMetrics(),
          fetchRecentActivity()
        ]);
        
        console.log('📊 Real metrics received:', metrics);
        setRealMetrics(metrics);
        setRecentActivity(activity);
      } catch (error) {
        console.error('❌ Failed to fetch real blockchain data:', error);
        // Don't set any fallback data - let the loading state show or display zeros
        setRealMetrics(null);
        setRecentActivity([]);
      } finally {
        setLoading(false);
      }
    };

    fetchRealData();
    
    // Refresh data every 5 minutes
    const interval = setInterval(fetchRealData, 300000);
    return () => clearInterval(interval);
  }, []);

  const fetchRecentActivity = async (): Promise<Activity[]> => {
    try {
      // Fetch from Supabase cache instead of making direct RPC calls
      // This avoids redundant RPC requests since data is already cached
      const response = await fetch('/api/get-transactions?limit=4');

      if (!response.ok) {
        throw new Error('Failed to fetch cached transactions');
      }

      const data = await response.json();
      const transactions = data.transactions || [];

      const activities: Activity[] = [];

      for (const tx of transactions) {
        // Format time from timestamp
        const timestamp = new Date(tx.timestamp).getTime();
        const timeAgo = Math.floor((Date.now() - timestamp) / 60000); // minutes

        let formattedTime = '';
        if (timeAgo < 60) {
          formattedTime = `${timeAgo}m ago`;
        } else if (timeAgo < 1440) {
          formattedTime = `${Math.floor(timeAgo/60)}h ago`;
        } else if (timeAgo < 43200) {
          formattedTime = `${Math.floor(timeAgo/1440)}d ago`;
        } else {
          formattedTime = `${Math.floor(timeAgo/43200)}mo ago`;
        }

        // Format user address
        const user = tx.user_wallet || 'unknown';
        const shortUser = user.length > 8 ? user.slice(0, 4) + '...' + user.slice(-4) : user;

        // Format amount (stored as string in DB)
        const amount = parseFloat(tx.amount || '0');
        const amountFormatted = amount > 0 ? `$${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '$0.00';

        activities.push({
          action: tx.type === 'wrap' ? 'Wrap' : 'Unwrap',
          amount: amountFormatted,
          user: shortUser,
          time: formattedTime
        });

        if (activities.length >= 4) break;
      }

      return activities;
    } catch (error) {
      console.error('Failed to fetch recent activity from cache:', error);
      // Return empty array - don't show fake data
      return [];
    }
  };
  
  const handleActivityClick = (): void => {
    toast({
        title: "🟢 Live On-Chain Data",
        description: "Showing real wrap/unwrap activity from RIFTS Protocol"
    });
  };

  const stats: Stat[] = realMetrics ? [
    {
      icon: DollarSign,
      label: 'Total Value Locked',
      value: realMetrics.totalTvl > 1000000 ? realMetrics.totalTvl / 1000000 : realMetrics.totalTvl,
      prefix: '$',
      suffix: realMetrics.totalTvl > 1000000 ? 'M' : '',
      change: 'LIVE',
      color: 'text-green-400'
    },
    {
      icon: Users,
      label: 'Active Users',
      value: realMetrics.activeUsers,
      change: 'LIVE',
      color: 'text-blue-400'
    },
    {
      icon: TrendingUp,
      label: 'Average APY',
      value: realMetrics.avgApy,
      suffix: '%',
      change: 'LIVE',
      color: 'text-purple-400'
    },
    {
      icon: Zap,
      label: '24h Volume',
      value: realMetrics.totalVolume24h > 1000000 ? realMetrics.totalVolume24h / 1000000 : realMetrics.totalVolume24h / 1000,
      prefix: '$',
      suffix: realMetrics.totalVolume24h > 1000000 ? 'M' : 'K',
      change: 'LIVE',
      color: 'text-yellow-400'
    }
  ] : [
    {
      icon: DollarSign,
      label: 'Total Value Locked',
      value: 0,
      prefix: '$',
      suffix: '',
      change: loading ? 'LOADING...' : 'ERROR',
      color: 'text-green-400'
    },
    {
      icon: Users,
      label: 'Active Users',
      value: 0,
      change: loading ? 'LOADING...' : 'ERROR',
      color: 'text-blue-400'
    },
    {
      icon: TrendingUp,
      label: 'Average APY',
      value: 0,
      suffix: '%',
      change: loading ? 'LOADING...' : 'ERROR',
      color: 'text-purple-400'
    },
    {
      icon: Zap,
      label: '24h Volume',
      value: 0,
      prefix: '$',
      suffix: '',
      change: loading ? 'LOADING...' : 'ERROR',
      color: 'text-yellow-400'
    }
  ];

  const activities: Activity[] = recentActivity;

  return (
    <section className="py-20 relative">
      <div className="container mx-auto px-6">
        <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-3xl p-8 md:p-12 shadow-2xl relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-white/10 via-transparent to-black/20" />
          <div className="relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          viewport={{ once: true, amount: 0.5 }}
          className="text-center mb-16"
        >
          <h2 className="text-4xl md:text-5xl font-bold mb-6 text-glow">
            Ecosystem <span className="text-green-400">Overview</span>
          </h2>
          <p className="text-xl text-white/70 max-w-3xl mx-auto">
            Real-time metrics showcasing the protocol's performance and community growth.
          </p>
        </motion.div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-16">
          {stats.map((stat, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 50 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: index * 0.1 }}
              viewport={{ once: true, amount: 0.5 }}
              whileHover={{ y: -5, scale: 1.03 }}
              className="bg-white/5 border border-white/10 rounded-xl p-6 backdrop-blur-sm tech-border hover:bg-white/10"
            >
              <div className="flex items-center justify-between mb-4">
                <stat.icon className={`w-8 h-8 ${stat.color}`} />
                <span className={`text-sm font-semibold ${stat.color}`}>
                  {stat.change}
                </span>
              </div>
              
              <div className="text-4xl font-bold font-mono mb-2 text-glow">
                <AnimatedNumber value={stat.value} prefix={stat.prefix} suffix={stat.suffix} />
              </div>
              
              <div className="text-white/60 text-sm">
                {stat.label}
              </div>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 50 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.5 }}
          viewport={{ once: true, amount: 0.5 }}
          className="bg-white/5 border border-white/10 rounded-xl p-6 backdrop-blur-sm tech-border cursor-pointer hover:bg-white/10"
          onClick={handleActivityClick}
        >
          <h3 className="text-xl font-semibold mb-6 flex items-center gap-3">
            <div className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
            </div>
            Live Activity
          </h3>
          
          <div className="space-y-4 font-mono text-sm">
            {activities.length > 0 ? activities.map((activity, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.4, delay: index * 0.1 + 0.5, ease: "easeOut" }}
                viewport={{ once: true }}
                className="flex items-center justify-between py-2 border-b border-white/5 last:border-b-0"
              >
                <div className="flex items-center gap-4">
                  <span className={`px-2 py-1 rounded text-xs ${
                    activity.action === 'Wrap' ? 'bg-green-400/20 text-green-400' :
                    activity.action === 'Unwrap' ? 'bg-yellow-400/20 text-yellow-400' :
                    'bg-blue-400/20 text-blue-400'
                  }`}>
                    {activity.action}
                  </span>
                  <span className="text-white">{activity.amount}</span>
                  <span className="hidden sm:inline text-white/60">{activity.user}</span>
                </div>
                <span className="text-white/40 text-xs">{activity.time}</span>
              </motion.div>
            )) : (
              <div className="text-center py-8 text-white/40">
                {loading ? 'Loading activity...' : 'No recent wrap/unwrap activity found'}
              </div>
            )}
          </div>
        </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Stats;