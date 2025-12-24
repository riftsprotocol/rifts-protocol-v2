import { NextRequest, NextResponse } from 'next/server';
import { getServerClient } from '@/lib/supabase/server-client';
import { getServerConnection } from '@/lib/solana/server-connection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface WrapUnwrapTransaction {
  signature: string;
  type: 'wrap' | 'unwrap';
  rift_address: string;
  vault_address: string;
  amount: number;
  token_symbol: string;
  timestamp: number;
  user_address: string;
}

// GET: Fetch cached transactions for a rift
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const riftAddress = searchParams.get('rift');
    const vaultAddress = searchParams.get('vault');
    const limit = parseInt(searchParams.get('limit') || '20');

    if (!riftAddress && !vaultAddress) {
      return NextResponse.json({ error: 'Missing rift or vault parameter' }, { status: 400 });
    }

    const supabase = getServerClient();

    // Try to get cached transactions from Supabase
    // Filter out failed transactions (amount = 0) - they're not useful to display
    let query = supabase
      .from('wrap_unwrap_history')
      .select('*')
      .gt('amount', 0)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (riftAddress) {
      query = query.eq('rift_address', riftAddress);
    } else if (vaultAddress) {
      query = query.eq('vault_address', vaultAddress);
    }

    const { data: cachedTxs, error } = await query;

    if (error) {
      console.error('[WRAP-UNWRAP-API] Supabase error:', error);
      // If table doesn't exist, return empty array (will trigger fresh fetch)
      return NextResponse.json({ transactions: [], cached: false });
    }

    if (cachedTxs && cachedTxs.length > 0) {
      console.log(`[WRAP-UNWRAP-API] ✅ Returned ${cachedTxs.length} cached transactions`);
      return NextResponse.json({
        transactions: cachedTxs.map(tx => ({
          signature: tx.signature,
          type: tx.type,
          amount: tx.amount,
          token: tx.token_symbol,
          price: 0, // Price not stored
          timestamp: tx.timestamp,
          user: tx.user_address,
          fee: 0
        })),
        cached: true
      });
    }

    // No cached data - return empty and let client know to fetch fresh
    return NextResponse.json({ transactions: [], cached: false });

  } catch (error) {
    console.error('[WRAP-UNWRAP-API] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST: Fetch fresh transactions from blockchain and cache them
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { riftAddress, vaultAddress, tokenSymbol } = body;

    if (!vaultAddress) {
      return NextResponse.json({ error: 'Missing vaultAddress' }, { status: 400 });
    }

    console.log(`[WRAP-UNWRAP-API] 🔄 Fetching fresh transactions for vault: ${vaultAddress}`);

    // Dynamic imports to avoid bundling issues
    const { PublicKey } = await import('@solana/web3.js');
    const connection = await getServerConnection();
    const vaultPubkey = new PublicKey(vaultAddress);

    // Fetch recent signatures (with caching to avoid redundant RPC calls)
    const { getSignaturesWithCache } = await import('@/lib/server-signature-cache');
    const signatures = await getSignaturesWithCache(connection, vaultPubkey, { limit: 100 });
    console.log(`[WRAP-UNWRAP-API] Found ${signatures.length} vault signatures`);

    const transactions: WrapUnwrapTransaction[] = [];
    const failedSignatures: string[] = []; // Track failed txs to remove from cache

    // Filter out failed transactions immediately (saves RPC calls)
    const successfulSigs = signatures.filter(s => !s.err);
    console.log(`[WRAP-UNWRAP-API] ${successfulSigs.length} successful, ${signatures.length - successfulSigs.length} failed`);

    // Parse successful transactions (process up to 25 to avoid timeouts)
    for (const sigInfo of successfulSigs.slice(0, 25)) {
      try {
        const parsedTx = await connection.getParsedTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0
        });

        // Double-check for failed transactions
        if (parsedTx?.meta?.err) {
          console.log(`[WRAP-UNWRAP-API] Skipping failed tx: ${sigInfo.signature}`);
          failedSignatures.push(sigInfo.signature);
          continue;
        }

        let txType: 'wrap' | 'unwrap' = 'wrap';
        let txAmount = 0;
        let userAddress = '';

        // Parse all instructions (both inner and main) for mint/burn/transfer operations
        const allInstructions: any[] = [];

        // Collect inner instructions
        if (parsedTx?.meta?.innerInstructions) {
          for (const innerIxGroup of parsedTx.meta.innerInstructions) {
            allInstructions.push(...innerIxGroup.instructions);
          }
        }

        // Also check main instructions
        if (parsedTx?.transaction?.message?.instructions) {
          allInstructions.push(...parsedTx.transaction.message.instructions);
        }

        for (const ix of allInstructions) {
          const parsed = (ix as any).parsed;
          if (!parsed) continue;

          const info = parsed.info;
          const decimals = info?.tokenAmount?.decimals || 6;

          // Get amount from parsed instruction
          const getAmount = () => {
            if (info?.tokenAmount?.uiAmount !== undefined) {
              return parseFloat(info.tokenAmount.uiAmount);
            } else if (info?.amount) {
              return parseFloat(info.amount) / Math.pow(10, decimals);
            }
            return 0;
          };

          // Detect wrap via mintTo/mintToChecked (minting rift tokens)
          if (parsed.type === 'mintTo' || parsed.type === 'mintToChecked') {
            txType = 'wrap';
            const amount = getAmount();
            if (amount > 0) txAmount = amount;
            userAddress = info?.account || info?.authority || '';
          }

          // Detect unwrap via burn/burnChecked (burning rift tokens)
          if (parsed.type === 'burn' || parsed.type === 'burnChecked') {
            txType = 'unwrap';
            const amount = getAmount();
            if (amount > 0) txAmount = amount;
            userAddress = info?.authority || info?.account || '';
          }

          // Also check transfers to/from vault as backup
          if (parsed.type === 'transfer' || parsed.type === 'transferChecked') {
            const amount = getAmount();

            // Check if vault is destination (wrap) or source (unwrap)
            if (info?.destination === vaultAddress) {
              txType = 'wrap';
              if (amount > 0 && txAmount === 0) txAmount = amount;
              userAddress = info?.authority || info?.source || '';
            } else if (info?.source === vaultAddress) {
              txType = 'unwrap';
              if (amount > 0 && txAmount === 0) txAmount = amount;
              userAddress = info?.destination || '';
            }
          }
        }

        // Always prefer transaction signer as the user address (it's the actual wallet)
        if (parsedTx?.transaction?.message?.accountKeys) {
          const signer = parsedTx.transaction.message.accountKeys.find((k: any) => k.signer);
          if (signer) {
            userAddress = signer.pubkey.toBase58();
          }
        }

        transactions.push({
          signature: sigInfo.signature,
          type: txType,
          rift_address: riftAddress || '',
          vault_address: vaultAddress,
          amount: txAmount,
          token_symbol: tokenSymbol || 'rRIFTS',
          timestamp: (sigInfo.blockTime || Date.now() / 1000) * 1000,
          user_address: userAddress
        });

      } catch (parseError) {
        console.error(`[WRAP-UNWRAP-API] Error parsing tx ${sigInfo.signature}:`, parseError);
        // Add with defaults on parse error
        transactions.push({
          signature: sigInfo.signature,
          type: 'wrap',
          rift_address: riftAddress || '',
          vault_address: vaultAddress,
          amount: 0,
          token_symbol: tokenSymbol || 'rRIFTS',
          timestamp: (sigInfo.blockTime || Date.now() / 1000) * 1000,
          user_address: ''
        });
      }
    }

    const supabase = getServerClient();

    // Delete failed transactions from cache (they shouldn't be displayed)
    if (failedSignatures.length > 0) {
      const { error: deleteError } = await supabase
        .from('wrap_unwrap_history')
        .delete()
        .in('signature', failedSignatures);

      if (deleteError) {
        console.error('[WRAP-UNWRAP-API] Error deleting failed txs:', deleteError);
      } else {
        console.log(`[WRAP-UNWRAP-API] 🗑️ Deleted ${failedSignatures.length} failed transactions from cache`);
      }
    }

    // Save successful transactions to Supabase (upsert to update existing records)
    if (transactions.length > 0) {
      const { error: upsertError } = await supabase
        .from('wrap_unwrap_history')
        .upsert(transactions, {
          onConflict: 'signature',
          ignoreDuplicates: false // Update existing records with improved parsing
        });

      if (upsertError) {
        console.error('[WRAP-UNWRAP-API] Error saving to Supabase:', upsertError);
        // Continue - still return the fetched data
      } else {
        console.log(`[WRAP-UNWRAP-API] ✅ Saved ${transactions.length} transactions to Supabase`);
      }
    }

    return NextResponse.json({
      transactions: transactions.map(tx => ({
        signature: tx.signature,
        type: tx.type,
        amount: tx.amount,
        token: tx.token_symbol,
        price: 0,
        timestamp: tx.timestamp,
        user: tx.user_address,
        fee: 0
      })),
      fetched: transactions.length
    });

  } catch (error) {
    console.error('[WRAP-UNWRAP-API] POST Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
