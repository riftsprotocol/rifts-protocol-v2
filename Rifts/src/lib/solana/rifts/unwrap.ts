// lib/solana/rifts/unwrap.ts - Unwrap tokens functionality
import { PublicKey, Transaction, ComputeBudgetProgram, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ServiceContext, DecodedRiftData, ProductionRiftData, RIFTS_PROGRAM_ID, getProgramIdForRift } from './types';
import { getStaticMintData, setStaticMintData, getStaticRiftData, cacheRiftData } from '../static-cache';

// ============ PREFETCH CACHE ============
// Cache prefetched data for instant unwrap when user clicks button
interface PrefetchedUnwrapData {
  riftData: DecodedRiftData;
  vaultAccountInfo: any;
  riftDecimals: number;
  underlyingDecimals: number;
  blockhash: string;
  tokenProgram: 'spl' | 'token2022';
  timestamp: number;
}

const prefetchCache = new Map<string, PrefetchedUnwrapData>();
const PREFETCH_TTL = 30000; // 30 seconds

export function getPrefetchedUnwrapData(riftId: string): PrefetchedUnwrapData | null {
  const cached = prefetchCache.get(riftId);
  if (cached && Date.now() - cached.timestamp < PREFETCH_TTL) {
    console.log(`⚡ [UNWRAP-PREFETCH] Using cached data for ${riftId.slice(0, 8)}... (age: ${Date.now() - cached.timestamp}ms)`);
    return cached;
  }
  return null;
}

export async function prefetchUnwrapData(
  ctx: ServiceContext,
  riftPubkey: PublicKey,
  helpers: {
    decodeRiftAccount: (data: Buffer) => DecodedRiftData;
    getCachedMintDecimals: (mint: PublicKey, programId?: PublicKey) => Promise<number>;
  }
): Promise<void> {
  const riftId = riftPubkey.toBase58();
  const startTime = Date.now();
  console.log(`🔄 [UNWRAP-PREFETCH] Starting prefetch for ${riftId.slice(0, 8)}...`);

  try {
    const programId = getProgramIdForRift(riftId);
    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), riftPubkey.toBuffer()],
      programId
    );

    const [accountInfos, latestBlockhash] = await Promise.all([
      ctx.connection.getMultipleAccountsInfo([riftPubkey, vaultPDA], 'processed'),
      ctx.connection.getLatestBlockhash('confirmed')
    ]);

    if (!accountInfos[0]) {
      console.error('[UNWRAP-PREFETCH] Rift not found');
      return;
    }

    const riftData = helpers.decodeRiftAccount(accountInfos[0].data);
    const vaultAccountInfo = accountInfos[1];

    const riftMintPubkey = new PublicKey(riftData.riftMint);
    const underlyingMintPubkey = new PublicKey(riftData.underlyingMint);

    const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
    const riftDecimals = await helpers.getCachedMintDecimals(riftMintPubkey, TOKEN_2022_PROGRAM_ID);
    const underlyingDecimals = await helpers.getCachedMintDecimals(underlyingMintPubkey);

    let tokenProgram: 'spl' | 'token2022' = 'spl';
    const cachedMint = getStaticMintData(riftData.underlyingMint);
    if (cachedMint) {
      tokenProgram = cachedMint.tokenProgram;
    }

    prefetchCache.set(riftId, {
      riftData,
      vaultAccountInfo,
      riftDecimals,
      underlyingDecimals,
      blockhash: latestBlockhash.blockhash,
      tokenProgram,
      timestamp: Date.now()
    });

    console.log(`✅ [UNWRAP-PREFETCH] Done for ${riftId.slice(0, 8)} in ${Date.now() - startTime}ms (decimals=${riftDecimals}/${underlyingDecimals})`);
  } catch (error) {
    console.error('[UNWRAP-PREFETCH] Error:', error);
  }
}

// ============ UNWRAP TOKENS ============

export interface UnwrapTokensParams {
  user: PublicKey;
  riftPubkey: PublicKey;
  riftTokenAmount: number;
  slippageBps?: number;
  transferFeeBps?: number; // Token-2022 transfer fee in basis points
}

export interface UnwrapTokensResult {
  success: boolean;
  signature?: string;
  error?: string;
  newTvl?: number;
}

export async function unwrapTokens(
  ctx: ServiceContext,
  params: UnwrapTokensParams,
  helpers: {
    decodeRiftAccount: (data: Buffer) => DecodedRiftData;
    trackVolume: (riftId: string, volume: number) => void;
    trackParticipant: (riftId: string, user: string) => void;
    unwrapFromVault: (params: any, riftData: any, decimals: number) => Promise<UnwrapTokensResult>;
    getCachedMintDecimals: (mint: PublicKey, programId?: PublicKey) => Promise<number>;
    confirmTransactionSafely: (sig: string, skip?: boolean) => Promise<boolean>;
    updateTvlInBackground: (riftId: string, amount: number, type: 'wrap' | 'unwrap') => Promise<void>;
  }
): Promise<UnwrapTokensResult> {
  ctx.isWrapInProgress = true;

  const startTime = Date.now();
  console.log('⏱️ [UNWRAP-TIMING] Starting unwrap transaction...');

  try {
    if (!ctx.wallet) {
      throw new Error('Wallet not connected');
    }

    if (params.riftTokenAmount <= 0 || !isFinite(params.riftTokenAmount)) {
      throw new Error('Amount must be greater than 0');
    }

    const riftId = params.riftPubkey.toBase58();
    let riftData: any = null;
    let riftDecimals: number | null = null;
    let underlyingDecimals: number | null = null;
    let vaultAccountInfo: any = null;
    let recentBlockhash: string | null = null;
    let tokenProgramId: PublicKey | null = null;

    // Prefetch
    const prefetched = getPrefetchedUnwrapData(riftId);
    if (prefetched) {
      console.log(`⚡ [UNWRAP] PREFETCH HIT! Using prefetched data (${Date.now() - prefetched.timestamp}ms old)`);
      riftData = prefetched.riftData;
      vaultAccountInfo = prefetched.vaultAccountInfo;
      riftDecimals = prefetched.riftDecimals;
      underlyingDecimals = prefetched.underlyingDecimals;
      recentBlockhash = prefetched.blockhash;
      const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
      tokenProgramId = prefetched.tokenProgram === 'token2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    }

    // Static cache
    const staticRift = getStaticRiftData(riftId);
    if (staticRift) {
      riftData = riftData || {
        creator: riftId,
        underlyingMint: staticRift.underlyingMint,
        riftMint: staticRift.riftMint,
        vault: staticRift.vault,
        burnFee: staticRift.burnFee || 0,
        partnerFee: staticRift.partnerFee || 0,
        totalWrapped: BigInt(0),
        totalBurned: BigInt(0),
        backingRatio: BigInt(10000),
        lastRebalance: BigInt(0),
        createdAt: BigInt(Math.floor(Date.now() / 1000)),
        oracleUpdateInterval: BigInt(60),
        maxRebalanceInterval: BigInt(3600),
        arbitrageThresholdBps: 50,
        lastOracleUpdate: BigInt(Math.floor(Date.now() / 1000)),
        totalVolume24h: BigInt(0),
        priceDeviation: BigInt(0),
        arbitrageOpportunityBps: 0,
        rebalanceCount: 0,
        totalFeesCollected: BigInt(0),
        riftsTokensDistributed: BigInt(0),
        riftsTokensBurned: BigInt(0)
      };
      const mintData = getStaticMintData(staticRift.riftMint);
      if (mintData) riftDecimals = mintData.decimals;
      const underlyingData = getStaticMintData(staticRift.underlyingMint);
      if (underlyingData) underlyingDecimals = underlyingData.decimals;
    }

    // Memory cache
    if (!riftData) {
      const cachedRift = ctx.riftsCache.find((r: ProductionRiftData) => r.id === riftId || r.address === riftId);
      if (cachedRift) {
        cacheRiftData(riftId, cachedRift.underlyingMint, cachedRift.riftMint, cachedRift.vault);
        riftData = {
          creator: cachedRift.creator,
          underlyingMint: cachedRift.underlyingMint || cachedRift.underlying,
          riftMint: cachedRift.riftMint,
          vault: cachedRift.vault,
          burnFee: cachedRift.burnFee || 0,
          partnerFee: cachedRift.partnerFee || 0,
          totalWrapped: BigInt(cachedRift.totalWrapped || 0),
          totalBurned: BigInt(0),
          backingRatio: BigInt(10000),
          lastRebalance: BigInt(0),
          createdAt: BigInt(Math.floor(Date.now() / 1000)),
          oracleUpdateInterval: BigInt(60),
          maxRebalanceInterval: BigInt(3600),
          arbitrageThresholdBps: 50,
          lastOracleUpdate: BigInt(Math.floor(Date.now() / 1000)),
          totalVolume24h: BigInt(0),
          priceDeviation: BigInt(0),
          arbitrageOpportunityBps: 0,
          rebalanceCount: 0,
          totalFeesCollected: BigInt(0),
          riftsTokensDistributed: BigInt(0),
          riftsTokensBurned: BigInt(0),
          positionNftMint: (cachedRift as any).positionNftMint,
          meteoraPool: (cachedRift as any).meteoraPool || (cachedRift as any).liquidityPool
        };
        const mintData = getStaticMintData(cachedRift.riftMint);
        if (mintData) riftDecimals = mintData.decimals;
      }
    }

    const programId = getProgramIdForRift(params.riftPubkey.toBase58());
    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), params.riftPubkey.toBuffer()],
      programId
    );

    if (!prefetched && (!riftData || riftDecimals === null || underlyingDecimals === null)) {
      const accountsToFetch = [params.riftPubkey, vaultPDA];
      const [accountInfos, latestBlockhash] = await Promise.all([
        ctx.connection.getMultipleAccountsInfo(accountsToFetch, 'processed'),
        ctx.connection.getLatestBlockhash('confirmed')
      ]);
      recentBlockhash = latestBlockhash.blockhash;
      if (!riftData) {
        if (!accountInfos[0]) throw new Error('Rift not found');
        riftData = helpers.decodeRiftAccount(accountInfos[0].data);
        vaultAccountInfo = accountInfos[1];
        cacheRiftData(riftId, riftData.underlyingMint, riftData.riftMint, riftData.vault);
      }
      const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
      const riftMintPubkey = new PublicKey(riftData.riftMint);
      const underlyingMintPubkey = new PublicKey(riftData.underlyingMint);
      if (riftDecimals === null) {
        riftDecimals = await helpers.getCachedMintDecimals(riftMintPubkey, TOKEN_2022_PROGRAM_ID);
      }
      if (underlyingDecimals === null) {
        underlyingDecimals = await helpers.getCachedMintDecimals(underlyingMintPubkey);
      }
      tokenProgramId = TOKEN_PROGRAM_ID;
    }

    if (riftData.vault === '11111111111111111111111111111111') {
      riftData.vault = vaultPDA.toBase58();
    }

    if (riftDecimals === null || underlyingDecimals === null) {
      throw new Error('Failed to fetch mint decimals for unwrap');
    }

    const {
      TOKEN_2022_PROGRAM_ID,
      getAssociatedTokenAddress,
      createAssociatedTokenAccountIdempotentInstruction,
      createCloseAccountInstruction,
      createSyncNativeInstruction,
    } = await import('@solana/spl-token');

    const underlyingMintPubkey = new PublicKey(riftData.underlyingMint);
    const riftMintPubkey = new PublicKey(riftData.riftMint);

    let underlyingTokenProgram = TOKEN_PROGRAM_ID;
    const cachedUnderlyingMintData = getStaticMintData(riftData.underlyingMint);
    if (cachedUnderlyingMintData) {
      underlyingTokenProgram = cachedUnderlyingMintData.tokenProgram === 'token2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    } else {
      try {
        const mintAccountInfo = await ctx.connection.getAccountInfo(underlyingMintPubkey, 'processed');
        if (mintAccountInfo) {
          const mintOwner = mintAccountInfo.owner.toBase58();
          underlyingTokenProgram = mintOwner === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
          setStaticMintData(riftData.underlyingMint, { decimals: underlyingDecimals, tokenProgram: mintOwner === TOKEN_2022_PROGRAM_ID.toBase58() ? 'token2022' : 'spl' });
        }
      } catch {
        // ignore detection errors
      }
    }

    const isV1Rift = params.riftPubkey.toBase58() === 'CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL';
    const riftTokenProgram = isV1Rift ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

    // ATAs
    const userUnderlyingAccount = await getAssociatedTokenAddress(
      underlyingMintPubkey,
      new PublicKey(params.user),
      false,
      underlyingTokenProgram
    );
    const userRiftTokenAccount = await getAssociatedTokenAddress(
      riftMintPubkey,
      new PublicKey(params.user),
      false,
      riftTokenProgram
    );

    // Use requested amount directly; let on-chain program enforce balance
    const effectiveAmount = params.riftTokenAmount;

    if (!Number.isFinite(effectiveAmount) || effectiveAmount <= 0) {
      throw new Error('Insufficient RIFT balance for unwrap');
    }

    // Compute expected underlying out (before user slippage min)
    const unwrapFeeBps =
      (riftData.unwrapFeeBps ?? riftData.unwrapFee ?? riftData.burnFee ?? 0) as number;
    // Burn/fee math must use the RIFT mint decimals, not underlying
    const amountLamports = Math.floor(effectiveAmount * Math.pow(10, riftDecimals));
    const amountAfterFee =
      unwrapFeeBps > 0
        ? Math.floor((amountLamports * (10000 - unwrapFeeBps)) / 10000)
        : amountLamports;

    // ===== Liquidity guard: ensure vault can cover the withdrawal =====
    let vaultBalanceLamports: number | null = null;
    try {
      if (vaultAccountInfo?.data?.length) {
        const buf = vaultAccountInfo.data as Buffer;
        if (buf.length >= 72) {
          vaultBalanceLamports = Number(buf.readBigUInt64LE(64));
        }
      }
      if (vaultBalanceLamports === null && typeof (ctx.connection as any).getTokenAccountBalance === 'function') {
        const balance = await (ctx.connection as any).getTokenAccountBalance(vaultPDA, 'processed');
        vaultBalanceLamports = Number(balance.value.amount);
      }
    } catch (e) {
      console.warn('[UNWRAP] Could not read vault balance, continuing without guard', e);
    }

    if (vaultBalanceLamports !== null && vaultBalanceLamports < amountAfterFee) {
      throw new Error(
        `Vault liquidity too low. Needed ${amountAfterFee}, available ${vaultBalanceLamports}.`
      );
    }

    // Track volume/participant
    const backingRatio = parseInt(riftData.backingRatio.toString()) / 10000;
    const volumeInSol = params.riftTokenAmount * backingRatio;
    helpers.trackVolume(params.riftPubkey.toString(), volumeInSol);
    if (ctx.wallet?.publicKey) {
      helpers.trackParticipant(params.riftPubkey.toString(), ctx.wallet.publicKey.toString());
    }

    // Build transaction (mirrors wrap structure)
    const transaction = new Transaction();
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
    );

    // Ensure these are initialized before any guard checks
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        new PublicKey(params.user),
        userUnderlyingAccount,
        new PublicKey(params.user),
        underlyingMintPubkey,
        underlyingTokenProgram
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        new PublicKey(params.user),
        userRiftTokenAccount,
        new PublicKey(params.user),
        riftMintPubkey,
        riftTokenProgram
      )
    );

    // Build unwrap instruction
    const unwrapIx = await createBasicUnwrapInstruction(
      ctx,
      new PublicKey(params.user),
      params.riftPubkey,
      effectiveAmount,
      riftDecimals,
      underlyingDecimals,
      riftData,
      params.slippageBps,
      underlyingTokenProgram,
      riftTokenProgram,
      params.transferFeeBps // Pass transfer fee for accurate min output calculation
    );
    if (!unwrapIx) throw new Error('Failed to create unwrap instruction');
    transaction.add(unwrapIx);

    // Close WSOL if needed
    const isNativeSOL = riftData.underlyingMint === 'So11111111111111111111111111111111111111112';
    if (isNativeSOL) {
      transaction.add(
        createCloseAccountInstruction(
          userUnderlyingAccount,
          new PublicKey(params.user),
          new PublicKey(params.user),
          [],
          TOKEN_PROGRAM_ID
        )
      );
    }

    transaction.feePayer = new PublicKey(params.user);
    if (recentBlockhash) {
      transaction.recentBlockhash = recentBlockhash;
    }

    // Debug: Log all accounts in the unwrap instruction
    console.log('🔍 [UNWRAP DEBUG] Transaction instructions:', transaction.instructions.length);
    console.log('🔍 [UNWRAP DEBUG] Unwrap instruction accounts:', {
      user: params.user.toString(),
      rift: params.riftPubkey.toString(),
      userUnderlyingAccount: userUnderlyingAccount.toString(),
      userRiftTokenAccount: userRiftTokenAccount.toString(),
      vault: riftData.vault,
      underlyingMint: riftData.underlyingMint,
      riftMint: riftData.riftMint,
      underlyingTokenProgram: underlyingTokenProgram.toString(),
      riftTokenProgram: riftTokenProgram.toString(),
      programId: getProgramIdForRift(params.riftPubkey.toBase58()).toString(),
      riftDecimals,
      underlyingDecimals,
      effectiveAmount,
      amountLamports,
      amountAfterFee
    });

    const signature = await ctx.wallet.sendTransaction(transaction, ctx.connection, {
      skipPreflight: true,
      maxRetries: 3
    } as any);

    const confirmed = await helpers.confirmTransactionSafely(signature);
    if (!confirmed) {
      // Get transaction details to see the actual error
      try {
        const txDetails = await ctx.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
        console.error('🔍 [UNWRAP DEBUG] Transaction details:', {
          err: txDetails?.meta?.err,
          logs: txDetails?.meta?.logMessages
        });
      } catch (e) {
        console.error('🔍 [UNWRAP DEBUG] Could not fetch tx details:', e);
      }
      throw new Error('Transaction failed to confirm');
    }

    helpers.updateTvlInBackground(params.riftPubkey.toBase58(), params.riftTokenAmount, 'unwrap').catch(() => {});

    return { success: true, signature };
  } catch (error) {
    console.error('[ERROR] UNWRAP DEBUG: Error in unwrapTokens:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unwrap failed'
    };
  } finally {
    ctx.isWrapInProgress = false;
  }
}

// ============ UNWRAP FROM VAULT ============

export interface UnwrapFromVaultParams {
  user: string;
  riftPubkey: string;
  riftTokenAmount: number;
  slippageBps?: number;
}

export async function unwrapFromVault(
  ctx: ServiceContext,
  params: UnwrapFromVaultParams,
  cachedRiftData: DecodedRiftData | undefined,
  cachedDecimals: number | undefined,
  helpers: {
    getRiftData: (pubkey: PublicKey, skipRetries?: boolean) => Promise<DecodedRiftData | null>;
    getCachedMintDecimals: (mint: PublicKey, programId?: PublicKey) => Promise<number>;
    confirmTransactionSafely: (sig: string, skipWait?: boolean) => Promise<boolean>;
    updateTvlInBackground: (riftId: string, amount: number, type: 'wrap' | 'unwrap') => Promise<void>;
    trackVolume: (riftId: string, volume: number) => void;
    trackParticipant: (riftId: string, user: string) => void;
  }
): Promise<UnwrapTokensResult> {
  const startTime = Date.now();
  try {
    console.log('🔨 UNWRAP FROM VAULT DEBUG: Starting with params:', {
      user: params.user,
      riftPubkey: params.riftPubkey,
      riftTokenAmount: params.riftTokenAmount,
      usingCache: !!cachedRiftData,
      usingCachedDecimals: !!cachedDecimals
    });

    if (!ctx.wallet) {
      throw new Error('Wallet not connected');
    }

    const user = new PublicKey(params.user);
    const riftPubkey = new PublicKey(params.riftPubkey);

    // Use cached rift data if provided
    let riftData: DecodedRiftData;
    if (!cachedRiftData) {
      console.log('[SLOW] UNWRAP FROM VAULT: Fetching rift data (not cached)...');
      const fetchedData = await helpers.getRiftData(riftPubkey, true);
      if (!fetchedData) {
        throw new Error('Rift not found');
      }
      riftData = fetchedData;
    } else {
      console.log('[FAST] UNWRAP FROM VAULT: Using cached rift data');
      riftData = cachedRiftData;
    }

    // Get decimals
    let riftDecimals: number;
    let underlyingDecimals: number;

    const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');

    if (cachedDecimals !== undefined) {
      riftDecimals = cachedDecimals;
      console.log('💾 Using cached rift token decimals:', riftDecimals);
    } else {
      // Check static cache first
      const riftMintData = getStaticMintData(riftData.riftMint);
      if (riftMintData) {
        riftDecimals = riftMintData.decimals;
        console.log(`⚡ [UNWRAP] Rift decimals from static cache: ${riftDecimals}`);
      } else {
        riftDecimals = await helpers.getCachedMintDecimals(new PublicKey(riftData.riftMint), TOKEN_2022_PROGRAM_ID);
        setStaticMintData(riftData.riftMint, { decimals: riftDecimals, tokenProgram: 'token2022' });
      }
    }

    // Fetch underlying decimals - use static cache first
    const underlyingMintData = getStaticMintData(riftData.underlyingMint);
    if (underlyingMintData) {
      underlyingDecimals = underlyingMintData.decimals;
      console.log(`⚡ [UNWRAP] Underlying decimals from static cache: ${underlyingDecimals}`);
    } else {
      underlyingDecimals = await helpers.getCachedMintDecimals(new PublicKey(riftData.underlyingMint));
    }

    // Convert amount
    let riftTokenAmountLamports: number;
    if (riftDecimals !== underlyingDecimals) {
      console.warn(`⚠️ DECIMAL MISMATCH: Rift has ${riftDecimals}, underlying has ${underlyingDecimals}`);
      riftTokenAmountLamports = Math.floor(params.riftTokenAmount * Math.pow(10, underlyingDecimals));
    } else {
      riftTokenAmountLamports = Math.floor(params.riftTokenAmount * Math.pow(10, riftDecimals));
    }

    // Track
    helpers.trackVolume(riftPubkey.toBase58(), params.riftTokenAmount);
    helpers.trackParticipant(riftPubkey.toBase58(), user.toBase58());

    // Setup token programs
    const isNativeSOL = riftData.underlyingMint === 'So11111111111111111111111111111111111111112';
    const { getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction } = await import('@solana/spl-token');

    // Detect underlying token program
    const underlyingMintPubkey = new PublicKey(riftData.underlyingMint);
    let underlyingTokenProgram = TOKEN_PROGRAM_ID;

    const cachedUnderlyingMintData = getStaticMintData(riftData.underlyingMint);
    if (cachedUnderlyingMintData) {
      underlyingTokenProgram = cachedUnderlyingMintData.tokenProgram === 'token2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      console.log(`🪙 [UNWRAP] ⚡ From cache: ${cachedUnderlyingMintData.tokenProgram}`);
    } else {
      try {
        const mintAccountInfo = await ctx.connection.getAccountInfo(underlyingMintPubkey, 'processed');
        if (mintAccountInfo) {
          const mintOwner = mintAccountInfo.owner.toBase58();
          if (mintOwner === TOKEN_2022_PROGRAM_ID.toBase58()) {
            underlyingTokenProgram = TOKEN_2022_PROGRAM_ID;
            setStaticMintData(riftData.underlyingMint, { decimals: underlyingDecimals, tokenProgram: 'token2022' });
          } else {
            setStaticMintData(riftData.underlyingMint, { decimals: underlyingDecimals, tokenProgram: 'spl' });
          }
        }
      } catch (e) {
        console.warn(`⚠️ Could not detect token program:`, e);
      }
    }

    // Get ATAs
    const userUnderlyingAccount = await getAssociatedTokenAddress(
      underlyingMintPubkey,
      user,
      false,
      underlyingTokenProgram
    );

    const isV1Rift = riftPubkey.toBase58() === 'CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL';
    const riftTokenProgram = isV1Rift ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

    const userRiftTokenAccount = await getAssociatedTokenAddress(
      new PublicKey(riftData.riftMint),
      user,
      false,
      riftTokenProgram
    );

    // Derive PDAs
    const programId = getProgramIdForRift(riftPubkey.toBase58());

    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), riftPubkey.toBuffer()],
      programId
    );

    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_auth"), riftPubkey.toBuffer()],
      programId
    );

    const [riftMintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("rift_mint_auth"), riftPubkey.toBuffer()],
      programId
    );

    const [feesVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("fees_vault"), riftPubkey.toBuffer()],
      programId
    );

    // Build instruction data
    const discriminator = Buffer.from([0xd4, 0xa2, 0xe5, 0x8c, 0x49, 0xd9, 0xf5, 0xaf]);
    const instructionData = Buffer.alloc(24);
    discriminator.copy(instructionData, 0);

    const dataView = new DataView(instructionData.buffer, instructionData.byteOffset, instructionData.byteLength);
    dataView.setBigUint64(8, BigInt(riftTokenAmountLamports), true);

    // Add min_underlying_out
    const expectedUnderlying = BigInt(riftTokenAmountLamports) * BigInt(9970) / BigInt(10000);
    const minUnderlyingOut = params.slippageBps !== undefined
      ? expectedUnderlying * BigInt(10000 - params.slippageBps) / BigInt(10000)
      : BigInt(0);
    dataView.setBigUint64(16, minUnderlyingOut, true);

    // Build instruction (account order must match on-chain UnwrapFromVault)
    const unwrapInstruction = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },                    // user
        { pubkey: riftPubkey, isSigner: false, isWritable: true },             // rift
        { pubkey: userUnderlyingAccount, isSigner: false, isWritable: true },  // user_underlying
        { pubkey: userRiftTokenAccount, isSigner: false, isWritable: true },   // user_rift_tokens
        { pubkey: vault, isSigner: false, isWritable: true },                  // vault
        { pubkey: underlyingMintPubkey, isSigner: false, isWritable: false },  // underlying_mint
        { pubkey: vaultAuthority, isSigner: false, isWritable: false },        // vault_authority
        { pubkey: riftMintAuthority, isSigner: false, isWritable: false },     // rift_mint_authority
        { pubkey: new PublicKey(riftData.riftMint), isSigner: false, isWritable: true }, // rift_mint
        { pubkey: feesVault, isSigner: false, isWritable: true },              // fees_vault
        { pubkey: underlyingTokenProgram, isSigner: false, isWritable: false }, // underlying_token_program
        { pubkey: riftTokenProgram, isSigner: false, isWritable: false },       // rift_token_program
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data: (() => {
        // rebuild data with effective amount to avoid mismatched burn
        const buf = Buffer.alloc(24);
        const discr = Buffer.from([0xd4, 0xa2, 0xe5, 0x8c, 0x49, 0xd9, 0xf5, 0xaf]);
        discr.copy(buf, 0);
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const lamports = BigInt(Math.floor(params.riftTokenAmount * Math.pow(10, riftDecimals)));
        const expected = lamports * BigInt(9970) / BigInt(10000);
        const minOut = params.slippageBps !== undefined
          ? expected * BigInt(10000 - params.slippageBps) / BigInt(10000)
          : BigInt(0);
        dv.setBigUint64(8, lamports, true);
        dv.setBigUint64(16, minOut, true);
        return buf;
      })(),
    });

    // Build transaction
    const transaction = new Transaction();

    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
    );

    // Create underlying ATA if needed
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        user,
        userUnderlyingAccount,
        user,
        underlyingMintPubkey,
        underlyingTokenProgram
      )
    );

    // Add unwrap instruction
    transaction.add(unwrapInstruction);

    // For native SOL, close WSOL account
    if (isNativeSOL) {
      transaction.add(
        createCloseAccountInstruction(
          userUnderlyingAccount,
          user,
          user,
          [],
          TOKEN_PROGRAM_ID
        )
      );
    }

    transaction.feePayer = user;

    // Send transaction
    let signature: string;
    try {
      signature = await ctx.wallet.sendTransaction(transaction, ctx.connection, {
        skipPreflight: true,
        maxRetries: 3
      } as any);
    } catch (sendError: any) {
      if (sendError?.message?.includes('User rejected')) {
        throw new Error('Transaction was rejected by user');
      }
      throw sendError;
    }

    // Confirm
    const confirmed = await helpers.confirmTransactionSafely(signature);

    if (confirmed) {
      const status = await ctx.connection.getSignatureStatus(signature);
      if (status?.value?.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
      }

      // Update TVL in background
      helpers.updateTvlInBackground(params.riftPubkey, params.riftTokenAmount, 'unwrap').catch(() => {});

      console.log('🎉 UNWRAP FROM VAULT: Completed successfully!');
      return { success: true, signature };
    } else {
      throw new Error('Transaction failed to confirm');
    }
  } catch (error) {
    console.error('[ERROR] UNWRAP FROM VAULT:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Vault unwrap failed'
    };
  }
}

// ============ BASIC UNWRAP INSTRUCTION ============
export async function createBasicUnwrapInstruction(
  ctx: ServiceContext,
  user: PublicKey,
  riftPubkey: PublicKey,
  riftTokenAmount: number,
  riftDecimals: number,
  underlyingDecimals: number,
  cachedRiftData?: DecodedRiftData,
  slippageBps?: number,
  underlyingTokenProgramId?: PublicKey,
  riftTokenProgramId?: PublicKey,
  transferFeeBps?: number // Token-2022 transfer fee for accurate min output calculation
): Promise<TransactionInstruction | null> {
  try {
    let riftData = cachedRiftData;
    if (!riftData) {
      const riftAccount = await ctx.connection.getAccountInfo(riftPubkey);
      if (!riftAccount) return null;
      const { decodeRiftAccount } = await import('./utils');
      riftData = decodeRiftAccount(riftAccount.data);
    }

    const instructionData = Buffer.alloc(24);
    const discriminator = Buffer.from([0xd4, 0xa2, 0xe5, 0x8c, 0x49, 0xd9, 0xf5, 0xaf]);
    discriminator.copy(instructionData, 0);
    const dataView = new DataView(instructionData.buffer, instructionData.byteOffset, instructionData.byteLength);

    // Use RIFT mint decimals for the burn amount
    const amountLamports = BigInt(Math.floor(riftTokenAmount * Math.pow(10, riftDecimals)));
    const expectedUnderlying = amountLamports * BigInt(9970) / BigInt(10000);

    // Calculate minUnderlyingOut accounting for transfer fee AND slippage
    // On unwrap: user receives underlying tokens, transfer fee applies on the outgoing transfer
    let minUnderlyingOut = BigInt(0);
    if (slippageBps !== undefined || transferFeeBps !== undefined) {
      const effectiveTransferFee = transferFeeBps ?? 0;
      const effectiveSlippage = slippageBps ?? 50; // Default 0.5% slippage

      // Add safety buffer for rounding
      const safetyBufferBps = 50;
      const totalDeductionBps = effectiveTransferFee + effectiveSlippage + safetyBufferBps;
      const cappedDeductionBps = Math.min(totalDeductionBps, 5000);

      minUnderlyingOut = expectedUnderlying * BigInt(10000 - cappedDeductionBps) / BigInt(10000);
      console.log(`🔐 [UNWRAP-SLIPPAGE] Transfer fee: ${effectiveTransferFee}bps, Slippage: ${effectiveSlippage}bps, Buffer: ${safetyBufferBps}bps, Total: ${cappedDeductionBps}bps, minUnderlyingOut: ${minUnderlyingOut.toString()}`);
    }
    dataView.setBigUint64(8, amountLamports, true);
    dataView.setBigUint64(16, minUnderlyingOut, true);

    const programId = getProgramIdForRift(riftPubkey.toBase58());
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), riftPubkey.toBuffer()],
      programId
    );
    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_auth"), riftPubkey.toBuffer()],
      programId
    );
    const [riftMintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("rift_mint_auth"), riftPubkey.toBuffer()],
      programId
    );
    const [feesVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("fees_vault"), riftPubkey.toBuffer()],
      programId
    );

    const { getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
    const underlyingMintPubkey = new PublicKey(riftData.underlyingMint);
    const riftMintPubkey = new PublicKey(riftData.riftMint);

    const isV1Rift = riftPubkey.toBase58() === 'CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL';
    const riftTokenProgram = riftTokenProgramId || (isV1Rift ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID);
    const underlyingTokenProgram = underlyingTokenProgramId || TOKEN_PROGRAM_ID;

    const userUnderlyingAccount = await getAssociatedTokenAddress(
      underlyingMintPubkey,
      user,
      false,
      underlyingTokenProgram
    );
    const userRiftTokenAccount = await getAssociatedTokenAddress(
      riftMintPubkey,
      user,
      false,
      riftTokenProgram
    );

    // Account order MUST match UnwrapFromVault ctx in on-chain program
    const accountKeys = [
      { pubkey: user, isSigner: true, isWritable: true },                   // user
      { pubkey: riftPubkey, isSigner: false, isWritable: true },            // rift
      { pubkey: userUnderlyingAccount, isSigner: false, isWritable: true }, // user_underlying
      { pubkey: userRiftTokenAccount, isSigner: false, isWritable: true },  // user_rift_tokens
      { pubkey: vault, isSigner: false, isWritable: true },                 // vault
      { pubkey: underlyingMintPubkey, isSigner: false, isWritable: false }, // underlying_mint
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },       // vault_authority
      { pubkey: riftMintAuthority, isSigner: false, isWritable: false },    // rift_mint_authority
      { pubkey: riftMintPubkey, isSigner: false, isWritable: true },        // rift_mint
      { pubkey: feesVault, isSigner: false, isWritable: true },             // fees_vault
      { pubkey: underlyingTokenProgram, isSigner: false, isWritable: false }, // underlying_token_program
      { pubkey: riftTokenProgram, isSigner: false, isWritable: false },       // rift_token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ];

    return new TransactionInstruction({
      programId,
      keys: accountKeys,
      data: instructionData,
    });
  } catch (error) {
    console.error('[ERROR] UNWRAP INSTRUCTION DEBUG:', error);
    return null;
  }
}
