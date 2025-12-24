import { NextRequest, NextResponse } from 'next/server';
import { getHeliusHttpRpcUrl } from '@/lib/solana/rpc-endpoints';

// Lightweight HTTP RPC bridge (avoids LaserStream native bindings during build)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const method = body?.method;
    const params = body?.params;

    if (method !== 'getBalance' || !Array.isArray(params) || !params[0]) {
      return NextResponse.json(
        { error: 'Unsupported method', method },
        { status: 400 }
      );
    }

    const pubkey = String(params[0]);

    // Build standard JSON-RPC payload
    const rpcBody = {
      jsonrpc: '2.0',
      id: body?.id ?? Date.now(),
      method: 'getBalance',
      params: [pubkey, { commitment: 'confirmed' }]
    };

    const rpcUrl = getHeliusHttpRpcUrl();
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(rpcBody),
    });

    const text = await resp.text();
    const contentType = resp.headers.get('content-type') || '';
    if (resp.status >= 400 || !contentType.includes('json') || !text) {
      return NextResponse.json(
        { error: 'RPC error', status: resp.status, body: text.slice(0, 200) },
        { status: 502 }
      );
    }

    const data = JSON.parse(text);
    return NextResponse.json(data, { status: resp.status });
  } catch (error) {
    return NextResponse.json(
      { error: 'LaserStream JSON bridge failed', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
