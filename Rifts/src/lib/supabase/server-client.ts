/**
 * 🔒 SECURITY FIX (Issue #8): Server-side Supabase client with service role
 *
 * IMPORTANT: Use this ONLY on the server, NEVER expose to client
 *
 * The service role key bypasses Row Level Security (RLS) and should only be used for:
 * - Admin operations
 * - Background jobs
 * - Server-side data synchronization
 * - Analytics aggregation
 *
 * For client-side or user-specific operations, use the regular anon key client.
 */

import { createClient } from '@supabase/supabase-js';

// Validate that we're running on the server
if (typeof window !== 'undefined') {
  throw new Error('🚨 SECURITY: server-client.ts must only be imported on the server!');
}

/**
 * Create Supabase client with SERVICE ROLE key
 * ⚠️ WARNING: This bypasses RLS - use with extreme caution
 */
export function createServerSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL environment variable');
  }

  if (!supabaseServiceKey) {
    console.warn('⚠️ Missing SUPABASE_SERVICE_ROLE_KEY - falling back to anon key (RLS will apply)');
    // Fallback to anon key if service role not configured
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!anonKey) {
      throw new Error('Missing both SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_ANON_KEY');
    }
    return createClient(supabaseUrl, anonKey);
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Create Supabase client with ANON key (respects RLS)
 * Use this for user-specific server-side operations
 */
export function createAnonSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Get the appropriate Supabase client based on operation type
 *
 * @param useServiceRole - Set to true for admin operations that need to bypass RLS
 * @returns Supabase client
 */
export function getSupabaseClient(useServiceRole: boolean = false) {
  if (useServiceRole) {
    console.log('🔐 Using service role client (bypasses RLS)');
    return createServerSupabaseClient();
  } else {
    console.log('👤 Using anon client (respects RLS)');
    return createAnonSupabaseClient();
  }
}

// Export singleton instances for convenience
let serverClient: ReturnType<typeof createServerSupabaseClient> | null = null;
let anonClient: ReturnType<typeof createAnonSupabaseClient> | null = null;

/**
 * Get or create the service role client singleton
 * ⚠️ WARNING: Bypasses RLS - use only for admin operations
 */
export function getServerClient() {
  if (!serverClient) {
    serverClient = createServerSupabaseClient();
  }
  return serverClient;
}

/**
 * Get or create the anon client singleton
 * ✅ SAFE: Respects RLS policies
 */
export function getAnonClient() {
  if (!anonClient) {
    anonClient = createAnonSupabaseClient();
  }
  return anonClient;
}
