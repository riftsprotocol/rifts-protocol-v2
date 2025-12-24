import { NextRequest, NextResponse } from 'next/server';

/**
 * Jito Bundle API Proxy
 * Sends transaction bundles via Jito Block Engine for atomic execution
 */

// Jito Block Engine endpoints (multiple regions for redundancy)
const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

// Jito tip accounts - one of these should receive a tip for the bundle to be processed
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bVmkdzGHkWCkxHmq9b5S1C',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { transactions } = body; // Array of base58 encoded signed transactions

    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return NextResponse.json(
        { error: 'Missing or invalid transactions array' },
        { status: 400 }
      );
    }

    console.log(`[JITO-BUNDLE] ========================================`);
    console.log(`[JITO-BUNDLE] Sending bundle with ${transactions.length} transactions`);
    console.log(`[JITO-BUNDLE] Transaction sizes (base58):`, transactions.map((t, i) => `TX${i+1}: ${t.length} chars`));

    // First, try to simulate the bundle to catch errors before sending
    const simulateEndpoint = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
    try {
      console.log(`[JITO-BUNDLE] Simulating bundle first...`);
      const simResponse = await fetch(simulateEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'simulateBundle',
          params: [{
            encodedTransactions: transactions,
          }],
        }),
      });
      const simText = await simResponse.text();
      console.log(`[JITO-BUNDLE] Bundle simulation response:`, simText.slice(0, 1000));

      const simResult = JSON.parse(simText);
      if (simResult.error) {
        console.log(`[JITO-BUNDLE] ❌ Bundle simulation FAILED:`, JSON.stringify(simResult.error));
      } else if (simResult.result?.value) {
        const simValue = simResult.result.value;
        console.log(`[JITO-BUNDLE] Bundle simulation results:`);
        if (Array.isArray(simValue)) {
          simValue.forEach((txSim: any, i: number) => {
            if (txSim?.err) {
              console.log(`[JITO-BUNDLE]   TX${i+1}: ❌ FAILED - ${JSON.stringify(txSim.err)}`);
              console.log(`[JITO-BUNDLE]   TX${i+1} logs:`, txSim.logs?.slice(-5));
            } else {
              console.log(`[JITO-BUNDLE]   TX${i+1}: ✓ OK (${txSim?.unitsConsumed || '?'} CU)`);
            }
          });
        }
      }
    } catch (simErr: any) {
      console.log(`[JITO-BUNDLE] Bundle simulation error (non-fatal):`, simErr.message);
    }

    // Try each endpoint until one succeeds
    let lastError: string = '';
    let allErrors: string[] = [];

    for (const endpoint of JITO_ENDPOINTS) {
      try {
        console.log(`[JITO-BUNDLE] Trying endpoint: ${endpoint}`);

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendBundle',
            params: [transactions], // Array of base58 transactions
          }),
        });

        const responseText = await response.text();
        console.log(`[JITO-BUNDLE] Response from ${endpoint}:`, responseText);

        if (!response.ok) {
          lastError = responseText;
          allErrors.push(`${endpoint}: HTTP ${response.status} - ${responseText.slice(0, 200)}`);
          continue;
        }

        const result = JSON.parse(responseText);

        if (result.error) {
          const errorMsg = `${result.error.code}: ${result.error.message}`;
          console.log(`[JITO-BUNDLE] ❌ Error from ${endpoint}:`, errorMsg);
          allErrors.push(`${endpoint}: ${errorMsg}`);

          // Check if it's rate limiting - try next endpoint
          if (result.error.code === -32097) {
            console.log(`[JITO-BUNDLE] Rate limited at ${endpoint}, trying next...`);
            lastError = result.error.message;
            continue;
          }
          lastError = JSON.stringify(result.error);
          continue;
        }

        if (result.result) {
          console.log(`[JITO-BUNDLE] ✓ Bundle sent successfully!`);
          console.log(`[JITO-BUNDLE]   Bundle ID: ${result.result}`);
          console.log(`[JITO-BUNDLE]   Endpoint: ${endpoint}`);
          console.log(`[JITO-BUNDLE] ========================================`);
          return NextResponse.json({
            success: true,
            bundleId: result.result,
            endpoint: endpoint,
          });
        }
      } catch (err: any) {
        console.error(`[JITO-BUNDLE] Error with ${endpoint}:`, err.message);
        allErrors.push(`${endpoint}: ${err.message}`);
        lastError = err.message;
        continue;
      }
    }

    // All endpoints failed
    console.error('[JITO-BUNDLE] ❌ All endpoints failed!');
    console.error('[JITO-BUNDLE] Errors:', allErrors);
    console.log(`[JITO-BUNDLE] ========================================`);
    return NextResponse.json(
      { error: 'All Jito endpoints failed', details: lastError, allErrors },
      { status: 503 }
    );

  } catch (error) {
    console.error('[JITO-BUNDLE] Error:', error);
    return NextResponse.json(
      { error: 'Jito bundle failed', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

// GET endpoint to return tip accounts or check bundle status
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const bundleId = searchParams.get('bundleId');

  // If bundleId provided, check bundle status
  if (bundleId) {
    console.log(`[JITO-BUNDLE] Checking status for bundle: ${bundleId}`);

    // Try to get bundle status from Jito - try all endpoints
    const errors: string[] = [];
    for (const baseEndpoint of JITO_ENDPOINTS) {
      try {
        // Use the getBundleStatuses endpoint
        const response = await fetch(baseEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBundleStatuses',
            params: [[bundleId]],
          }),
        });

        const responseText = await response.text();
        console.log(`[JITO-BUNDLE] Status from ${baseEndpoint}:`, responseText.slice(0, 500));

        if (!response.ok) {
          errors.push(`${baseEndpoint}: HTTP ${response.status}`);
          continue;
        }

        const result = JSON.parse(responseText);

        // Check for error response
        if (result.error) {
          errors.push(`${baseEndpoint}: ${result.error.message}`);
          continue;
        }

        // Jito returns { result: { context: {...}, value: [{...}] } }
        // value[0] can be null if bundle not found, or an object with status
        const bundleStatus = result.result?.value?.[0];

        if (bundleStatus) {
          // Bundle found with status
          const status = bundleStatus.confirmation_status || bundleStatus.status || 'pending';
          const landed = status === 'confirmed' || status === 'finalized' || status === 'Landed';

          console.log(`[JITO-BUNDLE] Bundle ${bundleId.slice(0,16)}... status: ${status}, landed: ${landed}`);

          return NextResponse.json({
            bundleId,
            status,
            slot: bundleStatus.slot,
            transactions: bundleStatus.transactions,
            landed,
            endpoint: baseEndpoint,
          });
        } else {
          // value[0] is null - bundle not found on this endpoint yet
          console.log(`[JITO-BUNDLE] Bundle not found on ${baseEndpoint}, trying next...`);
          errors.push(`${baseEndpoint}: bundle not found`);
        }
      } catch (err: any) {
        errors.push(`${baseEndpoint}: ${err.message}`);
        continue;
      }
    }

    // No endpoint had the bundle status
    console.log(`[JITO-BUNDLE] Bundle ${bundleId.slice(0,16)}... not found on any endpoint. Errors:`, errors);
    return NextResponse.json({
      bundleId,
      status: 'pending', // Assume pending if not found (might still land)
      landed: false,
      errors,
    });
  }

  // Default: return tip accounts
  return NextResponse.json({
    tipAccounts: JITO_TIP_ACCOUNTS,
    // Return a random tip account for load balancing
    recommendedTipAccount: JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)],
  });
}
