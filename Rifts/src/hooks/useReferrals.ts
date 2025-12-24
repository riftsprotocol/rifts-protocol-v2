import { useState, useEffect, useCallback } from 'react';

export interface Referral {
  id: string;
  referrer_wallet: string;
  referred_wallet: string;
  referral_code: string;
  created_at: string;
}

export interface ReferredRift {
  rift_id: string;
  referrer_wallet: string;
  creator_wallet: string;
  created_at: string;
}

export interface ReferralEarning {
  id: string;
  referrer_wallet: string;
  source_type: 'rift_profit' | 'lp_profit';
  source_id: string;
  referred_wallet?: string;
  amount_sol: string;
  created_at: string;
}

export interface ReferralClaim {
  id: string;
  referrer_wallet: string;
  amount_sol: string;
  signature?: string;
  created_at: string;
}

export interface ReferralStats {
  totalReferrals: number;
  totalRiftsFromReferrals: number;
  earningsFromRiftProfits: number;
  earningsFromLpProfits: number;
}

export interface ReferralData {
  referrals: Referral[];
  referredRifts: ReferredRift[];
  earnings: ReferralEarning[];
  claims: ReferralClaim[];
  totalEarned: number;
  totalClaimed: number;
  claimable: number;
  wasReferredBy: Referral | null;
  stats: ReferralStats;
}

export function useReferrals(walletAddress: string | null) {
  const [data, setData] = useState<ReferralData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isClaiming, setIsClaiming] = useState(false);
  const [claimResult, setClaimResult] = useState<{
    success: boolean;
    message: string;
    signature?: string;
  } | null>(null);

  // Fetch referral data
  const fetchReferralData = useCallback(async () => {
    if (!walletAddress) {
      setData(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/referrals?wallet=${walletAddress}`);
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to fetch referral data');
      }

      setData(result);
    } catch (err) {
      console.error('[useReferrals] Error fetching data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load referral data');
    } finally {
      setIsLoading(false);
    }
  }, [walletAddress]);

  // Fetch on wallet change
  useEffect(() => {
    fetchReferralData();
  }, [fetchReferralData]);

  // Record a referral (when user connects with ref link)
  const recordReferral = useCallback(async (referralCode: string): Promise<{ success: boolean; error?: string }> => {
    if (!walletAddress) {
      return { success: false, error: 'Wallet not connected' };
    }

    try {
      const response = await fetch('/api/referrals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          referredWallet: walletAddress,
          referralCode
        })
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        return { success: false, error: result.error || 'Failed to record referral' };
      }

      // Refresh data
      await fetchReferralData();

      return { success: true };
    } catch (err) {
      console.error('[useReferrals] Error recording referral:', err);
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to record referral'
      };
    }
  }, [walletAddress, fetchReferralData]);

  // Claim referral earnings
  const claimEarnings = useCallback(async (): Promise<{ success: boolean; error?: string; signature?: string }> => {
    if (!walletAddress) {
      return { success: false, error: 'Wallet not connected' };
    }

    if (!data || data.claimable <= 0) {
      return { success: false, error: 'Nothing to claim' };
    }

    setIsClaiming(true);
    setClaimResult(null);

    try {
      const response = await fetch('/api/referrals', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: walletAddress })
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        const errorMsg = result.error || 'Failed to claim';
        setClaimResult({ success: false, message: errorMsg });
        return { success: false, error: errorMsg };
      }

      setClaimResult({
        success: true,
        message: `Successfully claimed ${result.amountClaimed.toFixed(4)} SOL`,
        signature: result.signature
      });

      // Refresh data
      await fetchReferralData();

      return { success: true, signature: result.signature };
    } catch (err) {
      console.error('[useReferrals] Error claiming:', err);
      const errorMsg = err instanceof Error ? err.message : 'Failed to claim';
      setClaimResult({ success: false, message: errorMsg });
      return { success: false, error: errorMsg };
    } finally {
      setIsClaiming(false);
    }
  }, [walletAddress, data, fetchReferralData]);

  return {
    data,
    isLoading,
    error,
    isClaiming,
    claimResult,
    fetchReferralData,
    recordReferral,
    claimEarnings,
    clearClaimResult: () => setClaimResult(null)
  };
}
