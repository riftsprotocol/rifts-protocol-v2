import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { getServerConnection } from '@/lib/solana/server-connection';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { poolAddress, poolType } = req.query;

  if (!poolAddress || typeof poolAddress !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid poolAddress parameter' });
  }

  if (!poolType || (poolType !== 'cpamm' && poolType !== 'dlmm')) {
    return res.status(400).json({ error: 'Invalid poolType parameter. Must be "cpamm" or "dlmm"' });
  }

  try {
    const connection = await getServerConnection();

    let price = 0;
    let priceSource = 'sdk';

    if (poolType === 'cpamm') {
      // Use CP-AMM SDK with DAMM V2 program ID
      try {
        const { CpAmm, getPriceFromSqrtPrice } = await import('@meteora-ag/cp-amm-sdk');
        const { PublicKey } = await import('@solana/web3.js');

        // DAMM V2 uses a different program ID than standard CP-AMM
        const METEORA_DAMM_V2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
        const cpAmm = new (CpAmm as any)(connection, METEORA_DAMM_V2_PROGRAM_ID);
        const poolPubkey = new PublicKey(poolAddress);
        const poolState = await cpAmm.fetchPoolState(poolPubkey);

        const WSOL_MINT = 'So11111111111111111111111111111111111111112';
        const isSolTokenA = poolState.tokenAMint.toBase58() === WSOL_MINT;

        // Get token decimals from mint accounts
        const tokenAMintInfo = await connection.getParsedAccountInfo(poolState.tokenAMint);
        const tokenBMintInfo = await connection.getParsedAccountInfo(poolState.tokenBMint);

        const tokenADecimals = (tokenAMintInfo.value?.data as any)?.parsed?.info?.decimals ?? 9;
        const tokenBDecimals = (tokenBMintInfo.value?.data as any)?.parsed?.info?.decimals ?? 9;

        // Use SDK's getPriceFromSqrtPrice for accurate calculation (works even for empty pools)
        if (poolState.sqrtPrice) {
          const priceDecimal = getPriceFromSqrtPrice(
            poolState.sqrtPrice,
            tokenADecimals,
            tokenBDecimals
          );

          // priceDecimal is tokenB per tokenA
          // If SOL is tokenA: price = tokenB/tokenA (rift per SOL) - need to invert for SOL per rift
          // If SOL is tokenB: price = tokenB/tokenA (SOL per rift) - this is what we want
          price = isSolTokenA ? (1 / priceDecimal.toNumber()) : priceDecimal.toNumber();

          console.log(`[METEORA-POOL-PRICE] sqrtPrice: ${poolState.sqrtPrice.toString()}, decimals: A=${tokenADecimals} B=${tokenBDecimals}, isSolTokenA: ${isSolTokenA}, priceDecimal: ${priceDecimal.toString()}, finalPrice: ${price}`);
        } else {
          // Fallback: Use vault balances (for pools without sqrtPrice)
          const [vaultABalance, vaultBBalance] = await Promise.all([
            connection.getTokenAccountBalance(poolState.tokenAVault),
            connection.getTokenAccountBalance(poolState.tokenBVault)
          ]);

          const tokenAAmount = parseFloat(vaultABalance.value.uiAmountString || '0');
          const tokenBAmount = parseFloat(vaultBBalance.value.uiAmountString || '0');

          if (tokenAAmount > 0 && tokenBAmount > 0) {
            price = isSolTokenA
              ? tokenAAmount / tokenBAmount
              : tokenBAmount / tokenAAmount;
            console.log(`[METEORA-POOL-PRICE] Using vault balances: A=${tokenAAmount}, B=${tokenBAmount}, price: ${price}`);
          }
        }
      } catch (sdkError) {
        // Log full error for debugging
        console.error('[METEORA-POOL-PRICE] CP-AMM SDK error:', sdkError);
        throw sdkError; // Re-throw to see the actual error
      }
    } else {
      // Use DLMM method
      const { dlmmLiquidityService } = await import('@/lib/solana/dlmm-liquidity-service');
      const poolInfo = await dlmmLiquidityService.getPoolInfo(connection, poolAddress);
      price = poolInfo?.currentPrice || 0;

    }

    return res.status(200).json({ price });
  } catch (error: any) {
    console.error('[METEORA-POOL-PRICE] Error fetching pool price:', error);
    return res.status(500).json({ error: error?.message || 'Failed to fetch pool price' });
  }
}
