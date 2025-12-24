// Server-side price API - bypasses CSP restrictions
import { NextRequest, NextResponse } from 'next/server';

// Use Node.js runtime
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cache configuration
const CACHE_DURATION = 60 * 1000; // 1 minute cache
const priceCache = new Map<string, { price: number; source: 'jupiter' | 'meteora' | 'dexscreener'; timestamp: number }>();

// NO FALLBACK PRICES - Always use real prices from CoinGecko/Jupiter/Dexscreener only
const FALLBACK_PRICES: Record<string, number> = {};

type PriceResult = { price: number; source: 'jupiter' | 'meteora' | 'dexscreener' } | null;

/**
 * Fetch price from Jupiter API V3 - real prices always
 */
async function fetchJupiterPrice(tokenMint: string): Promise<PriceResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(
      `https://lite-api.jup.ag/price/v3?ids=${tokenMint}`,
      {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }
    );

    if (response.ok) {
      const data = await response.json();
      if (data[tokenMint]?.usdPrice !== undefined) {
        const price = data[tokenMint].usdPrice;
        if (process.env.DEBUG_PRICES === 'true') {
          console.log(`[PRICES-API] Jupiter V3: ${tokenMint.slice(0, 8)}... = $${price}`);
        }
        return { price, source: 'jupiter' };
      }
    }
    return null;
  } catch (error) {
    console.error('[PRICES-API] Jupiter fetch error:', error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchDexscreenerPrice(tokenMint: string): Promise<PriceResult> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      const pair = data?.pairs?.[0];
      const price = pair?.priceUsd ? parseFloat(pair.priceUsd) : null;
      if (price && !Number.isNaN(price)) {
        if (process.env.DEBUG_PRICES === 'true') {
          console.log(`[PRICES-API] Dexscreener: ${tokenMint.slice(0, 8)}... = $${price}`);
        }
        return { price, source: 'dexscreener' };
      }
    }
  } catch (error) {
    console.error('[PRICES-API] Dexscreener fetch error:', error);
  }
  return null;
}

/**
 * Fetch price with Dexscreener preference (pool price) and Jupiter fallback
 */
/**
 * Fetch price from Meteora CP-AMM pool (SOL pair only)
 */
async function fetchMeteoraPriceFromPool(tokenMint: string, poolAddress?: string): Promise<PriceResult> {
  if (!poolAddress) return null;

  try {
    const { PublicKey } = await import('@solana/web3.js');
    const { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint } = await import('@solana/spl-token');
    const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
    const { getServerConnection } = await import('@/lib/solana/server-connection');

    const conn = await getServerConnection();
    const METEORA_DAMM_V2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');

    const cpAmm = new (CpAmm as any)(conn, METEORA_DAMM_V2_PROGRAM_ID);
    const state = await cpAmm.fetchPoolState(new PublicKey(poolAddress));
    const targetMintPk = new PublicKey(tokenMint);

    const tokenAIsTarget = state.tokenAMint.equals(targetMintPk);
    const tokenBIsTarget = state.tokenBMint.equals(targetMintPk);
    const tokenAIsSol = state.tokenAMint.equals(NATIVE_MINT);
    const tokenBIsSol = state.tokenBMint.equals(NATIVE_MINT);

    if (!(tokenAIsTarget || tokenBIsTarget) || !(tokenAIsSol || tokenBIsSol)) {
      return null; // only support SOL pairs where target is other side
    }

    const balA = await conn.getTokenAccountBalance(state.tokenAVault);
    const balB = await conn.getTokenAccountBalance(state.tokenBVault);
    let amountA = parseFloat(balA.value.uiAmountString || '0');
    let amountB = parseFloat(balB.value.uiAmountString || '0');
    let decimalsA = balA.value.decimals;
    let decimalsB = balB.value.decimals;

    // Fallback decimals from mint if needed
    if (decimalsA === undefined) {
      const mintA = await getMint(conn, state.tokenAMint, 'confirmed', TOKEN_2022_PROGRAM_ID).catch(() => getMint(conn, state.tokenAMint, 'confirmed', TOKEN_PROGRAM_ID));
      decimalsA = mintA?.decimals ?? 0;
      amountA = amountA || (mintA ? Number(mintA.supply) / Math.pow(10, decimalsA) : 0);
    }
    if (decimalsB === undefined) {
      const mintB = await getMint(conn, state.tokenBMint, 'confirmed', TOKEN_2022_PROGRAM_ID).catch(() => getMint(conn, state.tokenBMint, 'confirmed', TOKEN_PROGRAM_ID));
      decimalsB = mintB?.decimals ?? 0;
      amountB = amountB || (mintB ? Number(mintB.supply) / Math.pow(10, decimalsB) : 0);
    }

    if (amountA === 0 || amountB === 0) return null;

    // Price in SOL of target token
    let priceSol = 0;
    if (tokenAIsTarget && tokenBIsSol) {
      priceSol = (amountB) / (amountA);
    } else if (tokenBIsTarget && tokenAIsSol) {
      priceSol = (amountA) / (amountB);
    }

    if (priceSol > 0) {
      return { price: priceSol, source: 'meteora' };
    }
  } catch (err) {
    console.error('[PRICES-API] Meteora pool fetch error:', err);
  }

  return null;
}

async function fetchPrice(tokenMint: string, poolAddress?: string): Promise<PriceResult> {
  const cacheKey = poolAddress ? `${tokenMint}-${poolAddress}` : tokenMint;
  // Check cache first
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return { price: cached.price, source: cached.source };
  }

  // Prefer Dexscreener pool price; if unavailable, use Jupiter
  if (poolAddress) {
    const meteora = await fetchMeteoraPriceFromPool(tokenMint, poolAddress);
    if (meteora) {
      priceCache.set(cacheKey, { price: meteora.price, source: 'meteora', timestamp: Date.now() });
      return meteora;
    }
  }

  const dexscreener = await fetchDexscreenerPrice(tokenMint);
  if (dexscreener) {
    priceCache.set(cacheKey, { price: dexscreener.price, source: 'dexscreener', timestamp: Date.now() });
    return dexscreener;
  }

  const jupiter = await fetchJupiterPrice(tokenMint);
  if (jupiter) {
    priceCache.set(cacheKey, { price: jupiter.price, source: 'jupiter', timestamp: Date.now() });
    return jupiter;
  }

  return null;
}

/**
 * GET handler for price requests
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const mint = searchParams.get('mint');

    if (!mint || typeof mint !== 'string') {
      return NextResponse.json(
        { error: 'Token mint required' },
        { status: 400 }
      );
    }

    const pool = searchParams.get('pool') || undefined;

    const price = await fetchPrice(mint, pool);

    if (price === null) {
      return NextResponse.json(
        {
          error: 'Price not available',
          mint
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      mint,
      price: price.price,
      source: price.source,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to fetch price'
      },
      { status: 500 }
    );
  }
}
