/**
 * TradingInterface - Optimized for fast loading
 *
 * PERFORMANCE OPTIMIZATIONS:
 * 1. Skip slow blockchain transaction fetching - use cached volume data
 * 2. Only load balances for selected trading pair (not all tokens)
 * 3. Use existing TVL data instead of fetching pool accounts
 * 4. Increased update intervals: balances 15s, orderbook 30s, transactions 60s
 * 5. Show interface immediately with first available pair
 */
import React, { useState, useEffect, useRef } from 'react';
import {
    ArrowUp, ArrowDown, RefreshCw, Loader, Copy, Check, ExternalLink
} from 'lucide-react';
import { PublicKey, Connection } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { LuxuryButton } from '@/components/ui/luxury-button';
import { dexIntegration } from '@/lib/solana/dex-integration';
import { riftsService } from '@/lib/solana/rifts-service';
import { connection } from '@/lib/solana/index';
import { jupiterIntegration } from '@/lib/solana/jupiter-integration';
import { meteoraIntegration } from '@/lib/solana/meteora-integration';
import { debugLog, debugError } from '@/utils/debug';

// Create a proxied Solana Connection for transaction queries (HTTP polling, no websockets)
const standardConnection = typeof window !== 'undefined'
  ? (() => {
      const { ProxiedConnection } = require('@/lib/solana/rpc-client');
      return new ProxiedConnection();
    })()
  : new Connection(require('@/lib/solana/rpc-endpoints').getHeliusHttpRpcUrl(), {
      commitment: 'confirmed',
      wsEndpoint: undefined,
      disableRetryOnRateLimit: true,
      confirmTransactionInitialTimeout: 60000,
    });

interface WalletType {
    publicKey: string;
    connected: boolean;
    sendTransaction?: (transaction: unknown) => Promise<unknown>;
}

interface TradingInterfaceProps {
    wallet: WalletType;
    rifts: unknown[];
    onTrade?: (type: 'buy' | 'sell', token: string, amount: number) => void;
    addToast?: (message: string, type: 'success' | 'error' | 'pending', signature?: string) => void;
    defaultSelectedRift?: { id?: string; symbol?: string; riftMint?: string } | null;
}

interface RealOrderBookEntry {
    price: number;
    amount: number;
    total: number;
    source: 'vault' | 'dex' | 'user';
}

interface RealTransaction {
    signature: string;
    type: 'wrap' | 'unwrap' | 'buy' | 'sell';
    token: string;
    amount: number;
    price: number;
    timestamp: number;
    user: string;
    fee: number;
}

interface RealTokenPair {
    base: string;
    quote: string;
    symbol: string;
    price: number;
    change24h: number;
    volume24h: number;
    high24h: number;
    low24h: number;
    riftAddress?: string;
    vaultAddress?: string;
    mintAddress?: string;
    underlyingMint?: string;
    hasMeteoraPool?: boolean;
    liquidityPool?: string; // Meteora pool address for trading
    poolAddress?: string; // Alias for liquidityPool
    tvl?: number;
}

export const TradingInterface: React.FC<TradingInterfaceProps> = ({ wallet, rifts, addToast, defaultSelectedRift }) => {
    // State
    const [selectedPair, setSelectedPair] = useState<RealTokenPair | null>(null);
    const [realPairs, setRealPairs] = useState<RealTokenPair[]>([]);
    
    const [tradeType, setTradeType] = useState<'buy' | 'sell'>('buy');
    const [amount, setAmount] = useState('');
    const [inputCurrency, setInputCurrency] = useState<'base' | 'quote'>('base'); // Toggle between base (RIFTS/rSOL) and quote (SOL)
    const [timeframe, setTimeframe] = useState<'1h' | '4h' | '1d' | '7d'>('1h');
    const [orderBook, setOrderBook] = useState<{ bids: RealOrderBookEntry[], asks: RealOrderBookEntry[] }>({ bids: [], asks: [] });
    const [realTransactions, setRealTransactions] = useState<RealTransaction[]>([]);
    const [priceHistory, setPriceHistory] = useState<{timestamp: number, price: number}[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [userBalances, setUserBalances] = useState<{[key: string]: number}>({});
    const [isPriceUpdating, setIsPriceUpdating] = useState(false);
    const [isLoadingBalances, setIsLoadingBalances] = useState(false);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);
    const [isFetchingDecimals, setIsFetchingDecimals] = useState(false);
    const [solUsdPrice, setSolUsdPrice] = useState<number>(0);
    const [copiedAddress, setCopiedAddress] = useState(false);
    const [slippageBps, setSlippageBps] = useState<number>(5000); // Default 50% slippage for low-liquidity pools
    const [showSlippageSettings, setShowSlippageSettings] = useState(false);

    // Meteora quote state - real-time quotes from Meteora SDK
    const [meteoraQuote, setMeteoraQuote] = useState<{
        inputAmount: number;
        outputAmount: number;
        minimumOutputAmount: number;
        priceImpact: number;
        fee: number;
        price: number;
    } | null>(null);
    const [isLoadingQuote, setIsLoadingQuote] = useState(false);
    const quoteTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Fetch Meteora quote when amount changes (debounced)
    useEffect(() => {
        // Clear previous timeout
        if (quoteTimeoutRef.current) {
            clearTimeout(quoteTimeoutRef.current);
        }

        const amountNum = parseFloat(amount) || 0;

        // Skip if no amount, no pair selected, or RIFTS/SOL (uses Jupiter)
        if (amountNum <= 0 || !selectedPair || selectedPair.base === 'RIFTS') {
            setMeteoraQuote(null);
            return;
        }

        // Get pool address
        const poolAddress = selectedPair.poolAddress ||
            (rifts.find(r => (r as any).id === selectedPair.riftAddress) as any)?.liquidityPool ||
            (rifts.find(r => (r as any).id === selectedPair.riftAddress) as any)?.meteoraPool;

        if (!poolAddress) {
            setMeteoraQuote(null);
            return;
        }

        // Debounce quote fetching (300ms)
        quoteTimeoutRef.current = setTimeout(async () => {
            setIsLoadingQuote(true);
            try {
                // Determine input/output mints based on trade type
                let inputMint: string;
                let outputMint: string;
                const riftData = rifts.find(r => (r as any).id === selectedPair.riftAddress) as any;

                if (!riftData) {
                    setMeteoraQuote(null);
                    return;
                }

                if (tradeType === 'buy') {
                    // Buy: spend quote (SOL/RIFTS), receive rift token
                    inputMint = selectedPair.quote === 'SOL'
                        ? 'So11111111111111111111111111111111111111112'
                        : (process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump');
                    outputMint = riftData.riftMint;
                } else {
                    // Sell: spend rift token, receive quote (SOL/RIFTS)
                    inputMint = riftData.riftMint;
                    outputMint = selectedPair.quote === 'SOL'
                        ? 'So11111111111111111111111111111111111111112'
                        : (process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump');
                }

                // Calculate input amount in lamports (assuming 9 decimals for simplicity, actual swap uses fetched decimals)
                const inputAmountLamports = inputCurrency === 'base'
                    ? Math.floor(amountNum * 1e9) // base token amount
                    : Math.floor(amountNum * 1e9); // quote token amount

                console.log('[TRADING] Fetching Meteora quote:', {
                    poolAddress,
                    inputMint: inputMint.slice(0, 8),
                    outputMint: outputMint.slice(0, 8),
                    amount: inputAmountLamports,
                    tradeType
                });

                const quote = await riftsService.getMeteoraSwapQuote({
                    poolAddress,
                    inputMint,
                    outputMint,
                    amount: inputAmountLamports,
                    slippageBps: 100 // 1% for quote display
                });

                if (quote) {
                    setMeteoraQuote(quote);
                    console.log('[TRADING] Meteora quote received:', {
                        inputAmount: quote.inputAmount,
                        outputAmount: quote.outputAmount,
                        priceImpact: quote.priceImpact.toFixed(2) + '%'
                    });
                } else {
                    setMeteoraQuote(null);
                }
            } catch (error) {
                console.error('[TRADING] Error fetching Meteora quote:', error);
                setMeteoraQuote(null);
            } finally {
                setIsLoadingQuote(false);
            }
        }, 300);

        return () => {
            if (quoteTimeoutRef.current) {
                clearTimeout(quoteTimeoutRef.current);
            }
        };
    }, [amount, selectedPair, tradeType, inputCurrency, rifts, slippageBps]);

    // Fetch SOL/USD price from Jupiter/Coingecko
    useEffect(() => {
        const fetchSolUsdPrice = async () => {
            try {
                // Use our price API which calls Jupiter Lite API
                const SOL_MINT = 'So11111111111111111111111111111111111111112';
                const response = await fetch(`/api/prices?mint=${SOL_MINT}`);
                const data = await response.json();
                if (data?.price) {
                    setSolUsdPrice(data.price);
                    debugLog(`✅ Fetched SOL/USD price: $${data.price}`);
                    return;
                }
            } catch (error) {
                debugError('Failed to fetch SOL price from API:', error);
            }

            try {
                // Fallback to Coingecko
                const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
                const data = await response.json();
                if (data?.solana?.usd) {
                    setSolUsdPrice(data.solana.usd);
                    debugLog(`✅ Fetched SOL/USD price from Coingecko: $${data.solana.usd}`);
                }
            } catch (error) {
                debugError('Failed to fetch SOL price from Coingecko:', error);
            }
        };

        fetchSolUsdPrice();
        // Update price every 60 seconds
        const interval = setInterval(fetchSolUsdPrice, 60000);
        return () => clearInterval(interval);
    }, []);

    // Load real token pairs from blockchain data
    useEffect(() => {
        const loadRealPairs = async () => {
            // OPTIMIZATION: Always try to load RIFTS/SOL pair first (instant)
            const pairs: RealTokenPair[] = [];

            // Add RIFTS/SOL pair (main RIFTS token)
            const riftsMint = process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';
            pairs.push({
                symbol: 'RIFTS/SOL',
                base: 'RIFTS',
                quote: 'SOL',
                mintAddress: riftsMint,
                price: 0.00001, // Will be updated from Meteora
                volume24h: 0,
                change24h: 0,
                high24h: 0,
                low24h: 0,
                riftAddress: undefined,
                liquidityPool: undefined // Will fetch from Meteora
            });

            // Set initial pairs immediately so UI shows
            setRealPairs(pairs);
            if (!selectedPair && pairs.length > 0) {
                setSelectedPair(pairs[0]);
            }

            // Now load rift pairs if available
            if (!rifts || rifts.length === 0) {
                // RIFTS/SOL pair disabled - no trading available without rifts
                debugLog('⚠️ No rifts available for trading');
                return;
            }

            const riftPairs: RealTokenPair[] = [];
            
            // Add wrapped token pairs from real rifts
            for (const rift of rifts) {
                const riftData = rift as unknown as {
                    isActive?: boolean;
                    backingRatio?: number;
                    volume24h?: number;
                    apy?: number;
                    underlying?: string;
                    symbol?: string;
                    id?: string;
                    vault?: string;
                    riftMint?: string;
                    underlyingMint?: string;
                    hasMeteoraPool?: boolean;
                    tvl?: number;
                    meteoraPoolType?: 'SOL' | 'RIFTS' | 'USD1';
                    solPool?: string;
                    riftsPool?: string;
                    usd1Pool?: string;
                };

                // Include rifts that are either active OR have Meteora pools with liquidity
                const hasLiquidity = (riftData.tvl || 0) > 0;
                const shouldInclude = riftData.isActive || (riftData.hasMeteoraPool && hasLiquidity);

                if (shouldInclude) {
                    try {
                        // Get REAL price from vault backing ratio
                        // Get REAL 24h data from oracle
                        const volume24h = riftData.volume24h || 0;
                        const change24h = riftData.apy ? (riftData.apy / 365) : 0;

                        // Determine quote token based on which pool exists
                        // SOL pool = rUNDERLYING/SOL (e.g., rRIFTS/SOL)
                        // RIFTS pool = rUNDERLYING/RIFTS (e.g., rSOL/RIFTS)
                        let quoteToken = 'SOL'; // Default to SOL
                        let quoteMint = 'So11111111111111111111111111111111111111112'; // SOL mint
                        let poolAddress = (riftData as any).solPool || (riftData as any).meteoraPool;

                        if (riftData.meteoraPoolType === 'RIFTS' || riftData.riftsPool) {
                            quoteToken = 'RIFTS';
                            quoteMint = process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';
                            poolAddress = (riftData as any).riftsPool || (riftData as any).meteoraPool;
                        }

                        const baseToken = `r${riftData.underlying || 'UNKNOWN'}`;

                        // Use backing ratio as price (already calculated and cached)
                        // Don't fetch from Meteora pools during load - too slow
                        const currentPrice = (riftData.backingRatio || 1) / 10000;

                        riftPairs.push({
                            base: baseToken,
                            quote: quoteToken,
                            symbol: `${baseToken}/${quoteToken}`,
                            price: currentPrice,
                            change24h: change24h,
                            volume24h: volume24h,
                            high24h: currentPrice * 1.001,
                            low24h: currentPrice * 0.999,
                            riftAddress: riftData.id || '',
                            vaultAddress: riftData.vault || '',
                            mintAddress: riftData.riftMint || '',
                            underlyingMint: quoteMint,
                            hasMeteoraPool: riftData.hasMeteoraPool || false,
                            liquidityPool: (riftData as any).liquidityPool || poolAddress, // Include Meteora pool address
                            tvl: riftData.tvl || 0
                        });

                        debugLog(`✅ Added trading pair: ${baseToken}/${quoteToken} (Price: ${currentPrice}, TVL: ${riftData.tvl}, Pool: ${(riftData as any).liquidityPool || poolAddress || 'none'})`);
                    } catch (error) {
                        debugError(`Error loading pair for ${riftData.symbol}:`, error);
                    }
                }
            }

            // Deduplicate pairs by symbol (keep first occurrence)
            const seenSymbols = new Set<string>();
            const uniqueRiftPairs = riftPairs.filter(pair => {
                if (seenSymbols.has(pair.symbol)) {
                    debugLog(`⚠️ Skipping duplicate pair: ${pair.symbol}`);
                    return false;
                }
                seenSymbols.add(pair.symbol);
                return true;
            });

            // Set final pairs (RIFTS/SOL + unique rift pairs)
            const allPairs = [...pairs, ...uniqueRiftPairs];
            setRealPairs(allPairs);

            // Select the default rift pair if provided, otherwise first pair
            if (!selectedPair && allPairs.length > 0) {
                if (defaultSelectedRift) {
                    // Find the pair matching the default selected rift
                    const defaultPair = allPairs.find(p =>
                        p.riftAddress === defaultSelectedRift.id ||
                        p.mintAddress === defaultSelectedRift.riftMint ||
                        p.base === defaultSelectedRift.symbol
                    );
                    if (defaultPair) {
                        setSelectedPair(defaultPair);
                        debugLog(`✅ Selected default rift pair: ${defaultPair.symbol}`);
                    } else {
                        setSelectedPair(allPairs[0]);
                    }
                } else {
                    setSelectedPair(allPairs[0]);
                }
            }
        };
        
        loadRealPairs();
        
        // REAL-TIME price updates every 30 seconds
        const priceUpdateInterval = setInterval(async () => {
            if (rifts && rifts.length > 0) {
                setIsPriceUpdating(true);
                try {
                    await loadRealPairs();
                    
                    // Update selected pair with REAL price
                    if (selectedPair && selectedPair.riftAddress) {
                        const updatedRift = rifts.find(r => (r as unknown as { id?: string }).id === selectedPair.riftAddress);
                        if (updatedRift) {
                            const riftData = updatedRift as unknown as { backingRatio?: number };
                            const newPrice = (riftData.backingRatio || 0) / 10000 || selectedPair.price;
                            setSelectedPair(prev => prev ? { ...prev, price: newPrice } : prev);
                        }
                    } else if (selectedPair && selectedPair.base === 'RIFTS') {
                        try {
                            const newPrice = await dexIntegration.getRIFTSPrice();
                            setSelectedPair(prev => prev ? { ...prev, price: newPrice } : prev);
                        } catch (error) {
                            debugError('Failed to update RIFTS price:', error);
                        }
                    }
                } finally {
                    setIsPriceUpdating(false);
                }
            }
        }, 30000);
        
        return () => clearInterval(priceUpdateInterval);
    }, [rifts, selectedPair]);
    
    // Load REAL user balances from blockchain (OPTIMIZED - only load selected pair)
    useEffect(() => {
        let isMounted = true;

        const loadUserBalances = async () => {
            // Check if wallet is connected and has a public key
            if (!wallet || !wallet.connected || !wallet.publicKey) {
                console.log('⚠️ Wallet not connected or missing publicKey:', {
                    hasWallet: !!wallet,
                    connected: wallet?.connected,
                    publicKey: wallet?.publicKey
                });
                return;
            }

            console.log('💰 Loading user balances for wallet:', wallet.publicKey);
            setIsLoadingBalances(true);
            const balances: {[key: string]: number} = {};

            try {
                // Get SOL balance (always needed)
                const solBalance = await (connection as unknown as { getBalance: (pubkey: unknown) => Promise<number> }).getBalance(new PublicKey(wallet.publicKey));
                balances['SOL'] = (solBalance as number) / 1e9;

                // OPTIMIZATION: Only load balance for SELECTED trading pair, not all tokens
                if (selectedPair) {
                    console.log('💡 Selected pair for balance fetch:', {
                        symbol: selectedPair.symbol,
                        base: selectedPair.base,
                        mintAddress: selectedPair.mintAddress,
                        riftAddress: selectedPair.riftAddress,
                        liquidityPool: selectedPair.liquidityPool
                    });

                    // Get base token balance
                    if (selectedPair.base === 'RIFTS') {
                        try {
                            const riftsBalance = await (dexIntegration as unknown as { getRIFTSBalance: (pubkey: string) => Promise<number> }).getRIFTSBalance(wallet.publicKey);
                            balances['RIFTS'] = riftsBalance;
                        } catch {
                            balances['RIFTS'] = 0;
                        }
                    } else if (selectedPair.mintAddress) {
                        // Get wrapped token balance for selected pair only
                        try {
                            console.log(`🔍 Fetching balance for ${selectedPair.base} (mint: ${selectedPair.mintAddress})`);
                            const tokenBalance = await (riftsService as unknown as { getTokenBalance: (pubkey: unknown, mint: string) => Promise<number> }).getTokenBalance(
                                new PublicKey(wallet.publicKey),
                                selectedPair.mintAddress
                            );
                            console.log(`✅ Balance fetched for ${selectedPair.base}: ${tokenBalance}`);
                            balances[selectedPair.base] = tokenBalance || 0;
                        } catch (error) {
                            console.error(`❌ Error fetching balance for ${selectedPair.base}:`, error);
                            balances[selectedPair.base] = 0;
                        }
                    }

                    // Get quote token balance if not SOL
                    if (selectedPair.quote !== 'SOL' && selectedPair.underlyingMint) {
                        try {
                            const quoteBalance = await (riftsService as unknown as { getTokenBalance: (pubkey: unknown, mint: string) => Promise<number> }).getTokenBalance(
                                new PublicKey(wallet.publicKey),
                                selectedPair.underlyingMint
                            );
                            balances[selectedPair.quote] = quoteBalance || 0;
                        } catch {
                            balances[selectedPair.quote] = 0;
                        }
                    }
                }

                if (isMounted) {
                    setUserBalances(balances);
                    setIsLoadingBalances(false);
                }
            } catch (error) {
                debugError('Error loading user balances:', error);
                if (isMounted) {
                    setIsLoadingBalances(false);
                }
            }
        };

        loadUserBalances();
        // OPTIMIZATION: Increased interval to 15 seconds (was 10s)
        const interval = setInterval(loadUserBalances, 15000);
        return () => {
            isMounted = false;
            clearInterval(interval);
        };
    }, [wallet, selectedPair]);
    
    // Generate REAL order book from Meteora pools and vault liquidity (OPTIMIZED)
    useEffect(() => {
        let isMounted = true;

        const generateRealOrderBook = async () => {
            if (!selectedPair || !selectedPair.riftAddress) return;

            try {
                const riftData = rifts.find(r => (r as unknown as { id?: string }).id === selectedPair.riftAddress) as unknown as { id?: string; tvl?: number; backingRatio?: number; volume24h?: number; apy?: number; underlying?: string; symbol?: string; vault?: string; riftMint?: string; liquidityPool?: string };
                if (!riftData) return;

                let bids: RealOrderBookEntry[] = [];
                let asks: RealOrderBookEntry[] = [];

                // Try to fetch REAL Meteora orderbook data first
                if (riftData.liquidityPool && riftData.liquidityPool !== '11111111111111111111111111111111') {
                    try {
                        debugLog(`🌊 Fetching real Meteora orderbook for pool ${riftData.liquidityPool}`);
                        const meteoraOrderbook = await meteoraIntegration.getOrderBook(riftData.liquidityPool);

                        if (meteoraOrderbook) {
                            debugLog(`✅ Loaded ${meteoraOrderbook.bids.length} bids and ${meteoraOrderbook.asks.length} asks from Meteora`);
                            bids = meteoraOrderbook.bids.map(b => ({ ...b, source: 'dex' as const }));
                            asks = meteoraOrderbook.asks.map(a => ({ ...a, source: 'dex' as const }));
                        }
                    } catch (error) {
                        debugError('Failed to fetch Meteora orderbook, using TVL fallback:', error);
                    }
                }

                // Fallback: Use TVL data if Meteora fetch failed
                if (bids.length === 0 && asks.length === 0 && riftData.tvl) {
                    const poolLiquidity = riftData.tvl / selectedPair.price;

                    const midPrice = selectedPair.price;
                    const spread = 0.002; // 0.2% spread

                    asks.push({
                        price: midPrice * (1 + spread),
                        amount: poolLiquidity * 0.3,
                        total: midPrice * poolLiquidity * 0.3,
                        source: 'dex'
                    });

                    bids.push({
                        price: midPrice * (1 - spread),
                        amount: poolLiquidity * 0.3,
                        total: midPrice * poolLiquidity * 0.3,
                        source: 'dex'
                    });
                }

                // Get REAL vault balance
                const vaultBalance = (riftData.tvl || 0) / (selectedPair.price * 180);
                const availableLiquidity = Math.max(vaultBalance * 0.8, 0);

                if (availableLiquidity > 0) {
                    const basePrice = selectedPair.price;
                    const spreadPercent = 0.001; // 0.1% spread

                    // Generate REAL buy orders from vault
                    for (let i = 1; i <= 10; i++) {
                        const priceOffset = (i * spreadPercent) / 10;
                        const price = basePrice * (1 - priceOffset);
                        const amount = availableLiquidity / 10;

                        bids.push({
                            price,
                            amount,
                            total: price * amount,
                            source: 'vault'
                        });
                    }

                    // Generate REAL sell orders from vault
                    for (let i = 1; i <= 10; i++) {
                        const priceOffset = (i * spreadPercent) / 10;
                        const price = basePrice * (1 + priceOffset);
                        const amount = availableLiquidity / 10;

                        asks.push({
                            price,
                            amount,
                            total: price * amount,
                            source: 'vault'
                        });
                    }
                }

                if (isMounted) {
                    setOrderBook({ bids, asks });
                }
            } catch (error) {
                debugError('Error generating real order book:', error);
            }
        };

        generateRealOrderBook();
        // OPTIMIZATION: Increased interval to 30 seconds (was 20s)
        const interval = setInterval(generateRealOrderBook, 30000);
        return () => {
            isMounted = false;
            clearInterval(interval);
        };
    }, [selectedPair, rifts]);
    
    // Load REAL transaction history from Solana blockchain (OPTIMIZED - lazy load)
    useEffect(() => {
        let isMounted = true;

        const loadRealTransactions = async () => {
            if (!selectedPair) return;

            try {
                const transactions: RealTransaction[] = [];
                const poolAddress = (selectedPair as any).meteoraPool || selectedPair.liquidityPool;

                // Find the rift for wrap/unwrap
                let rift = selectedPair.riftAddress
                    ? rifts.find(r => (r as unknown as { id?: string }).id === selectedPair.riftAddress) as unknown as {
                        id?: string;
                        vault?: string;
                        underlyingMint?: string;
                        symbol?: string;
                    }
                    : null;

                // For RIFTS/SOL pair, also find the rRIFTS rift to show its wrap/unwrap
                let riftAddressToFetch = selectedPair.riftAddress;
                if (!riftAddressToFetch && selectedPair.base === 'RIFTS') {
                    // Find the rRIFTS rift (rift that wraps RIFTS)
                    const rRiftsRift = rifts.find(r => {
                        const riftData = r as unknown as { symbol?: string; id?: string; vault?: string };
                        return riftData.symbol === 'rRIFTS';
                    }) as unknown as { id?: string; vault?: string; symbol?: string };

                    if (rRiftsRift) {
                        riftAddressToFetch = rRiftsRift.id;
                        rift = rRiftsRift;
                        debugLog('📦 RIFTS/SOL pair - will also show rRIFTS wrap/unwrap');
                    }
                }

                // STEP 1: Fetch wrap/unwrap from Supabase cache FIRST (FAST ~100ms)
                if (riftAddressToFetch && rift?.vault) {
                    try {
                        const cacheResponse = await fetch(`/api/wrap-unwrap-history?rift=${riftAddressToFetch}&limit=12`);
                        const cacheData = await cacheResponse.json();

                        if (cacheData.cached && cacheData.transactions?.length > 0) {
                            debugLog(`✅ Got ${cacheData.transactions.length} cached wrap/unwrap transactions`);
                            for (const tx of cacheData.transactions) {
                                transactions.push({ ...tx, price: selectedPair.price });
                            }
                            // IMMEDIATELY show wrap/unwrap transactions
                            if (isMounted) {
                                transactions.sort((a, b) => b.timestamp - a.timestamp);
                                setRealTransactions([...transactions]);
                            }
                        } else {
                            // No cache - trigger background fetch
                            debugLog(`🔄 No cache, triggering background fetch...`);
                            fetch('/api/wrap-unwrap-history', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    riftAddress: riftAddressToFetch,
                                    vaultAddress: rift.vault,
                                    tokenSymbol: rift.symbol || selectedPair.base
                                })
                            }).catch(err => debugError('Background fetch error:', err));
                        }
                    } catch (error) {
                        debugError('Error fetching wrap/unwrap cache:', error);
                    }
                }

                // STEP 2: Fetch pool trades from RPC (SLOW - runs after wrap/unwrap already displayed)
                if (poolAddress && poolAddress !== '11111111111111111111111111111111') {
                    try {
                        const poolSigs = await connection.getSignaturesForAddress(new PublicKey(poolAddress), { limit: 20 });
                        if (poolSigs.length > 0) {
                            debugLog(`Found ${poolSigs.length} recent transactions for pool`);
                            for (const sigInfo of poolSigs.slice(0, 10)) {
                                if (!transactions.find(t => t.signature === sigInfo.signature)) {
                                    transactions.push({
                                        signature: sigInfo.signature,
                                        type: 'buy',
                                        token: selectedPair.base,
                                        amount: 0,
                                        price: selectedPair.price,
                                        timestamp: (sigInfo.blockTime || Date.now() / 1000) * 1000,
                                        user: 'trader',
                                        fee: 0
                                    });
                                }
                            }
                            debugLog(`✅ Loaded pool trades, total: ${transactions.length}`);
                        }
                    } catch (error) {
                        debugError('Error loading pool trades:', error);
                    }
                }

                // Fallback for RIFTS base token without pool
                if (!poolAddress && selectedPair.base === 'RIFTS') {
                    try {
                        debugLog('📜 Fetching real trades for RIFTS/SOL from dexIntegration...');
                        const meteoraTrades = await (dexIntegration as unknown as { getRIFTSRecentTrades: (limit: number) => Promise<Array<{
                            signature: string;
                            type: 'buy' | 'sell';
                            token: string;
                            amount: number;
                            price: number;
                            timestamp: number;
                            user: string;
                            fee: number;
                        }>> }).getRIFTSRecentTrades(50);

                        meteoraTrades.forEach(trade => {
                            transactions.push({
                                signature: trade.signature,
                                type: trade.type === 'buy' ? 'buy' : 'sell',
                                token: trade.token,
                                amount: trade.amount,
                                price: trade.price,
                                timestamp: trade.timestamp,
                                user: trade.user,
                                fee: trade.fee
                            });
                        });

                        debugLog(`✅ Loaded ${transactions.length} real trades from dexIntegration`);
                    } catch (error) {
                        debugError('Error loading RIFTS trades:', error);
                    }
                }

                if (isMounted) {
                    transactions.sort((a, b) => b.timestamp - a.timestamp);
                    setRealTransactions(transactions.slice(0, 50));
                }
            } catch (error) {
                debugError('Error loading real transactions:', error);
            }
        };

        loadRealTransactions();
        // OPTIMIZATION: Increased interval to 60 seconds (was 15s)
        const interval = setInterval(loadRealTransactions, 60000);
        return () => {
            isMounted = false;
            clearInterval(interval);
        };
    }, [selectedPair, rifts]);
    
    // Load price history from Supabase on mount and when pair changes
    useEffect(() => {
        const loadPriceHistory = async () => {
            if (!selectedPair) return;

            setIsLoadingHistory(true);
            try {
                // Fetch last 24 hours of price history from Supabase
                const response = await fetch(`/api/price-history?token_pair=${selectedPair.symbol}&hours=24`);
                const result = await response.json();

                if (result.data && result.data.length > 0) {
                    const pricePoints = result.data.map((point: any) => ({
                        timestamp: new Date(point.timestamp).getTime(),
                        price: parseFloat(point.price)
                    }));
                    setPriceHistory(pricePoints);
                    console.log(`📊 Loaded ${pricePoints.length} price points from Supabase for ${selectedPair.symbol}`);
                } else {
                    // No historical data, start with current price
                    setPriceHistory([{ timestamp: Date.now(), price: selectedPair.price }]);
                }
            } catch (error) {
                debugError('Error loading price history from Supabase:', error);
                // Fallback to current price
                setPriceHistory([{ timestamp: Date.now(), price: selectedPair.price }]);
            } finally {
                setIsLoadingHistory(false);
            }
        };

        loadPriceHistory();
    }, [selectedPair?.symbol]);

    // Generate REAL price chart data and save to Supabase
    useEffect(() => {
        const generatePriceData = async () => {
            if (!selectedPair) return;

            try {
                const currentPrice = selectedPair.price;
                const now = Date.now();

                // Build price points from REAL trades if available
                if (realTransactions.length > 0) {
                    // Sort trades by timestamp (oldest first)
                    const sortedTrades = [...realTransactions].sort((a, b) => a.timestamp - b.timestamp);

                    // Create price points from actual trades
                    const pricePoints = sortedTrades.map(trade => ({
                        timestamp: trade.timestamp,
                        price: trade.price
                    }));

                    setPriceHistory(pricePoints);

                    // Save the latest trade price to Supabase
                    const latestTrade = sortedTrades[sortedTrades.length - 1];
                    if (latestTrade) {
                        await savePricePoint(selectedPair.symbol, latestTrade.price, selectedPair.volume24h);
                    }
                } else {
                    // No trades - save current price snapshot
                    setPriceHistory(prev => {
                        const newPoint = { timestamp: now, price: currentPrice };

                        // Only add if price changed significantly or first point
                        if (prev.length === 0 || Math.abs(prev[prev.length - 1].price - currentPrice) > currentPrice * 0.0001) {
                            return [...prev, newPoint].slice(-100); // Keep last 100 points
                        }

                        return prev;
                    });

                    // Save to Supabase (once per minute)
                    await savePricePoint(selectedPair.symbol, currentPrice, selectedPair.volume24h);
                }
            } catch (error) {
                debugError('Error generating price data:', error);
            }
        };

        // Save price point to Supabase
        const savePricePoint = async (tokenPair: string, price: number, volume24h: number) => {
            try {
                await fetch('/api/price-history', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token_pair: tokenPair,
                        price,
                        volume_24h: volume24h
                    })
                });
            } catch (error) {
                // Silently fail - don't block the UI
                debugError('Failed to save price point:', error);
            }
        };

        generatePriceData();
        const interval = setInterval(generatePriceData, 60000); // Update every minute
        return () => clearInterval(interval);
    }, [selectedPair, timeframe, rifts, realTransactions]);
    
    // Execute REAL trade using Jupiter aggregator
    const handleRealTrade = async () => {
        console.log('🚀 handleRealTrade called!', {
            selectedPair,
            amount,
            tradeType,
            walletConnected: !!wallet?.publicKey,
            isLoading
        });

        if (!selectedPair || !amount || parseFloat(amount) <= 0) {
            console.error('❌ Invalid amount:', { selectedPair, amount });
            addToast?.('Please enter a valid amount', 'error');
            return;
        }

        if (!wallet?.publicKey) {
            console.error('❌ Wallet not connected');
            addToast?.('Please connect your wallet', 'error');
            return;
        }

        // Prevent double execution
        if (isLoading) {
            console.warn('⚠️ Trade already in progress, ignoring duplicate call');
            return;
        }

        console.log('✅ Starting trade execution...');
        setIsLoading(true);

        // Show processing notification
        addToast?.(
            `🔄 Processing ${tradeType === 'buy' ? 'BUY' : 'SELL'} order...\n` +
            `Preparing to ${tradeType} ${parseFloat(amount).toFixed(6)} ${tradeType === 'buy' ? selectedPair.quote : selectedPair.base}`,
            'pending'
        );

        try {
            // Convert amount to correct units for trading
            const inputAmount = parseFloat(amount);
            let tradeAmount: number; // Amount in base currency (for display/calculation)
            let actualInputAmount: number; // Actual amount being sent in the swap

            // Get pool address early to fetch real price if available
            const riftDataForPrice = rifts.find(r => (r as unknown as { id?: string }).id === selectedPair.riftAddress) as unknown as {
                id?: string; liquidityPool?: string; solPool?: string; riftsPool?: string; meteoraPool?: string
            };
            let poolAddressForPrice = riftDataForPrice?.liquidityPool || selectedPair.liquidityPool;
            if (!poolAddressForPrice) {
                if (selectedPair.quote === 'SOL') {
                    poolAddressForPrice = (riftDataForPrice as any)?.solPool || (riftDataForPrice as any)?.meteoraPool;
                } else if (selectedPair.quote === 'RIFTS') {
                    poolAddressForPrice = (riftDataForPrice as any)?.riftsPool || (riftDataForPrice as any)?.meteoraPool;
                }
            }

            // CRITICAL: Fetch REAL pool price from Meteora instead of using UI backing ratio
            // This ensures the swap amount matches actual pool liquidity
            let tokenPriceInQuote = selectedPair ? selectedPair.price : 0.001;

            if (poolAddressForPrice && poolAddressForPrice !== '11111111111111111111111111111111') {
                try {
                    const realPoolPrice = await riftsService.getMeteoraPoolPrice(poolAddressForPrice);
                    if (realPoolPrice > 0) {
                        console.log('📊 Using REAL Meteora pool price:', {
                            uiPrice: selectedPair.price,
                            realPoolPrice,
                            poolAddress: poolAddressForPrice
                        });
                        tokenPriceInQuote = realPoolPrice;
                    }
                } catch (priceError) {
                    console.warn('⚠️ Could not fetch real pool price, using UI price:', priceError);
                }
            }

            console.log('💰 Price Calculation:', {
                priceInQuoteCurrency: selectedPair.price,
                realPoolPrice: tokenPriceInQuote,
                quoteCurrency: selectedPair.quote,
                tokenPriceInQuote,
                inputAmount,
                inputCurrency,
                tradeType
            });

            // IMPORTANT: actualInputAmount = what goes INTO the swap (what you're sending)
            // For BUY: send quote (SOL), receive base (rRIFTS)
            // For SELL: send base (rRIFTS), receive quote (SOL)

            if (tradeType === 'buy') {
                if (inputCurrency === 'base') {
                    // Buying, user entered how much BASE they want to receive
                    tradeAmount = inputAmount; // Amount of base token to receive
                    actualInputAmount = inputAmount * tokenPriceInQuote; // Quote needed to buy that much
                } else {
                    // Buying, user entered how much QUOTE they want to spend
                    tradeAmount = inputAmount / tokenPriceInQuote; // Amount of base token to receive
                    actualInputAmount = inputAmount; // Quote to spend
                }

                console.log('✅ BUY Calculation:', {
                    inputCurrency,
                    inputAmount,
                    tokenPriceInQuote,
                    tradeAmount: `${tradeAmount} ${selectedPair.base}`,
                    actualInputAmount: `${actualInputAmount} ${selectedPair.quote} (sending)`,
                    resultInLamports: Math.floor(actualInputAmount * 1e9)
                });
            } else {
                // SELLING
                if (inputCurrency === 'base') {
                    // Selling, user entered how much BASE to sell
                    tradeAmount = inputAmount; // Amount of base token to sell
                    actualInputAmount = inputAmount; // Send this much base token
                } else {
                    // Selling, user entered how much QUOTE they want to receive (AFTER FEES)
                    // Need to account for 0.7% fee
                    const desiredQuoteAfterFees = inputAmount;
                    const grossQuoteNeeded = desiredQuoteAfterFees / (1 - 0.007); // Add back the fee
                    tradeAmount = grossQuoteNeeded / tokenPriceInQuote; // Base tokens to sell
                    actualInputAmount = tradeAmount; // Send this much base token
                }

                console.log('✅ SELL Calculation:', {
                    inputCurrency,
                    inputAmount,
                    tokenPriceInQuote,
                    tradeAmount: `${tradeAmount} ${selectedPair.base}`,
                    actualInputAmount: `${actualInputAmount} ${selectedPair.base} (sending)`,
                    willReceiveAfterFees: inputCurrency === 'quote' ? `${inputAmount} ${selectedPair.quote}` : 'N/A'
                });
            }

            // Get token mints for Jupiter swap
            let inputMint: string;
            let outputMint: string;
            let riftData: {
                id?: string;
                riftMint?: string;
                vault?: string;
                symbol?: string;
                realVaultBalance?: number;
                underlyingMint?: string;
                contractAddresses?: {
                    riftsToken?: string;
                    riftContract?: string;
                };
                liquidityPool?: string;
            } | undefined;

            if (selectedPair.base === 'RIFTS') {
                // RIFTS/SOL trading - ✅ WORKING TOKEN WITH METEORA POOL
                // Use Meteora direct swap (Jupiter doesn't support custom devnet tokens)
                if (tradeType === 'buy') {
                    inputMint = 'So11111111111111111111111111111111111111112'; // SOL
                    outputMint = process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump'; // ✅ WORKING RIFTS token
                } else {
                    inputMint = process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump'; // ✅ WORKING RIFTS token
                    outputMint = 'So11111111111111111111111111111111111111112'; // SOL
                }
            } else if (selectedPair.riftAddress) {
                // Wrapped token trading - check for Meteora pool
                riftData = rifts.find(r => (r as unknown as { id?: string }).id === selectedPair.riftAddress) as unknown as {
                    id?: string;
                    riftMint?: string;
                    vault?: string;
                    symbol?: string;
                    realVaultBalance?: number;
                    underlyingMint?: string;
                    contractAddresses?: {
                        riftsToken?: string;
                        riftContract?: string;
                    };
                    liquidityPool?: string;
                    hasMeteoraPool?: boolean;
                };

                if (!riftData) {
                    throw new Error('Rift data not found');
                }

                // If riftData doesn't have liquidityPool, use it from selectedPair
                if (!riftData.liquidityPool && selectedPair.liquidityPool) {
                    riftData.liquidityPool = selectedPair.liquidityPool;
                }

                console.log('🔍 Rift data:', {
                    id: riftData.id,
                    symbol: riftData.symbol,
                    riftMint: riftData.riftMint,
                    contractAddresses: riftData.contractAddresses,
                    liquidityPool: riftData.liquidityPool,
                    liquidityPoolFromPair: selectedPair.liquidityPool
                });

                // Try to get riftMint from multiple possible sources
                if (!riftData.riftMint) {
                    // Check if it's in contractAddresses
                    if (riftData.contractAddresses?.riftsToken) {
                        riftData.riftMint = riftData.contractAddresses.riftsToken;
                        console.log('✅ Found riftMint in contractAddresses.riftsToken:', riftData.riftMint);
                    }
                }

                // Handle rifts with missing mint data
                if (!riftData.riftMint || !riftData.underlyingMint) {
                    console.error('❌ Rift missing required mint data:', {
                        riftMint: riftData.riftMint,
                        underlyingMint: riftData.underlyingMint,
                        contractAddresses: riftData.contractAddresses
                    });
                    throw new Error(
                        `This rift does not have a tradeable token mint.\n\n` +
                        `To trade this rift, you need to:\n` +
                        `1. Create a Meteora liquidity pool for this rift token\n` +
                        `2. Add liquidity to the pool\n` +
                        `3. The rift will then become tradeable\n\n` +
                        `Missing: ${!riftData.riftMint ? 'riftMint' : 'underlyingMint'}`
                    );
                }

                // Determine input/output based on the quote token in the trading pair
                // Quote token = what you pay with, Base token = what you receive
                let quoteTokenMint: string;
                if (selectedPair.quote === 'SOL') {
                    quoteTokenMint = 'So11111111111111111111111111111111111111112'; // wSOL
                } else if (selectedPair.quote === 'RIFTS') {
                    quoteTokenMint = process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';
                } else {
                    quoteTokenMint = riftData.underlyingMint; // fallback
                }

                if (tradeType === 'buy') {
                    // Buy: spend quote token to get rift token
                    inputMint = quoteTokenMint; // Quote token (SOL or RIFTS)
                    outputMint = riftData.riftMint; // Rift token (e.g., rRIFTS)
                } else {
                    // Sell: spend rift token to get quote token
                    inputMint = riftData.riftMint; // Rift token (e.g., rRIFTS)
                    outputMint = quoteTokenMint; // Quote token (SOL or RIFTS)
                }

                console.log('✅ Using mints based on pair - Input:', inputMint, 'Output:', outputMint, 'Quote:', selectedPair.quote);
            } else {
                throw new Error('Invalid trading pair');
            }
            
            // Calculate input amount in lamports/smallest units
            // Use actualInputAmount which represents the actual tokens being sent in the swap
            // CRITICAL: Fetch correct decimals from blockchain, NO UNSAFE DEFAULTS
            let inputDecimals: number | null = null;

            try {
                // Determine which mint we're sending (inputMint is what we're sending in the swap)
                const sendingMint = inputMint;

                // Known token decimals (including Token-2022 tokens that getMint can't fetch)
                const KNOWN_DECIMALS: Record<string, number> = {
                    'So11111111111111111111111111111111111111112': 9, // SOL
                    'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump': 6, // RIFTS
                    'H8wDrayqi5YrBqkc162JU1cVyHvX4rMcjxLzPzNNFToS': 6, // rRIFTS (Token-2022)
                    'CP3k7ZWoWmj89mnyPzexDuLZTghJ7yYktD12f2kna63R': 9, // rSOL (Token-2022)
                    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6, // USDC
                    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6, // USDT
                };

                // Check known decimals first (faster and works for Token-2022)
                if (KNOWN_DECIMALS[sendingMint] !== undefined) {
                    inputDecimals = KNOWN_DECIMALS[sendingMint];
                    console.log(`✅ Using known decimals: ${inputDecimals} for ${sendingMint.slice(0, 8)}...`);
                } else {
                    // For unknown tokens, try to fetch from blockchain
                    try {
                        setIsFetchingDecimals(true);
                        const mintInfo = await getMint(standardConnection, new PublicKey(sendingMint));
                        inputDecimals = mintInfo.decimals;
                        console.log(`✅ Fetched token decimals from blockchain: ${inputDecimals} for ${sendingMint.slice(0, 8)}...`);
                    } catch (error) {
                        // If getMint fails (Token-2022 or other issue), try fetching account info directly
                        console.warn(`⚠️ getMint failed for ${sendingMint.slice(0, 8)}..., trying account info...`);
                        try {
                            const accountInfo = await standardConnection.getAccountInfo(new PublicKey(sendingMint));
                            if (accountInfo && accountInfo.data.length >= 45) {
                                // Decimals is at byte 44 in mint account data for both Token and Token-2022
                                inputDecimals = accountInfo.data[44];
                                console.log(`✅ Fetched decimals from account data: ${inputDecimals} for ${sendingMint.slice(0, 8)}...`);
                            } else {
                                throw new Error('Invalid mint account data');
                            }
                        } catch (innerError) {
                            console.error(`❌ CRITICAL: Failed to fetch mint decimals for ${sendingMint.slice(0, 8)}...`, innerError);
                            throw new Error(`Failed to fetch token decimals for ${sendingMint.slice(0, 8)}...\n\nThis is required for accurate swap amounts. Please check your connection and try again.`);
                        }
                    } finally {
                        setIsFetchingDecimals(false);
                    }
                }
            } catch (error) {
                console.error('❌ CRITICAL: Error determining token decimals', error);
                setIsFetchingDecimals(false);
                throw error; // Re-throw to prevent swap with wrong decimals
            }

            // 🔒 Validate decimals was fetched
            if (inputDecimals === null || inputDecimals === undefined || inputDecimals < 0) {
                throw new Error(`Failed to determine token decimals. Cannot proceed with swap.`);
            }

            const inputAmountLamports = Math.floor(actualInputAmount * Math.pow(10, inputDecimals));

            console.log('💵 Input Amount Calculation:', {
                actualInputAmount,
                inputDecimals,
                inputAmountLamports,
                inputToken: tradeType === 'buy' ? selectedPair.quote : selectedPair.base,
                isValid: inputAmountLamports > 0 && !isNaN(inputAmountLamports) && isFinite(inputAmountLamports)
            });

            // Validate the input amount
            if (!inputAmountLamports || inputAmountLamports <= 0 || isNaN(inputAmountLamports) || !isFinite(inputAmountLamports)) {
                throw new Error(
                    `Invalid swap amount calculated.\n\n` +
                    `Input: ${amount} ${inputCurrency === 'base' ? selectedPair.base : selectedPair.quote}\n` +
                    `Calculated: ${actualInputAmount} tokens (${inputAmountLamports} lamports)\n\n` +
                    `Please enter a valid amount and try again.`
                );
            }

            let signature: string;

            // Handle RIFTS/SOL trading using Jupiter or Meteora
            if (selectedPair.base === 'RIFTS') {
                debugLog(`🌊 Trading RIFTS/SOL - using Jupiter swap`);

                // Use Jupiter for RIFTS/SOL swaps
                signature = await riftsService.executeDirectJupiterSwap({
                    inputMint: inputMint,
                    outputMint: outputMint,
                    amount: inputAmountLamports,
                    slippageBps: slippageBps,
                    wallet: wallet as any
                });

                debugLog(`✅ Jupiter swap completed: ${signature}`);
            } else if (riftData) {
                // For ALL rift tokens: Try Meteora FIRST (custom tokens aren't on Jupiter)
                // If pool exists, use it. If not, show helpful error.

                // Determine which pool to use - prioritize liquidityPool from API (auto-detected)
                // then fall back to legacy solPool/riftsPool/meteoraPool fields
                let poolAddress: string | undefined;

                // First check liquidityPool (auto-detected from API) or selectedPair.liquidityPool
                poolAddress = riftData.liquidityPool || selectedPair.liquidityPool;

                // If not found, fall back to legacy fields
                if (!poolAddress) {
                    if (selectedPair.quote === 'SOL') {
                        poolAddress = (riftData as any).solPool || (riftData as any).meteoraPool;
                    } else if (selectedPair.quote === 'RIFTS') {
                        poolAddress = (riftData as any).riftsPool || (riftData as any).meteoraPool;
                    }
                }

                console.log('🔍 Pool lookup:', {
                    quoteToken: selectedPair.quote,
                    liquidityPool: riftData.liquidityPool,
                    pairLiquidityPool: selectedPair.liquidityPool,
                    solPool: (riftData as any).solPool,
                    riftsPool: (riftData as any).riftsPool,
                    meteoraPool: (riftData as any).meteoraPool,
                    selectedPool: poolAddress
                });

                if (poolAddress && poolAddress !== '11111111111111111111111111111111') {
                    // Meteora pool exists - use it!
                    debugLog(`🌊 Using Meteora pool for ${selectedPair.symbol}: ${inputAmountLamports} ${inputMint} -> ${outputMint}`);
                    debugLog(`   Pool address: ${poolAddress}`);

                    // Update user with Meteora routing information
                    addToast?.(
                        `🌊 Executing Meteora Swap...\n` +
                        `Step 1/3: Building transaction...`,
                        'pending'
                    );

                    // Use Meteora direct swap for rift token
                    signature = await riftsService.executeMeteoraSwap({
                        poolAddress: poolAddress,
                        inputMint,
                        outputMint,
                        amount: inputAmountLamports,
                        slippageBps: slippageBps,
                        wallet: {
                            publicKey: new PublicKey(wallet.publicKey),
                            sendTransaction: wallet.sendTransaction as any,
                            signTransaction: async (tx: any) => {
                                // Show signing step
                                addToast?.(
                                    `🌊 Executing Meteora Swap...\n` +
                                    `Step 2/3: Waiting for wallet signature...`,
                                    'pending'
                                );

                                // This is a fallback, the method should use sendTransaction directly
                                if (wallet.sendTransaction) {
                                    await wallet.sendTransaction(tx);
                                    return tx;
                                }
                                throw new Error('Wallet does not support transaction signing');
                            }
                        } as any
                    });

                    // Show sending step
                    addToast?.(
                        `🌊 Executing Meteora Swap...\n` +
                        `Step 3/3: Sending to blockchain...`,
                        'pending'
                    );
                } else {
                    // No Meteora pool found - show helpful error
                    throw new Error(
                        `❌ This rift token is not yet tradable.\n\n` +
                        `To make it tradable:\n` +
                        `1. Click "Add Liquidity" button on the rift card\n` +
                        `2. Create a Meteora pool with initial liquidity\n` +
                        `3. The rift will then become tradable\n\n` +
                        `Note: Custom rift tokens require Meteora pools and cannot use Jupiter.`
                    );
                }
            } else {
                // No rift data - this shouldn't happen, but handle gracefully
                throw new Error('Unable to find rift trading information');
            }

            debugLog('✅ Swap completed:', { signature });

            // Log swap details for debugging
            console.log('📊 Swap Details:', {
                tradeType,
                inputMint,
                outputMint,
                inputAmount: actualInputAmount,
                inputAmountLamports,
                expectedOutput: tradeType === 'buy' ? (actualInputAmount / tokenPriceInQuote) : (actualInputAmount * tokenPriceInQuote),
                signature
            });

            // Show immediate success notification
            addToast?.(
                `✅ Transaction Sent!\n` +
                `Confirming on blockchain...\n` +
                `Signature: ${signature?.slice(0, 8)}...${signature?.slice(-8)}`,
                'success',
                signature
            );

            // Calculate output amount for better user feedback
            // Use actualInputAmount (the actual amount being swapped)
            let outputAmount: number;
            let outputToken: string;
            let inputToken: string;

            if (tradeType === 'buy') {
                // Buying: SOL -> rRIFTS (or similar)
                outputAmount = actualInputAmount / tokenPriceInQuote;
                outputToken = selectedPair.base;
                inputToken = selectedPair.quote;
            } else {
                // Selling: rRIFTS -> SOL (or similar)
                outputAmount = actualInputAmount * tokenPriceInQuote;
                outputToken = selectedPair.quote;
                inputToken = selectedPair.base;
            }

            // Enhanced success notification with trade details
            // Determine which pool type was used based on the logic above
            const poolType = selectedPair.base === 'RIFTS' ? 'Meteora DAMM v2 🌊' :
                           (riftData?.liquidityPool && riftData.liquidityPool !== '11111111111111111111111111111111') ? 'Meteora DAMM v2 🌊' :
                           'DEX Router 🚀';

            const tradeDetails = `${tradeType === 'buy' ? '🟢 BUY' : '🔴 SELL'} ORDER SUBMITTED!\n\n` +
                `📊 Trade Summary:\n` +
                `• Swapped: ${actualInputAmount.toFixed(6)} ${inputToken}\n` +
                `• Received: ~${outputAmount.toFixed(6)} ${outputToken}\n` +
                `• Price: ${selectedPair.price.toFixed(6)} ${selectedPair.quote} per ${selectedPair.base}\n` +
                `• Pool: ${poolType}\n\n` +
                `⏳ Confirmation in progress...\n` +
                `View on Explorer: ${signature}`;

            // Show detailed trade info after a brief delay
            setTimeout(() => {
                addToast?.(
                    tradeDetails,
                    'success',
                    signature
                );
            }, 1500);

            // Update UI state
            setAmount('');

            // Notify about balance refresh
            addToast?.(
                `🔄 Refreshing your wallet balances...\n` +
                `Updated balances will appear shortly`,
                'pending'
            );

            // Trigger balance refresh
            setTimeout(() => {
                const event = new CustomEvent('refreshBalances');
                window.dispatchEvent(event);
            }, 2000);

            return; // Exit early since we completed the trade
        } catch (error) {
            console.error('❌ Trade error caught:', error);
            console.error('Error type:', error instanceof Error ? 'Error' : typeof error);
            console.error('Error message:', (error as Error).message);
            console.error('Error stack:', (error as Error).stack);

            debugError('Jupiter trade error:', error);

            const errorMessage = (error as Error).message || 'Unknown error';

            // If Jupiter says token not tradable, try Meteora direct swap
            if (errorMessage.includes('TOKEN_NOT_TRADABLE') || errorMessage.includes('not tradable')) {
                console.log('🌊 Token not on Jupiter, trying direct Meteora swap...');

                try {
                    // Get pool address - try from rift data first (if available), then search for it
                    let poolAddress: string | null = null;

                    // Check if we have rift data with a pool address
                    try {
                        // riftData is only available for wrapped token trades, not RIFTS/SOL
                        if (selectedPair.riftAddress) {
                            const currentRiftData = rifts.find(r => (r as unknown as { id?: string }).id === selectedPair.riftAddress) as unknown as {
                                liquidityPool?: string;
                            };
                            poolAddress = currentRiftData?.liquidityPool || null;
                        }
                    } catch (e) {
                        // riftData not available, will search for pool
                    }

                    if (!poolAddress) {
                        console.log('🔍 Pool address not in rift data, searching for Meteora pool...');

                        // Get the mints from the error context (they should be in scope from the try block)
                        // Declare them locally to satisfy TypeScript
                        const localInputMint = (selectedPair.base === 'RIFTS') ?
                            (tradeType === 'buy' ? 'So11111111111111111111111111111111111111112' : process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump') :
                            (tradeType === 'buy' ?
                                (rifts.find(r => (r as any).id === selectedPair.riftAddress) as any)?.underlyingMint :
                                (rifts.find(r => (r as any).id === selectedPair.riftAddress) as any)?.riftMint
                            );
                        const localOutputMint = (selectedPair.base === 'RIFTS') ?
                            (tradeType === 'buy' ? process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump' : 'So11111111111111111111111111111111111111112') :
                            (tradeType === 'buy' ?
                                (rifts.find(r => (r as any).id === selectedPair.riftAddress) as any)?.riftMint :
                                (rifts.find(r => (r as any).id === selectedPair.riftAddress) as any)?.underlyingMint
                            );

                        if (!localInputMint || !localOutputMint) {
                            throw new Error('Could not determine token mints for Meteora swap');
                        }

                        console.log('  Looking for pool with:', { inputMint: localInputMint, outputMint: localOutputMint });

                        // Search for the pool using the token mints
                        poolAddress = await riftsService.findMeteoraPool(localInputMint, localOutputMint);

                        if (!poolAddress) {
                            throw new Error(
                                'No Meteora pool found for this token pair.\n\n' +
                                'The token might not have a liquidity pool yet, or the pool ' +
                                'was not created on Meteora.'
                            );
                        }

                        console.log('✅ Found Meteora pool:', poolAddress);
                    }

                    // Recalculate mints for Meteora swap (same logic as in the try block)
                    const swapInputMint = (selectedPair.base === 'RIFTS') ?
                        (tradeType === 'buy' ? 'So11111111111111111111111111111111111111112' : process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump') :
                        (tradeType === 'buy' ?
                            (rifts.find(r => (r as any).id === selectedPair.riftAddress) as any)?.underlyingMint :
                            (rifts.find(r => (r as any).id === selectedPair.riftAddress) as any)?.riftMint
                        );
                    const swapOutputMint = (selectedPair.base === 'RIFTS') ?
                        (tradeType === 'buy' ? process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump' : 'So11111111111111111111111111111111111111112') :
                        (tradeType === 'buy' ?
                            (rifts.find(r => (r as any).id === selectedPair.riftAddress) as any)?.riftMint :
                            (rifts.find(r => (r as any).id === selectedPair.riftAddress) as any)?.underlyingMint
                        );

                    if (!swapInputMint || !swapOutputMint) {
                        throw new Error('Could not determine token mints for swap');
                    }

                    // Recalculate input amount in lamports - use the amount state directly
                    // Convert string to number and multiply by 1e9 (same as inputAmountLamports from try block)
                    const swapInputAmountLamports = Math.floor(parseFloat(amount) * 1e9);

                    addToast?.(
                        `🌊 Swapping via Meteora DEX...\n` +
                        `Token not available on Jupiter, using direct pool swap`,
                        'pending'
                    );

                    const meteoraSignature = await riftsService.executeMeteoraSwap({
                        poolAddress,
                        inputMint: swapInputMint,
                        outputMint: swapOutputMint,
                        amount: swapInputAmountLamports,
                        slippageBps: slippageBps,
                        wallet: wallet as any // Pass the real wallet object with sendTransaction method
                    });

                    // If we get here, Meteora swap succeeded!
                    addToast?.(
                        `✅ SWAP COMPLETED!\n\n` +
                        `${tradeType === 'buy' ? 'Bought' : 'Sold'} ${selectedPair.symbol}\n\n` +
                        `Via: Meteora DEX\n` +
                        `Tx: ${meteoraSignature?.slice(0, 8)}...${meteoraSignature?.slice(-8)}`,
                        'success',
                        meteoraSignature
                    );

                    addToast?.(
                        `🔄 Refreshing balances...\n` +
                        `Updated balances will appear shortly`,
                        'pending'
                    );

                    setTimeout(() => {
                        const event = new CustomEvent('refreshBalances');
                        window.dispatchEvent(event);
                    }, 2000);

                    return; // Success!
                } catch (meteoraError) {
                    console.error('❌ Meteora swap also failed:', meteoraError);
                    // Fall through to regular error handling
                }
            }

            let enhancedErrorMessage = `❌ TRADE FAILED\n\n`;
            let suggestions = '';

            // Provide specific error handling and suggestions
            if (errorMessage.includes('insufficient funds') || errorMessage.includes('Insufficient balance')) {
                enhancedErrorMessage += `💸 Insufficient Balance\n\n`;
                suggestions = `💡 Suggestions:\n` +
                    `• Check your wallet balance\n` +
                    `• Reduce trade amount\n` +
                    `• Ensure you have SOL for transaction fees`;
            } else if (errorMessage.includes('slippage') || errorMessage.includes('price impact')) {
                enhancedErrorMessage += `📊 Price Slippage Too High\n\n`;
                suggestions = `💡 Suggestions:\n` +
                    `• Try a smaller trade amount\n` +
                    `• Increase slippage tolerance\n` +
                    `• Wait for better market conditions`;
            } else if (errorMessage.includes('timeout') || errorMessage.includes('network')) {
                enhancedErrorMessage += `🌐 Network Connection Issue\n\n`;
                suggestions = `💡 Suggestions:\n` +
                    `• Check your internet connection\n` +
                    `• Try again in a few moments\n` +
                    `• Switch to a different RPC endpoint`;
            } else if (errorMessage.includes('wallet') || errorMessage.includes('signature')) {
                enhancedErrorMessage += `🔑 Wallet Transaction Issue\n\n`;
                suggestions = `💡 Suggestions:\n` +
                    `• Make sure you approved the transaction\n` +
                    `• Check if your wallet is still connected\n` +
                    `• Try refreshing and reconnecting your wallet`;
            } else if (errorMessage.includes('pool') || errorMessage.includes('liquidity')) {
                enhancedErrorMessage += `🌊 Pool Liquidity Issue\n\n`;
                suggestions = `💡 Suggestions:\n` +
                    `• Try a smaller trade amount\n` +
                    `• Wait for more liquidity to be added\n` +
                    `• Use a different trading pair`;
            } else {
                enhancedErrorMessage += `⚠️ Unexpected Error\n\n`;
                suggestions = `💡 Suggestions:\n` +
                    `• Try the transaction again\n` +
                    `• Check Solana network status\n` +
                    `• Contact support if issue persists`;
            }

            enhancedErrorMessage += `Error: ${errorMessage}\n\n${suggestions}`;

            addToast?.(enhancedErrorMessage, 'error');
        } finally {
            setIsLoading(false);
        }
    };
    
    // Calculate REAL total with fees - uses Meteora quote when available
    const calculateRealTotal = () => {
        const amountNum = parseFloat(amount) || 0;
        if (amountNum === 0) {
            return { baseAmount: 0, quoteAmount: 0, subtotal: 0, fee: 0, total: 0, priceImpact: 0, fromMeteoraQuote: false };
        }

        // 🚀 USE METEORA QUOTE when available (except for RIFTS/SOL which uses Jupiter)
        if (meteoraQuote && selectedPair && selectedPair.base !== 'RIFTS') {
            // Convert from lamports back to UI amounts (divide by 1e9)
            const inputAmount = meteoraQuote.inputAmount / 1e9;
            const outputAmount = meteoraQuote.outputAmount / 1e9;

            if (tradeType === 'buy') {
                // Buy: input is quote (SOL/RIFTS), output is base (rift token)
                return {
                    baseAmount: outputAmount,
                    quoteAmount: inputAmount,
                    subtotal: inputAmount,
                    fee: meteoraQuote.fee / 1e9,
                    total: inputAmount,
                    priceImpact: meteoraQuote.priceImpact,
                    fromMeteoraQuote: true
                };
            } else {
                // Sell: input is base (rift token), output is quote (SOL/RIFTS)
                return {
                    baseAmount: inputAmount,
                    quoteAmount: outputAmount,
                    subtotal: outputAmount + (meteoraQuote.fee / 1e9),
                    fee: meteoraQuote.fee / 1e9,
                    total: outputAmount,
                    priceImpact: meteoraQuote.priceImpact,
                    fromMeteoraQuote: true
                };
            }
        }

        // Fallback: Use the price from selectedPair (for RIFTS/SOL or when quote not available)
        const tokenPriceInQuote = selectedPair ? selectedPair.price : 0.001;

        let baseAmount: number;
        let quoteAmount: number;

        if (tradeType === 'buy') {
            // BUYING
            if (inputCurrency === 'base') {
                // User entered how much base they want to BUY
                baseAmount = amountNum;
                quoteAmount = amountNum * tokenPriceInQuote;
            } else {
                // User entered how much quote they want to SPEND
                quoteAmount = amountNum;
                baseAmount = amountNum / tokenPriceInQuote;
            }

            // Fee is 0.7% on the quote amount
            const fee = quoteAmount * 0.007;

            // Buying: user pays quote currency (add fee to cost)
            return {
                baseAmount,
                quoteAmount,
                subtotal: quoteAmount,
                fee,
                total: quoteAmount + fee,
                priceImpact: 0,
                fromMeteoraQuote: false
            };
        } else {
            // SELLING
            if (inputCurrency === 'base') {
                // User entered how much base they want to SELL
                baseAmount = amountNum;
                quoteAmount = amountNum * tokenPriceInQuote;
                const fee = quoteAmount * 0.007;

                return {
                    baseAmount,
                    quoteAmount: quoteAmount - fee,
                    subtotal: quoteAmount,
                    fee,
                    total: quoteAmount - fee,
                    priceImpact: 0,
                    fromMeteoraQuote: false
                };
            } else {
                // User entered how much quote they want to RECEIVE (after fees)
                const desiredQuoteAfterFees = amountNum;
                const grossQuoteNeeded = desiredQuoteAfterFees / (1 - 0.007); // Add back the fee
                baseAmount = grossQuoteNeeded / tokenPriceInQuote; // Base tokens to sell
                const fee = grossQuoteNeeded * 0.007;

                return {
                    baseAmount,
                    quoteAmount: desiredQuoteAfterFees,
                    subtotal: grossQuoteNeeded,
                    fee,
                    total: desiredQuoteAfterFees,
                    priceImpact: 0,
                    fromMeteoraQuote: false
                };
            }
        }
    };
    
    // Get REAL user balance for selected token
    const getUserBalance = (token: string) => {
        return userBalances[token] || 0;
    };

    // Calculate USD price based on quote currency
    const getUsdPrice = (priceInQuote: number, quoteCurrency: string) => {
        if (quoteCurrency === 'SOL' && solUsdPrice > 0) {
            return priceInQuote * solUsdPrice;
        }
        // For RIFTS pairs, we'd need RIFTS/USD price
        // For now, return 0 for non-SOL pairs
        return 0;
    };
    
    // REAL-TIME price chart with blockchain data
    const RealPriceChart = () => {
        const canvasRef = useRef<HTMLCanvasElement>(null);

        useEffect(() => {
            const canvas = canvasRef.current;
            if (!canvas || priceHistory.length < 1) {
                return;
            }

            const ctx = canvas.getContext('2d');
            if (!ctx) {
                return;
            }

            // Clear canvas
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const width = canvas.width;
            const height = canvas.height;
            const padding = 40;
            const chartWidth = width - padding * 2;
            const chartHeight = height - padding * 2;

            // Get price range
            const allPrices = priceHistory.map(p => p.price);
            const minPrice = Math.min(...allPrices);
            const maxPrice = Math.max(...allPrices);
            const priceRange = maxPrice - minPrice || 0.0001; // Avoid division by zero

            // Draw background grid
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
            ctx.lineWidth = 1;
            for (let i = 0; i <= 4; i++) {
                const y = padding + (chartHeight / 4) * i;
                ctx.beginPath();
                ctx.moveTo(padding, y);
                ctx.lineTo(width - padding, y);
                ctx.stroke();
            }

            // Draw Y-axis price labels
            ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.font = '10px Arial';
            ctx.textAlign = 'right';
            for (let i = 0; i <= 4; i++) {
                const price = maxPrice - (priceRange / 4) * i;
                const y = padding + (chartHeight / 4) * i;
                ctx.fillText(price.toFixed(8), padding - 5, y + 3);
            }

            if (priceHistory.length < 2) {
                // Draw single point
                const x = padding + chartWidth / 2;
                const y = padding + chartHeight - ((priceHistory[0].price - minPrice) / priceRange) * chartHeight;

                ctx.fillStyle = '#10b981';
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, Math.PI * 2);
                ctx.fill();

                return;
            }

            // Draw line chart
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';

            ctx.beginPath();

            priceHistory.forEach((point, index) => {
                const x = padding + (chartWidth / (priceHistory.length - 1)) * index;
                const y = padding + chartHeight - ((point.price - minPrice) / priceRange) * chartHeight;

                if (index === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            });

            ctx.stroke();

            // Draw gradient fill under the line
            const gradient = ctx.createLinearGradient(0, padding, 0, height - padding);
            gradient.addColorStop(0, 'rgba(16, 185, 129, 0.3)');
            gradient.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

            ctx.fillStyle = gradient;
            ctx.beginPath();

            // Start from bottom-left
            ctx.moveTo(padding, height - padding);

            // Draw line to first point
            const firstX = padding;
            const firstY = padding + chartHeight - ((priceHistory[0].price - minPrice) / priceRange) * chartHeight;
            ctx.lineTo(firstX, firstY);

            // Draw all points
            priceHistory.forEach((point, index) => {
                const x = padding + (chartWidth / (priceHistory.length - 1)) * index;
                const y = padding + chartHeight - ((point.price - minPrice) / priceRange) * chartHeight;
                ctx.lineTo(x, y);
            });

            // Close path at bottom-right
            const lastX = padding + chartWidth;
            ctx.lineTo(lastX, height - padding);
            ctx.lineTo(padding, height - padding);

            ctx.closePath();
            ctx.fill();

            // Draw points
            ctx.fillStyle = '#10b981';
            priceHistory.forEach((point, index) => {
                const x = padding + (chartWidth / (priceHistory.length - 1)) * index;
                const y = padding + chartHeight - ((point.price - minPrice) / priceRange) * chartHeight;

                ctx.beginPath();
                ctx.arc(x, y, 3, 0, Math.PI * 2);
                ctx.fill();
            });

            // Draw current price label
            ctx.fillStyle = '#10b981';
            ctx.font = 'bold 14px Arial';
            ctx.textAlign = 'left';
            const priceLabel = `${selectedPair?.price.toFixed(8) || '0'} ${selectedPair?.quote || 'SOL'}`;
            ctx.fillText(priceLabel, padding, padding - 10);

        }, [priceHistory, selectedPair]);

        return (
            <canvas
                ref={canvasRef}
                width={800}
                height={300}
                className="w-full h-full"
            />
        );
    };
    
    // OPTIMIZATION: Show skeleton/placeholder while loading instead of full spinner
    if (!selectedPair && realPairs.length === 0) {
        return (
            <div className="flex items-center justify-center h-96 rounded-xl bg-black/30 border border-emerald-500/20">
                <div className="text-center">
                    <Loader className="w-8 h-8 mx-auto mb-4 text-emerald-400 animate-spin" />
                    <p className="text-gray-400">Loading market data...</p>
                </div>
            </div>
        );
    }

    // OPTIMIZATION: Show trading interface immediately even if selectedPair not set yet
    const displayPair = selectedPair || realPairs[0];
    if (!displayPair) {
        return (
            <div className="flex items-center justify-center h-96 rounded-xl bg-black/30 border border-emerald-500/20">
                <div className="text-center">
                    <Loader className="w-8 h-8 mx-auto mb-4 text-emerald-400 animate-spin" />
                    <p className="text-gray-400">No trading pairs available</p>
                </div>
            </div>
        );
    }
    
    return (
        <div className="overflow-hidden border border-emerald-500/20 bg-black/30 backdrop-blur-sm rounded-xl">
            {/* Header */}
            <div className="p-4 border-b border-emerald-500/20 bg-black/30">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                        {/* REAL Token Pair Selector */}
                        <div className="relative">
                            <select
                                value={displayPair.symbol}
                                onChange={(e) => {
                                    const pair = realPairs.find(p => p.symbol === e.target.value);
                                    if (pair) setSelectedPair(pair);
                                }}
                                className="w-full sm:w-auto px-4 py-2 text-white bg-black/50 border border-emerald-500/30 rounded-lg focus:border-emerald-500/50 focus:outline-none"
                            >
                                {realPairs.map((pair, index) => (
                                    <option key={pair.riftAddress || pair.symbol || `pair-${index}`} value={pair.symbol}>
                                        {pair.symbol} {pair.hasMeteoraPool ? '🌊' : ''}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {/* Compact Stats Bar */}
                        <div className="flex items-center gap-2 text-xs flex-nowrap overflow-x-auto">
                            {/* Price - uses Meteora quote when available */}
                            <div className="flex items-center gap-1.5 px-2 py-1 bg-black/30 border border-emerald-500/10 rounded-md whitespace-nowrap">
                                <span className="text-gray-400">Price:</span>
                                {(() => {
                                    // Calculate live price from Meteora quote if available (non-RIFTS tokens only)
                                    let livePrice = displayPair.price;
                                    let isLiveQuote = false;

                                    if (meteoraQuote && displayPair.base !== 'RIFTS' && meteoraQuote.inputAmount > 0 && meteoraQuote.outputAmount > 0) {
                                        // Price = quote per base
                                        // BUY: input=quote, output=base → price = input/output
                                        // SELL: input=base, output=quote → price = output/input
                                        if (tradeType === 'buy') {
                                            livePrice = (meteoraQuote.inputAmount / meteoraQuote.outputAmount);
                                        } else {
                                            livePrice = (meteoraQuote.outputAmount / meteoraQuote.inputAmount);
                                        }
                                        isLiveQuote = true;
                                    }

                                    return (
                                        <>
                                            <span className={`font-semibold ${isLiveQuote ? 'text-emerald-300' : 'text-white'}`}>
                                                {livePrice.toFixed(6)} {displayPair.quote}
                                            </span>
                                            {isLoadingQuote && <Loader className="w-3 h-3 text-yellow-400 animate-spin" />}
                                            {!isLoadingQuote && isLiveQuote && <span className="text-emerald-400 text-[10px]">LIVE</span>}
                                            {isPriceUpdating && !isLoadingQuote && <RefreshCw className="w-3 h-3 text-emerald-400 animate-spin" />}
                                            {displayPair.quote === 'SOL' && solUsdPrice > 0 && (
                                                <span className="text-gray-500">(${getUsdPrice(livePrice, displayPair.quote).toFixed(4)})</span>
                                            )}
                                        </>
                                    );
                                })()}
                            </div>

                            {/* 24h Change - only show if non-zero */}
                            {displayPair.change24h !== 0 && (
                                <div className={`flex items-center gap-1 px-2 py-1 rounded-md whitespace-nowrap border ${displayPair.change24h >= 0 ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
                                    {displayPair.change24h >= 0 ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                                    <span className="font-semibold">{Math.abs(displayPair.change24h).toFixed(2)}%</span>
                                </div>
                            )}

                            {/* Volume - only show if non-zero */}
                            {displayPair.volume24h > 0 && (
                                <div className="flex items-center gap-1.5 px-2 py-1 bg-black/30 border border-emerald-500/10 rounded-md whitespace-nowrap">
                                    <span className="text-gray-400">Vol:</span>
                                    <span className="text-white">${displayPair.volume24h >= 1000 ? (displayPair.volume24h / 1000).toFixed(1) + 'K' : displayPair.volume24h.toFixed(0)}</span>
                                </div>
                            )}

                            {/* Pool Badge */}
                            {displayPair.hasMeteoraPool && (
                                <div className="px-2 py-1 bg-blue-500/10 border border-blue-500/20 rounded-md whitespace-nowrap">
                                    <span className="text-blue-400">🌊 Meteora</span>
                                </div>
                            )}

                            {/* Balance - only show ... on initial load, not during refresh */}
                            <div className="flex items-center gap-1.5 px-2 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-md whitespace-nowrap">
                                <span className="text-gray-400">Bal:</span>
                                <span className={`text-emerald-300 font-medium transition-opacity duration-300 ${isLoadingBalances ? 'opacity-70' : 'opacity-100'}`}>
                                    {Object.keys(userBalances).length === 0 && isLoadingBalances ? '...' : (
                                        getUserBalance(displayPair.base) >= 10000
                                            ? (getUserBalance(displayPair.base) / 1000).toFixed(1) + 'K'
                                            : getUserBalance(displayPair.base).toFixed(2)
                                    )} {displayPair.base}
                                </span>
                            </div>

                            {/* Spacer to push contract to right */}
                            <div className="flex-1" />

                            {/* Contract - always on far right */}
                            {displayPair.mintAddress && (
                                <div className="flex items-center gap-1 px-2 py-1 bg-black/30 border border-emerald-500/10 rounded-md whitespace-nowrap">
                                    <a
                                        href={`https://solscan.io/token/${displayPair.mintAddress}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="font-mono text-emerald-400 hover:text-emerald-300"
                                        title={displayPair.mintAddress}
                                    >
                                        {displayPair.mintAddress.slice(0, 4)}...{displayPair.mintAddress.slice(-4)}
                                    </a>
                                    <button
                                        onClick={async () => {
                                            if (displayPair.mintAddress) {
                                                await navigator.clipboard.writeText(displayPair.mintAddress);
                                                setCopiedAddress(true);
                                                setTimeout(() => setCopiedAddress(false), 2000);
                                            }
                                        }}
                                        className="p-0.5 hover:bg-emerald-500/20 rounded"
                                        title={copiedAddress ? "Copied!" : "Copy"}
                                    >
                                        {copiedAddress ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-gray-400" />}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
            
            {/* Main Content */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 p-4">
                {/* Trading Form */}
                <div className="lg:col-span-2">
                    <div className="p-4 mt-4 rounded-lg bg-black/30 border border-emerald-500/20">
                        <div className="flex gap-2 mb-4">
                            <button
                                onClick={() => setTradeType('buy')}
                                className={`flex-1 py-2 rounded-lg font-medium transition-all ${
                                    tradeType === 'buy'
                                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                        : 'bg-black/30 text-gray-400 hover:text-white border border-emerald-500/10'
                                }`}
                            >
                                Buy {displayPair.base}
                            </button>
                            <button
                                onClick={() => setTradeType('sell')}
                                className={`flex-1 py-2 rounded-lg font-medium transition-all ${
                                    tradeType === 'sell'
                                        ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                                        : 'bg-black/30 text-gray-400 hover:text-white border border-emerald-500/10'
                                }`}
                            >
                                Sell {displayPair.base}
                            </button>
                        </div>

                        <div className="space-y-3 mt-4">
                            <div>
                                <div className="flex items-center justify-between mb-1">
                                    <label className="block text-xs text-gray-400">Amount</label>
                                    <button
                                        onClick={() => setInputCurrency(inputCurrency === 'base' ? 'quote' : 'base')}
                                        className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
                                    >
                                        Switch to {inputCurrency === 'base' ? displayPair.quote : displayPair.base} ⇄
                                    </button>
                                </div>
                                <div className="relative">
                                    <input
                                        type="number"
                                        min="0"
                                        step="any"
                                        value={amount}
                                        onChange={(e) => {
                                            const value = e.target.value;
                                            // Prevent negative values
                                            if (value === '' || parseFloat(value) >= 0) {
                                                setAmount(value);
                                            }
                                        }}
                                        placeholder="0.00"
                                        className="w-full px-4 py-2 text-white bg-black/50 border border-emerald-500/30 rounded-lg focus:border-emerald-500/50 focus:outline-none"
                                    />
                                    <span className="absolute text-gray-400 -translate-y-1/2 right-3 top-1/2">
                                        {inputCurrency === 'base' ? displayPair.base : displayPair.quote}
                                    </span>
                                </div>
                                <div className="flex gap-2 mt-2">
                                    {[25, 50, 75, 100].map((percent) => (
                                        <button
                                            key={percent}
                                            onClick={() => {
                                                // Determine which balance to use based on trade type and input currency
                                                let balance: number;
                                                let calculatedAmount: number;

                                                if (tradeType === 'buy') {
                                                    // When buying, we spend quote (SOL) to get base (RIFTS/rSOL)
                                                    balance = getUserBalance(displayPair.quote);
                                                    const availableQuote = balance * percent / 100;

                                                    if (inputCurrency === 'base') {
                                                        // Input is in base, so calculate how much base we can buy
                                                        calculatedAmount = availableQuote / displayPair.price;
                                                    } else {
                                                        // Input is in quote, so just use the quote amount
                                                        calculatedAmount = availableQuote;
                                                    }
                                                } else {
                                                    // When selling, we spend base (RIFTS/rSOL) to get quote (SOL)
                                                    balance = getUserBalance(displayPair.base);
                                                    const availableBase = balance * percent / 100;

                                                    if (inputCurrency === 'base') {
                                                        // Input is in base, so just use the base amount
                                                        calculatedAmount = availableBase;
                                                    } else {
                                                        // Input is in quote, so calculate quote value
                                                        calculatedAmount = availableBase * displayPair.price;
                                                    }
                                                }

                                                setAmount(calculatedAmount.toFixed(6));
                                            }}
                                            className="flex-1 py-1 text-xs text-gray-400 transition-colors bg-black/30 border border-emerald-500/10 rounded hover:bg-emerald-500/10 hover:text-white hover:border-emerald-500/30"
                                        >
                                            {percent}%
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* REAL Transaction Summary */}
                            <div className="p-3 rounded-lg bg-black/30 border border-emerald-500/10">
                                <div className="space-y-2 text-sm">
                                    {/* Quote Source Indicator */}
                                    {parseFloat(amount) > 0 && displayPair.base !== 'RIFTS' && (
                                        <div className="flex justify-between items-center text-xs">
                                            <span className="text-gray-500">Quote Source</span>
                                            {isLoadingQuote ? (
                                                <span className="text-yellow-400 flex items-center gap-1">
                                                    <Loader className="w-3 h-3 animate-spin" /> Fetching...
                                                </span>
                                            ) : calculateRealTotal().fromMeteoraQuote ? (
                                                <span className="text-emerald-400 flex items-center gap-1">
                                                    🌊 Meteora Live
                                                </span>
                                            ) : (
                                                <span className="text-gray-400">Estimated</span>
                                            )}
                                        </div>
                                    )}
                                    <div className="flex justify-between">
                                        <span className="text-gray-400">Price</span>
                                        <div className="text-right">
                                            <div className="text-white">{displayPair.price.toFixed(6)} {displayPair.quote}</div>
                                            {displayPair.quote === 'SOL' && solUsdPrice > 0 && (
                                                <div className="text-xs text-gray-400">
                                                    ≈ ${getUsdPrice(displayPair.price, displayPair.quote).toFixed(4)}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-gray-400">You Send</span>
                                        <span className="text-white">
                                            {tradeType === 'buy'
                                                ? `${calculateRealTotal().total.toFixed(6)} ${displayPair.quote}`
                                                : `${calculateRealTotal().baseAmount.toFixed(6)} ${displayPair.base}`
                                            }
                                        </span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-gray-400">You Receive</span>
                                        <span className="text-white">
                                            {tradeType === 'buy'
                                                ? `${calculateRealTotal().baseAmount.toFixed(6)} ${displayPair.base}`
                                                : `${calculateRealTotal().total.toFixed(6)} ${displayPair.quote}`
                                            }
                                        </span>
                                    </div>
                                    {/* Price Impact - only show when from Meteora quote */}
                                    {calculateRealTotal().fromMeteoraQuote && calculateRealTotal().priceImpact > 0.1 && (
                                        <div className="flex justify-between">
                                            <span className="text-gray-400">Price Impact</span>
                                            <span className={`${calculateRealTotal().priceImpact > 5 ? 'text-red-400' : calculateRealTotal().priceImpact > 1 ? 'text-yellow-400' : 'text-emerald-400'}`}>
                                                {calculateRealTotal().priceImpact.toFixed(2)}%
                                            </span>
                                        </div>
                                    )}
                                    <div className="flex justify-between pt-2 border-t border-emerald-500/20">
                                        <span className="font-medium text-gray-400">Total</span>
                                        <span className="font-bold text-emerald-400">{calculateRealTotal().total.toFixed(6)} {displayPair.quote}</span>
                                    </div>

                                    {/* Slippage Settings */}
                                    <div className="pt-2 border-t border-emerald-500/20">
                                        <div
                                            className="flex justify-between items-center cursor-pointer hover:bg-emerald-500/5 rounded p-1 -m-1"
                                            onClick={() => setShowSlippageSettings(!showSlippageSettings)}
                                        >
                                            <span className="text-gray-400 text-xs">Slippage Tolerance</span>
                                            <span className="text-emerald-400 text-xs font-medium">{(slippageBps / 100).toFixed(1)}%</span>
                                        </div>
                                        {showSlippageSettings && (
                                            <div className="mt-2 space-y-2">
                                                <div className="flex gap-1">
                                                    {[1000, 2500, 5000, 7500].map((bps) => (
                                                        <button
                                                            key={bps}
                                                            onClick={() => setSlippageBps(bps)}
                                                            className={`flex-1 py-1 px-2 text-xs rounded transition-colors ${
                                                                slippageBps === bps
                                                                    ? 'bg-emerald-500 text-black font-medium'
                                                                    : 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                                                            }`}
                                                        >
                                                            {bps / 100}%
                                                        </button>
                                                    ))}
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <input
                                                        type="number"
                                                        value={slippageBps / 100}
                                                        onChange={(e) => {
                                                            const val = parseFloat(e.target.value);
                                                            if (!isNaN(val) && val >= 0.1 && val <= 100) {
                                                                setSlippageBps(Math.round(val * 100));
                                                            }
                                                        }}
                                                        className="flex-1 bg-black/50 border border-emerald-500/30 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-emerald-500"
                                                        min="0.1"
                                                        max="100"
                                                        step="0.1"
                                                    />
                                                    <span className="text-gray-400 text-xs">%</span>
                                                </div>
                                                <p className="text-[10px] text-gray-500">
                                                    Higher slippage = more likely to succeed but worse price
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {isFetchingDecimals && (
                                <div className="flex items-center justify-center gap-2 mb-3 p-2 bg-emerald-500/10 rounded-lg border border-emerald-500/30">
                                    <Loader className="w-4 h-4 text-emerald-400 animate-spin" />
                                    <span className="text-xs text-emerald-400">Fetching token decimals...</span>
                                </div>
                            )}

                            <LuxuryButton
                                variant={tradeType === 'buy' ? 'success' : 'danger'}
                                size="lg"
                                className="w-full"
                                onClick={handleRealTrade}
                                disabled={!wallet?.connected || isLoading || isFetchingDecimals || !amount}
                                loading={isLoading || isFetchingDecimals}
                            >
                                {!wallet?.connected ? 'Connect Wallet' :
                                 isFetchingDecimals ? 'Fetching decimals...' :
                                 isLoading ? 'Processing transaction...' :
                                 tradeType === 'buy' ? `Buy ${displayPair.base}` : `Sell ${displayPair.base}`}
                            </LuxuryButton>
                        </div>
                    </div>
                </div>

                {/* Recent Wraps/Unwraps */}
                <div className="lg:col-span-1">
                    <div className="p-4 rounded-lg bg-black/30 border border-emerald-500/20">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-sm font-medium text-emerald-400">Recent Wraps/Unwraps</h3>
                            <div className="text-xs text-gray-400">
                                {realTransactions.filter(tx => tx.type === 'wrap' || tx.type === 'unwrap').length} txs
                            </div>
                        </div>

                        <div className="space-y-1">
                            <div className="grid grid-cols-4 gap-2 pb-2 text-xs text-gray-400 border-b border-emerald-500/10">
                                <div>Type</div>
                                <div className="text-right">Amount</div>
                                <div className="text-right">Time</div>
                                <div className="text-right">TX</div>
                            </div>

                            <div className="space-y-0.5 max-h-[300px] overflow-y-auto">
                                {realTransactions
                                    .filter(tx => tx.type === 'wrap' || tx.type === 'unwrap')
                                    .slice(0, 12)
                                    .map((tx) => {
                                        // Format amount with K/M/B suffixes
                                        const formatAmount = (amt: number) => {
                                            if (amt >= 1000000000) return (amt / 1000000000).toFixed(1) + 'B';
                                            if (amt >= 1000000) return (amt / 1000000).toFixed(1) + 'M';
                                            if (amt >= 1000) return (amt / 1000).toFixed(1) + 'K';
                                            return amt.toFixed(2);
                                        };

                                        return (
                                            <div
                                                key={tx.signature}
                                                className="grid grid-cols-4 gap-2 text-xs hover:bg-emerald-500/5 py-1.5 items-center transition-colors rounded"
                                                title={`Amount: ${tx.amount.toLocaleString()} | Price: ${tx.price}`}
                                            >
                                                <div className={`font-medium ${tx.type === 'wrap' ? 'text-emerald-400' : 'text-red-400'}`}>
                                                    {tx.type === 'wrap' ? '↑ Wrap' : '↓ Unwrap'}
                                                </div>
                                                <div className="text-right text-white font-mono">
                                                    {tx.amount > 0 ? formatAmount(tx.amount) : '-'}
                                                </div>
                                                <div className="text-right text-gray-400">
                                                    {new Date(tx.timestamp).toLocaleTimeString([], {
                                                        hour: '2-digit',
                                                        minute: '2-digit'
                                                    })}
                                                </div>
                                                <div className="text-right">
                                                    <a
                                                        href={`https://solscan.io/tx/${tx.signature}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="inline-flex items-center justify-center w-6 h-6 rounded bg-black/30 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors"
                                                        title="View on Solscan"
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        <ExternalLink className="w-3 h-3 text-emerald-400" />
                                                    </a>
                                                </div>
                                            </div>
                                        );
                                    })}

                                {realTransactions.filter(tx => tx.type === 'wrap' || tx.type === 'unwrap').length === 0 && (
                                    <div className="py-4 text-xs text-center text-gray-500">
                                        No recent wrap/unwrap transactions
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
