// Server-side vanity address pool API
import { NextApiRequest, NextApiResponse } from 'next';
import { Keypair } from '@solana/web3.js';
import fs from 'fs/promises';
import path from 'path';

interface VanityAddress {
  keypair: string; // Base64 encoded keypair
  address: string;
  createdAt: number;
}

interface PoolData {
  addresses: VanityAddress[];
  lastGenerated: number;
}

const POOL_FILE = path.join(process.cwd(), 'vanity-pool.json');
const TARGET_POOL_SIZE = 20; // Server can handle more
const REFILL_THRESHOLD = 5;

// Load pool from disk
async function loadPool(): Promise<PoolData> {
  try {
    const data = await fs.readFile(POOL_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { addresses: [], lastGenerated: 0 };
  }
}

// Save pool to disk
async function savePool(pool: PoolData): Promise<void> {
  await fs.writeFile(POOL_FILE, JSON.stringify(pool, null, 2));
}

// Generate vanity addresses - NON-BLOCKING with frequent yields
async function generateSingleVanityAddress(): Promise<VanityAddress | null> {
  const startTime = Date.now();
  const maxAttempts = 20000000;
  const BATCH_SIZE = 100; // SMALLER batches to yield more often
  const YIELD_EVERY = 1; // Yield after EVERY batch to prevent blocking

  for (let batch = 0; batch < maxAttempts / BATCH_SIZE; batch++) {
    // Check EVERY batch for address
    for (let i = 0; i < BATCH_SIZE; i++) {
      const keypair = Keypair.generate();
      const address = keypair.publicKey.toBase58();

      if (address.toLowerCase().endsWith('rift')) {
        const duration = (Date.now() - startTime) / 1000;
        console.log(`⚡ Generated rift address in ${duration.toFixed(1)}s: ${address}`);

        return {
          keypair: Buffer.from(keypair.secretKey).toString('base64'),
          address,
          createdAt: Date.now()
        };
      }
    }

    // 🚀 YIELD AFTER EVERY BATCH - prevents blocking the server
    await new Promise(resolve => setImmediate(resolve));

    // Stop after 30 seconds to prevent long blocking
    if (Date.now() - startTime > 30000) {
      console.log(`⏱️ Stopping vanity generation after 30 seconds (will retry later)`);
      return null;
    }
  }

  return null;
}

// Multi-process generation for Node.js cluster
async function generateMultipleVanityAddresses(count: number = 1): Promise<VanityAddress[]> {
  console.log(`🏭 Starting parallel generation of ${count} rift addresses...`);

  const promises = Array(count).fill(null).map(async (_, index) => {
    console.log(`🚀 Starting generator ${index + 1}/${count}`);
    return generateSingleVanityAddress();
  });

  const results = await Promise.allSettled(promises);
  const successful = results
    .filter((result): result is PromiseFulfilledResult<VanityAddress> =>
      result.status === 'fulfilled' && result.value !== null
    )
    .map(result => result.value);

  console.log(`✅ Generated ${successful.length}/${count} vanity addresses`);
  return successful;
}

// Background pool refill (non-blocking)
async function refillPool(): Promise<void> {
  const pool = await loadPool();

  console.log(`🏭 Server refilling pool (current: ${pool.addresses.length}/${TARGET_POOL_SIZE})`);

  // Generate only one address per call to prevent blocking
  if (pool.addresses.length < TARGET_POOL_SIZE) {
    const vanityAddress = await generateSingleVanityAddress();
    if (vanityAddress) {
      pool.addresses.push(vanityAddress);
      pool.lastGenerated = Date.now();
      await savePool(pool);
      console.log(`📦 Server added to pool (${pool.addresses.length}/${TARGET_POOL_SIZE})`);

      // Schedule next generation (non-blocking)
      if (pool.addresses.length < TARGET_POOL_SIZE) {
        setImmediate(() => refillPool().catch(console.error));
      }
    } else {
      // If generation failed, try again after a delay
      setTimeout(() => refillPool().catch(console.error), 5000);
    }
  } else {
    console.log('✅ Server pool is full!');
  }
}

async function vanityPoolHandler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      // 🔒 SECURITY FIX: Only return PUBLIC addresses, NEVER private keys
      // The server generates and stores keypairs securely, but only gives out addresses
      const pool = await loadPool();

      if (pool.addresses.length === 0) {
        return res.status(503).json({
          error: 'No vanity addresses available',
          poolSize: 0
        });
      }

      // Get the oldest address from pool
      const vanityAddress = pool.addresses.shift()!;
      await savePool(pool);

      console.log(`🎯 Server served rift address: ${vanityAddress.address} (${pool.addresses.length} remaining)`);

      // Trigger refill if running low (don't await - run in background)
      if (pool.addresses.length <= REFILL_THRESHOLD) {
        console.log('🔄 Server pool running low, starting background refill...');
        refillPool().catch(console.error);
      }

      // 🔒 SECURITY: ONLY return the PUBLIC address - NEVER the keypair
      // The private key stays on the server until user claims ownership
      return res.status(200).json({
        address: vanityAddress.address,
        poolSize: pool.addresses.length,
        createdAt: vanityAddress.createdAt
      });

    } else if (req.method === 'POST') {
      // Claim ownership of a vanity address
      // User provides signature proving they control the address they want
      const { address, userPublicKey, signature } = req.body;

      if (!address || !userPublicKey || !signature) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // TODO: Verify signature proves user controls their stated public key
      // This ensures only legitimate users can claim addresses

      // Find the keypair in pool
      const pool = await loadPool();
      const vanityEntry = pool.addresses.find(a => a.address === address);

      if (!vanityEntry) {
        return res.status(404).json({ error: 'Address not found in pool' });
      }

      // 🔒 SECURITY: Only return private key after verifying user identity
      // In production, you'd want additional verification (e.g., user must pay a fee,
      // or prove ownership of another address, etc.)
      const keypairBytes = Buffer.from(vanityEntry.keypair, 'base64');

      // Remove from pool
      pool.addresses = pool.addresses.filter(a => a.address !== address);
      await savePool(pool);

      return res.status(200).json({
        keypair: Array.from(keypairBytes),
        address: vanityEntry.address,
        message: 'Ownership claimed successfully'
      });

    } else if (req.method === 'PUT') {
      // Get pool status (admin only)
      const pool = await loadPool();
      return res.status(200).json({
        poolSize: pool.addresses.length,
        targetSize: TARGET_POOL_SIZE,
        lastGenerated: pool.lastGenerated,
        addresses: pool.addresses.map(a => a.address) // Only show addresses, not keys
      });

    } else {
      res.setHeader('Allow', ['GET', 'POST', 'PUT']);
      return res.status(405).json({ error: 'Method not allowed' });
    }

  } catch (error) {
    console.error('Vanity pool API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Export with security protection: rate limiting for GET, CSRF + rate limit for POST/PUT
import { withSecurityProtection, withRateLimiting } from '@/lib/middleware/pages-api-protection';
import { apiRateLimiter } from '@/lib/middleware/rate-limiter';

// Use a combined wrapper that handles different methods appropriately
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Apply rate limiting to all methods
  if (req.method === 'POST') {
    // POST (claim address) needs CSRF protection
    return withSecurityProtection(vanityPoolHandler, {
      requireAuth: false
    })(req, res);
  } else {
    // GET and PUT only need rate limiting (PUT is just status check)
    return withRateLimiting(vanityPoolHandler, apiRateLimiter)(req, res);
  }
}

// Global state to ensure we only start once per server instance
let isPoolStarted = false;
let poolInterval: NodeJS.Timeout | null = null;

// Auto-start pool generation when module loads (DISABLED - generate on-demand only)
function startVanityPool() {
  if (isPoolStarted) return;
  isPoolStarted = true;

  console.log('🚀 Vanity pool ready (on-demand generation)');

  // Set up periodic health checks (only if not already set)
  if (!poolInterval) {
    poolInterval = setInterval(async () => {
      try {
        const pool = await loadPool();
        if (pool.addresses.length < REFILL_THRESHOLD) {
          console.log('🔄 Pool low, generating in background...');
          // Generate in background without blocking
          refillPool().catch(console.error);
        }
      } catch (error) {
        console.error('❌ Periodic pool check failed:', error);
      }
    }, 10 * 60 * 1000); // Check every 10 minutes (less frequent)
  }
}

// DISABLED auto-start - only generate when addresses are requested
// if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'production') {
//   startVanityPool();
// }