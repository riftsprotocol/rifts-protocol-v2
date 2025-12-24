import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Keypair,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  AddressLookupTableAccount
} from '@solana/web3.js';
import { Program, AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
import { JupiterClient, JupiterQuote } from './client';
import { JupiterAccountResolver, ResolvedAccounts } from './accounts';

export interface SwapTransactionConfig {
  computeUnitLimit?: number;
  computeUnitPrice?: number;
  priorityFee?: number;
  useVersionedTransaction?: boolean;
  addressLookupTableAccounts?: AddressLookupTableAccount[];
}

export interface SwapResult {
  signature: string;
  inputAmount: BN;
  outputAmount: BN;
  priceImpact: number;
  fee: BN;
}

export class JupiterTransactionBuilder {
  private connection: Connection;
  private jupiterClient: JupiterClient;
  private accountResolver: JupiterAccountResolver;
  private feeCollectorProgram: Program;

  constructor(
    connection: Connection,
    feeCollectorProgram: Program,
    jupiterClient?: JupiterClient,
    accountResolver?: JupiterAccountResolver
  ) {
    this.connection = connection;
    this.feeCollectorProgram = feeCollectorProgram;
    this.jupiterClient = jupiterClient || new JupiterClient(connection);
    this.accountResolver = accountResolver || new JupiterAccountResolver(connection);
  }

  /**
   * Build complete swap transaction
   */
  async buildSwapTransaction(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: BN,
    userPublicKey: PublicKey,
    maxSlippageBps: number = 300, // 3% default slippage
    config: SwapTransactionConfig = {}
  ): Promise<{
    transaction: Transaction;
    quote: JupiterQuote;
    resolvedAccounts: ResolvedAccounts;
  }> {
    // 1. Get quote from Jupiter
    const quote = await this.jupiterClient.getQuote({
      inputMint: inputMint.toBase58(),
      outputMint: outputMint.toBase58(),
      amount: amount.toString(),
      slippageBps: maxSlippageBps,
      swapMode: 'ExactIn',
      maxAccounts: 20 // Limit to prevent transaction size issues
    });

    // 2. Resolve all required accounts
    const [feeCollectorState] = PublicKey.findProgramAddressSync(
      [Buffer.from('fee_collector')],
      this.feeCollectorProgram.programId
    );

    const resolvedAccounts = await this.accountResolver.resolveAccounts(
      quote,
      userPublicKey,
      this.feeCollectorProgram.programId,
      feeCollectorState
    );

    // 3. Build transaction
    const transaction = new Transaction();

    // Add compute budget instructions if specified
    if (config.computeUnitLimit) {
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: config.computeUnitLimit
        })
      );
    }

    if (config.computeUnitPrice) {
      transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: config.computeUnitPrice
        })
      );
    }

    if (config.priorityFee) {
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: userPublicKey,
          toPubkey: new PublicKey('11111111111111111111111111111111'), // Burn address for priority fee
          lamports: config.priorityFee
        })
      );
    }

    // Add setup instructions (e.g., create ATA if needed)
    for (const setupIx of resolvedAccounts.setupInstructions) {
      transaction.add(setupIx);
    }

    // 4. Create fee collection instruction
    const { jupiterQuote, routeAccountsMap } = this.jupiterClient.convertQuoteToProgram(quote);

    const feeCollectionIx = await this.feeCollectorProgram.methods
      .processFeesWithJupiterIntegration(
        jupiterQuote,
        maxSlippageBps,
        Buffer.from(routeAccountsMap)
      )
      .accounts({
        feeCollector: feeCollectorState,
        user: userPublicKey,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(resolvedAccounts.remainingAccounts)
      .instruction();

    transaction.add(feeCollectionIx);

    return {
      transaction,
      quote,
      resolvedAccounts
    };
  }

  /**
   * Execute swap transaction
   */
  async executeSwap(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: BN,
    wallet: Wallet,
    maxSlippageBps: number = 300,
    config: SwapTransactionConfig = {}
  ): Promise<SwapResult> {
    const userPublicKey = wallet.publicKey;

    // Build transaction
    const { transaction, quote } = await this.buildSwapTransaction(
      inputMint,
      outputMint,
      amount,
      userPublicKey,
      maxSlippageBps,
      config
    );

    // Get recent blockhash
    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = userPublicKey;

    // Sign and send transaction
    const signedTransaction = await wallet.signTransaction(transaction);
    
    const signature = await this.connection.sendRawTransaction(
      signedTransaction.serialize(),
      {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3
      }
    );

    // Wait for confirmation
    const confirmation = await this.connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight: await this.connection.getBlockHeight() + 150
    });

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${confirmation.value.err.toString()}`);
    }

    // Parse results from quote
    const inputAmount = new BN(quote.inAmount);
    const outputAmount = new BN(quote.outAmount);
    const priceImpact = parseFloat(quote.priceImpactPct);
    const fee = inputAmount.sub(outputAmount).mul(new BN(quote.slippageBps)).div(new BN(10000));

    return {
      signature,
      inputAmount,
      outputAmount,
      priceImpact,
      fee
    };
  }

  /**
   * Simulate swap to estimate results
   */
  async simulateSwap(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: BN,
    userPublicKey: PublicKey,
    maxSlippageBps: number = 300
  ): Promise<{
    quote: JupiterQuote;
    estimatedOutput: BN;
    priceImpact: number;
    minimumOutput: BN;
    fees: BN;
  }> {
    // Get quote for simulation
    const quote = await this.jupiterClient.getQuote({
      inputMint: inputMint.toBase58(),
      outputMint: outputMint.toBase58(),
      amount: amount.toString(),
      slippageBps: maxSlippageBps,
      swapMode: 'ExactIn'
    });

    const estimatedOutput = new BN(quote.outAmount);
    const priceImpact = parseFloat(quote.priceImpactPct);
    
    // Calculate minimum output with slippage
    const minimumOutput = estimatedOutput
      .mul(new BN(10000 - maxSlippageBps))
      .div(new BN(10000));

    // Estimate fees (platform fees + price impact)
    const fees = amount.sub(estimatedOutput);

    return {
      quote,
      estimatedOutput,
      priceImpact,
      minimumOutput,
      fees
    };
  }

  /**
   * Get optimal route for swap
   */
  async getOptimalRoute(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: BN,
    options: {
      maxSlippageBps?: number;
      dexes?: string[];
      excludeDexes?: string[];
      onlyDirectRoutes?: boolean;
    } = {}
  ): Promise<JupiterQuote> {
    return await this.jupiterClient.getQuote({
      inputMint: inputMint.toBase58(),
      outputMint: outputMint.toBase58(),
      amount: amount.toString(),
      slippageBps: options.maxSlippageBps || 300,
      swapMode: 'ExactIn',
      dexes: options.dexes,
      excludeDexes: options.excludeDexes,
      onlyDirectRoutes: options.onlyDirectRoutes,
      maxAccounts: 20
    });
  }

  /**
   * Batch multiple swaps into single transaction
   */
  async buildBatchSwapTransaction(
    swaps: Array<{
      inputMint: PublicKey;
      outputMint: PublicKey;
      amount: BN;
      maxSlippageBps?: number;
    }>,
    userPublicKey: PublicKey,
    config: SwapTransactionConfig = {}
  ): Promise<{
    transaction: Transaction;
    quotes: JupiterQuote[];
  }> {
    const transaction = new Transaction();
    const quotes: JupiterQuote[] = [];

    // Add compute budget for batch transaction
    if (config.computeUnitLimit) {
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: config.computeUnitLimit
        })
      );
    }

    for (const swap of swaps) {
      const { transaction: swapTx, quote } = await this.buildSwapTransaction(
        swap.inputMint,
        swap.outputMint,
        swap.amount,
        userPublicKey,
        swap.maxSlippageBps || 300,
        { ...config, computeUnitLimit: undefined } // Don't duplicate compute budget
      );

      // Add swap instructions to batch transaction
      transaction.instructions.push(...swapTx.instructions.slice(-1)); // Only the fee collection instruction
      quotes.push(quote);
    }

    return {
      transaction,
      quotes
    };
  }

  /**
   * Estimate transaction fees
   */
  async estimateTransactionFee(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: BN,
    userPublicKey: PublicKey
  ): Promise<{
    baseFee: number;
    priorityFee?: number;
    totalFee: number;
  }> {
    const { transaction } = await this.buildSwapTransaction(
      inputMint,
      outputMint,
      amount,
      userPublicKey
    );

    // Get fee for transaction size
    const message = transaction.compileMessage();
    const baseFee = await this.connection.getFeeForMessage(message);

    if (!baseFee.value) {
      throw new Error('Failed to estimate transaction fee');
    }

    return {
      baseFee: baseFee.value,
      totalFee: baseFee.value
    };
  }
}