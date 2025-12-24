import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Fetch the most recent protocol metrics from database
    const { data: metrics, error } = await supabase
      .from('protocol_metrics')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      console.error('Error fetching protocol metrics:', error);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!metrics) {
      return res.status(404).json({ error: 'No metrics found' });
    }

    // Format for frontend
    const formatted = {
      avgApy: parseFloat(metrics.avg_apy),
      totalTvl: parseFloat(metrics.total_tvl),
      totalVolume24h: parseFloat(metrics.volume_24h),
      totalRifts: metrics.total_rifts,
      totalFees: parseFloat(metrics.total_fees || '0'),
      activeUsers: metrics.active_users || 0,
      timestamp: new Date(metrics.timestamp).getTime(),
      cached: true
    };

    res.status(200).json({ metrics: formatted });
  } catch (error) {
    console.error('Error in get-protocol-metrics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
