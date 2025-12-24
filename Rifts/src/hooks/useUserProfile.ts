import { useState, useEffect, useCallback } from 'react';

export interface UserProfile {
  walletAddress: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export function useUserProfile(walletAddress: string | null) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch or create user when wallet connects
  useEffect(() => {
    if (!walletAddress) {
      setUser(null);
      return;
    }

    const fetchUser = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/users?wallet=${walletAddress}`);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to fetch user');
        }

        if (data.success && data.user) {
          setUser({
            walletAddress: data.user.wallet_address,
            userId: data.user.user_id,
            createdAt: data.user.created_at,
            updatedAt: data.user.updated_at
          });

          if (data.isNew) {
            console.log('[USER-PROFILE] New user created:', data.user.user_id);
          } else {
            console.log('[USER-PROFILE] Existing user loaded:', data.user.user_id);
          }
        }
      } catch (err) {
        console.error('[USER-PROFILE] Error fetching user:', err);
        setError(err instanceof Error ? err.message : 'Failed to load user');
      } finally {
        setIsLoading(false);
      }
    };

    fetchUser();
  }, [walletAddress]);

  // Update user ID
  const updateUserId = useCallback(async (newUserId: string): Promise<{ success: boolean; error?: string }> => {
    if (!walletAddress) {
      return { success: false, error: 'Wallet not connected' };
    }

    if (!newUserId || newUserId.trim().length === 0) {
      return { success: false, error: 'User ID cannot be empty' };
    }

    try {
      const response = await fetch('/api/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress,
          newUserId: newUserId.trim()
        })
      });

      const data = await response.json();

      if (!response.ok) {
        return { success: false, error: data.error || 'Failed to update user ID' };
      }

      if (data.success && data.user) {
        setUser({
          walletAddress: data.user.wallet_address,
          userId: data.user.user_id,
          createdAt: data.user.created_at,
          updatedAt: data.user.updated_at
        });

        console.log('[USER-PROFILE] User ID updated:', data.user.user_id);
        return { success: true };
      }

      return { success: false, error: 'Unknown error' };
    } catch (err) {
      console.error('[USER-PROFILE] Error updating user ID:', err);
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to update user ID'
      };
    }
  }, [walletAddress]);

  // Check if user ID is available
  const checkUserIdAvailability = useCallback(async (userId: string): Promise<boolean> => {
    if (!userId || userId.trim().length === 0) {
      return false;
    }

    try {
      const response = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: userId.trim() })
      });

      const data = await response.json();
      return data.available === true;
    } catch (err) {
      console.error('[USER-PROFILE] Error checking availability:', err);
      return false;
    }
  }, []);

  return {
    user,
    isLoading,
    error,
    updateUserId,
    checkUserIdAvailability
  };
}
