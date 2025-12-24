// Manual pool detection trigger
// Allows users to immediately detect pools created externally on Meteora
import { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import { getServerConnection } from '@/lib/solana/server-connection';

const METEORA_CP_AMM_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
const METEORA_DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { riftId } = req.body;

  if (!riftId) {
    return res.status(400).json({ error: 'riftId is required' });
  }

  try {
    const connection = await getServerConnection();
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Get rift from database
    const { data: rift, error: riftError } = await supabase
      .from('rifts')
      .select('*')
      .eq('id', riftId)
      .single();

    if (riftError || !rift) {
      return res.status(404).json({ error: 'Rift not found' });
    }

    const riftMint = rift.token_mint;
    console.log(`🔍 Searching for pools for rift ${rift.token_symbol} (${riftMint})`);

    // Search for CPAMM pools
    const cpammPoolsTokenA = await connection.getProgramAccounts(METEORA_CP_AMM_PROGRAM_ID, {
      filters: [
        { dataSize: 1112 },
        { memcmp: { offset: 168, bytes: riftMint } }
      ],
      dataSlice: { offset: 0, length: 0 },
      commitment: 'confirmed'
    }).catch(() => []);

    const cpammPoolsTokenB = await connection.getProgramAccounts(METEORA_CP_AMM_PROGRAM_ID, {
      filters: [
        { dataSize: 1112 },
        { memcmp: { offset: 200, bytes: riftMint } }
      ],
      dataSlice: { offset: 0, length: 0 },
      commitment: 'confirmed'
    }).catch(() => []);

    const cpammPools = [...cpammPoolsTokenA, ...cpammPoolsTokenB];

    // Search for DLMM pools
    const dlmmPoolsTokenX = await connection.getProgramAccounts(METEORA_DLMM_PROGRAM_ID, {
      filters: [
        { dataSize: 3312 },
        { memcmp: { offset: 168, bytes: riftMint } }
      ],
      dataSlice: { offset: 0, length: 0 },
      commitment: 'confirmed'
    }).catch(() => []);

    const dlmmPoolsTokenY = await connection.getProgramAccounts(METEORA_DLMM_PROGRAM_ID, {
      filters: [
        { dataSize: 3312 },
        { memcmp: { offset: 200, bytes: riftMint } }
      ],
      dataSlice: { offset: 0, length: 0 },
      commitment: 'confirmed'
    }).catch(() => []);

    const dlmmPools = [...dlmmPoolsTokenX, ...dlmmPoolsTokenY];

    console.log(`📊 Found ${cpammPools.length} CPAMM pools and ${dlmmPools.length} DLMM pools`);

    if (cpammPools.length === 0 && dlmmPools.length === 0) {
      return res.status(404).json({
        error: 'No pools found',
        message: 'No Meteora pools detected for this rift. Please ensure the pool has been created and confirmed on-chain.'
      });
    }

    // Select primary pool (prefer SOL pairs)
    let selectedPool: string | undefined;
    const SOL_MINT = 'So11111111111111111111111111111111111111112';

    // Check CPAMM pools first
    if (cpammPools.length > 0) {
      if (cpammPools.length === 1) {
        selectedPool = cpammPools[0].pubkey.toBase58();
      } else {
        // Find SOL pair
        for (const pool of cpammPools) {
          const poolInfo = await connection.getAccountInfo(pool.pubkey);
          if (poolInfo && poolInfo.data.length >= 232) {
            const tokenAMint = new PublicKey(poolInfo.data.slice(168, 200)).toBase58();
            const tokenBMint = new PublicKey(poolInfo.data.slice(200, 232)).toBase58();
            if (tokenAMint === SOL_MINT || tokenBMint === SOL_MINT) {
              selectedPool = pool.pubkey.toBase58();
              break;
            }
          }
        }
        selectedPool = selectedPool || cpammPools[0].pubkey.toBase58();
      }
    } else if (dlmmPools.length > 0) {
      selectedPool = dlmmPools[0].pubkey.toBase58();
    }

    // Update database
    const allPools = [
      ...cpammPools.map(p => p.pubkey.toBase58()),
      ...dlmmPools.map(p => p.pubkey.toBase58())
    ];

    const updatedRawData = {
      ...rift.raw_data,
      hasMeteoraPool: true,
      meteoraPool: selectedPool,
      meteoraPools: allPools,
      liquidityPool: selectedPool
    };

    const { error: updateError } = await supabase
      .from('rifts')
      .update({ raw_data: updatedRawData })
      .eq('id', riftId);

    if (updateError) {
      console.error('Update error:', updateError);
      return res.status(500).json({ error: 'Failed to update rift' });
    }

    console.log(`✅ Updated ${rift.token_symbol} with pool: ${selectedPool}`);

    return res.status(200).json({
      success: true,
      rift: rift.token_symbol,
      poolAddress: selectedPool,
      totalPools: allPools.length,
      pools: allPools
    });

  } catch (error: any) {
    console.error('Pool refresh error:', error);
    return res.status(500).json({ error: error.message });
  }
}
