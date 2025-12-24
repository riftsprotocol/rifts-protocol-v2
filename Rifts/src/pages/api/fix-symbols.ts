import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({ error: 'Missing Supabase configuration' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    console.log('[FIX-SYMBOLS] Starting symbol fix...');

    // Fetch all rifts
    const { data: rifts, error: fetchError } = await supabase
      .from('rifts')
      .select('*');

    if (fetchError) {
      console.error('[FIX-SYMBOLS] Error fetching rifts:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch rifts', details: fetchError });
    }

    if (!rifts || rifts.length === 0) {
      return res.status(200).json({ message: 'No rifts to fix', updated: 0 });
    }

    console.log(`[FIX-SYMBOLS] Found ${rifts.length} rifts to process`);

    const updates = [];
    let updatedCount = 0;

    for (const rift of rifts) {
      const rawData = rift.raw_data || {};
      const prefixType = rawData.prefixType || 0;
      const currentSymbol = rawData.symbol || rift.token_symbol || '';
      const currentName = rift.name || '';

      let needsUpdate = false;
      let newSymbol = currentSymbol;
      let newName = currentName;
      let newPrefixType = prefixType;

      // Special handling for the new monorift
      if (rift.id === '8zChjEwBnSafVQENjrK9mkAnv8WDkUPAgmApeo19SvFm') {
        newSymbol = 'mSOL';
        newName = 'mSOL';
        newPrefixType = 1;
        needsUpdate = true;
        console.log(`[FIX-SYMBOLS] Fixing monorift ${rift.id}: ${currentSymbol} → ${newSymbol}`);
      } else {
        // Check if symbol needs 'r' prefix (for regular rifts)
        if (prefixType === 0) {
          // Regular rift - should have 'r' prefix
          if (!currentSymbol.startsWith('r') && !currentSymbol.startsWith('m')) {
            newSymbol = `r${currentSymbol}`;
            needsUpdate = true;
            console.log(`[FIX-SYMBOLS] Adding 'r' prefix to ${rift.id}: ${currentSymbol} → ${newSymbol}`);
          }
          if (!currentName.startsWith('r') && !currentName.startsWith('m')) {
            newName = `r${currentName}`;
            needsUpdate = true;
          }
        } else if (prefixType === 1) {
          // Monorift - should have 'm' prefix
          if (!currentSymbol.startsWith('m')) {
            newSymbol = `m${currentSymbol}`;
            needsUpdate = true;
            console.log(`[FIX-SYMBOLS] Adding 'm' prefix to monorift ${rift.id}: ${currentSymbol} → ${newSymbol}`);
          }
          if (!currentName.startsWith('m')) {
            newName = `m${currentName}`;
            needsUpdate = true;
          }
        }
      }

      if (needsUpdate) {
        // Update the rift
        const updatedRawData = {
          ...rawData,
          symbol: newSymbol,
          prefixType: newPrefixType
        };

        const { error: updateError } = await supabase
          .from('rifts')
          .update({
            name: newName,
            token_symbol: newSymbol,
            raw_data: updatedRawData
          })
          .eq('id', rift.id);

        if (updateError) {
          console.error(`[FIX-SYMBOLS] Error updating ${rift.id}:`, updateError);
          updates.push({
            id: rift.id,
            status: 'error',
            error: updateError.message,
            before: currentSymbol,
            after: newSymbol
          });
        } else {
          console.log(`[FIX-SYMBOLS] ✓ Updated ${rift.id}: ${currentSymbol} → ${newSymbol}`);
          updatedCount++;
          updates.push({
            id: rift.id,
            status: 'success',
            before: currentSymbol,
            after: newSymbol,
            prefixType: newPrefixType
          });
        }
      }
    }

    console.log(`[FIX-SYMBOLS] Complete. Updated ${updatedCount} rifts.`);

    return res.status(200).json({
      message: 'Symbol fix complete',
      totalRifts: rifts.length,
      updatedCount,
      updates
    });

  } catch (error) {
    console.error('[FIX-SYMBOLS] Exception:', error);
    return res.status(500).json({
      error: 'Failed to fix symbols',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
