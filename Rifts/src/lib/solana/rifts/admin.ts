// lib/solana/rifts/admin.ts - Admin and management functions
import { Connection, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ServiceContext, WalletAdapter, RIFTS_PROGRAM_ID, getProgramIdForRift } from './types';

// ============ INITIALIZE VAULT ============

export interface InitializeVaultParams {
  user: PublicKey;
  riftPubkey: PublicKey;
}

export interface InitializeVaultResult {
  success: boolean;
  signature?: string;
  error?: string;
}

export async function createInitializeVaultInstruction(
  ctx: ServiceContext,
  riftPubkey: PublicKey,
  payer: PublicKey,
  getRiftData: (rift: PublicKey) => Promise<any>
): Promise<TransactionInstruction | null> {
  try {
    // Calculate discriminator for initialize_vault
    const discriminator = Buffer.from([48, 191, 163, 44, 71, 129, 63, 164]);
    const instructionData = Buffer.alloc(8);
    discriminator.copy(instructionData, 0);

    // Get rift data to find underlying mint
    const riftData = await getRiftData(riftPubkey);
    if (!riftData) {
      throw new Error('Rift not found');
    }

    // Calculate vault PDA
    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    // Calculate vault authority PDA
    const [vaultAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_auth"), riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    // Calculate rift mint authority PDA
    const [riftMintAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("rift_mint_auth"), riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const SYSVAR_RENT_PUBKEY = new PublicKey('SysvarRent111111111111111111111111111111111');

    return new TransactionInstruction({
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: riftPubkey, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: new PublicKey(riftData.underlyingMint), isSigner: false, isWritable: false },
        { pubkey: vaultAuthorityPDA, isSigner: false, isWritable: false },
        { pubkey: riftMintAuthorityPDA, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: RIFTS_PROGRAM_ID,
      data: instructionData,
    });
  } catch (error) {
    console.error('[ERROR] Failed to create initialize vault instruction:', error);
    return null;
  }
}

export async function initializeVault(
  ctx: ServiceContext,
  params: InitializeVaultParams,
  helpers: {
    getRiftData: (rift: PublicKey) => Promise<any>;
    forceCloseAccount: (account: PublicKey) => Promise<{ success: boolean; signature?: string; error?: string }>;
    confirmTransactionSafely: (sig: string) => Promise<boolean>;
  }
): Promise<InitializeVaultResult> {
  try {
    if (!ctx.wallet) {
      throw new Error('Wallet not connected');
    }

    // First, check if vault already exists
    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), params.riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const vaultAccountInfo = await ctx.connection.getAccountInfo(vaultPDA);

    if (vaultAccountInfo) {
      const TOKEN_PROGRAM_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      if (vaultAccountInfo.owner.toBase58() === TOKEN_PROGRAM_STR) {
        const closeResult = await helpers.forceCloseAccount(vaultPDA);
        if (!closeResult.success) {
          return {
            success: false,
            error: `Failed to close conflicting token account: ${closeResult.error}`
          };
        }
      } else if (vaultAccountInfo.data.length === 0 || vaultAccountInfo.data.length < 165) {
        const closeResult = await helpers.forceCloseAccount(vaultPDA);
        if (!closeResult.success) {
          return {
            success: false,
            error: `Failed to close corrupted vault: ${closeResult.error}`
          };
        }
      } else if (vaultAccountInfo.owner.toBase58() === RIFTS_PROGRAM_ID.toBase58()) {
        return { success: true, signature: 'vault_already_initialized' };
      } else {
        return {
          success: false,
          error: `Vault account owned by unexpected program: ${vaultAccountInfo.owner.toBase58()}`
        };
      }
    }

    const instruction = await createInitializeVaultInstruction(ctx, params.riftPubkey, params.user, helpers.getRiftData);
    if (!instruction) {
      throw new Error('Failed to create initialize vault instruction');
    }

    const transaction = new Transaction();
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
    );
    transaction.add(instruction);

    const { blockhash } = await ctx.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = params.user;

    const signature = await ctx.wallet.sendTransaction(transaction, ctx.connection);
    const confirmed = await helpers.confirmTransactionSafely(signature);
    if (!confirmed) {
      throw new Error('Initialize vault confirmation failed or timed out');
    }

    return { success: true, signature };
  } catch (error) {
    console.error('[ERROR] Initialize vault failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Initialize vault failed'
    };
  }
}

// ============ FORCE CLOSE ACCOUNT ============

export interface ForceCloseResult {
  success: boolean;
  signature?: string;
  error?: string;
}

export async function forceCloseAccount(
  ctx: ServiceContext,
  accountPubkey: PublicKey,
  confirmTransactionSafely: (sig: string) => Promise<boolean>
): Promise<ForceCloseResult> {
  try {
    if (!ctx.wallet) {
      throw new Error('Wallet not connected');
    }

    const accountInfo = await ctx.connection.getAccountInfo(accountPubkey);
    if (!accountInfo) {
      return { success: true };
    }

    const transaction = new Transaction();
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: accountPubkey,
        toPubkey: ctx.wallet.publicKey!,
        lamports: accountInfo.lamports,
      })
    );

    const { blockhash } = await ctx.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = ctx.wallet.publicKey!;

    const simulation = await ctx.connection.simulateTransaction(transaction);

    if (simulation.value.err) {
      return await programForceClose(ctx, accountPubkey, confirmTransactionSafely);
    }

    const signature = await ctx.wallet.sendTransaction(transaction, ctx.connection);
    const confirmed = await confirmTransactionSafely(signature);
    if (!confirmed) {
      throw new Error('Force close confirmation failed or timed out');
    }

    return { success: true, signature };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Force close failed'
    };
  }
}

async function programForceClose(
  ctx: ServiceContext,
  accountPubkey: PublicKey,
  confirmTransactionSafely: (sig: string) => Promise<boolean>
): Promise<ForceCloseResult> {
  try {
    if (!ctx.wallet?.publicKey) {
      throw new Error('Wallet not connected');
    }

    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: ctx.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: accountPubkey, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: SystemProgram.programId,
      data: Buffer.from([2]),
    });

    const transaction = new Transaction();
    transaction.add(instruction);

    const { blockhash } = await ctx.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = ctx.wallet.publicKey!;

    const signature = await ctx.wallet.sendTransaction(transaction, ctx.connection);
    await confirmTransactionSafely(signature);

    return { success: true, signature };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Program force close failed'
    };
  }
}

// ============ CLEANUP STUCK ACCOUNTS ============

export async function cleanupStuckAccounts(
  ctx: ServiceContext,
  creator: PublicKey,
  underlyingMint: PublicKey,
  confirmTransactionSafely: (sig: string) => Promise<boolean>
): Promise<ForceCloseResult> {
  try {
    if (!ctx.wallet?.publicKey) {
      throw new Error('Wallet not connected');
    }

    const [riftPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("rift"), underlyingMint.toBuffer(), creator.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const [riftMintPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("rift_mint"), riftPDA.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const discriminator = Buffer.from([100, 220, 53, 26, 12, 35, 133, 38]);

    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: creator, isSigner: false, isWritable: false },
        { pubkey: underlyingMint, isSigner: false, isWritable: false },
        { pubkey: riftMintPDA, isSigner: false, isWritable: true },
        { pubkey: riftPDA, isSigner: false, isWritable: false },
        { pubkey: ctx.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: RIFTS_PROGRAM_ID,
      data: discriminator,
    });

    const transaction = new Transaction();
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
    );
    transaction.add(instruction);

    const { blockhash } = await ctx.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = ctx.wallet.publicKey;

    const simulation = await ctx.connection.simulateTransaction(transaction);

    if (simulation.value.err) {
      throw new Error(`Cleanup simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }

    const signature = await ctx.wallet.sendTransaction(transaction, ctx.connection);
    const confirmed = await confirmTransactionSafely(signature);
    if (!confirmed) {
      throw new Error('Cleanup confirmation failed or timed out');
    }

    return { success: true, signature };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Cleanup failed'
    };
  }
}

// ============ CLOSE RIFT ============

export interface CloseRiftParams {
  creator: PublicKey;
  riftPubkey: PublicKey;
}

async function createCloseRiftInstruction(
  ctx: ServiceContext,
  riftPubkey: PublicKey,
  creator: PublicKey
): Promise<TransactionInstruction | null> {
  try {
    const discriminator = Buffer.from([140, 145, 139, 209, 3, 35, 103, 222]); // close_rift discriminator

    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const [riftMintPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("rift_mint"), riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    return new TransactionInstruction({
      keys: [
        { pubkey: creator, isSigner: true, isWritable: true },
        { pubkey: riftPubkey, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: riftMintPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: RIFTS_PROGRAM_ID,
      data: discriminator,
    });
  } catch (error) {
    console.error('[ERROR] Failed to create close rift instruction:', error);
    return null;
  }
}

export async function closeRift(
  ctx: ServiceContext,
  params: CloseRiftParams,
  helpers: {
    getRiftData: (rift: PublicKey) => Promise<any>;
    confirmTransactionSafely: (sig: string) => Promise<boolean>;
  }
): Promise<ForceCloseResult> {
  try {
    if (!ctx.wallet) {
      throw new Error('Wallet not connected');
    }

    const riftData = await helpers.getRiftData(params.riftPubkey);
    if (!riftData) {
      throw new Error('Rift not found');
    }

    const isCorruptedRift = riftData.burnFee > 0.45 || (riftData.partnerFee && riftData.partnerFee > 0.05);

    if (!isCorruptedRift && riftData.creator !== params.creator.toBase58()) {
      throw new Error('Only the rift creator can close this rift');
    }

    const transaction = new Transaction();

    const closeInstruction = await createCloseRiftInstruction(ctx, params.riftPubkey, params.creator);

    if (closeInstruction) {
      transaction.add(closeInstruction);
    } else {
      throw new Error('Failed to create close instruction');
    }

    const { blockhash } = await ctx.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = params.creator;

    const simulation = await ctx.connection.simulateTransaction(transaction);

    if (simulation.value.err) {
      throw new Error(`Close rift simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }

    const signature = await ctx.wallet.sendTransaction(transaction, ctx.connection);
    const confirmed = await helpers.confirmTransactionSafely(signature);
    if (!confirmed) {
      throw new Error('Rift close confirmation failed or timed out');
    }

    return { success: true, signature };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Close rift failed'
    };
  }
}

// ============ ADMIN CLOSE RIFT ============

export interface AdminCloseRiftParams {
  riftPubkey: PublicKey;
}

export async function adminCloseRift(
  ctx: ServiceContext,
  params: AdminCloseRiftParams,
  confirmTransactionSafely: (sig: string) => Promise<boolean>
): Promise<ForceCloseResult> {
  try {
    if (!ctx.wallet?.publicKey) {
      throw new Error('Wallet not connected');
    }

    // Admin close discriminator
    const discriminator = Buffer.from([173, 34, 94, 186, 32, 203, 45, 167]);

    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), params.riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const [riftMintPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("rift_mint"), params.riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: ctx.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: params.riftPubkey, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: riftMintPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: RIFTS_PROGRAM_ID,
      data: discriminator,
    });

    const transaction = new Transaction();
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
    );
    transaction.add(instruction);

    const { blockhash } = await ctx.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = ctx.wallet.publicKey;

    const simulation = await ctx.connection.simulateTransaction(transaction);

    if (simulation.value.err) {
      throw new Error(`Admin close simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }

    const signature = await ctx.wallet.sendTransaction(transaction, ctx.connection);
    const confirmed = await confirmTransactionSafely(signature);
    if (!confirmed) {
      throw new Error('Admin close confirmation failed or timed out');
    }

    return { success: true, signature };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Admin close rift failed'
    };
  }
}

// ============ CHECK PROGRAM STATUS ============

export interface ProgramStatusResult {
  programId: string;
  isActive: boolean;
  riftsCount: number;
  totalTvl: number;
  error?: string;
}

export async function checkProgramStatus(
  ctx: ServiceContext
): Promise<ProgramStatusResult> {
  try {
    // Check if program exists
    const programInfo = await ctx.connection.getAccountInfo(RIFTS_PROGRAM_ID);

    if (!programInfo) {
      return {
        programId: RIFTS_PROGRAM_ID.toBase58(),
        isActive: false,
        riftsCount: 0,
        totalTvl: 0,
        error: 'Program not found'
      };
    }

    // Get all program accounts (rifts)
    const accounts = await ctx.connection.getProgramAccounts(RIFTS_PROGRAM_ID, {
      dataSlice: { offset: 0, length: 8 } // Just get discriminator
    });

    return {
      programId: RIFTS_PROGRAM_ID.toBase58(),
      isActive: true,
      riftsCount: accounts.length,
      totalTvl: 0 // Would need to iterate through all to calculate
    };
  } catch (error) {
    return {
      programId: RIFTS_PROGRAM_ID.toBase58(),
      isActive: false,
      riftsCount: 0,
      totalTvl: 0,
      error: error instanceof Error ? error.message : 'Status check failed'
    };
  }
}

// ============ GET TOKEN BALANCE ============

export async function getTokenBalance(
  connection: Connection,
  publicKey: PublicKey,
  mintAddress: string
): Promise<number> {
  try {
    const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
    let tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      publicKey,
      {
        mint: new PublicKey(mintAddress),
        programId: TOKEN_2022_PROGRAM_ID
      }
    );

    // If no Token-2022 accounts found, try standard Token Program
    if (tokenAccounts.value.length === 0) {
      tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        publicKey,
        { mint: new PublicKey(mintAddress) }
      );
    }

    if (tokenAccounts.value.length === 0) {
      return 0;
    }

    let totalBalance = 0;
    for (const account of tokenAccounts.value) {
      const tokenData = account.account.data.parsed.info;
      const rawAmount = Number(tokenData.tokenAmount.amount);
      const decimals = tokenData.tokenAmount.decimals;
      const balance = rawAmount / Math.pow(10, decimals);

      if (!isFinite(balance) || balance < 0) {
        continue;
      }

      totalBalance += balance;
    }

    return totalBalance;
  } catch (error) {
    console.error('[ERROR] Get token balance failed:', error);
    return 0;
  }
}
