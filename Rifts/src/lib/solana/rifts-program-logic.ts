// Rifts Protocol Program Logic (TypeScript Implementation)
// This implements the core logic that would be in the Rust smart contract

import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeAccountInstruction,
  createMintToInstruction,
  createBurnInstruction,
  createTransferInstruction,
  getMint,
  getAccount,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  MINT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';

// Program constants (matches Rust implementation) - REAL DEPLOYED PROGRAM
export const RIFTS_PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_LP_STAKING_PROGRAM_ID || process.env.NEXT_PUBLIC_RIFTS_PROGRAM_ID || '6FEZJKsxbDm5W4Ad4eogNehivRKKGCHJHRnKUSFbLpKt'); // ✅ FIXED DEPLOYMENT
export const RIFTS_TOKEN_MINT = new PublicKey(process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump');

// Fee constants (in basis points)
export const WRAP_FEE_BPS = 70; // 0.7%
export const UNWRAP_FEE_BPS = 70; // 0.7%
export const MAX_BURN_FEE_BPS = 45; // 0.45%
export const MAX_PARTNER_FEE_BPS = 5; // 0.05%

// PDA seeds (matches Rust)
export const RIFT_SEED = Buffer.from('rift');
export const RIFT_MINT_SEED = Buffer.from('rift_mint');
export const VAULT_SEED = Buffer.from('vault');
export const MINT_AUTH_SEED = Buffer.from('rift_mint_auth');
export const VAULT_AUTH_SEED = Buffer.from('vault_auth');

// Data structures
export interface RiftAccount {
  creator: PublicKey;
  underlyingMint: PublicKey;
  riftMint: PublicKey;
  vault: PublicKey;
  burnFeeBps: number;
  partnerFeeBps: number;
  partnerWallet?: PublicKey;
  totalWrapped: bigint;
  totalBurned: bigint;
  backingRatio: number; // In basis points (10000 = 1.0x)
  lastRebalance: number;
  createdAt: number;
}

export interface CreateRiftParams {
  creator: PublicKey;
  underlyingMint: PublicKey;
  burnFeeBps: number;
  partnerFeeBps: number;
  partnerWallet?: PublicKey;
}

export interface WrapTokensParams {
  user: PublicKey;
  rift: PublicKey;
  amount: bigint;
}

export interface UnwrapTokensParams {
  user: PublicKey;
  rift: PublicKey;
  riftTokenAmount: bigint;
}

// Helper functions to derive PDAs
export async function deriveRiftAddress(
  underlyingMint: PublicKey,
  creator: PublicKey
): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddress(
    [RIFT_SEED, underlyingMint.toBuffer(), creator.toBuffer()],
    RIFTS_PROGRAM_ID
  );
}

export async function deriveRiftMintAddress(
  rift: PublicKey
): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddress(
    [RIFT_MINT_SEED, rift.toBuffer()],
    RIFTS_PROGRAM_ID
  );
}

export async function deriveVaultAddress(
  rift: PublicKey
): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddress(
    [VAULT_SEED, rift.toBuffer()],
    RIFTS_PROGRAM_ID
  );
}

export async function deriveMintAuthorityAddress(
  rift: PublicKey
): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddress(
    [MINT_AUTH_SEED, rift.toBuffer()],
    RIFTS_PROGRAM_ID
  );
}

export async function deriveVaultAuthorityAddress(
  rift: PublicKey
): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddress(
    [VAULT_AUTH_SEED, rift.toBuffer()],
    RIFTS_PROGRAM_ID
  );
}

// Create instruction builders
export function createRiftInstruction(
  params: CreateRiftParams
): TransactionInstruction {
  // In the actual implementation, this would create the proper instruction
  // For now, we'll create a minimal instruction
  const keys = [
    { pubkey: params.creator, isSigner: true, isWritable: true },
    { pubkey: params.underlyingMint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  // Instruction data would be properly serialized in Rust
  const data = Buffer.from([
    0, // Instruction index for create_rift
    ...Buffer.from(new Uint16Array([params.burnFeeBps]).buffer),
    ...Buffer.from(new Uint16Array([params.partnerFeeBps]).buffer),
  ]);

  return new TransactionInstruction({
    keys,
    programId: RIFTS_PROGRAM_ID,
    data,
  });
}

export function wrapTokensInstruction(
  params: WrapTokensParams,
  accounts: {
    rift: PublicKey;
    riftMint: PublicKey;
    vault: PublicKey;
    userUnderlying: PublicKey;
    userRiftTokens: PublicKey;
    mintAuthority: PublicKey;
  }
): TransactionInstruction {
  const keys = [
    { pubkey: params.user, isSigner: true, isWritable: true },
    { pubkey: params.rift, isSigner: false, isWritable: true },
    { pubkey: accounts.riftMint, isSigner: false, isWritable: true },
    { pubkey: accounts.vault, isSigner: false, isWritable: true },
    { pubkey: accounts.userUnderlying, isSigner: false, isWritable: true },
    { pubkey: accounts.userRiftTokens, isSigner: false, isWritable: true },
    { pubkey: accounts.mintAuthority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  // Serialize amount as u64 (8 bytes, little-endian)
  const data = Buffer.concat([
    Buffer.from([1]), // Instruction index for wrap_tokens
    Buffer.from(params.amount.toString(16).padStart(16, '0'), 'hex').reverse(),
  ]);

  return new TransactionInstruction({
    keys,
    programId: RIFTS_PROGRAM_ID,
    data,
  });
}

export function unwrapTokensInstruction(
  params: UnwrapTokensParams,
  accounts: {
    rift: PublicKey;
    riftMint: PublicKey;
    vault: PublicKey;
    userUnderlying: PublicKey;
    userRiftTokens: PublicKey;
    vaultAuthority: PublicKey;
  }
): TransactionInstruction {
  const keys = [
    { pubkey: params.user, isSigner: true, isWritable: true },
    { pubkey: params.rift, isSigner: false, isWritable: true },
    { pubkey: accounts.riftMint, isSigner: false, isWritable: true },
    { pubkey: accounts.vault, isSigner: false, isWritable: true },
    { pubkey: accounts.userUnderlying, isSigner: false, isWritable: true },
    { pubkey: accounts.userRiftTokens, isSigner: false, isWritable: true },
    { pubkey: accounts.vaultAuthority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  const data = Buffer.concat([
    Buffer.from([2]), // Instruction index for unwrap_tokens
    Buffer.from(params.riftTokenAmount.toString(16).padStart(16, '0'), 'hex').reverse(),
  ]);

  return new TransactionInstruction({
    keys,
    programId: RIFTS_PROGRAM_ID,
    data,
  });
}

// Fee calculation functions
export function calculateWrapFees(amount: bigint): {
  totalFee: bigint;
  amountAfterFee: bigint;
} {
  const totalFee = (amount * BigInt(WRAP_FEE_BPS)) / BigInt(10000);
  const amountAfterFee = amount - totalFee;
  return { totalFee, amountAfterFee };
}

export function calculateUnwrapFees(riftTokenAmount: bigint, backingRatio: number): {
  underlyingAmount: bigint;
  totalFee: bigint;
  amountAfterFee: bigint;
} {
  const underlyingAmount = (riftTokenAmount * BigInt(backingRatio)) / BigInt(10000);
  const totalFee = (underlyingAmount * BigInt(UNWRAP_FEE_BPS)) / BigInt(10000);
  const amountAfterFee = underlyingAmount - totalFee;
  return { underlyingAmount, totalFee, amountAfterFee };
}

export function calculateFeeDistribution(
  totalFee: bigint,
  burnFeeBps: number,
  partnerFeeBps: number
): {
  burnAmount: bigint;
  partnerAmount: bigint;
  treasuryAmount: bigint;
  riftsBuyAmount: bigint;
} {
  const burnAmount = (totalFee * BigInt(burnFeeBps)) / BigInt(10000);
  const partnerAmount = (totalFee * BigInt(partnerFeeBps)) / BigInt(10000);
  const remaining = totalFee - burnAmount - partnerAmount;
  
  // 5% to treasury
  const treasuryAmount = (remaining * BigInt(5)) / BigInt(100);
  
  // 95% to buy RIFTS tokens
  const riftsBuyAmount = remaining - treasuryAmount;
  
  return {
    burnAmount,
    partnerAmount,
    treasuryAmount,
    riftsBuyAmount
  };
}

// Backing ratio calculation
export function updateBackingRatio(
  totalWrapped: bigint,
  totalBurned: bigint
): number {
  const totalSupply = totalWrapped - totalBurned;
  if (totalSupply > BigInt(0)) {
    return Number((totalWrapped * BigInt(10000)) / totalSupply);
  }
  return 10000; // 1.0x default
}