# Rifts Service Module Structure

This directory contains the modular structure for the Rifts Protocol service.

## Current Structure

```
rifts/
├── index.ts        # Main exports (re-exports from original for backward compat)
├── types.ts        # All types, interfaces, and constants (~170 lines)
├── utils.ts        # Utility functions (decode, oracle, cache helpers) (~400 lines)
└── README.md       # This file
```

## Migration Status

The original `rifts-service.ts` (10,000+ lines) is being split into smaller modules.

### Completed
- ✅ `types.ts` - Types, interfaces, constants
- ✅ `utils.ts` - Decode functions, oracle/risk calculations, cache helpers
- ✅ `index.ts` - Re-exports for backward compatibility

### Planned (requires refactoring)
- `create.ts` - Rift creation methods (createRiftWithVanityPDA, createRiftAndWrapInstructions)
- `wrap.ts` - Wrap/unwrap methods (wrapTokens, unwrapTokens, unwrapFromVault)
- `data.ts` - Data fetching (getAllRifts, getRiftData, prefetch)
- `fees.ts` - Fee distribution (distributeFeesFromVault, claimDexFees)
- `meteora.ts` - Meteora pool methods (createMeteoraPool, addLiquidity, removeLiquidity)
- `instructions.ts` - Instruction builders (createXXXInstruction methods)
- `service.ts` - Main service class coordinator

## Usage

For backward compatibility, continue importing from the original file:
```typescript
import { riftsService, ProductionRiftsService } from '@/lib/solana/rifts-service';
```

Or import from the new module:
```typescript
import { riftsService, ProductionRiftsService } from '@/lib/solana/rifts';
```

## Why Not Fully Split Yet?

The `ProductionRiftsService` class has:
1. **Shared private state** - wallet, connection, caches
2. **Tightly coupled methods** - methods call each other via `this`
3. **Complex dependencies** - methods rely on instance state

Full split requires:
1. Extracting state into a shared context object
2. Converting methods to functions that accept context
3. Using mixins or composition pattern
4. Extensive testing to ensure no regressions
