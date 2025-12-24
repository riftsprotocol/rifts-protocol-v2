import { NextRequest } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import { getHeliusHttpRpcUrl } from '@/lib/solana/rpc-endpoints';

export const runtime = 'nodejs';

/**
 * Server-Sent Events bridge for account subscriptions (LaserStream-compatible).
 * Usage: GET /api/laserstream-sse?accounts=addr1,addr2
 * Keeps the API key server-side and streams account change notifications.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const accountsParam = searchParams.get('accounts');

  if (!accountsParam) {
    return new Response('accounts query param required', { status: 400 });
  }

  const accountKeys = accountsParam
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (accountKeys.length === 0) {
    return new Response('no accounts provided', { status: 400 });
  }

  // Use HTTP polling (getMultipleAccounts) to avoid WS restrictions on Vercel/Phantom
  let endpoint: string;
  try {
    endpoint = getHeliusHttpRpcUrl();
  } catch (err) {
    endpoint = 'https://api.mainnet-beta.solana.com';
    console.error('[laserstream-sse] getHeliusHttpRpcUrl failed:', (err as Error)?.message);
  }
  // Ensure https scheme for mixed-content safety
  if (endpoint.startsWith('http://')) {
    endpoint = endpoint.replace('http://', 'https://');
  }

  const encoder = new TextEncoder();
  let polling = true;

  const stream = new ReadableStream({
    async start(controller) {
      // Surface the endpoint in the stream for debugging
      controller.enqueue(encoder.encode(`event: info\ndata: ${JSON.stringify({ endpoint })}\n\n`));
      controller.enqueue(encoder.encode('event: open\ndata: "ok"\n\n'));

      // Poll accounts via JSON-RPC getMultipleAccounts every 2s
      const poll = async () => {
        if (!polling) return;
        try {
          const body = {
            jsonrpc: '2.0',
            id: 1,
            method: 'getMultipleAccounts',
            params: [accountKeys, { encoding: 'base64', commitment: 'confirmed' }],
          };
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            controller.enqueue(
              encoder.encode(`event: error\ndata: ${JSON.stringify({ error: `rpc ${res.status}` })}\n\n`)
            );
          } else {
            const json = await res.json();
            if (json?.result?.value) {
              json.result.value.forEach((acc: any, idx: number) => {
                if (acc) {
                  const payload = JSON.stringify({
                    account: accountKeys[idx],
                    data: acc.data?.[0],
                    lamports: acc.lamports,
                    owner: acc.owner,
                    executable: acc.executable,
                    rentEpoch: acc.rentEpoch,
                  });
                  controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
                }
              });
            }
          }
        } catch (err) {
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ error: (err as Error)?.message })}\n\n`)
          );
        } finally {
          if (polling) {
            setTimeout(poll, 2000);
          }
        }
      };
      poll();
    },
    async cancel() {
      polling = false;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
