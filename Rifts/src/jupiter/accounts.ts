import { 
  Connection, 
  PublicKey, 
  AccountMeta, 
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_CLOCK_PUBKEY
} from '@solana/web3.js';
import { 
  TOKEN_PROGRAM_ID, 
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction
} from '@solana/spl-token';
import { JupiterQuote } from './client';

export interface ResolvedAccounts {
  programAccounts: AccountMeta[];
  remainingAccounts: AccountMeta[];
  routeAccountsMap: number[];
  setupInstructions: any[];
}

export class JupiterAccountResolver {
  private connection: Connection;
  private readonly JUPITER_V6_PROGRAM = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
  
  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Resolve all accounts needed for Jupiter swap
   */
  async resolveAccounts(
    quote: JupiterQuote,
    userPublicKey: PublicKey,
    feeCollectorProgram: PublicKey,
    feeCollectorState: PublicKey
  ): Promise<ResolvedAccounts> {
    const setupInstructions: any[] = [];
    const accountMap = new Map<string, number>();
    let accountIndex = 0;

    // Standard program accounts for fee collector
    const programAccounts: AccountMeta[] = [
      { pubkey: feeCollectorState, isSigner: false, isWritable: true },
      { pubkey: userPublicKey, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    ];

    // Resolve token accounts
    const inputMint = new PublicKey(quote.inputMint);
    const outputMint = new PublicKey(quote.outputMint);
    
    const userInputAta = getAssociatedTokenAddressSync(inputMint, userPublicKey);
    const userOutputAta = getAssociatedTokenAddressSync(outputMint, userPublicKey);

    // Check if output ATA exists, create if needed
    try {
      await this.connection.getAccountInfo(userOutputAta);
    } catch {
      setupInstructions.push(
        createAssociatedTokenAccountInstruction(
          userPublicKey,
          userOutputAta,
          userPublicKey,
          outputMint
        )
      );
    }

    // Add token accounts to program accounts
    programAccounts.push(
      { pubkey: inputMint, isSigner: false, isWritable: false },
      { pubkey: outputMint, isSigner: false, isWritable: false },
      { pubkey: userInputAta, isSigner: false, isWritable: true },
      { pubkey: userOutputAta, isSigner: false, isWritable: true }
    );

    // Build remaining accounts for Jupiter
    const remainingAccounts: AccountMeta[] = [];
    
    // Jupiter program
    remainingAccounts.push({
      pubkey: this.JUPITER_V6_PROGRAM,
      isSigner: false,
      isWritable: false
    });
    accountMap.set(this.JUPITER_V6_PROGRAM.toBase58(), accountIndex++);

    // Add route-specific accounts
    for (const routeStep of quote.routePlan) {
      // AMM account
      const ammKey = new PublicKey(routeStep.swapInfo.ammKey);
      if (!accountMap.has(ammKey.toBase58())) {
        remainingAccounts.push({
          pubkey: ammKey,
          isSigner: false,
          isWritable: true
        });
        accountMap.set(ammKey.toBase58(), accountIndex++);
      }

      // Route mints
      const routeInputMint = new PublicKey(routeStep.swapInfo.inputMint);
      const routeOutputMint = new PublicKey(routeStep.swapInfo.outputMint);
      
      if (!accountMap.has(routeInputMint.toBase58())) {
        remainingAccounts.push({
          pubkey: routeInputMint,
          isSigner: false,
          isWritable: false
        });
        accountMap.set(routeInputMint.toBase58(), accountIndex++);
      }

      if (!accountMap.has(routeOutputMint.toBase58())) {
        remainingAccounts.push({
          pubkey: routeOutputMint,
          isSigner: false,
          isWritable: false
        });
        accountMap.set(routeOutputMint.toBase58(), accountIndex++);
      }

      // Add AMM-specific accounts based on label
      const ammAccounts = await this.resolveAmmAccounts(routeStep.swapInfo.label, ammKey, routeInputMint, routeOutputMint);
      for (const account of ammAccounts) {
        if (!accountMap.has(account.pubkey.toBase58())) {
          remainingAccounts.push(account);
          accountMap.set(account.pubkey.toBase58(), accountIndex++);
        }
      }
    }

    // Create route accounts map
    const routeAccountsMap = this.createRouteAccountsMap(quote, accountMap);

    return {
      programAccounts,
      remainingAccounts,
      routeAccountsMap,
      setupInstructions
    };
  }

  /**
   * Resolve AMM-specific accounts based on DEX type
   */
  private async resolveAmmAccounts(
    dexLabel: string,
    ammKey: PublicKey,
    inputMint: PublicKey,
    outputMint: PublicKey
  ): Promise<AccountMeta[]> {
    const accounts: AccountMeta[] = [];

    switch (dexLabel.toLowerCase()) {
      case 'raydium':
        accounts.push(...await this.resolveRaydiumAccounts(ammKey, inputMint, outputMint));
        break;
      case 'orca':
        accounts.push(...await this.resolveOrcaAccounts(ammKey, inputMint, outputMint));
        break;
      case 'serum':
        accounts.push(...await this.resolveSerumAccounts(ammKey, inputMint, outputMint));
        break;
      case 'saber':
        accounts.push(...await this.resolveSaberAccounts(ammKey, inputMint, outputMint));
        break;
      default:
        // Generic AMM accounts
        accounts.push(...await this.resolveGenericAmmAccounts(ammKey, inputMint, outputMint));
        break;
    }

    return accounts;
  }

  /**
   * Resolve Raydium-specific accounts
   */
  private async resolveRaydiumAccounts(
    ammKey: PublicKey,
    inputMint: PublicKey,
    outputMint: PublicKey
  ): Promise<AccountMeta[]> {
    // Derive Raydium pool accounts
    const [poolCoinTokenAccount] = PublicKey.findProgramAddressSync(
      [ammKey.toBuffer(), inputMint.toBuffer()],
      new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') // Raydium AMM program
    );

    const [poolPcTokenAccount] = PublicKey.findProgramAddressSync(
      [ammKey.toBuffer(), outputMint.toBuffer()],
      new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')
    );

    return [
      { pubkey: poolCoinTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolPcTokenAccount, isSigner: false, isWritable: true },
      { pubkey: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'), isSigner: false, isWritable: false }
    ];
  }

  /**
   * Resolve Orca-specific accounts
   */
  private async resolveOrcaAccounts(
    ammKey: PublicKey,
    inputMint: PublicKey,
    outputMint: PublicKey
  ): Promise<AccountMeta[]> {
    return [
      { pubkey: new PublicKey('9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP'), isSigner: false, isWritable: false }, // Orca program
    ];
  }

  /**
   * Resolve Serum-specific accounts
   */
  private async resolveSerumAccounts(
    ammKey: PublicKey,
    inputMint: PublicKey,
    outputMint: PublicKey
  ): Promise<AccountMeta[]> {
    return [
      { pubkey: new PublicKey('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'), isSigner: false, isWritable: false }, // Serum program
    ];
  }

  /**
   * Resolve Saber-specific accounts
   */
  private async resolveSaberAccounts(
    ammKey: PublicKey,
    inputMint: PublicKey,
    outputMint: PublicKey
  ): Promise<AccountMeta[]> {
    return [
      { pubkey: new PublicKey('SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ'), isSigner: false, isWritable: false }, // Saber program
    ];
  }

  /**
   * Resolve generic AMM accounts
   */
  private async resolveGenericAmmAccounts(
    ammKey: PublicKey,
    inputMint: PublicKey,
    outputMint: PublicKey
  ): Promise<AccountMeta[]> {
    // Basic token accounts for the AMM
    const inputTokenAccount = getAssociatedTokenAddressSync(inputMint, ammKey);
    const outputTokenAccount = getAssociatedTokenAddressSync(outputMint, ammKey);

    return [
      { pubkey: inputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
    ];
  }

  /**
   * Create route accounts map for program consumption
   */
  private createRouteAccountsMap(quote: JupiterQuote, accountMap: Map<string, number>): number[] {
    const routeMap: number[] = [];

    for (const routeStep of quote.routePlan) {
      // Add AMM account index
      const ammIndex = accountMap.get(routeStep.swapInfo.ammKey) ?? 0;
      routeMap.push(ammIndex);

      // Add input mint index
      const inputMintIndex = accountMap.get(routeStep.swapInfo.inputMint) ?? 0;
      routeMap.push(inputMintIndex);

      // Add output mint index
      const outputMintIndex = accountMap.get(routeStep.swapInfo.outputMint) ?? 0;
      routeMap.push(outputMintIndex);
    }

    // Pad to ensure minimum length
    while (routeMap.length < 32) {
      routeMap.push(0);
    }

    return routeMap;
  }
}