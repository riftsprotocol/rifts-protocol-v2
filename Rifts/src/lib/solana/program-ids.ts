/**
 * RIFTS Protocol Program IDs
 * Centralized configuration for all program addresses
 * Values come from environment variables for easy mainnet/devnet switching
 */

export const PROGRAM_IDS = {
  // Main RIFTS program (V2)
  rifts: process.env.NEXT_PUBLIC_RIFTS_PROGRAM_ID || '6FEZJKsxbDm5W4Ad4eogNehivRKKGCHJHRnKUSFbLpKt',

  // Legacy RIFTS program (V1) - for backward compatibility
  riftsV1: process.env.NEXT_PUBLIC_RIFTS_V1_PROGRAM_ID || '9qomJJ5jMzaKu9JXgMzbA3KEyQ3kqcW7hN3xq3tMEkww',

  // Governance program
  governance: process.env.NEXT_PUBLIC_GOVERNANCE_PROGRAM_ID || 'EbVBCs4g7MQo7iDAtVcZhmV9FMq37JKah3iheLpqJbPo',

  // Fee collector program
  feeCollector: process.env.NEXT_PUBLIC_FEE_COLLECTOR_PROGRAM_ID || '4eZJyc7bPFQ7FcjBF5S5xkGJjaqHs3BaHR4oXUMa7rf9',

  // LP Staking program
  lpStaking: process.env.NEXT_PUBLIC_LP_STAKING_PROGRAM_ID || 'CXPzLmqnVdhS8corDDceLUdPMF3xM8XZg1viQLqwP4ru',

  // RIFTS token mint
  riftsToken: process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || process.env.NEXT_PUBLIC_RIFTS_TOKEN_MINT || 'HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump',

  // Protocol authority (deployer wallet)
  authority: process.env.NEXT_PUBLIC_PROTOCOL_AUTHORITY || '9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4',
} as const;

// Legacy constant for backward compatibility
export const RIFTS_PROGRAM_ID = PROGRAM_IDS.rifts;

// Type-safe helper to get program ID
export function getProgramId(program: keyof typeof PROGRAM_IDS): string {
  return PROGRAM_IDS[program];
}

// Validate all required program IDs are set
export function validateProgramIds(): boolean {
  const missing: string[] = [];

  Object.entries(PROGRAM_IDS).forEach(([key, value]) => {
    if (!value || value.length < 32) {
      missing.push(key);
    }
  });

  if (missing.length > 0) {
    console.error('❌ Missing or invalid program IDs:', missing);
    return false;
  }

  console.log('✅ All program IDs validated');
  return true;
}

// Log configuration on module load
if (typeof window !== 'undefined') {
  console.log('📋 RIFTS Program IDs:', {
    rifts: PROGRAM_IDS.rifts.slice(0, 8) + '...',
    governance: PROGRAM_IDS.governance.slice(0, 8) + '...',
    feeCollector: PROGRAM_IDS.feeCollector.slice(0, 8) + '...',
    lpStaking: PROGRAM_IDS.lpStaking.slice(0, 8) + '...',
    riftsToken: PROGRAM_IDS.riftsToken.slice(0, 8) + '...',
    authority: PROGRAM_IDS.authority.slice(0, 8) + '...',
  });
}
