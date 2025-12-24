// Persistent cache system for RIFTS Protocol data
// Uses browser storage with automatic cleanup and compression

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
  version: string;
}

interface CacheConfig {
  defaultTTL: number; // Time to live in milliseconds
  maxSize: number; // Maximum cache size in MB
  version: string; // Cache version for invalidation
  compression: boolean; // Enable data compression
}

class PersistentCache {
  private config: CacheConfig;
  private storageKey = 'rifts-protocol-cache';
  private memoryCache = new Map<string, CacheEntry<unknown>>();

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = {
      defaultTTL: 5 * 60 * 1000, // 5 minutes default
      maxSize: 10, // 10MB max
      version: '1.0.0',
      compression: true,
      ...config
    };

    // Load cache from storage on initialization
    this.loadFromStorage();
  }

  async set<T>(key: string, data: T, ttl?: number): Promise<void> {
    const expiresAt = Date.now() + (ttl || this.config.defaultTTL);
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      expiresAt,
      version: this.config.version
    };

    this.memoryCache.set(key, entry);
    await this.saveToStorage();
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.memoryCache.get(key) as CacheEntry<T> | undefined;
    
    if (!entry) {
      return null;
    }

    // Check version compatibility
    if (entry.version !== this.config.version) {
      this.memoryCache.delete(key);
      await this.saveToStorage();
      return null;
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.memoryCache.delete(key);
      await this.saveToStorage();
      return null;
    }

    return entry.data;
  }

  async has(key: string): Promise<boolean> {
    const data = await this.get(key);
    return data !== null;
  }

  async delete(key: string): Promise<void> {
    this.memoryCache.delete(key);
    await this.saveToStorage();
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    try {
      // Check if we're in a browser environment
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.removeItem(this.storageKey);
      }
    } catch (error) {
      console.warn('Could not clear localStorage cache:', error);
    }
  }

  async cleanup(): Promise<void> {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.memoryCache.entries()) {
      if (now > entry.expiresAt || entry.version !== this.config.version) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach(key => this.memoryCache.delete(key));
    
    if (keysToDelete.length > 0) {
      await this.saveToStorage();
      console.log(`🧹 Cleaned up ${keysToDelete.length} expired cache entries`);
    }
  }

  getCacheStats() {
    const entries = Array.from(this.memoryCache.values());
    const now = Date.now();
    
    return {
      totalEntries: entries.length,
      expiredEntries: entries.filter(e => now > e.expiresAt).length,
      validEntries: entries.filter(e => now <= e.expiresAt).length,
      oldestEntry: Math.min(...entries.map(e => e.timestamp)),
      newestEntry: Math.max(...entries.map(e => e.timestamp)),
      approximateSize: this.getApproximateSize()
    };
  }

  private loadFromStorage(): void {
    try {
      // Check if we're in a browser environment
      if (typeof window === 'undefined' || !window.localStorage) {
        return;
      }
      
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        
        // Validate and load entries
        if (parsed && typeof parsed === 'object') {
          for (const [key, entry] of Object.entries(parsed)) {
            if (this.isValidCacheEntry(entry)) {
              this.memoryCache.set(key, entry as CacheEntry<unknown>);
            }
          }
        }
      }
    } catch (error) {
      console.warn('Could not load cache from localStorage:', error);
      // Clear corrupted cache
      this.clear();
    }
  }

  private async saveToStorage(): Promise<void> {
    try {
      // Check if we're in a browser environment
      if (typeof window === 'undefined' || !window.localStorage) {
        return;
      }
      
      // Clean up expired entries before saving
      await this.cleanup();
      
      // Convert map to object for storage
      const cacheObject = Object.fromEntries(this.memoryCache.entries());
      
      // Check size limit
      const size = this.getApproximateSize();
      if (size > this.config.maxSize) {
        console.warn(`Cache size (${size}MB) exceeds limit (${this.config.maxSize}MB), clearing oldest entries`);
        await this.trimCache();
      }
      
      localStorage.setItem(this.storageKey, JSON.stringify(cacheObject));
    } catch (error) {
      console.warn('Could not save cache to localStorage:', error);
      
      // If quota exceeded, try trimming cache
      if (error instanceof Error && error.name === 'QuotaExceededError') {
        await this.trimCache();
        // Try saving again with reduced cache
        try {
          const cacheObject = Object.fromEntries(this.memoryCache.entries());
          if (typeof window !== 'undefined' && window.localStorage) {
            localStorage.setItem(this.storageKey, JSON.stringify(cacheObject));
          }
        } catch (retryError) {
          console.error('Failed to save cache even after trimming:', retryError);
        }
      }
    }
  }

  private async trimCache(): Promise<void> {
    // Remove oldest half of the entries
    const entries = Array.from(this.memoryCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    const toRemove = Math.floor(entries.length / 2);
    for (let i = 0; i < toRemove; i++) {
      this.memoryCache.delete(entries[i][0]);
    }
    
    console.log(`🗑️ Trimmed ${toRemove} oldest cache entries`);
  }

  private isValidCacheEntry(entry: unknown): entry is CacheEntry<unknown> {
    return (
      typeof entry === 'object' &&
      entry !== null &&
      'data' in entry &&
      'timestamp' in entry &&
      'expiresAt' in entry &&
      'version' in entry
    );
  }

  private getApproximateSize(): number {
    try {
      const serialized = JSON.stringify(Object.fromEntries(this.memoryCache.entries()));
      return serialized.length / (1024 * 1024); // Convert to MB
    } catch {
      return 0;
    }
  }
}

// Singleton instance for app-wide use
export const appCache = new PersistentCache({
  defaultTTL: 5 * 60 * 1000, // 5 minutes
  maxSize: 10, // 10MB
  version: '1.0.0',
  compression: false // Disable for now to avoid complexity
});

// Specialized cache instances for different data types
export const riftsCache = new PersistentCache({
  defaultTTL: 5 * 60 * 1000, // 5 minutes for rifts data (refresh every 5 mins from blockchain)
  maxSize: 5,
  version: '2.0.0' // Updated for new program deployment (Nov 7, 2025 - slot 420053855)
});

export const priceCache = new PersistentCache({
  defaultTTL: 2 * 60 * 1000, // 2 minutes for price data
  maxSize: 2,
  version: '2.0.0' // Updated for new program deployment
});

export const userDataCache = new PersistentCache({
  defaultTTL: 30 * 1000, // 30 seconds for user data
  maxSize: 1,
  version: '2.0.0' // Updated for new program deployment
});

// Cache management utilities
export const cacheManager = {
  async clearAll() {
    await Promise.all([
      appCache.clear(),
      riftsCache.clear(),
      priceCache.clear(),
      userDataCache.clear()
    ]);
  },

  async cleanup() {
    await Promise.all([
      appCache.cleanup(),
      riftsCache.cleanup(),
      priceCache.cleanup(),
      userDataCache.cleanup()
    ]);
  },

  getStats() {
    return {
      app: appCache.getCacheStats(),
      rifts: riftsCache.getCacheStats(),
      price: priceCache.getCacheStats(),
      userData: userDataCache.getCacheStats()
    };
  }
};

// Auto-cleanup every 5 minutes
if (typeof window !== 'undefined') {
  setInterval(() => {
    cacheManager.cleanup().catch(console.error);
  }, 5 * 60 * 1000);
}