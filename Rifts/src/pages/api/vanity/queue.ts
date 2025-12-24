/**
 * Vanity PDA Generation Job Queue API
 * 🔒 PRODUCTION-READY SECURITY (Issue #5):
 * - Admin-only access to queue jobs
 * - Redis-based rate limiting
 * - Background processing prevents CPU exhaustion
 * - Job status tracking and results retrieval
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { checkRedisRateLimit, redisAcceleratedRateLimiter, getClientIdentifier } from '@/lib/middleware/redis-rate-limiter';
import { queueVanityJob, getJobStatus as getJobStatusSimple } from '@/lib/queue/vanity-queue-simple';
import { randomUUID } from 'crypto';

async function vanityQueueHandler(req: NextApiRequest, res: NextApiResponse) {
  // POST - Queue a new vanity generation job
  if (req.method === 'POST') {
    const { creator, underlyingMint, targetPattern, maxAttempts } = req.body;

    // Validate inputs
    if (!creator || !underlyingMint) {
      return res.status(400).json({ error: 'Missing required fields: creator, underlyingMint' });
    }

    try {
      // Generate unique request ID for tracking
      const requestId = randomUUID();
      const clientIp = getClientIdentifier(req);

      // Queue the job (non-blocking)
      const jobId = await queueVanityJob({
        creator,
        underlyingMint,
        targetPattern: targetPattern || 'rft',
        maxAttempts: maxAttempts || 500000,
        requestId,
        submittedAt: Date.now(),
        submittedBy: clientIp,
      });

      return res.status(202).json({
        success: true,
        jobId,
        requestId,
        message: 'Vanity generation job queued. Use GET /api/vanity/queue?jobId=<id> to check status',
        estimatedTime: '30-120 seconds',
      });

    } catch (error: any) {
      console.error('❌ Failed to queue job:', error);
      return res.status(500).json({
        error: 'Failed to queue vanity generation job',
        details: error.message,
      });
    }
  }

  // GET - Check job status and retrieve result
  if (req.method === 'GET') {
    const { jobId } = req.query;

    if (!jobId || typeof jobId !== 'string') {
      return res.status(400).json({ error: 'Missing jobId parameter' });
    }

    try {
      const status = await getJobStatusSimple(jobId);

      if (!status) {
        return res.status(404).json({ error: 'Job not found' });
      }

      if (status.status === 'completed') {
        return res.status(200).json({
          status: 'completed',
          result: status.result,
        });
      }

      if (status.status === 'failed') {
        return res.status(200).json({
          status: 'failed',
          error: status.error,
        });
      }

      if (status.status === 'active') {
        return res.status(200).json({
          status: 'active',
          message: 'Job is currently being processed',
        });
      }

      return res.status(200).json({
        status: 'pending',
        message: 'Job is waiting in queue',
      });

    } catch (error: any) {
      console.error('❌ Failed to get job status:', error);
      return res.status(500).json({
        error: 'Failed to retrieve job status',
        details: error.message,
      });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 🔒 PRODUCTION-READY SECURITY (Issue #5):
  // 1. Admin-only access (prevents CPU exhaustion from public)
  // 2. Redis-based rate limiting (prevents distributed DoS)
  // 3. Background job processing (controlled CPU usage)

  // Require admin authentication
  if (!process.env.RIFTS_ADMIN_TOKEN) {
    return res.status(500).json({ error: 'Server configuration error: admin token not set' });
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  if (token !== process.env.RIFTS_ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: admin access required for vanity generation queue' });
  }

  // Redis-based rate limiting (even for admin to prevent abuse)
  const rateLimitResult = await checkRedisRateLimit(req, redisAcceleratedRateLimiter);

  if (!rateLimitResult.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfter: rateLimitResult.retryAfter,
      limit: rateLimitResult.limit,
      remaining: rateLimitResult.remaining,
    });
  }

  // Log admin access
  const clientIp = getClientIdentifier(req);
  console.log(`🔐 Admin vanity queue access: ${req.method} from ${clientIp} (${rateLimitResult.remaining}/${rateLimitResult.limit} remaining)`);

  return vanityQueueHandler(req, res);
}
