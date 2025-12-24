// PDA-based vanity address generation like pump.fun
import { PublicKey } from '@solana/web3.js';

const RIFTS_PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_RIFTS_PROGRAM_ID || '6FEZJKsxbDm5W4Ad4eogNehivRKKGCHJHRnKUSFbLpKt'); // ✅ FIXED DEPLOYMENT with correct declare_id

interface VanityPDAResult {
  mintPDA: PublicKey;
  mintBump: number;
  vanitySeed: Buffer;
  attempts: number;
  duration: number;
}

export class VanityPDAGenerator {
  // Generate vanity PDA that ends with target pattern
  static async generateVanityPDA(
    creator: PublicKey,
    underlyingMint: PublicKey,
    targetPattern: string = 'rift',
    maxAttempts: number = 10000000
  ): Promise<VanityPDAResult | null> {

    console.log(`🎯 Generating PDA vanity address ending with "${targetPattern}"...`);
    const startTime = performance.now();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Generate random vanity seed
      const vanitySeed = this.generateRandomSeed(attempt);

      try {
        // Calculate PDA using the seed
        const [mintPDA, mintBump] = PublicKey.findProgramAddressSync(
          [
            Buffer.from("rift_mint"),
            creator.toBuffer(),
            underlyingMint.toBuffer(),
            vanitySeed
          ],
          RIFTS_PROGRAM_ID
        );

        const address = mintPDA.toBase58();

        // Check if it matches our target pattern (or if no pattern is required)
        const matchesPattern = targetPattern === '' ||
          address.toLowerCase().endsWith(targetPattern.toLowerCase());

        if (matchesPattern) {
          const duration = performance.now() - startTime;

          console.log(`✅ Found vanity PDA: ${address}`);
          console.log(`⚡ Generated in ${duration.toFixed(1)}ms after ${attempt + 1} attempts`);

          return {
            mintPDA,
            mintBump,
            vanitySeed,
            attempts: attempt + 1,
            duration
          };
        }

        // Yield control more frequently for better responsiveness
        if (attempt % 10000 === 0 && attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, 0));

          if (attempt % 50000 === 0) {
            const elapsed = performance.now() - startTime;
            const rate = attempt / (elapsed / 1000);
            console.log(`⚡ PDA generation progress: ${attempt.toLocaleString()} attempts (${Math.round(rate).toLocaleString()}/sec)`);
          }
        }

      } catch (error) {
        // PDA generation failed for this seed, continue
        continue;
      }
    }

    console.log(`❌ Could not find vanity PDA after ${maxAttempts.toLocaleString()} attempts`);
    return null;
  }

  // Generate random seed for PDA derivation
  private static generateRandomSeed(nonce: number): Buffer {
    // Combine nonce with random data for deterministic but varied seeds
    const randomBytes = new Uint8Array(8);
    crypto.getRandomValues(randomBytes);

    // Mix nonce with random data
    const seed = new Uint8Array(12);
    const nonceBytes = new DataView(new ArrayBuffer(4));
    nonceBytes.setUint32(0, nonce, true);

    seed.set(new Uint8Array(nonceBytes.buffer), 0);
    seed.set(randomBytes, 4);

    return Buffer.from(seed);
  }

  // Pre-generate multiple vanity PDAs for pool
  static async generateVanityPDABatch(
    creator: PublicKey,
    underlyingMint: PublicKey,
    targetPattern: string = 'rift',
    batchSize: number = 5
  ): Promise<VanityPDAResult[]> {

    console.log(`🏭 Generating batch of ${batchSize} vanity PDAs...`);

    const results: VanityPDAResult[] = [];
    const maxAttemptsPerAddress = Math.floor(10000000 / batchSize);

    for (let i = 0; i < batchSize; i++) {
      console.log(`📦 Generating vanity PDA ${i + 1}/${batchSize}...`);

      const result = await this.generateVanityPDA(
        creator,
        underlyingMint,
        targetPattern,
        maxAttemptsPerAddress
      );

      if (result) {
        results.push(result);
        console.log(`✅ Batch item ${i + 1} complete: ${result.mintPDA.toBase58()}`);
      } else {
        console.log(`⚠️ Batch item ${i + 1} failed - continuing with next`);
      }
    }

    console.log(`🎯 Batch complete: ${results.length}/${batchSize} vanity PDAs generated`);
    return results;
  }

  // Verify a PDA can be derived with given parameters
  static verifyVanityPDA(
    creator: PublicKey,
    underlyingMint: PublicKey,
    vanitySeed: Buffer,
    expectedAddress: string
  ): boolean {
    try {
      const [mintPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("rift_mint"),
          creator.toBuffer(),
          underlyingMint.toBuffer(),
          vanitySeed
        ],
        RIFTS_PROGRAM_ID
      );

      return mintPDA.toBase58() === expectedAddress;
    } catch {
      return false;
    }
  }

  // Calculate deterministic PDA for given parameters
  static calculateRiftMintPDA(
    creator: PublicKey,
    underlyingMint: PublicKey,
    vanitySeed: Buffer
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("rift_mint"),
        creator.toBuffer(),
        underlyingMint.toBuffer(),
        vanitySeed
      ],
      RIFTS_PROGRAM_ID
    );
  }
}

// Enhanced vanity PDA pool for instant access
export class VanityPDAPool {
  private static pool: VanityPDAResult[] = [];
  private static isGenerating = false;
  private static readonly POOL_SIZE = 10;

  // Get a vanity PDA from pool
  static getVanityPDA(creator: PublicKey, underlyingMint: PublicKey): VanityPDAResult | null {
    const result = this.pool.shift() || null;

    if (result) {
      console.log(`🎯 Using pooled vanity PDA: ${result.mintPDA.toBase58()} (${this.pool.length} remaining)`);

      // Trigger refill if running low
      if (this.pool.length <= 3) {
        this.refillPool(creator, underlyingMint);
      }
    }

    return result;
  }

  // Refill the pool
  private static async refillPool(creator: PublicKey, underlyingMint: PublicKey) {
    if (this.isGenerating) return;
    this.isGenerating = true;

    console.log('🔄 Refilling vanity PDA pool...');

    try {
      const newPDAs = await VanityPDAGenerator.generateVanityPDABatch(
        creator,
        underlyingMint,
        'rift',
        this.POOL_SIZE - this.pool.length
      );

      this.pool.push(...newPDAs);
      console.log(`✅ Pool refilled: ${this.pool.length}/${this.POOL_SIZE} vanity PDAs ready`);
    } catch (error) {
      console.error('❌ Pool refill failed:', error);
    } finally {
      this.isGenerating = false;
    }
  }

  // Initialize pool
  static async initialize(creator: PublicKey, underlyingMint: PublicKey) {
    if (this.pool.length === 0 && !this.isGenerating) {
      await this.refillPool(creator, underlyingMint);
    }
  }

  // Get pool status
  static getStatus() {
    return {
      poolSize: this.pool.length,
      targetSize: this.POOL_SIZE,
      isGenerating: this.isGenerating
    };
  }
}