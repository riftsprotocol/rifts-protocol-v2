// Background worker to keep server vanity pool filled
export class VanityPoolWorker {
  private static interval: NodeJS.Timeout | null = null;
  private static readonly CHECK_INTERVAL = 5 * 60 * 1000; // Check every 5 minutes

  static start() {
    if (this.interval) return; // Already running

    console.log('🔄 Starting vanity pool background worker...');

    // Initial check
    this.checkAndRefillPool();

    // Set up periodic checks
    this.interval = setInterval(() => {
      this.checkAndRefillPool();
    }, this.CHECK_INTERVAL);
  }

  static stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('⏹️ Stopped vanity pool background worker');
    }
  }

  private static async checkAndRefillPool() {
    try {
      // Check pool status
      const response = await fetch('/api/vanity-pool', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) return;

      const status = await response.json();
      console.log(`📊 Pool status: ${status.poolSize}/${status.targetSize}`);

      // Trigger refill if needed
      if (status.poolSize < 5) {
        console.log('🔄 Pool low, triggering background refill...');
        fetch('/api/vanity-pool', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }).catch(console.error);
      }

    } catch (error) {
      console.error('❌ Pool worker error:', error);
    }
  }
}

// Auto-start in development
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  VanityPoolWorker.start();
}