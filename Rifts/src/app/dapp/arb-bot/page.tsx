// Force dynamic rendering to avoid SSG issues with wallet hooks
export const dynamic = 'force-dynamic';

import ArbBotClient from './ArbBotClient';

export default function ArbBotPage() {
  return <ArbBotClient />;
}
