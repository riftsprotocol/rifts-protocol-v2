// lib/solana/rifts/jupiter.ts - Jupiter swap functions
import { Connection, PublicKey, Transaction, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { ServiceContext, WalletAdapter, RIFTS_PROGRAM_ID } from './types';

// ============ DIRECT JUPITER SWAP ============

export interface DirectJupiterSwapParams {
  inputMint: string;
  outputMint: string;
  amount: number; // in lamports
  slippageBps?: number; // basis points (300 = 3%)
  wallet: WalletAdapter;
}

export async function executeDirectJupiterSwap(
  ctx: ServiceContext,
  params: DirectJupiterSwapParams,
  confirmTransactionSafely: (sig: string) => Promise<boolean>
): Promise<string> {
  try {
    console.log('🪐 Starting direct Jupiter swap...');

    if (!params.wallet.publicKey) {
      throw new Error('Wallet not connected');
    }

    // Step 1: Get quote from Jupiter Ultra via our API route
    const quoteUrl = `/api/jupiter/quote?` + new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount.toString(),
      slippageBps: (params.slippageBps || 300).toString(),
    });

    const quoteResponse = await fetch(quoteUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      credentials: 'same-origin',
      signal: AbortSignal.timeout(10000)
    });

    if (!quoteResponse.ok) {
      const errorText = await quoteResponse.text().catch(() => '');
      let errorDetails;
      try {
        errorDetails = JSON.parse(errorText);
      } catch {
        errorDetails = { details: errorText };
      }
      throw new Error(`Jupiter quote failed: ${quoteResponse.status} ${JSON.stringify(errorDetails)}`);
    }

    const quote = await quoteResponse.json();

    // Step 2: Get swap transaction via our API route (uses Jupiter Ultra)
    console.log('📝 Getting swap transaction from Jupiter Ultra...');

    const swapResponse = await fetch('/api/jupiter/swap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: typeof params.wallet.publicKey === 'string'
          ? params.wallet.publicKey
          : params.wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        useSharedAccounts: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto'
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!swapResponse.ok) {
      const errorText = await swapResponse.text().catch(() => '');
      throw new Error(`Jupiter swap failed: ${swapResponse.status} ${errorText}`);
    }

    const swapData = await swapResponse.json();

    // Jupiter Ultra returns 'transaction' field, not 'swapTransaction'
    const transactionData = swapData.transaction || swapData.swapTransaction;

    if (!transactionData) {
      console.error('No transaction in response:', swapData);
      throw new Error('Jupiter Ultra API did not return a transaction. Response: ' + JSON.stringify(swapData));
    }

    // Step 3: Deserialize versioned transaction
    const { VersionedTransaction, PublicKey: PK } = await import('@solana/web3.js');

    const txBuf = Buffer.from(transactionData, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuf);

    // Use wallet's sendTransaction if available
    if (params.wallet.sendTransaction && params.wallet.publicKey) {
      console.log('Using wallet sendTransaction for Jupiter swap');

      const walletPubkey = typeof params.wallet.publicKey === 'string'
        ? new PK(params.wallet.publicKey)
        : params.wallet.publicKey;

      // @ts-ignore - Wallet adapter sendTransaction supports both Transaction and VersionedTransaction
      const signature = await params.wallet.sendTransaction(transaction, ctx.connection, {
        skipPreflight: false,
        maxRetries: 3
      });

      console.log(`Jupiter swap transaction sent: ${signature}`);

      await confirmTransactionSafely(signature);

      return signature;
    }

    // Fallback: Manual signing if signTransaction is available
    if (!params.wallet.signTransaction) {
      throw new Error('Wallet does not support transaction signing. Please ensure your wallet is properly connected.');
    }

    console.log('Using wallet signTransaction for Jupiter swap');

    // @ts-ignore - Wallet adapter supports both Transaction and VersionedTransaction
    const signedTx = await params.wallet.signTransaction(transaction);

    const signature = await ctx.connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
      maxRetries: 3
    });

    console.log(`Jupiter swap transaction sent: ${signature}`);

    await confirmTransactionSafely(signature);

    return signature;

  } catch (error) {
    console.error('Direct Jupiter swap failed:', error);

    if (error instanceof Error && error.message.includes('Failed to fetch')) {
      throw new Error('Network error: Unable to connect to Jupiter API. Please check your internet connection and try again.');
    }

    throw error;
  }
}

// ============ JUPITER SWAP VIA RIFTS PROTOCOL ============

export interface JupiterSwapParams {
  riftId: string;
  inputMint: string;
  outputMint: string;
  amount: number; // in lamports
  slippageBps?: number; // basis points (300 = 3%)
  wallet: WalletAdapter;
}

export async function executeJupiterSwap(
  ctx: ServiceContext,
  params: JupiterSwapParams,
  confirmTransactionSafely: (sig: string) => Promise<boolean>
): Promise<string> {
  try {
    console.log('🪐 Starting Jupiter swap via RIFTS protocol...');

    if (!params.wallet.publicKey) {
      throw new Error('Wallet not connected');
    }

    // Get Jupiter instruction data from Jupiter API first
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${params.inputMint}&outputMint=${params.outputMint}&amount=${params.amount}&slippageBps=${params.slippageBps || 300}&onlyDirectRoutes=false`;

    let jupiterResponse: Response;
    try {
      jupiterResponse = await fetch(quoteUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });
    } catch (fetchError) {
      throw new Error(`Failed to connect to Jupiter API. Please check your internet connection and try again. Error: ${fetchError instanceof Error ? fetchError.message : 'Network error'}`);
    }

    if (!jupiterResponse.ok) {
      const errorText = await jupiterResponse.text().catch(() => 'Unknown error');
      throw new Error(`Jupiter quote failed with status ${jupiterResponse.status}: ${errorText}`);
    }

    const quote = await jupiterResponse.json();

    // Get swap transaction from Jupiter
    console.log('📝 Getting swap transaction from Jupiter...');

    let swapResponse: Response;
    try {
      swapResponse = await fetch(`https://quote-api.jup.ag/v6/swap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: params.wallet.publicKey.toBase58(),
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto'
        }),
        signal: AbortSignal.timeout(10000)
      });
    } catch (fetchError) {
      throw new Error(`Failed to connect to Jupiter swap API. Please check your internet connection and try again. Error: ${fetchError instanceof Error ? fetchError.message : 'Network error'}`);
    }

    if (!swapResponse.ok) {
      const errorText = await swapResponse.text().catch(() => 'Unknown error');
      throw new Error(`Jupiter swap instruction failed with status ${swapResponse.status}: ${errorText}`);
    }

    const swapData = await swapResponse.json();
    const swapTransaction = Transaction.from(Buffer.from(swapData.swapTransaction, 'base64'));

    // Extract Jupiter instruction data and accounts from the transaction
    const jupiterInstruction = swapTransaction.instructions.find(ix =>
      ix.programId.toBase58() === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
    );

    if (!jupiterInstruction) {
      throw new Error('No Jupiter instruction found in transaction');
    }

    // Get rift PDA
    const riftPDA = new PublicKey(params.riftId);

    // Create the RIFTS protocol instruction to execute Jupiter swap
    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: riftPDA, isSigner: false, isWritable: true },
        { pubkey: params.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: new PublicKey(params.inputMint), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(params.outputMint), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        // Add Jupiter program and all its required accounts
        { pubkey: new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), isSigner: false, isWritable: false },
        ...jupiterInstruction.keys
      ],
      programId: RIFTS_PROGRAM_ID,
      data: Buffer.concat([
        Buffer.from([9]), // Instruction discriminator for execute_jupiter_swap_with_instruction
        Buffer.from(jupiterInstruction.data)
      ])
    });

    // Create and send transaction
    const transaction = new Transaction().add(instruction);
    const { blockhash } = await ctx.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = params.wallet.publicKey;

    // Sign and send transaction
    if (!params.wallet.signTransaction) {
      throw new Error('Wallet does not support manual transaction signing. Please try reconnecting your wallet.');
    }

    const signedTx = await params.wallet.signTransaction(transaction);
    const signature = await ctx.connection.sendRawTransaction(signedTx.serialize());

    await confirmTransactionSafely(signature);

    return signature;

  } catch (error) {
    console.error('Jupiter swap via RIFTS failed:', error);

    if (error instanceof Error && error.message.includes('Failed to fetch')) {
      throw new Error('Network error: Unable to connect to Jupiter API. This could be due to:\n' +
        '1. Internet connection issues\n' +
        '2. CORS restrictions (try using a different browser or network)\n' +
        '3. Jupiter API temporarily unavailable\n\n' +
        'Please check your connection and try again.');
    }

    throw error;
  }
}
