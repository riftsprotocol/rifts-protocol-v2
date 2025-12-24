// LP Staking Client - Real integration with deployed LP Staking program
import { Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@project-serum/anchor';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import crypto from 'crypto';

// Deployed program ID
const LP_STAKING_PROGRAM_ID = new PublicKey('Dz1b2WXm2W7PYAp7CvN4qiGdZ7ULRtaAxBWb7Ju8PwNy'); // ✅ DEPLOYED
const RIFTS_MINT = new PublicKey(process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump');

/**
 * Generate Anchor instruction discriminator
 * Anchor uses SHA256 hash of "global:function_name" and takes first 8 bytes
 */
function getDiscriminator(name: string): Buffer {
  const preimage = `global:${name}`;
  const hash = crypto.createHash('sha256').update(preimage).digest();
  return hash.slice(0, 8);
}

export interface StakingResult {
  success: boolean;
  signature?: string;
  amount?: number;
  error?: string;
}

export interface UserStakingInfo {
  stakedAmount: number;
  pendingRewards: number;
  stakeTime: number;
}

export class LPStakingClient {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Derive the staking pool PDA
   */
  async getStakingPoolAddress(lpTokenMint: PublicKey): Promise<[PublicKey, number]> {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('staking_pool'), lpTokenMint.toBuffer()],
      LP_STAKING_PROGRAM_ID
    );
  }

  /**
   * Derive the user stake account PDA
   */
  async getUserStakeAddress(
    stakingPool: PublicKey,
    user: PublicKey
  ): Promise<[PublicKey, number]> {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('user_stake'), stakingPool.toBuffer(), user.toBuffer()],
      LP_STAKING_PROGRAM_ID
    );
  }

  /**
   * Get user's staking information
   */
  async getUserStakingInfo(
    lpTokenMint: PublicKey,
    userPubkey: PublicKey
  ): Promise<UserStakingInfo> {
    try {
      const [stakingPool] = await this.getStakingPoolAddress(lpTokenMint);
      const [userStake] = await this.getUserStakeAddress(stakingPool, userPubkey);

      const accountInfo = await this.connection.getAccountInfo(userStake);

      if (!accountInfo) {
        return { stakedAmount: 0, pendingRewards: 0, stakeTime: 0 };
      }

      // Deserialize account data
      const data = accountInfo.data;

      // Skip discriminator (8 bytes)
      // Skip user pubkey (32 bytes)
      // Skip pool pubkey (32 bytes)
      // Read amount at offset 72 (8 bytes u64)
      const amount = data.readBigUInt64LE(72);

      // Read stake_time at offset 80 (8 bytes i64)
      const stakeTime = Number(data.readBigInt64LE(80));

      // Read reward_debt at offset 88 (8 bytes u64)
      // const rewardDebt = data.readBigUInt64LE(88);

      // Read pending_rewards at offset 96 (8 bytes u64)
      const pendingRewards = data.readBigUInt64LE(96);

      return {
        stakedAmount: Number(amount) / 1e9, // Convert from lamports
        pendingRewards: Number(pendingRewards) / 1e9,
        stakeTime
      };
    } catch (error) {
      console.error('Error fetching user staking info:', error);
      return { stakedAmount: 0, pendingRewards: 0, stakeTime: 0 };
    }
  }

  /**
   * Stake LP tokens
   */
  async stakeLPTokens(
    lpTokenMint: PublicKey,
    amount: number,
    userPubkey: PublicKey,
    sendTransaction: (transaction: Transaction) => Promise<string>
  ): Promise<StakingResult> {
    try {
      console.log('🥩 Staking LP tokens:', {
        lpTokenMint: lpTokenMint.toString(),
        amount,
        user: userPubkey.toString()
      });

      // Derive PDAs
      const [stakingPool] = await this.getStakingPoolAddress(lpTokenMint);
      const [userStake] = await this.getUserStakeAddress(stakingPool, userPubkey);
      const [poolLpVault] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool_lp_vault'), stakingPool.toBuffer()],
        LP_STAKING_PROGRAM_ID
      );

      // Get user's LP token account
      const userLpTokenAccount = await getAssociatedTokenAddress(
        lpTokenMint,
        userPubkey
      );

      // Build transaction
      const transaction = new Transaction();

      // Check if user's LP token account exists
      const userLpAccountInfo = await this.connection.getAccountInfo(userLpTokenAccount);
      if (!userLpAccountInfo) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            userPubkey,
            userLpTokenAccount,
            userPubkey,
            lpTokenMint
          )
        );
      }

      // Create stake instruction
      const stakeInstruction = await this.createStakeInstruction(
        stakingPool,
        userStake,
        userLpTokenAccount,
        poolLpVault,
        userPubkey,
        amount
      );

      transaction.add(stakeInstruction);

      // Get recent blockhash
      const { blockhash } = await this.connection.getLatestBlockhash('processed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = userPubkey;

      // Send transaction (wallet adapter will use its own connection)
      const signature = await sendTransaction(transaction);
      console.log('✅ LP tokens staked successfully:', signature);

      return {
        success: true,
        signature,
        amount
      };
    } catch (error) {
      console.error('❌ LP staking failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'LP staking failed'
      };
    }
  }

  /**
   * Claim RIFTS rewards
   */
  async claimRewards(
    lpTokenMint: PublicKey,
    userPubkey: PublicKey,
    sendTransaction: (transaction: Transaction) => Promise<string>
  ): Promise<StakingResult> {
    try {
      console.log('🎁 Claiming RIFTS rewards for user:', userPubkey.toString());

      // Derive PDAs
      const [stakingPool] = await this.getStakingPoolAddress(lpTokenMint);
      const [userStake] = await this.getUserStakeAddress(stakingPool, userPubkey);
      const [rewardAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from('reward_authority'), stakingPool.toBuffer()],
        LP_STAKING_PROGRAM_ID
      );

      // Get staking pool data to find reward vault
      const poolAccountInfo = await this.connection.getAccountInfo(stakingPool);
      if (!poolAccountInfo) {
        throw new Error('Staking pool not found');
      }

      // Read reward_token_vault from pool account (offset 104)
      const poolRewardVault = new PublicKey(poolAccountInfo.data.slice(104, 136));

      // Get user's RIFTS token account
      const userRiftsAccount = await getAssociatedTokenAddress(
        RIFTS_MINT,
        userPubkey
      );

      // Build transaction
      const transaction = new Transaction();

      // Check if user's RIFTS account exists
      const userRiftsAccountInfo = await this.connection.getAccountInfo(userRiftsAccount);
      if (!userRiftsAccountInfo) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            userPubkey,
            userRiftsAccount,
            userPubkey,
            RIFTS_MINT
          )
        );
      }

      // Create claim instruction
      const claimInstruction = await this.createClaimInstruction(
        stakingPool,
        userStake,
        userRiftsAccount,
        poolRewardVault,
        rewardAuthority,
        userPubkey
      );

      transaction.add(claimInstruction);

      // Get recent blockhash
      const { blockhash } = await this.connection.getLatestBlockhash('processed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = userPubkey;

      // Send transaction
      const signature = await sendTransaction(transaction);
      console.log('✅ RIFTS rewards claimed successfully:', signature);

      return {
        success: true,
        signature
      };
    } catch (error) {
      console.error('❌ Claim rewards failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Claim rewards failed'
      };
    }
  }

  /**
   * Create stake instruction
   */
  private async createStakeInstruction(
    stakingPool: PublicKey,
    userStake: PublicKey,
    userLpTokens: PublicKey,
    poolLpTokens: PublicKey,
    user: PublicKey,
    amount: number
  ) {
    // Convert amount to lamports
    const amountLamports = new BN(amount * 1e9);

    // Generate proper Anchor discriminator for "stake"
    const discriminator = getDiscriminator('stake');

    // Instruction data: discriminator + amount (u64)
    const data = Buffer.alloc(16);
    discriminator.copy(data, 0);
    // Browser-compatible BigInt writing using DataView
    const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
    dataView.setBigUint64(8, BigInt(amountLamports.toString()), true); // true = little-endian

    return {
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: stakingPool, isSigner: false, isWritable: true },
        { pubkey: userStake, isSigner: false, isWritable: true },
        { pubkey: userLpTokens, isSigner: false, isWritable: true },
        { pubkey: poolLpTokens, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      programId: LP_STAKING_PROGRAM_ID,
      data
    };
  }

  /**
   * Unstake LP tokens
   */
  async unstakeLPTokens(
    lpTokenMint: PublicKey,
    amount: number,
    userPubkey: PublicKey,
    sendTransaction: (transaction: Transaction) => Promise<string>
  ): Promise<StakingResult> {
    try {
      console.log('🔓 Unstaking LP tokens:', {
        lpTokenMint: lpTokenMint.toString(),
        amount,
        user: userPubkey.toString()
      });

      // Derive PDAs
      const [stakingPool] = await this.getStakingPoolAddress(lpTokenMint);
      const [userStake] = await this.getUserStakeAddress(stakingPool, userPubkey);
      const [poolLpVault] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool_lp_vault'), stakingPool.toBuffer()],
        LP_STAKING_PROGRAM_ID
      );
      const [vaultAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from('vault_authority'), stakingPool.toBuffer()],
        LP_STAKING_PROGRAM_ID
      );

      // Get user's LP token account
      const userLpTokenAccount = await getAssociatedTokenAddress(
        lpTokenMint,
        userPubkey
      );

      // Build transaction
      const transaction = new Transaction();

      // Create unstake instruction
      const unstakeInstruction = await this.createUnstakeInstruction(
        stakingPool,
        userStake,
        userLpTokenAccount,
        poolLpVault,
        vaultAuthority,
        userPubkey,
        amount
      );

      transaction.add(unstakeInstruction);

      // Get recent blockhash
      const { blockhash } = await this.connection.getLatestBlockhash('processed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = userPubkey;

      // Send transaction
      const signature = await sendTransaction(transaction);
      console.log('✅ LP tokens unstaked successfully:', signature);

      return {
        success: true,
        signature,
        amount
      };
    } catch (error) {
      console.error('❌ LP unstaking failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'LP unstaking failed'
      };
    }
  }

  /**
   * Create unstake instruction
   */
  private async createUnstakeInstruction(
    stakingPool: PublicKey,
    userStake: PublicKey,
    userLpTokens: PublicKey,
    poolLpTokens: PublicKey,
    vaultAuthority: PublicKey,
    user: PublicKey,
    amount: number
  ) {
    // Convert amount to lamports
    const amountLamports = new BN(amount * 1e9);

    // Generate proper Anchor discriminator for "unstake"
    const discriminator = getDiscriminator('unstake');

    // Instruction data: discriminator + amount (u64)
    const data = Buffer.alloc(16);
    discriminator.copy(data, 0);
    // Browser-compatible BigInt writing using DataView
    const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
    dataView.setBigUint64(8, BigInt(amountLamports.toString()), true); // true = little-endian

    return {
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: stakingPool, isSigner: false, isWritable: true },
        { pubkey: userStake, isSigner: false, isWritable: true },
        { pubkey: userLpTokens, isSigner: false, isWritable: true },
        { pubkey: poolLpTokens, isSigner: false, isWritable: true },
        { pubkey: vaultAuthority, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      programId: LP_STAKING_PROGRAM_ID,
      data
    };
  }

  /**
   * Create claim rewards instruction
   */
  private async createClaimInstruction(
    stakingPool: PublicKey,
    userStake: PublicKey,
    userRewardTokens: PublicKey,
    poolRewardVault: PublicKey,
    rewardAuthority: PublicKey,
    user: PublicKey
  ) {
    // Generate proper Anchor discriminator for "claim_rewards"
    const discriminator = getDiscriminator('claim_rewards');

    return {
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: stakingPool, isSigner: false, isWritable: true },
        { pubkey: userStake, isSigner: false, isWritable: true },
        { pubkey: RIFTS_MINT, isSigner: false, isWritable: true }, // reward_token_mint
        { pubkey: userRewardTokens, isSigner: false, isWritable: true },
        { pubkey: rewardAuthority, isSigner: false, isWritable: false },
        { pubkey: poolRewardVault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      programId: LP_STAKING_PROGRAM_ID,
      data: discriminator
    };
  }
}

// Export singleton instance
const lpStakingConnection =
  typeof window !== 'undefined'
    ? require('@/lib/solana/rpc-client').createProxiedConnection()
    : new Connection(require('./rpc-endpoints').getHeliusHttpRpcUrl(), {
        commitment: 'confirmed',
        wsEndpoint:
          (process.env.LASERSTREAM_API_KEY && `wss://mainnet.helius-rpc.com/?api-key=${process.env.LASERSTREAM_API_KEY}`) ||
          undefined,
        disableRetryOnRateLimit: true,
      });

export const lpStakingClient = new LPStakingClient(lpStakingConnection);
