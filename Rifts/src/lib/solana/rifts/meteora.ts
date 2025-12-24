// lib/solana/rifts/meteora.ts - Meteora DAMM v2 pool integration functions
import {
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  ServiceContext,
  WalletAdapter,
  ProductionRiftData,
  METEORA_DAMM_V2_PROGRAM_ID,
} from './types';
import { getRiftData, updateRiftInCache, saveRiftsToSupabase } from './data';
import { decodeRiftAccount } from './utils';

// Build a connection that routes JSON-RPC over our HTTP proxy (avoids gRPC/empty-body responses)
const getMeteoraConnection = (ctxConnection: Connection): Connection => {
  if (typeof window !== 'undefined') {
    return new Connection('https://proxy', {
      commitment: 'confirmed',
      wsEndpoint: 'wss://localhost:1',
      disableRetryOnRateLimit: true,
      confirmTransactionInitialTimeout: 60000,
      fetch: async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        return fetch('/api/rpc-http', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: init?.body,
        });
      },
    });
  }
  // Server-side: unwrap RateLimitedConnection if present
  return (ctxConnection as any).connection || ctxConnection;
};

// ============ TYPES ============

export interface CreatePoolParams {
  riftPubkey: PublicKey;
  riftAmount: number;
  otherAmount: number;
  binStep?: number;
  baseFactor?: number;
  useUnderlyingToken?: boolean;
  underlyingMint?: string;
}

export interface CreatePoolResult {
  success: boolean;
  signature?: string;
  error?: string;
  poolAddress?: string;
  positionNftMint?: string;
}

export interface RemoveLiquidityParams {
  poolAddress: string;
  lpTokenAmount: number;
  riftPubkey: PublicKey;
}

export interface RemoveLiquidityResult {
  success: boolean;
  signature?: string;
  error?: string;
  tokensReceived?: { token0: number; token1: number };
}

export interface SwapParams {
  poolAddress: string;
  inputMint: string;
  outputMint: string;
  amount: number;
  slippageBps?: number;
  wallet: WalletAdapter;
}

// ============ POOL CREATION ============

/**
 * Create a Meteora DAMM v2 pool with liquidity
 */
export async function createMeteoraPool(
  ctx: ServiceContext,
  params: CreatePoolParams
): Promise<CreatePoolResult> {
  ctx.isWrapInProgress = true;

  const startTime = Date.now();
  console.log('🔧 [CREATE-POOL] Starting pool creation with params:', params);

  if (!ctx.wallet) {
    console.error('❌ Wallet not connected');
    return { success: false, error: 'Wallet not connected' };
  }

  try {
    const riftId = params.riftPubkey.toBase58();
    let riftData: any = null;

    // Try server cache first
    try {
      const cacheResponse = await fetch(`/api/rift-data?id=${riftId}`);
      if (cacheResponse.ok) {
        const cacheData = await cacheResponse.json();
        if (cacheData.success && cacheData.cached) {
          riftData = {
            underlyingMint: cacheData.data.underlyingMint,
            riftMint: cacheData.data.riftMint,
            vault: cacheData.data.vaultAddress
          };
        }
      }
    } catch (error) {
      console.log(`⏱️ [ADD-LIQUIDITY] ⚠️ Server cache miss`);
    }

    if (!riftData) {
      riftData = await getRiftData(ctx, params.riftPubkey);
    }

    if (!riftData) {
      throw new Error('Rift data not found');
    }

    const { getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } = await import('@solana/spl-token');

    let riftAmount = params.riftAmount;
    let otherAmount = params.otherAmount;

    // Check rRIFT token balance
    const userRiftAta = await getAssociatedTokenAddress(
      new PublicKey(riftData.riftMint),
      ctx.wallet.publicKey!,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const rawConnection = getMeteoraConnection(ctx.connection);
    const riftBalance = await rawConnection.getTokenAccountBalance(userRiftAta).catch(() => {
      return { value: { uiAmount: 0, uiAmountString: '0' } };
    });
    const availableRrifts = parseFloat(riftBalance.value.uiAmountString || '0');

    console.log('💰 rRIFT Balance:', {
      available: availableRrifts.toFixed(6),
      required: riftAmount.toFixed(6)
    });

    // Adjust for transfer fees if near max
    if (availableRrifts < riftAmount) {
      const diffPercent = ((riftAmount - availableRrifts) / riftAmount) * 100;
      if (diffPercent < 2.0) {
        riftAmount = availableRrifts * 0.98;
        params.riftAmount = riftAmount;
      } else {
        throw new Error(`Insufficient rRIFT tokens. Need ${(riftAmount - availableRrifts).toFixed(6)} more.`);
      }
    } else if (Math.abs(availableRrifts - riftAmount) / riftAmount < 0.02) {
      riftAmount = riftAmount * 0.98;
      params.riftAmount = riftAmount;
    }

    // Check other token balance
    if (params.useUnderlyingToken) {
      const underlyingMintPubkey = new PublicKey(riftData.underlyingMint);
      const underlyingMintInfo = await rawConnection.getAccountInfo(underlyingMintPubkey);
      const underlyingTokenProgram = underlyingMintInfo?.owner?.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;

      const underlyingAta = await getAssociatedTokenAddress(
        underlyingMintPubkey,
        ctx.wallet.publicKey!,
        false,
        underlyingTokenProgram
      );

      const underlyingBalance = await rawConnection.getTokenAccountBalance(underlyingAta).catch(() => {
        return { value: { uiAmount: 0, uiAmountString: '0' } };
      });
      const availableUnderlying = parseFloat(underlyingBalance.value.uiAmountString || '0');

      if (availableUnderlying < otherAmount) {
        const diffPercent = ((otherAmount - availableUnderlying) / otherAmount) * 100;
        if (diffPercent < 2.0) {
          otherAmount = availableUnderlying * 0.98;
          params.otherAmount = otherAmount;
        } else {
          throw new Error(`Insufficient underlying tokens. Need ${(otherAmount - availableUnderlying).toFixed(6)} more.`);
        }
      }
    } else {
      // Use the same raw connection we use for token balances to avoid discrepancies from proxies
      const balanceLamports = await rawConnection.getBalance(ctx.wallet.publicKey!);
      const balanceSOL = balanceLamports / LAMPORTS_PER_SOL;
      // Keep a small SOL buffer for rent + fees (~0.003 SOL is enough for 2 ATAs + tx)
      const feeReserveSOL = 0.003;
      const availableForPool = Math.max(0, balanceSOL - feeReserveSOL);

      if (availableForPool < otherAmount) {
        const diffPercent = ((otherAmount - availableForPool) / otherAmount) * 100;
        if (diffPercent < 2.0) {
          otherAmount = availableForPool * 0.95;
          params.otherAmount = otherAmount;
        } else {
          throw new Error(`Insufficient SOL. Need ${(otherAmount - availableForPool).toFixed(6)} more.`);
        }
      }
    }

    console.log('✅ [CREATE-POOL] All balance checks passed! Creating pool...');

    // Create pool with existing tokens
    const poolCreationResult = await createMeteoraPoolWithLiquidity(
      ctx,
      ctx.wallet.publicKey!,
      params.riftPubkey,
      riftAmount,
      otherAmount,
      params.useUnderlyingToken || false,
      params.underlyingMint
    );

    if (!poolCreationResult.success) {
      throw new Error(poolCreationResult.error || 'Failed to create Meteora pool');
    }

    // Store pool info
    if (poolCreationResult.poolAddress && poolCreationResult.positionNftMint) {
      const poolType = params.underlyingMint
        ? (params.underlyingMint === 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB' ? 'USD1' : 'RIFTS')
        : (params.useUnderlyingToken ? 'RIFTS' : 'SOL');

      updateRiftInCache(ctx, params.riftPubkey.toBase58(), {
        meteoraPool: poolCreationResult.poolAddress,
        positionNftMint: poolCreationResult.positionNftMint,
        hasMeteoraPool: true,
        meteoraPoolType: poolType as any,
        solPool: poolType === 'SOL' ? poolCreationResult.poolAddress : undefined,
        riftsPool: poolType === 'RIFTS' ? poolCreationResult.poolAddress : undefined,
        usd1Pool: poolType === 'USD1' ? poolCreationResult.poolAddress : undefined
      });

      // Save to Supabase
      try {
        const riftDataFromCache = ctx.riftsCache.find(r => r.id === params.riftPubkey.toBase58());
        if (riftDataFromCache) {
          await saveRiftsToSupabase([{
            ...riftDataFromCache,
            meteoraPool: poolCreationResult.poolAddress,
            positionNftMint: poolCreationResult.positionNftMint,
            hasMeteoraPool: true,
            meteoraPoolType: poolType as any,
          }]);
        }
      } catch (err) {
        console.warn('⚠️ Failed to save pool type to Supabase:', err);
      }
    }

    const totalTime = Date.now() - startTime;
    console.log(`⏱️ [CREATE-POOL] Total time: ${totalTime}ms`);

    return {
      success: true,
      signature: poolCreationResult.signature,
      poolAddress: poolCreationResult.poolAddress,
      positionNftMint: poolCreationResult.positionNftMint
    };

  } catch (error) {
    console.error('❌ createMeteoraPool error:', error);
    return { success: false, error: (error as Error).message };
  } finally {
    ctx.isWrapInProgress = false;
  }
}

/**
 * Internal function to create pool with liquidity
 */
async function createMeteoraPoolWithLiquidity(
  ctx: ServiceContext,
  user: PublicKey,
  riftPubkey: PublicKey,
  riftAmount: number,
  wsolAmount: number,
  useUnderlyingToken: boolean = false,
  customMint?: string
): Promise<CreatePoolResult> {
  const startTime = Date.now();
  console.log('[POOL-WITH-LIQ] Starting pool creation with liquidity...');

  try {
    // Use Meteora public config with 0.25% base fee, no dynamic fee
    const METEORA_CONFIG = new PublicKey('FzvMYBQ29z2J21QPsABpJYYxQBEKGsxA6w6J2HYceFj8');

    // Get rift data
    const riftAccount = await ctx.connection.getAccountInfo(riftPubkey);
    if (!riftAccount) {
      throw new Error('Rift account not found');
    }
    const riftData = decodeRiftAccount(riftAccount.data);

    // Token selection (match backup logic): tokenA = SOL/underlying/custom, tokenB = rRIFT
    const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
    const riftMintPubkey = new PublicKey(riftData.riftMint);
    const tokenAMintPubkey = customMint
      ? new PublicKey(customMint)
      : (useUnderlyingToken ? new PublicKey(riftData.underlyingMint) : WSOL_MINT);
    const tokenBMintPubkey = riftMintPubkey;

    console.log('[POOL-WITH-LIQ] Token configuration:', {
      tokenA: tokenAMintPubkey.toBase58(),
      tokenB: tokenBMintPubkey.toBase58(),
      useUnderlyingToken,
      customMint
    });

    // Import dependencies
    const { CpAmm, derivePoolAddress } = await import('@meteora-ag/cp-amm-sdk');
    const BN = (await import('bn.js')).default;
    const {
      TOKEN_2022_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      getMint,
    } = await import('@solana/spl-token');

    // Meteora connection (proxyed on client)
    const meteoraConnection = getMeteoraConnection(ctx.connection);
    const cpAmm = new (CpAmm as any)(meteoraConnection, METEORA_DAMM_V2_PROGRAM_ID);

    // Deterministic pool PDA per (config, tokenA, tokenB). If it already exists, don't proceed.
    try {
      const derivedPool = derivePoolAddress(METEORA_CONFIG, tokenAMintPubkey, tokenBMintPubkey);
      const exists = await cpAmm.isPoolExist(derivedPool);
      if (exists) {
        return {
          success: false,
          error:
            'Pool already exists for this token pair and config. Please use Add Liquidity instead of creating a new pool.',
          poolAddress: derivedPool.toBase58(),
        };
      }
    } catch (checkErr) {
      console.warn('[POOL-WITH-LIQ] Pool existence check failed, continuing:', checkErr);
    }

    // Detect token programs
    const tokenAMintInfo = await meteoraConnection.getAccountInfo(tokenAMintPubkey);
    const tokenBMintInfo = await meteoraConnection.getAccountInfo(tokenBMintPubkey);

    const tokenAProgram = tokenAMintInfo?.owner?.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
    const tokenBProgram = tokenBMintInfo?.owner?.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;

    console.log('[POOL-WITH-LIQ] Token programs:', {
      tokenA: tokenAProgram.toBase58(),
      tokenB: tokenBProgram.toBase58()
    });

    // Fetch decimals for accurate price/liquidity setup
    const tokenAMintInfoParsed = await getMint(meteoraConnection, tokenAMintPubkey, 'confirmed', tokenAProgram);
    const tokenBMintInfoParsed = await getMint(meteoraConnection, tokenBMintPubkey, 'confirmed', tokenBProgram);
    const tokenADecimals = tokenAMintInfoParsed.decimals ?? 9;
    const tokenBDecimals = tokenBMintInfoParsed.decimals ?? 9;
    console.log('[POOL-WITH-LIQ] Decimals:', { tokenADecimals, tokenBDecimals });

    // Derive price from user inputs (rRIFT per tokenA)
    const initPrice = wsolAmount > 0 ? riftAmount / wsolAmount : 1;
    const getSqrtPriceFromPrice = (price: number, tokenADec: number, tokenBDec: number) => {
      const decimalDiff = tokenBDec - tokenADec;
      const adjustedPrice = price * Math.pow(10, decimalDiff);
      const sqrtPrice = Math.sqrt(adjustedPrice);
      const Q64_STRING = '18446744073709551616';
      const scaledPrice = BigInt(Math.floor(sqrtPrice * 1e18));
      const Q64_BIGINT = BigInt(Q64_STRING);
      const resultBigInt = (scaledPrice * Q64_BIGINT) / BigInt(1e18);
      return new BN(resultBigInt.toString());
    };
    const initSqrtPrice = getSqrtPriceFromPrice(initPrice, tokenADecimals, tokenBDecimals);

    // Convert inputs to lamports
    const tokenAAmountLamports = Math.floor(wsolAmount * Math.pow(10, tokenADecimals));
    const tokenBAmountLamports = Math.floor(riftAmount * Math.pow(10, tokenBDecimals));

    console.log('[POOL-WITH-LIQ] Price/amounts:', {
      initPrice,
      tokenAAmountLamports,
      tokenBAmountLamports
    });

    // Fetch config to get min/max sqrt price bounds
    const configState = await cpAmm.fetchConfigState(METEORA_CONFIG);

    // Get deposit quote to derive liquidity and matched amounts (SDK handles Token-2022 fees)
    const depositQuote = await cpAmm.getDepositQuote({
      inAmount: new BN(tokenAAmountLamports),
      isTokenA: true,
      minSqrtPrice: configState.sqrtMinPrice,
      maxSqrtPrice: configState.sqrtMaxPrice,
      sqrtPrice: initSqrtPrice,
    });

    const tokenAAmountBN = depositQuote.consumedInputAmount
      || depositQuote.actualInputAmount
      || new BN(tokenAAmountLamports);
    const tokenBAmountBN = depositQuote.outputAmount
      || new BN(tokenBAmountLamports);
    const liquidityDelta = depositQuote.liquidityDelta;

    console.log('[POOL-WITH-LIQ] Deposit quote:', {
      tokenAAmountBN: tokenAAmountBN.toString(),
      tokenBAmountBN: tokenBAmountBN.toString(),
      liquidityDelta: liquidityDelta?.toString?.(),
    });

    // Position NFT mint (required by Meteora SDK)
    const positionNftMint = Keypair.generate();

    // Create pool
    console.log('[POOL-WITH-LIQ] Creating pool with Meteora SDK...');
    const createPoolResult = await cpAmm.createPool({
      payer: user,
      creator: user,
      config: METEORA_CONFIG,
      positionNft: positionNftMint.publicKey,
      tokenAMint: tokenAMintPubkey,
      tokenBMint: tokenBMintPubkey,
      initSqrtPrice,
      liquidityDelta,
      tokenAAmount: tokenAAmountBN,
      tokenBAmount: tokenBAmountBN,
      tokenAProgram,
      tokenBProgram,
      activationPoint: null,
      isLockLiquidity: false,
    });
    console.log('[POOL-WITH-LIQ] createPool params sent:', {
      initSqrtPrice: initSqrtPrice?.toString?.(),
      liquidityDelta: liquidityDelta?.toString?.(),
      tokenAAmount: tokenAAmountBN.toString(),
      tokenBAmount: tokenBAmountBN.toString()
    });

    // Build transaction
    let createPoolTx;
    if (typeof createPoolResult.transaction === 'function') {
      createPoolTx = await createPoolResult.transaction();
    } else if ((createPoolResult as any)?.tx) {
      createPoolTx = (createPoolResult as any).tx;
    } else {
      createPoolTx = createPoolResult as Transaction;
    }

    // Add compute budget
    createPoolTx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })
    );

    // Set fee payer and a fresh blockhash for simulation + partial signing
    const { blockhash } = await meteoraConnection.getLatestBlockhash('confirmed');
    createPoolTx.recentBlockhash = blockhash;
    createPoolTx.feePayer = user;
    createPoolTx.partialSign(positionNftMint);

    // Pre-simulate via RPC proxy to catch issues before prompting wallet
    try {
      const simTx = Transaction.from(
        createPoolTx.serialize({ requireAllSignatures: false, verifySignatures: false })
      );
      const { blockhash } = await meteoraConnection.getLatestBlockhash('confirmed');
      simTx.recentBlockhash = blockhash;
      const simEncoded = simTx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
      console.log('[POOL-WITH-LIQ] Pre-simulating pool creation (sigVerify: false)...');
      const simResp = await fetch('/api/rpc-http', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'sim_meteora_pool',
          method: 'simulateTransaction',
          params: [
            simEncoded,
            {
              encoding: 'base64',
              sigVerify: false,
              commitment: 'processed',
              replaceRecentBlockhash: true,
            },
          ],
        }),
      });
      const simJson = await simResp.json();
      if (simJson.error) {
        console.log('[POOL-WITH-LIQ] ❌ Pool sim RPC error:', simJson.error);
        throw new Error(simJson.error.message || 'Pool simulation RPC error');
      }
      if (simJson.result?.value?.err) {
        console.log('[POOL-WITH-LIQ] ❌ Pool sim failed:', simJson.result.value.err, simJson.result.value.logs);
        throw new Error(`Pool simulation failed: ${JSON.stringify(simJson.result.value.err)}`);
      }
      console.log('[POOL-WITH-LIQ] ✅ Pool simulation passed, units:', simJson.result?.value?.unitsConsumed);
    } catch (simErr: any) {
      console.log('[POOL-WITH-LIQ] Pool simulation error:', simErr?.message || simErr);
      throw simErr;
    }

    // Send transaction (wallet signs)
    if (!ctx.wallet?.sendTransaction) {
      throw new Error('Wallet does not support sendTransaction');
    }
    console.log('[POOL-WITH-LIQ] Sending pool creation transaction...');
    const signature = await ctx.wallet.sendTransaction(createPoolTx, meteoraConnection);

    console.log('[POOL-WITH-LIQ] Transaction sent:', signature);

    // Confirm
    await confirmTransactionSafely(ctx, signature);

    // Extract pool address and position NFT
    const poolAddress = createPoolResult.pool?.toBase58() || (createPoolResult as any).poolAddress;
    const positionNftMintStr = createPoolResult.positionNftMint?.toBase58() || positionNftMint.publicKey.toBase58();

    console.log('[POOL-WITH-LIQ] Pool created:', { poolAddress, positionNftMint: positionNftMintStr });

    return {
      success: true,
      signature,
      poolAddress,
      positionNftMint: positionNftMintStr
    };

  } catch (error) {
    console.error('[POOL-WITH-LIQ] Error:', error);
    return {
      success: false,
      error: (error as Error).message
    };
  }
}

// ============ LIQUIDITY REMOVAL ============

/**
 * Remove liquidity from a Meteora pool
 */
export async function removeMeteoraLiquidity(
  ctx: ServiceContext,
  params: RemoveLiquidityParams
): Promise<RemoveLiquidityResult> {
  if (!ctx.wallet) {
    return { success: false, error: 'Wallet not connected' };
  }

  try {
    const userPublicKey = ctx.wallet.publicKey!;

    // Get rift data
    const riftData = await getRiftData(ctx, params.riftPubkey);
    if (!riftData) {
      return { success: false, error: 'Rift data not found' };
    }

    // Get actual pool address
    let actualPoolAddress = (riftData as any).meteoraPool || params.poolAddress;
    let poolPubkey = new PublicKey(actualPoolAddress);

    // Verify pool exists
    const poolAccount = await ctx.connection.getAccountInfo(poolPubkey);
    if (!poolAccount) {
      const paramPoolPubkey = new PublicKey(params.poolAddress);
      const paramPoolAccount = await ctx.connection.getAccountInfo(paramPoolPubkey);
      if (paramPoolAccount) {
        actualPoolAddress = params.poolAddress;
        poolPubkey = paramPoolPubkey;
      } else {
        return { success: false, error: 'Pool not found on-chain' };
      }
    }

    // Import dependencies
    const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
    const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } = await import('@solana/spl-token');
    const BN = (await import('bn.js')).default;

    const rawConnection = getMeteoraConnection(ctx.connection);
    const cpAmm = new (CpAmm as any)(rawConnection, METEORA_DAMM_V2_PROGRAM_ID);

    // Get pool state
    const poolState = await cpAmm.fetchPoolState(poolPubkey);

    // Calculate liquidity to remove
    const totalLiquidity = poolState.liquidity;
    const permanentLockLiquidity = poolState.permanentLockLiquidity || new BN(0);
    const userLiquidity = totalLiquidity.sub(permanentLockLiquidity);

    if (userLiquidity.isZero()) {
      return { success: false, error: 'No liquidity available to remove' };
    }

    const withdrawPercentage = Math.min(params.lpTokenAmount, 100) / 100;
    const percentage = new BN(Math.floor(withdrawPercentage * 10000));
    const liquidityToRemove = userLiquidity.mul(percentage).div(new BN(10000));

    // Get withdrawal quote
    const minSqrtPrice = poolState.sqrtMinPrice || poolState.minSqrtPrice;
    const maxSqrtPrice = poolState.sqrtMaxPrice || poolState.maxSqrtPrice;
    const sqrtPrice = poolState.sqrtPrice || poolState.currentSqrtPrice;

    const withdrawQuote = await cpAmm.getWithdrawQuote({
      liquidityDelta: liquidityToRemove,
      sqrtPrice: BN.isBN(sqrtPrice) ? sqrtPrice : new BN(sqrtPrice.toString()),
      minSqrtPrice: BN.isBN(minSqrtPrice) ? minSqrtPrice : new BN(minSqrtPrice.toString()),
      maxSqrtPrice: BN.isBN(maxSqrtPrice) ? maxSqrtPrice : new BN(maxSqrtPrice.toString())
    });

    const token0Amount = (withdrawQuote.outAmountA || withdrawQuote.tokenAAmount).toNumber() / 1e9;
    const token1Amount = (withdrawQuote.outAmountB || withdrawQuote.tokenBAmount).toNumber() / 1e9;

    // Get position NFT
    const positionNftMintStr = (riftData as any)?.positionNftMint;
    if (!positionNftMintStr) {
      return { success: false, error: 'Position NFT not found' };
    }

    const positionNftMint = new PublicKey(positionNftMintStr);
    const positionNftAccount = await getAssociatedTokenAddress(
      positionNftMint,
      userPublicKey
    );

    // Find position PDA
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), positionNftMint.toBuffer()],
      METEORA_DAMM_V2_PROGRAM_ID
    );

    // Build remove liquidity transaction
    const amountA = withdrawQuote.outAmountA || withdrawQuote.tokenAAmount;
    const amountB = withdrawQuote.outAmountB || withdrawQuote.tokenBAmount;

    const removeLiquidityBuilder = await cpAmm.removeLiquidity({
      owner: userPublicKey,
      pool: poolPubkey,
      position: positionPda,
      positionNftAccount,
      liquidityDelta: liquidityToRemove,
      tokenAAmountThreshold: amountA.muln(0.95),
      tokenBAmountThreshold: amountB.muln(0.95),
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      vestings: []
    });

    let removeLiquidityTx;
    if (typeof removeLiquidityBuilder.transaction === 'function') {
      removeLiquidityTx = await removeLiquidityBuilder.transaction();
    } else {
      removeLiquidityTx = removeLiquidityBuilder;
    }

    removeLiquidityTx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1500 })
    );

    removeLiquidityTx.feePayer = userPublicKey;

    const signature = await ctx.wallet.sendTransaction(removeLiquidityTx, ctx.connection, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 5
    });

    await confirmTransactionSafely(ctx, signature, true);

    return {
      success: true,
      signature,
      tokensReceived: { token0: token0Amount, token1: token1Amount }
    };

  } catch (error) {
    console.error('[REMOVE-LIQUIDITY] Error:', error);
    return {
      success: false,
      error: (error as Error).message
    };
  }
}

// ============ POOL QUERIES ============

/**
 * Find a Meteora pool for a token pair
 */
export async function findMeteoraPool(
  ctx: ServiceContext,
  mintA: string,
  mintB: string
): Promise<string | null> {
  try {
    const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
    const cpAmm = new CpAmm(getMeteoraConnection(ctx.connection));

    const accounts = await ctx.connection.getProgramAccounts(METEORA_DAMM_V2_PROGRAM_ID, {
      commitment: 'confirmed',
      encoding: 'base64',
    });

    for (const { pubkey } of accounts) {
      try {
        const poolState = await cpAmm.fetchPoolState(pubkey);
        const tokenA = poolState.tokenAMint?.toBase58();
        const tokenB = poolState.tokenBMint?.toBase58();

        if (
          (tokenA === mintA && tokenB === mintB) ||
          (tokenA === mintB && tokenB === mintA)
        ) {
          return pubkey.toBase58();
        }
      } catch (e) {
        continue;
      }
    }

    return null;
  } catch (error) {
    console.error('[FIND-POOL] Error:', error);
    return null;
  }
}

/**
 * Get price from a Meteora pool
 */
export async function getMeteoraPoolPrice(
  ctx: ServiceContext,
  poolAddress: string
): Promise<number> {
  try {
    const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
    const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');

    const cpAmm = new CpAmm(ctx.connection);
    const poolPubkey = new PublicKey(poolAddress);
    const poolState = await cpAmm.fetchPoolState(poolPubkey);

    // Fetch vault account info directly to handle both Token and Token-2022
    const [tokenAVaultInfo, tokenBVaultInfo, tokenAMintInfo, tokenBMintInfo] = await Promise.all([
      ctx.connection.getAccountInfo(poolState.tokenAVault),
      ctx.connection.getAccountInfo(poolState.tokenBVault),
      ctx.connection.getAccountInfo(poolState.tokenAMint),
      ctx.connection.getAccountInfo(poolState.tokenBMint)
    ]);

    if (!tokenAVaultInfo || !tokenBVaultInfo || !tokenAMintInfo || !tokenBMintInfo) {
      throw new Error('Could not fetch pool account info');
    }

    // Parse token account data - amount is at offset 64 for both Token and Token-2022
    // (8 bytes mint + 32 bytes owner + 8 bytes amount = offset 64 for amount)
    // Actually for SPL Token: mint(32) + owner(32) + amount(8) = amount at offset 64
    const tokenAAmount = Number(tokenAVaultInfo.data.readBigUInt64LE(64));
    const tokenBAmount = Number(tokenBVaultInfo.data.readBigUInt64LE(64));

    // Parse mint decimals - decimals is at byte 44 for both Token and Token-2022
    const tokenADecimals = tokenAMintInfo.data[44];
    const tokenBDecimals = tokenBMintInfo.data[44];

    const tokenAAmountDecimal = tokenAAmount / Math.pow(10, tokenADecimals);
    const tokenBAmountDecimal = tokenBAmount / Math.pow(10, tokenBDecimals);

    const WSOL_MINT = 'So11111111111111111111111111111111111111112';
    const isSolTokenA = poolState.tokenAMint.toBase58() === WSOL_MINT;

    // Price = SOL per token (how much SOL for 1 token)
    const price = isSolTokenA
      ? tokenAAmountDecimal / tokenBAmountDecimal
      : tokenBAmountDecimal / tokenAAmountDecimal;

    console.log('📊 Meteora Pool Price:', {
      poolAddress,
      price,
      tokenAAmount: tokenAAmountDecimal,
      tokenBAmount: tokenBAmountDecimal,
      isSolTokenA
    });

    return price;
  } catch (error) {
    console.error('Failed to fetch Meteora pool price:', error);
    return 0;
  }
}

/**
 * Get a swap quote from Meteora SDK
 * Returns the expected output amount for a given input
 */
export interface SwapQuoteParams {
  poolAddress: string;
  inputMint: string;
  outputMint: string;
  amount: number; // In lamports/smallest units
  slippageBps?: number;
}

export interface SwapQuoteResult {
  inputAmount: number;
  outputAmount: number;
  minimumOutputAmount: number;
  priceImpact: number;
  fee: number;
  price: number; // Output per input
}

export async function getMeteoraSwapQuote(
  ctx: ServiceContext,
  params: SwapQuoteParams
): Promise<SwapQuoteResult | null> {
  try {
    const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
    const BN = (await import('bn.js')).default;

    // Use proper connection that routes through HTTP proxy
    const meteoraConnection = getMeteoraConnection(ctx.connection);
    const cpAmm = new (CpAmm as any)(meteoraConnection, METEORA_DAMM_V2_PROGRAM_ID);
    const poolAddress = new PublicKey(params.poolAddress);

    console.log('[METEORA-QUOTE] Fetching quote for pool:', params.poolAddress);

    // Fetch pool state
    const poolState = await cpAmm.fetchPoolState(poolAddress);
    if (!poolState || !poolState.tokenAMint || !poolState.tokenBMint) {
      console.error('[METEORA-QUOTE] Invalid pool state');
      return null;
    }

    const inputMint = new PublicKey(params.inputMint);
    const outputMint = new PublicKey(params.outputMint);
    const amountIn = new BN(params.amount);
    const slippageBps = params.slippageBps || 100; // Default 1% slippage for quotes

    let expectedOutput: any;
    let minimumAmountOut: any;
    let priceImpact = 0;

    try {
      // Try to get quote from SDK first
      const swapQuote = await (cpAmm as any).getQuote({
        pool: poolAddress,
        poolState,
        inputMint,
        outputMint,
        amountIn,
        slippageBps
      });

      console.log('[METEORA-QUOTE] SDK Quote:', swapQuote);
      expectedOutput = swapQuote.swapOutAmount || swapQuote.outAmount || swapQuote.amountOut;
      minimumAmountOut = swapQuote.minSwapOutAmount || swapQuote.minimumOutAmount;
      priceImpact = swapQuote.priceImpact || 0;
    } catch (quoteError) {
      console.warn('[METEORA-QUOTE] SDK getQuote failed, calculating from reserves:', quoteError);

      // Calculate expected output from pool reserves (constant product AMM: x * y = k)
      const [vaultAInfo, vaultBInfo, tokenAMintInfo, tokenBMintInfo] = await Promise.all([
        ctx.connection.getAccountInfo(poolState.tokenAVault),
        ctx.connection.getAccountInfo(poolState.tokenBVault),
        ctx.connection.getAccountInfo(poolState.tokenAMint),
        ctx.connection.getAccountInfo(poolState.tokenBMint)
      ]);

      if (vaultAInfo && vaultBInfo) {
        const reserveA = Number(vaultAInfo.data.readBigUInt64LE(64));
        const reserveB = Number(vaultBInfo.data.readBigUInt64LE(64));

        const inputAmount = Number(amountIn.toString());
        const isInputA = inputMint.equals(poolState.tokenAMint);

        // Constant product formula: dy = y * dx / (x + dx)
        const inputReserve = isInputA ? reserveA : reserveB;
        const outputReserve = isInputA ? reserveB : reserveA;

        // Account for 0.25% fee (25 bps) typical for Meteora pools
        const inputWithFee = inputAmount * 0.9975;
        const expectedOutputNum = Math.floor((outputReserve * inputWithFee) / (inputReserve + inputWithFee));

        expectedOutput = new BN(expectedOutputNum);

        // Calculate price impact
        const spotPrice = outputReserve / inputReserve;
        const executionPrice = expectedOutputNum / inputAmount;
        priceImpact = Math.abs((spotPrice - executionPrice) / spotPrice) * 100;

        console.log('[METEORA-QUOTE] Calculated from reserves:', {
          inputReserve,
          outputReserve,
          inputAmount,
          expectedOutput: expectedOutputNum,
          priceImpact: priceImpact.toFixed(2) + '%'
        });
      } else {
        console.error('[METEORA-QUOTE] Could not fetch vault info');
        return null;
      }

      // Apply slippage to expected output
      minimumAmountOut = expectedOutput.muln(10000 - slippageBps).divn(10000);
    }

    const inputAmountNum = Number(amountIn.toString());
    const outputAmountNum = Number(expectedOutput.toString());
    const minimumOutputNum = Number(minimumAmountOut.toString());

    // Calculate price (output per input)
    const price = outputAmountNum / inputAmountNum;

    // Estimate fee (0.25% of input)
    const fee = inputAmountNum * 0.0025;

    console.log('[METEORA-QUOTE] Final quote:', {
      inputAmount: inputAmountNum,
      outputAmount: outputAmountNum,
      minimumOutputAmount: minimumOutputNum,
      priceImpact: priceImpact.toFixed(2) + '%',
      price
    });

    return {
      inputAmount: inputAmountNum,
      outputAmount: outputAmountNum,
      minimumOutputAmount: minimumOutputNum,
      priceImpact,
      fee,
      price
    };

  } catch (error) {
    console.error('[METEORA-QUOTE] Error:', error);
    return null;
  }
}

/**
 * Execute a swap on Meteora
 */
export async function executeMeteoraSwap(
  ctx: ServiceContext,
  params: SwapParams
): Promise<string> {
  if (!params.wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  try {
    const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
    const BN = (await import('bn.js')).default;
    const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createSyncNativeInstruction } = await import('@solana/spl-token');

    // Use proper connection that routes through HTTP proxy
    const meteoraConnection = getMeteoraConnection(ctx.connection);
    const cpAmm = new (CpAmm as any)(meteoraConnection, METEORA_DAMM_V2_PROGRAM_ID);
    const poolAddress = new PublicKey(params.poolAddress);

    console.log('[METEORA-SWAP] Fetching pool state for:', params.poolAddress);
    const poolState = await cpAmm.fetchPoolState(poolAddress);
    console.log('[METEORA-SWAP] Pool state:', poolState ? 'Found' : 'Not found');

    if (!poolState || !poolState.tokenAMint || !poolState.tokenBMint) {
      throw new Error('Invalid pool state');
    }

    // Determine swap direction
    const isAtoB = params.inputMint === poolState.tokenAMint.toBase58();
    const inputMint = new PublicKey(params.inputMint);
    const outputMint = new PublicKey(params.outputMint);

    // Detect token programs
    const inputMintInfo = await ctx.connection.getAccountInfo(inputMint);
    const outputMintInfo = await ctx.connection.getAccountInfo(outputMint);

    const inputTokenProgram = inputMintInfo?.owner?.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
    const outputTokenProgram = outputMintInfo?.owner?.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;

    // Get token accounts
    const userInputAccount = await getAssociatedTokenAddress(
      inputMint,
      params.wallet.publicKey,
      false,
      inputTokenProgram
    );

    const userOutputAccount = await getAssociatedTokenAddress(
      outputMint,
      params.wallet.publicKey,
      false,
      outputTokenProgram
    );

    // Meteora pays referral fees in SOL/WSOL, so referralTokenAccount must ALWAYS be the WSOL account
    const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
    const isInputWSOL = inputMint.equals(WSOL_MINT);
    const userWsolAccount = isInputWSOL ? userInputAccount : userOutputAccount;

    // Get swap quote
    const amountIn = new BN(params.amount);
    const slippageBps = params.slippageBps || 5000; // Default 50% slippage

    console.log('[METEORA-SWAP] Swap parameters:', {
      amountIn: amountIn.toString(),
      slippageBps,
      slippagePercent: `${slippageBps / 100}%`
    });

    // Calculate expected output from pool reserves
    let expectedOutput: any;
    let minimumAmountOut: any;

    try {
      // Try to get quote from SDK first
      const swapQuote = await (cpAmm as any).getQuote({
        pool: poolAddress,
        poolState,
        inputMint,
        outputMint,
        amountIn,
        slippageBps
      });
      console.log('[METEORA-SWAP] SDK Quote:', swapQuote);
      expectedOutput = swapQuote.swapOutAmount || swapQuote.outAmount || swapQuote.amountOut;
      minimumAmountOut = swapQuote.minSwapOutAmount || swapQuote.minimumOutAmount;
    } catch (quoteError) {
      console.warn('[METEORA-SWAP] getQuote failed, calculating from pool reserves:', quoteError);

      // Calculate expected output from pool reserves (constant product AMM: x * y = k)
      const [vaultAInfo, vaultBInfo] = await Promise.all([
        ctx.connection.getAccountInfo(poolState.tokenAVault),
        ctx.connection.getAccountInfo(poolState.tokenBVault)
      ]);

      if (vaultAInfo && vaultBInfo) {
        const reserveA = Number(vaultAInfo.data.readBigUInt64LE(64));
        const reserveB = Number(vaultBInfo.data.readBigUInt64LE(64));

        const inputAmount = Number(amountIn.toString());
        const isInputA = inputMint.equals(poolState.tokenAMint);

        // Constant product formula: dy = y * dx / (x + dx)
        const inputReserve = isInputA ? reserveA : reserveB;
        const outputReserve = isInputA ? reserveB : reserveA;

        // Account for 0.25% fee (25 bps) typical for Meteora pools
        const inputWithFee = inputAmount * 0.9975;
        const expectedOutputNum = Math.floor((outputReserve * inputWithFee) / (inputReserve + inputWithFee));

        expectedOutput = new BN(expectedOutputNum);
        console.log('[METEORA-SWAP] Calculated from reserves:', {
          inputReserve,
          outputReserve,
          inputAmount,
          expectedOutput: expectedOutputNum
        });
      } else {
        // Ultimate fallback - set to 1 to accept any output
        expectedOutput = new BN(1);
      }

      // Apply slippage to expected output
      minimumAmountOut = expectedOutput.muln(10000 - slippageBps).divn(10000);
    }

    // For very high slippage (>= 50%), set minimum to 1 to ensure transaction goes through
    if (slippageBps >= 5000) {
      minimumAmountOut = new BN(1);
      console.log('[METEORA-SWAP] High slippage mode - setting minimumAmountOut to 1');
    }

    console.log('[METEORA-SWAP] Final amounts:', {
      amountIn: amountIn.toString(),
      expectedOutput: expectedOutput?.toString(),
      minimumAmountOut: minimumAmountOut.toString(),
      slippageBps
    });

    // Determine token programs from poolState or detect from mint accounts
    const tokenAProgram = poolState.tokenAProgram ||
      (poolState.tokenAMint.equals(inputMint) ? inputTokenProgram : outputTokenProgram);
    const tokenBProgram = poolState.tokenBProgram ||
      (poolState.tokenBMint.equals(inputMint) ? inputTokenProgram : outputTokenProgram);

    console.log('[METEORA-SWAP] Building swap:', {
      isAtoB,
      inputMint: inputMint.toBase58(),
      outputMint: outputMint.toBase58(),
      amountIn: amountIn.toString(),
      tokenAMint: poolState.tokenAMint.toBase58(),
      tokenBMint: poolState.tokenBMint.toBase58(),
    });

    // Build swap transaction using correct SDK API
    // referralTokenAccount is required by Meteora SDK - use user's INPUT token account
    // (referral fees are paid from the input token, not output)
    const swapBuilder = await (cpAmm as any).swap({
      payer: params.wallet.publicKey,
      pool: poolAddress,
      inputTokenMint: inputMint, // SDK expects inputTokenMint
      outputTokenMint: outputMint, // SDK expects outputTokenMint
      amountIn,
      minimumAmountOut: minimumAmountOut,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAProgram: tokenAProgram,
      tokenBProgram: tokenBProgram,
      referralTokenAccount: userWsolAccount, // Required: user's WSOL ATA (Meteora always pays referral fees in SOL)
    });

    let swapTx: any;
    if (typeof swapBuilder?.transaction === 'function') {
      swapTx = await swapBuilder.transaction();
    } else {
      swapTx = swapBuilder;
    }

    swapTx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 })
    );

    swapTx.feePayer = params.wallet.publicKey;

    const signature = await params.wallet.sendTransaction(swapTx, ctx.connection, {
      skipPreflight: true,
      maxRetries: 3
    });

    await confirmTransactionSafely(ctx, signature);

    console.log('✅ Swap completed:', signature);
    return signature;

  } catch (error) {
    console.error('[METEORA-SWAP] Error:', error);
    throw error;
  }
}

// ============ HELPER FUNCTIONS ============

/**
 * Confirm transaction safely using polling
 */
async function confirmTransactionSafely(
  ctx: ServiceContext,
  signature: string,
  skipWait: boolean = false
): Promise<boolean> {
  try {
    if (skipWait) {
      const status = await ctx.connection.getSignatureStatus(signature);
      return !!status?.value?.confirmationStatus;
    }

    const maxRetries = 30;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const status = await ctx.connection.getSignatureStatus(signature);

        if (status?.value?.confirmationStatus === 'confirmed' ||
            status?.value?.confirmationStatus === 'finalized') {
          return true;
        }

        if (status?.value?.err) {
          console.error('[CONFIRM] Transaction failed:', status.value.err);
          return false;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        // Retry
      }
    }

    return true;
  } catch (error) {
    console.error('[CONFIRM] Error:', error);
    return false;
  }
}
