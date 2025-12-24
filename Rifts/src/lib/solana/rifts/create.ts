// lib/solana/rifts/create.ts - Rift creation functionality
import { Connection, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram, TransactionInstruction, SYSVAR_RENT_PUBKEY, Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as anchor from '@coral-xyz/anchor';
import { ServiceContext, ProductionRiftData, RIFTS_PROGRAM_ID } from './types';
import riftsIdl from '@/lib/idl/rifts_protocol_v2.json';

// ============ CREATE RIFT WITH VANITY PDA ============

export interface CreateRiftWithVanityPDAParams {
  creator: PublicKey;
  underlyingMint: PublicKey;
  partnerWallet?: PublicKey;
  riftName?: string;
  transferFeeBps?: number;
  prefixType?: number; // 0 = 'r' (Rift), 1 = 'm' (Monorift)
  burnFeeBps?: number; // Burn fee in basis points (e.g., 45 = 0.45%)
  partnerFeeBps?: number; // Partner fee in basis points
}

export interface CreateRiftResult {
  success: boolean;
  signature?: string;
  riftId?: string;
  riftMintAddress?: string;
  error?: string;
}

export async function createRiftWithVanityPDA(
  ctx: ServiceContext,
  params: CreateRiftWithVanityPDAParams,
  helpers: {
    confirmTransactionSafely: (sig: string, skipWait?: boolean) => Promise<boolean>;
    saveRiftsToSupabase: (rifts: ProductionRiftData[]) => Promise<void>;
  }
): Promise<CreateRiftResult> {
  const totalStartTime = performance.now();
  console.log('⏱️ [TIMING] === CREATE RIFT START ===');

  try {
    const step1Start = performance.now();
    if (!ctx.wallet || !ctx.wallet.publicKey) {
      throw new Error('Wallet not connected');
    }
    console.log('⏱️ [TIMING] Wallet check: ' + (performance.now() - step1Start).toFixed(2) + 'ms');

    // Generate PDA client-side
    const step2Start = performance.now();
    const { VanityPDAGenerator } = await import('@/lib/vanity-pda-generator');

    const vanityResult = await VanityPDAGenerator.generateVanityPDA(
      params.creator,
      params.underlyingMint,
      '', // No pattern - instant generation
      100 // Just 100 attempts
    );
    console.log('⏱️ [TIMING] Vanity PDA generation: ' + (performance.now() - step2Start).toFixed(2) + 'ms');

    if (!vanityResult) {
      throw new Error('Could not generate any PDA');
    }

    const { mintPDA, vanitySeed } = vanityResult;
    console.log('🔍 [DEBUG] Mint PDA:', mintPDA.toString());

    // Calculate rift PDA
    const step3Start = performance.now();
    const [riftPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("rift"), params.underlyingMint.toBuffer(), params.creator.toBuffer(), vanitySeed],
      RIFTS_PROGRAM_ID
    );
    console.log('⏱️ [TIMING] Rift PDA calculation: ' + (performance.now() - step3Start).toFixed(2) + 'ms');
    console.log('🔍 [DEBUG] Rift PDA:', riftPDA.toString());

    // Create the instruction
    const step4Start = performance.now();
    const instruction = await createRiftWithVanityPDAInstruction(ctx, {
      riftPDA,
      riftMintPDA: mintPDA,
      vanitySeed,
      creator: params.creator,
      underlyingMint: params.underlyingMint,
      partnerWallet: params.partnerWallet,
      riftName: params.riftName,
      transferFeeBps: params.transferFeeBps || 80,
      prefixType: params.prefixType ?? 0,
    });
    console.log('⏱️ [TIMING] Instruction creation: ' + (performance.now() - step4Start).toFixed(2) + 'ms');

    if (!instruction) {
      throw new Error('Failed to create vanity PDA instruction');
    }

    // Create transaction
    const transaction = new Transaction().add(instruction);
    transaction.feePayer = ctx.wallet.publicKey;

    // Send transaction
    const step5Start = performance.now();
    const signature = await ctx.wallet.sendTransaction(transaction, ctx.connection, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 5
    });
    console.log('⏱️ [TIMING] Send transaction: ' + (performance.now() - step5Start).toFixed(2) + 'ms');

    // Wait for confirmation
    const step8Start = performance.now();
    const confirmed = await helpers.confirmTransactionSafely(signature, false);
    console.log('⏱️ [TIMING] Transaction confirmation: ' + (performance.now() - step8Start).toFixed(2) + 'ms');

    if (!confirmed) {
      throw new Error('Transaction failed to confirm');
    }

    // Check transaction status
    const status = await ctx.connection.getSignatureStatus(signature);
    if (status?.value?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
    }

    console.log('[CREATE-RIFT] Transaction confirmed successfully!');

    // Save to Supabase
    const step10Start = performance.now();
    const newRiftData: ProductionRiftData = {
      id: riftPDA.toBase58(),
      address: riftPDA.toBase58(),
      symbol: params.riftName || 'RIFT',
      underlying: params.riftName || 'RIFT',
      strategy: 'Volatility Farming',
      apy: 0,
      tvl: 0,
      volume24h: 0,
      risk: 'Medium' as const,
      backingRatio: 100,
      burnFee: 0,
      partnerFee: Math.floor((params.transferFeeBps || 80) / 100),
      creator: params.creator.toBase58(),
      underlyingMint: params.underlyingMint.toBase58(),
      riftMint: mintPDA.toBase58(),
      vault: '',
      totalWrapped: '0',
      totalBurned: '0',
      createdAt: new Date(),
      lastRebalance: new Date(),
      arbitrageOpportunity: 0,
      oracleCountdown: 0,
      nextRebalance: 0,
      performance: [],
      realVaultBalance: 0,
      realRiftSupply: 0,
      realBackingRatio: 100,
      priceDeviation: 0,
      volumeTriggerActive: false,
      participants: 0,
      oracleStatus: 'active' as const
    };

    await helpers.saveRiftsToSupabase([newRiftData]);
    console.log('⏱️ [TIMING] Save to Supabase: ' + (performance.now() - step10Start).toFixed(2) + 'ms');

    // Track referred rift if creator was referred
    const step11Start = performance.now();
    try {
      await trackReferredRift(params.creator.toBase58(), riftPDA.toBase58());
      console.log('⏱️ [TIMING] Track referred rift: ' + (performance.now() - step11Start).toFixed(2) + 'ms');
    } catch (refErr) {
      console.log('[CREATE-RIFT] Referral tracking skipped:', refErr);
    }

    const totalTime = performance.now() - totalStartTime;
    console.log('⏱️ [TIMING] === TOTAL CREATE RIFT TIME: ' + totalTime.toFixed(2) + 'ms ===');

    return {
      success: true,
      signature,
      riftId: riftPDA.toBase58(),
      riftMintAddress: mintPDA.toBase58()
    };

  } catch (error) {
    console.error('❌ [CREATE-RIFT] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// ============ CREATE RIFT AND WRAP INSTRUCTIONS ============

export interface CreateRiftAndWrapParams {
  creator: PublicKey;
  underlyingMint: PublicKey;
  wrapAmount: number;
  partnerWallet?: PublicKey;
  riftName?: string;
  transferFeeBps?: number;
  prefixType?: number;
}

export interface CreateRiftAndWrapResult {
  success: boolean;
  instructions?: TransactionInstruction[];
  riftId?: string;
  riftMintAddress?: string;
  error?: string;
}

export async function createRiftAndWrapInstructions(
  ctx: ServiceContext,
  params: CreateRiftAndWrapParams
): Promise<CreateRiftAndWrapResult> {
  const totalStart = performance.now();
  console.log('[BUNDLE] ⏱️ Creating bundled rift + wrap instructions...');

  try {
    if (!ctx.wallet || !ctx.wallet.publicKey) {
      throw new Error('Wallet not connected');
    }

    // Generate vanity PDA
    const step1Start = performance.now();
    const { VanityPDAGenerator } = await import('@/lib/vanity-pda-generator');
    const vanityResult = await VanityPDAGenerator.generateVanityPDA(
      params.creator,
      params.underlyingMint,
      '',
      100
    );
    console.log(`[BUNDLE] ⏱️ Step 1 (Vanity PDA): ${(performance.now() - step1Start).toFixed(1)}ms`);

    if (!vanityResult) {
      throw new Error('Could not generate PDA');
    }

    const { mintPDA, vanitySeed } = vanityResult;

    // Calculate rift PDA
    const [riftPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("rift"), params.underlyingMint.toBuffer(), params.creator.toBuffer(), vanitySeed],
      RIFTS_PROGRAM_ID
    );

    // Import spl-token and detect token program
    const step2Start = performance.now();
    const { 
      getMint, 
      TOKEN_2022_PROGRAM_ID, 
      getAssociatedTokenAddress,
      createAssociatedTokenAccountIdempotentInstruction,
      createSyncNativeInstruction
    } = await import('@solana/spl-token');
    console.log(`[BUNDLE] ⏱️ Step 2a (Import): ${(performance.now() - step2Start).toFixed(1)}ms`);

    let decimals = 9;
    let underlyingTokenProgram = TOKEN_PROGRAM_ID;

    const step2bStart = performance.now();
    try {
      const mintAccountInfo = await ctx.connection.getAccountInfo(params.underlyingMint, 'processed');
      if (mintAccountInfo) {
        const mintOwner = mintAccountInfo.owner.toBase58();
        if (mintOwner === TOKEN_2022_PROGRAM_ID.toBase58()) {
          underlyingTokenProgram = TOKEN_2022_PROGRAM_ID;
          const mintInfo = await getMint(ctx.connection, params.underlyingMint, 'confirmed', TOKEN_2022_PROGRAM_ID);
          decimals = mintInfo.decimals;
        } else {
          const mintInfo = await getMint(ctx.connection, params.underlyingMint, 'confirmed', TOKEN_PROGRAM_ID);
          decimals = mintInfo.decimals;
        }
      }
    } catch (e) {
      console.warn('[BUNDLE] Could not fetch mint info:', e);
    }
    console.log(`[BUNDLE] ⏱️ Step 2b (Detect): ${(performance.now() - step2bStart).toFixed(1)}ms`);

    // Create rift instruction
    const step3Start = performance.now();
    const riftInstruction = await createRiftWithVanityPDAInstruction(ctx, {
      riftPDA,
      riftMintPDA: mintPDA,
      vanitySeed,
      creator: params.creator,
      underlyingMint: params.underlyingMint,
      partnerWallet: params.partnerWallet,
      riftName: params.riftName,
      transferFeeBps: params.transferFeeBps || 80,
      prefixType: params.prefixType ?? 0,
      underlyingTokenProgram,
    });
    console.log(`[BUNDLE] ⏱️ Step 3 (Rift instruction): ${(performance.now() - step3Start).toFixed(1)}ms`);

    if (!riftInstruction) {
      throw new Error('Failed to create rift instruction');
    }

    // Calculate PDAs
    const step4Start = performance.now();
    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), riftPDA.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const [riftMintAuthPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('rift_mint_auth'), riftPDA.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const [feesVaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('fees_vault'), riftPDA.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const [vaultAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault_auth'), riftPDA.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const userUnderlyingAta = await getAssociatedTokenAddress(
      params.underlyingMint,
      params.creator,
      false,
      underlyingTokenProgram
    );

    const userRiftAta = await getAssociatedTokenAddress(
      mintPDA,
      params.creator,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    console.log(`[BUNDLE] ⏱️ Step 4 (PDAs): ${(performance.now() - step4Start).toFixed(1)}ms`);

    // Ensure user token accounts exist before wrapping
    const createAtaInstructions: TransactionInstruction[] = [];
    const userUnderlyingInfo = await ctx.connection.getAccountInfo(userUnderlyingAta, 'processed');
    console.log('[BUNDLE] Underlying ATA exists?', !!userUnderlyingInfo, 'ATA:', userUnderlyingAta.toBase58());
    if (!userUnderlyingInfo) {
      createAtaInstructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          ctx.wallet.publicKey,
          userUnderlyingAta,
          params.creator,
          params.underlyingMint,
          underlyingTokenProgram
        )
      );
    }

    const userRiftInfo = await ctx.connection.getAccountInfo(userRiftAta, 'processed');
    console.log('[BUNDLE] Rift ATA exists?', !!userRiftInfo, 'ATA:', userRiftAta.toBase58());
    if (!userRiftInfo) {
      createAtaInstructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          ctx.wallet.publicKey,
          userRiftAta,
          params.creator,
          mintPDA,
          TOKEN_2022_PROGRAM_ID
        )
      );
    }

    // Create wrap instruction data
    const instructionData = Buffer.alloc(24);
    const discriminator = Buffer.from([244, 137, 57, 251, 232, 224, 54, 14]); // wrap_tokens
    discriminator.copy(instructionData, 0);

    const amountLamports = BigInt(Math.floor(params.wrapAmount * Math.pow(10, decimals)));
    const amountBytesWrap = new DataView(new ArrayBuffer(8));
    amountBytesWrap.setBigUint64(0, amountLamports, true);
    Buffer.from(amountBytesWrap.buffer).copy(instructionData, 8);
    Buffer.alloc(8).copy(instructionData, 16); // min_rift_out = 0

    // If wrapping SOL, ensure the WSOL ATA has enough balance (fund + sync native)
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    if (params.underlyingMint.toBase58() === SOL_MINT) {
      let currentBalanceLamports = BigInt(0);
      try {
        const bal = await ctx.connection.getTokenAccountBalance(userUnderlyingAta);
        const uiAmount = bal?.value?.uiAmount || 0;
        // Convert uiAmount to lamports using decimals (9 for SOL)
        currentBalanceLamports = BigInt(Math.floor(uiAmount * Math.pow(10, 9)));
        console.log('[BUNDLE] Existing WSOL balance (lamports):', currentBalanceLamports.toString());
      } catch {
        // If balance fetch fails, assume zero and continue to fund
        currentBalanceLamports = BigInt(0);
        console.warn('[BUNDLE] Could not fetch WSOL balance, assuming 0');
      }

      const neededLamports = amountLamports > currentBalanceLamports ? amountLamports - currentBalanceLamports : BigInt(0);
      console.log('[BUNDLE] Needed lamports for wrap:', neededLamports.toString());
      if (neededLamports > BigInt(0)) {
        createAtaInstructions.push(
          SystemProgram.transfer({
            fromPubkey: params.creator,
            toPubkey: userUnderlyingAta,
            lamports: Number(neededLamports),
          })
        );
        createAtaInstructions.push(createSyncNativeInstruction(userUnderlyingAta));
      } else {
        console.log('[BUNDLE] No additional lamports needed for WSOL ATA');
      }
    }

    // Build wrap instruction
    const wrapInstruction = new TransactionInstruction({
      programId: RIFTS_PROGRAM_ID,
      keys: [
        { pubkey: params.creator, isSigner: true, isWritable: true },
        { pubkey: riftPDA, isSigner: false, isWritable: true },
        { pubkey: userUnderlyingAta, isSigner: false, isWritable: true },
        { pubkey: userRiftAta, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: params.underlyingMint, isSigner: false, isWritable: false },
        { pubkey: mintPDA, isSigner: false, isWritable: true },
        { pubkey: riftMintAuthPDA, isSigner: false, isWritable: false },
        { pubkey: feesVaultPDA, isSigner: false, isWritable: true },
        { pubkey: vaultAuthorityPDA, isSigner: false, isWritable: false },
        { pubkey: underlyingTokenProgram, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
      ],
      data: instructionData,
    });

    console.log(`[BUNDLE] ⏱️ Total: ${(performance.now() - totalStart).toFixed(1)}ms`);

    return {
      success: true,
      instructions: [riftInstruction, ...createAtaInstructions, wrapInstruction],
      riftId: riftPDA.toBase58(),
      riftMintAddress: mintPDA.toBase58(),
    };

  } catch (error) {
    console.error('[BUNDLE] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// ============ CREATE RIFT WITH VANITY PDA INSTRUCTION ============

interface CreateRiftInstructionParams {
  riftPDA: PublicKey;
  riftMintPDA: PublicKey;
  vanitySeed: Buffer;
  creator: PublicKey;
  underlyingMint: PublicKey;
  partnerWallet?: PublicKey;
  riftName?: string;
  transferFeeBps?: number;
  prefixType?: number;
  underlyingTokenProgram?: PublicKey;
}

async function createRiftWithVanityPDAInstruction(
  ctx: ServiceContext,
  params: CreateRiftInstructionParams
): Promise<TransactionInstruction | null> {
  try {
    const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

    // Calculate PDAs
    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), params.riftPDA.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const [feesVaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("fees_vault"), params.riftPDA.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const [withheldVaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("withheld_vault"), params.riftPDA.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_auth"), params.riftPDA.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const [riftMintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("rift_mint_auth"), params.riftPDA.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    // Detect underlying token program if not passed
    let detectedUnderlyingTokenProgram = params.underlyingTokenProgram || TOKEN_PROGRAM_ID;
    if (!params.underlyingTokenProgram) {
      try {
        const mintAccountInfo = await ctx.connection.getAccountInfo(params.underlyingMint, 'processed');
        if (mintAccountInfo) {
          const mintOwner = mintAccountInfo.owner.toBase58();
          if (mintOwner === TOKEN_2022_PROGRAM_ID.toBase58()) {
            detectedUnderlyingTokenProgram = TOKEN_2022_PROGRAM_ID;
          }
        }
      } catch (e) {
        console.warn('[CREATE-RIFT] Could not detect token program:', e);
      }
    }

    // Prepare args
    const vanitySeedArray = new Uint8Array(32);
    vanitySeedArray.set(params.vanitySeed);

    const riftNameArray = new Uint8Array(32);
    if (params.riftName) {
      const nameBytes = Buffer.from(params.riftName, 'utf8');
      riftNameArray.set(nameBytes.slice(0, 32));
    }

    const nameLen = params.riftName ? Math.min(Buffer.from(params.riftName, 'utf8').length, 32) : 0;
    const transferFeeBps = params.transferFeeBps || 80;
    const prefixType = params.prefixType ?? 0;

    // Create Anchor program
    const cleanIdl = {
      ...riftsIdl,
      address: RIFTS_PROGRAM_ID.toString(),
      metadata: { address: RIFTS_PROGRAM_ID.toString() },
    };

    const provider = new anchor.AnchorProvider(
      ctx.connection,
      // @ts-ignore
      { publicKey: params.creator } as any,
      { commitment: 'confirmed' }
    );

    const program = new anchor.Program(cleanIdl as any, provider);

    // Build instruction using Anchor
    const instruction = await program.methods
      .createRiftWithVanityPda(
        Array.from(vanitySeedArray),
        params.vanitySeed.length,
        params.partnerWallet || null,
        Array.from(riftNameArray),
        nameLen,
        transferFeeBps,
        prefixType
      )
      .accounts({
        creator: params.creator,
        rift: params.riftPDA,
        underlyingMint: params.underlyingMint,
        riftMint: params.riftMintPDA,
        riftMintAuthority: riftMintAuthority,
        vault: vaultPDA,
        feesVault: feesVaultPDA,
        withheldVault: withheldVaultPDA,
        vaultAuthority: vaultAuthority,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        underlyingTokenProgram: detectedUnderlyingTokenProgram,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    return instruction;

  } catch (error) {
    console.error('❌ [CREATE-INSTRUCTION] Error:', error);
    return null;
  }
}

// ============ VANITY ADDRESS POOL (Static) ============

const vanityAddressPool: Array<{ keypair: Keypair; address: string }> = [];
let isGeneratingPool = false;
const POOL_TARGET_SIZE = 3;
const POOL_REFILL_THRESHOLD = 1;

export async function generateVanityAddressPool(): Promise<void> {
  if (isGeneratingPool) return;
  isGeneratingPool = true;

  while (vanityAddressPool.length < POOL_TARGET_SIZE) {
    const result = await generateSingleVanityAddress();
    if (result) {
      vanityAddressPool.push(result);
    }
  }

  isGeneratingPool = false;
}

async function generateSingleVanityAddress(): Promise<{ keypair: Keypair; address: string } | null> {
  try {
    if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      const { vanityAccelerator } = await import('@/lib/vanity-accelerator');
      const result = await vanityAccelerator.generateVanityAddress('rift');
      if (result) {
        return { keypair: result.keypair, address: result.address };
      }
    }

    // Fallback
    const maxAttempts = 5000000;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const keypair = Keypair.generate();
      const address = keypair.publicKey.toBase58();
      if (address.toLowerCase().endsWith('rift')) {
        return { keypair, address };
      }
      if (attempt % 50000 === 0 && attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

export function getVanityAddressFromPool(): { keypair: Keypair; address: string } | null {
  const result = vanityAddressPool.shift() || null;
  if (result && vanityAddressPool.length <= POOL_REFILL_THRESHOLD) {
    generateVanityAddressPool().catch(console.error);
  }
  return result;
}

export function getVanityPoolStatus() {
  return {
    poolSize: vanityAddressPool.length,
    targetSize: POOL_TARGET_SIZE,
    isGenerating: isGeneratingPool,
    refillThreshold: POOL_REFILL_THRESHOLD,
    addresses: vanityAddressPool.map(item => item.address)
  };
}

export function clearVanityPool(): void {
  vanityAddressPool.length = 0;
}

export async function preWarmVanityPool(): Promise<void> {
  return generateVanityAddressPool();
}

// ============ REFERRAL TRACKING ============

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://nitmreqtsnzjylyzwsri.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

/**
 * Track a rift created by a referred user.
 * This rift will generate 5% referral rewards on all its arb profits.
 */
async function trackReferredRift(creatorWallet: string, riftId: string): Promise<void> {
  const headers = {
    'apikey': SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };

  // Check if creator was referred
  const referralResponse = await fetch(
    `${SUPABASE_URL}/rest/v1/referrals?referred_wallet=eq.${creatorWallet}&select=referrer_wallet`,
    { headers, cache: 'no-store' }
  );

  if (!referralResponse.ok) {
    console.log('[REFERRAL] Failed to check referral status');
    return;
  }

  const referrals = await referralResponse.json();
  if (!referrals || referrals.length === 0) {
    console.log('[REFERRAL] Creator was not referred, skipping tracking');
    return;
  }

  const referrerWallet = referrals[0].referrer_wallet;
  console.log('[REFERRAL] Creator was referred by:', referrerWallet);

  // Record the rift in referred_rifts table
  const createResponse = await fetch(
    `${SUPABASE_URL}/rest/v1/referred_rifts`,
    {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        rift_id: riftId,
        referrer_wallet: referrerWallet,
        creator_wallet: creatorWallet
      }),
    }
  );

  if (createResponse.ok) {
    console.log('[REFERRAL] Tracked referred rift:', riftId, 'for referrer:', referrerWallet);
  } else {
    const error = await createResponse.text();
    console.log('[REFERRAL] Failed to track referred rift:', error);
  }
}
