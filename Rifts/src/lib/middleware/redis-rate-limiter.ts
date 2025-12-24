/**
 * Redis-based Rate Limiter using Upstash
 * 🔒 SECURITY FIX (Issue #6): Centralized rate limiting that works in serverless
 *
 * The memory-based rate limiter can be bypassed in serverless environments because:
 * - Each serverless instance has its own memory
 * - Horizontal scaling creates new instances with fresh memory
 * - No coordination between instances
 *
 * This Redis-based limiter solves that by using a centralized store.
 */

import { Redis } from '@upstash/redis';

// Initialize Upstash Redis client
// Set these environment variables:
// UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
// UPSTASH_REDIS_REST_TOKEN=your-token
let redis: Redis | null = null;

function getRedisClient(): Redis | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.warn('⚠️ Upstash Redis not configured. Falling back to memory-based rate limiter.');
    return null;
  }

  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }

  return redis;
}

interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
}

/**
 * Redis-based sliding window rate limiter
 * Uses sorted sets to track requests within a time window
 */
export class RedisRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly keyPrefix: string;

  constructor(
    windowMs: number = 60000,
    maxRequests: number = 10,
    keyPrefix: string = 'ratelimit'
  ) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.keyPrefix = keyPrefix;
  }

  /**
   * Check if request is allowed using sliding window algorithm
   */
  async check(identifier: string): Promise<RateLimitResult> {
    const redis = getRedisClient();

    // Fallback to memory-based if Redis not configured
    if (!redis) {
      return this.memoryFallback(identifier);
    }

    try {
      const now = Date.now();
      const windowStart = now - this.windowMs;
      const key = `${this.keyPrefix}:${identifier}`;

      // Use Redis pipeline for atomic operations
      const pipeline = redis.pipeline();

      // 1. Remove old entries outside the window
      pipeline.zremrangebyscore(key, 0, windowStart);

      // 2. Count requests in current window
      pipeline.zcard(key);

      // 3. Add current request
      pipeline.zadd(key, { score: now, member: `${now}-${Math.random()}` });

      // 4. Set expiry on key (cleanup)
      pipeline.expire(key, Math.ceil(this.windowMs / 1000));

      const results = await pipeline.exec();

      // results[1] is the count before adding current request
      const count = (results[1] as number) || 0;

      if (count >= this.maxRequests) {
        // Rate limit exceeded
        // Get oldest request to calculate reset time
        const oldestRequests = await redis.zrange(key, 0, 0, { withScores: true });
        const oldestTimestamp = oldestRequests.length > 0
          ? (oldestRequests[0] as { score: number }).score
          : now;

        const resetTime = oldestTimestamp + this.windowMs;
        const retryAfter = Math.ceil((resetTime - now) / 1000);

        // Remove the request we just added since it's not allowed
        await redis.zpopmax(key);

        return {
          allowed: false,
          limit: this.maxRequests,
          remaining: 0,
          reset: resetTime,
          retryAfter
        };
      }

      // Request allowed
      return {
        allowed: true,
        limit: this.maxRequests,
        remaining: this.maxRequests - count - 1,
        reset: now + this.windowMs
      };

    } catch (error) {
      console.error('❌ Redis rate limiter error:', error);
      // On error, fail open (allow request) to avoid breaking the app
      // Log error for monitoring
      return {
        allowed: true,
        limit: this.maxRequests,
        remaining: this.maxRequests,
        reset: Date.now() + this.windowMs
      };
    }
  }

  /**
   * Reset rate limit for a specific identifier
   */
  async reset(identifier: string): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;

    try {
      const key = `${this.keyPrefix}:${identifier}`;
      await redis.del(key);
    } catch (error) {
      console.error('❌ Redis reset error:', error);
    }
  }

  /**
   * Get current usage for an identifier
   */
  async getUsage(identifier: string): Promise<{
    count: number;
    limit: number;
    remaining: number;
  }> {
    const redis = getRedisClient();

    if (!redis) {
      return { count: 0, limit: this.maxRequests, remaining: this.maxRequests };
    }

    try {
      const now = Date.now();
      const windowStart = now - this.windowMs;
      const key = `${this.keyPrefix}:${identifier}`;

      // Remove old entries and count
      await redis.zremrangebyscore(key, 0, windowStart);
      const count = await redis.zcard(key);

      return {
        count,
        limit: this.maxRequests,
        remaining: Math.max(0, this.maxRequests - count)
      };
    } catch (error) {
      console.error('❌ Redis getUsage error:', error);
      return { count: 0, limit: this.maxRequests, remaining: this.maxRequests };
    }
  }

  /**
   * Fallback to memory-based rate limiting if Redis unavailable
   */
  private memoryFallback(identifier: string): RateLimitResult {
    // Import the memory-based limiter
    const { apiRateLimiter } = require('./rate-limiter');
    const result = apiRateLimiter.check(identifier);

    return {
      allowed: result.allowed,
      limit: this.maxRequests,
      remaining: result.allowed ? this.maxRequests - 1 : 0,
      reset: Date.now() + this.windowMs,
      retryAfter: result.retryAfter
    };
  }
}

// Export pre-configured rate limiters
export const redisApiRateLimiter = new RedisRateLimiter(60000, 30, 'api'); // 30 requests per minute
export const redisSwapRateLimiter = new RedisRateLimiter(60000, 10, 'swap'); // 10 swaps per minute
export const redisQuoteRateLimiter = new RedisRateLimiter(10000, 5, 'quote'); // 5 quotes per 10 seconds
export const redisAcceleratedRateLimiter = new RedisRateLimiter(60000, 5, 'accelerated'); // 5 per minute for CPU-intensive

/**
 * Helper to get client identifier with better IP detection
 */
export function getClientIdentifier(req: any): string {
  // Try to get real IP from various headers
  // Priority: CF-Connecting-IP (Cloudflare) > X-Real-IP > X-Forwarded-For > fallback

  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp) return Array.isArray(cfIp) ? cfIp[0] : cfIp;

  const realIp = req.headers['x-real-ip'];
  if (realIp) return Array.isArray(realIp) ? realIp[0] : realIp;

  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const ip = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor.split(',')[0];
    return ip.trim();
  }

  // Fallback to user-agent hash (less reliable but better than nothing)
  const userAgent = req.headers['user-agent'] || 'unknown';
  return `ua-${Buffer.from(userAgent).toString('base64').substring(0, 20)}`;
}

/**
 * Check rate limit for a request (works with both NextRequest and NextApiRequest)
 */
export async function checkRedisRateLimit(
  req: any,
  limiter: RedisRateLimiter = redisApiRateLimiter
): Promise<RateLimitResult> {
  const identifier = getClientIdentifier(req);
  return limiter.check(identifier);
}
