import { NextRequest, NextResponse } from 'next/server';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://nitmreqtsnzjylyzwsri.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Treasury wallet for referral payouts
const TREASURY_WALLET = process.env.TREASURY_WALLET || '';
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY || '';

// VIP wallets - always get 10% referral bonus regardless of referral count
const VIP_WALLETS = [
  'H1v8BRhuATZv9ELpYMuaZut5c3UtCKxxgKpFLbVnErWp', // Boosted wallet
];

// Tiered referral rates: 0-4 refs = 5%, 5-9 refs = 8%, 10+ refs = 10%
// VIP wallets always get 10%
function getReferralPercentage(referralCount: number, wallet?: string): number {
  // VIP wallets always get max rate
  if (wallet && VIP_WALLETS.includes(wallet)) {
    return 10;
  }
  if (referralCount >= 10) return 10;
  if (referralCount >= 5) return 8;
  return 5;
}

// Check if wallet is VIP
function isVipWallet(wallet: string): boolean {
  return VIP_WALLETS.includes(wallet);
}

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

// GET - Get referral stats for a wallet
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const wallet = searchParams.get('wallet');

    if (!wallet) {
      return NextResponse.json({ error: 'Wallet required' }, { status: 400 });
    }

    // SECURITY: Validate wallet address format to prevent PostgREST injection
    const { isValidWalletAddress } = await import('@/lib/middleware/api-auth');
    if (!isValidWalletAddress(wallet)) {
      return NextResponse.json({ error: 'Invalid wallet address format' }, { status: 400 });
    }

    // URL-encode the wallet to prevent injection attacks
    const encodedWallet = encodeURIComponent(wallet);

    // Get referrals where this wallet is the referrer (people they referred)
    const referralsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/referrals?referrer_wallet=eq.${encodedWallet}&select=*`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const referrals = referralsResponse.ok ? await referralsResponse.json() : [];

    // Get rifts created by referred users
    const referredRiftsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/referred_rifts?referrer_wallet=eq.${encodedWallet}&select=*`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const referredRifts = referredRiftsResponse.ok ? await referredRiftsResponse.json() : [];

    // Get all earnings for this referrer
    const earningsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/referral_earnings?referrer_wallet=eq.${encodedWallet}&select=*&order=created_at.desc`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const earnings = earningsResponse.ok ? await earningsResponse.json() : [];

    // Get all claims for this referrer
    const claimsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/referral_claims?referrer_wallet=eq.${encodedWallet}&select=*&order=created_at.desc`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const claims = claimsResponse.ok ? await claimsResponse.json() : [];

    // Calculate totals
    const totalEarned = earnings.reduce((sum: number, e: { amount_sol: string }) =>
      sum + parseFloat(e.amount_sol || '0'), 0);
    const totalClaimed = claims.reduce((sum: number, c: { amount_sol: string }) =>
      sum + parseFloat(c.amount_sol || '0'), 0);
    const claimable = totalEarned - totalClaimed;

    // Check if this wallet was referred by someone
    const wasReferredResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/referrals?referred_wallet=eq.${encodedWallet}&select=*`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const wasReferred = wasReferredResponse.ok ? await wasReferredResponse.json() : [];

    // Count ACTIVE referrals (only those who generated earnings count towards tier)
    // Get unique referred wallets from earnings
    const activeReferralWallets = new Set<string>();
    for (const earning of earnings) {
      if (earning.referred_wallet) {
        activeReferralWallets.add(earning.referred_wallet);
      }
    }
    // Also count rifts created by referred users (rift_profit earnings may not have referred_wallet)
    for (const rift of referredRifts) {
      // Find the referred wallet that created this rift
      const referral = referrals.find((r: { referred_wallet: string }) =>
        earnings.some((e: { source_id: string; source_type: string }) =>
          e.source_id === rift.rift_id && e.source_type === 'rift_profit'
        )
      );
      if (referral) {
        activeReferralWallets.add(referral.referred_wallet);
      }
    }
    const activeReferralCount = activeReferralWallets.size;

    // Calculate current referral rate based on ACTIVE referrals (those who generated earnings)
    // VIP wallets always get 10% regardless of referral count
    const isVip = isVipWallet(wallet);
    const currentRate = getReferralPercentage(activeReferralCount, wallet);
    const nextTierRefs = isVip ? null : (activeReferralCount < 5 ? 5 : activeReferralCount < 10 ? 10 : null);
    const nextTierRate = isVip ? null : (activeReferralCount < 5 ? 8 : activeReferralCount < 10 ? 10 : null);

    return NextResponse.json({
      success: true,
      referrals,           // People this wallet referred
      referredRifts,       // Rifts created by referred users
      earnings,            // All earning events
      claims,              // All claim events
      totalEarned,
      totalClaimed,
      claimable,
      wasReferredBy: wasReferred.length > 0 ? wasReferred[0] : null,
      stats: {
        totalReferrals: referrals.length,
        activeReferrals: activeReferralCount,  // Only those who generated earnings
        totalRiftsFromReferrals: referredRifts.length,
        earningsFromRiftProfits: earnings.filter((e: { source_type: string }) => e.source_type === 'rift_profit')
          .reduce((sum: number, e: { amount_sol: string }) => sum + parseFloat(e.amount_sol || '0'), 0),
        earningsFromLpProfits: earnings.filter((e: { source_type: string }) => e.source_type === 'lp_profit')
          .reduce((sum: number, e: { amount_sol: string }) => sum + parseFloat(e.amount_sol || '0'), 0),
        currentRate,           // Current referral rate (5%, 8%, or 10%) based on active referrals
        nextTierRefs,          // Refs needed for next tier (null if at max or VIP)
        nextTierRate,          // Rate at next tier (null if at max or VIP)
        isVip,                 // VIP wallets always get 10% bonus
      }
    });
  } catch (error) {
    console.error('[REFERRALS-API] GET error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch referral data' },
      { status: 500 }
    );
  }
}

// POST - Record new referral relationship
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { referredWallet, referralCode } = body;

    if (!referredWallet || !referralCode) {
      return NextResponse.json(
        { error: 'Referred wallet and referral code required' },
        { status: 400 }
      );
    }

    // Check if this wallet is already referred
    const existingResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/referrals?referred_wallet=eq.${referredWallet}&select=id`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const existing = existingResponse.ok ? await existingResponse.json() : [];

    if (existing.length > 0) {
      return NextResponse.json({
        success: false,
        error: 'Wallet already has a referrer',
        alreadyReferred: true
      });
    }

    // Look up the referral code to get the referrer wallet
    // referral_code can be either a user_id from users table OR a wallet address directly
    let referrerWallet = referralCode;

    // First try to find by user_id
    const userResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/users?user_id=eq.${referralCode}&select=wallet_address`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const users = userResponse.ok ? await userResponse.json() : [];

    if (users.length > 0) {
      referrerWallet = users[0].wallet_address;
    } else {
      // If not found by user_id, check if referralCode is a valid wallet address (32-44 chars, base58)
      const isValidWallet = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(referralCode);
      if (!isValidWallet) {
        return NextResponse.json({
          success: false,
          error: 'Invalid referral code'
        });
      }
      // Use the referralCode directly as the wallet address
      referrerWallet = referralCode;
    }

    // Can't refer yourself
    if (referrerWallet === referredWallet) {
      return NextResponse.json({
        success: false,
        error: 'Cannot refer yourself'
      });
    }

    // Create the referral record
    const createResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/referrals`,
      {
        method: 'POST',
        headers: { ...getHeaders(true), 'Prefer': 'return=representation' },
        body: JSON.stringify({
          referrer_wallet: referrerWallet,
          referred_wallet: referredWallet,
          referral_code: referralCode
        }),
      }
    );

    if (!createResponse.ok) {
      const error = await createResponse.text();
      console.error('[REFERRALS-API] Failed to create referral:', error);
      return NextResponse.json(
        { error: 'Failed to create referral' },
        { status: 500 }
      );
    }

    const referral = await createResponse.json();
    console.log('[REFERRALS-API] Created referral:', referral);

    return NextResponse.json({
      success: true,
      referral: referral[0],
      message: `Referral recorded: ${referredWallet} was referred by ${referrerWallet}`
    });
  } catch (error) {
    console.error('[REFERRALS-API] POST error:', error);
    return NextResponse.json(
      { error: 'Failed to record referral' },
      { status: 500 }
    );
  }
}

// PUT - Claim referral earnings
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { wallet } = body;

    if (!wallet) {
      return NextResponse.json({ error: 'Wallet required' }, { status: 400 });
    }

    // SECURITY: Validate wallet address format to prevent PostgREST injection
    const { isValidWalletAddress } = await import('@/lib/middleware/api-auth');
    if (!isValidWalletAddress(wallet)) {
      return NextResponse.json({ error: 'Invalid wallet address format' }, { status: 400 });
    }

    // URL-encode the wallet to prevent injection attacks
    const encodedWallet = encodeURIComponent(wallet);

    // Get total earnings
    const earningsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/referral_earnings?referrer_wallet=eq.${encodedWallet}&select=amount_sol`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const earnings = earningsResponse.ok ? await earningsResponse.json() : [];
    const totalEarned = earnings.reduce((sum: number, e: { amount_sol: string }) =>
      sum + parseFloat(e.amount_sol || '0'), 0);

    // Get total claimed
    const claimsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/referral_claims?referrer_wallet=eq.${encodedWallet}&select=amount_sol`,
      { headers: getHeaders(), cache: 'no-store' }
    );
    const claims = claimsResponse.ok ? await claimsResponse.json() : [];
    const totalClaimed = claims.reduce((sum: number, c: { amount_sol: string }) =>
      sum + parseFloat(c.amount_sol || '0'), 0);

    const claimable = totalEarned - totalClaimed;

    if (claimable <= 0) {
      return NextResponse.json({
        success: false,
        error: 'Nothing to claim'
      });
    }

    // Transfer SOL from treasury to claimer
    const { PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, bs58, getServerConnection } = await getSolana();

    if (!TREASURY_PRIVATE_KEY) {
      return NextResponse.json({
        success: false,
        error: 'Treasury not configured'
      }, { status: 500 });
    }

    const connection = await getServerConnection();
    const treasuryKeypair = Keypair.fromSecretKey(bs58.decode(TREASURY_PRIVATE_KEY));
    const recipientPubkey = new PublicKey(wallet);

    // Check treasury balance
    const treasuryBalance = await connection.getBalance(treasuryKeypair.publicKey);
    const lamportsToSend = Math.floor(claimable * LAMPORTS_PER_SOL);

    if (treasuryBalance < lamportsToSend + 5000) { // 5000 for fee
      return NextResponse.json({
        success: false,
        error: 'Insufficient treasury balance'
      }, { status: 500 });
    }

    // Create and send transaction
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

    // Record the claim
    await fetch(
      `${SUPABASE_URL}/rest/v1/referral_claims`,
      {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify({
          referrer_wallet: wallet,
          amount_sol: claimable,
          signature
        }),
      }
    );

    console.log('[REFERRALS-API] Claim processed:', { wallet, amount: claimable, signature });

    return NextResponse.json({
      success: true,
      amountClaimed: claimable,
      signature,
      message: `Successfully claimed ${claimable.toFixed(4)} SOL`
    });
  } catch (error) {
    console.error('[REFERRALS-API] PUT error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to claim' },
      { status: 500 }
    );
  }
}

