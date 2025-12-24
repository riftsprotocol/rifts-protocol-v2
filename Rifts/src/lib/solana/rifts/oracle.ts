// lib/solana/rifts/oracle.ts - Oracle and rebalance functions
import { Connection, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { ServiceContext, RIFTS_PROGRAM_ID, getProgramIdForRift } from './types';

// ============ ORACLE UPDATE ============

export interface OracleUpdateParams {
  riftPubkey: PublicKey;
  underlyingMint: string;
}

export interface OracleUpdateResult {
  success: boolean;
  signature?: string;
  error?: string;
}

async function createOracleUpdateInstruction(
  ctx: ServiceContext,
  riftPubkey: PublicKey,
  underlyingMint: string
): Promise<TransactionInstruction | null> {
  try {
    // Oracle update discriminator
    const discriminator = Buffer.from([52, 98, 187, 222, 176, 191, 45, 89]);
    const instructionData = Buffer.alloc(8);
    discriminator.copy(instructionData, 0);

    // Calculate vault PDA
    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    // Calculate oracle PDA
    const [oraclePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle"), riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    return new TransactionInstruction({
      keys: [
        { pubkey: ctx.wallet!.publicKey!, isSigner: true, isWritable: true },
        { pubkey: riftPubkey, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: false },
        { pubkey: oraclePDA, isSigner: false, isWritable: true },
        { pubkey: new PublicKey(underlyingMint), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: RIFTS_PROGRAM_ID,
      data: instructionData,
    });
  } catch (error) {
    console.error('[ERROR] Failed to create oracle update instruction:', error);
    return null;
  }
}

export async function updateOraclePrice(
  ctx: ServiceContext,
  params: OracleUpdateParams,
  confirmTransactionSafely: (sig: string) => Promise<boolean>
): Promise<OracleUpdateResult> {
  try {
    if (!ctx.wallet) {
      throw new Error('Wallet not connected');
    }

    const transaction = new Transaction();

    // Add compute budget
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
    );

    // Add oracle update instruction
    const updateInstruction = await createOracleUpdateInstruction(
      ctx,
      params.riftPubkey,
      params.underlyingMint
    );

    if (updateInstruction) {
      transaction.add(updateInstruction);
    } else {
      throw new Error('Failed to create oracle update instruction');
    }

    const { blockhash } = await ctx.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = ctx.wallet.publicKey!;

    const signature = await ctx.wallet.sendTransaction(transaction, ctx.connection);
    await confirmTransactionSafely(signature);

    return { success: true, signature };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Oracle update failed'
    };
  }
}

// ============ TRIGGER REBALANCE ============

export interface RebalanceResult {
  success: boolean;
  signature?: string;
  error?: string;
}

async function createRebalanceInstruction(
  ctx: ServiceContext,
  riftPubkey: PublicKey
): Promise<TransactionInstruction | null> {
  try {
    // Rebalance discriminator
    const discriminator = Buffer.from([183, 142, 225, 194, 201, 189, 28, 51]);
    const instructionData = Buffer.alloc(8);
    discriminator.copy(instructionData, 0);

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

    // Calculate rift mint PDA
    const [riftMintPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("rift_mint"), riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    // Calculate rift mint authority PDA
    const [riftMintAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("rift_mint_auth"), riftPubkey.toBuffer()],
      RIFTS_PROGRAM_ID
    );

    return new TransactionInstruction({
      keys: [
        { pubkey: ctx.wallet!.publicKey!, isSigner: true, isWritable: true },
        { pubkey: riftPubkey, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: vaultAuthorityPDA, isSigner: false, isWritable: false },
        { pubkey: riftMintPDA, isSigner: false, isWritable: true },
        { pubkey: riftMintAuthorityPDA, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: RIFTS_PROGRAM_ID,
      data: instructionData,
    });
  } catch (error) {
    console.error('[ERROR] Failed to create rebalance instruction:', error);
    return null;
  }
}

export async function triggerRebalance(
  ctx: ServiceContext,
  riftPubkey: PublicKey,
  confirmTransactionSafely: (sig: string) => Promise<boolean>
): Promise<RebalanceResult> {
  try {
    if (!ctx.wallet) {
      throw new Error('Wallet not connected');
    }

    const transaction = new Transaction();

    // Add compute budget
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
    );

    const rebalanceInstruction = await createRebalanceInstruction(ctx, riftPubkey);

    if (rebalanceInstruction) {
      transaction.add(rebalanceInstruction);
    } else {
      throw new Error('Failed to create rebalance instruction');
    }

    const { blockhash } = await ctx.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = ctx.wallet.publicKey!;

    const signature = await ctx.wallet.sendTransaction(transaction, ctx.connection);
    await confirmTransactionSafely(signature);

    return { success: true, signature };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Rebalance failed'
    };
  }
}
