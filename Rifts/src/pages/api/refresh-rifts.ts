// Background task to refresh rifts cache
// Call this endpoint every 5 minutes to keep cache warm
// Can be triggered by Vercel Cron Jobs or external service
import { NextApiRequest, NextApiResponse } from 'next';
import { withSecurityProtection } from '@/lib/middleware/pages-api-protection';

async function refreshRiftsHandler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    // 🔒 SECURITY FIX (Issue #10): Authentication is now REQUIRED via middleware
    // No longer checks expectedToken - middleware enforces this with fail-closed behavior

    console.log('🔄 Manual refresh requested, triggering cache refresh...');

    // Call the rifts-cache API to trigger a refresh
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';

    const response = await fetch(`${baseUrl}/api/rifts-cache`, {
      headers: {
        'x-refresh': 'true' // Signal to bypass cache
      }
    });

    const data = await response.json();

    if (data.success) {
      console.log(`✅ Cache refreshed: ${data.rifts.length} rifts`);
      return res.status(200).json({
        success: true,
        message: 'Cache refreshed successfully',
        riftsCount: data.rifts.length,
        timestamp: Date.now()
      });
    } else {
      console.error('[ERROR] Cache refresh failed:', data.error);
      return res.status(500).json({
        success: false,
        error: data.error
      });
    }
  } catch (error) {
    console.error('[ERROR] Refresh error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Refresh failed'
    });
  }
}

// Export with security protection (CSRF + rate limiting + REQUIRED auth)
// 🔒 SECURITY FIX (Issue #10): Authentication is now ALWAYS required (fail-closed)
// Previously would allow unauthenticated access if RIFTS_REFRESH_TOKEN env var was not set
export default withSecurityProtection(refreshRiftsHandler, {
  requireAuth: true // ALWAYS require auth token - fail-closed approach
});
