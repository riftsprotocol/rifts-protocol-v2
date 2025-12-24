import { NextResponse } from 'next/server';

export async function GET() {
  const metadata = {
    name: "rRIFTS",
    symbol: "rRIFTS",
    description: "Wrapped RIFTS token with 0.7% fees and automatic Meteora DLMM pool creation",
    image: "https://app.rifts.finance/PFP3.png"
  };

  return NextResponse.json(metadata, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
    },
  });
}
