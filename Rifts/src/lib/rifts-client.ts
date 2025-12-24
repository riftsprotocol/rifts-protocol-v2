// Rifts Protocol Client - TypeScript interface to smart contract
import { 
  Connection, 
  PublicKey, 
  Transaction, 
  SystemProgram,
  SYSVAR_RENT_PUBKEY 
} from '@solana/web3.js';
import { 
  TOKEN_PROGRAM_ID, 
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  MINT_SIZE
} from '@solana/spl-token';
import { Program, AnchorProvider, Idl, BN } from '@coral-xyz/anchor';

// Program ID - Real deployed program on devnet
export const RIFTS_PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_LP_STAKING_PROGRAM_ID || process.env.NEXT_PUBLIC_RIFTS_PROGRAM_ID || '6FEZJKsxbDm5W4Ad4eogNehivRKKGCHJHRnKUSFbLpKt'); // ✅ FIXED DEPLOYMENT

// IDL types (simplified - in production, generate from anchor build)
export interface RiftsProtocolIDL extends Idl {
  name: "rifts_protocol";
  instructions: any[];
  accounts: any[];
  events: any[];
  errors: any[];
}

export class RiftsProtocolClient {
  private connection: Connection;
  private program: Program<RiftsProtocolIDL>;
  
  constructor(connection: Connection, provider: AnchorProvider) {
    this.connection = connection;
    // In production, load the actual IDL
    // @ts-ignore - IDL type will be properly loaded in production
    this.program = new Program({} as any, RIFTS_PROGRAM_ID, provider);
  }

  // ==================== UTILITY FUNCTIONS ====================
  
  /**
   * Get the PDA for a rift account
   */
  async getRiftPDA(underlyingMint: PublicKey, creator: PublicKey): Promise<[PublicKey, number]> {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from('rift'),
        underlyingMint.toBuffer(),
        creator.toBuffer()
      ],
      RIFTS_PROGRAM_ID
    );
  }

  /**
   * Get the PDA for a rift mint
   */
  async getRiftMintPDA(rift: PublicKey): Promise<[PublicKey, number]> {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from('rift_mint'),
        rift.toBuffer()
      ],
      RIFTS_PROGRAM_ID
    );
  }

  /**
   * Get the PDA for rift mint authority
   */
  async getRiftMintAuthorityPDA(rift: PublicKey): Promise<[PublicKey, number]> {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from('rift_mint_auth'),
        rift.toBuffer()
      ],
      RIFTS_PROGRAM_ID
    );
  }

  /**
   * Get the PDA for the vault
   */
  async getVaultPDA(rift: PublicKey): Promise<[PublicKey, number]> {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from('vault'),
        rift.toBuffer()
      ],
      RIFTS_PROGRAM_ID
    );
  }

  /**
   * Get the PDA for vault authority
   */
  async getVaultAuthorityPDA(rift: PublicKey): Promise<[PublicKey, number]> {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from('vault_auth'),
        rift.toBuffer()
      ],
      RIFTS_PROGRAM_ID
    );
  }

  // ==================== MAIN FUNCTIONS ====================

  /**
   * Create a new rift (wrapped token vault)
   */
  async createRift(params: {
    creator: PublicKey;
    underlyingMint: PublicKey;
    burnFeeBps: number;  // 0-45 (0-0.45%)
    partnerFeeBps: number; // 0-5 (0-0.05%)
    partnerWallet?: PublicKey;
  }): Promise<{
    transaction: Transaction;
    riftPubkey: PublicKey;
    riftMintPubkey: PublicKey;
    vaultPubkey: PublicKey;
  }> {
    const { creator, underlyingMint, burnFeeBps, partnerFeeBps, partnerWallet } = params;

    // Get PDAs
    const [riftPubkey] = await this.getRiftPDA(underlyingMint, creator);
    const [riftMintPubkey] = await this.getRiftMintPDA(riftPubkey);
    const [riftMintAuthorityPubkey] = await this.getRiftMintAuthorityPDA(riftPubkey);
    const [vaultPubkey] = await this.getVaultPDA(riftPubkey);
    const [vaultAuthorityPubkey] = await this.getVaultAuthorityPDA(riftPubkey);

    // Create transaction
    const transaction = new Transaction();

    // Add create rift instruction (simplified - would use actual program instruction)
    const createRiftIx = SystemProgram.createAccount({
      fromPubkey: creator,
      newAccountPubkey: riftPubkey,
      space: 8 + 32 + 32 + 32 + 32 + 2 + 2 + 33 + 8 + 8 + 8 + 8 + 8, // Approximate space
      lamports: await this.connection.getMinimumBalanceForRentExemption(200),
      programId: RIFTS_PROGRAM_ID,
    });

    transaction.add(createRiftIx);

    return {
      transaction,
      riftPubkey,
      riftMintPubkey,
      vaultPubkey,
    };
  }

  /**
   * Wrap tokens into rift tokens
   */
  async wrapTokens(params: {
    user: PublicKey;
    riftPubkey: PublicKey;
    amount: number; // Amount in token units (not lamports)
  }): Promise<Transaction> {
    const { user, riftPubkey, amount } = params;

    // Get rift account to find mints
    const riftAccount = await this.getRiftAccount(riftPubkey);
    if (!riftAccount) {
      throw new Error('Rift account not found');
    }

    // Get associated token accounts
    const userUnderlyingATA = await getAssociatedTokenAddress(
      riftAccount.underlyingMint,
      user
    );
    
    const userRiftTokensATA = await getAssociatedTokenAddress(
      riftAccount.riftMint,
      user
    );

    // Get PDAs
    const [riftMintAuthorityPubkey] = await this.getRiftMintAuthorityPDA(riftPubkey);
    const [vaultPubkey] = await this.getVaultPDA(riftPubkey);

    const transaction = new Transaction();

    // Create user's rift token account if it doesn't exist
    const userRiftTokensInfo = await this.connection.getAccountInfo(userRiftTokensATA);
    if (!userRiftTokensInfo) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          user,
          userRiftTokensATA,
          user,
          riftAccount.riftMint
        )
      );
    }

    // Add wrap instruction (simplified - would use actual program instruction)
    // In production, this would be: this.program.methods.wrapTokens(new BN(amount))...

    return transaction;
  }

  /**
   * Unwrap rift tokens back to underlying tokens
   */
  async unwrapTokens(params: {
    user: PublicKey;
    riftPubkey: PublicKey;
    riftTokenAmount: number;
  }): Promise<Transaction> {
    const { user, riftPubkey, riftTokenAmount } = params;

    // Similar structure to wrapTokens but in reverse
    const transaction = new Transaction();

    // Add unwrap instruction (simplified)
    // In production: this.program.methods.unwrapTokens(new BN(riftTokenAmount))...

    return transaction;
  }

  /**
   * Trigger rebalance (hybrid oracle)
   */
  async triggerRebalance(params: {
    oracle: PublicKey;
    riftPubkey: PublicKey;
    newPrice: number;
  }): Promise<Transaction> {
    const { oracle, riftPubkey, newPrice } = params;

    const transaction = new Transaction();

    // Add rebalance instruction (simplified)
    // In production: this.program.methods.triggerRebalance(new BN(newPrice))...

    return transaction;
  }

  // ==================== QUERY FUNCTIONS ====================

  /**
   * Get rift account data
   */
  async getRiftAccount(riftPubkey: PublicKey): Promise<any | null> {
    try {
      // In production, use: this.program.account.rift.fetch(riftPubkey)
      const accountInfo = await this.connection.getAccountInfo(riftPubkey);
      if (!accountInfo) return null;

      // Parse account data (simplified)
      return {
        creator: new PublicKey(accountInfo.data.slice(8, 40)),
        underlyingMint: new PublicKey(accountInfo.data.slice(40, 72)),
        riftMint: new PublicKey(accountInfo.data.slice(72, 104)),
        vault: new PublicKey(accountInfo.data.slice(104, 136)),
        burnFeeBps: accountInfo.data.readUInt16LE(136),
        partnerFeeBps: accountInfo.data.readUInt16LE(138),
        // ... other fields
      };
    } catch (error) {
      console.error('Error fetching rift account:', error);
      return null;
    }
  }

  /**
   * Get all rifts created by a user
   */
  async getRiftsByCreator(creator: PublicKey): Promise<any[]> {
    try {
      // In production, use program account filters
      // this.program.account.rift.all([
      //   {
      //     memcmp: {
      //       offset: 8, // After discriminator
      //       bytes: creator.toBase58(),
      //     }
      //   }
      // ])
      
      // No rifts found for this creator
      return [];
    } catch (error) {
      console.error('Error fetching rifts by creator:', error);
      throw new Error(`Failed to fetch rifts for creator: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get user's positions across all rifts
   */
  async getUserPositions(user: PublicKey): Promise<any[]> {
    try {
      // Get all token accounts owned by user
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        user,
        { programId: TOKEN_PROGRAM_ID }
      );

      const positions = [];

      for (const account of tokenAccounts.value) {
        const tokenData = account.account.data.parsed;
        if (tokenData.info.tokenAmount.uiAmount > 0) {
          // Check if this is a rift token by querying rift accounts
          // In production, would have better indexing
          positions.push({
            mint: tokenData.info.mint,
            amount: tokenData.info.tokenAmount.uiAmount,
            // ... additional position data
          });
        }
      }

      return positions;
    } catch (error) {
      console.error('Error fetching user positions:', error);
      return [];
    }
  }

  /**
   * Calculate current backing ratio for a rift
   */
  async getBackingRatio(riftPubkey: PublicKey): Promise<number> {
    try {
      const riftAccount = await this.getRiftAccount(riftPubkey);
      if (!riftAccount) return 1.0;

      // backing_ratio is stored in basis points (10000 = 1.0x)
      return riftAccount.backingRatio / 10000;
    } catch (error) {
      console.error('Error calculating backing ratio:', error);
      return 1.0;
    }
  }

  /**
   * Check if a rift needs rebalancing
   */
  async needsRebalancing(riftPubkey: PublicKey): Promise<{
    needsRebalance: boolean;
    timeRemaining: number;
    volumeTrigger: boolean;
  }> {
    try {
      const riftAccount = await this.getRiftAccount(riftPubkey);
      if (!riftAccount) {
        return { needsRebalance: false, timeRemaining: 0, volumeTrigger: false };
      }

      const now = Math.floor(Date.now() / 1000);
      const timeSinceLastRebalance = now - riftAccount.lastRebalance;
      const twentyFourHours = 24 * 60 * 60;
      
      const timeRemaining = Math.max(0, twentyFourHours - timeSinceLastRebalance);
      const timeTrigger = timeSinceLastRebalance >= twentyFourHours;
      
      // Check if volume exceeds rebalance threshold (e.g., >$100k in 24h)
      const volumeThreshold = 100000; // $100k
      const volumeTrigger = riftAccount.totalVolume24h > volumeThreshold;

      return {
        needsRebalance: timeTrigger || volumeTrigger,
        timeRemaining,
        volumeTrigger,
      };
    } catch (error) {
      console.error('Error checking rebalance status:', error);
      return { needsRebalance: false, timeRemaining: 0, volumeTrigger: false };
    }
  }
}

// Export types
export interface RiftData {
  creator: PublicKey;
  underlyingMint: PublicKey;
  riftMint: PublicKey;
  vault: PublicKey;
  burnFeeBps: number;
  partnerFeeBps: number;
  partnerWallet?: PublicKey;
  totalWrapped: number;
  totalBurned: number;
  backingRatio: number;
  lastRebalance: number;
  createdAt: number;
}

export interface UserPosition {
  riftPubkey: PublicKey;
  riftTokenAmount: number;
  underlyingValue: number;
  unrealizedGains: number;
}

// Export client factory
export function createRiftsClient(connection: Connection, provider: AnchorProvider): RiftsProtocolClient {
  return new RiftsProtocolClient(connection, provider);
}