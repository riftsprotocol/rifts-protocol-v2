import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { transactions, metrics } = req.body;

    // Save transactions
    if (transactions && transactions.length > 0) {
      const { error: txError } = await supabase
        .from('transactions')
        .upsert(transactions, { onConflict: 'id' });

      if (txError) {
        console.error('Error saving transactions:', txError.message, txError.details);
      } else {
        console.log(`✅ Saved ${transactions.length} transactions to database`);
      }
    }

    // Save protocol metrics - ONLY if TVL > 300K AND fees > 2000 (validates data is correct)
    if (metrics && metrics.totalTvl > 300000 && metrics.totalFees > 2000) {
      const { error: metricsError } = await supabase
        .from('protocol_metrics')
        .insert({
          avg_apy: metrics.avgApy,
          total_tvl: metrics.totalTvl,
          volume_24h: metrics.volume24h,
          total_rifts: metrics.totalRifts,
          total_fees: metrics.totalFees,
          active_users: metrics.activeUsers || 0
        });

      if (metricsError) {
        console.error('Error saving metrics:', metricsError);
      } else {
        console.log(`✅ Saved protocol metrics (fees: $${metrics.totalFees.toFixed(2)})`);
      }
    } else if (metrics) {
      if (metrics.totalTvl <= 300000) {
        console.warn(`⚠️ Skipping metrics - TVL too low ($${metrics.totalTvl})`);
      } else if (metrics.totalFees <= 2000) {
        console.warn(`⚠️ Skipping metrics - fees too low ($${metrics.totalFees}) - vault fetch likely failed`);
      }
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error in save-protocol-data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
