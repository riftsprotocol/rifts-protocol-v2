import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isValidWalletAddress } from '@/lib/middleware/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// GET - Get or create user by wallet address
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get('wallet');

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Wallet address required' },
        { status: 400 }
      );
    }

    // SECURITY: Validate wallet address format to prevent injection attacks
    if (!isValidWalletAddress(walletAddress)) {
      return NextResponse.json(
        { error: 'Invalid wallet address format' },
        { status: 400 }
      );
    }

    // Check Supabase configuration
    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('[USERS-API] Supabase not configured');
      return NextResponse.json(
        { error: 'Database not configured' },
        { status: 500 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Check if user exists
    const { data: existingUser, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('wallet_address', walletAddress)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      // PGRST116 = no rows returned
      console.error('[USERS-API] Error fetching user:', fetchError);
      return NextResponse.json(
        { error: 'Failed to fetch user' },
        { status: 500 }
      );
    }

    // If user exists, return it
    if (existingUser) {
      return NextResponse.json({
        success: true,
        user: existingUser,
        isNew: false
      });
    }

    // User doesn't exist, create new user with wallet address as initial user_id
    const { data: newUser, error: createError } = await supabase
      .from('users')
      .insert({
        wallet_address: walletAddress,
        user_id: walletAddress // Initial user_id is wallet address
      })
      .select()
      .single();

    if (createError) {
      console.error('[USERS-API] Error creating user:', createError);
      return NextResponse.json(
        { error: 'Failed to create user' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      user: newUser,
      isNew: true
    });

  } catch (error) {
    console.error('[USERS-API] GET error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// PUT - Update user_id
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { walletAddress, newUserId } = body;

    if (!walletAddress || !newUserId) {
      return NextResponse.json(
        { error: 'Wallet address and new user ID required' },
        { status: 400 }
      );
    }

    // SECURITY: Validate wallet address format
    if (!isValidWalletAddress(walletAddress)) {
      return NextResponse.json(
        { error: 'Invalid wallet address format' },
        { status: 400 }
      );
    }

    // Validate user_id format (alphanumeric, dashes, underscores, 3-30 chars)
    const userIdRegex = /^[a-zA-Z0-9_-]{3,30}$/;
    if (!userIdRegex.test(newUserId)) {
      return NextResponse.json(
        { error: 'User ID must be 3-30 characters (letters, numbers, dashes, underscores only)' },
        { status: 400 }
      );
    }

    // Check Supabase configuration
    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('[USERS-API] Supabase not configured');
      return NextResponse.json(
        { error: 'Database not configured' },
        { status: 500 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Check if new user_id is already taken (by someone else)
    const { data: existingUserId, error: checkError } = await supabase
      .from('users')
      .select('wallet_address')
      .eq('user_id', newUserId)
      .single();

    if (checkError && checkError.code !== 'PGRST116') {
      console.error('[USERS-API] Error checking user_id:', checkError);
      return NextResponse.json(
        { error: 'Failed to check user ID availability' },
        { status: 500 }
      );
    }

    if (existingUserId && existingUserId.wallet_address !== walletAddress) {
      return NextResponse.json(
        { error: 'User ID already taken' },
        { status: 409 }
      );
    }

    // Update user_id
    const { data: updatedUser, error: updateError } = await supabase
      .from('users')
      .update({ user_id: newUserId })
      .eq('wallet_address', walletAddress)
      .select()
      .single();

    if (updateError) {
      console.error('[USERS-API] Error updating user_id:', updateError);
      return NextResponse.json(
        { error: 'Failed to update user ID' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      user: updatedUser
    });

  } catch (error) {
    console.error('[USERS-API] PUT error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// POST - Check if user_id is available
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId } = body;

    if (!userId) {
      return NextResponse.json(
        { error: 'User ID required' },
        { status: 400 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data, error } = await supabase
      .from('users')
      .select('user_id')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('[USERS-API] Error checking availability:', error);
      return NextResponse.json(
        { error: 'Failed to check availability' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      available: !data,
      userId
    });

  } catch (error) {
    console.error('[USERS-API] POST error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
