// Debug endpoint to check protocol_metrics data
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // Get total count
    const { count } = await supabase
      .from('protocol_metrics')
      .select('*', { count: 'exact', head: true });

    // Get latest 10 records
    const { data: latest, error: latestError } = await supabase
      .from('protocol_metrics')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(10);

    // Get oldest 5 records
    const { data: oldest, error: oldestError } = await supabase
      .from('protocol_metrics')
      .select('*')
      .order('timestamp', { ascending: true })
      .limit(5);

    // Get min/max TVL values
    const { data: allData } = await supabase
      .from('protocol_metrics')
      .select('total_tvl, volume_24h, timestamp')
      .order('timestamp', { ascending: true });

    const tvlValues = allData?.map(d => d.total_tvl) || [];
    const volValues = allData?.map(d => d.volume_24h) || [];

    res.status(200).json({
      totalRecords: count,
      latestError: latestError?.message,
      oldestError: oldestError?.message,
      latest: latest?.map(r => ({
        timestamp: r.timestamp,
        total_tvl: r.total_tvl,
        volume_24h: r.volume_24h
      })),
      oldest: oldest?.map(r => ({
        timestamp: r.timestamp,
        total_tvl: r.total_tvl,
        volume_24h: r.volume_24h
      })),
      tvlRange: {
        min: Math.min(...tvlValues),
        max: Math.max(...tvlValues),
        unique: new Set(tvlValues.map(v => Math.round(v))).size
      },
      volRange: {
        min: Math.min(...volValues),
        max: Math.max(...volValues),
        unique: new Set(volValues.map(v => Math.round(v))).size
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
