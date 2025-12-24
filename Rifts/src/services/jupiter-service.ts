import {
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionInstruction,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
} from '@solana/web3.js';

/**
 * Real Jupiter V6 API Integration Service
 * Uses the official Jupiter Swap API for routing and instruction generation
 */
export class JupiterService {
  private connection: Connection;
  private apiUrl: string;

  constructor(connection: Connection, cluster: 'mainnet' | 'devnet' = 'mainnet') {
    this.connection = connection;
    this.apiUrl = cluster === 'mainnet' 
      ? 'https://quote-api.jup.ag/v6' 
      : 'https://quote-api.jup.ag/v6'; // Same API for both
  }

  /**
   * Get quote for token swap using Jupiter API
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 300 // 3% default slippage
  ): Promise<JupiterQuote> {
    try {
      
      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps: slippageBps.toString(),
        onlyDirectRoutes: 'false',
        asLegacyTransaction: 'false',
      });

      const response = await fetch(`${this.apiUrl}/quote?${params}`);
      
      if (!response.ok) {
        throw new Error(`Jupiter API error: ${response.statusText}`);
      }

      const quote = await response.json() as JupiterQuote;
      
      return quote;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get swap transaction from Jupiter API
   */
  async getSwapTransaction(
    quote: JupiterQuote,
    userPublicKey: string,
    priorityFee?: number
  ): Promise<{
    swapTransaction: string;
    addressLookupTableAddresses: string[];
  }> {
    try {

      const swapRequest = {
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        priorityLevelWithMaxLamports: priorityFee ? {
          priorityLevel: 'high',
          maxLamports: priorityFee
        } : undefined,
        dynamicComputeUnitLimit: true,
        skipUserAccountsRpcCalls: true,
      };

      const response = await fetch(`${this.apiUrl}/swap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(swapRequest),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Jupiter swap API error: ${response.statusText} - ${errorText}`);
      }

      const swapResponse = await response.json();

      return {
        swapTransaction: swapResponse.swapTransaction,
        addressLookupTableAddresses: swapResponse.addressLookupTableAddresses || [],
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Parse Jupiter swap transaction to extract instruction data
   */
  async parseSwapTransaction(
    swapTransactionBase64: string,
    addressLookupTableAddresses: string[]
  ): Promise<{
    instructions: TransactionInstruction[];
    computeBudgetInstructions: TransactionInstruction[];
    lookupTables: AddressLookupTableAccount[];
  }> {
    try {

      // Deserialize the transaction
      const transactionBuffer = Buffer.from(swapTransactionBase64, 'base64');
      const transaction = VersionedTransaction.deserialize(transactionBuffer);

      // Get address lookup tables if any
      const lookupTables: AddressLookupTableAccount[] = [];
      if (addressLookupTableAddresses.length > 0) {
        for (const address of addressLookupTableAddresses) {
          const lookupTableAccount = await this.connection.getAddressLookupTable(
            new PublicKey(address)
          );
          if (lookupTableAccount.value) {
            lookupTables.push(lookupTableAccount.value);
          }
        }
      }

      // Extract instructions
      const instructions: TransactionInstruction[] = [];
      const computeBudgetInstructions: TransactionInstruction[] = [];

      for (const instruction of transaction.message.compiledInstructions) {
        const programId = transaction.message.staticAccountKeys[instruction.programIdIndex];
        
        // Separate compute budget instructions from swap instructions
        if (programId.equals(ComputeBudgetProgram.programId)) {
          // Reconstruct compute budget instruction
          const computeInstruction = new TransactionInstruction({
            keys: instruction.accountKeyIndexes.map(keyIndex => ({
              pubkey: transaction.message.staticAccountKeys[keyIndex],
              isSigner: transaction.message.header.numRequiredSignatures > keyIndex,
              isWritable: keyIndex < transaction.message.header.numReadonlySignedAccounts + 
                         transaction.message.header.numReadonlyUnsignedAccounts,
            })),
            programId,
            data: Buffer.from(instruction.data),
          });
          computeBudgetInstructions.push(computeInstruction);
        } else {
          // Reconstruct swap instruction
          const swapInstruction = new TransactionInstruction({
            keys: instruction.accountKeyIndexes.map(keyIndex => ({
              pubkey: transaction.message.staticAccountKeys[keyIndex],
              isSigner: transaction.message.header.numRequiredSignatures > keyIndex,
              isWritable: keyIndex < transaction.message.header.numReadonlySignedAccounts + 
                         transaction.message.header.numReadonlyUnsignedAccounts,
            })),
            programId,
            data: Buffer.from(instruction.data),
          });
          instructions.push(swapInstruction);
        }
      }


      return {
        instructions,
        computeBudgetInstructions,
        lookupTables,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get swap instruction data for use in Solana programs
   */
  async getSwapInstructionData(
    inputMint: string,
    outputMint: string,
    amount: number,
    userPublicKey: string,
    slippageBps: number = 300
  ): Promise<{
    instructionData: Buffer;
    accounts: PublicKey[];
    quote: JupiterQuote;
  }> {
    try {
      // Get quote
      const quote = await this.getQuote(inputMint, outputMint, amount, slippageBps);

      // Get swap transaction
      const { swapTransaction, addressLookupTableAddresses } = await this.getSwapTransaction(
        quote,
        userPublicKey
      );

      // Parse transaction
      const { instructions } = await this.parseSwapTransaction(
        swapTransaction,
        addressLookupTableAddresses
      );

      // Extract the main Jupiter swap instruction (usually the largest one)
      const jupiterInstruction = instructions.find(ix => 
        ix.programId.toString() === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
      );

      if (!jupiterInstruction) {
        throw new Error('No Jupiter swap instruction found in transaction');
      }

      const accounts = jupiterInstruction.keys.map(key => key.pubkey);


      return {
        instructionData: jupiterInstruction.data,
        accounts,
        quote,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Estimate output amount for a given input (quick quote)
   */
  async estimateOutputAmount(
    inputMint: string,
    outputMint: string,
    inputAmount: number
  ): Promise<number> {
    try {
      const quote = await this.getQuote(inputMint, outputMint, inputAmount, 100); // 1% slippage for estimate
      return parseInt(quote.outAmount);
    } catch (error) {
      return 0;
    }
  }
}

// Jupiter API types
export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee?: {
    amount: string;
    feeBps: number;
  };
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
  contextSlot?: number;
  timeTaken?: number;
}

// Export singleton instance
let jupiterService: JupiterService;

export const getJupiterService = (connection?: Connection, cluster: 'mainnet' | 'devnet' = 'mainnet'): JupiterService => {
  if (!jupiterService && connection) {
    jupiterService = new JupiterService(connection, cluster);
  } else if (!jupiterService) {
    throw new Error('JupiterService not initialized. Please provide a Connection.');
  }
  return jupiterService;
};

export default JupiterService;