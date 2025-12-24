import { createClient, SupabaseClient } from '@supabase/supabase-js';

// TODO: Add these to your .env.local file:
// NEXT_PUBLIC_SUPABASE_URL=your-project-url
// NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  if (typeof window !== 'undefined') {
    console.warn('⚠️ Supabase credentials not found. Please add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local');
  }
}

// Only create client if we have valid credentials, otherwise create a dummy client
// that won't be used during build time
let supabaseClient: SupabaseClient;

if (supabaseUrl && supabaseAnonKey && supabaseUrl.startsWith('http')) {
  supabaseClient = createClient(supabaseUrl, supabaseAnonKey);
} else {
  // Create a dummy client for build time - this won't actually be used
  // Dummy client for build time - won't be used in production
  supabaseClient = createClient('https://placeholder.supabase.co', 'placeholder_key');
}

export const supabase = supabaseClient;

// Database types
export interface RiftRecord {
  id: string; // Rift account address (primary key)
  name: string;
  created_at: string;
  updated_at: string;

  // Rift state
  is_open: boolean;
  total_tokens_wrapped: string;
  total_fees_collected: string;

  // Pricing
  entry_price: string;
  current_price: string;
  price_change_24h: number;

  // Volume & participants
  volume_24h: string;
  total_participants: number;

  // Token info
  token_mint: string;
  token_symbol: string;
  token_decimals: number;

  // Vault info
  vault_balance: string;

  // Metadata
  is_deprecated: boolean; // Flag for old buggy rifts
  program_id: string; // Track which program created this rift

  // Raw data (JSON)
  raw_data: any; // Store full ProductionRiftData for compatibility
}

export interface DeprecatedRift {
  address: string;
  reason: string;
  deprecated_at: string;
}

// Mint metadata cache - stores mint decimals permanently
export interface MintMetadata {
  mint_address: string; // Primary key
  decimals: number;
  symbol?: string;
  name?: string;
  created_at: string;
  updated_at: string;
}

// Helper function to get mint decimals from Supabase (instant) or fallback to RPC
export async function getMintDecimals(mintAddress: string): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from('mint_metadata')
      .select('decimals')
      .eq('mint_address', mintAddress)
      .maybeSingle(); // Use maybeSingle() instead of single() to handle 0 rows gracefully

    if (error) {
      console.debug(`[SUPABASE] Mint ${mintAddress} not in cache:`, error.message);
      return null;
    }

    if (data) {
      console.log(`💾 [SUPABASE] Fetched decimals for ${mintAddress}: ${data.decimals}`);
      return data.decimals;
    }

    // Mint not in cache yet - return null to trigger RPC fetch
    console.debug(`[SUPABASE] Mint ${mintAddress} not in cache (will fetch from RPC)`);
    return null;
  } catch (error) {
    console.debug('[SUPABASE] Error fetching mint decimals:', error);
    return null;
  }
}

// Helper function to save mint decimals to Supabase for future use
export async function saveMintDecimals(
  mintAddress: string,
  decimals: number,
  symbol?: string,
  name?: string
): Promise<void> {
  try {
    const { error } = await supabase
      .from('mint_metadata')
      .upsert({
        mint_address: mintAddress,
        decimals,
        symbol,
        name,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'mint_address'
      });

    if (error) {
      console.debug(`[SUPABASE] Error saving mint decimals:`, error);
    } else {
      console.log(`💾 [SUPABASE] Saved decimals for ${mintAddress}: ${decimals}`);
    }
  } catch (error) {
    console.debug('[SUPABASE] Error saving mint decimals:', error);
  }
}
