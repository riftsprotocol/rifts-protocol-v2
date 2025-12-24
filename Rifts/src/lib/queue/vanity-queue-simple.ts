/**
 * Simplified Job Queue for Vanity PDA Generation using Redis
 * 🔒 PRODUCTION-READY SECURITY (Issue #5):
 * - Uses Redis for job storage and status tracking
 * - Prevents CPU exhaustion through job queueing
 * - Admin-only job submission
 * - Automatic cleanup of old jobs
 */

import { Redis } from '@upstash/redis';

// Get Redis client
function getRedisClient(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error('Redis not configured');
  }

  return new Redis({ url, token });
}

// Job interfaces
export interface VanityPDAJobData {
  creator: string;
  underlyingMint: string;
  targetPattern: string;
  maxAttempts: number;
  requestId: string;
  submittedAt: number;
  submittedBy: string; // IP address
}

export interface VanityPDAJobResult {
  mintPDA: string;
  mintBump: number;
  vanitySeed: string;
  creator: string;
  underlyingMint: string;
  generated: number;
  attempts?: number;
}

export interface JobStatus {
  status: 'pending' | 'active' | 'completed' | 'failed';
  data?: VanityPDAJobData;
  result?: VanityPDAJobResult;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

const QUEUE_KEY = 'vanity:queue';
const JOB_PREFIX = 'vanity:job:';
const ACTIVE_JOBS_KEY = 'vanity:active';

/**
 * Add a job to the queue
 */
export async function queueVanityJob(
  data: VanityPDAJobData
): Promise<string> {
  const redis = getRedisClient();
  const jobId = data.requestId;

  // Store job data
  await redis.set(`${JOB_PREFIX}${jobId}`, JSON.stringify({
    status: 'pending',
    data,
    submittedAt: Date.now(),
  } as JobStatus), {
    ex: 3600, // Expire after 1 hour
  });

  // Add to queue (sorted set by timestamp)
  await redis.zadd(QUEUE_KEY, {
    score: data.submittedAt,
    member: jobId,
  });

  console.log(`📋 Queued vanity job ${jobId} for pattern "${data.targetPattern}"`);
  return jobId;
}

/**
 * Get next job from queue (for worker processing)
 */
export async function getNextJob(): Promise<{
  jobId: string;
  data: VanityPDAJobData;
} | null> {
  const redis = getRedisClient();

  // Get oldest pending job
  const jobs = await redis.zrange(QUEUE_KEY, 0, 0);

  if (!jobs || jobs.length === 0) {
    return null;
  }

  const jobId = jobs[0] as string;

  // Get job data
  const jobData = await redis.get(`${JOB_PREFIX}${jobId}`);
  if (!jobData) {
    // Job expired, remove from queue
    await redis.zrem(QUEUE_KEY, jobId);
    return null;
  }

  const job = JSON.parse(jobData as string) as JobStatus;

  // Check if already active
  const isActive = await redis.sismember(ACTIVE_JOBS_KEY, jobId);
  if (isActive) {
    return null; // Already being processed
  }

  // Mark as active
  await redis.sadd(ACTIVE_JOBS_KEY, jobId);
  await redis.expire(ACTIVE_JOBS_KEY, 600); // Active set expires in 10 mins

  // Update job status
  job.status = 'active';
  job.startedAt = Date.now();
  await redis.set(`${JOB_PREFIX}${jobId}`, JSON.stringify(job), {
    ex: 3600,
  });

  return {
    jobId,
    data: job.data!,
  };
}

/**
 * Mark job as completed with result
 */
export async function completeJob(
  jobId: string,
  result: VanityPDAJobResult
): Promise<void> {
  const redis = getRedisClient();

  // Get current job
  const jobData = await redis.get(`${JOB_PREFIX}${jobId}`);
  if (!jobData) return;

  const job = JSON.parse(jobData as string) as JobStatus;

  // Update job
  job.status = 'completed';
  job.result = result;
  job.completedAt = Date.now();

  await redis.set(`${JOB_PREFIX}${jobId}`, JSON.stringify(job), {
    ex: 3600, // Keep result for 1 hour
  });

  // Remove from queue and active set
  await redis.zrem(QUEUE_KEY, jobId);
  await redis.srem(ACTIVE_JOBS_KEY, jobId);

  console.log(`✅ Completed job ${jobId}`);
}

/**
 * Mark job as failed
 */
export async function failJob(
  jobId: string,
  error: string
): Promise<void> {
  const redis = getRedisClient();

  // Get current job
  const jobData = await redis.get(`${JOB_PREFIX}${jobId}`);
  if (!jobData) return;

  const job = JSON.parse(jobData as string) as JobStatus;

  // Update job
  job.status = 'failed';
  job.error = error;
  job.completedAt = Date.now();

  await redis.set(`${JOB_PREFIX}${jobId}`, JSON.stringify(job), {
    ex: 7200, // Keep failed jobs for 2 hours
  });

  // Remove from queue and active set
  await redis.zrem(QUEUE_KEY, jobId);
  await redis.srem(ACTIVE_JOBS_KEY, jobId);

  console.log(`❌ Failed job ${jobId}: ${error}`);
}

/**
 * Get job status
 */
export async function getJobStatus(jobId: string): Promise<JobStatus | null> {
  const redis = getRedisClient();

  const jobData = await redis.get(`${JOB_PREFIX}${jobId}`);
  if (!jobData) {
    return null;
  }

  return JSON.parse(jobData as string) as JobStatus;
}

/**
 * Get queue statistics
 */
export async function getQueueStats(): Promise<{
  pending: number;
  active: number;
}> {
  const redis = getRedisClient();

  const pending = await redis.zcard(QUEUE_KEY);
  const active = await redis.scard(ACTIVE_JOBS_KEY);

  return {
    pending: pending || 0,
    active: active || 0,
  };
}

/**
 * Process jobs from the queue (worker function)
 * Should be called periodically (e.g., every 5 seconds)
 */
export async function processQueuedJobs(
  maxConcurrent: number = 2
): Promise<void> {
  const stats = await getQueueStats();

  // Don't start new jobs if at capacity
  if (stats.active >= maxConcurrent) {
    return;
  }

  // Get next job
  const job = await getNextJob();
  if (!job) {
    return;
  }

  // Process job in background (don't await)
  processJob(job.jobId, job.data).catch((error) => {
    console.error(`Error processing job ${job.jobId}:`, error);
    failJob(job.jobId, error.message);
  });
}

/**
 * Process a single job
 */
async function processJob(
  jobId: string,
  data: VanityPDAJobData
): Promise<void> {
  console.log(`🏭 Processing job ${jobId} (pattern: ${data.targetPattern})`);

  try {
    // Import generator
    const { generateVanityPDAFast } = await import('../vanity/generator');
    const { PublicKey } = await import('@solana/web3.js');

    const creator = new PublicKey(data.creator);
    const underlyingMint = new PublicKey(data.underlyingMint);

    const result = await generateVanityPDAFast(
      creator,
      underlyingMint,
      data.targetPattern,
      data.maxAttempts
    );

    if (!result) {
      await failJob(jobId, `Failed to generate vanity PDA for pattern "${data.targetPattern}"`);
      return;
    }

    await completeJob(jobId, result);

  } catch (error: any) {
    await failJob(jobId, error.message);
  }
}
