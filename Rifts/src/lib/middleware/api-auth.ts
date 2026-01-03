/**
 * API Authentication Utilities
 * Production-ready authentication for API routes
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';

// Admin wallet that can access all administrative endpoints
export const ADMIN_WALLET = '9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4';

// CRON secret for Vercel cron jobs - MUST be set in production
export const CRON_SECRET = process.env.CRON_SECRET || '';

// Minimum length for CRON secret to be considered valid (32+ chars recommended)
const MIN_CRON_SECRET_LENGTH = 32;

// Signature validity window (5 minutes)
const SIGNATURE_VALIDITY_MS = 5 * 60 * 1000;

/**
 * Validate that CRON secret is properly configured
 * Fail closed if secret is empty or too short
 */
export function isCronSecretValid(): boolean {
  return CRON_SECRET.length >= MIN_CRON_SECRET_LENGTH;
}

/**
 * Check if request is from Vercel cron job
 * Only accepts Bearer token format with valid secret
 */
export function isVercelCron(authHeader: string | null): boolean {
  if (!authHeader || !isCronSecretValid()) return false;
  return authHeader === `Bearer ${CRON_SECRET}`;
}

/**
 * Check if request has valid cron secret (from header or query param)
 * Requires valid secret length
 */
export function hasValidCronSecret(cronSecret: string | null): boolean {
  if (!cronSecret || !isCronSecretValid()) return false;
  return secureCompare(cronSecret, CRON_SECRET);
}

/**
 * Check if wallet is admin
 */
export function isAdmin(wallet: string | null): boolean {
  if (!wallet) return false;
  return wallet === ADMIN_WALLET;
}

/**
 * Validate base58 wallet address format
 * Prevents injection attacks via wallet parameters
 */
export function isValidWalletAddress(wallet: string): boolean {
  if (!wallet || wallet.length < 32 || wallet.length > 44) return false;
  // Base58 character set (no 0, O, I, l)
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
  return base58Regex.test(wallet);
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Verify a Solana wallet signature
 * This cryptographically proves the caller owns the wallet
 *
 * @param wallet - The wallet address (base58 public key)
 * @param message - The message that was signed
 * @param signature - The signature (base58 encoded)
 * @returns true if signature is valid
 */
export function verifyWalletSignature(
  wallet: string,
  message: string,
  signature: string
): boolean {
  try {
    // Decode the public key and signature from base58
    const publicKey = bs58.decode(wallet);
    const signatureBytes = bs58.decode(signature);

    // Message as Uint8Array
    const messageBytes = new TextEncoder().encode(message);

    // Verify using nacl
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey);
  } catch (error) {
    console.error('[API-AUTH] Signature verification error:', error);
    return false;
  }
}

/**
 * Generate the expected message format for admin authentication
 * Includes timestamp to prevent replay attacks
 */
export function generateAuthMessage(action: string, timestamp: number): string {
  return `RIFTS Admin Auth\nAction: ${action}\nTimestamp: ${timestamp}`;
}

/**
 * Verify admin authentication with signature
 *
 * @param wallet - The wallet claiming to be admin
 * @param signature - The signature proving wallet ownership
 * @param action - The action being performed (for message verification)
 * @param timestamp - When the signature was created
 * @returns Object with verification result
 */
export function verifyAdminAuth(params: {
  wallet: string;
  signature: string;
  action: string;
  timestamp: number;
}): { valid: boolean; error?: string } {
  const { wallet, signature, action, timestamp } = params;

  // Check if wallet is admin
  if (!isAdmin(wallet)) {
    return { valid: false, error: 'Not an admin wallet' };
  }

  // Check timestamp is within validity window
  const now = Date.now();
  if (Math.abs(now - timestamp) > SIGNATURE_VALIDITY_MS) {
    return { valid: false, error: 'Signature expired or timestamp invalid' };
  }

  // Verify the signature
  const expectedMessage = generateAuthMessage(action, timestamp);
  if (!verifyWalletSignature(wallet, expectedMessage, signature)) {
    return { valid: false, error: 'Invalid signature' };
  }

  return { valid: true };
}

/**
 * Check if request is authenticated for admin/cron operations
 * Supports multiple authentication methods:
 * 1. Cryptographic signature (most secure, for admin wallet)
 * 2. Vercel cron bearer token
 * 3. CRON secret header/param
 *
 * For signature auth, request body must include:
 * - wallet: admin wallet address
 * - signature: base58 encoded signature
 * - timestamp: when signature was created
 * - action: the action being performed
 */
export function isAuthenticatedForAdminOp(params: {
  wallet?: string | null;
  signature?: string | null;
  action?: string | null;
  timestamp?: number | null;
  authHeader?: string | null;
  cronSecret?: string | null;
}): { authenticated: boolean; method: string | null; error?: string } {
  const { wallet, signature, action, timestamp, authHeader, cronSecret } = params;

  // Method 1: Signature-based admin authentication (most secure)
  if (wallet && signature && action && timestamp) {
    const result = verifyAdminAuth({
      wallet,
      signature,
      action,
      timestamp
    });

    if (result.valid) {
      return { authenticated: true, method: 'signature' };
    }
    // If signature was provided but invalid, don't fall through to other methods
    return { authenticated: false, method: null, error: result.error };
  }

  // Method 2: Vercel cron bearer token
  if (authHeader && isVercelCron(authHeader)) {
    return { authenticated: true, method: 'vercel-cron' };
  }

  // Method 3: CRON secret (for manual cron triggers)
  if (cronSecret && hasValidCronSecret(cronSecret)) {
    return { authenticated: true, method: 'cron-secret' };
  }

  // Method 4: Simple admin wallet check (legacy, for backwards compatibility)
  // WARNING: This is less secure as it trusts caller-supplied wallet string
  // Should migrate to signature-based auth for production
  if (wallet && isAdmin(wallet) && !signature) {
    console.warn('[API-AUTH] Using legacy wallet-only auth. Consider upgrading to signature auth.');
    return { authenticated: true, method: 'admin-legacy' };
  }

  return { authenticated: false, method: null };
}

/**
 * Helper to extract auth params from request
 */
export function extractAuthParams(request: Request, body?: Record<string, unknown>): {
  wallet: string | null;
  signature: string | null;
  action: string | null;
  timestamp: number | null;
  authHeader: string | null;
  cronSecret: string | null;
} {
  const url = new URL(request.url);
  const searchParams = url.searchParams;

  return {
    wallet: (body?.wallet as string) || searchParams.get('wallet'),
    signature: (body?.signature as string) || searchParams.get('signature'),
    action: (body?.action as string) || searchParams.get('action'),
    timestamp: body?.timestamp ? Number(body.timestamp) :
               searchParams.get('timestamp') ? Number(searchParams.get('timestamp')) : null,
    authHeader: request.headers.get('authorization'),
    cronSecret: request.headers.get('x-cron-secret') || searchParams.get('secret'),
  };
}
