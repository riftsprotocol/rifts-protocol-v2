import type { NextApiRequest, NextApiResponse } from 'next';

// Cache the DLMM pools list for 5 minutes to avoid hitting API too often
let cachedPools: string[] | null = null;
let cacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const now = Date.now();
    const forceRefresh = req.query.refresh === 'true';

    // Return cached data if still valid (unless force refresh)
    if (!forceRefresh && cachedPools && (now - cacheTime) < CACHE_DURATION) {
      return res.status(200).json({ pools: cachedPools, cached: true });
    }

    // Fetch from Meteora DLMM API
    const response = await fetch('https://dlmm-api.meteora.ag/pair/all');

    if (!response.ok) {
      throw new Error(`Meteora API returned ${response.status}`);
    }

    const dlmmPools = await response.json();
    const poolAddresses = dlmmPools.map((p: any) => p.address);

    // Update cache
    cachedPools = poolAddresses;
    cacheTime = now;

    return res.status(200).json({ pools: poolAddresses, cached: false, count: poolAddresses.length });
  } catch (error) {
    console.error('[DLMM-POOLS] Error fetching DLMM pools:', error);

    // Return cached data on error if available
    if (cachedPools) {
      return res.status(200).json({ pools: cachedPools, cached: true, stale: true });
    }

    return res.status(500).json({ error: 'Failed to fetch DLMM pools', pools: [] });
  }
}
