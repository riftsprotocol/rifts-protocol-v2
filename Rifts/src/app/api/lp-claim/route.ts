import { NextRequest, NextResponse } from 'next/server';

/**
 * LP CLAIM ENDPOINT
 *
 * Allows LPs to claim their recorded earnings from the treasury.
 * - Reads accumulated earnings from lp_earnings table
 * - Pays out from treasury wallet
 * - Updates claimed_sol in lp_earnings
 *
 * Also handles referral claims via action=claim-referral.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://nitmreqtsnzjylyzwsri.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Treasury wallet for payouts
const TREASURY_WALLET = process.env.TREASURY_WALLET || '';
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY || '';

// Minimum claim amount (to cover fees)
const MIN_CLAIM_SOL = 0.001;

// Dynamic imports for Solana
const getSolana = async () => {
  const { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
  const bs58 = (await import('bs58')).default;
  const { getServerConnection } = await import('@/lib/solana/server-connection');
  return { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, bs58, getServerConnection };
};

// Helper to get Supabase headers
const getHeaders = (forWrite = false) => {
  const key = forWrite && SUPABASE_SERVICE_KEY ? SUPABASE_SERVICE_KEY : SUPABASE_ANON_KEY;
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
};

// Record treasury payment for audit trail
async function recordTreasuryPayment(params: {
  paymentType: string;
  amountSol: number;
  recipientWallet: string;
  riftId?: string;
  sourceDescription?: string;
  signature?: string;
}) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/treasury_payments`, {
      method: 'POST',
      headers: getHeaders(true),
      body: JSON.stringify({
        payment_type: params.paymentType,
        amount_sol: params.amountSol,
        recipient_wallet: params.recipientWallet,
        rift_id: params.riftId || null,
        source_description: params.sourceDescription || null,
        signature: params.signature || null,
        status: 'confirmed',
      }),
    });
    console.log(`[TREASURY] Recorded ${params.paymentType}: ${params.amountSol.toFixed(6)} SOL to ${params.recipientWallet.slice(0, 8)}...`);
  } catch (err) {
    console.error('[TREASURY] Failed to record payment:', err);
    // Don't throw - payment already succeeded, just logging failed
  }
}

interface LpEarning {
  id: string;
  rift_id: string;
  wallet_address: string;
  total_earned_sol: string;
  claimed_sol: string;
}

// GET - Get claimable amounts for a wallet
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const wallet = searchParams.get('wallet');

    if (!wallet) {
      return NextResponse.json({ error: 'Wallet required' }, { status: 400 });
    }

    // Fetch LP earnings for this wallet
    const lpEarningsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/lp_earnings?wallet_address=eq.${wallet}&select=*`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const lpEarnings: LpEarning[] = lpEarningsResponse.ok ? await lpEarningsResponse.json() : [];

    // Fetch referral earnings for this wallet
    const referralEarningsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/referral_earnings?referrer_wallet=eq.${wallet}&select=*`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const referralEarnings = referralEarningsResponse.ok ? await referralEarningsResponse.json() : [];

    // Fetch referral claims for this wallet
    const referralClaimsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/referral_claims?referrer_wallet=eq.${wallet}&select=*`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const referralClaims = referralClaimsResponse.ok ? await referralClaimsResponse.json() : [];

    // Calculate LP claimable
    let totalLpEarned = 0;
    let totalLpClaimed = 0;
    const lpPositions = lpEarnings.map(lp => {
      const earned = parseFloat(lp.total_earned_sol) || 0;
      const claimed = parseFloat(lp.claimed_sol) || 0;
      totalLpEarned += earned;
      totalLpClaimed += claimed;
      return {
        riftId: lp.rift_id,
        earned,
        claimed,
        claimable: earned - claimed,
      };
    });
    const lpClaimable = totalLpEarned - totalLpClaimed;

    // Calculate referral claimable
    const totalReferralEarned = referralEarnings.reduce(
      (sum: number, e: { amount_sol: string }) => sum + (parseFloat(e.amount_sol) || 0),
      0
    );
    const totalReferralClaimed = referralClaims.reduce(
      (sum: number, c: { amount_sol: string }) => sum + (parseFloat(c.amount_sol) || 0),
      0
    );
    const referralClaimable = totalReferralEarned - totalReferralClaimed;

    // Get treasury balance for display
    let treasuryBalance = 0;
    if (TREASURY_WALLET) {
      try {
        const { PublicKey, LAMPORTS_PER_SOL, getServerConnection } = await getSolana();
        const connection = await getServerConnection();
        treasuryBalance = await connection.getBalance(new PublicKey(TREASURY_WALLET)) / LAMPORTS_PER_SOL;
      } catch (err) {
        console.error('[LP-CLAIM] Failed to get treasury balance:', err);
      }
    }

    return NextResponse.json({
      wallet,
      lp: {
        positions: lpPositions,
        totalEarned: totalLpEarned,
        totalClaimed: totalLpClaimed,
        claimable: lpClaimable,
      },
      referral: {
        totalEarned: totalReferralEarned,
        totalClaimed: totalReferralClaimed,
        claimable: referralClaimable,
        earnings: referralEarnings,
      },
      totalClaimable: lpClaimable + referralClaimable,
      treasuryBalance,
    });
  } catch (error) {
    console.error('[LP-CLAIM] GET error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch claim info' },
      { status: 500 }
    );
  }
}

// POST - Claim earnings
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { wallet, action } = body;

    if (!wallet) {
      return NextResponse.json({ error: 'Wallet required' }, { status: 400 });
    }

    if (!TREASURY_WALLET || !TREASURY_PRIVATE_KEY) {
      return NextResponse.json({ error: 'Treasury not configured' }, { status: 500 });
    }

    const { PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, bs58, getServerConnection } = await getSolana();
    const connection = await getServerConnection();
    const treasuryKeypair = Keypair.fromSecretKey(bs58.decode(TREASURY_PRIVATE_KEY));

    // Handle referral claims
    if (action === 'claim-referral') {
      // Get referral earnings
      const earningsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/referral_earnings?referrer_wallet=eq.${wallet}&select=amount_sol`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const earnings = earningsResponse.ok ? await earningsResponse.json() : [];
      const totalEarned = earnings.reduce(
        (sum: number, e: { amount_sol: string }) => sum + (parseFloat(e.amount_sol) || 0),
        0
      );

      // Get claims
      const claimsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/referral_claims?referrer_wallet=eq.${wallet}&select=amount_sol`,
        { headers: getHeaders(), cache: 'no-store' }
      );
      const claims = claimsResponse.ok ? await claimsResponse.json() : [];
      const totalClaimed = claims.reduce(
        (sum: number, c: { amount_sol: string }) => sum + (parseFloat(c.amount_sol) || 0),
        0
      );

      const claimable = totalEarned - totalClaimed;

      if (claimable < MIN_CLAIM_SOL) {
        return NextResponse.json({
          error: `Nothing to claim. Claimable: ${claimable.toFixed(6)} SOL (min: ${MIN_CLAIM_SOL} SOL)`,
        }, { status: 400 });
      }

      // Check treasury balance
      const treasuryBalance = await connection.getBalance(treasuryKeypair.publicKey);
      const lamportsToSend = Math.floor(claimable * LAMPORTS_PER_SOL);

      if (treasuryBalance < lamportsToSend + 10000) {
        return NextResponse.json({
          error: `Insufficient treasury balance. Treasury: ${(treasuryBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
        }, { status: 500 });
      }

      // Transfer from treasury
      const recipientPubkey = new PublicKey(wallet);
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: treasuryKeypair.publicKey,
          toPubkey: recipientPubkey,
          lamports: lamportsToSend,
        })
      );

      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = treasuryKeypair.publicKey;

      const signature = await connection.sendTransaction(transaction, [treasuryKeypair]);
      await connection.confirmTransaction(signature, 'confirmed');

      // Record the claim in referral_claims table
      await fetch(
        `${SUPABASE_URL}/rest/v1/referral_claims`,
        {
          method: 'POST',
          headers: getHeaders(true),
          body: JSON.stringify({
            referrer_wallet: wallet,
            amount_sol: claimable,
            signature,
          }),
        }
      );

      // Record in unified treasury_payments audit log
      await recordTreasuryPayment({
        paymentType: 'referral_claim',
        amountSol: claimable,
        recipientWallet: wallet,
        sourceDescription: `Referral earnings claim`,
        signature,
      });

      console.log(`[LP-CLAIM] Referral claim: ${wallet} claimed ${claimable.toFixed(6)} SOL, sig: ${signature}`);

      return NextResponse.json({
        success: true,
        type: 'referral',
        amountClaimed: claimable,
        signature,
        message: `Successfully claimed ${claimable.toFixed(4)} SOL in referral earnings`,
      });
    }

    // Default: claim LP earnings
    // Fetch LP earnings for this wallet
    const lpEarningsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/lp_earnings?wallet_address=eq.${wallet}&select=*`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const lpEarnings: LpEarning[] = lpEarningsResponse.ok ? await lpEarningsResponse.json() : [];

    // Calculate total claimable
    let totalClaimable = 0;
    const earningsToUpdate: { id: string; newClaimed: number }[] = [];

    for (const lp of lpEarnings) {
      const earned = parseFloat(lp.total_earned_sol) || 0;
      const claimed = parseFloat(lp.claimed_sol) || 0;
      const claimable = earned - claimed;

      if (claimable > 0.000001) {
        totalClaimable += claimable;
        earningsToUpdate.push({
          id: lp.id,
          newClaimed: earned, // Set claimed = earned (full claim)
        });
      }
    }

    if (totalClaimable < MIN_CLAIM_SOL) {
      return NextResponse.json({
        error: `Nothing to claim. Claimable: ${totalClaimable.toFixed(6)} SOL (min: ${MIN_CLAIM_SOL} SOL)`,
      }, { status: 400 });
    }

    // Check treasury balance
    const treasuryBalance = await connection.getBalance(treasuryKeypair.publicKey);
    const lamportsToSend = Math.floor(totalClaimable * LAMPORTS_PER_SOL);

    if (treasuryBalance < lamportsToSend + 10000) {
      return NextResponse.json({
        error: `Insufficient treasury balance. Treasury: ${(treasuryBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL, Needed: ${totalClaimable.toFixed(4)} SOL`,
      }, { status: 500 });
    }

    // Transfer from treasury to claimant
    const recipientPubkey = new PublicKey(wallet);
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: treasuryKeypair.publicKey,
        toPubkey: recipientPubkey,
        lamports: lamportsToSend,
      })
    );

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = treasuryKeypair.publicKey;

    const signature = await connection.sendTransaction(transaction, [treasuryKeypair]);
    await connection.confirmTransaction(signature, 'confirmed');

    // Update claimed amounts in lp_earnings
    for (const update of earningsToUpdate) {
      await fetch(
        `${SUPABASE_URL}/rest/v1/lp_earnings?id=eq.${update.id}`,
        {
          method: 'PATCH',
          headers: getHeaders(true),
          body: JSON.stringify({
            claimed_sol: update.newClaimed,
            updated_at: new Date().toISOString(),
          }),
        }
      );
    }

    // Record in unified treasury_payments audit log
    // Get rift IDs for the description
    const riftIds = lpEarnings.map(lp => lp.rift_id).join(', ');
    await recordTreasuryPayment({
      paymentType: 'lp_claim',
      amountSol: totalClaimable,
      recipientWallet: wallet,
      sourceDescription: `LP earnings claim from ${earningsToUpdate.length} position(s)`,
      signature,
    });

    console.log(`[LP-CLAIM] LP claim: ${wallet} claimed ${totalClaimable.toFixed(6)} SOL, sig: ${signature}`);

    return NextResponse.json({
      success: true,
      type: 'lp',
      amountClaimed: totalClaimable,
      signature,
      positionsUpdated: earningsToUpdate.length,
      message: `Successfully claimed ${totalClaimable.toFixed(4)} SOL in LP earnings`,
    });
  } catch (error) {
    console.error('[LP-CLAIM] POST error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Claim failed' },
      { status: 500 }
    );
  }
}
