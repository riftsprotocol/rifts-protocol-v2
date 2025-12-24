// lib/solana/rifts/index.ts - Main export file for Rifts Service
// Re-exports everything from modular files for backward compatibility
// Individual modules can be imported directly for tree-shaking

// ============ TYPES ============
// Re-export types and constants
export {
  // Program IDs and constants
  RIFTS_PROGRAM_ID,
  RIFTS_PROGRAM_ID_OLD,
  RIFTS_V1_PROGRAM_ID,
  METEORA_DAMM_V2_PROGRAM_ID,
  WSOL_MINT,
  V1_RIFTS,
  BLACKLISTED_RIFTS,
  MINT_CACHE_TTL,
  CACHE_DURATION_MS,
  MIN_RPC_INTERVAL,
  // Helper functions
  getProgramIdForRift,
  getProgramVersionForRift,
} from './types';

// Re-export type definitions
export type {
  WalletAdapter,
  DecodedRiftData,
  ProductionRiftData,
  ServiceContext,
  VanityPoolState,
  RiftsServiceState,
} from './types';

// ============ UTILITIES ============
export {
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
  getProgramIdForRiftAddress,
} from './utils';

// ============ DATA FUNCTIONS ============
export {
  // Main data fetching
  getAllRifts,
  getAllRiftsCacheBusted,
  enrichRiftsWithMeteoraData,
  getRiftData,
  prefetchRiftDataInBackground,
  // Cache management
  updateRiftInCache,
  addRiftToCache,
  clearCache,
  clearRiftCache,
  clearAllRiftCaches,
  // Volume tracking
  trackVolume,
  getTrackedVolume,
  trackParticipant,
  getParticipantCount,
  getVolumeHistory,
  onVolumeUpdate,
  offVolumeUpdate,
  // Helper functions
  getActualVaultBalance,
  getTokenPrice,
  getTokenSymbol,
  getTotalTVL,
  getTotal24hVolume,
  getUniqueUserCount,
  getPerformanceHistory,
  saveRiftsToSupabase,
} from './data';

// ============ WRAP FUNCTIONS ============
export {
  wrapTokens,
  basicWrapTokens,
  createBasicWrapTokensInstruction,
  prefetchWrapData,
  getPrefetchedWrapData,
} from './wrap';

export type {
  WrapTokensParams,
  WrapTokensResult,
} from './wrap';

// ============ UNWRAP FUNCTIONS ============
export {
  unwrapTokens,
  unwrapFromVault,
} from './unwrap';

export type {
  UnwrapTokensParams,
  UnwrapTokensResult,
} from './unwrap';

// ============ CREATE FUNCTIONS ============
export {
  createRiftWithVanityPDA,
  createRiftAndWrapInstructions,
  generateVanityAddressPool,
  getVanityAddressFromPool,
  getVanityPoolStatus,
} from './create';

export type {
  CreateRiftWithVanityPDAParams,
  CreateRiftResult,
  CreateRiftAndWrapParams,
  CreateRiftAndWrapResult,
} from './create';

// ============ FEE FUNCTIONS ============
export {
  createPartnerTokenAccount,
  distributeFeesFromVault,
  claimDexFees,
  claimRiftFees,
  getVaultFeesAvailable,
  getWithheldVaultFeesAvailable,
} from './fees';

export type {
  DistributeFeesParams,
  DistributeFeesResult,
  VaultFeesResult,
} from './fees';

// ============ METEORA FUNCTIONS ============
export {
  createMeteoraPool,
  removeMeteoraLiquidity,
  findMeteoraPool,
  getMeteoraPoolPrice,
  getMeteoraSwapQuote,
  executeMeteoraSwap,
} from './meteora';

export type {
  CreatePoolParams,
  CreatePoolResult,
  RemoveLiquidityParams,
  RemoveLiquidityResult,
  SwapParams,
  SwapQuoteParams,
  SwapQuoteResult,
} from './meteora';

// ============ ADMIN FUNCTIONS ============
export {
  initializeVault,
  forceCloseAccount,
  cleanupStuckAccounts,
  closeRift,
  adminCloseRift,
  checkProgramStatus,
  getTokenBalance,
  createInitializeVaultInstruction,
} from './admin';

export type {
  InitializeVaultParams,
  InitializeVaultResult,
  ForceCloseResult,
  CloseRiftParams,
  AdminCloseRiftParams,
  ProgramStatusResult,
} from './admin';

// ============ ORACLE FUNCTIONS ============
export {
  updateOraclePrice,
  triggerRebalance,
} from './oracle';

export type {
  OracleUpdateParams,
  OracleUpdateResult,
  RebalanceResult,
} from './oracle';

// ============ JUPITER FUNCTIONS ============
export {
  executeDirectJupiterSwap,
  executeJupiterSwap,
} from './jupiter';

export type {
  DirectJupiterSwapParams,
  JupiterSwapParams,
} from './jupiter';

// ============ MAIN SERVICE (backward compatible) ============
// Re-export the main service from the original file
export {
  ProductionRiftsService,
  getProductionRiftsService,
  riftsService,
} from '../rifts-service';
