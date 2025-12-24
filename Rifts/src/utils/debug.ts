// Debug utility for conditional logging
export const DEBUG_ENABLED = process.env.NODE_ENV === 'development' || process.env.NEXT_PUBLIC_DEBUG === 'true';

export const debugLog = (...args: unknown[]) => {
  if (DEBUG_ENABLED) {
    console.log(...args);
  }
};

export const debugWarn = (...args: unknown[]) => {
  if (DEBUG_ENABLED) {
    console.warn(...args);
  }
};

export const debugError = (...args: unknown[]) => {
  // Always log errors, even in production
  console.error(...args);
};