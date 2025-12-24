import {
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionInstruction,
  AccountMeta,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
} from '@solana/web3.js';

/**
 * Complete Jupiter V6 API Client for Real Integration
 * Handles route calculation and instruction generation off-chain
 */
export class JupiterApiClient {
  private connection: Connection;
  private apiUrl: string;

  constructor(connection: Connection, cluster: 'mainnet' | 'devnet' = 'mainnet') {
    this.connection = connection;
    this.apiUrl = cluster === 'mainnet' 
      ? 'https://quote-api.jup.ag/v6' 
      : 'https://quote-api.jup.ag/v6';
  }

  /**
   * Get real Jupiter quote with routing
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 300,
    feeBps?: number,
    platformFeeBps?: number
  ): Promise<JupiterQuoteResponse> {
    try {
      
      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps: slippageBps.toString(),
        onlyDirectRoutes: 'false',
        asLegacyTransaction: 'false',
        maxAccounts: '20', // Limit accounts for CPI compatibility
        ...(feeBps && { feeBps: feeBps.toString() }),
        ...(platformFeeBps && { platformFeeBps: platformFeeBps.toString() }),
      });

      const response = await fetch(`${this.apiUrl}/quote?${params}`);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Jupiter quote API error: ${response.statusText} - ${errorText}`);
      }

      const quote = await response.json() as JupiterQuoteResponse;
      
      return quote;
    } catch (error) {
      console.error('❌ Failed to get Jupiter quote:', error);
      throw error;
    }
  }

  /**
   * Get swap transaction from Jupiter API
   */
  async getSwapTransaction(
    quote: JupiterQuoteResponse,
    userPublicKey: string,
    wrapAndUnwrapSol: boolean = true,
    dynamicComputeUnitLimit: boolean = true,
    priorityLevelWithMaxLamports?: {
      priorityLevel: 'none' | 'low' | 'medium' | 'high' | 'veryHigh';
      maxLamports: number;
    }
  ): Promise<JupiterSwapResponse> {
    try {

      const swapRequest = {
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol,
        dynamicComputeUnitLimit,
        ...(priorityLevelWithMaxLamports && { priorityLevelWithMaxLamports }),
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

      const swapResponse = await response.json() as JupiterSwapResponse;

      return swapResponse;
    } catch (error) {
      console.error('❌ Failed to get Jupiter swap transaction:', error);
      throw error;
    }
  }

  /**
   * Extract Jupiter instruction data for use in Solana program CPI
   * This is the KEY function for the correct architecture
   */
  async extractJupiterInstructionData(
    inputMint: string,
    outputMint: string,
    amount: number,
    userPublicKey: string,
    slippageBps: number = 300
  ): Promise<{
    instructionData: Buffer;
    accounts: AccountMeta[];
    quote: JupiterQuoteResponse;
    computeBudgetInstructions: TransactionInstruction[];
  }> {
    try {

      // Step 1: Get quote from Jupiter API
      const quote = await this.getQuote(inputMint, outputMint, amount, slippageBps);

      // Step 2: Get swap transaction
      const { swapTransaction, addressLookupTableAddresses } = 
        await this.getSwapTransaction(quote, userPublicKey);

      // Step 3: Parse transaction to extract instruction data
      const { instructionData, accounts, computeBudgetInstructions } = 
        await this.parseSwapTransaction(swapTransaction, addressLookupTableAddresses || []);

      return {
        instructionData,
        accounts,
        quote,
        computeBudgetInstructions,
      };
    } catch (error) {
      console.error('❌ Failed to extract Jupiter instruction data:', error);
      throw error;
    }
  }

  /**
   * Parse Jupiter swap transaction to extract instruction and account data
   */
  private async parseSwapTransaction(
    swapTransactionBase64: string,
    addressLookupTableAddresses: string[]
  ): Promise<{
    instructionData: Buffer;
    accounts: AccountMeta[];
    computeBudgetInstructions: TransactionInstruction[];
  }> {
    try {

      // Deserialize the transaction
      const transactionBuffer = Buffer.from(swapTransactionBase64, 'base64');
      const transaction = VersionedTransaction.deserialize(transactionBuffer);

      // Get address lookup tables if any
      const lookupTables: AddressLookupTableAccount[] = [];
      if (addressLookupTableAddresses.length > 0) {
        for (const address of addressLookupTableAddresses) {
          try {
            const lookupTableAccount = await this.connection.getAddressLookupTable(
              new PublicKey(address)
            );
            if (lookupTableAccount.value) {
              lookupTables.push(lookupTableAccount.value);
            }
          } catch (error) {
            console.warn(`Could not fetch lookup table ${address}:`, error);
          }
        }
      }

      // Resolve all addresses including lookup table addresses
      const allAccountKeys = transaction.message.getAccountKeys({ 
        addressLookupTableAccounts: lookupTables 
      });

      let jupiterInstructionData: Buffer | null = null;
      let jupiterAccounts: AccountMeta[] = [];
      const computeBudgetInstructions: TransactionInstruction[] = [];

      // Extract instructions
      for (const instruction of transaction.message.compiledInstructions) {
        const programId = allAccountKeys.get(instruction.programIdIndex);
        
        if (!programId) continue;

        // Separate compute budget instructions
        if (programId.equals(ComputeBudgetProgram.programId)) {
          const computeInstruction = new TransactionInstruction({
            keys: instruction.accountKeyIndexes.map(keyIndex => {
              const pubkey = allAccountKeys.get(keyIndex);
              if (!pubkey) throw new Error(`Cannot resolve account at index ${keyIndex}`);
              return {
                pubkey,
                isSigner: keyIndex < transaction.message.header.numRequiredSignatures,
                isWritable: keyIndex < transaction.message.header.numRequiredSignatures ||
                           (keyIndex >= transaction.message.header.numRequiredSignatures &&
                            keyIndex < transaction.message.header.numRequiredSignatures +
                                     transaction.message.header.numReadonlySignedAccounts),
              };
            }),
            programId,
            data: Buffer.from(instruction.data),
          });
          computeBudgetInstructions.push(computeInstruction);

        } else if (programId.toString() === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') {
          // This is the Jupiter instruction
          jupiterInstructionData = Buffer.from(instruction.data);
          
          // Build account metas
          jupiterAccounts = instruction.accountKeyIndexes.map(keyIndex => {
            const pubkey = allAccountKeys.get(keyIndex);
            if (!pubkey) throw new Error(`Cannot resolve account at index ${keyIndex}`);
            
            const isSigner = keyIndex < transaction.message.header.numRequiredSignatures;
            const isWritable = keyIndex < (transaction.message.header.numRequiredSignatures - 
                                         transaction.message.header.numReadonlySignedAccounts) ||
                             (keyIndex >= transaction.message.header.numRequiredSignatures &&
                              keyIndex < transaction.message.header.numRequiredSignatures + 
                                        transaction.message.header.numReadonlyUnsignedAccounts);

            return {
              pubkey,
              isSigner,
              isWritable,
            };
          });
        }
      }

      if (!jupiterInstructionData) {
        throw new Error('No Jupiter instruction found in transaction');
      }

      return {
        instructionData: jupiterInstructionData,
        accounts: jupiterAccounts,
        computeBudgetInstructions,
      };
    } catch (error) {
      console.error('❌ Failed to parse Jupiter swap transaction:', error);
      throw error;
    }
  }

  /**
   * Get simple price estimate for UI display
   */
  async getSimplePriceEstimate(
    inputMint: string,
    outputMint: string,
    inputAmount: number
  ): Promise<number> {
    try {
      const quote = await this.getQuote(inputMint, outputMint, inputAmount, 100); // 1% slippage
      return parseInt(quote.outAmount);
    } catch (error) {
      console.error('Failed to get price estimate:', error);
      return 0;
    }
  }
}

// Jupiter API Response Types
export interface JupiterQuoteResponse {
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

export interface JupiterSwapResponse {
  swapTransaction: string;
  addressLookupTableAddresses?: string[];
}

// Singleton pattern for easy access
let jupiterApiClient: JupiterApiClient;

export const getJupiterApiClient = (connection?: Connection, cluster: 'mainnet' | 'devnet' = 'mainnet'): JupiterApiClient => {
  if (!jupiterApiClient && connection) {
    jupiterApiClient = new JupiterApiClient(connection, cluster);
  } else if (!jupiterApiClient) {
    throw new Error('JupiterApiClient not initialized. Please provide a Connection.');
  }
  return jupiterApiClient;
};

export default JupiterApiClient;