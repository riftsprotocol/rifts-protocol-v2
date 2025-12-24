/**
 * PumpFun Launcher Client
 *
 * Client-side integration for the fee-splitting pump.fun launcher program.
 * This program creates tokens on pump.fun with a PDA as the creator,
 * allowing fees to be split between the dev and platform.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import bs58 from 'bs58';

// ============ CONSTANTS ============

// Program IDs
export const PUMPFUN_LAUNCHER_PROGRAM_ID = new PublicKey('5ZDwhJd4vk38YM2mFk3gq2b6H4w4vLRLdeKVGctrK6Ts');
export const PUMPFUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// Seeds
const GLOBAL_CONFIG_SEED = Buffer.from('global_config');
const TOKEN_LAUNCH_SEED = Buffer.from('token_launch');
const FEE_VAULT_SEED = Buffer.from('fee_vault');

// Pump.fun specific
const PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const PUMP_FEE = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCvbRstBBMp7');
const PUMP_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

// ============ TYPES ============

export interface LauncherConfig {
  authority: PublicKey;
  platformWallet: PublicKey;
  emergencyAuthority: PublicKey;
  totalLaunches: number;
  totalFeesCollected: number;
}

export interface TokenLaunchInfo {
  mint: PublicKey;
  creator: PublicKey;
  feeVault: PublicKey;
  platformFeeBps: number;
  creatorFeeBps: number;
  totalFeesReceived: number;
  creatorClaimed: number;
  platformClaimed: number;
  createdAt: number;
}

export interface CreateTokenParams {
  name: string;
  symbol: string;
  uri: string;
  creatorFeeBps: number; // Dev's cut: 0-10000 (0-100%). Platform gets the rest.
}

// ============ PDA DERIVATION ============

export function deriveGlobalConfig(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [GLOBAL_CONFIG_SEED],
    PUMPFUN_LAUNCHER_PROGRAM_ID
  );
}

export function deriveTokenLaunch(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TOKEN_LAUNCH_SEED, mint.toBuffer()],
    PUMPFUN_LAUNCHER_PROGRAM_ID
  );
}

export function deriveFeeVault(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [FEE_VAULT_SEED, mint.toBuffer()],
    PUMPFUN_LAUNCHER_PROGRAM_ID
  );
}

// Pump.fun specific derivations
export function derivePumpMintAuthority(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('mint-authority')],
    PUMPFUN_PROGRAM_ID
  );
}

export function derivePumpBondingCurve(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMPFUN_PROGRAM_ID
  );
}

export function deriveMetadata(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    MPL_TOKEN_METADATA_PROGRAM_ID
  );
}

// ============ INSTRUCTION BUILDERS ============

/**
 * Build initialize instruction
 */
export function buildInitializeInstruction(
  authority: PublicKey,
  platformWallet: PublicKey
): TransactionInstruction {
  const [globalConfig] = deriveGlobalConfig();

  // Discriminator for "initialize"
  const discriminator = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);

  const data = Buffer.alloc(8 + 32);
  discriminator.copy(data, 0);
  platformWallet.toBuffer().copy(data, 8);

  return new TransactionInstruction({
    programId: PUMPFUN_LAUNCHER_PROGRAM_ID,
    keys: [
      { pubkey: globalConfig, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build create token instruction
 */
export function buildCreateTokenInstruction(
  payer: PublicKey,
  mint: PublicKey,
  params: CreateTokenParams
): TransactionInstruction {
  const [globalConfig] = deriveGlobalConfig();
  const [tokenLaunch] = deriveTokenLaunch(mint);
  const [feeVault] = deriveFeeVault(mint);
  const [mintAuthority] = derivePumpMintAuthority();
  const [bondingCurve] = derivePumpBondingCurve(mint);
  const [metadata] = deriveMetadata(mint);

  // Associated bonding curve (ATA for bonding curve)
  const associatedBondingCurve = PublicKey.findProgramAddressSync(
    [bondingCurve.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];

  // Discriminator for "create_token"
  const discriminator = Buffer.from([84, 52, 204, 228, 24, 140, 234, 75]);

  // Serialize instruction data
  const nameBytes = Buffer.from(params.name);
  const symbolBytes = Buffer.from(params.symbol);
  const uriBytes = Buffer.from(params.uri);

  const dataSize = 8 + 4 + nameBytes.length + 4 + symbolBytes.length + 4 + uriBytes.length + 2;
  const data = Buffer.alloc(dataSize);

  let offset = 0;
  discriminator.copy(data, offset);
  offset += 8;

  // Name
  data.writeUInt32LE(nameBytes.length, offset);
  offset += 4;
  nameBytes.copy(data, offset);
  offset += nameBytes.length;

  // Symbol
  data.writeUInt32LE(symbolBytes.length, offset);
  offset += 4;
  symbolBytes.copy(data, offset);
  offset += symbolBytes.length;

  // URI
  data.writeUInt32LE(uriBytes.length, offset);
  offset += 4;
  uriBytes.copy(data, offset);
  offset += uriBytes.length;

  // Creator fee (u16) - dev's cut, platform gets the rest
  data.writeUInt16LE(params.creatorFeeBps, offset);

  return new TransactionInstruction({
    programId: PUMPFUN_LAUNCHER_PROGRAM_ID,
    keys: [
      { pubkey: globalConfig, isSigner: false, isWritable: true },
      { pubkey: tokenLaunch, isSigner: false, isWritable: true },
      { pubkey: feeVault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: true, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      // Pump.fun accounts
      { pubkey: mintAuthority, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: MPL_TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMPFUN_PROGRAM_ID, isSigner: false, isWritable: false },
      // System accounts
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build claim creator instruction
 */
export function buildClaimCreatorInstruction(
  creator: PublicKey,
  mint: PublicKey
): TransactionInstruction {
  const [tokenLaunch] = deriveTokenLaunch(mint);
  const [feeVault] = deriveFeeVault(mint);

  // Discriminator for "claim_creator"
  const discriminator = Buffer.from([150, 178, 35, 71, 213, 192, 242, 196]);

  return new TransactionInstruction({
    programId: PUMPFUN_LAUNCHER_PROGRAM_ID,
    keys: [
      { pubkey: tokenLaunch, isSigner: false, isWritable: true },
      { pubkey: feeVault, isSigner: false, isWritable: true },
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  });
}

/**
 * Build claim platform instruction
 */
export function buildClaimPlatformInstruction(
  caller: PublicKey,
  mint: PublicKey,
  platformWallet: PublicKey
): TransactionInstruction {
  const [globalConfig] = deriveGlobalConfig();
  const [tokenLaunch] = deriveTokenLaunch(mint);
  const [feeVault] = deriveFeeVault(mint);

  // Discriminator for "claim_platform"
  const discriminator = Buffer.from([118, 214, 184, 225, 129, 191, 63, 41]);

  return new TransactionInstruction({
    programId: PUMPFUN_LAUNCHER_PROGRAM_ID,
    keys: [
      { pubkey: globalConfig, isSigner: false, isWritable: true },
      { pubkey: tokenLaunch, isSigner: false, isWritable: true },
      { pubkey: feeVault, isSigner: false, isWritable: true },
      { pubkey: platformWallet, isSigner: false, isWritable: true },
      { pubkey: caller, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  });
}

/**
 * Build sync fees instruction
 */
export function buildSyncFeesInstruction(mint: PublicKey): TransactionInstruction {
  const [tokenLaunch] = deriveTokenLaunch(mint);
  const [feeVault] = deriveFeeVault(mint);

  // Discriminator for "sync_fees"
  const discriminator = Buffer.from([103, 122, 229, 75, 234, 52, 89, 148]);

  return new TransactionInstruction({
    programId: PUMPFUN_LAUNCHER_PROGRAM_ID,
    keys: [
      { pubkey: tokenLaunch, isSigner: false, isWritable: true },
      { pubkey: feeVault, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  });
}

/**
 * Build emergency withdraw instruction
 */
export function buildEmergencyWithdrawInstruction(
  emergencyAuthority: PublicKey,
  mint: PublicKey,
  recipient: PublicKey
): TransactionInstruction {
  const [globalConfig] = deriveGlobalConfig();
  const [tokenLaunch] = deriveTokenLaunch(mint);
  const [feeVault] = deriveFeeVault(mint);

  // Discriminator for "emergency_withdraw"
  const discriminator = Buffer.from([237, 51, 237, 230, 35, 117, 231, 53]);

  return new TransactionInstruction({
    programId: PUMPFUN_LAUNCHER_PROGRAM_ID,
    keys: [
      { pubkey: globalConfig, isSigner: false, isWritable: false },
      { pubkey: tokenLaunch, isSigner: false, isWritable: false },
      { pubkey: feeVault, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: emergencyAuthority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  });
}

// ============ CLIENT CLASS ============

export class PumpFunLauncherClient {
  constructor(
    public connection: Connection,
    public programId: PublicKey = PUMPFUN_LAUNCHER_PROGRAM_ID
  ) {}

  /**
   * Fetch global config
   */
  async getGlobalConfig(): Promise<LauncherConfig | null> {
    const [globalConfigPda] = deriveGlobalConfig();

    try {
      const accountInfo = await this.connection.getAccountInfo(globalConfigPda);
      if (!accountInfo) return null;

      // Deserialize (skip 8-byte discriminator)
      const data = accountInfo.data.slice(8);

      return {
        authority: new PublicKey(data.slice(0, 32)),
        platformWallet: new PublicKey(data.slice(32, 64)),
        emergencyAuthority: new PublicKey(data.slice(64, 96)),
        totalLaunches: new BN(data.slice(96, 104), 'le').toNumber(),
        totalFeesCollected: new BN(data.slice(104, 112), 'le').toNumber(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch token launch info
   */
  async getTokenLaunch(mint: PublicKey): Promise<TokenLaunchInfo | null> {
    const [tokenLaunchPda] = deriveTokenLaunch(mint);

    try {
      const accountInfo = await this.connection.getAccountInfo(tokenLaunchPda);
      if (!accountInfo) return null;

      // Deserialize (skip 8-byte discriminator)
      const data = accountInfo.data.slice(8);

      return {
        mint: new PublicKey(data.slice(0, 32)),
        creator: new PublicKey(data.slice(32, 64)),
        feeVault: new PublicKey(data.slice(64, 96)),
        platformFeeBps: data.readUInt16LE(96),
        creatorFeeBps: data.readUInt16LE(98),
        totalFeesReceived: new BN(data.slice(100, 108), 'le').toNumber(),
        creatorClaimed: new BN(data.slice(108, 116), 'le').toNumber(),
        platformClaimed: new BN(data.slice(116, 124), 'le').toNumber(),
        createdAt: new BN(data.slice(124, 132), 'le').toNumber(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Get fee vault balance
   */
  async getFeeVaultBalance(mint: PublicKey): Promise<number> {
    const [feeVault] = deriveFeeVault(mint);
    const balance = await this.connection.getBalance(feeVault);
    return balance;
  }

  /**
   * Calculate claimable amounts for a token
   */
  async getClaimableAmounts(mint: PublicKey): Promise<{
    creatorClaimable: number;
    platformClaimable: number;
  }> {
    const launch = await this.getTokenLaunch(mint);
    if (!launch) {
      return { creatorClaimable: 0, platformClaimable: 0 };
    }

    const totalCreatorShare = Math.floor(
      (launch.totalFeesReceived * launch.creatorFeeBps) / 10000
    );
    const totalPlatformShare = Math.floor(
      (launch.totalFeesReceived * launch.platformFeeBps) / 10000
    );

    return {
      creatorClaimable: Math.max(0, totalCreatorShare - launch.creatorClaimed),
      platformClaimable: Math.max(0, totalPlatformShare - launch.platformClaimed),
    };
  }

  /**
   * Build a complete create token transaction
   */
  buildCreateTokenTransaction(
    payer: PublicKey,
    mintKeypair: Keypair,
    params: CreateTokenParams
  ): Transaction {
    const tx = new Transaction();
    tx.add(buildCreateTokenInstruction(payer, mintKeypair.publicKey, params));
    return tx;
  }

  /**
   * Get all PDAs for a mint (useful for frontend)
   */
  getMinPdas(mint: PublicKey): {
    tokenLaunch: PublicKey;
    feeVault: PublicKey;
    bondingCurve: PublicKey;
    metadata: PublicKey;
  } {
    const [tokenLaunch] = deriveTokenLaunch(mint);
    const [feeVault] = deriveFeeVault(mint);
    const [bondingCurve] = derivePumpBondingCurve(mint);
    const [metadata] = deriveMetadata(mint);

    return { tokenLaunch, feeVault, bondingCurve, metadata };
  }
}

// ============ HELPER FUNCTIONS ============

/**
 * Generate a vanity mint keypair (optional, for pump-style addresses)
 * Note: This is computationally expensive and optional
 */
export async function generateVanityMint(suffix: string, maxAttempts = 100000): Promise<Keypair | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    if (address.toLowerCase().endsWith(suffix.toLowerCase())) {
      return keypair;
    }
  }
  return null;
}

/**
 * Estimate rent for token launch account
 */
export async function estimateRent(connection: Connection): Promise<number> {
  const tokenLaunchSize = 8 + 32 + 32 + 32 + 2 + 2 + 8 + 8 + 8 + 8 + 1 + 1;
  return await connection.getMinimumBalanceForRentExemption(tokenLaunchSize);
}
