// lib/solana/hybrid-oracle-manager.ts - Fixed Hybrid Oracle Manager
import { Connection, PublicKey } from '@solana/web3.js';
import { productionJupiterOracle } from './jupiter-oracle';
import { ProductionRiftsService } from './rifts-service';

export interface OraclePrice {
  price: number;
  confidence: number;
  timestamp: number;
  source: string;
}

export interface RebalanceSignal {
  shouldRebalance: boolean;
  priceDeviation: number;
  volumeTrigger: boolean;
  arbitrageOpportunity: number;
  confidence: number;
}

export class HybridOracleManager {
  private connection: Connection;
  private riftsService: ProductionRiftsService;
  private priceCache: Map<string, OraclePrice> = new Map();
  private rebalanceThreshold = 0.02; // 2% deviation triggers rebalance
  private volumeThreshold = 0.07; // 7% volume spike triggers rebalance

  constructor(connection: Connection) {
    this.connection = connection;
    this.riftsService = new ProductionRiftsService(connection);
  }

  // Get aggregated price from multiple oracle sources
  async getAggregatedPrice(tokenMint: string): Promise<OraclePrice> {
    const cacheKey = `price_${tokenMint}`;
    const cached = this.priceCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < 30000) { // 30 second cache
      return cached;
    }

    try {
      // Get price from Jupiter oracle
      const jupiterPrice = await productionJupiterOracle.getJupiterPrice(tokenMint);
      
      // In production, you'd aggregate multiple oracle sources here
      const aggregatedPrice: OraclePrice = {
        price: jupiterPrice.price,
        confidence: jupiterPrice.confidence,
        timestamp: Date.now(),
        source: 'Jupiter_Aggregated'
      };

      this.priceCache.set(cacheKey, aggregatedPrice);
      return aggregatedPrice;
    } catch (error) {
      console.error('Error getting aggregated price:', error);
      
      // Return fallback price
      return {
        price: 1.0,
        confidence: 0.1,
        timestamp: Date.now(),
        source: 'Fallback'
      };
    }
  }

  // Analyze if rift needs rebalancing
  async analyzeRebalanceNeed(params: {
    riftId: string;
    underlyingMint: string;
    riftMint: string;
  }): Promise<RebalanceSignal> {
    try {
      const { riftId, underlyingMint, riftMint } = params;

      // Get current prices
      const underlyingPrice = await this.getAggregatedPrice(underlyingMint);
      const riftPrice = await this.getAggregatedPrice(riftMint);

      // Get arbitrage data
      const arbitrageData = await productionJupiterOracle.detectArbitrage({
        underlyingMint,
        riftMint
      });

      // Calculate price deviation
      const expectedRiftPrice = underlyingPrice.price;
      const actualRiftPrice = riftPrice.price;
      const priceDeviation = Math.abs(expectedRiftPrice - actualRiftPrice) / expectedRiftPrice;

      // Check volume trigger
      const volumeTrigger = arbitrageData.volumeTrigger;

      // Determine if rebalance is needed
      const shouldRebalance = 
        priceDeviation > this.rebalanceThreshold || 
        volumeTrigger ||
        Math.abs(arbitrageData.arbitrageOpportunity) > 2.0; // 2% arbitrage opportunity

      // Calculate confidence based on price sources
      const confidence = Math.min(underlyingPrice.confidence, riftPrice.confidence);

      return {
        shouldRebalance,
        priceDeviation,
        volumeTrigger: volumeTrigger || false,
        arbitrageOpportunity: arbitrageData.arbitrageOpportunity,
        confidence
      };
    } catch (error) {
      console.error('Error analyzing rebalance need:', error);
      
      return {
        shouldRebalance: false,
        priceDeviation: 0,
        volumeTrigger: false,
        arbitrageOpportunity: 0,
        confidence: 0
      };
    }
  }

  // Execute oracle-driven rebalance (fetches live price from Jupiter automatically)
  async executeOracleRebalance(params: {
    riftId: string;
    underlyingMint: string;
  }): Promise<{
    success: boolean;
    signature?: string;
    error?: string;
  }> {
    try {
      const { riftId, underlyingMint } = params;

      // Update oracle price first (fetches live price from Jupiter)
      const updateResult = await this.riftsService.updateOraclePrice({
        riftPubkey: new PublicKey(riftId),
        underlyingMint
      });

      if (!updateResult.success) {
        throw new Error(`Oracle update failed: ${updateResult.error}`);
      }

      // Trigger rebalance
      const rebalanceResult = await this.riftsService.triggerRebalance(
        new PublicKey(riftId)
      );

      if (rebalanceResult.success) {
        return {
          success: true,
          signature: rebalanceResult.signature
        };
      } else {
        throw new Error(`Rebalance failed: ${rebalanceResult.error}`);
      }
    } catch (error) {
      console.error('❌ Oracle rebalance failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Oracle rebalance failed'
      };
    }
  }

  // Monitor all rifts for rebalancing opportunities
  async monitorAllRifts(): Promise<void> {
    try {
      
      const allRifts = await this.riftsService.getAllRifts();
      
      for (const rift of allRifts) {
        const signal = await this.analyzeRebalanceNeed({
          riftId: rift.id,
          underlyingMint: rift.underlyingMint,
          riftMint: rift.riftMint
        });

        if (signal.shouldRebalance && signal.confidence > 0.8) {

          // Execute oracle rebalance (fetches live price from Jupiter automatically)
          await this.executeOracleRebalance({
            riftId: rift.id,
            underlyingMint: rift.underlyingMint
          });
        }
      }
    } catch (error) {
      console.error('Error monitoring rifts:', error);
    }
  }

  // Start automated monitoring
  startAutomatedMonitoring(intervalMs: number = 60000): () => void {
    
    const interval = setInterval(() => {
      this.monitorAllRifts().catch(error => {
        console.error('Automated monitoring error:', error);
      });
    }, intervalMs);

    // Return cleanup function
    return () => {
      clearInterval(interval);
    };
  }

  // Get oracle health status
  async getOracleHealth(): Promise<{
    healthy: boolean;
    jupiterOracle: boolean;
    priceCache: number;
    lastUpdate: number;
  }> {
    try {
      // Test Jupiter oracle
      const testPrice = await productionJupiterOracle.getJupiterPrice(
        'So11111111111111111111111111111111111111112' // SOL
      );
      
      const jupiterHealthy = testPrice.price > 0 && testPrice.confidence > 0.5;
      
      return {
        healthy: jupiterHealthy && this.priceCache.size >= 0,
        jupiterOracle: jupiterHealthy,
        priceCache: this.priceCache.size,
        lastUpdate: Date.now()
      };
    } catch (error) {
      console.error('Oracle health check failed:', error);
      return {
        healthy: false,
        jupiterOracle: false,
        priceCache: 0,
        lastUpdate: 0
      };
    }
  }

  // Update oracle configuration
  updateConfiguration(config: {
    rebalanceThreshold?: number;
    volumeThreshold?: number;
  }) {
    if (config.rebalanceThreshold) {
      this.rebalanceThreshold = config.rebalanceThreshold;
    }
    if (config.volumeThreshold) {
      this.volumeThreshold = config.volumeThreshold;
    }
    

  }

  // Clear price cache
  clearCache() {
    this.priceCache.clear();
  }

  // Get cache stats
  getCacheStats() {
    return {
      size: this.priceCache.size,
      entries: Array.from(this.priceCache.entries()).map(([key, value]) => ({
        key,
        price: value.price,
        age: Date.now() - value.timestamp,
        source: value.source
      }))
    };
  }
}

// Export singleton instance
export const hybridOracleManager = new HybridOracleManager(
  typeof window !== 'undefined'
    ? (() => {
        const { ProxiedConnection } = require('./rpc-client');
        return new ProxiedConnection();
      })()
    : new Connection(
        require('./rpc-endpoints').getHeliusHttpRpcUrl(),
        {
          commitment: 'confirmed',
          wsEndpoint: undefined,
          disableRetryOnRateLimit: true,
        }
      )
);
