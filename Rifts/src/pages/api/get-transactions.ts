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
    const limit = parseInt(req.query.limit as string) || 10;
    const riftId = req.query.rift_id as string;

    // Build query
    let query = supabase
      .from('transactions')
      .select('*')
      .eq('status', 'confirmed');

    // Filter by rift_id if provided
    if (riftId) {
      query = query.eq('rift_id', riftId);
    }

    // Fetch transactions from database
    const { data: transactions, error } = await query
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching transactions:', error);
      return res.status(500).json({ error: 'Database error' });
    }

    // Format for frontend
    const formatted = (transactions || []).map(tx => ({
      id: tx.id,
      type: tx.type,
      amount: parseFloat(tx.amount),
      asset: tx.asset,
      timestamp: new Date(tx.timestamp).getTime(),
      signature: tx.signature, // Keep full signature for Solscan links
      status: tx.status,
      user_wallet: tx.user_wallet // Include wallet address
    }));

    res.status(200).json({ transactions: formatted, cached: false });
  } catch (error) {
    console.error('Error in get-transactions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
