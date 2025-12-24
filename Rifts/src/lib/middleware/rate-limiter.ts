/**
 * Rate Limiting Middleware
 * SECURITY FIX: Prevent API abuse and DoS attacks
 */

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

export class RateLimiter {
  private requests: Map<string, RateLimitEntry> = new Map();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(windowMs: number = 60000, maxRequests: number = 10) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;

    // Clean up old entries every minute
    setInterval(() => this.cleanup(), 60000);
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.requests.entries()) {
      if (entry.resetTime < now) {
        this.requests.delete(key);
      }
    }
  }

  check(identifier: string): { allowed: boolean; retryAfter?: number } {
    const now = Date.now();
    const entry = this.requests.get(identifier);

    if (!entry || entry.resetTime < now) {
      // New window
      this.requests.set(identifier, {
        count: 1,
        resetTime: now + this.windowMs
      });
      return { allowed: true };
    }

    if (entry.count >= this.maxRequests) {
      // Rate limit exceeded
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
      return { allowed: false, retryAfter };
    }

    // Increment count
    entry.count++;
    return { allowed: true };
  }

  reset(identifier: string) {
    this.requests.delete(identifier);
  }
}

// Different rate limiters for different endpoints
export const apiRateLimiter = new RateLimiter(60000, 30); // 30 requests per minute for API
export const swapRateLimiter = new RateLimiter(60000, 10); // 10 swaps per minute
export const quoteRateLimiter = new RateLimiter(10000, 5); // 5 quotes per 10 seconds

/**
 * Get client identifier from request
 */
export function getClientIdentifier(request: Request): string {
  // Try to get IP from headers (works with most reverse proxies)
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }

  // Fallback to user-agent as identifier (less reliable)
  const userAgent = request.headers.get('user-agent') || 'unknown';
  return `ua-${userAgent.substring(0, 50)}`;
}

/**
 * Apply rate limiting to a request
 */
export function checkRateLimit(
  request: Request,
  limiter: RateLimiter
): { allowed: boolean; retryAfter?: number } {
  const identifier = getClientIdentifier(request);
  return limiter.check(identifier);
}
