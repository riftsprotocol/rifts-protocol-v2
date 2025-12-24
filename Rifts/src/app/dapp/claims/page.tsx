// Force dynamic rendering to avoid SSG issues with wallet hooks
export const dynamic = 'force-dynamic';

import ClaimsClient from './ClaimsClient';

export default function ClaimsPage() {
  return <ClaimsClient />;
}
