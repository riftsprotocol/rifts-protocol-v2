// Accelerated vanity PDA generation using multi-core CPU
import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';

// Try to load native addon, fall back to JS if not available
let nativeGenerator: any = null;
try {
  nativeGenerator = require('../../gpu-vanity/index.node');
  console.log('✅ Loaded native multi-core vanity generator');
} catch (error) {
  console.log('⚠️ Native generator not available, using fallback');
}

interface VanityPDA {
  mintPDA: string;
  mintBump: number;
  vanitySeed: string;
  creator: string;
  underlyingMint: string;
  generated: number;
  attempts?: number;
}

const POOL_FILE = path.join(process.cwd(), '.vanity-pda-pool-accelerated.json');
const RIFTS_PROGRAM_ID = process.env.NEXT_PUBLIC_LP_STAKING_PROGRAM_ID || process.env.NEXT_PUBLIC_RIFTS_PROGRAM_ID || '6FEZJKsxbDm5W4Ad4eogNehivRKKGCHJHRnKUSFbLpKt';

// Load pool
let pdaPool: VanityPDA[] = [];
try {
  if (fs.existsSync(POOL_FILE)) {
    pdaPool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf-8'));
    console.log(`📂 Loaded ${pdaPool.length} accelerated vanity PDAs`);
  }
} catch (error) {
  console.log('📂 No cached PDAs, starting fresh');
}

let isGenerating = false;
const POOL_SIZE = 20;

function savePool() {
  try {
    fs.writeFileSync(POOL_FILE, JSON.stringify(pdaPool, null, 2));
  } catch (error) {
    console.error('❌ Failed to save pool:', error);
  }
}

// Accelerated generation using native addon
async function generateVanityPDAFast(
  creator: PublicKey,
  underlyingMint: PublicKey,
  targetPattern: string,
  maxAttempts: number = 5000000
): Promise<VanityPDA | null> {
  if (!nativeGenerator) {
    console.log('⚠️ Native generator not available');
    return null;
  }

  const startTime = Date.now();

  try {
    const result = nativeGenerator.generateVanityPDA(
      RIFTS_PROGRAM_ID,
      creator.toBase58(),
      underlyingMint.toBase58(),
      targetPattern,
      maxAttempts
    );

    const duration = Date.now() - startTime;
    console.log(`⚡ Generated PDA in ${(duration/1000).toFixed(2)}s (${result.attempts} attempts, ~${Math.round(result.attempts/(duration/1000))}/sec)`);

    return {
      mintPDA: result.pda,
      mintBump: result.bump,
      vanitySeed: result.seed,
      creator: creator.toBase58(),
      underlyingMint: underlyingMint.toBase58(),
      generated: Date.now(),
      attempts: result.attempts
    };
  } catch (error) {
    console.error('❌ Native generation failed:', error);
    return null;
  }
}

// Refill pool using accelerated generator
async function refillPool(creator: string, underlyingMint: string) {
  if (isGenerating) return;
  isGenerating = true;

  console.log(`🏭 Refilling accelerated pool (current: ${pdaPool.length}/${POOL_SIZE})`);

  const creatorPubkey = new PublicKey(creator);
  const mintPubkey = new PublicKey(underlyingMint);

  try {
    while (pdaPool.length < POOL_SIZE) {
      // Try "rf" pattern (2 chars) - much faster than "rft"
      const vanity = await generateVanityPDAFast(creatorPubkey, mintPubkey, 'rf', 2000000);

      if (vanity) {
        pdaPool.push(vanity);
        console.log(`📦 Pool: ${pdaPool.length}/${POOL_SIZE} (${vanity.attempts} attempts)`);
        savePool();
      } else {
        console.log('⚠️ Could not generate, retrying...');
        // Fallback to no pattern if struggling
        const fallback = await generateVanityPDAFast(creatorPubkey, mintPubkey, '', 100000);
        if (fallback) {
          pdaPool.push(fallback);
          savePool();
        }
      }
    }

    console.log(`✅ Accelerated pool filled: ${pdaPool.length} addresses`);
  } catch (error) {
    console.error('❌ Pool refill error:', error);
  } finally {
    isGenerating = false;
  }
}

async function vanityPoolAcceleratedHandler(req: NextApiRequest, res: NextApiResponse) {
  // 🔒 SECURITY: This is the accelerated PDA generation endpoint
  // PDAs have no private keys, so they're safe to generate and return
  // Rate limiting prevents CPU exhaustion abuse

  if (req.method === 'GET') {
    const { creator, underlyingMint } = req.query;

    if (!creator || !underlyingMint) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    // Try to serve from pool
    const matchingPDA = pdaPool.find(
      pda => pda.creator === creator && pda.underlyingMint === underlyingMint
    );

    if (matchingPDA) {
      pdaPool = pdaPool.filter(pda => pda !== matchingPDA);
      console.log(`🎯 Served pooled PDA (${pdaPool.length} remaining)`);
      savePool();

      if (pdaPool.length < 5) {
        refillPool(creator as string, underlyingMint as string);
      }

      return res.status(200).json(matchingPDA);
    }

    // Generate on demand if pool empty
    console.log('⚠️ Pool empty, generating on demand...');

    try {
      const creatorPubkey = new PublicKey(creator as string);
      const mintPubkey = new PublicKey(underlyingMint as string);

      const vanity = await generateVanityPDAFast(creatorPubkey, mintPubkey, 'rf', 1000000);

      if (vanity) {
        refillPool(creator as string, underlyingMint as string);
        return res.status(200).json(vanity);
      }

      return res.status(500).json({ error: 'Generation failed' });
    } catch (error) {
      console.error('❌ Error:', error);
      return res.status(500).json({ error: 'Generation failed' });
    }
  }

  if (req.method === 'PUT') {
    // Admin-only pool refill
    const { creator, underlyingMint } = req.body;

    if (!creator || !underlyingMint) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    await refillPool(creator, underlyingMint);
    return res.status(200).json({ poolSize: pdaPool.length });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// Export with Redis-based rate limiting and authentication
import { withSecurityProtection } from '@/lib/middleware/pages-api-protection';
import { checkRedisRateLimit, redisAcceleratedRateLimiter, getClientIdentifier } from '@/lib/middleware/redis-rate-limiter';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 🔒 PRODUCTION-READY SECURITY FIX (Issue #5):
  // 1. Redis-based rate limiting (prevents distributed DoS)
  // 2. Admin-only access for CPU-intensive operations
  // 3. Strict per-IP quotas enforced globally

  // ALL methods require authentication (CPU-intensive operations)
  if (!process.env.RIFTS_ADMIN_TOKEN) {
    return res.status(500).json({ error: 'Server configuration error: admin token not set' });
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  if (token !== process.env.RIFTS_ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: admin access required for accelerated operations' });
  }

  // Redis-based rate limiting (even for authenticated users to prevent abuse)
  const rateLimitResult = await checkRedisRateLimit(req, redisAcceleratedRateLimiter);

  if (!rateLimitResult.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfter: rateLimitResult.retryAfter,
      limit: rateLimitResult.limit,
      remaining: rateLimitResult.remaining
    });
  }

  // Log admin access for audit trail
  const clientIp = getClientIdentifier(req);
  console.log(`🔐 Admin accelerated vanity access: ${req.method} from ${clientIp} (${rateLimitResult.remaining}/${rateLimitResult.limit} remaining)`);

  return vanityPoolAcceleratedHandler(req, res);
}
