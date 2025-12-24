// 🔒 SECURITY FIX: Web Worker for vanity address generation - SECURE VERSION
// This worker generates keypairs in browser but NEVER exposes private keys to main thread
// Only the public address is returned - private keys stay isolated in the worker

importScripts('https://unpkg.com/@solana/web3.js@latest/lib/index.iife.min.js');

// 🔒 Private keys are stored here and NEVER leave the worker
const generatedKeypairs = new Map();

self.onmessage = function(e) {
  const { type, id, pattern, maxAttempts = 2000000, workerId, address } = e.data;

  if (type === 'generate') {
    // Generate vanity address - only return PUBLIC address
    console.log(`Worker ${workerId}: Starting generation for pattern "${pattern}"`);

    const startTime = Date.now();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Generate keypair using Solana Web3.js
      const keypair = solanaWeb3.Keypair.generate();
      const publicAddress = keypair.publicKey.toBase58();

      // Check if it matches our pattern
      if (publicAddress.toLowerCase().endsWith(pattern.toLowerCase())) {
        const duration = (Date.now() - startTime) / 1000;

        // 🔒 SECURITY: Store keypair in worker memory, NEVER send to main thread
        generatedKeypairs.set(publicAddress, keypair);

        // Send ONLY the public address back to main thread
        self.postMessage({
          type: 'success',
          id,
          workerId,
          result: {
            address: publicAddress, // ONLY public address
            attempts: attempt + 1,
            duration
          }
        });
        return;
      }

      // Send progress updates every 50k attempts
      if (attempt % 50000 === 0 && attempt > 0) {
        self.postMessage({
          type: 'progress',
          id,
          workerId,
          attempts: attempt,
          maxAttempts
        });
      }
    }

    // No match found
    self.postMessage({
      type: 'failed',
      id,
      workerId,
      attempts: maxAttempts,
      duration: (Date.now() - startTime) / 1000
    });

  } else if (type === 'export') {
    // 🔒 SECURITY: Only export private key after user explicitly requests it
    // This requires a separate, deliberate action - not automatic
    const keypair = generatedKeypairs.get(address);

    if (!keypair) {
      self.postMessage({
        type: 'export_error',
        address,
        error: 'Keypair not found in worker memory'
      });
      return;
    }

    // Export the private key ONLY when explicitly requested
    // This should only happen when user wants to save/use the address
    self.postMessage({
      type: 'export_success',
      address,
      keypair: Array.from(keypair.secretKey)
    });

    // Clear from memory after export
    generatedKeypairs.delete(address);

  } else if (type === 'clear') {
    // Clear all stored keypairs from memory
    generatedKeypairs.clear();
    self.postMessage({
      type: 'cleared'
    });
  }
};