// Cache Monitor Component - Shows cache statistics in development mode
import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Database, Trash2, RefreshCw } from 'lucide-react';
import { cacheManager } from '@/lib/cache/persistent-cache';

interface CacheStats {
  totalEntries: number;
  expiredEntries: number;
  validEntries: number;
  oldestEntry: number;
  newestEntry: number;
  approximateSize: number;
}

interface AllCacheStats {
  app: CacheStats;
  rifts: CacheStats;
  price: CacheStats;
  userData: CacheStats;
}

export const CacheMonitor: React.FC<{ enabled?: boolean }> = ({ 
  enabled = process.env.NODE_ENV === 'development' 
}) => {
  const [stats, setStats] = useState<AllCacheStats | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    const updateStats = () => {
      setStats(cacheManager.getStats());
    };

    // Update every 5 seconds
    updateStats();
    const interval = setInterval(updateStats, 5000);

    return () => clearInterval(interval);
  }, [enabled]);

  const handleClearAll = async () => {
    await cacheManager.clearAll();
    setStats(cacheManager.getStats());
  };

  const handleCleanup = async () => {
    await cacheManager.cleanup();
    setStats(cacheManager.getStats());
  };

  if (!enabled || !stats) {
    return null;
  }

  const totalEntries = Object.values(stats).reduce((sum, cache) => sum + cache.totalEntries, 0);
  const totalSize = Object.values(stats).reduce((sum, cache) => sum + cache.approximateSize, 0);

  return (
    <motion.div
      className="fixed bottom-4 left-4 z-50"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="bg-gray-900/95 border border-gray-700 rounded-lg shadow-xl backdrop-blur-sm">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 p-3 text-white hover:bg-gray-800/50 rounded-lg transition-colors"
        >
          <Database className="w-4 h-4" />
          <span className="text-sm font-medium">Cache: {totalEntries} entries</span>
          <span className="text-xs text-gray-400">({totalSize.toFixed(1)}MB)</span>
        </button>

        {isOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="border-t border-gray-700 p-3 space-y-2"
          >
            {Object.entries(stats).map(([cacheType, cacheStats]) => (
              <div key={cacheType} className="text-xs">
                <div className="flex justify-between items-center">
                  <span className="text-gray-300 capitalize">{cacheType}:</span>
                  <span className="text-white">
                    {cacheStats.validEntries}/{cacheStats.totalEntries}
                  </span>
                </div>
                {cacheStats.expiredEntries > 0 && (
                  <div className="text-yellow-400 text-xs">
                    {cacheStats.expiredEntries} expired
                  </div>
                )}
              </div>
            ))}
            
            <div className="flex gap-2 pt-2 border-t border-gray-700">
              <button
                onClick={handleCleanup}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
              >
                <RefreshCw className="w-3 h-3" />
                Cleanup
              </button>
              <button
                onClick={handleClearAll}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
              >
                <Trash2 className="w-3 h-3" />
                Clear All
              </button>
            </div>
          </motion.div>
        )}
      </div>
    </motion.div>
  );
};

export default CacheMonitor;