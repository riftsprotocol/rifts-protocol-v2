/**
 * Vanity PDA Generation Module
 * Extracted from API endpoints for use in background job workers
 */

import { PublicKey } from '@solana/web3.js';
import path from 'path';

const RIFTS_PROGRAM_ID = process.env.NEXT_PUBLIC_RIFTS_PROGRAM_ID || '6FEZJKsxbDm5W4Ad4eogNehivRKKGCHJHRnKUSFbLpKt';

// Try to load native addon, fall back to JS if not available
let nativeGenerator: any = null;
try {
  nativeGenerator = require('../../gpu-vanity/index.node');
  console.log('✅ Loaded native multi-core vanity generator');
} catch (error) {
  console.log('⚠️ Native generator not available, using JS fallback');
}

export interface VanityPDAResult {
  mintPDA: string;
  mintBump: number;
  vanitySeed: string;
  creator: string;
  underlyingMint: string;
  generated: number;
  attempts?: number;
}

/**
 * Generate vanity PDA using native accelerated generator
 */
export async function generateVanityPDAFast(
  creator: PublicKey,
  underlyingMint: PublicKey,
  targetPattern: string,
  maxAttempts: number = 5000000
): Promise<VanityPDAResult | null> {
  if (!nativeGenerator) {
    console.log('⚠️ Native generator not available, falling back to JS');
    return generateVanityPDAJS(creator, underlyingMint, targetPattern, maxAttempts);
  }

  const startTime = Date.now();

  try {
    const result = nativeGenerator.generateVanityPDA(
      RIFTS_PROGRAM_ID,
      creator.toBase58(),
      underlyingMint.toBase58(),
      targetPattern,
      maxAttempts
    );

    const duration = Date.now() - startTime;
    console.log(`⚡ Generated PDA in ${(duration/1000).toFixed(2)}s (${result.attempts} attempts, ~${Math.round(result.attempts/(duration/1000))}/sec)`);

    return {
      mintPDA: result.pda,
      mintBump: result.bump,
      vanitySeed: result.seed,
      creator: creator.toBase58(),
      underlyingMint: underlyingMint.toBase58(),
      generated: Date.now(),
      attempts: result.attempts
    };
  } catch (error) {
    console.error('❌ Native generation failed:', error);
    return null;
  }
}

/**
 * Fallback JavaScript implementation (slower but guaranteed to work)
 */
async function generateVanityPDAJS(
  creator: PublicKey,
  underlyingMint: PublicKey,
  targetPattern: string,
  maxAttempts: number
): Promise<VanityPDAResult | null> {
  const startTime = Date.now();
  const PROGRAM_ID = new PublicKey(RIFTS_PROGRAM_ID);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const vanitySeed = Buffer.from(
      Array.from({ length: 12 }, () => Math.floor(Math.random() * 256))
    );

    try {
      const [mintPDA, mintBump] = PublicKey.findProgramAddressSync([
        Buffer.from("rift_mint"),
        creator.toBuffer(),
        underlyingMint.toBuffer(),
        vanitySeed
      ], PROGRAM_ID);

      const address = mintPDA.toBase58();

      if (targetPattern === '' || address.toLowerCase().endsWith(targetPattern.toLowerCase())) {
        const duration = Date.now() - startTime;
        console.log(`⚡ JS fallback: Generated "${targetPattern}" in ${(duration/1000).toFixed(1)}s`);

        return {
          mintPDA: mintPDA.toBase58(),
          mintBump,
          vanitySeed: vanitySeed.toString('hex'),
          creator: creator.toBase58(),
          underlyingMint: underlyingMint.toBase58(),
          generated: Date.now(),
          attempts: attempt
        };
      }
    } catch (error) {
      continue;
    }
  }

  return null;
}
