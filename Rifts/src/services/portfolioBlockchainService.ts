import { Connection, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@project-serum/anchor';
import * as anchor from '@project-serum/anchor';
import { getPreferredRpcUrl } from '@/lib/solana/rpc-endpoints';

// Program IDs (from programs.txt - deployed versions)
const LP_STAKING_PROGRAM_ID = new PublicKey(process.env.LP_STAKING_PROGRAM_ID || process.env.RIFTS_PROGRAM_ID || '6FEZJKsxbDm5W4Ad4eogNehivRKKGCHJHRnKUSFbLpKt'); // ✅ DEPLOYED
const GOVERNANCE_PROGRAM_ID = new PublicKey(process.env.GOVERNANCE_PROGRAM_ID || 'EbVBCs4g7MQo7iDAtVcZhmV9FMq37JKah3iheLpqJbPo');
const FEE_COLLECTOR_PROGRAM_ID = new PublicKey(process.env.FEE_COLLECTOR_PROGRAM_ID || '4eZJyc7bPFQ7FcjBF5S5xkGJjaqHs3BaHR4oXUMa7rf9');
const RIFTS_PROGRAM_ID = new PublicKey(process.env.RIFTS_PROGRAM_ID || '6FEZJKsxbDm5W4Ad4eogNehivRKKGCHJHRnKUSFbLpKt');

// RIFTS token mint - CORRECT ACTIVE MINT
const RIFTS_MINT = new PublicKey(process.env.RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump');

interface UserStakeData {
  user: PublicKey;
  pool: PublicKey;
  amount: BN;
  stakeTime: BN;
  rewardDebt: BN;
  pendingRewards: BN;
}

interface StakingPoolData {
  authority: PublicKey;
  lpTokenMint: PublicKey;
  rewardTokenMint: PublicKey;
  rewardTokenVault: PublicKey;
  totalStaked: BN;
  rewardsPerSecond: BN;
  minStakeDuration: BN;
  lastUpdateTime: BN;
  accumulatedRewardsPerShare: BN;
  isPaused: boolean;
  riftsProtocol: PublicKey;
  totalRewardsAvailable: BN;
  lastRewardDeposit: BN;
}

interface GovernanceData {
  authority: PublicKey;
  riftsMint: PublicKey;
  totalProposals: BN;
  totalExecuted: BN;
}

interface FeeCollectorData {
  authority: PublicKey;
  totalRiftsBought: BN;
  totalRiftsDistributed: BN;
  totalRiftsBurned: BN;
  currentRiftsPrice: BN;
  lastPriceUpdate: BN;
}

interface PortfolioData {
  // RIFTS Holdings
  riftsBalance: number;
  riftsBalanceUsd: number;

  // Staking
  stakedAmount: number;
  stakedAmountUsd: number;
  pendingRewards: number;
  pendingRewardsUsd: number;
  stakingApy: number;

  // Governance
  votingPower: number;
  votingPowerPercentage: number;
  proposalsVoted: number;

  // Revenue Share
  monthlyRevenue: number;
  totalRevenue: number;
  nextDistribution: string;

  // Performance
  totalValue: number;
  pnl7d: number;
  pnl7dPercent: number;
  pnl30d: number;
  pnl30dPercent: number;
}

class PortfolioBlockchainService {
  private connection: Connection;
  private fallbackConnection: Connection;
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 30000; // 30 seconds
  private useFallback = false;

  constructor(rpcEndpoint?: string) {
    // Browser-safe primary RPC routed through our HTTP proxy to avoid CORS/gRPC issues
    const browserEndpoint = typeof window !== 'undefined'
      ? `${window.location.origin}/api/rpc-http`
      : undefined;
    const endpoint = rpcEndpoint || browserEndpoint || getPreferredRpcUrl();
    this.connection = new Connection(endpoint, 'confirmed');

    // Fallback RPC endpoints
    const fallbackEndpoint = browserEndpoint || getPreferredRpcUrl();
    this.fallbackConnection = new Connection(fallbackEndpoint, 'confirmed');
  }

  /**
   * Get connection with automatic fallback
   */
  private getConnection(): Connection {
    return this.useFallback ? this.fallbackConnection : this.connection;
  }

  /**
   * Execute RPC call with automatic fallback
   */
  private async executeWithFallback<T>(
    operation: (conn: Connection) => Promise<T>,
    operationName: string = 'RPC call'
  ): Promise<T> {
    try {
      // Try primary connection
      return await Promise.race([
        operation(this.connection),
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`${operationName} timeout`)), 10000)
        )
      ]);
    } catch (error) {

      try {
        // Try fallback connection
        this.useFallback = true;
        const result = await Promise.race([
          operation(this.fallbackConnection),
          new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`${operationName} fallback timeout`)), 10000)
          )
        ]);
        return result;
      } catch (fallbackError) {
        throw fallbackError;
      }
    }
  }

  /**
   * Get comprehensive user portfolio data from all programs
   */
  async getUserPortfolio(userPubkey: PublicKey): Promise<PortfolioData> {
    try {

      // Fetch data from all sources in parallel
      const [
        riftsBalance,
        stakeData,
        riftsPrice,
        feeCollectorData,
        governanceData
      ] = await Promise.all([
        this.getRIFTSBalance(userPubkey),
        this.getUserStakeData(userPubkey),
        this.getRIFTSPrice(),
        this.getFeeCollectorData(),
        this.getGovernanceData(userPubkey)
      ]);

      // Calculate staking APY
      const stakingApy = await this.calculateStakingAPY();

      // Calculate values
      const riftsBalanceUsd = riftsBalance * riftsPrice;
      const stakedAmountUsd = stakeData.stakedAmount * riftsPrice;
      const pendingRewardsUsd = stakeData.pendingRewards * riftsPrice;
      const totalValue = riftsBalanceUsd + stakedAmountUsd + pendingRewardsUsd;

      // Calculate voting power
      const totalSupply = await this.getRIFTSTotalSupply();
      const votingPower = riftsBalance + stakeData.stakedAmount;
      const votingPowerPercentage = totalSupply > 0 ? (votingPower / totalSupply) * 100 : 0;

      // Calculate revenue share (90% of fees go to LP stakers)
      const monthlyRevenue = this.calculateMonthlyRevenue(feeCollectorData, stakeData.stakedAmount);
      const totalRevenue = this.calculateTotalRevenue(feeCollectorData, stakeData.stakedAmount);

      // Get PnL data (from transaction history analysis)
      const pnlData = await this.calculatePnL(userPubkey, riftsPrice);

      return {
        // RIFTS Holdings
        riftsBalance,
        riftsBalanceUsd,

        // Staking
        stakedAmount: stakeData.stakedAmount,
        stakedAmountUsd,
        pendingRewards: stakeData.pendingRewards,
        pendingRewardsUsd,
        stakingApy,

        // Governance
        votingPower,
        votingPowerPercentage,
        proposalsVoted: governanceData.proposalsVoted,

        // Revenue Share
        monthlyRevenue,
        totalRevenue,
        nextDistribution: this.getNextDistributionDate(),

        // Performance
        totalValue,
        pnl7d: pnlData.pnl7d,
        pnl7dPercent: pnlData.pnl7dPercent,
        pnl30d: pnlData.pnl30d,
        pnl30dPercent: pnlData.pnl30dPercent,
      };
    } catch (error) {
      return this.getEmptyPortfolio();
    }
  }

  /**
   * Get user's RIFTS token balance
   */
  private async getRIFTSBalance(userPubkey: PublicKey): Promise<number> {
    try {
      const cacheKey = `rifts-balance-${userPubkey.toString()}`;
      const cached = this.getFromCache(cacheKey);
      if (cached) return cached;

      // Get associated token account
      const ata = await this.getAssociatedTokenAddress(RIFTS_MINT, userPubkey);
      const accountInfo = await this.connection.getAccountInfo(ata);

      if (!accountInfo) return 0;

      // Parse token account data
      const data = Buffer.from(accountInfo.data);
      const amount = new BN(data.slice(64, 72), 'le');
      // Convert safely to avoid "number can only store 53 bits" error
      const balance = parseFloat(amount.toString()) / 1e9; // Assuming 9 decimals

      this.setCache(cacheKey, balance);
      return balance;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Get user's staking data from LP staking program
   */
  private async getUserStakeData(userPubkey: PublicKey): Promise<{
    stakedAmount: number;
    pendingRewards: number;
    stakeTime: number;
  }> {
    try {
      const cacheKey = `stake-data-${userPubkey.toString()}`;
      const cached = this.getFromCache(cacheKey);
      if (cached) return cached;

      // Derive user stake account PDA
      // First, find the staking pool (we need to know the LP token mint)
      // For now, we'll search for all staking pools and find user's stakes

      const poolAddress = await this.findStakingPool();
      if (!poolAddress) {
        return { stakedAmount: 0, pendingRewards: 0, stakeTime: 0 };
      }

      const [userStakeAccount] = await PublicKey.findProgramAddress(
        [
          Buffer.from('user_stake'),
          poolAddress.toBuffer(),
          userPubkey.toBuffer()
        ],
        LP_STAKING_PROGRAM_ID
      );

      const accountInfo = await this.connection.getAccountInfo(userStakeAccount);

      if (!accountInfo) {
        return { stakedAmount: 0, pendingRewards: 0, stakeTime: 0 };
      }

      // Parse user stake account data
      const data = Buffer.from(accountInfo.data);

      // Skip discriminator (8 bytes)
      let offset = 8;

      // user: Pubkey (32 bytes)
      offset += 32;

      // pool: Pubkey (32 bytes)
      offset += 32;

      // amount: u64 (8 bytes)
      const amount = new BN(data.slice(offset, offset + 8), 'le');
      offset += 8;

      // stake_time: i64 (8 bytes)
      const stakeTime = new BN(data.slice(offset, offset + 8), 'le');
      offset += 8;

      // reward_debt: u64 (8 bytes)
      offset += 8;

      // pending_rewards: u64 (8 bytes)
      const pendingRewards = new BN(data.slice(offset, offset + 8), 'le');

      const result = {
        stakedAmount: parseFloat(amount.toString()) / 1e9,
        pendingRewards: parseFloat(pendingRewards.toString()) / 1e9,
        stakeTime: parseInt(stakeTime.toString())
      };

      this.setCache(cacheKey, result);
      return result;
    } catch (error) {
      return { stakedAmount: 0, pendingRewards: 0, stakeTime: 0 };
    }
  }

  /**
   * Find staking pool address
   */
  private async findStakingPool(): Promise<PublicKey | null> {
    try {
      // The staking pool is created with PDA: seeds = [b"staking_pool", lp_token_mint.key()]
      // We need to find it by scanning program accounts
      const accounts = await this.connection.getProgramAccounts(LP_STAKING_PROGRAM_ID, {
        filters: [
          { dataSize: 177 } // StakingPool size (8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 16 + 1 + 32 + 8 + 8)
        ]
      });

      if (accounts.length > 0) {
        return accounts[0].pubkey;
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get RIFTS token price from DEX (DexScreener)
   */
  private async getRIFTSPrice(): Promise<number> {
    try {
      const cacheKey = 'rifts-price';
      const cached = this.getFromCache(cacheKey);
      if (cached) return cached;

      // Fetch RIFTS price from DexScreener
      const RIFTS_MINT_STR = 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';
      const fallbackPrice = 0.002; // Fallback if DexScreener fails

      try {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${RIFTS_MINT_STR}`);
        if (response.ok) {
          const data = await response.json();
          const price = parseFloat(data.pairs?.[0]?.priceUsd || '0');
          if (price > 0) {
            this.setCache(cacheKey, price);
            return price;
          }
        }
      } catch (fetchError) {
        console.error('[PORTFOLIO-SERVICE] Error fetching RIFTS price from DexScreener:', fetchError);
      }

      // Fallback price if DexScreener fails
      this.setCache(cacheKey, fallbackPrice);
      return fallbackPrice;
    } catch (error) {
      return 0.002; // Ultimate fallback
    }
  }

  /**
   * Get fee collector data
   */
  private async getFeeCollectorData(): Promise<FeeCollectorData | null> {
    try {
      const cacheKey = 'fee-collector-data';
      const cached = this.getFromCache(cacheKey);
      if (cached) return cached;

      // Derive fee collector PDA
      const [feeCollectorPDA] = await PublicKey.findProgramAddress(
        [Buffer.from('fee_collector'), new PublicKey(process.env.NEXT_PUBLIC_PROTOCOL_AUTHORITY || '9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4').toBuffer()],
        FEE_COLLECTOR_PROGRAM_ID
      );

      const accountInfo = await this.connection.getAccountInfo(feeCollectorPDA);
      if (!accountInfo) return null;

      const data = Buffer.from(accountInfo.data);
      let offset = 8; // Skip discriminator

      // authority: Pubkey (32 bytes)
      const authority = new PublicKey(data.slice(offset, offset + 32));
      offset += 32;

      // total_rifts_bought: u64 (8 bytes)
      const totalRiftsBought = new BN(data.slice(offset, offset + 8), 'le');
      offset += 8;

      // total_rifts_distributed: u64 (8 bytes)
      const totalRiftsDistributed = new BN(data.slice(offset, offset + 8), 'le');
      offset += 8;

      // total_rifts_burned: u64 (8 bytes)
      const totalRiftsBurned = new BN(data.slice(offset, offset + 8), 'le');
      offset += 8;

      // current_rifts_price: u64 (8 bytes)
      const currentRiftsPrice = new BN(data.slice(offset, offset + 8), 'le');
      offset += 16; // Skip current_underlying_price

      // last_price_update: i64 (8 bytes)
      const lastPriceUpdate = new BN(data.slice(offset, offset + 8), 'le');

      const result = {
        authority,
        totalRiftsBought,
        totalRiftsDistributed,
        totalRiftsBurned,
        currentRiftsPrice,
        lastPriceUpdate
      };

      this.setCache(cacheKey, result);
      return result;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get governance data for user
   */
  private async getGovernanceData(userPubkey: PublicKey): Promise<{
    proposalsVoted: number;
  }> {
    try {
      // Search for vote records by user
      const voteRecords = await this.connection.getProgramAccounts(GOVERNANCE_PROGRAM_ID, {
        filters: [
          { dataSize: 89 }, // VoteRecord size
          {
            memcmp: {
              offset: 8, // After discriminator
              bytes: userPubkey.toBase58()
            }
          }
        ]
      });

      return {
        proposalsVoted: voteRecords.length
      };
    } catch (error) {
      return { proposalsVoted: 0 };
    }
  }

  /**
   * Calculate staking APY
   */
  private async calculateStakingAPY(): Promise<number> {
    try {
      const poolAddress = await this.findStakingPool();
      if (!poolAddress) return 0;

      const accountInfo = await this.connection.getAccountInfo(poolAddress);
      if (!accountInfo) return 0;

      const data = Buffer.from(accountInfo.data);
      let offset = 8 + 32 + 32 + 32 + 32; // Skip to total_staked

      const totalStaked = new BN(data.slice(offset, offset + 8), 'le');
      offset += 8;

      const rewardsPerSecond = new BN(data.slice(offset, offset + 8), 'le');

      const totalStakedNum = parseFloat(totalStaked.toString());
      if (totalStakedNum === 0) return 0;

      // APY = (rewards per year / total staked) * 100
      const rewardsPerYear = parseFloat(rewardsPerSecond.toString()) * 365 * 24 * 60 * 60;
      const apy = (rewardsPerYear / totalStakedNum) * 100;

      return apy;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Calculate monthly revenue from fee distribution
   */
  private calculateMonthlyRevenue(feeData: FeeCollectorData | null, stakedAmount: number): number {
    if (!feeData || stakedAmount === 0) return 0;

    try {
      // 90% of fees go to LP stakers
      const totalDistributed = parseFloat(feeData.totalRiftsDistributed.toString()) / 1e9;

      // Estimate monthly distribution based on total distributed
      // This is a rough estimate - actual would need historical data
      const monthlyEstimate = totalDistributed * 0.1; // Very rough estimate

      return monthlyEstimate;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Calculate total revenue earned
   */
  private calculateTotalRevenue(feeData: FeeCollectorData | null, stakedAmount: number): number {
    if (!feeData || stakedAmount === 0) return 0;

    try {
      // User's share of total distributed = (user stake / total stake) * total distributed
      // This is approximate without access to pool total staked
      return 0; // Placeholder
    } catch (error) {
      return 0;
    }
  }

  /**
   * Get next distribution date
   */
  private getNextDistributionDate(): string {
    // Distributions happen when fees are swapped and deposited
    // Return "TBA" for now as it's event-driven
    return 'TBA';
  }

  /**
   * Fetch user transactions for a specific time period
   * 🚫 DISABLED: This causes 2000+ getTransaction calls which kills server performance
   */
  private async getUserTransactions(userPubkey: PublicKey, daysBack: number): Promise<any[]> {
    console.log('[PORTFOLIO] ⚠️ getUserTransactions DISABLED to prevent RPC spam');
    return []; // Return empty array instead of fetching thousands of transactions

    /* DISABLED CODE:
    try {
      const signatures = await this.connection.getSignaturesForAddress(userPubkey, {
        limit: 1000 // Maximum allowed by Solana RPC
      });

      const cutoffTime = Date.now() / 1000 - (daysBack * 24 * 60 * 60);

      // Filter signatures by time
      const recentSignatures = signatures.filter(sig =>
        sig.blockTime && sig.blockTime >= cutoffTime
      );

      // Fetch transaction details in batches to avoid rate limits
      const transactions = [];
      const batchSize = 10;

      for (let i = 0; i < recentSignatures.length; i += batchSize) {
        const batch = recentSignatures.slice(i, i + batchSize);
        const txs = await Promise.all(
          batch.map(sig =>
            this.connection.getTransaction(sig.signature, {
              maxSupportedTransactionVersion: 0
            }).catch(() => null)
          )
        );
        transactions.push(...txs.filter(tx => tx !== null));
      }

      return transactions;
    } catch (error) {
      return [];
    }
    */
  }

  /**
   * Parse transaction to extract RIFTS-related activity
   */
  private parseRIFTSTransaction(tx: any): {
    type: 'wrap' | 'unwrap' | 'stake' | 'unstake' | 'claim' | 'unknown';
    riftsAmount: number;
    underlyingAmount: number;
    timestamp: number;
  } | null {
    try {
      if (!tx || !tx.meta || !tx.blockTime) return null;

      // Get pre and post token balances
      const preBalances = tx.meta.preTokenBalances || [];
      const postBalances = tx.meta.postTokenBalances || [];

      // Find RIFTS token balance changes
      let riftsChange = 0;
      let underlyingChange = 0;

      for (const postBalance of postBalances) {
        if (!postBalance.mint) continue;

        const preBalance = preBalances.find((pb: any) =>
          pb.accountIndex === postBalance.accountIndex
        );

        const preAmount = preBalance?.uiTokenAmount?.uiAmount || 0;
        const postAmount = postBalance.uiTokenAmount?.uiAmount || 0;
        const change = postAmount - preAmount;

        // Check if this is RIFTS token
        if (postBalance.mint === RIFTS_MINT.toString()) {
          riftsChange = change;
        } else {
          // Assume other token is underlying (SOL wrapped token or other)
          underlyingChange = Math.abs(change);
        }
      }

      // Determine transaction type based on balance changes
      let type: 'wrap' | 'unwrap' | 'stake' | 'unstake' | 'claim' | 'unknown' = 'unknown';

      if (riftsChange > 0 && underlyingChange > 0) {
        type = 'wrap'; // User wrapped underlying → got RIFTS
      } else if (riftsChange < 0 && underlyingChange > 0) {
        type = 'unwrap'; // User unwrapped RIFTS → got underlying
      } else if (riftsChange < 0) {
        type = 'stake'; // User staked RIFTS
      } else if (riftsChange > 0) {
        type = 'claim'; // User claimed rewards or unstaked
      }

      return {
        type,
        riftsAmount: Math.abs(riftsChange),
        underlyingAmount: underlyingChange,
        timestamp: tx.blockTime
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Calculate cost basis from transaction history
   */
  private calculateCostBasis(transactions: any[], currentPrice: number): {
    totalCost: number;
    totalRIFTSAcquired: number;
    avgCost: number;
  } {
    let totalCost = 0;
    let totalRIFTSAcquired = 0;

    for (const tx of transactions) {
      const parsed = this.parseRIFTSTransaction(tx);
      if (!parsed) continue;

      // Only count wraps and claims as acquisitions
      if (parsed.type === 'wrap') {
        // Cost = underlying amount (in SOL/USD)
        totalCost += parsed.underlyingAmount;
        totalRIFTSAcquired += parsed.riftsAmount;
      } else if (parsed.type === 'claim') {
        // Rewards have zero cost basis (free)
        totalRIFTSAcquired += parsed.riftsAmount;
      }
    }

    const avgCost = totalRIFTSAcquired > 0 ? totalCost / totalRIFTSAcquired : 0;

    return {
      totalCost,
      totalRIFTSAcquired,
      avgCost
    };
  }

  /**
   * Calculate PnL for 7-day and 30-day periods
   */
  private async calculatePnL(userPubkey: PublicKey, currentPrice: number): Promise<{
    pnl7d: number;
    pnl7dPercent: number;
    pnl30d: number;
    pnl30dPercent: number;
  }> {
    try {
      // Fetch transactions for both periods
      const [transactions7d, transactions30d] = await Promise.all([
        this.getUserTransactions(userPubkey, 7),
        this.getUserTransactions(userPubkey, 30)
      ]);

      // Get current holdings
      const [riftsBalance, stakeData] = await Promise.all([
        this.getRIFTSBalance(userPubkey),
        this.getUserStakeData(userPubkey)
      ]);

      const totalHoldings = riftsBalance + stakeData.stakedAmount + stakeData.pendingRewards;
      const currentValue = totalHoldings * currentPrice;

      // Calculate 7-day PnL
      const costBasis7d = this.calculateCostBasis(transactions7d, currentPrice);
      const pnl7d = currentValue - costBasis7d.totalCost;
      const pnl7dPercent = costBasis7d.totalCost > 0
        ? (pnl7d / costBasis7d.totalCost) * 100
        : 0;

      // Calculate 30-day PnL
      const costBasis30d = this.calculateCostBasis(transactions30d, currentPrice);
      const pnl30d = currentValue - costBasis30d.totalCost;
      const pnl30dPercent = costBasis30d.totalCost > 0
        ? (pnl30d / costBasis30d.totalCost) * 100
        : 0;

      return {
        pnl7d,
        pnl7dPercent,
        pnl30d,
        pnl30dPercent
      };
    } catch (error) {
      return {
        pnl7d: 0,
        pnl7dPercent: 0,
        pnl30d: 0,
        pnl30dPercent: 0
      };
    }
  }

  /**
   * Get RIFTS total supply with retry and fallback logic
   */
  private async getRIFTSTotalSupply(): Promise<number> {
    try {
      const cacheKey = 'rifts-total-supply';
      const cached = this.getFromCache(cacheKey);
      if (cached) return cached;

      // Use fallback RPC method
      const mintInfo = await this.executeWithFallback(
        (conn) => conn.getAccountInfo(RIFTS_MINT),
        'getRIFTSTotalSupply'
      ).catch(() => null);

      if (!mintInfo) {
        const estimatedSupply = 1000000000; // 1B estimated
        this.setCache(cacheKey, estimatedSupply);
        return estimatedSupply;
      }

      const data = Buffer.from(mintInfo.data);
      const supply = new BN(data.slice(36, 44), 'le');

      // Convert BN to number safely
      const supplyStr = supply.toString();
      const totalSupply = parseInt(supplyStr) / 1e9;

      this.setCache(cacheKey, totalSupply);
      return totalSupply;

    } catch (error) {
      const fallbackSupply = 1000000000; // 1B default
      return fallbackSupply;
    }
  }

  /**
   * Get associated token address
   */
  private async getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
    const [address] = await PublicKey.findProgramAddress(
      [
        owner.toBuffer(),
        new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(),
        mint.toBuffer(),
      ],
      new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
    );
    return address;
  }

  /**
   * Cache helpers
   */
  private getFromCache(key: string): any {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }
    return null;
  }

  private setCache(key: string, data: any): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Get empty portfolio (fallback)
   */
  private getEmptyPortfolio(): PortfolioData {
    return {
      riftsBalance: 0,
      riftsBalanceUsd: 0,
      stakedAmount: 0,
      stakedAmountUsd: 0,
      pendingRewards: 0,
      pendingRewardsUsd: 0,
      stakingApy: 0,
      votingPower: 0,
      votingPowerPercentage: 0,
      proposalsVoted: 0,
      monthlyRevenue: 0,
      totalRevenue: 0,
      nextDistribution: 'TBA',
      totalValue: 0,
      pnl7d: 0,
      pnl7dPercent: 0,
      pnl30d: 0,
      pnl30dPercent: 0,
    };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}

export const portfolioBlockchainService = new PortfolioBlockchainService();
export type { PortfolioData };
