// hooks/index.ts - Fixed Custom Hooks for Production Integration

"use client";

import { useState, useEffect } from 'react';
import { WalletState, RealTimeData, UserPosition } from '@/types';

// Import production services
import { 
  productionRiftsService,
  riftProtocolService,
  walletService
} from '@/lib/solana';
import { debugError } from '@/utils/debug';

// ==================== REAL-TIME DATA HOOK ====================

export const useRealTimeData = (): RealTimeData => {
  const [data, setData] = useState<RealTimeData>({
    totalTvl: 0,
    volume24h: 0,
    activeRifts: 0,
    riftsPrice: 0,
    totalUsers: 0,
    networkFees: 0
  });

  useEffect(() => {
    const fetchRealTimeData = async () => {
      try {
        // Use production services for real data
        const totalTvl = await productionRiftsService.getTotalTVL();
        const volume24h = await productionRiftsService.getTotal24hVolume();
        const totalUsers = await productionRiftsService.getUniqueUserCount();
        const allRifts = await productionRiftsService.getAllRifts();
        
        setData({
          totalTvl,
          volume24h,
          activeRifts: allRifts.length,
          riftsPrice: 0.001, // Would fetch from DEX API
          totalUsers,
          networkFees: 0 // Would calculate from fee collections
        });
      } catch (error) {
        debugError('Error fetching real-time data:', error);
      }
    };

    // Initial fetch
    fetchRealTimeData();
    
    // Refresh every 30 seconds
    const interval = setInterval(fetchRealTimeData, 30000);
    return () => clearInterval(interval);
  }, []);

  return data;
};

// ==================== USER POSITIONS HOOK ====================

export const useUserPositions = (walletConnected: boolean) => {
  const [positions, setPositions] = useState<UserPosition[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchUserPositions = async () => {
      if (walletConnected) {
        setLoading(true);
        
        try {
          // Get user positions using the production implementation
          const userPubkey = walletService.walletAdapter?.publicKey;
          const realPositions = userPubkey ? await riftProtocolService.getUserPositions(userPubkey) : [];
          
          // Transform to match UserPosition interface
          const transformedPositions = realPositions.map((pos: any) => ({
            riftId: pos.riftId,
            wrapped: pos.amount || 0,
            lpStaked: 0, // LP staking not implemented yet
            rewards: pos.rewards || 0,
            totalValue: pos.value || 0,
            pnl: 0 // Calculate from entry price vs current value
          }));
          
          setPositions(transformedPositions);
        } catch (error) {
          debugError('Error fetching user positions:', error);
          setPositions([]);
        } finally {
          setLoading(false);
        }
      } else {
        setPositions([]);
        setLoading(false);
      }
    };

    fetchUserPositions();
  }, [walletConnected]);

  const addPosition = (position: UserPosition) => {
    setPositions(prev => [...prev, position]);
  };

  const updatePosition = (riftId: string, updates: Partial<UserPosition>) => {
    setPositions(prev => 
      prev.map(pos => 
        pos.riftId === riftId ? { ...pos, ...updates } : pos
      )
    );
  };

  const removePosition = (riftId: string) => {
    setPositions(prev => prev.filter(pos => pos.riftId !== riftId));
  };

  const refreshPositions = async () => {
    if (walletConnected) {
      setLoading(true);
      
      try {
        const userPubkey = walletService.walletAdapter?.publicKey;
        const realPositions = userPubkey ? await riftProtocolService.getUserPositions(userPubkey) : [];
        
        const transformedPositions = realPositions.map((pos: any) => ({
          riftId: pos.riftId,
          wrapped: pos.amount || 0,
          lpStaked: 0,
          rewards: pos.rewards || 0,
          totalValue: pos.value || 0,
          pnl: 0
        }));
        
        setPositions(transformedPositions);
      } catch (error) {
        debugError('Error refreshing user positions:', error);
      } finally {
        setLoading(false);
      }
    }
  };

  return {
    positions,
    loading,
    addPosition,
    updatePosition,
    removePosition,
    refreshPositions
  };
};

// ==================== THEME HOOK ====================

export const useTheme = () => {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [accentColor, setAccentColor] = useState<'blue' | 'purple' | 'emerald'>('blue');

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const changeAccentColor = (color: 'blue' | 'purple' | 'emerald') => {
    setAccentColor(color);
  };

  useEffect(() => {
    // Apply theme to document
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-accent', accentColor);
  }, [theme, accentColor]);

  return {
    theme,
    accentColor,
    toggleTheme,
    changeAccentColor
  };
};

// ==================== LOCAL STORAGE HOOK ====================

export const useLocalStorage = <T>(key: string, initialValue: T) => {
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (typeof window === 'undefined') {
      return initialValue;
    }
    
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      debugError(`Error reading localStorage key "${key}":`, error);
      return initialValue;
    }
  });

  const setValue = (value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(key, JSON.stringify(valueToStore));
      }
    } catch (error) {
      debugError(`Error setting localStorage key "${key}":`, error);
    }
  };

  return [storedValue, setValue] as const;
};

// ==================== DEBOUNCE HOOK ====================

export const useDebounce = <T>(value: T, delay: number): T => {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
};

// ==================== INTERSECTION OBSERVER HOOK ====================

export const useIntersection = (
  elementRef: React.RefObject<Element>,
  threshold: number = 0.1
) => {
  const [isIntersecting, setIsIntersecting] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsIntersecting(entry.isIntersecting);
      },
      { threshold }
    );

    const currentElement = elementRef.current;
    if (currentElement) {
      observer.observe(currentElement);
    }

    return () => {
      if (currentElement) {
        observer.unobserve(currentElement);
      }
    };
  }, [elementRef, threshold]);

  return isIntersecting;
};