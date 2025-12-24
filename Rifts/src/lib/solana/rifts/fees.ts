// lib/solana/rifts/fees.ts - Fee distribution and claiming functions
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  ServiceContext,
  DecodedRiftData,
  RIFTS_PROGRAM_ID,
  MINT_CACHE_TTL,
} from './types';
import { getRiftData, getActualVaultBalance } from './data';
import { getCachedMintDecimals } from './utils';

// ============ FEE DISTRIBUTION FUNCTIONS ============

export interface DistributeFeesParams {
  riftPubkey: PublicKey;
  amount: number;
  partnerFeeBps?: number;
}

export interface DistributeFeesResult {
  success: boolean;
  signature?: string;
  error?: string;
}

export interface VaultFeesResult {
  success: boolean;
  available: number;
  partnerShare?: number;
  treasuryShare?: number;
  userClaimable?: number;
  error?: string;
}

/**
 * Create partner token account (must be called BEFORE distributeFeesFromVault if partner not set up)
 */
export async function createPartnerTokenAccount(
  ctx: ServiceContext,
  params: { riftPubkey: PublicKey }
): Promise<string> {
  if (!ctx.wallet) throw new Error('Wallet not initialized');

  const riftData = await getRiftData(ctx, params.riftPubkey);
  if (!riftData) {
    throw new Error('Rift not found');
  }
  if (!riftData.partnerWallet) {
    throw new Error('Rift does not have a partner wallet configured');
  }

  const { getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
  const { Transaction, ComputeBudgetProgram } = await import('@solana/web3.js');

  const underlyingMint = new PublicKey(riftData.underlyingMint);
  const partnerWallet = new PublicKey(riftData.partnerWallet);

  // Detect if underlying token is Token-2022
  const mintAccountInfo = await ctx.connection.getAccountInfo(underlyingMint);
  const isToken2022 = mintAccountInfo?.owner?.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58();
  const tokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  console.log(`🔍 Underlying mint ${underlyingMint.toBase58()} is ${isToken2022 ? 'Token-2022' : 'SPL Token'}`);

  const partnerTokenAccount = await getAssociatedTokenAddress(
    underlyingMint,
    partnerWallet,
    false,
    tokenProgramId
  );

  console.log('🤝 Creating partner token account:', partnerTokenAccount.toBase58());

  const transaction = new Transaction();

  const { blockhash, lastValidBlockHeight } = await ctx.connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = ctx.wallet.publicKey!;

  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 })
  );

  const createAccountIx = createAssociatedTokenAccountIdempotentInstruction(
    ctx.wallet.publicKey!,
    partnerTokenAccount,
    partnerWallet,
    underlyingMint,
    tokenProgramId
  );
  transaction.add(createAccountIx);

  console.log('📤 Sending partner account creation transaction...');
  const signature = await ctx.wallet.sendTransaction(transaction, ctx.connection);
  console.log('[OK] Partner account creation transaction sent:', signature);

  // Wait for confirmation
  const confirmed = await confirmTransactionSafely(ctx, signature);
  if (!confirmed) {
    throw new Error('Failed to confirm partner account creation transaction');
  }

  console.log('✅ Partner token account created successfully');
  return signature;
}

/**
 * Distribute fees from vault (callable by anyone, sends to treasury + partner)
 */
export async function distributeFeesFromVault(
  ctx: ServiceContext,
  params: DistributeFeesParams
): Promise<DistributeFeesResult> {
  ctx.isWrapInProgress = true;

  try {
    if (!ctx.wallet) {
      throw new Error('Wallet not connected');
    }

    const riftId = params.riftPubkey.toBase58();
    let riftData: any = null;

    // Try server cache first
    const tApiCache = Date.now();
    try {
      console.log(`⏱️ [CLAIM-FEE] 🚀 Trying server cache API...`);
      const cacheResponse = await fetch(`/api/rift-data?id=${riftId}`);
      if (cacheResponse.ok) {
        const cacheData = await cacheResponse.json();
        if (cacheData.success && cacheData.cached) {
          console.log(`⏱️ [CLAIM-FEE] 🚀 SERVER CACHE HIT! fetch time: +${Date.now() - tApiCache}ms`);
          riftData = {
            underlyingMint: cacheData.data.underlyingMint,
            riftMint: cacheData.data.riftMint,
            vault: cacheData.data.vaultAddress,
            treasuryWallet: cacheData.data.treasuryWallet,
            partnerWallet: cacheData.data.partnerWallet
          };
        }
      }
    } catch (error) {
      console.log(`⏱️ [CLAIM-FEE] ⚠️ Server cache miss, falling back to RPC`);
    }

    // Fallback to RPC
    if (!riftData) {
      const tRpc = Date.now();
      console.log(`⏱️ [CLAIM-FEE] 🌐 Fetching from RPC...`);
      riftData = await getRiftData(ctx, params.riftPubkey);
      console.log(`⏱️ [CLAIM-FEE] 🌐 RPC fetch: +${Date.now() - tRpc}ms`);
    }

    if (!riftData) {
      throw new Error('Rift not found');
    }

    // 🔧 FIX: ALWAYS read treasury AND partner wallet from on-chain to avoid cache mismatch
    // The cached data might have wrong/stale wallets
    let onChainTreasuryWallet: string | null = null;
    let onChainPartnerWallet: string | null = null;
    try {
      const riftAccountInfo = await ctx.connection.getAccountInfo(params.riftPubkey);
      if (riftAccountInfo) {
        // Use the proper decode function to handle Option<Pubkey> correctly
        const { decodeRiftAccount } = await import('./utils');
        const decodedRift = decodeRiftAccount(riftAccountInfo.data);
        if (decodedRift.treasuryWallet) {
          onChainTreasuryWallet = decodedRift.treasuryWallet;
          console.log(`[DISTRIBUTE-FEES] 🔑 On-chain treasury wallet: ${onChainTreasuryWallet}`);
        } else {
          console.log(`[DISTRIBUTE-FEES] ⚠️ Rift has no treasury wallet set on-chain`);
        }
        if (decodedRift.partnerWallet) {
          onChainPartnerWallet = decodedRift.partnerWallet;
          console.log(`[DISTRIBUTE-FEES] 🔑 On-chain partner wallet: ${onChainPartnerWallet}`);
        } else {
          console.log(`[DISTRIBUTE-FEES] ⚠️ Rift has no partner wallet set on-chain (will use treasury)`);
        }
      }
    } catch (err) {
      console.warn('[DISTRIBUTE-FEES] Failed to read on-chain wallets:', err);
    }

    const PROGRAM_AUTHORITY = process.env.NEXT_PUBLIC_PROTOCOL_AUTHORITY || '9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4';

    // Use on-chain wallets if available, otherwise fall back to cached/default
    const effectiveTreasuryWallet = onChainTreasuryWallet || riftData.treasuryWallet || PROGRAM_AUTHORITY;
    // Partner wallet: use on-chain if set, otherwise fall back to treasury (NOT cached partner)
    const effectivePartnerWallet = onChainPartnerWallet || effectiveTreasuryWallet;

    const effectiveRiftData = {
      ...riftData,
      treasuryWallet: effectiveTreasuryWallet,
      partnerWallet: effectivePartnerWallet
    };

    console.log('🏦 Distributing fees:', {
      cachedTreasuryWallet: riftData.treasuryWallet,
      cachedPartnerWallet: riftData.partnerWallet,
      onChainTreasuryWallet,
      onChainPartnerWallet,
      effectiveTreasury: effectiveTreasuryWallet,
      effectivePartner: effectivePartnerWallet
    });

    const transaction = new Transaction();

    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 500000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 })
    );

    // Check if treasury token account exists
    const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');
    const underlyingMint = new PublicKey(effectiveRiftData.underlyingMint);
    const treasuryWallet = new PublicKey(effectiveRiftData.treasuryWallet!);

    // Detect token program - retry on failure to avoid wrong ATA derivation (causes error 6071)
    const TOKEN_2022_PROGRAM_ID_STR = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    const TOKEN_PROGRAM_ID_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

    let mintAccountInfo = await ctx.connection.getAccountInfo(underlyingMint);
    // Retry once if null - critical for correct ATA derivation
    if (!mintAccountInfo) {
      console.warn('[DISTRIBUTE-FEES] Mint account info null, retrying...');
      await new Promise(r => setTimeout(r, 500));
      mintAccountInfo = await ctx.connection.getAccountInfo(underlyingMint);
    }
    if (!mintAccountInfo) {
      throw new Error('Failed to fetch mint account info - cannot determine token program');
    }

    const isToken2022 = mintAccountInfo.owner?.toBase58() === TOKEN_2022_PROGRAM_ID_STR;
    const tokenProgramId = isToken2022 ? new PublicKey(TOKEN_2022_PROGRAM_ID_STR) : new PublicKey(TOKEN_PROGRAM_ID_STR);
    console.log(`[DISTRIBUTE-FEES] Token program: ${isToken2022 ? 'Token-2022' : 'SPL Token'}`);

    const treasuryTokenAccount = await getAssociatedTokenAddress(
      underlyingMint,
      treasuryWallet,
      false,
      tokenProgramId
    );

    const treasuryAccountInfo = await ctx.connection.getAccountInfo(treasuryTokenAccount);
    if (!treasuryAccountInfo) {
      console.log('📝 Creating treasury token account:', treasuryTokenAccount.toBase58());
      const createTreasuryAccountIx = createAssociatedTokenAccountInstruction(
        ctx.wallet!.publicKey!,
        treasuryTokenAccount,
        treasuryWallet,
        underlyingMint,
        tokenProgramId
      );
      transaction.add(createTreasuryAccountIx);
    }

    // Ensure partner account exists (fallback to treasury when no partner configured)
    const partnerWallet = effectiveRiftData.partnerWallet
      ? new PublicKey(effectiveRiftData.partnerWallet)
      : treasuryWallet;

    // Only create partner ATA if it's different from treasury (avoid duplicate creation)
    const partnerIsSameAsTreasury = partnerWallet.equals(treasuryWallet);
    if (!partnerIsSameAsTreasury) {
      const partnerTokenAccount = await getAssociatedTokenAddress(
        underlyingMint,
        partnerWallet,
        false,
        tokenProgramId
      );
      const partnerAccountInfo = await ctx.connection.getAccountInfo(partnerTokenAccount);
      if (!partnerAccountInfo) {
        console.log('📝 Creating partner token account:', partnerTokenAccount.toBase58());
        const createPartnerAccountIx = createAssociatedTokenAccountInstruction(
          ctx.wallet!.publicKey!,
          partnerTokenAccount,
          partnerWallet,
          underlyingMint,
          tokenProgramId
        );
        transaction.add(createPartnerAccountIx);
      }
    } else {
      console.log('ℹ️ Partner wallet same as treasury, skipping duplicate ATA creation');
    }

    // Create distribute fees instruction
    const instruction = await createDistributeFeesInstruction(
      ctx,
      params.riftPubkey,
      effectiveRiftData,
      params.amount
    );
    if (!instruction) {
      throw new Error('Failed to create distribute fees instruction');
    }

    transaction.add(instruction);
    transaction.feePayer = ctx.wallet!.publicKey!;

    const { blockhash } = await ctx.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;

    // Send transaction
    console.log('📤 Sending distribute fees transaction...');
    const signature = await ctx.wallet.sendTransaction(transaction, ctx.connection, {
      skipPreflight: false,  // DEBUG: Set to false to see simulation errors
      maxRetries: 3
    } as any);
    console.log('[OK] Transaction sent:', signature);

    const finalStatus = await waitForFinalResult(ctx, signature);
    if (finalStatus.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(finalStatus.err)}`);
    }

    console.log('🎉 Fees distributed successfully!');
    return { success: true, signature };
  } catch (error) {
    console.error('[ERROR] Error distributing fees:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to distribute fees'
    };
  } finally {
    ctx.isWrapInProgress = false;
    console.log('🔓 Fee claim completed, PREFETCH operations re-enabled');
  }
}

/**
 * Claim DEX fees from withheld vault (RIFT tokens from DEX trading)
 */
export async function claimDexFees(
  ctx: ServiceContext,
  params: DistributeFeesParams
): Promise<DistributeFeesResult> {
  ctx.isWrapInProgress = true;

  try {
    if (!ctx.wallet) {
      throw new Error('Wallet not connected');
    }

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
            vault: cacheData.data.vaultAddress,
            treasuryWallet: cacheData.data.treasuryWallet,
            partnerWallet: cacheData.data.partnerWallet
          };
        }
      }
    } catch (error) {
      console.log(`⏱️ [CLAIM-DEX-FEE] ⚠️ Server cache miss`);
    }

    if (!riftData) {
      riftData = await getRiftData(ctx, params.riftPubkey);
    }

    if (!riftData) {
      throw new Error('Rift not found');
    }

    // 🔧 FIX: ALWAYS read treasury AND partner wallet from on-chain to avoid cache mismatch
    let onChainTreasuryWallet: string | null = null;
    let onChainPartnerWallet: string | null = null;
    try {
      const riftAccountInfo = await ctx.connection.getAccountInfo(params.riftPubkey);
      if (riftAccountInfo) {
        const { decodeRiftAccount } = await import('./utils');
        const decodedRift = decodeRiftAccount(riftAccountInfo.data);
        if (decodedRift.treasuryWallet) {
          onChainTreasuryWallet = decodedRift.treasuryWallet;
          console.log(`[CLAIM-DEX-FEE] 🔑 On-chain treasury wallet: ${onChainTreasuryWallet}`);
        } else {
          console.log(`[CLAIM-DEX-FEE] ⚠️ Rift has no treasury wallet set on-chain`);
        }
        if (decodedRift.partnerWallet) {
          onChainPartnerWallet = decodedRift.partnerWallet;
          console.log(`[CLAIM-DEX-FEE] 🔑 On-chain partner wallet: ${onChainPartnerWallet}`);
        }
      }
    } catch (err) {
      console.warn('[CLAIM-DEX-FEE] Failed to read on-chain wallets:', err);
    }

    const PROGRAM_AUTHORITY = process.env.NEXT_PUBLIC_PROTOCOL_AUTHORITY || '9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4';

    // Use on-chain wallets if available, otherwise fall back to cached/default
    const effectiveTreasuryWallet = onChainTreasuryWallet || riftData.treasuryWallet || PROGRAM_AUTHORITY;
    const effectivePartnerWallet = onChainPartnerWallet || effectiveTreasuryWallet;

    const effectiveRiftData = {
      ...riftData,
      treasuryWallet: effectiveTreasuryWallet,
      partnerWallet: effectivePartnerWallet
    };

    console.log('[CLAIM-DEX-FEE] 🏦 Using wallets:', {
      cachedTreasury: riftData.treasuryWallet,
      cachedPartner: riftData.partnerWallet,
      onChainTreasury: onChainTreasuryWallet,
      onChainPartner: onChainPartnerWallet,
      effectiveTreasury: effectiveTreasuryWallet,
      effectivePartner: effectivePartnerWallet
    });

    const transaction = new Transaction();

    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 500000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 })
    );

    const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
    const riftMint = new PublicKey(effectiveRiftData.riftMint);
    const treasuryWallet = new PublicKey(effectiveRiftData.treasuryWallet!);

    const treasuryTokenAccount = await getAssociatedTokenAddress(
      riftMint,
      treasuryWallet,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const treasuryAccountInfo = await ctx.connection.getAccountInfo(treasuryTokenAccount);
    if (!treasuryAccountInfo) {
      console.log('📝 Creating treasury RIFT token account:', treasuryTokenAccount.toBase58());
      const createTreasuryAccountIx = createAssociatedTokenAccountInstruction(
        ctx.wallet!.publicKey!,
        treasuryTokenAccount,
        treasuryWallet,
        riftMint,
        TOKEN_2022_PROGRAM_ID
      );
      transaction.add(createTreasuryAccountIx);
    }

    // Handle partner account - create if it doesn't exist
    if (effectiveRiftData.partnerWallet) {
      const partnerWallet = new PublicKey(effectiveRiftData.partnerWallet);
      const partnerTokenAccount = await getAssociatedTokenAddress(
        riftMint,
        partnerWallet,
        false,
        TOKEN_2022_PROGRAM_ID
      );

      const partnerAccountInfo = await ctx.connection.getAccountInfo(partnerTokenAccount);
      if (!partnerAccountInfo || partnerAccountInfo.data.length === 0) {
        console.log('📝 Creating partner RIFT token account:', partnerTokenAccount.toBase58());
        const createPartnerAccountIx = createAssociatedTokenAccountInstruction(
          ctx.wallet!.publicKey!,
          partnerTokenAccount,
          partnerWallet,
          riftMint,
          TOKEN_2022_PROGRAM_ID
        );
        transaction.add(createPartnerAccountIx);
      }
    }

    const instruction = await createDistributeWithheldVaultInstruction(
      ctx,
      params.riftPubkey,
      effectiveRiftData,
      params.amount
    );
    if (!instruction) {
      throw new Error('Failed to create distribute withheld vault instruction');
    }

    transaction.add(instruction);
    transaction.feePayer = ctx.wallet!.publicKey!;
    const { blockhash } = await ctx.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;

    console.log('📤 Sending claim DEX fees transaction...');
    const signature = await ctx.wallet.sendTransaction(transaction, ctx.connection, {
      skipPreflight: true,
      maxRetries: 3
    } as any);
    console.log('[OK] Transaction sent:', signature);

    const confirmed = await confirmTransactionSafely(ctx, signature);
    if (!confirmed) {
      throw new Error('Transaction confirmation failed or timed out');
    }

    console.log('🎉 DEX fees claimed successfully!');
    return { success: true, signature };
  } catch (error) {
    console.error('[ERROR] Error claiming DEX fees:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to claim DEX fees'
    };
  } finally {
    ctx.isWrapInProgress = false;
  }
}

/**
 * Claim Rift fees (alias for distributeFeesFromVault)
 */
export async function claimRiftFees(
  ctx: ServiceContext,
  params: DistributeFeesParams
): Promise<DistributeFeesResult> {
  return distributeFeesFromVault(ctx, params);
}

/**
 * Get available fees in vault
 */
export async function getVaultFeesAvailable(
  ctx: ServiceContext,
  params: { riftPubkey: PublicKey }
): Promise<VaultFeesResult> {
  const fetchAccountInfoHttp = async (pubkey: string) => {
    try {
      const resp = await fetch('/api/rpc-http', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'getAccountInfo',
          params: [pubkey, { encoding: 'base64' }]
        })
      });
      if (!resp.ok) return null;
      const json = await resp.json();
      return json?.result?.value ?? null;
    } catch {
      return null;
    }
  };

  try {
    let accountInfo = await ctx.connection.getAccountInfo(params.riftPubkey);

    // Fallback to HTTP if LaserStream returns empty/non-JSON
    if (!accountInfo) {
      const httpVal = await fetchAccountInfoHttp(params.riftPubkey.toBase58());
      if (httpVal) {
        accountInfo = {
          executable: httpVal.executable,
          lamports: httpVal.lamports,
          owner: new PublicKey(httpVal.owner),
          rentEpoch: httpVal.rentEpoch,
          data: Buffer.from(httpVal.data?.[0] || '', 'base64')
        } as any;
      }
    }
    if (!accountInfo) {
      return { success: false, available: 0, error: 'Rift not found' };
    }

    const data = accountInfo.data;

    // Parse rift_mint address (offset 104, 32 bytes)
    const riftMintBytes = data.slice(104, 136);
    const riftMint = new PublicKey(riftMintBytes);

    // Parse fees_vault address (offset 168, 32 bytes)
    const feesVaultBytes = data.slice(168, 200);
    const feesVault = new PublicKey(feesVaultBytes);

    // Parse underlying_mint address (offset 72, 32 bytes)
    const underlyingMintBytes = data.slice(72, 104);
    const underlyingMint = new PublicKey(underlyingMintBytes);

    // Get decimals
    let decimals = 9;
    try {
      const { getMint, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
      const mintInfo = await getMint(ctx.connection, riftMint, 'confirmed', TOKEN_2022_PROGRAM_ID);
      decimals = mintInfo.decimals;
    } catch (error) {
      console.warn('[VAULT-FEES] Failed to get mint decimals, using default 9');
    }

    // Get fees vault balance
    const feesVaultBalance = await getActualVaultBalance(ctx, feesVault.toBase58());
    const availableFees = feesVaultBalance;

    // Get rift data for fee calculation
    const riftData = await getRiftData(ctx, params.riftPubkey);
    let partnerShare = 0;
    let treasuryShare = 0;
    let userClaimable = 0; // Default to 0 - user must be partner or treasury to claim

    // Read on-chain wallets for accurate comparison (cached data might be stale)
    let onChainPartnerWallet: string | null = null;
    let onChainTreasuryWallet: string | null = null;
    try {
      const { decodeRiftAccount } = await import('./utils');
      const decodedRift = decodeRiftAccount(data);
      onChainPartnerWallet = decodedRift.partnerWallet || null;
      onChainTreasuryWallet = decodedRift.treasuryWallet || null;
    } catch (err) {
      console.warn('[VAULT-FEES] Failed to decode on-chain wallets:', err);
    }

    // Use on-chain wallets if available, otherwise fall back to cached
    const effectivePartnerWallet = onChainPartnerWallet || riftData?.partnerWallet || null;
    const effectiveTreasuryWallet = onChainTreasuryWallet || riftData?.treasuryWallet || null;

    if (riftData) {
      const rawPartnerFee = riftData.partnerFee || 50;
      const partnerFeeBps = rawPartnerFee <= 100 ? rawPartnerFee * 100 : rawPartnerFee;
      const partnerSharePercent = partnerFeeBps / 10000;
      const treasurySharePercent = 1 - partnerSharePercent;

      partnerShare = availableFees * partnerSharePercent;
      treasuryShare = availableFees * treasurySharePercent;

      if (ctx.wallet && ctx.wallet.publicKey) {
        const userWallet = ctx.wallet.publicKey.toBase58();
        const isPartner = effectivePartnerWallet && effectivePartnerWallet === userWallet;
        const isTreasury = effectiveTreasuryWallet && effectiveTreasuryWallet === userWallet;

        if (isPartner) {
          userClaimable = partnerShare;
        } else if (isTreasury) {
          userClaimable = treasuryShare;
        }
        // If neither partner nor treasury, userClaimable stays 0
      }
    }

    return {
      success: true,
      available: availableFees,
      partnerShare,
      treasuryShare,
      userClaimable
    };
  } catch (error) {
    return {
      success: false,
      available: 0,
      error: error instanceof Error ? error.message : 'Failed to get vault balance'
    };
  }
}

/**
 * Get available DEX fees in withheld vault
 */
export async function getWithheldVaultFeesAvailable(
  ctx: ServiceContext,
  params: { riftPubkey: PublicKey }
): Promise<VaultFeesResult> {
  try {
    const [withheldVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("withheld_vault"), params.riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const riftData = await getRiftData(ctx, params.riftPubkey);
    if (!riftData) {
      return {
        success: false,
        available: 0,
        partnerShare: 0,
        treasuryShare: 0,
        userClaimable: 0,
        error: 'Rift not found'
      };
    }

    const riftMint = new PublicKey(riftData.riftMint);

    let decimals = 9;
    try {
      const { getMint, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
      const mintInfo = await getMint(ctx.connection, riftMint, 'confirmed', TOKEN_2022_PROGRAM_ID);
      decimals = mintInfo.decimals;
    } catch (error) {
      console.warn('[WITHHELD-VAULT-FEES] Failed to get mint decimals, using default 9');
    }

    let available = 0;
    try {
      const { getAccount, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
      const vaultAccount = await getAccount(ctx.connection, withheldVault, 'confirmed', TOKEN_2022_PROGRAM_ID);
      available = Number(vaultAccount.amount) / Math.pow(10, decimals);
    } catch (error) {
      return {
        success: false,
        available: 0,
        partnerShare: 0,
        treasuryShare: 0,
        userClaimable: 0,
        error: 'Failed to read withheld vault account'
      };
    }

    const rawPartnerFee = riftData.partnerFee || 50;
    const partnerFeeBps = rawPartnerFee <= 100 ? rawPartnerFee * 100 : rawPartnerFee;
    const partnerSharePercent = partnerFeeBps / 10000;
    const treasurySharePercent = 1 - partnerSharePercent;

    const partnerShare = available * partnerSharePercent;
    const treasuryShare = available * treasurySharePercent;

    // Read on-chain wallets for accurate comparison (cached data might be stale)
    let onChainPartnerWallet: string | null = null;
    let onChainTreasuryWallet: string | null = null;
    try {
      const riftAccountInfo = await ctx.connection.getAccountInfo(params.riftPubkey);
      if (riftAccountInfo) {
        const { decodeRiftAccount } = await import('./utils');
        const decodedRift = decodeRiftAccount(riftAccountInfo.data);
        onChainPartnerWallet = decodedRift.partnerWallet || null;
        onChainTreasuryWallet = decodedRift.treasuryWallet || null;
      }
    } catch (err) {
      console.warn('[WITHHELD-VAULT-FEES] Failed to decode on-chain wallets:', err);
    }

    // Use on-chain wallets if available, otherwise fall back to cached
    const effectivePartnerWallet = onChainPartnerWallet || riftData.partnerWallet || null;
    const effectiveTreasuryWallet = onChainTreasuryWallet || riftData.treasuryWallet || null;

    let userClaimable = 0; // Default to 0 - user must be partner or treasury to claim
    if (ctx.wallet && ctx.wallet.publicKey) {
      const userWallet = ctx.wallet.publicKey.toBase58();
      const isPartner = effectivePartnerWallet && effectivePartnerWallet === userWallet;
      const isTreasury = effectiveTreasuryWallet && effectiveTreasuryWallet === userWallet;

      if (isPartner) {
        userClaimable = partnerShare;
      } else if (isTreasury) {
        userClaimable = treasuryShare;
      }
      // If neither partner nor treasury, userClaimable stays 0
    }

    return {
      success: true,
      available,
      partnerShare,
      treasuryShare,
      userClaimable
    };
  } catch (error) {
    return {
      success: false,
      available: 0,
      partnerShare: 0,
      treasuryShare: 0,
      userClaimable: 0,
      error: error instanceof Error ? error.message : 'Failed to get withheld vault balance'
    };
  }
}

// ============ INSTRUCTION BUILDERS ============

/**
 * Create distribute fees instruction
 */
async function createDistributeFeesInstruction(
  ctx: ServiceContext,
  riftPubkey: PublicKey,
  riftData: DecodedRiftData,
  amount: number
): Promise<TransactionInstruction | null> {
  try {
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256');
    hash.update('global:distribute_fees_from_vault');
    const fullHash = hash.digest();
    const discriminator = Buffer.from(fullHash.slice(0, 8));

    const { getAssociatedTokenAddress } = await import('@solana/spl-token');
    const underlyingMint = new PublicKey(riftData.underlyingMint);
    const decimals = await getCachedMintDecimals(ctx.connection, underlyingMint, ctx.mintInfoCache, MINT_CACHE_TTL);
    const decimalMultiplier = Math.pow(10, decimals);

    // Detect token program - retry on failure to avoid wrong ATA derivation (causes error 6071)
    const TOKEN_2022_PROGRAM_ID_STR = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    const TOKEN_PROGRAM_ID_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

    let mintAccountInfo = await ctx.connection.getAccountInfo(underlyingMint);
    if (!mintAccountInfo) {
      console.warn('[CREATE-DISTRIBUTE-IX] Mint account info null, retrying...');
      await new Promise(r => setTimeout(r, 500));
      mintAccountInfo = await ctx.connection.getAccountInfo(underlyingMint);
    }
    if (!mintAccountInfo) {
      throw new Error('Failed to fetch mint account info for instruction');
    }

    const isToken2022 = mintAccountInfo.owner?.toBase58() === TOKEN_2022_PROGRAM_ID_STR;
    const tokenProgramId = isToken2022 ? new PublicKey(TOKEN_2022_PROGRAM_ID_STR) : new PublicKey(TOKEN_PROGRAM_ID_STR);

    const amountLamports = BigInt(Math.floor(amount * decimalMultiplier));
    const amountBytes = new DataView(new ArrayBuffer(8));
    amountBytes.setBigUint64(0, amountLamports, true);
    const amountBuffer = Buffer.from(amountBytes.buffer);

    const instructionData = Buffer.concat([discriminator, amountBuffer]);

    const [feesVault] = PublicKey.findProgramAddressSync(
      [Buffer.from('fees_vault'), riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault_auth'), riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const treasuryWallet = new PublicKey(riftData.treasuryWallet!);
    const treasuryAccount = await getAssociatedTokenAddress(
      underlyingMint,
      treasuryWallet,
      false,
      tokenProgramId
    );

    // Partner optional: if none configured, fall back to treasury
    const partnerWallet = riftData.partnerWallet
      ? new PublicKey(riftData.partnerWallet)
      : treasuryWallet;
    const partnerAccount = await getAssociatedTokenAddress(
      underlyingMint,
      partnerWallet,
      false,
      tokenProgramId
    );

    const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

    const keys = [
      { pubkey: ctx.wallet!.publicKey!, isSigner: true, isWritable: true },
      { pubkey: riftPubkey, isSigner: false, isWritable: true },
      { pubkey: feesVault, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: underlyingMint, isSigner: false, isWritable: false },
      { pubkey: treasuryWallet, isSigner: false, isWritable: false },
      { pubkey: treasuryAccount, isSigner: false, isWritable: true },
      { pubkey: partnerWallet, isSigner: false, isWritable: false },
      { pubkey: partnerAccount, isSigner: false, isWritable: true },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ];

    return new TransactionInstruction({
      keys,
      programId: RIFTS_PROGRAM_ID,
      data: instructionData,
    });
  } catch (error) {
    console.error('Error creating distribute fees instruction:', error);
    return null;
  }
}

/**
 * Create distribute withheld vault instruction (for DEX fees)
 */
async function createDistributeWithheldVaultInstruction(
  ctx: ServiceContext,
  riftPubkey: PublicKey,
  riftData: DecodedRiftData,
  amount: number
): Promise<TransactionInstruction | null> {
  try {
    const discriminator = Buffer.from([92, 236, 64, 62, 111, 111, 14, 102]);

    const { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress } = await import('@solana/spl-token');
    const riftMint = new PublicKey(riftData.riftMint);
    const decimals = await getCachedMintDecimals(ctx.connection, riftMint, ctx.mintInfoCache, MINT_CACHE_TTL, TOKEN_2022_PROGRAM_ID);
    const decimalMultiplier = Math.pow(10, decimals);

    const amountLamports = BigInt(Math.floor(amount * decimalMultiplier));
    const amountBytes = new DataView(new ArrayBuffer(8));
    amountBytes.setBigUint64(0, amountLamports, true);
    const amountBuffer = Buffer.from(amountBytes.buffer);

    const instructionData = Buffer.concat([discriminator, amountBuffer]);

    const [withheldVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("withheld_vault"), riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_auth"), riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const treasuryWallet = new PublicKey(riftData.treasuryWallet!);
    const treasuryTokenAccount = await getAssociatedTokenAddress(
      riftMint,
      treasuryWallet,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    let partnerTokenAccount;
    if (riftData.partnerWallet) {
      const partnerWallet = new PublicKey(riftData.partnerWallet);
      partnerTokenAccount = await getAssociatedTokenAddress(
        riftMint,
        partnerWallet,
        false,
        TOKEN_2022_PROGRAM_ID
      );
    } else {
      partnerTokenAccount = RIFTS_PROGRAM_ID;
    }

    const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

    const keys = [
      { pubkey: ctx.wallet!.publicKey!, isSigner: true, isWritable: true },
      { pubkey: riftPubkey, isSigner: false, isWritable: true },
      { pubkey: withheldVault, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: riftMint, isSigner: false, isWritable: false },
      { pubkey: treasuryWallet, isSigner: false, isWritable: false },
      { pubkey: treasuryTokenAccount, isSigner: false, isWritable: true },
      { pubkey: riftData.partnerWallet ? new PublicKey(riftData.partnerWallet) : RIFTS_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: partnerTokenAccount, isSigner: false, isWritable: !!riftData.partnerWallet },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    return new TransactionInstruction({
      keys,
      programId: RIFTS_PROGRAM_ID,
      data: instructionData,
    });
  } catch (error) {
    console.error('Error creating distribute withheld vault instruction:', error);
    return null;
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
      const status = await ctx.connection.getSignatureStatus(signature, { searchTransactionHistory: true } as any);
      if (status?.value?.confirmationStatus) {
        return true;
      }
      return true;
    }

    const maxRetries = 30;
    console.log('[CONFIRM] Starting polling confirmation for:', signature.slice(0, 20) + '...');

    for (let i = 0; i < maxRetries; i++) {
      try {
        const statuses = await ctx.connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
        const status = statuses?.value?.[0];

        if (status?.err) {
          console.error('[CONFIRM] Transaction failed:', status.err);
          return false;
        }

        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
          console.log('[CONFIRM] Transaction confirmed via polling:', status.confirmationStatus);
          return true;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        // Retry
      }
    }

    console.warn('[CONFIRM] Transaction not confirmed after 30s, assuming success');
    return true;
  } catch (error) {
    console.error('[CONFIRM] Error confirming transaction:', error);
    return false;
  }
}

/**
 * Wait for final result and surface meta.err if present
 */
async function waitForFinalResult(ctx: ServiceContext, signature: string): Promise<{ err: any | null }> {
  try {
    const maxRetries = 40;
    for (let i = 0; i < maxRetries; i++) {
      let status: any = null;
      try {
        if (typeof (ctx.connection as any).getSignatureStatuses === 'function') {
          const statuses = await (ctx.connection as any).getSignatureStatuses([signature], { searchTransactionHistory: true });
          status = statuses?.value?.[0] || null;
        } else if (typeof ctx.connection.getSignatureStatus === 'function') {
          const single = await ctx.connection.getSignatureStatus(signature, { searchTransactionHistory: true } as any);
          status = single?.value || null;
        }
      } catch (err) {
        console.warn('[CONFIRM] status lookup failed, retrying', err);
      }

      if (status?.err) {
        return { err: status.err };
      }

      if (status?.confirmationStatus === 'finalized') {
        // If finalized with no err, double-check transaction meta
        try {
          const tx = await ctx.connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
          } as any);
          if (tx?.meta?.err) {
            return { err: tx.meta.err };
          }
        } catch {
          // ignore
        }
        return { err: null };
      }

      await new Promise(resolve => setTimeout(resolve, 750));
    }

    // If we exit loop, treat as indeterminate success
    return { err: null };
  } catch (error) {
    console.error('[CONFIRM] waitForFinalResult error', error);
    return { err: null };
  }
}
