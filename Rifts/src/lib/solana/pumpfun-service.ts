/**
 * PumpFun Token Launch Service
 * Handles token creation on pump.fun via PumpPortal API
 */

// PumpPortal API endpoints
const PUMPFUN_IPFS_API = 'https://pump.fun/api/ipfs';

export interface PumpFunTokenMetadata {
  name: string;
  symbol: string;
  description: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

/**
 * Upload token metadata and image to IPFS via pump.fun
 */
export async function uploadMetadata(
  metadata: PumpFunTokenMetadata,
  image: File,
  banner?: File
): Promise<string> {
  const formData = new FormData();
  formData.append('file', image);
  formData.append('name', metadata.name);
  formData.append('symbol', metadata.symbol);
  formData.append('description', metadata.description);
  if (metadata.twitter) formData.append('twitter', metadata.twitter);
  if (metadata.telegram) formData.append('telegram', metadata.telegram);
  if (metadata.website) formData.append('website', metadata.website);
  if (banner) formData.append('banner', banner);
  formData.append('showName', 'true');

  const response = await fetch(PUMPFUN_IPFS_API, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to upload metadata: ${error}`);
  }

  const result = await response.json();
  return result.metadataUri;
}

/**
 * Get token info from pump.fun
 */
export async function getPumpFunTokenInfo(mint: string): Promise<any> {
  try {
    const response = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
