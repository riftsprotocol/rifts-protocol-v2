// Global connection configuration to ensure all services use proxied connection
import { ProxiedConnection } from './rpc-client';

if (process.env.NODE_ENV === 'development') {
  // console.log('🔗 Creating global proxied connection');
}

// Create singleton connection that routes through /api/rpc proxy
export const globalConnection = new ProxiedConnection();

// Export for use in all services
export default globalConnection;