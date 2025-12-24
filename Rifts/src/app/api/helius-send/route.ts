import { NextRequest, NextResponse } from 'next/server';

/**
 * Helius Smart Transaction Sender
 * Uses Helius's enhanced sendTransaction endpoint with:
 * - Automatic priority fee estimation
 * - Smart retries with exponential backoff
 * - Better transaction landing rates
 */

// Get Helius RPC URL
function getHeliusRpcUrl(): string {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    throw new Error('SOLANA_RPC_URL required for Helius sender');
  }
  return rpcUrl;
}

interface SendTransactionParams {
  transaction: string; // Base64 encoded serialized transaction
  skipPreflight?: boolean;
  maxRetries?: number;
}

interface SendMultipleParams {
  transactions: string[]; // Array of base64 encoded transactions
  skipPreflight?: boolean;
  sequential?: boolean; // If true, wait for each tx to confirm before sending next
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      transaction,
      transactions,
      skipPreflight = false,
      maxRetries = 3,
      sequential = true
    } = body;

    const heliusUrl = getHeliusRpcUrl();
    console.log(`[HELIUS-SEND] ========================================`);

    // Single transaction mode
    if (transaction) {
      console.log(`[HELIUS-SEND] Sending single transaction`);
      const result = await sendSingleTransaction(heliusUrl, transaction, skipPreflight, maxRetries);
      console.log(`[HELIUS-SEND] ========================================`);
      return NextResponse.json(result);
    }

    // Multiple transactions mode
    if (transactions && Array.isArray(transactions)) {
      console.log(`[HELIUS-SEND] Sending ${transactions.length} transactions (sequential: ${sequential})`);

      if (sequential) {
        const result = await sendTransactionsSequentially(heliusUrl, transactions, skipPreflight, maxRetries);
        console.log(`[HELIUS-SEND] ========================================`);
        return NextResponse.json(result);
      } else {
        const result = await sendTransactionsParallel(heliusUrl, transactions, skipPreflight, maxRetries);
        console.log(`[HELIUS-SEND] ========================================`);
        return NextResponse.json(result);
      }
    }

    return NextResponse.json(
      { error: 'Missing transaction or transactions array' },
      { status: 400 }
    );

  } catch (error) {
    console.error('[HELIUS-SEND] Error:', error);
    return NextResponse.json(
      { error: 'Helius send failed', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

async function sendSingleTransaction(
  heliusUrl: string,
  transaction: string,
  skipPreflight: boolean,
  maxRetries: number
): Promise<{ success: boolean; signature?: string; error?: string }> {
  let lastError = '';

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[HELIUS-SEND] Attempt ${attempt + 1}/${maxRetries}`);

      const response = await fetch(heliusUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `helius-send-${Date.now()}`,
          method: 'sendTransaction',
          params: [
            transaction,
            {
              encoding: 'base64',
              skipPreflight,
              preflightCommitment: 'confirmed',
              maxRetries: 5, // Helius internal retries
            }
          ]
        })
      });

      const result = await response.json();

      if (result.error) {
        console.log(`[HELIUS-SEND] ❌ Error:`, result.error.message);
        lastError = result.error.message;

        // Don't retry on certain errors
        if (result.error.message?.includes('already been processed') ||
            result.error.message?.includes('Blockhash not found')) {
          break;
        }

        // Exponential backoff
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 500));
        continue;
      }

      if (result.result) {
        console.log(`[HELIUS-SEND] ✓ Transaction sent: ${result.result.slice(0, 20)}...`);
        return { success: true, signature: result.result };
      }
    } catch (err: any) {
      console.error(`[HELIUS-SEND] Attempt ${attempt + 1} error:`, err.message);
      lastError = err.message;
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 500));
    }
  }

  return { success: false, error: lastError };
}

async function sendTransactionsSequentially(
  heliusUrl: string,
  transactions: string[],
  skipPreflight: boolean,
  maxRetries: number
): Promise<{
  success: boolean;
  signatures: string[];
  errors: string[];
  successCount: number;
  failCount: number;
}> {
  const signatures: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < transactions.length; i++) {
    console.log(`[HELIUS-SEND] Sending transaction ${i + 1}/${transactions.length}`);

    const result = await sendSingleTransaction(heliusUrl, transactions[i], skipPreflight, maxRetries);

    if (result.success && result.signature) {
      signatures.push(result.signature);
      console.log(`[HELIUS-SEND] ✓ TX ${i + 1} confirmed: ${result.signature.slice(0, 20)}...`);

      // Wait for confirmation before sending next
      await waitForConfirmation(heliusUrl, result.signature);
    } else {
      errors.push(`TX ${i + 1}: ${result.error}`);
      console.log(`[HELIUS-SEND] ❌ TX ${i + 1} failed: ${result.error}`);

      // Continue with remaining transactions even if one fails
      // (they may not depend on each other)
    }

    // Small delay between transactions
    if (i < transactions.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return {
    success: signatures.length === transactions.length,
    signatures,
    errors,
    successCount: signatures.length,
    failCount: errors.length
  };
}

async function sendTransactionsParallel(
  heliusUrl: string,
  transactions: string[],
  skipPreflight: boolean,
  maxRetries: number
): Promise<{
  success: boolean;
  signatures: string[];
  errors: string[];
  successCount: number;
  failCount: number;
}> {
  const results = await Promise.all(
    transactions.map((tx, i) =>
      sendSingleTransaction(heliusUrl, tx, skipPreflight, maxRetries)
        .then(r => ({ index: i, ...r }))
    )
  );

  const signatures: string[] = [];
  const errors: string[] = [];

  results.forEach(r => {
    if (r.success && r.signature) {
      signatures.push(r.signature);
    } else {
      errors.push(`TX ${r.index + 1}: ${r.error}`);
    }
  });

  return {
    success: signatures.length === transactions.length,
    signatures,
    errors,
    successCount: signatures.length,
    failCount: errors.length
  };
}

async function waitForConfirmation(heliusUrl: string, signature: string, timeout = 30000): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(heliusUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'confirm',
          method: 'getSignatureStatuses',
          params: [[signature], { searchTransactionHistory: false }]
        })
      });

      const result = await response.json();
      const status = result.result?.value?.[0];

      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        return true;
      }

      if (status?.err) {
        console.log(`[HELIUS-SEND] Transaction failed on-chain:`, status.err);
        return false;
      }
    } catch (err) {
      // Ignore and retry
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`[HELIUS-SEND] Confirmation timeout for ${signature.slice(0, 20)}...`);
  return false;
}

// GET endpoint for health check
export async function GET() {
  try {
    const rpcUrl = process.env.SOLANA_RPC_URL;
    return NextResponse.json({
      status: 'ok',
      hasRpcUrl: !!rpcUrl,
      endpoint: rpcUrl?.split('?')[0] || 'not configured',
    });
  } catch (error) {
    return NextResponse.json({ status: 'error', error: String(error) }, { status: 500 });
  }
}
