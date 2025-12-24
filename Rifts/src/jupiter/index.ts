export * from './client';
export * from './accounts';
export * from './transactions';

import { Connection, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
import { JupiterClient } from './client';
import { JupiterAccountResolver } from './accounts';
import { JupiterTransactionBuilder, SwapResult, SwapTransactionConfig } from './transactions';

/**
 * Main Jupiter integration SDK for RIFTS Protocol
 */
export class RiftsJupiterSDK {
  private connection: Connection;
  private feeCollectorProgram: Program;
  private jupiterClient: JupiterClient;
  private accountResolver: JupiterAccountResolver;
  private transactionBuilder: JupiterTransactionBuilder;

  constructor(
    connection: Connection,
    feeCollectorProgram: Program
  ) {
    this.connection = connection;
    this.feeCollectorProgram = feeCollectorProgram;
    this.jupiterClient = new JupiterClient(connection);
    this.accountResolver = new JupiterAccountResolver(connection);
    this.transactionBuilder = new JupiterTransactionBuilder(
      connection,
      feeCollectorProgram,
      this.jupiterClient,
      this.accountResolver
    );
  }

  /**
   * Get the best quote for swapping tokens through fee collection
   */
  async getSwapQuote(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: BN,
    options?: {
      slippageBps?: number;
      dexes?: string[];
      excludeDexes?: string[];
      onlyDirectRoutes?: boolean;
    }
  ) {
    return await this.transactionBuilder.getOptimalRoute(
      inputMint,
      outputMint,
      amount,
      options
    );
  }

  /**
   * Simulate a swap to get estimated results
   */
  async simulateSwap(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: BN,
    userPublicKey: PublicKey,
    maxSlippageBps: number = 300
  ) {
    return await this.transactionBuilder.simulateSwap(
      inputMint,
      outputMint,
      amount,
      userPublicKey,
      maxSlippageBps
    );
  }

  /**
   * Execute a swap through the fee collector
   */
  async executeSwap(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: BN,
    wallet: Wallet,
    maxSlippageBps: number = 300,
    config?: SwapTransactionConfig
  ): Promise<SwapResult> {
    return await this.transactionBuilder.executeSwap(
      inputMint,
      outputMint,
      amount,
      wallet,
      maxSlippageBps,
      config
    );
  }

  /**
   * Build a swap transaction without executing it
   */
  async buildSwapTransaction(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: BN,
    userPublicKey: PublicKey,
    maxSlippageBps: number = 300,
    config?: SwapTransactionConfig
  ) {
    return await this.transactionBuilder.buildSwapTransaction(
      inputMint,
      outputMint,
      amount,
      userPublicKey,
      maxSlippageBps,
      config
    );
  }

  /**
   * Estimate transaction fees for a swap
   */
  async estimateSwapFees(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: BN,
    userPublicKey: PublicKey
  ) {
    return await this.transactionBuilder.estimateTransactionFee(
      inputMint,
      outputMint,
      amount,
      userPublicKey
    );
  }

  /**
   * Batch multiple swaps into a single transaction
   */
  async buildBatchSwap(
    swaps: Array<{
      inputMint: PublicKey;
      outputMint: PublicKey;
      amount: BN;
      maxSlippageBps?: number;
    }>,
    userPublicKey: PublicKey,
    config?: SwapTransactionConfig
  ) {
    return await this.transactionBuilder.buildBatchSwapTransaction(
      swaps,
      userPublicKey,
      config
    );
  }

  /**
   * Check if a quote is still valid (not expired)
   */
  async isQuoteValid(quote: any): Promise<boolean> {
    return await this.jupiterClient.validateQuote(quote);
  }

  /**
   * Get supported tokens that can be swapped
   */
  async getSupportedTokens(): Promise<Array<{
    mint: string;
    symbol: string;
    name: string;
    decimals: number;
    logoURI?: string;
  }>> {
    try {
      // Jupiter tokens list endpoint
      const response = await fetch('https://token.jup.ag/all');
      if (!response.ok) {
        throw new Error('Failed to fetch tokens list');
      }
      return await response.json();
    } catch (error) {
      console.error('Error fetching supported tokens:', error);
      return [];
    }
  }

  /**
   * Get price information for a token
   */
  async getTokenPrice(mint: PublicKey): Promise<{
    id: string;
    mintSymbol: string;
    vsToken: string;
    vsTokenSymbol: string;
    price: number;
  } | null> {
    try {
      const response = await fetch(`https://price.jup.ag/v4/price?ids=${mint.toBase58()}`);
      if (!response.ok) {
        throw new Error('Failed to fetch token price');
      }
      const data = await response.json();
      return data.data?.[mint.toBase58()] || null;
    } catch (error) {
      console.error('Error fetching token price:', error);
      return null;
    }
  }

  /**
   * Health check for Jupiter services
   */
  async healthCheck(): Promise<{
    quoteApi: boolean;
    priceApi: boolean;
    tokensApi: boolean;
    connection: boolean;
  }> {
    const checks = await Promise.allSettled([
      // Quote API health
      fetch('https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000', {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      }),
      
      // Price API health
      fetch('https://price.jup.ag/v4/price?ids=So11111111111111111111111111111111111111112', {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      }),
      
      // Tokens API health
      fetch('https://token.jup.ag/all', {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      }),
      
      // Connection health
      this.connection.getLatestBlockhash()
    ]);

    return {
      quoteApi: checks[0].status === 'fulfilled',
      priceApi: checks[1].status === 'fulfilled',
      tokensApi: checks[2].status === 'fulfilled',
      connection: checks[3].status === 'fulfilled'
    };
  }
}

/**
 * Factory function to create RiftsJupiterSDK instance
 */
export function createRiftsJupiterSDK(
  connection: Connection,
  feeCollectorProgram: Program
): RiftsJupiterSDK {
  return new RiftsJupiterSDK(connection, feeCollectorProgram);
}

/**
 * Common token addresses for convenience
 */
export const COMMON_TOKENS = {
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  USDT: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
  BONK: new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'),
  JUP: new PublicKey('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'),
  RAY: new PublicKey('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'),
  ORCA: new PublicKey('orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'),
  MNGO: new PublicKey('MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac')
} as const;