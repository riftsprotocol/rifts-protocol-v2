import { NextApiRequest, NextApiResponse } from 'next';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { PublicKey } from '@solana/web3.js';

// Singleton Supabase client (reused across requests)
let supabaseClient: SupabaseClient | null = null;

function getSupabase() {
  if (!supabaseClient) {
    supabaseClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
  }
  return supabaseClient;
}

// Server-side cache endpoint for rift data
// Returns pre-fetched rift account data so clients don't need to hit blockchain
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const startTime = Date.now();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid rift ID' });
  }

  try {
    const supabase = getSupabase(); // Reuse singleton

    // Fetch cached rift data
    const tQuery = Date.now();
    const { data, error } = await supabase
      .from('rift_account_cache')
      .select('*')
      .eq('rift_address', id)
      .single();
    console.log(`[RIFT-DATA-API] ⏱️ Database query: +${Date.now() - tQuery}ms`);

    if (error) {
      // If not in cache, return 404 so client can fallback to blockchain
      console.log(`[RIFT-DATA-API] Cache miss for ${id}, client will fetch from blockchain (total: +${Date.now() - startTime}ms)`);
      return res.status(404).json({ error: 'Rift data not cached yet', fallback: true });
    }

    // Check if cache is stale (> 60 seconds old as safety margin)
    const lastUpdated = new Date(data.last_updated).getTime();
    const now = Date.now();
    const ageSeconds = (now - lastUpdated) / 1000;

    if (ageSeconds > 60) {
      console.log(`[RIFT-DATA-API] Stale cache for ${id} (${ageSeconds}s old), client will fetch from blockchain (total: +${Date.now() - startTime}ms)`);
      return res.status(404).json({ error: 'Cache too stale', fallback: true });
    }

    const tResponse = Date.now();
    console.log(`[RIFT-DATA-API] ✅ Cache hit for ${id} (${ageSeconds.toFixed(1)}s old, total: +${Date.now() - startTime}ms)`);

    // Return cached data
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=20');

    // Parse treasury and partner wallets from account_data
    let treasuryWallet: string | undefined;
    let partnerWallet: string | undefined;

    try {
      const accountDataBuffer = Buffer.from(data.account_data.hex, 'hex');

      // Struct layout (after 8-byte discriminator):
      // name: [u8; 32] (8-39)
      // creator: Pubkey (40-71)
      // underlying_mint: Pubkey (72-103)
      // rift_mint: Pubkey (104-135)
      // vault: Pubkey (136-167)
      // fees_vault: Pubkey (168-199)
      // withheld_vault: Pubkey (200-231)
      // partner_fee_bps: u16 (232-233)
      // partner_wallet: Option<Pubkey> (234-266, 1 byte + 32 bytes)
      // treasury_wallet: Option<Pubkey> (267-299, 1 byte + 32 bytes)

      // Parse Option<Pubkey> for partner_wallet (offset 234)
      const hasPartnerWallet = accountDataBuffer[234] === 1;
      if (hasPartnerWallet) {
        partnerWallet = new PublicKey(accountDataBuffer.slice(235, 267)).toBase58();
      }

      // Parse Option<Pubkey> for treasury_wallet (offset 267)
      const hasTreasuryWallet = accountDataBuffer[267] === 1;
      if (hasTreasuryWallet) {
        treasuryWallet = new PublicKey(accountDataBuffer.slice(268, 300)).toBase58();
      }

      console.log(`[RIFT-DATA-API] Parsed wallets - Treasury: ${treasuryWallet || 'None'}, Partner: ${partnerWallet || 'None'}`);
    } catch (parseError) {
      console.warn('[RIFT-DATA-API] Failed to parse treasury/partner wallets from account_data:', parseError);
    }

    const response = {
      success: true,
      cached: true,
      ageSeconds: Math.floor(ageSeconds),
      data: {
        riftAddress: data.rift_address,
        accountData: data.account_data,
        vaultAddress: data.vault_address,
        vaultAccountData: data.vault_account_data,
        underlyingMint: data.underlying_mint,
        underlyingDecimals: data.underlying_decimals,
        riftMint: data.rift_mint,
        riftDecimals: data.rift_decimals,
        backingRatio: data.backing_ratio,
        totalWrapped: data.total_wrapped,
        totalMinted: data.total_minted,
        treasuryWallet, // Include parsed treasury wallet
        partnerWallet, // Include parsed partner wallet
      }
    };
    console.log(`[RIFT-DATA-API] ⏱️ Response built: +${Date.now() - tResponse}ms (total: +${Date.now() - startTime}ms)`);
    return res.status(200).json(response);
  } catch (error) {
    console.error('[RIFT-DATA-API] Error:', error, `(total: +${Date.now() - startTime}ms)`);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
