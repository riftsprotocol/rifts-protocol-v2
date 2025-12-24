/**
 * Input Validation Utilities
 * SECURITY FIX: Prevent invalid inputs from reaching smart contracts
 */

export interface ValidationResult {
  isValid: boolean;
  error?: string;
}

/**
 * Validates token amounts to prevent invalid inputs
 */
export function validateTokenAmount(
  amount: number | string,
  options?: {
    min?: number;
    max?: number;
    decimals?: number;
    fieldName?: string;
  }
): ValidationResult {
  const fieldName = options?.fieldName || 'Amount';
  const min = options?.min ?? 0;
  const max = options?.max ?? Number.MAX_SAFE_INTEGER;
  const decimals = options?.decimals ?? 9;

  // Convert to number if string
  const numAmount = typeof amount === 'string' ? parseFloat(amount) : amount;

  // Check for invalid number types
  if (isNaN(numAmount)) {
    return {
      isValid: false,
      error: `${fieldName} must be a valid number`
    };
  }

  if (!isFinite(numAmount)) {
    return {
      isValid: false,
      error: `${fieldName} must be a finite number`
    };
  }

  // Check for negative values
  if (numAmount < 0) {
    return {
      isValid: false,
      error: `${fieldName} cannot be negative`
    };
  }

  // Check for zero (usually invalid for transactions)
  if (numAmount === 0 && min > 0) {
    return {
      isValid: false,
      error: `${fieldName} must be greater than zero`
    };
  }

  // Check minimum
  if (numAmount < min) {
    return {
      isValid: false,
      error: `${fieldName} must be at least ${min}`
    };
  }

  // Check maximum
  if (numAmount > max) {
    return {
      isValid: false,
      error: `${fieldName} cannot exceed ${max}`
    };
  }

  // Check decimal places
  const decimalPlaces = (numAmount.toString().split('.')[1] || '').length;
  if (decimalPlaces > decimals) {
    return {
      isValid: false,
      error: `${fieldName} can have at most ${decimals} decimal places`
    };
  }

  return { isValid: true };
}

/**
 * Validates percentage inputs (0-100)
 */
export function validatePercentage(
  percentage: number | string,
  options?: {
    min?: number;
    max?: number;
    fieldName?: string;
  }
): ValidationResult {
  const fieldName = options?.fieldName || 'Percentage';
  const min = options?.min ?? 0;
  const max = options?.max ?? 100;

  const numPercentage = typeof percentage === 'string' ? parseFloat(percentage) : percentage;

  if (isNaN(numPercentage) || !isFinite(numPercentage)) {
    return {
      isValid: false,
      error: `${fieldName} must be a valid number`
    };
  }

  if (numPercentage < min || numPercentage > max) {
    return {
      isValid: false,
      error: `${fieldName} must be between ${min} and ${max}`
    };
  }

  return { isValid: true };
}

/**
 * Validates fee basis points (0-10000, where 10000 = 100%)
 */
export function validateFeeBps(
  bps: number | string,
  options?: {
    max?: number;
    fieldName?: string;
  }
): ValidationResult {
  const fieldName = options?.fieldName || 'Fee';
  const max = options?.max ?? 10000;

  const numBps = typeof bps === 'string' ? parseInt(bps) : bps;

  if (isNaN(numBps) || !isFinite(numBps)) {
    return {
      isValid: false,
      error: `${fieldName} must be a valid number`
    };
  }

  if (!Number.isInteger(numBps)) {
    return {
      isValid: false,
      error: `${fieldName} must be a whole number`
    };
  }

  if (numBps < 0 || numBps > max) {
    return {
      isValid: false,
      error: `${fieldName} must be between 0 and ${max} basis points`
    };
  }

  return { isValid: true };
}

/**
 * Validates Solana public key format
 */
export function validatePublicKey(
  address: string,
  fieldName: string = 'Address'
): ValidationResult {
  if (!address || typeof address !== 'string') {
    return {
      isValid: false,
      error: `${fieldName} is required`
    };
  }

  // Basic format check (base58, 32-44 characters)
  if (address.length < 32 || address.length > 44) {
    return {
      isValid: false,
      error: `${fieldName} has invalid length`
    };
  }

  // Check for invalid characters (base58 alphabet)
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
  if (!base58Regex.test(address)) {
    return {
      isValid: false,
      error: `${fieldName} contains invalid characters`
    };
  }

  return { isValid: true };
}

/**
 * Validates slippage tolerance (0-100%)
 */
export function validateSlippage(
  slippage: number | string,
  options?: {
    min?: number;
    max?: number;
    recommended?: number;
  }
): ValidationResult {
  const min = options?.min ?? 0.1;
  const max = options?.max ?? 50;
  const recommended = options?.recommended ?? 1;

  const numSlippage = typeof slippage === 'string' ? parseFloat(slippage) : slippage;

  if (isNaN(numSlippage) || !isFinite(numSlippage)) {
    return {
      isValid: false,
      error: 'Slippage must be a valid number'
    };
  }

  if (numSlippage < min) {
    return {
      isValid: false,
      error: `Slippage must be at least ${min}%`
    };
  }

  if (numSlippage > max) {
    return {
      isValid: false,
      error: `Slippage cannot exceed ${max}%`
    };
  }

  // Warning for high slippage (not an error, but a warning)
  if (numSlippage > recommended * 5) {
    return {
      isValid: true,
      error: `Warning: Slippage of ${numSlippage}% is unusually high (recommended: ${recommended}%)`
    };
  }

  return { isValid: true };
}

/**
 * Sanitizes user input to prevent injection attacks
 */
export function sanitizeInput(input: string, maxLength: number = 1000): string {
  if (typeof input !== 'string') {
    return '';
  }

  // Trim and limit length
  let sanitized = input.trim().slice(0, maxLength);

  // Remove potentially dangerous characters
  sanitized = sanitized.replace(/[<>&"']/g, '');

  return sanitized;
}

/**
 * Validates transaction priority fee
 */
export function validatePriorityFee(
  fee: number | string,
  options?: {
    min?: number;
    max?: number;
  }
): ValidationResult {
  const min = options?.min ?? 0;
  const max = options?.max ?? 1000000; // 0.001 SOL max

  const numFee = typeof fee === 'string' ? parseInt(fee) : fee;

  if (isNaN(numFee) || !isFinite(numFee)) {
    return {
      isValid: false,
      error: 'Priority fee must be a valid number'
    };
  }

  if (!Number.isInteger(numFee)) {
    return {
      isValid: false,
      error: 'Priority fee must be a whole number (lamports)'
    };
  }

  if (numFee < min || numFee > max) {
    return {
      isValid: false,
      error: `Priority fee must be between ${min} and ${max} lamports`
    };
  }

  return { isValid: true };
}
