/**
 * Security middleware for legacy Pages API routes (NextApiRequest/NextApiResponse)
 * Provides CSRF protection and rate limiting for pages/api/** endpoints
 *
 * This module adapts the App Router security middleware for use with legacy Pages API.
 */

import { NextApiRequest, NextApiResponse } from 'next';
import { apiRateLimiter, type RateLimiter } from './rate-limiter';

// Allowed origins that can call our API
const ALLOWED_ORIGINS = [
  'https://www.rifts.finance',
  'https://rifts.finance',
  'https://testrifts-ibh54smbu-kayzen112s-projects.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
];

/**
 * Validates that the request comes from an allowed origin (CSRF protection)
 */
export function validateOrigin(req: NextApiRequest): boolean {
  const origin = req.headers.origin;
  const referer = req.headers.referer;

  // In development, be more permissive
  if (process.env.NODE_ENV === 'development') {
    // Allow localhost origins
    if (origin?.includes('localhost') || origin?.includes('127.0.0.1')) {
      return true;
    }
  }

  // Check origin header (most reliable)
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return true;
  }

  // Fallback to referer check (less reliable but better than nothing)
  if (referer && ALLOWED_ORIGINS.some(allowed => referer.startsWith(allowed))) {
    return true;
  }

  // Allow requests without origin/referer in development
  if (process.env.NODE_ENV === 'development' && !origin && !referer) {
    return true;
  }

  return false;
}

/**
 * Get client identifier from NextApiRequest for rate limiting
 */
export function getClientIdentifier(req: NextApiRequest): string {
  // Try to get IP from headers (works with most reverse proxies)
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const ip = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor.split(',')[0];
    return ip.trim();
  }

  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }

  // Fallback to user-agent as identifier (less reliable)
  const userAgent = req.headers['user-agent'] || 'unknown';
  return `ua-${userAgent.substring(0, 50)}`;
}

/**
 * Check rate limit for NextApiRequest (memory-based - use checkRedisRateLimit when possible)
 */
export function checkRateLimit(
  req: NextApiRequest,
  limiter: RateLimiter = apiRateLimiter
): { allowed: boolean; retryAfter?: number } {
  const identifier = getClientIdentifier(req);
  return limiter.check(identifier);
}

/**
 * 🔒 SECURITY FIX (Issue #6): Redis-based rate limiting for serverless
 * Check rate limit using Upstash Redis (async)
 * Prefer this over checkRateLimit for better serverless support
 */
export async function checkRedisRateLimit(
  req: NextApiRequest
): Promise<{ allowed: boolean; retryAfter?: number; remaining?: number }> {
  try {
    const { checkRedisRateLimit: redisCheck, redisApiRateLimiter } = await import('./redis-rate-limiter');
    const result = await redisCheck(req, redisApiRateLimiter);
    return {
      allowed: result.allowed,
      retryAfter: result.retryAfter,
      remaining: result.remaining
    };
  } catch (error) {
    console.warn('⚠️ Redis rate limiter unavailable, using memory fallback:', error);
    // Fallback to memory-based
    return checkRateLimit(req);
  }
}

/**
 * Middleware wrapper that applies both CSRF protection and rate limiting
 * Use this for state-changing endpoints (POST, PUT, DELETE)
 */
export function withSecurityProtection(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void,
  options: {
    rateLimiter?: RateLimiter;
    requireAuth?: boolean;
  } = {}
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    // 1. Validate origin (CSRF protection)
    if (!validateOrigin(req)) {
      console.warn(
        `🚫 CSRF: Blocked request from origin: ${req.headers.origin} | referer: ${req.headers.referer}`
      );
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Invalid origin. This API endpoint can only be accessed from authorized domains.',
      });
    }

    // 2. Check rate limit
    const limiter = options.rateLimiter || apiRateLimiter;
    const rateLimit = checkRateLimit(req, limiter);

    if (!rateLimit.allowed) {
      console.warn(
        `🚫 Rate limit exceeded for ${getClientIdentifier(req)}`
      );
      return res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Please try again in ${rateLimit.retryAfter} seconds.`,
        retryAfter: rateLimit.retryAfter
      });
    }

    // 3. Optional: Check authorization token
    if (options.requireAuth) {
      const authToken = req.headers.authorization;
      const expectedToken = process.env.RIFTS_ADMIN_TOKEN || process.env.RIFTS_REFRESH_TOKEN;

      if (!expectedToken) {
        console.error('🚫 Admin token not configured in environment');
        return res.status(500).json({
          error: 'Server Configuration Error',
          message: 'Authentication is required but not configured'
        });
      }

      if (!authToken || authToken !== `Bearer ${expectedToken}`) {
        console.warn(
          `🚫 Unauthorized request from ${getClientIdentifier(req)}`
        );
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Valid authentication token required'
        });
      }
    }

    // 4. All checks passed, proceed with handler
    return handler(req, res);
  };
}

/**
 * Middleware wrapper for read-only endpoints (GET)
 * Applies rate limiting but no CSRF protection (not needed for GET)
 */
export function withRateLimiting(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void,
  limiter: RateLimiter = apiRateLimiter
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const rateLimit = checkRateLimit(req, limiter);

    if (!rateLimit.allowed) {
      console.warn(
        `🚫 Rate limit exceeded for ${getClientIdentifier(req)}`
      );
      return res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Please try again in ${rateLimit.retryAfter} seconds.`,
        retryAfter: rateLimit.retryAfter
      });
    }

    return handler(req, res);
  };
}

/**
 * 🔒 SECURITY FIX (Issue #6): Redis-based security protection wrapper
 * Middleware with Redis-based rate limiting (async)
 * Use this for better serverless support - falls back to memory if Redis unavailable
 */
export function withRedisSecurityProtection(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void,
  options: {
    requireAuth?: boolean;
  } = {}
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    // 1. Validate origin (CSRF protection)
    if (!validateOrigin(req)) {
      console.warn(
        `🚫 CSRF: Blocked request from origin: ${req.headers.origin} | referer: ${req.headers.referer}`
      );
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Invalid origin. This API endpoint can only be accessed from authorized domains.',
      });
    }

    // 2. Check rate limit using Redis
    const rateLimit = await checkRedisRateLimit(req);

    if (!rateLimit.allowed) {
      console.warn(
        `🚫 Rate limit exceeded for ${getClientIdentifier(req)}`
      );
      return res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Please try again in ${rateLimit.retryAfter} seconds.`,
        retryAfter: rateLimit.retryAfter,
        remaining: 0
      });
    }

    // 3. Optional: Check authorization token
    if (options.requireAuth) {
      const authToken = req.headers.authorization;
      const expectedToken = process.env.RIFTS_ADMIN_TOKEN || process.env.RIFTS_REFRESH_TOKEN;

      if (!expectedToken) {
        console.error('🚫 Admin token not configured in environment');
        return res.status(500).json({
          error: 'Server Configuration Error',
          message: 'Authentication is required but not configured'
        });
      }

      if (!authToken || authToken !== `Bearer ${expectedToken}`) {
        console.warn(
          `🚫 Unauthorized request from ${getClientIdentifier(req)}`
        );
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Valid authentication token required'
        });
      }
    }

    // 4. All checks passed, proceed with handler
    return handler(req, res);
  };
}

/**
 * 🔒 SECURITY FIX (Issue #6): Redis-based rate limiting wrapper
 * Middleware for read-only endpoints with Redis rate limiting
 */
export function withRedisRateLimiting(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const rateLimit = await checkRedisRateLimit(req);

    if (!rateLimit.allowed) {
      console.warn(
        `🚫 Rate limit exceeded for ${getClientIdentifier(req)}`
      );
      return res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Please try again in ${rateLimit.retryAfter} seconds.`,
        retryAfter: rateLimit.retryAfter,
        remaining: 0
      });
    }

    return handler(req, res);
  };
}
