import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import fetch from 'cross-fetch';

export interface JupiterQuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
  swapMode?: 'ExactIn' | 'ExactOut';
  dexes?: string[];
  excludeDexes?: string[];
  platformFeeBps?: number;
  maxAccounts?: number;
  onlyDirectRoutes?: boolean;
}

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
  contextSlot: number;
  timeTaken: number;
}

export interface JupiterSwapRequest {
  quoteResponse: JupiterQuote;
  userPublicKey: string;
  wrapAndUnwrapSol?: boolean;
  useSharedAccounts?: boolean;
  feeAccount?: string;
  computeUnitPriceMicroLamports?: number;
  asLegacyTransaction?: boolean;
  useTokenLedger?: boolean;
  destinationTokenAccount?: string;
}

export interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
}

export class JupiterClient {
  private readonly baseUrl = 'https://quote-api.jup.ag/v6';
  private readonly connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Fetch a quote from Jupiter API
   */
  async getQuote(request: JupiterQuoteRequest): Promise<JupiterQuote> {
    const params = new URLSearchParams({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amount,
    });

    if (request.slippageBps !== undefined) {
      params.append('slippageBps', request.slippageBps.toString());
    }
    if (request.swapMode) {
      params.append('swapMode', request.swapMode);
    }
    if (request.dexes) {
      params.append('dexes', request.dexes.join(','));
    }
    if (request.excludeDexes) {
      params.append('excludeDexes', request.excludeDexes.join(','));
    }
    if (request.platformFeeBps !== undefined) {
      params.append('platformFeeBps', request.platformFeeBps.toString());
    }
    if (request.maxAccounts !== undefined) {
      params.append('maxAccounts', request.maxAccounts.toString());
    }
    if (request.onlyDirectRoutes !== undefined) {
      params.append('onlyDirectRoutes', request.onlyDirectRoutes.toString());
    }

    const response = await fetch(`${this.baseUrl}/quote?${params.toString()}`);
    
    if (!response.ok) {
      throw new Error(`Jupiter quote request failed: ${response.status} ${response.statusText}`);
    }

    const quote = await response.json() as JupiterQuote;
    
    // Validate quote freshness (within 30 seconds)
    const currentSlot = await this.connection.getSlot();
    const maxSlotDifference = 150; // ~30 seconds at 400ms/slot
    
    if (currentSlot - quote.contextSlot > maxSlotDifference) {
      throw new Error('Quote is stale, please request a new quote');
    }

    return quote;
  }

  /**
   * Get swap transaction from Jupiter API
   */
  async getSwapTransaction(request: JupiterSwapRequest): Promise<JupiterSwapResponse> {
    const response = await fetch(`${this.baseUrl}/swap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Jupiter swap request failed: ${response.status} ${response.statusText}`);
    }

    return await response.json() as JupiterSwapResponse;
  }

  /**
   * Get route account map for CPI
   */
  async getRouteAccounts(quote: JupiterQuote): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    
    // Add standard Jupiter program accounts
    accounts.push(new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')); // Jupiter v6 program
    accounts.push(new PublicKey(quote.inputMint));
    accounts.push(new PublicKey(quote.outputMint));

    // Add AMM-specific accounts from route plan
    for (const routeStep of quote.routePlan) {
      const ammKey = new PublicKey(routeStep.swapInfo.ammKey);
      if (!accounts.some(acc => acc.equals(ammKey))) {
        accounts.push(ammKey);
      }

      // Add mint accounts if not already included
      const inputMint = new PublicKey(routeStep.swapInfo.inputMint);
      const outputMint = new PublicKey(routeStep.swapInfo.outputMint);
      
      if (!accounts.some(acc => acc.equals(inputMint))) {
        accounts.push(inputMint);
      }
      if (!accounts.some(acc => acc.equals(outputMint))) {
        accounts.push(outputMint);
      }
    }

    return accounts;
  }

  /**
   * Validate quote is still fresh and valid
   */
  async validateQuote(quote: JupiterQuote): Promise<boolean> {
    try {
      const currentSlot = await this.connection.getSlot();
      const maxSlotDifference = 150; // ~30 seconds
      
      return currentSlot - quote.contextSlot <= maxSlotDifference;
    } catch (error) {
      console.error('Error validating quote:', error);
      return false;
    }
  }

  /**
   * Convert Jupiter quote to program format
   */
  convertQuoteToProgram(quote: JupiterQuote): {
    jupiterQuote: any;
    routeAccountsMap: number[];
  } {
    // Serialize route plan
    const routePlan = quote.routePlan.map(step => ({
      swapInfo: {
        ammKey: new PublicKey(step.swapInfo.ammKey).toBytes(),
        label: step.swapInfo.label,
        inputMint: new PublicKey(step.swapInfo.inputMint).toBytes(),
        outputMint: new PublicKey(step.swapInfo.outputMint).toBytes(),
        inAmount: new BN(step.swapInfo.inAmount),
        outAmount: new BN(step.swapInfo.outAmount),
        feeAmount: new BN(step.swapInfo.feeAmount),
        feeMint: new PublicKey(step.swapInfo.feeMint).toBytes(),
      },
      percent: step.percent,
    }));

    const jupiterQuote = {
      inputMint: new PublicKey(quote.inputMint).toBytes(),
      inAmount: new BN(quote.inAmount),
      outputMint: new PublicKey(quote.outputMint).toBytes(),
      outAmount: new BN(quote.outAmount),
      otherAmountThreshold: new BN(quote.otherAmountThreshold),
      swapMode: quote.swapMode === 'ExactIn' ? 0 : 1,
      slippageBps: quote.slippageBps,
      priceImpactPct: parseFloat(quote.priceImpactPct) * 10000, // Convert to bps
      routePlan: routePlan,
      contextSlot: new BN(quote.contextSlot),
      timeTaken: quote.timeTaken,
    };

    // Create route accounts map (simplified version)
    const routeAccountsMap = Array.from({ length: quote.routePlan.length * 10 }, (_, i) => i);

    return { jupiterQuote, routeAccountsMap };
  }
}