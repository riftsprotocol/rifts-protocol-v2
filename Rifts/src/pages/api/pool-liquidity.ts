import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { getServerConnection } from '@/lib/solana/server-connection';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

interface PoolLiquidity {
  pool: string;
  liquidity: number; // Total liquidity in SOL terms
  isDlmm: boolean;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { pools, dlmmPools } = req.body as { pools: string[]; dlmmPools: string[] };

  if (!pools || !Array.isArray(pools) || pools.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid pools array' });
  }

  const dlmmSet = new Set(dlmmPools || []);
  const connection = await getServerConnection();

  const results: PoolLiquidity[] = [];

  for (const poolAddress of pools) {
    try {
      const isDlmm = dlmmSet.has(poolAddress);
      let liquidity = 0;

      if (isDlmm) {
        // DLMM: fetch from SDK
        const { dlmmLiquidityService } = await import('@/lib/solana/dlmm-liquidity-service');
        const poolInfo = await dlmmLiquidityService.getPoolInfo(connection, poolAddress);
        // Use reserveX + reserveY as liquidity proxy (SOL is usually reserveX)
        liquidity = (poolInfo?.reserveX || 0) + (poolInfo?.reserveY || 0) * (poolInfo?.currentPrice || 0);
      } else {
        // CP-AMM (DAMM V2): fetch vault balances
        const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
        const METEORA_DAMM_V2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
        const cpAmm = new (CpAmm as any)(connection, METEORA_DAMM_V2_PROGRAM_ID);
        const poolPubkey = new PublicKey(poolAddress);
        const poolState = await cpAmm.fetchPoolState(poolPubkey);

        const [vaultABalance, vaultBBalance] = await Promise.all([
          connection.getTokenAccountBalance(poolState.tokenAVault),
          connection.getTokenAccountBalance(poolState.tokenBVault)
        ]);

        const tokenAAmount = parseFloat(vaultABalance.value.uiAmountString || '0');
        const tokenBAmount = parseFloat(vaultBBalance.value.uiAmountString || '0');

        const isSolTokenA = poolState.tokenAMint.toBase58() === WSOL_MINT;
        const price = isSolTokenA
          ? tokenAAmount / tokenBAmount
          : tokenBAmount / tokenAAmount;

        // Calculate total liquidity in SOL terms
        if (isSolTokenA) {
          liquidity = tokenAAmount + (tokenBAmount * price);
        } else {
          liquidity = tokenBAmount + (tokenAAmount * (1 / price));
        }
      }

      results.push({ pool: poolAddress, liquidity, isDlmm });
    } catch (error) {
      console.error(`[POOL-LIQUIDITY] Error fetching liquidity for ${poolAddress}:`, error);
      results.push({ pool: poolAddress, liquidity: 0, isDlmm: dlmmSet.has(poolAddress) });
    }
  }

  // Sort by liquidity descending (biggest first)
  results.sort((a, b) => b.liquidity - a.liquidity);

  return res.status(200).json({ pools: results });
}
