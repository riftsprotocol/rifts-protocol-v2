import { NextRequest, NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const getRpcUrl = () => {
  const base = process.env.LASERSTREAM;
  const key = process.env.LASERSTREAM_API_KEY;

  if (base) {
    // If the URL already contains an api-key param, respect it and do not append again
    const hasKey = base.includes('api-key=');
    if (hasKey) {
      return base;
    }
    if (key) {
      const sep = base.includes('?') ? '&' : '?';
      return `${base}${sep}api-key=${key}`;
    }
    return base;
  }

  // Fallback to any configured public RPC to avoid hard crashes in dev
  return (
    process.env.NEXT_PUBLIC_SOLANA_RPC ||
    process.env.SOLANA_RPC_URL ||
    'https://api.mainnet-beta.solana.com'
  );
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mint = searchParams.get('mint');

  if (!mint) {
    console.error('[TOKEN-SUPPLY] Missing mint param');
    return NextResponse.json({ error: 'Missing mint parameter' }, { status: 400 });
  }

  try {
    const rpcUrl = getRpcUrl();
    if (!rpcUrl) {
      return NextResponse.json(
        { error: 'RPC not configured' },
        { status: 500 }
      );
    }

    console.log('[TOKEN-SUPPLY] Fetching supply', { mint, rpcUrl });

    const origin = request.nextUrl.origin;
    const rpcUrls = [rpcUrl, 'https://api.mainnet-beta.solana.com'];

    let mintPubkey: PublicKey;
    try {
      mintPubkey = new PublicKey(mint);
    } catch (e) {
      console.error('[TOKEN-SUPPLY] Invalid mint', mint, e);
      return NextResponse.json(
        { error: 'Invalid mint address' },
        { status: 400 }
      );
    }

    // Special case: native SOL / wSOL — use circulating SOL supply
    const isWsol = mintPubkey.toBase58() === WSOL_MINT;
    if (isWsol) {
      const { getServerConnection } = await import('@/lib/solana/server-connection');
      const connection = await getServerConnection();
      const supplyInfo = await connection.getSupply();
      const supplyLamports = supplyInfo.value.circulating || supplyInfo.value.total;
      const supply = supplyLamports / 1_000_000_000; // convert lamports to SOL
      return NextResponse.json({
        supply,
        decimals: 9,
        rawAmount: supplyLamports.toString(),
        isNative: true,
      });
    }
    // Primary: use rpc-http helper (handles multiple URLs and envs)
    let supplyInfo;
    try {
      const rpcResponse = await fetch(`${origin}/api/rpc-http`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          urls: rpcUrls,
          method: 'getTokenSupply',
          paramsType: 'array',
          params: [mint],
        })
      });

      if (rpcResponse.ok) {
        const body = await rpcResponse.json();
        if (body?.result?.value) {
          supplyInfo = body.result;
        } else if (body?.error) {
          console.error('[TOKEN-SUPPLY] rpc-http error', body.error);
        }
      } else {
        console.error('[TOKEN-SUPPLY] rpc-http call failed', rpcResponse.status);
      }
    } catch (rpcHttpError) {
      console.error('[TOKEN-SUPPLY] rpc-http fetch failed', rpcHttpError);
    }

    // Fallback: direct connection if rpc-http failed
    if (!supplyInfo) {
      const { getServerConnection } = await import('@/lib/solana/server-connection');
      const connection = await getServerConnection();
      try {
        supplyInfo = await connection.getTokenSupply(mintPubkey);
      } catch (primaryError) {
        console.error('[TOKEN-SUPPLY] getTokenSupply failed, attempting fallback', primaryError);
        // Fallback: fetch mint account directly to derive supply/decimals
        try {
          const accountInfo = await connection.getAccountInfo(mintPubkey);
          if (!accountInfo) {
            console.error('[TOKEN-SUPPLY] Mint not found during fallback', mint);
            return NextResponse.json(
              { error: 'Token mint not found', mint },
              { status: 404 }
            );
          }

          const { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
          const programId = accountInfo.owner.equals(new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'))
            ? TOKEN_2022_PROGRAM_ID
            : TOKEN_PROGRAM_ID;
          const mintData = await getMint(connection, mintPubkey, 'confirmed', programId);
          supplyInfo = {
            value: {
              uiAmount: Number(mintData.supply) / Math.pow(10, mintData.decimals),
              decimals: mintData.decimals,
              amount: mintData.supply.toString(),
            }
          };
        } catch (fallbackError) {
          console.error('[TOKEN-SUPPLY] Token supply fallback failed', fallbackError);
          throw primaryError;
        }
      }
    }

    const supply = supplyInfo.value.uiAmount || 0;
    const decimals = supplyInfo.value.decimals;

    return NextResponse.json({
      supply,
      decimals,
      rawAmount: supplyInfo.value.amount,
    });
  } catch (error) {
    console.error('[TOKEN-SUPPLY] Failed to fetch token supply:', error);
    const message = error instanceof Error ? error.message : 'Failed to fetch token supply';

    // Map common RPC failures to clearer responses
    const lower = message.toLowerCase();
    const notFound = lower.includes('could not find account') || lower.includes('account does not exist') || lower.includes('not found');
    const invalidParam = lower.includes('invalid param');

    if (notFound || invalidParam) {
      return NextResponse.json(
        { error: 'Token mint not found', mint },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
