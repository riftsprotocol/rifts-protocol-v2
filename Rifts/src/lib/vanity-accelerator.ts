// High-performance vanity address generation using Web Workers
import { Keypair } from '@solana/web3.js';

interface VanityResult {
  keypair: Keypair;
  address: string;
  attempts: number;
  duration: number;
  workerId: number;
}

interface WorkerTask {
  id: string;
  pattern: string;
  maxAttempts: number;
  resolve: (result: VanityResult | null) => void;
  reject: (error: Error) => void;
}

export class VanityAccelerator {
  private workers: Worker[] = [];
  private readonly NUM_WORKERS = navigator.hardwareConcurrency || 4; // Use all CPU cores
  private taskQueue: WorkerTask[] = [];
  private activeTasks = new Map<string, WorkerTask>();
  private static instance: VanityAccelerator;

  constructor() {
    this.initWorkers();
  }

  static getInstance(): VanityAccelerator {
    if (!this.instance) {
      this.instance = new VanityAccelerator();
    }
    return this.instance;
  }

  private initWorkers() {
    console.log(`🚀 Initializing ${this.NUM_WORKERS} vanity generation workers...`);

    for (let i = 0; i < this.NUM_WORKERS; i++) {
      const worker = new Worker('/vanity-worker.js');

      worker.onmessage = (e) => {
        const { type, id, workerId, result } = e.data;
        const task = this.activeTasks.get(id);

        if (!task) return;

        switch (type) {
          case 'success':
            console.log(`⚡ Worker ${workerId} found address: ${result.address} (${result.attempts} attempts, ${result.duration.toFixed(1)}s)`);

            // Convert array back to Keypair
            const keypair = Keypair.fromSecretKey(new Uint8Array(result.keypair));

            task.resolve({
              keypair,
              address: result.address,
              attempts: result.attempts,
              duration: result.duration,
              workerId
            });
            this.activeTasks.delete(id);
            this.processQueue();
            break;

          case 'progress':
            console.log(`⚡ Worker ${workerId} progress: ${e.data.attempts}/${e.data.maxAttempts} attempts`);
            break;

          case 'failed':
            console.log(`⚠️ Worker ${workerId} failed after ${e.data.attempts} attempts`);
            task.resolve(null);
            this.activeTasks.delete(id);
            this.processQueue();
            break;
        }
      };

      worker.onerror = (error) => {
        console.error(`❌ Worker ${i} error:`, error);
      };

      this.workers.push(worker);
    }
  }

  // Generate vanity address using all available workers
  async generateVanityAddress(pattern: string = 'rift', maxAttemptsPerWorker: number = 5000000): Promise<VanityResult | null> {
    return new Promise((resolve, reject) => {
      const taskId = Math.random().toString(36).substring(7);

      const task: WorkerTask = {
        id: taskId,
        pattern,
        maxAttempts: maxAttemptsPerWorker,
        resolve,
        reject
      };

      // Add to queue
      this.taskQueue.push(task);
      this.processQueue();
    });
  }

  private processQueue() {
    // Find available workers
    const availableWorkers = this.workers.filter((_, index) => {
      return !Array.from(this.activeTasks.values()).some(task =>
        task.id.includes(`_worker${index}`)
      );
    });

    // Assign tasks to available workers
    while (this.taskQueue.length > 0 && availableWorkers.length > 0) {
      const task = this.taskQueue.shift()!;
      const workerIndex = availableWorkers.length - 1;
      const worker = availableWorkers.pop()!;

      // Create unique task ID for this worker
      const workerTaskId = `${task.id}_worker${this.workers.indexOf(worker)}`;
      task.id = workerTaskId;

      this.activeTasks.set(workerTaskId, task);

      // Start the worker
      worker.postMessage({
        id: workerTaskId,
        pattern: task.pattern,
        maxAttempts: task.maxAttempts,
        workerId: this.workers.indexOf(worker)
      });
    }
  }

  // Generate multiple addresses in parallel (for pool filling)
  async generateAddressBatch(pattern: string = 'rift', batchSize: number = 4): Promise<VanityResult[]> {
    console.log(`🏭 Generating batch of ${batchSize} "${pattern}" addresses using ${this.NUM_WORKERS} workers...`);

    const promises = Array(batchSize).fill(null).map(() =>
      this.generateVanityAddress(pattern)
    );

    const results = await Promise.all(promises);
    return results.filter(result => result !== null) as VanityResult[];
  }

  // Get current performance stats
  getStats() {
    return {
      numWorkers: this.NUM_WORKERS,
      activeTasks: this.activeTasks.size,
      queuedTasks: this.taskQueue.length,
      totalCores: navigator.hardwareConcurrency || 'Unknown'
    };
  }

  // Cleanup workers
  destroy() {
    this.workers.forEach(worker => worker.terminate());
    this.workers = [];
    this.taskQueue = [];
    this.activeTasks.clear();
  }
}

// Export singleton instance
export const vanityAccelerator = VanityAccelerator.getInstance();