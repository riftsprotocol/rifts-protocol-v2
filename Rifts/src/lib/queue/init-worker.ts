/**
 * Initialize Background Job Workers
 * Processes queued vanity generation jobs periodically
 */

import { processQueuedJobs } from './vanity-queue-simple';

let workerInterval: NodeJS.Timeout | null = null;
let workerInitialized = false;

export function initializeWorkers() {
  // Prevent duplicate initialization
  if (workerInitialized) {
    console.log('⚠️ Workers already initialized, skipping...');
    return;
  }

  // Only initialize workers in Node.js environment (not in browser)
  if (typeof window !== 'undefined') {
    console.log('⚠️ Skipping worker initialization in browser environment');
    return;
  }

  // Only initialize if Redis is configured
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.warn('⚠️ Redis not configured - background workers disabled. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
    return;
  }

  try {
    console.log('🚀 Initializing background job workers...');

    // Process queue every 5 seconds
    workerInterval = setInterval(async () => {
      try {
        await processQueuedJobs(2); // Max 2 concurrent jobs
      } catch (error) {
        console.error('❌ Error processing queued jobs:', error);
      }
    }, 5000);

    workerInitialized = true;
    console.log('✅ Background worker initialized (checking queue every 5 seconds)');

  } catch (error) {
    console.error('❌ Failed to initialize background workers:', error);
    // Don't throw - allow app to start even if workers fail
  }
}

export function shutdownWorkers() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    workerInitialized = false;
    console.log('✅ Background workers shut down');
  }
}

// Auto-initialize on import (for serverless functions)
if (process.env.NODE_ENV === 'production' || process.env.INIT_WORKERS === 'true') {
  initializeWorkers();
}
