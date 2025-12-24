import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Fetch SOL price from CoinGecko (server-side, no CORS issues)
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');

    if (!response.ok) {
      console.error('[SOL-PRICE] CoinGecko API error:', response.status, response.statusText);
      return res.status(response.status).json({ error: 'Failed to fetch SOL price from CoinGecko' });
    }

    const data = await response.json();
    const price = data?.solana?.usd;

    if (!price) {
      return res.status(500).json({ error: 'Invalid price data from CoinGecko' });
    }

    // Cache for 1 minute to reduce API calls
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');

    return res.status(200).json({ price });
  } catch (error: any) {
    console.error('[SOL-PRICE] Error fetching SOL price:', error);
    return res.status(500).json({ error: error?.message || 'Failed to fetch SOL price' });
  }
}
