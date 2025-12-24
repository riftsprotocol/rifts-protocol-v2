// lib/solana/integration-utils.ts - Updated to use your existing types

import { Connection, PublicKey } from '@solana/web3.js';
import { ProductionRiftsTokenManager } from './rifts-token-manager';
import { Rift, UserPosition } from '@/types'; // Using your existing types

// Service integration helper
export class ServiceIntegrator {
  private connection: Connection;
  private tokenManager: ProductionRiftsTokenManager | null = null;

  constructor(connection: Connection) {
    this.connection = connection;
    this.initializeServices();
  }

  private async initializeServices() {
    try {
      // Initialize your comprehensive token manager
      this.tokenManager = new ProductionRiftsTokenManager(this.connection);
      // console.log('✅ Services integrated successfully');
    } catch (error) {
    }
  }

  // Get your token manager instance
  getTokenManager(): ProductionRiftsTokenManager | null {
    return this.tokenManager;
  }

  // Helper to validate all services are ready
  async validateServices(): Promise<{
    tokenManager: boolean;
    connection: boolean;
    overall: boolean;
  }> {
    try {
      const tokenManagerReady = this.tokenManager !== null;
      const connectionReady = await this.testConnection();
      
      return {
        tokenManager: tokenManagerReady,
        connection: connectionReady,
        overall: tokenManagerReady && connectionReady
      };
    } catch (error) {
      return {
        tokenManager: false,
        connection: false,
        overall: false
      };
    }
  }

  private async testConnection(): Promise<boolean> {
    try {
      await this.connection.getVersion();
      return true;
    } catch (error) {
      return false;
    }
  }

  // Helper to get RIFTS token stats using your implementation
  async getRiftsStats() {
    if (!this.tokenManager) {
      throw new Error('Token manager not initialized');
    }
    
    return await this.tokenManager.getRiftsTokenStats();
  }

  // Helper to process LP staking using your implementation
  async stakeLPTokens(params: {
    user: PublicKey;
    lpTokenMint: PublicKey;
    amount: number;
    payer: any; // Your Keypair type
  }) {
    if (!this.tokenManager) {
      throw new Error('Token manager not initialized');
    }
    
    return await this.tokenManager.stakeLPTokens(params);
  }

  // Helper to claim rewards using your implementation
  async claimRewards(params: {
    user: PublicKey;
    payer: any; // Your Keypair type
  }) {
    if (!this.tokenManager) {
      throw new Error('Token manager not initialized');
    }
    
    return await this.tokenManager.claimRiftsRewards(params);
  }
}

// Export singleton integrator
export const serviceIntegrator = new ServiceIntegrator(
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

// Utility functions to work with your existing code
export const riftsTokenUtils = {
  // Convert your FeeDistribution to a standard format
  formatFeeDistribution: (distribution: any) => {
    return {
      burn: `${distribution.burnAmount} SOL`,
      partner: `${distribution.partnerAmount} SOL`,
      treasury: `${distribution.treasuryAmount} SOL`,
      riftsOps: `${distribution.riftsTokenBuyAmount} SOL`
    };
  },

  // Format LP staking position for display using your types
  formatStakingPosition: (position: UserPosition) => {
    return {
      staked: `${position.lpStaked} LP`,
      rewards: `${position.rewards} RIFTS`,
      value: `$${position.totalValue.toFixed(2)}`,
      pnl: position.pnl > 0 ? `+${position.pnl.toFixed(2)}%` : `${position.pnl.toFixed(2)}%`
    };
  },

  // Calculate APY display using your Rift type
  calculateDisplayAPY: (rift: Rift, hasBonus: boolean = false) => {
    const finalAPY = hasBonus ? rift.apy * 1.5 : rift.apy;
    return `${finalAPY.toFixed(1)}%`;
  },

  // Format rift metrics using your types
  formatRiftMetrics: (rift: Rift) => {
    return {
      tvl: `$${rift.tvl.toLocaleString()}`,
      apy: `${rift.apy.toFixed(1)}%`,
      backingRatio: `${rift.backingRatio.toFixed(4)}x`,
      volume24h: `$${rift.volume24h.toLocaleString()}`,
      risk: rift.risk,
      participants: rift.participants.toLocaleString()
    };
  }
};

// Health check utilities
export const healthCheck = {
  async checkTokenManager(manager: ProductionRiftsTokenManager): Promise<boolean> {
    try {
      // Test basic functionality
      const stats = await manager.getRiftsTokenStats();
      return stats.totalSupply > 0;
    } catch (error) {
      return false;
    }
  },

  async checkRiftsToken(manager: ProductionRiftsTokenManager): Promise<{
    deployed: boolean;
    supply: number;
    price: number;
  }> {
    try {
      const stats = await manager.getRiftsTokenStats();
      return {
        deployed: stats.totalSupply > 0,
        supply: stats.totalSupply,
        price: stats.currentPrice
      };
    } catch (error) {
      return {
        deployed: false,
        supply: 0,
        price: 0
      };
    }
  },

  // Check rift health using your Rift type
  async checkRiftHealth(rift: Rift): Promise<{
    healthy: boolean;
    issues: string[];
    metrics: {
      backingRatioOk: boolean;
      volumeOk: boolean;
      capacityOk: boolean;
    };
  }> {
    const issues: string[] = [];
    const metrics = {
      backingRatioOk: rift.backingRatio >= 0.98,
      volumeOk: rift.volume24h > 1000,
      capacityOk: rift.tvl < rift.maxCapacity * 0.9
    };

    if (!metrics.backingRatioOk) issues.push('Low backing ratio');
    if (!metrics.volumeOk) issues.push('Low volume');
    if (!metrics.capacityOk) issues.push('Near capacity limit');
    if (!rift.isActive) issues.push('Rift is inactive');

    return {
      healthy: issues.length === 0,
      issues,
      metrics
    };
  }
};

// Conversion utilities between your types and production data
export const typeConverters = {
  // Convert production rift data to your Rift type
  toRiftType: (productionRift: any): Rift => {
    return {
      id: productionRift.id,
      symbol: productionRift.symbol,
      underlying: productionRift.underlying,
      tvl: productionRift.tvl,
      backingRatio: productionRift.realBackingRatio,
      volume24h: productionRift.volume24h,
      burnFee: productionRift.burnFee,
      partnerFee: productionRift.partnerFee,
      apy: productionRift.apy,
      nextRebalance: productionRift.nextRebalance,
      volumeProgress: productionRift.volumeTriggerActive ? 1 : 0,
      strategy: productionRift.strategy,
      risk: productionRift.risk,
      maxCapacity: productionRift.tvl * 2, // Estimate
      isActive: productionRift.realVaultBalance > 0,
      performance: productionRift.performance || [],
      participants: 100 // Would track real participants
    };
  },

  // Convert wallet position data to your UserPosition type
  toUserPositionType: (positionData: any, riftId: string): UserPosition => {
    return {
      riftId,
      wrapped: positionData.amount || 0,
      lpStaked: 0, // Would get from LP staking data
      rewards: positionData.rewards || 0,
      totalValue: positionData.value || 0,
      pnl: 0 // Would calculate from historical data
    };
  }
};
