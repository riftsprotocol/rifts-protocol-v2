// lib/solana/rifts-service.ts - Thin wrapper delegating to modular functions
// This file provides backward compatibility while all logic lives in ./rifts/*.ts modules
import { Connection, PublicKey, Transaction, TransactionInstruction, Keypair } from '@solana/web3.js';
import { ProductionRiftsTokenManager } from './rifts-token-manager';

// Re-export types and constants for backward compatibility
export {
  RIFTS_PROGRAM_ID,
  RIFTS_PROGRAM_ID_OLD,
  RIFTS_V1_PROGRAM_ID,
  METEORA_DAMM_V2_PROGRAM_ID,
  WSOL_MINT,
  V1_RIFTS,
  BLACKLISTED_RIFTS,
  getProgramIdForRift,
  getProgramVersionForRift,
} from './rifts/types';

export type {
  WalletAdapter,
  DecodedRiftData,
  ProductionRiftData,
  ServiceContext,
} from './rifts/types';

// Import types locally
import {
  ServiceContext,
  WalletAdapter,
  ProductionRiftData,
  DecodedRiftData,
  RIFTS_PROGRAM_ID,
  CACHE_DURATION_MS,
  MIN_RPC_INTERVAL,
  MINT_CACHE_TTL,
} from './rifts/types';

// Import all modular functions
import {
  decodeRiftAccount,
  decodeMinimalRiftAccount,
  calculateRiskLevel,
  getOracleStatus,
  calculateOracleCountdown,
  generateMockPerformance,
  calculateRealArbitrageOpportunity,
  getPositionNftFromLocalStorage,
  savePositionNftToLocalStorage,
  getMintSymbol,
  getCachedMintDecimals,
  filterBlacklistedRifts,
  isV1Rift,
} from './rifts/utils';

import {
  getAllRifts,
  getAllRiftsCacheBusted,
  enrichRiftsWithMeteoraData,
  getRiftData as getRiftDataFn,
  updateRiftInCache as updateRiftInCacheFn,
  addRiftToCache as addRiftToCacheFn,
  clearCache as clearCacheFn,
  clearRiftCache as clearRiftCacheFn,
  clearAllRiftCaches as clearAllRiftCachesFn,
  trackVolume as trackVolumeFn,
  getTrackedVolume,
  trackParticipant as trackParticipantFn,
  getParticipantCount,
  getVolumeHistory as getVolumeHistoryFn,
  onVolumeUpdate as onVolumeUpdateFn,
  offVolumeUpdate as offVolumeUpdateFn,
  prefetchRiftDataInBackground,
  getActualVaultBalance,
  getTokenPrice,
  getTokenSymbol,
  getTotalTVL as getTotalTVLFn,
  getTotal24hVolume as getTotal24hVolumeFn,
  getUniqueUserCount as getUniqueUserCountFn,
  getPerformanceHistory,
  saveRiftsToSupabase,
} from './rifts/data';

import {
  wrapTokens as wrapTokensFn,
  basicWrapTokens as basicWrapTokensFn,
  prefetchWrapData as prefetchWrapDataFn,
  WrapTokensParams,
  WrapTokensResult,
} from './rifts/wrap';

import {
  unwrapTokens as unwrapTokensFn,
  unwrapFromVault as unwrapFromVaultFn,
  UnwrapTokensParams,
  UnwrapTokensResult,
} from './rifts/unwrap';

import {
  createRiftWithVanityPDA as createRiftWithVanityPDAFn,
  createRiftAndWrapInstructions as createRiftAndWrapInstructionsFn,
  generateVanityAddressPool,
  getVanityAddressFromPool,
  getVanityPoolStatus,
  CreateRiftWithVanityPDAParams,
  CreateRiftResult,
  CreateRiftAndWrapParams,
  CreateRiftAndWrapResult,
} from './rifts/create';

// Fees module functions call other modules directly - no helpers needed
import {
  createPartnerTokenAccount as createPartnerTokenAccountFn,
  distributeFeesFromVault as distributeFeesFromVaultFn,
  claimDexFees as claimDexFeesFn,
  claimRiftFees as claimRiftFeesFn,
  getVaultFeesAvailable as getVaultFeesAvailableFn,
  getWithheldVaultFeesAvailable as getWithheldVaultFeesAvailableFn,
  DistributeFeesParams,
  DistributeFeesResult,
  VaultFeesResult,
} from './rifts/fees';

// Meteora module functions call other modules directly - no helpers needed
import {
  createMeteoraPool as createMeteoraPoolFn,
  removeMeteoraLiquidity as removeMeteoraLiquidityFn,
  findMeteoraPool as findMeteoraPoolFn,
  getMeteoraPoolPrice as getMeteoraPoolPriceFn,
  getMeteoraSwapQuote as getMeteoraSwapQuoteFn,
  executeMeteoraSwap as executeMeteoraSwapFn,
  CreatePoolParams,
  CreatePoolResult,
  RemoveLiquidityParams,
  RemoveLiquidityResult,
  SwapParams,
  SwapQuoteParams,
  SwapQuoteResult,
} from './rifts/meteora';

import {
  initializeVault as initializeVaultFn,
  forceCloseAccount as forceCloseAccountFn,
  cleanupStuckAccounts as cleanupStuckAccountsFn,
  closeRift as closeRiftFn,
  adminCloseRift as adminCloseRiftFn,
  checkProgramStatus as checkProgramStatusFn,
  getTokenBalance as getTokenBalanceFn,
  InitializeVaultParams,
  InitializeVaultResult,
  ForceCloseResult,
  CloseRiftParams,
  AdminCloseRiftParams,
  ProgramStatusResult,
} from './rifts/admin';

import {
  updateOraclePrice as updateOraclePriceFn,
  triggerRebalance as triggerRebalanceFn,
  OracleUpdateParams,
  OracleUpdateResult,
  RebalanceResult,
} from './rifts/oracle';

import {
  executeDirectJupiterSwap as executeDirectJupiterSwapFn,
  executeJupiterSwap as executeJupiterSwapFn,
  DirectJupiterSwapParams,
  JupiterSwapParams,
} from './rifts/jupiter';

// ============ PRODUCTION RIFTS SERVICE CLASS ============
export class ProductionRiftsService {
  private ctx: ServiceContext;
  private riftsTokenManager: ProductionRiftsTokenManager;

  constructor(connection: Connection) {
    // Initialize service context
    this.ctx = {
      connection,
      wallet: null,
      volumeCallbacks: [],
      volumeTracker: {},
      participantTracker: {},
      mintInfoCache: {},
      riftsCache: [],
      lastCacheUpdate: 0,
      isLoadingRifts: false,
      isWrapInProgress: false,
      isProcessingQueue: false,
      lastRpcCall: 0,
      rpcCallQueue: [],
      priceUpdateInterval: null,
    };
    this.riftsTokenManager = new ProductionRiftsTokenManager(connection);
  }

  // ============ WALLET MANAGEMENT ============
  setWallet(wallet: WalletAdapter) {
    this.ctx.wallet = wallet;
  }

  stopUpdates() {
    if (this.ctx.priceUpdateInterval) {
      clearInterval(this.ctx.priceUpdateInterval);
      this.ctx.priceUpdateInterval = null;
    }
  }

  destroy() {
    this.stopUpdates();
  }

  // ============ HELPER: CONFIRM TRANSACTION ============
  private async confirmTransactionSafely(signature: string, skipWait: boolean = false): Promise<boolean> {
    try {
      if (skipWait) return true;

      const startTime = Date.now();
      const timeout = 60000;

      while (Date.now() - startTime < timeout) {
        let status: any = null;
        const conn: any = this.ctx.connection as any;

        if (typeof conn.getSignatureStatuses === 'function') {
          const result = await conn.getSignatureStatuses([signature]);
          status = result?.value?.[0];
        } else if (typeof conn.getSignatureStatus === 'function') {
          status = await conn.getSignatureStatus(signature);
          status = status?.value || status;
        }

        // Success
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
          if (status.err) {
            console.error('\n Transaction failed:', status.err);
            console.error('🔍 [DEBUG] Full error object:', JSON.stringify(status.err, null, 2));
            // Try to get transaction logs
            try {
              const txDetails = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
              if (txDetails?.meta?.logMessages) {
                console.error('🔍 [DEBUG] Transaction logs:', txDetails.meta.logMessages.join('\n'));
              }
            } catch (e) {
              console.error('🔍 [DEBUG] Could not fetch logs:', e);
            }
            return false;
          }
          return true;
        }

        // Explicit error
        if (status?.err) {
          console.error('\n Transaction failed:', status.err);
          console.error('🔍 [DEBUG] Full error object:', JSON.stringify(status.err, null, 2));
          return false;
        }

        // Keep polling
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      console.warn('Transaction confirmation timeout');
      return false;
    } catch (error) {
      console.error('Confirmation error:', error);
      return false;
    }
  }

  // ============ DATA FUNCTIONS ============
  async getAllRifts(forceRefresh: boolean = false): Promise<ProductionRiftData[]> {
    return getAllRifts(this.ctx, forceRefresh);
  }

  async getAllRiftsCacheBusted(): Promise<ProductionRiftData[]> {
    return getAllRiftsCacheBusted(this.ctx);
  }

  async getRiftData(riftPubkey: PublicKey): Promise<ProductionRiftData | null> {
    const decoded = await getRiftDataFn(this.ctx, riftPubkey);
    if (!decoded) return null;
    // Convert DecodedRiftData to ProductionRiftData for backward compat
    return this.decodedToProduction(decoded, riftPubkey.toBase58());
  }

  private decodedToProduction(decoded: DecodedRiftData, riftId: string): ProductionRiftData {
    const backingRatio = Number(decoded.backingRatio) / 10000;
    return {
      id: riftId,
      symbol: decoded.name || 'rTOKEN',
      underlying: decoded.underlyingMint,
      strategy: 'Arbitrage',
      apy: calculateRealArbitrageOpportunity(backingRatio) * 365,
      tvl: 0,
      volume24h: 0,
      risk: calculateRiskLevel(backingRatio, decoded.arbitrageOpportunityBps),
      backingRatio,
      burnFee: decoded.burnFee,
      partnerFee: decoded.partnerFee,
      wrapFeeBps: decoded.wrapFeeBps,
      unwrapFeeBps: decoded.unwrapFeeBps,
      partnerFeeBps: decoded.partnerFeeBps,
      creator: decoded.creator,
      treasuryWallet: decoded.treasuryWallet,
      partnerWallet: decoded.partnerWallet,
      underlyingMint: decoded.underlyingMint,
      riftMint: decoded.riftMint,
      vault: decoded.vault,
      totalWrapped: decoded.totalWrapped.toString(),
      totalBurned: decoded.totalBurned.toString(),
      createdAt: new Date(Number(decoded.createdAt) * 1000),
      lastRebalance: new Date(Number(decoded.lastRebalance) * 1000),
      arbitrageOpportunity: decoded.arbitrageOpportunityBps / 100,
      oracleCountdown: calculateOracleCountdown(Number(decoded.lastOracleUpdate)),
      nextRebalance: Number(decoded.maxRebalanceInterval) - (Date.now() / 1000 - Number(decoded.lastRebalance)),
      performance: generateMockPerformance(12),
      realVaultBalance: 0,
      realRiftSupply: 0,
      realBackingRatio: backingRatio,
      priceDeviation: Number(decoded.priceDeviation) / 10000,
      volumeTriggerActive: false,
      participants: 0,
      oracleStatus: getOracleStatus(Number(decoded.lastOracleUpdate)),
    };
  }

  addRiftToCache(riftData: ProductionRiftData): void {
    addRiftToCacheFn(this.ctx, riftData);
  }

  updateRiftInCache(riftId: string, updates: Partial<ProductionRiftData>): void {
    updateRiftInCacheFn(this.ctx, riftId, updates);
  }

  clearCache(): void {
    clearCacheFn(this.ctx);
  }

  clearRiftCache(riftId: string): void {
    clearRiftCacheFn(riftId);
  }

  clearAllRiftCaches(): void {
    clearAllRiftCachesFn();
  }

  // ============ VOLUME TRACKING ============
  private trackVolume(riftId: string, volumeInSol: number): void {
    trackVolumeFn(this.ctx, riftId, volumeInSol);
  }

  private trackParticipant(riftId: string, userAddress: string): void {
    trackParticipantFn(this.ctx, riftId, userAddress);
  }

  getVolumeHistory(riftId: string): Array<{timestamp: number, amount: number, participant?: string}> {
    return getVolumeHistoryFn(this.ctx, riftId);
  }

  onVolumeUpdate(callback: (riftId: string, volume: number) => void): void {
    onVolumeUpdateFn(this.ctx, callback);
  }

  offVolumeUpdate(callback: (riftId: string, volume: number) => void): void {
    offVolumeUpdateFn(this.ctx, callback);
  }

  // ============ TVL/STATS ============
  async getTotalTVL(): Promise<number> {
    return getTotalTVLFn(this.ctx);
  }

  async getTotal24hVolume(): Promise<number> {
    return getTotal24hVolumeFn(this.ctx);
  }

  async getUniqueUserCount(): Promise<number> {
    return getUniqueUserCountFn(this.ctx);
  }

  // ============ WRAP TOKENS ============

  // Prefetch wrap data when modal opens (instant wrap when user clicks button)
  async prefetchWrapData(riftPubkey: PublicKey): Promise<void> {
    return prefetchWrapDataFn(this.ctx, riftPubkey, {
      decodeRiftAccount,
      getCachedMintDecimals: (mint: PublicKey) => getCachedMintDecimals(this.ctx.connection, mint, this.ctx.mintInfoCache, MINT_CACHE_TTL),
    });
  }

  // Prefetch unwrap data when modal opens
  async prefetchUnwrapData(riftPubkey: PublicKey): Promise<void> {
    const { prefetchUnwrapData } = await import('./rifts/unwrap');
    return prefetchUnwrapData(this.ctx, riftPubkey, {
      decodeRiftAccount,
      getCachedMintDecimals: (mint: PublicKey, programId?: PublicKey) =>
        getCachedMintDecimals(this.ctx.connection, mint, this.ctx.mintInfoCache, MINT_CACHE_TTL, programId),
    });
  }

  async wrapTokens(params: {
    user: PublicKey;
    riftPubkey: PublicKey;
    amount: number;
    slippageBps?: number;
    transferFeeBps?: number; // Token-2022 transfer fee for accurate slippage calculation
    initialRiftAmount?: number;
    tradingFeeBps?: number;
    binStep?: number;
    baseFactor?: number;
  }): Promise<WrapTokensResult> {
    return wrapTokensFn(this.ctx, params, {
      decodeRiftAccount,
      getCachedMintDecimals: (mint: PublicKey) => getCachedMintDecimals(this.ctx.connection, mint, this.ctx.mintInfoCache, MINT_CACHE_TTL),
      confirmTransactionSafely: (sig: string, skip?: boolean) => this.confirmTransactionSafely(sig, skip),
      trackVolume: (riftId: string, vol: number) => this.trackVolume(riftId, vol),
      trackParticipant: (riftId: string, user: string) => this.trackParticipant(riftId, user),
      createInitializeVaultInstruction: async () => null, // Vault init handled internally if needed
      updateTvlInBackground: async () => {},
    });
  }

  async basicWrapTokens(params: {
    user: PublicKey;
    riftPubkey: PublicKey;
    amount: number;
    skipVaultInitialization?: boolean;
  }): Promise<WrapTokensResult> {
    return basicWrapTokensFn(this.ctx, params, {
      getRiftData: (pubkey: PublicKey, skipRetries?: boolean) => getRiftDataFn(this.ctx, pubkey, skipRetries),
      createBasicWrapTokensInstruction: async () => null, // Handled internally by the module
      createInitializeVaultInstruction: async () => null, // Handled internally by the module
      confirmTransactionSafely: (sig: string, skip?: boolean) => this.confirmTransactionSafely(sig, skip),
    });
  }

  // ============ UNWRAP TOKENS ============
  async unwrapTokens(params: {
    user: PublicKey;
    riftPubkey: PublicKey;
    riftTokenAmount: number;
    slippageBps?: number;
    transferFeeBps?: number; // Token-2022 transfer fee for accurate slippage calculation
  }): Promise<UnwrapTokensResult> {
    return unwrapTokensFn(this.ctx, params, {
      decodeRiftAccount,
      trackVolume: (riftId: string, vol: number) => this.trackVolume(riftId, vol),
      trackParticipant: (riftId: string, user: string) => this.trackParticipant(riftId, user),
      unwrapFromVault: (p: any, riftData: any, decimals: number) => this.unwrapFromVault(p, riftData, decimals),
      confirmTransactionSafely: (sig: string, skip?: boolean) => this.confirmTransactionSafely(sig, skip),
      updateTvlInBackground: async (_riftId: string, _amount: number, _type: 'wrap' | 'unwrap') => {},
      getCachedMintDecimals: (mint: PublicKey, programId?: PublicKey) =>
        getCachedMintDecimals(this.ctx.connection, mint, this.ctx.mintInfoCache, MINT_CACHE_TTL, programId),
    });
  }

  async unwrapFromVault(params: any, riftData: any, decimals: number): Promise<UnwrapTokensResult> {
    return unwrapFromVaultFn(this.ctx, params, riftData, decimals, {
      getRiftData: (pubkey: PublicKey, skipRetries?: boolean) => getRiftDataFn(this.ctx, pubkey, skipRetries),
      getCachedMintDecimals: (mint: PublicKey, programId?: PublicKey) => getCachedMintDecimals(this.ctx.connection, mint, this.ctx.mintInfoCache, MINT_CACHE_TTL),
      confirmTransactionSafely: (sig: string, skip?: boolean) => this.confirmTransactionSafely(sig, skip),
      updateTvlInBackground: async () => {},
      trackVolume: (riftId: string, vol: number) => this.trackVolume(riftId, vol),
      trackParticipant: (riftId: string, user: string) => this.trackParticipant(riftId, user),
    });
  }

  // ============ CREATE RIFT ============
  async createRiftWithVanityPDA(params: CreateRiftWithVanityPDAParams): Promise<CreateRiftResult> {
    return createRiftWithVanityPDAFn(this.ctx, params, {
      confirmTransactionSafely: (sig: string, skip?: boolean) => this.confirmTransactionSafely(sig, skip),
      saveRiftsToSupabase,
    });
  }

  async createRiftAndWrapInstructions(params: CreateRiftAndWrapParams): Promise<CreateRiftAndWrapResult> {
    return createRiftAndWrapInstructionsFn(this.ctx, params);
  }

  // Backward compatibility aliases
  async createRift(params: CreateRiftWithVanityPDAParams): Promise<CreateRiftResult> {
    return this.createRiftWithVanityPDA(params);
  }

  async createRiftWithVanityAddress(params: CreateRiftWithVanityPDAParams): Promise<CreateRiftResult> {
    return this.createRiftWithVanityPDA(params);
  }

  // ============ FEES - Call modules directly (they use internal functions) ============
  async createPartnerTokenAccount(params: { riftPubkey: PublicKey }): Promise<string> {
    return createPartnerTokenAccountFn(this.ctx, params);
  }

  async distributeFeesFromVault(params: DistributeFeesParams): Promise<DistributeFeesResult> {
    return distributeFeesFromVaultFn(this.ctx, params);
  }

  async claimDexFees(params: DistributeFeesParams): Promise<DistributeFeesResult> {
    return claimDexFeesFn(this.ctx, params);
  }

  async claimRiftFees(params: DistributeFeesParams): Promise<DistributeFeesResult> {
    return claimRiftFeesFn(this.ctx, params);
  }

  async getVaultFeesAvailable(params: { riftPubkey: PublicKey }): Promise<VaultFeesResult> {
    return getVaultFeesAvailableFn(this.ctx, params);
  }

  async getWithheldVaultFeesAvailable(params: { riftPubkey: PublicKey }): Promise<VaultFeesResult> {
    return getWithheldVaultFeesAvailableFn(this.ctx, params);
  }

  // ============ METEORA - Call modules directly (they use internal functions) ============
  async createMeteoraPool(params: CreatePoolParams): Promise<CreatePoolResult> {
    return createMeteoraPoolFn(this.ctx, params);
  }

  async removeMeteoraLiquidity(params: RemoveLiquidityParams): Promise<RemoveLiquidityResult> {
    return removeMeteoraLiquidityFn(this.ctx, params);
  }

  async findMeteoraPool(mintA: string, mintB: string): Promise<string | null> {
    return findMeteoraPoolFn(this.ctx, mintA, mintB);
  }

  async getMeteoraPoolPrice(poolAddress: string): Promise<number> {
    return getMeteoraPoolPriceFn(this.ctx, poolAddress);
  }

  async getMeteoraSwapQuote(params: SwapQuoteParams): Promise<SwapQuoteResult | null> {
    return getMeteoraSwapQuoteFn(this.ctx, params);
  }

  async executeMeteoraSwap(params: SwapParams): Promise<string> {
    return executeMeteoraSwapFn(this.ctx, params);
  }

  // ============ ADMIN FUNCTIONS ============
  async initializeVault(params: InitializeVaultParams): Promise<InitializeVaultResult> {
    return initializeVaultFn(this.ctx, params, {
      getRiftData: (rift: PublicKey) => getRiftDataFn(this.ctx, rift),
      forceCloseAccount: (account: PublicKey) => this.forceCloseAccount(account),
      confirmTransactionSafely: (sig: string) => this.confirmTransactionSafely(sig),
    });
  }

  async forceCloseAccount(accountPubkey: PublicKey): Promise<ForceCloseResult> {
    return forceCloseAccountFn(this.ctx, accountPubkey, (sig: string) => this.confirmTransactionSafely(sig));
  }

  async cleanupStuckAccounts(creator: PublicKey, underlyingMint: PublicKey): Promise<ForceCloseResult> {
    return cleanupStuckAccountsFn(this.ctx, creator, underlyingMint, (sig: string) => this.confirmTransactionSafely(sig));
  }

  async closeRift(params: CloseRiftParams): Promise<ForceCloseResult> {
    return closeRiftFn(this.ctx, params, {
      getRiftData: (rift: PublicKey) => getRiftDataFn(this.ctx, rift),
      confirmTransactionSafely: (sig: string) => this.confirmTransactionSafely(sig),
    });
  }

  async adminCloseRift(params: AdminCloseRiftParams): Promise<ForceCloseResult> {
    return adminCloseRiftFn(this.ctx, params, (sig: string) => this.confirmTransactionSafely(sig));
  }

  async checkProgramStatus(): Promise<ProgramStatusResult> {
    return checkProgramStatusFn(this.ctx);
  }

  async getTokenBalance(publicKey: PublicKey, mintAddress: string): Promise<number> {
    return getTokenBalanceFn(this.ctx.connection, publicKey, mintAddress);
  }

  // ============ ORACLE ============
  async updateOraclePrice(params: OracleUpdateParams): Promise<OracleUpdateResult> {
    return updateOraclePriceFn(this.ctx, params, (sig: string) => this.confirmTransactionSafely(sig));
  }

  async triggerRebalance(riftPubkey: PublicKey): Promise<RebalanceResult> {
    return triggerRebalanceFn(this.ctx, riftPubkey, (sig: string) => this.confirmTransactionSafely(sig));
  }

  // ============ JUPITER ============
  async executeDirectJupiterSwap(params: DirectJupiterSwapParams): Promise<string> {
    return executeDirectJupiterSwapFn(this.ctx, params, (sig: string) => this.confirmTransactionSafely(sig));
  }

  async executeJupiterSwap(params: JupiterSwapParams): Promise<string> {
    return executeJupiterSwapFn(this.ctx, params, (sig: string) => this.confirmTransactionSafely(sig));
  }

  // ============ UTILITY GETTERS (for backward compat) ============
  get connection(): Connection {
    return this.ctx.connection;
  }

  get wallet(): WalletAdapter | null {
    return this.ctx.wallet;
  }
}

// ============ FACTORY & SINGLETON ============
export function getProductionRiftsService(connection: Connection): ProductionRiftsService {
  return new ProductionRiftsService(connection);
}

import globalConnection from './connection';

// Export singleton instance
export const riftsService = new ProductionRiftsService(globalConnection);
