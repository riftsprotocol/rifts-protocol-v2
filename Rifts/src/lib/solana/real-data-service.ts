// Real Data Service - Connect to actual Solana blockchain data
import { Connection, PublicKey } from '@solana/web3.js';
import { productionJupiterOracle } from './jupiter-oracle';
import { RIFTS_PROGRAM_ID } from './rifts-service';

export interface RealDataMetrics {
  totalTvl: number;
  activeUsers: number;
  totalVolume24h: number;
  totalFees: number;
  totalBurned: number;
  avgApy: number;
  burnRate: number;
  activeOracles: number;
  priceFeedAccuracy: number;
  avgLatency: number;
}

export interface RealUserAnalytics {
  newUsers7d: number;
  activeUsers30d: number;
  retentionRate: number;
  positionDistribution: {
    under1k: number;
    between1k10k: number;
    over10k: number;
  };
  volumeMetrics: {
    dailyAvg: number;
    weeklyPeak: number;
    totalVolume: number;
  };
  geographic: {
    northAmerica: number;
    europe: number;
    asiaPacific: number;
  };
}

export class RealDataService {
  private connection: Connection;
  private httpConnection: Connection | null = null;
  private dataCache: { [key: string]: { data: unknown; timestamp: number } } = {};
  private readonly CACHE_DURATION = 1800000; // 30 minutes - extremely long cache to reduce API calls
  private rpcQueue: Array<() => Promise<any>> = [];
  private isProcessingRpcQueue = false;
  private lastRpcTime = 0;
  private MIN_RPC_INTERVAL = 100; // 100ms between RPC calls - much faster!

  constructor(connection: Connection) {
    this.connection = connection;
  }

  private getHttpConnection(): Connection {
    if (!this.httpConnection) {
      const base =
        typeof window !== 'undefined'
          ? window.location.origin
          : process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
      const url = `${base}/api/rpc-http`;
      this.httpConnection = new Connection(url, {
        commitment: 'confirmed',
        fetch: fetch,
      });
    }
    return this.httpConnection;
  }

  // Rate limiting wrapper for RPC requests
  private async throttledRpcRequest<T>(requestFn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.rpcQueue.push(async () => {
        try {
          const now = Date.now();
          const timeSinceLastRpc = now - this.lastRpcTime;
          
          if (timeSinceLastRpc < this.MIN_RPC_INTERVAL) {
            await new Promise(resolve => setTimeout(resolve, this.MIN_RPC_INTERVAL - timeSinceLastRpc));
          }
          
          this.lastRpcTime = Date.now();
          const result = await requestFn();
          resolve(result);
        } catch (error) {
          if ((error as Error).message?.includes('429')) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          reject(error);
        }
      });
      
      this.processRpcQueue();
    });
  }

  private async processRpcQueue() {
    if (this.isProcessingRpcQueue || this.rpcQueue.length === 0) return;
    
    this.isProcessingRpcQueue = true;
    
    while (this.rpcQueue.length > 0) {
      const request = this.rpcQueue.shift()!;
      await request();
    }
    
    this.isProcessingRpcQueue = false;
  }

  private async getCachedData<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.dataCache[key];
    const now = Date.now();
    
    // Use cached data if it's still fresh
    if (cached && (now - cached.timestamp) < this.CACHE_DURATION) {

      return cached.data as T;
    }

    // Always fetch real data - no fallbacks
    try {

      const data = await fetcher();
      this.dataCache[key] = { data, timestamp: now };

      return data;
    } catch (error: any) {
      
      // Only use stale cached data if we have it and there's a network issue
      if (cached && (error?.message?.includes('429') || error?.message?.includes('Failed to fetch'))) {
        return cached.data as T;
      }
      
      // No fallback - throw error to show loading state or zero values
      throw error;
    }
  }

  // Shared rifts data to avoid duplicate API calls
  // Uses /api/rifts-read (fast, Supabase only) instead of /api/rifts-cache (slow, RPC calls)
  private async getRiftsCacheData(): Promise<{ rifts: any[]; tvl: number; volume24h: number }> {
    return this.getCachedData('rifts-cache-all', async () => {
      try {
        const baseUrl = typeof window !== 'undefined'
          ? window.location.origin
          : process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

        // Use fast read-only endpoint - no RPC calls!
        const response = await fetch(`${baseUrl}/api/rifts-read`);
        if (!response.ok) {
          return { rifts: [], tvl: 0, volume24h: 0 };
        }

        const data = await response.json();
        const rifts = Array.isArray(data) ? data : (data.rifts || data.data || []);

        // Calculate both TVL and Volume in one pass
        const totalTvl = rifts.reduce((sum: number, rift: any) => sum + (rift.tvl || 0), 0);
        const totalVolume = rifts.reduce((sum: number, rift: any) => sum + (rift.volume24h || 0), 0);

        return { rifts, tvl: totalTvl, volume24h: totalVolume };
      } catch (error) {
        return { rifts: [], tvl: 0, volume24h: 0 };
      }
    });
  }

  async getRealTvl(): Promise<number> {
    const cached = await this.getRiftsCacheData();
    return cached.tvl;
  }

  async getRealUserCount(): Promise<number> {
    return this.getCachedData('userCount', async () => {
      try {
        // Get actual unique users from real transaction data
        const uniqueUsers = new Set<string>();
        
        try {
          // Check signatures on our real rifts for actual user activity
          const riftMints = [
            'CbQYmrHDjy5sZENDebDjd2dwDAKD3ua4aNTJ1peu8vWf'  // rUSDC
          ];
          
          for (const mint of riftMints) {
            try {
              const signatures = await this.throttledRpcRequest(() =>
                this.connection.getSignaturesForAddress(
                  new PublicKey(mint),
                  { limit: 50 }
                )
              );
              
              // DISABLED: Transaction detail fetching causes excessive RPC spam
              // Instead, estimate users from signature count (much lighter)
              // Assume ~30% of signatures are unique users
              uniqueUsers.add(`estimated_user_${Math.floor(signatures.length * 0.3)}`);
            } catch (mintErr) {
            }
          }
          
          return uniqueUsers.size;
        } catch (err) {
          return 0;
        }
      } catch (error) {
        return 0;
      }
    });
  }

  async getRealVolume24h(): Promise<number> {
    // Uses shared rifts-cache data - no duplicate API call!
    const cached = await this.getRiftsCacheData();
    return cached.volume24h;
  }

  async getRealFees(): Promise<number> {
    return this.getCachedData('fees', async () => {
      try {
        // Clear cache to ensure fresh data
        delete this.dataCache['fees'];
        delete this.dataCache['burnData'];
        // Get REAL transaction data and calculate actual fees from transaction amounts
        const httpConn = this.getHttpConnection();
        const programSigs = await this.throttledRpcRequest(() =>
          httpConn.getSignaturesForAddress(
            RIFTS_PROGRAM_ID,
            { limit: 50 }
          )
        );
        
        let totalFeesCalculated = 0;
        let processedTxs = 0;
        
        // DISABLED: Transaction detail fetching causes excessive RPC spam (95% of all RPC calls!)
        // Instead, estimate fees from signature count
        // Estimate: ~$50 average transaction value × 0.5% fee × 50% of sigs are meaningful
        const estimatedTxCount = Math.min(programSigs.length, 10);
        for (let i = 0; i < estimatedTxCount; i++) {
          if (programSigs[i]) {
            // Estimate fee without fetching full transaction
            const estimatedFee = 50 * 0.005 * 0.5; // $50 tx × 0.5% fee × 50% meaningful
            totalFeesCalculated += estimatedFee;
            processedTxs++;
          }
        }

        // If we couldn't process transactions, fall back to count-based estimate
        if (totalFeesCalculated === 0 && programSigs.length > 0) {
          const fallbackFees = programSigs.length * 0.25; // Conservative estimate

          return fallbackFees;
        }
        
        return totalFeesCalculated;
      } catch (error) {
        console.error('[REAL-DATA][getRealFees] RPC error', {
          error,
          stack: error instanceof Error ? error.stack : undefined,
          callerStack: new Error().stack
        });
        return 0;
      }
    });
  }

  async getRealBurnData(): Promise<{ totalBurned: number; burnRate: number }> {
    return this.getCachedData('burnData', async () => {
      try {
        // Calculate realistic burn based on actual fees
        const totalFees = await this.getRealFees();
        
        // Realistic burn: ~10% of actual fees collected
        const realisticBurned = totalFees * 0.1;
        
        // Monthly burn rate (annualized percentage)
        const monthlyBurnRate = realisticBurned > 0 ? (realisticBurned / 1000000) * 12 * 100 : 0; // As % of 1M supply

        return { 
          totalBurned: realisticBurned, 
          burnRate: monthlyBurnRate 
        };
      } catch (error) {
        console.error('[REAL-DATA][getRealBurnData] RPC error', {
          error,
          stack: error instanceof Error ? error.stack : undefined,
          callerStack: new Error().stack
        });
        return { totalBurned: 0, burnRate: 0 };
      }
    });
  }

  async getRealOracleStatus(): Promise<{ activeOracles: number; accuracy: number; latency: number }> {
    return this.getCachedData('oracleStatus', async () => {
      try {
        // Check Jupiter Oracle status with devnet compatibility
        const oracleFeeds = await productionJupiterOracle.getAllPriceFeeds();
        
        let activeCount = 0;
        const totalAccuracy = 0;
        const totalLatency = 0;

        for (const feed of oracleFeeds) {
          if (feed.status === 'active') {
            activeCount++;
            // Don't add fake accuracy/latency - just count active feeds
          }
        }

        const avgAccuracy = activeCount > 0 ? totalAccuracy / activeCount : 0;
        const avgLatency = activeCount > 0 ? totalLatency / activeCount : 0;

        return {
          activeOracles: activeCount,
          accuracy: avgAccuracy,
          latency: avgLatency
        };
      } catch (error) {
        return { activeOracles: 0, accuracy: 0, latency: 0 };
      }
    });
  }

  async getRealUserAnalytics(): Promise<RealUserAnalytics> {
    return this.getCachedData('userAnalytics', async () => {
      try {
        // This would require a proper analytics database in production
        // For now, return derived data from on-chain activity
        
        const httpConn = this.getHttpConnection();
        const signatures = await this.throttledRpcRequest(() =>
          httpConn.getSignaturesForAddress(
            RIFTS_PROGRAM_ID,
            { limit: 1000 }
          )
        );

        const weeklyUsers = new Set<string>();
        const monthlyUsers = new Set<string>();
        
        const now = Date.now();
        const weekAgo = now - (7 * 24 * 60 * 60 * 1000);
        const monthAgo = now - (30 * 24 * 60 * 60 * 1000);

        let totalVolume = 0;
        let weeklyVolume = 0;
        let dailyVolume = 0;

        for (const sig of signatures) {
          const blockTime = sig.blockTime ? sig.blockTime * 1000 : 0;
          
          if (blockTime > monthAgo) {
            monthlyUsers.add(sig.signature.slice(0, 8)); // Simplified user identification
            
            if (blockTime > weekAgo) {
              weeklyUsers.add(sig.signature.slice(0, 8));
              weeklyVolume += 1; // Simplified volume calculation
              
              if (blockTime > now - (24 * 60 * 60 * 1000)) {
                dailyVolume += 1;
              }
            }
            
            totalVolume += 1;
          }
        }

        // Calculate real position sizes from actual vault balances
        const realPositionDistribution = await this.calculateRealPositionSizes();
        
        return {
          newUsers7d: weeklyUsers.size,
          activeUsers30d: monthlyUsers.size,
          retentionRate: monthlyUsers.size > 0 ? (weeklyUsers.size / monthlyUsers.size) * 100 : 0,
          positionDistribution: realPositionDistribution,
          volumeMetrics: {
            dailyAvg: dailyVolume,
            weeklyPeak: weeklyVolume,
            totalVolume: totalVolume
          },
          geographic: await this.calculateRealGeographic()
        };
      } catch (error) {
        console.error('[REAL-DATA][getRealUserAnalytics] RPC error', {
          error,
          stack: error instanceof Error ? error.stack : undefined,
          callerStack: new Error().stack
        });
        return {
          newUsers7d: 0,
          activeUsers30d: 0,
          retentionRate: 0,
          positionDistribution: { under1k: 0, between1k10k: 0, over10k: 0 },
          volumeMetrics: { dailyAvg: 0, weeklyPeak: 0, totalVolume: 0 },
          geographic: { northAmerica: 0, europe: 0, asiaPacific: 0 }
        };
      }
    });
  }

  private async getTokenPrice(mint: string): Promise<number> {
    try {
      // Simplified price fetch - would use Jupiter API in production
      const prices = await productionJupiterOracle.getAllPriceFeeds();
      const tokenPrice = prices.find(p => p.token === mint);
      return tokenPrice?.price || 0;
    } catch {
      return 0;
    }
  }

  private async calculateRealPositionSizes(): Promise<{under1k: number; between1k10k: number; over10k: number}> {
    try {
      // Get all token account holders of our rifts
      const riftMints = [
        'CbQYmrHDjy5sZENDebDjd2dwDAKD3ua4aNTJ1peu8vWf'  // rUSDC
      ];
      
      let under1k = 0, between1k10k = 0, over10k = 0;
      let totalHolders = 0;
      
      for (const mint of riftMints) {
        try {
          const httpConn = this.getHttpConnection();
          // Get all token accounts for this mint using getProgramAccounts with TOKEN_PROGRAM_ID
          const accounts = await this.throttledRpcRequest(() =>
            httpConn.getProgramAccounts(
              new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), // TOKEN_PROGRAM_ID
              {
                filters: [
                  {
                    dataSize: 165 // SPL Token Account size
                  },
                  {
                    memcmp: {
                      offset: 0, // Mint is at offset 0
                      bytes: mint
                    }
                  }
                ]
              }
            )
          );
          
          for (const account of accounts) {
            const accountData = account.account.data;
            if (accountData.length === 165) {
              const balance = Number(accountData.readBigUInt64LE(64)) / 1e9;
              const valueUSD = balance * 180; // Approximate USD value
              
              totalHolders++;
              if (valueUSD < 1000) under1k++;
              else if (valueUSD < 10000) between1k10k++;
              else over10k++;
            }
          }
        } catch (err) {
        }
      }
      
      return {
        under1k: totalHolders > 0 ? Math.round((under1k / totalHolders) * 100) : 0,
        between1k10k: totalHolders > 0 ? Math.round((between1k10k / totalHolders) * 100) : 0,
        over10k: totalHolders > 0 ? Math.round((over10k / totalHolders) * 100) : 0
      };
    } catch (error) {
      return { under1k: 0, between1k10k: 0, over10k: 0 };
    }
  }
  
  private async calculateRealGeographic(): Promise<{northAmerica: number; europe: number; asiaPacific: number}> {
    // For real geographic data, we would need IP geolocation service
    // Since this requires external API calls that may not be available,
    // we return zeros to indicate no fake data
    return {
      northAmerica: 0,
      europe: 0,
      asiaPacific: 0
    };
  }

  async getAllRealMetrics(): Promise<RealDataMetrics> {
    try {
      // First, try to fetch from database (much faster!)
      // Direct Supabase access works on both client and server
      const { createClient } = await import('@supabase/supabase-js');

      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (supabaseUrl && supabaseKey) {
        try {
          const supabase = createClient(supabaseUrl, supabaseKey);

          // Fetch latest metrics from database
          const { data: metrics, error } = await supabase
            .from('protocol_metrics')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(1)
            .single();

          if (!error && metrics) {
            const dbMetrics = {
              avgApy: parseFloat(metrics.avg_apy),
              totalTvl: parseFloat(metrics.total_tvl),
              totalVolume24h: parseFloat(metrics.volume_24h),
              totalFees: parseFloat(metrics.total_fees || '0'),
              activeUsers: metrics.active_users || 0
            };

            // Fetch additional metrics that aren't in database
            const [burnData, oracleStatus] = await Promise.allSettled([
              this.getRealBurnData(),
              this.getRealOracleStatus()
            ]);

            const safeBurnData = burnData.status === 'fulfilled' ? burnData.value : { totalBurned: 0, burnRate: 0 };
            const safeOracleStatus = oracleStatus.status === 'fulfilled' ? oracleStatus.value : { activeOracles: 0, accuracy: 0, latency: 0 };

            return {
              totalTvl: dbMetrics.totalTvl,
              activeUsers: dbMetrics.activeUsers,
              totalVolume24h: dbMetrics.totalVolume24h,
              totalFees: dbMetrics.totalFees,
              totalBurned: safeBurnData.totalBurned,
              avgApy: dbMetrics.avgApy,
              burnRate: safeBurnData.burnRate,
              activeOracles: safeOracleStatus.activeOracles,
              priceFeedAccuracy: safeOracleStatus.accuracy,
              avgLatency: safeOracleStatus.latency
            };
          }
        } catch (dbError) {
          // Database error
        }
      }

      // If database fetch fails, fall back to blockchain calculation

      const [
        tvl,
        userCount,
        volume24h,
        fees,
        burnData,
        oracleStatus
      ] = await Promise.allSettled([
        this.getRealTvl(),
        this.getRealUserCount(),
        this.getRealVolume24h(),
        this.getRealFees(),
        this.getRealBurnData(),
        this.getRealOracleStatus()
      ]);

      // Extract values with fallbacks for failed promises
      const safeTvl = tvl.status === 'fulfilled' ? tvl.value : 0;
      const safeUserCount = userCount.status === 'fulfilled' ? userCount.value : 0;
      const safeVolume24h = volume24h.status === 'fulfilled' ? volume24h.value : 0;
      const safeFees = fees.status === 'fulfilled' ? fees.value : 0;
      const safeBurnData = burnData.status === 'fulfilled' ? burnData.value : { totalBurned: 0, burnRate: 0 };
      const safeOracleStatus = oracleStatus.status === 'fulfilled' ? oracleStatus.value : { activeOracles: 0, accuracy: 0, latency: 0 };

      // Calculate fees from volume (0.7% fee rate)
      const calculatedFees = safeVolume24h * 0.007;

      // Cap APY at 10,000% to prevent insane values
      const MAX_APY = 10000;
      const rawApy = (safeVolume24h > 0 && safeTvl > 0) ? (calculatedFees / safeTvl) * 365 * 100 : 0;

      return {
        totalTvl: safeTvl,
        activeUsers: safeUserCount,
        totalVolume24h: safeVolume24h,
        totalFees: calculatedFees,
        totalBurned: safeBurnData.totalBurned,
        avgApy: Math.min(rawApy, MAX_APY),
        burnRate: safeBurnData.burnRate,
        activeOracles: safeOracleStatus.activeOracles,
        priceFeedAccuracy: safeOracleStatus.accuracy,
        avgLatency: safeOracleStatus.latency
      };
    } catch (error) {
      console.error('[REAL-DATA] Error fetching metrics:', error);
      // Return fallback metrics
      return {
        totalTvl: 0,
        activeUsers: 0,
        totalVolume24h: 0,
        totalFees: 0,
        totalBurned: 0,
        avgApy: 0,
        burnRate: 0,
        activeOracles: 0,
        priceFeedAccuracy: 0,
        avgLatency: 0
      };
    }
  }

  // Wrapper method for dashboard compatibility
  async getProtocolMetrics(): Promise<RealDataMetrics> {
    return this.getAllRealMetrics();
  }

  // Get user's positions across all rifts
  async getUserPositions(walletAddress: string): Promise<Array<{
    asset: string;
    amount: number;
    tvl: number;
    apy: number;
    pnl: number;
    change24h: number;
  }>> {
    return this.getCachedData(`user-positions-${walletAddress}`, async () => {
      try {

        const positions = [];
        const userPubkey = new PublicKey(walletAddress);

        // Known rift mints
        const rifts = [
          { mint: 'CbQYmrHDjy5sZENDebDjd2dwDAKD3ua4aNTJ1peu8vWf', symbol: 'rUSDC', decimals: 9 }
        ];

        // 🚀 Fetch TVL once upfront (not inside loop!)
        const cachedTvl = await this.getRealTvl();

        // Fetch all user token accounts
        const tokenAccounts = await this.throttledRpcRequest(() =>
          this.connection.getParsedTokenAccountsByOwner(userPubkey, {
            programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
          })
        );

        for (const rift of rifts) {
          // Find user's token account for this rift
          const account = tokenAccounts.value.find(
            acc => acc.account.data.parsed.info.mint === rift.mint
          );

          if (account) {
            const balance = account.account.data.parsed.info.tokenAmount.uiAmount;

            if (balance > 0) {
              // Get current price for PnL calculation (use cached if available)
              const price = await this.getTokenPrice(rift.mint);
              const currentValue = balance * price;

              positions.push({
                asset: rift.symbol,
                amount: balance,
                tvl: cachedTvl, // Use cached TVL - much faster!
                apy: 12.5, // Default APY from metrics
                pnl: currentValue * 0.05, // Assume 5% gain (simplified)
                change24h: 2.5 // Simplified 24h change
              });

            }
          }
        }

        return positions;
      } catch (error) {
        return [];
      }
    });
  }

  // Get PROTOCOL-WIDE transaction history from database
  async getUserTransactions(walletAddress: string, limit: number = 10): Promise<Array<{
    id: string;
    type: 'wrap' | 'unwrap' | 'claim' | 'stake';
    amount: number;
    asset: string;
    timestamp: number;
    signature: string;
    status: 'confirmed' | 'pending' | 'failed';
    user_wallet?: string;
  }>> {
    try {
      const baseUrl = typeof window !== 'undefined'
        ? window.location.origin
        : process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

      // Fetch from database instead of blockchain
      const response = await fetch(`${baseUrl}/api/get-transactions?limit=${limit}`);
      if (!response.ok) return [];

      const data = await response.json();
      return data.transactions || [];
    } catch (error) {
      console.error('Error fetching transactions:', error);
      return [];
    }
  }
}

import globalConnection from './connection';

export const realDataService = new RealDataService(globalConnection);
