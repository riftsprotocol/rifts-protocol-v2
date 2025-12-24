import type { NextApiRequest, NextApiResponse } from 'next';
import { calculateVaultBalances, VaultBalancesResult } from '../../lib/vault-balances';

// In-memory cache for vault balances (expensive to compute - 10-20 RPC calls)
let cachedResult: VaultBalancesResult | null = null;
let cachedTimestamp = 0;
const CACHE_TTL = 60000; // 60 seconds - vault balances don't change that fast

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const now = Date.now();
    const forceRefresh = req.query.refresh === 'true';

    // Return cached result if still valid
    if (!forceRefresh && cachedResult && (now - cachedTimestamp) < CACHE_TTL) {
      const age = Math.floor((now - cachedTimestamp) / 1000);
      console.log(`[VAULT-BALANCES] ⚡ Returning cached result (${age}s old)`);
      return res.status(200).json({
        ...cachedResult,
        cached: true,
        cacheAge: age
      });
    }

    // Fetch fresh vault balances
    console.log('[VAULT-BALANCES] 🔄 Calculating fresh vault balances...');
    const start = Date.now();
    const result = await calculateVaultBalances();
    const fetchTime = Date.now() - start;

    // Cache the result
    cachedResult = result;
    cachedTimestamp = now;

    console.log(`[VAULT-BALANCES] ✅ Calculated in ${fetchTime}ms, total: $${result.grandTotalUSD.toFixed(2)}`);

    res.status(200).json({
      ...result,
      cached: false,
      fetchTime
    });
  } catch (error: any) {
    console.error('Error fetching vault balances:', error);
    res.status(500).json({ error: error.message });
  }
}
