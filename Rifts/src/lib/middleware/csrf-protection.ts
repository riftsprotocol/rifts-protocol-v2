/**
 * CSRF Protection Middleware
 * SECURITY FIX: Prevent Cross-Site Request Forgery attacks
 */

import { NextRequest, NextResponse } from 'next/server';

// Allowed origins that can call our API
const ALLOWED_ORIGINS = [
  'https://www.rifts.finance',
  'https://rifts.finance',
  'https://app.rifts.finance',
  'https://testrifts-ibh54smbu-kayzen112s-projects.vercel.app', // Your test deployment
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
];

/**
 * Validates that the request comes from an allowed origin
 */
export function validateOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');

  // In development, be more permissive
  if (process.env.NODE_ENV === 'development') {
    // Allow localhost origins
    if (origin?.includes('localhost') || origin?.includes('127.0.0.1')) {
      return true;
    }
  }

  // Check origin header (most reliable)
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return true;
  }

  // Fallback to referer check (less reliable but better than nothing)
  if (referer && ALLOWED_ORIGINS.some(allowed => referer.startsWith(allowed))) {
    return true;
  }

  // Allow requests without origin/referer in development
  if (process.env.NODE_ENV === 'development' && !origin && !referer) {
    return true;
  }

  return false;
}

/**
 * Creates a 403 Forbidden response
 */
export function createForbiddenResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'Forbidden',
      message: 'Invalid origin. This API endpoint can only be accessed from authorized domains.',
    },
    {
      status: 403,
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
}

/**
 * Wrapper function to apply CSRF protection to API routes
 */
export function withCSRFProtection(
  handler: (request: NextRequest) => Promise<NextResponse>
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    // Validate origin
    if (!validateOrigin(request)) {
      console.warn(
        `🚫 CSRF: Blocked request from origin: ${request.headers.get('origin')} | referer: ${request.headers.get('referer')}`
      );
      return createForbiddenResponse();
    }

    // Origin is valid, proceed with the handler
    return handler(request);
  };
}
