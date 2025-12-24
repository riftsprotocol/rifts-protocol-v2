// lib/solana/rifts/wrap.ts - Wrap tokens functionality
import { Connection, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ServiceContext, DecodedRiftData, ProductionRiftData, RIFTS_PROGRAM_ID, getProgramIdForRift } from './types';
import { getStaticMintData, setStaticMintData, getStaticRiftData, cacheRiftData } from '../static-cache';

// ============ PREFETCH CACHE ============
// Cache prefetched data for instant wrap when user clicks button
interface PrefetchedWrapData {
  riftData: DecodedRiftData;
  vaultAccountInfo: any;
  decimals: number;
  blockhash: string;
  tokenProgram: 'spl' | 'token2022';
  timestamp: number;
}

const prefetchCache = new Map<string, PrefetchedWrapData>();
const PREFETCH_TTL = 30000; // 30 seconds - blockhash valid for ~60s

export function getPrefetchedWrapData(riftId: string): PrefetchedWrapData | null {
  const cached = prefetchCache.get(riftId);
  if (cached && Date.now() - cached.timestamp < PREFETCH_TTL) {
    console.log(`⚡ [PREFETCH] Using cached data for ${riftId.slice(0, 8)}... (age: ${Date.now() - cached.timestamp}ms)`);
    return cached;
  }
  return null;
}

export async function prefetchWrapData(
  ctx: ServiceContext,
  riftPubkey: PublicKey,
  helpers: {
    decodeRiftAccount: (data: Buffer) => DecodedRiftData;
    getCachedMintDecimals: (mint: PublicKey) => Promise<number>;
  }
): Promise<void> {
  const riftId = riftPubkey.toBase58();
  const startTime = Date.now();
  console.log(`🔄 [PREFETCH] Starting prefetch for ${riftId.slice(0, 8)}...`);

  try {
    const programId = getProgramIdForRift(riftId);
    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), riftPubkey.toBuffer()],
      programId
    );

    // Fetch everything in parallel!
    const [accountInfos, latestBlockhash] = await Promise.all([
      ctx.connection.getMultipleAccountsInfo([riftPubkey, vaultPDA], 'processed'),
      ctx.connection.getLatestBlockhash('confirmed')
    ]);
    console.log(`⏱️ [PREFETCH] RPC calls: +${Date.now() - startTime}ms`);

    if (!accountInfos[0]) {
      console.error('[PREFETCH] Rift not found');
      return;
    }

    const riftData = helpers.decodeRiftAccount(accountInfos[0].data);
    const vaultAccountInfo = accountInfos[1];

    // Fetch decimals (should be fast from Supabase cache)
    const mintPubkey = new PublicKey(riftData.underlyingMint);
    const decimals = await helpers.getCachedMintDecimals(mintPubkey);

    // Detect token program
    let tokenProgram: 'spl' | 'token2022' = 'spl';
    const cachedMint = getStaticMintData(riftData.underlyingMint);
    if (cachedMint) {
      tokenProgram = cachedMint.tokenProgram;
    }

    // Cache the prefetched data
    prefetchCache.set(riftId, {
      riftData,
      vaultAccountInfo,
      decimals,
      blockhash: latestBlockhash.blockhash,
      tokenProgram,
      timestamp: Date.now()
    });

    console.log(`✅ [PREFETCH] Done for ${riftId.slice(0, 8)} in ${Date.now() - startTime}ms (decimals=${decimals})`);
  } catch (error) {
    console.error('[PREFETCH] Error:', error);
  }
}

// ============ WRAP TOKENS ============

export interface WrapTokensParams {
  user: PublicKey;
  riftPubkey: PublicKey;
  amount: number;
  slippageBps?: number;
  transferFeeBps?: number; // Token-2022 transfer fee in basis points (e.g., 100 = 1%)
  initialRiftAmount?: number;
  tradingFeeBps?: number;
  binStep?: number;
  baseFactor?: number;
}

export interface WrapTokensResult {
  success: boolean;
  signature?: string;
  error?: string;
  poolAddress?: string;
  newTvl?: number;
}

export async function wrapTokens(
  ctx: ServiceContext,
  params: WrapTokensParams,
  helpers: {
    decodeRiftAccount: (data: Buffer) => DecodedRiftData;
    getCachedMintDecimals: (mint: PublicKey) => Promise<number>;
    confirmTransactionSafely: (sig: string, skipWait?: boolean) => Promise<boolean>;
    trackVolume: (riftId: string, volume: number) => void;
    trackParticipant: (riftId: string, user: string) => void;
    createInitializeVaultInstruction: (rift: PublicKey, payer: PublicKey) => Promise<TransactionInstruction | null>;
    updateTvlInBackground: (riftId: string, amount: number, type: 'wrap' | 'unwrap') => Promise<void>;
  }
): Promise<WrapTokensResult> {
  // Set flag to prevent prefetch operations during wrap
  ctx.isWrapInProgress = true;

  const startTime = Date.now();
  console.log('⏱️ [WRAP-TIMING] Starting wrap transaction...');

  try {
    if (!ctx.wallet) {
      throw new Error('Wallet not connected');
    }
    console.log(`⏱️ [WRAP-TIMING] Wallet check: +${Date.now() - startTime}ms`);

    // Validate amount
    if (params.amount <= 0) {
      throw new Error('Amount must be greater than 0');
    }

    if (!isFinite(params.amount) || isNaN(params.amount)) {
      throw new Error('Amount must be a valid number');
    }

    // ⚡ FAST: Use static cache (instant) instead of API calls
    const riftId = params.riftPubkey.toBase58();
    let cachedRift: any = null;
    let riftData: any = null;
    let decimals: number | null = null;
    let hasServerCacheDecimals = false;
    let vaultAccountInfo: any = null;
    let recentBlockhash: string | null = null; // Fetch in parallel to avoid delay
    let tokenProgramId: PublicKey | null = null;

    // Step 0: Check PREFETCH cache first (fastest - data already fetched when modal opened!)
    const prefetched = getPrefetchedWrapData(riftId);
    if (prefetched) {
      console.log(`⚡⚡ [WRAP] PREFETCH HIT! Using prefetched data (${Date.now() - prefetched.timestamp}ms old)`);
      riftData = prefetched.riftData;
      vaultAccountInfo = prefetched.vaultAccountInfo;
      decimals = prefetched.decimals;
      recentBlockhash = prefetched.blockhash;
      hasServerCacheDecimals = true;
      // Import TOKEN_2022_PROGRAM_ID for token program
      const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
      tokenProgramId = prefetched.tokenProgram === 'token2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    }

    // Step 1: Check static cache (instant - no network call)
    const staticRift = getStaticRiftData(riftId);
    if (staticRift) {
      cachedRift = {
        id: riftId,
        underlyingMint: staticRift.underlyingMint,
        riftMint: staticRift.riftMint,
        vault: staticRift.vault,
      };
      // Get decimals from static cache too
      const mintData = getStaticMintData(staticRift.underlyingMint);
      if (mintData) {
        decimals = mintData.decimals;
        hasServerCacheDecimals = true;
      }
      console.log(`⚡ [WRAP] Static cache hit! decimals=${decimals}`);
    }

    // Step 2: Fallback to memory cache (also instant)
    if (!cachedRift) {
      cachedRift = ctx.riftsCache.find((r: ProductionRiftData) => r.id === riftId || r.address === riftId);
      if (cachedRift) {
        // Cache it for next time
        cacheRiftData(riftId, cachedRift.underlyingMint, cachedRift.riftMint, cachedRift.vault);
        // Get decimals
        const mintData = getStaticMintData(cachedRift.underlyingMint);
        if (mintData) {
          decimals = mintData.decimals;
          hasServerCacheDecimals = true;
        }
      }
    }

    console.log(`⏱️ [WRAP-TIMING] Cache lookup: +${Date.now() - startTime}ms, cached=${!!cachedRift}`);

    // Determine which program ID to use for this rift
    const programId = getProgramIdForRift(params.riftPubkey.toBase58());
    console.log(`🔧 Using program ID: ${programId.toBase58()} for rift: ${params.riftPubkey.toBase58()}`);

    // Calculate vault PDA upfront
    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), params.riftPubkey.toBuffer()],
      programId
    );
    console.log(`⏱️ [WRAP-TIMING] Vault PDA derived: +${Date.now() - startTime}ms`);

    // Skip all RPC if we have prefetched data
    if (prefetched) {
      console.log(`⏱️ [WRAP-TIMING] ⚡ SKIPPING RPC - using prefetch: +${Date.now() - startTime}ms`);
      // riftData, vaultAccountInfo, decimals, recentBlockhash already set from prefetch
    } else if (cachedRift && cachedRift.underlyingMint && cachedRift.riftMint) {
      // Use cached rift data
      riftData = {
        creator: cachedRift.creator,
        underlyingMint: cachedRift.underlyingMint || cachedRift.underlying,
        riftMint: cachedRift.riftMint,
        vault: cachedRift.vault,
        burnFee: cachedRift.burnFee || 0.45,
        partnerFee: cachedRift.partnerFee || 0.05,
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

      // ⚡ Fetch decimals AND blockhash in parallel
      const tParallel = Date.now();
      const needsDecimals = decimals === null || !hasServerCacheDecimals;
      const needsVault = riftData.vault === '11111111111111111111111111111111';

      const parallelFetches: Promise<any>[] = [
        ctx.connection.getLatestBlockhash('confirmed') // Always need blockhash
      ];

      if (needsDecimals) {
        const underlyingMintPubkey = new PublicKey(riftData.underlyingMint);
        parallelFetches.push(helpers.getCachedMintDecimals(underlyingMintPubkey));
      }
      if (needsVault) {
        parallelFetches.push(ctx.connection.getAccountInfo(vaultPDA, 'processed'));
      }

      const results = await Promise.all(parallelFetches);
      console.log(`⏱️ [WRAP-TIMING] Parallel fetches (blockhash+decimals+vault): +${Date.now() - tParallel}ms`);

      recentBlockhash = results[0].blockhash;
      let idx = 1;
      if (needsDecimals) {
        decimals = results[idx++];
      }
      if (needsVault) {
        vaultAccountInfo = results[idx];
        riftData.vault = vaultPDA.toBase58();
      }
    } else {
      console.log(`⏱️ [WRAP-TIMING] No cache - fetching from blockchain...`);
      // Need to fetch rift from blockchain + blockhash IN PARALLEL
      const accountsToFetch = [params.riftPubkey, vaultPDA];
      const tMulti = Date.now();

      // Fetch accounts AND blockhash in parallel!
      const [accountInfos, latestBlockhash] = await Promise.all([
        ctx.connection.getMultipleAccountsInfo(accountsToFetch, 'processed'),
        ctx.connection.getLatestBlockhash('confirmed')
      ]);
      console.log(`⏱️ [WRAP-TIMING] getMultipleAccountsInfo + blockhash RPC: +${Date.now() - tMulti}ms`);

      // Store blockhash for later
      recentBlockhash = latestBlockhash.blockhash;

      // Parse rift account
      if (!accountInfos[0]) {
        throw new Error('Rift not found');
      }
      riftData = helpers.decodeRiftAccount(accountInfos[0].data);
      vaultAccountInfo = accountInfos[1];

      // Fetch mint decimals from Supabase cache (fast) or RPC
      const tMint = Date.now();
      const mintPubkey = new PublicKey(riftData.underlyingMint);
      decimals = await helpers.getCachedMintDecimals(mintPubkey);
      console.log(`⏱️ [WRAP-TIMING] Decimals fetch: +${Date.now() - tMint}ms`);

      if (riftData.vault === '11111111111111111111111111111111') {
        riftData.vault = vaultPDA.toBase58();
      }
    }
    console.log(`⏱️ [WRAP-TIMING] ✅ Data fetch complete: +${Date.now() - startTime}ms`);

    // 🔒 CRITICAL VALIDATION: Ensure decimals was fetched correctly
    if (decimals === null || decimals === undefined || decimals < 0) {
      throw new Error(`Failed to fetch token decimals for ${riftData?.underlyingMint}`);
    }
    console.log(`✅ [DECIMALS-VALIDATION] Using decimals: ${decimals}`);

    // Track volume
    helpers.trackVolume(params.riftPubkey.toString(), params.amount);

    // Track participant
    if (ctx.wallet?.publicKey) {
      helpers.trackParticipant(params.riftPubkey.toString(), ctx.wallet.publicKey.toString());
    }

    // Create transaction
    console.log(`⏱️ [WRAP-TIMING] Building transaction: +${Date.now() - startTime}ms`);
    const transaction = new Transaction();

    // Add compute budget
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })
    );
    console.log(`⏱️ [WRAP-TIMING] Compute budget added: +${Date.now() - startTime}ms`);

    // Import spl-token
    console.log(`⏱️ [WRAP-TIMING] Importing spl-token...`);
    const {
      TOKEN_2022_PROGRAM_ID,
      getAssociatedTokenAddress,
      createAssociatedTokenAccountIdempotentInstruction,
      createSyncNativeInstruction
    } = await import('@solana/spl-token');
    console.log(`⏱️ [WRAP-TIMING] spl-token imported: +${Date.now() - startTime}ms`);

    // Detect token program
    const underlyingMintPubkey = new PublicKey(riftData.underlyingMint);
    let underlyingTokenProgramId = TOKEN_PROGRAM_ID;

    const cachedMintData = getStaticMintData(riftData.underlyingMint);
    if (cachedMintData) {
      underlyingTokenProgramId = cachedMintData.tokenProgram === 'token2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      console.log(`⏱️ [WRAP-TIMING] Token program from cache: ${cachedMintData.tokenProgram} +${Date.now() - startTime}ms`);
    } else {
      // Fetch and cache
      console.log(`⏱️ [WRAP-TIMING] Fetching token program from RPC...`);
      try {
        const mintAccountInfo = await ctx.connection.getAccountInfo(underlyingMintPubkey, 'processed');
        console.log(`⏱️ [WRAP-TIMING] Got mint account info: +${Date.now() - startTime}ms`);
        if (mintAccountInfo) {
          const isToken2022 = mintAccountInfo.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58();
          underlyingTokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
          setStaticMintData(riftData.underlyingMint, {
            decimals: decimals || 9,
            tokenProgram: isToken2022 ? 'token2022' : 'spl'
          });
        }
      } catch (e) {
        console.warn(`⚠️ [WRAP] Could not detect token program:`, e);
      }
    }

    // Get user ATAs
    console.log(`⏱️ [WRAP-TIMING] Getting user underlying ATA...`);
    const userUnderlyingAccount = await getAssociatedTokenAddress(
      underlyingMintPubkey,
      new PublicKey(params.user),
      false,
      underlyingTokenProgramId
    );
    console.log(`⏱️ [WRAP-TIMING] Got underlying ATA: +${Date.now() - startTime}ms`);

    // Create underlying ATA (idempotent)
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        new PublicKey(params.user),
        userUnderlyingAccount,
        new PublicKey(params.user),
        underlyingMintPubkey,
        underlyingTokenProgramId
      )
    );
    console.log(`⏱️ [WRAP-TIMING] Underlying ATA instruction added: +${Date.now() - startTime}ms`);

    // For WSOL, transfer SOL and sync
    const isNativeSOL = riftData.underlyingMint === 'So11111111111111111111111111111111111111112';
    if (isNativeSOL) {
      console.log(`⏱️ [WRAP-TIMING] Adding WSOL transfer instructions...`);
      const wrapAmount = Math.floor(params.amount * Math.pow(10, decimals));
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: new PublicKey(params.user),
          toPubkey: userUnderlyingAccount,
          lamports: wrapAmount,
        })
      );
      transaction.add(createSyncNativeInstruction(userUnderlyingAccount, TOKEN_PROGRAM_ID));
      console.log(`⏱️ [WRAP-TIMING] WSOL instructions added: +${Date.now() - startTime}ms`);
    }

    // Create rift token ATA
    console.log(`⏱️ [WRAP-TIMING] Getting rift token ATA...`);
    const isV1Rift = params.riftPubkey.toBase58() === 'CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL';
    const riftTokenProgramId = isV1Rift ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

    const userRiftAccount = await getAssociatedTokenAddress(
      new PublicKey(riftData.riftMint),
      new PublicKey(params.user),
      false,
      riftTokenProgramId
    );
    console.log(`⏱️ [WRAP-TIMING] Got rift ATA: +${Date.now() - startTime}ms`);

    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        new PublicKey(params.user),
        userRiftAccount,
        new PublicKey(params.user),
        new PublicKey(riftData.riftMint),
        riftTokenProgramId
      )
    );
    console.log(`⏱️ [WRAP-TIMING] Rift ATA instruction added: +${Date.now() - startTime}ms`);

    // Initialize vault if needed
    if (riftData.vault !== '11111111111111111111111111111111') {
      if (!vaultAccountInfo || vaultAccountInfo.data.length === 0) {
        console.log(`⏱️ [WRAP-TIMING] Creating vault init instruction...`);
        const initVaultIx = await helpers.createInitializeVaultInstruction(
          params.riftPubkey,
          new PublicKey(params.user)
        );
        console.log(`⏱️ [WRAP-TIMING] Vault init created: +${Date.now() - startTime}ms`);
        if (initVaultIx) {
          transaction.add(initVaultIx);
        } else {
          console.warn('⚠️ No initialize_vault instruction provided; skipping init');
        }
        riftData.vault = vaultPDA.toBase58();
      }
    }

    // Add wrap instruction (uses internal function)
    console.log(`⏱️ [WRAP-TIMING] Creating wrap instruction: +${Date.now() - startTime}ms`);
    const wrapInstruction = await createBasicWrapTokensInstruction(
      ctx,
      new PublicKey(params.user),
      params.riftPubkey,
      params.amount,
      decimals,
      riftData,
      params.slippageBps,
      underlyingTokenProgramId, // Pass token program to avoid RPC call!
      params.transferFeeBps // Pass transfer fee for accurate minRiftOut calculation
    );
    console.log(`⏱️ [WRAP-TIMING] Wrap instruction created: +${Date.now() - startTime}ms`);

    if (wrapInstruction) {
      transaction.add(wrapInstruction);
    } else {
      throw new Error('Failed to create wrap instruction');
    }

    // Set fee payer and blockhash (already fetched in parallel!)
    transaction.feePayer = new PublicKey(params.user);
    if (recentBlockhash) {
      transaction.recentBlockhash = recentBlockhash;
      console.log(`⏱️ [WRAP-TIMING] ✅ Transaction built with blockhash: +${Date.now() - startTime}ms`);
    } else {
      console.log(`⏱️ [WRAP-TIMING] ✅ Transaction built (blockhash will be fetched by wallet): +${Date.now() - startTime}ms`);
    }

    // Send transaction
    const t6 = Date.now();
    console.log(`⏱️ [WRAP-TIMING] 📤 Opening wallet popup... (total: +${Date.now() - startTime}ms)`);

    const signature = await ctx.wallet.sendTransaction(transaction, ctx.connection, {
      skipPreflight: true,
      maxRetries: 3
    } as any);
    const walletTime = Date.now() - t6;
    console.log(`⏱️ [WRAP-TIMING] ✅ Wallet signed & sent! Wallet time: ${walletTime}ms, sig=${signature.slice(0, 8)}...`);

    // Confirm transaction
    const t7 = Date.now();
    const confirmed = await helpers.confirmTransactionSafely(signature);
    console.log(`⏱️ [WRAP-TIMING] Confirmation: +${Date.now() - t7}ms, confirmed=${confirmed}`);

    if (confirmed) {
      const status = await ctx.connection.getSignatureStatus(signature);
      if (status?.value?.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
      }

      console.log(`⏱️ [WRAP-TIMING] 🎉 Transaction confirmed! Total: ${Date.now() - startTime}ms`);

      // Update TVL in background
      helpers.updateTvlInBackground(params.riftPubkey.toBase58(), params.amount, 'wrap').catch(() => {});

      return { success: true, signature, poolAddress: 'Pool created successfully' };
    } else {
      throw new Error('Transaction failed to confirm');
    }
  } catch (error) {
    console.error(`⏱️ [WRAP-TIMING] 💥 Error:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Wrap failed'
    };
  } finally {
    ctx.isWrapInProgress = false;
  }
}

// ============ BASIC WRAP TOKENS ============

export interface BasicWrapTokensParams {
  user: PublicKey;
  riftPubkey: PublicKey;
  amount: number;
  skipVaultInitialization?: boolean;
}

export async function basicWrapTokens(
  ctx: ServiceContext,
  params: BasicWrapTokensParams,
  helpers: {
    getRiftData: (pubkey: PublicKey, skipRetries?: boolean) => Promise<DecodedRiftData | null>;
    createBasicWrapTokensInstruction: (user: PublicKey, rift: PublicKey, amount: number) => Promise<TransactionInstruction | null>;
    createInitializeVaultInstruction: (rift: PublicKey, payer: PublicKey) => Promise<TransactionInstruction | null>;
    confirmTransactionSafely: (sig: string, skipWait?: boolean) => Promise<boolean>;
  }
): Promise<WrapTokensResult> {
  try {
    if (!ctx.wallet) {
      throw new Error('Wallet not connected');
    }

    // Get rift data
    const riftData = await helpers.getRiftData(params.riftPubkey, true);
    if (!riftData) {
      throw new Error('Rift not found');
    }

    // Create instruction
    const instruction = await helpers.createBasicWrapTokensInstruction(
      params.user,
      params.riftPubkey,
      params.amount
    );

    if (!instruction) {
      throw new Error('Failed to create basic wrap instruction');
    }

    // Import SPL Token
    const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createSyncNativeInstruction } = await import('@solana/spl-token');

    // Get user accounts
    const userUnderlyingAccount = await getAssociatedTokenAddress(
      new PublicKey(riftData.underlyingMint),
      params.user
    );

    const userRiftTokenAccount = await getAssociatedTokenAddress(
      new PublicKey(riftData.riftMint),
      params.user
    );

    // Create transaction
    const transaction = new Transaction();
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
    );

    // Check accounts and create if needed
    const underlyingAccountInfo = await ctx.connection.getAccountInfo(userUnderlyingAccount);
    if (!underlyingAccountInfo) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          params.user,
          userUnderlyingAccount,
          params.user,
          new PublicKey(riftData.underlyingMint)
        )
      );
    }

    const riftAccountInfo = await ctx.connection.getAccountInfo(userRiftTokenAccount);
    if (!riftAccountInfo) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          params.user,
          userRiftTokenAccount,
          params.user,
          new PublicKey(riftData.riftMint)
        )
      );
    }

    // Check vault
    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), params.riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    if (!params.skipVaultInitialization) {
      const vaultAccountInfo = await ctx.connection.getAccountInfo(vaultPDA, 'confirmed');
      if (!vaultAccountInfo) {
        const vaultInstruction = await helpers.createInitializeVaultInstruction(params.riftPubkey, params.user);
        if (vaultInstruction) {
          transaction.add(vaultInstruction);
        }
      }
    }

    // For SOL wrapping
    if (riftData.underlyingMint === 'So11111111111111111111111111111111111111112') {
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: params.user,
          toPubkey: userUnderlyingAccount,
          lamports: Math.floor(params.amount * 1e9),
        })
      );
      transaction.add(createSyncNativeInstruction(userUnderlyingAccount));
    }

    transaction.add(instruction);
    transaction.feePayer = ctx.wallet.publicKey!;

    // Send
    const signature = await ctx.wallet.sendTransaction(transaction, ctx.connection, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 5
    });

    await helpers.confirmTransactionSafely(signature, true);

    return { success: true, signature };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Basic wrap failed'
    };
  }
}

// ============ CREATE BASIC WRAP INSTRUCTION ============

export async function createBasicWrapTokensInstruction(
  ctx: ServiceContext,
  user: PublicKey,
  riftPubkey: PublicKey,
  amount: number,
  decimals?: number,
  cachedRiftData?: DecodedRiftData,
  slippageBps?: number,
  underlyingTokenProgramId?: PublicKey, // Pass this to avoid RPC call
  transferFeeBps?: number // Token-2022 transfer fee for accurate minRiftOut calculation
): Promise<TransactionInstruction | null> {
  const ixStart = Date.now();
  try {
    console.log('🔨 [WRAP-IX] START Creating instruction:', {
      user: user.toBase58().slice(0, 8),
      rift: riftPubkey.toBase58().slice(0, 8),
      amount,
      cached: !!cachedRiftData,
      hasProgram: !!underlyingTokenProgramId
    });

    // Use cached rift data if provided
    let riftData = cachedRiftData;
    if (!riftData) {
      console.log(`⏱️ [WRAP-IX] +${Date.now() - ixStart}ms: Fetching rift (NOT CACHED - SLOW!)`);
      const riftAccount = await ctx.connection.getAccountInfo(riftPubkey);
      console.log(`⏱️ [WRAP-IX] +${Date.now() - ixStart}ms: Got rift account`);
      if (!riftAccount) {
        console.error('[ERROR] WRAP INSTRUCTION DEBUG: Rift account not found');
        return null;
      }
      const { decodeRiftAccount } = await import('./utils');
      riftData = decodeRiftAccount(riftAccount.data);
    } else {
      console.log(`⏱️ [WRAP-IX] +${Date.now() - ixStart}ms: Using cached rift data`);
    }

    // Get decimals - MUST be provided (already fetched by caller)
    const tokenDecimals = decimals ?? 9;
    console.log(`⏱️ [WRAP-IX] +${Date.now() - ixStart}ms: Decimals=${tokenDecimals}`);

    // Create instruction data buffer: discriminator (8) + amount (8) + min_rift_out (8) = 24 bytes
    const instructionData = Buffer.alloc(24);
    let offset = 0;

    // Create wrap_tokens instruction discriminator
    const discriminator = Buffer.from([244, 137, 57, 251, 232, 224, 54, 14]);
    discriminator.copy(instructionData, offset);
    offset += 8;

    // Use actual token decimals
    const amountLamports = BigInt(Math.floor(amount * Math.pow(10, tokenDecimals)));

    // Calculate min_rift_out with slippage protection AND transfer fee deduction
    // For Token-2022 tokens with transfer fees, the vault receives: amount * (1 - transferFee)
    // Then apply slippage tolerance: receivedAmount * (1 - slippage)
    // Formula: minRiftOut = amount * (10000 - transferFeeBps) / 10000 * (10000 - slippageBps) / 10000
    let minRiftOut = BigInt(0);
    if (slippageBps !== undefined || transferFeeBps !== undefined) {
      const effectiveTransferFee = transferFeeBps ?? 0;
      const effectiveSlippage = slippageBps ?? 50; // Default 0.5% slippage if not specified

      // First deduct transfer fee, then apply slippage
      // Adding 50bps (0.5%) extra buffer for rounding and other on-chain calculations
      const safetyBufferBps = 50;
      const totalDeductionBps = effectiveTransferFee + effectiveSlippage + safetyBufferBps;

      // Ensure we don't go negative (cap at 5000 bps = 50% max deduction)
      const cappedDeductionBps = Math.min(totalDeductionBps, 5000);

      minRiftOut = amountLamports * BigInt(10000 - cappedDeductionBps) / BigInt(10000);

      console.log(`🔐 [SLIPPAGE] Transfer fee: ${effectiveTransferFee}bps, Slippage: ${effectiveSlippage}bps, Buffer: ${safetyBufferBps}bps, Total deduction: ${cappedDeductionBps}bps, minRiftOut: ${minRiftOut.toString()}`);
    }

    // Browser-compatible BigInt writing using DataView
    const dataView = new DataView(instructionData.buffer, instructionData.byteOffset, instructionData.byteLength);
    dataView.setBigUint64(offset, amountLamports, true);
    offset += 8;
    dataView.setBigUint64(offset, minRiftOut, true);
    console.log(`⏱️ [WRAP-IX] +${Date.now() - ixStart}ms: Instruction data built`);

    // Import SPL Token utilities
    console.log(`⏱️ [WRAP-IX] +${Date.now() - ixStart}ms: Importing spl-token...`);
    const { getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
    console.log(`⏱️ [WRAP-IX] +${Date.now() - ixStart}ms: spl-token imported`);

    // Determine which program ID to use for this rift
    const programId = getProgramIdForRift(riftPubkey.toBase58());

    // Use provided token program (already detected by caller) - NO RPC call needed!
    const underlyingTokenProgram = underlyingTokenProgramId ?? TOKEN_PROGRAM_ID;
    console.log(`⏱️ [WRAP-IX] +${Date.now() - ixStart}ms: Token program: ${underlyingTokenProgram.toBase58().slice(0, 8)}`);

    // Calculate required PDAs (instant - no RPC)
    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), riftPubkey.toBuffer()],
      programId
    );

    const [riftMintAuthPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('rift_mint_auth'), riftPubkey.toBuffer()],
      programId
    );
    console.log(`⏱️ [WRAP-IX] +${Date.now() - ixStart}ms: PDAs derived`);

    // Calculate user token accounts (just address derivation, no RPC)
    const underlyingMintPubkey = new PublicKey(riftData.underlyingMint);
    console.log(`⏱️ [WRAP-IX] +${Date.now() - ixStart}ms: Getting user underlying ATA...`);
    const userUnderlyingAccount = await getAssociatedTokenAddress(
      underlyingMintPubkey,
      user,
      false,
      underlyingTokenProgram
    );
    console.log(`⏱️ [WRAP-IX] +${Date.now() - ixStart}ms: Got user underlying ATA`);

    // Detect V1 rift and use correct token program
    const isV1Rift = riftPubkey.toBase58() === 'CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL';
    const riftTokenProgram = isV1Rift ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

    console.log(`⏱️ [WRAP-IX] +${Date.now() - ixStart}ms: Getting user rift ATA...`);
    const userRiftTokenAccount = await getAssociatedTokenAddress(
      new PublicKey(riftData.riftMint),
      user,
      false,
      riftTokenProgram
    );
    console.log(`⏱️ [WRAP-IX] +${Date.now() - ixStart}ms: Got user rift ATA`);

    // Calculate fees_vault PDA
    const [feesVaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('fees_vault'), riftPubkey.toBuffer()],
      programId
    );

    // Calculate vault_authority PDA
    const [vaultAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault_auth'), riftPubkey.toBuffer()],
      programId
    );
    console.log(`⏱️ [WRAP-IX] +${Date.now() - ixStart}ms: All PDAs done`);

    // Create the instruction with ALL wrap_tokens accounts
    const accountKeys = [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: riftPubkey, isSigner: false, isWritable: true },
      { pubkey: userUnderlyingAccount, isSigner: false, isWritable: true },
      { pubkey: userRiftTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vaultPDA, isSigner: false, isWritable: true },
    ];

    if (isV1Rift) {
      // V1: rift_mint, rift_mint_authority, token_program (positions 5-7)
      accountKeys.push(
        { pubkey: new PublicKey(riftData.riftMint), isSigner: false, isWritable: true },
        { pubkey: riftMintAuthPDA, isSigner: false, isWritable: false },
        { pubkey: underlyingTokenProgram, isSigner: false, isWritable: false }
      );
    } else {
      // V2: Has underlying_mint, fees_vault, vault_authority, TWO token programs, system_program
      accountKeys.push(
        { pubkey: new PublicKey(riftData.underlyingMint), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(riftData.riftMint), isSigner: false, isWritable: true },
        { pubkey: riftMintAuthPDA, isSigner: false, isWritable: false },
        { pubkey: feesVaultPDA, isSigner: false, isWritable: true },
        { pubkey: vaultAuthorityPDA, isSigner: false, isWritable: false },
        { pubkey: underlyingTokenProgram, isSigner: false, isWritable: false },
        { pubkey: riftTokenProgram, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
      );
    }

    console.log(`⏱️ [WRAP-IX] +${Date.now() - ixStart}ms: ✅ DONE - Instruction created`);
    return new TransactionInstruction({
      keys: accountKeys,
      programId: programId,
      data: instructionData
    });

  } catch (error) {
    console.error('[ERROR] WRAP INSTRUCTION DEBUG: Error creating instruction:', error);
    return null;
  }
}
