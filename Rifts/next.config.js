/** @type {import('next').NextConfig} */
const nextConfig = {
  // Empty turbopack config to silence Next.js 16 warning (we use webpack config below)
  turbopack: {},

  // Force SWC to respect .browserslistrc so the bundle is downleveled for Safari 16
  // (avoids parsing errors on iOS when vendor chunks contain static class blocks).
  experimental: {
    browsersListForSwc: true,
    legacyBrowsers: true,
  },

  webpack: (config, { isServer, dev }) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };

    // Exclude .node files from webpack bundling (native addons)
    if (isServer) {
      config.externals = config.externals || [];
      // Handle all possible paths to gpu-vanity addon
      config.externals.push({
        '../../../gpu-vanity/index.node': 'commonjs ../../../gpu-vanity/index.node',
        '../../gpu-vanity/index.node': 'commonjs ../../gpu-vanity/index.node',
        './gpu-vanity/index.node': 'commonjs ./gpu-vanity/index.node',
      });
    }

    // Fix for webpack cache corruption and module resolution issues
    if (dev) {
      // Disable webpack cache in development to prevent corruption
      config.cache = false;

      // Use deterministic module IDs for consistent chunk names
      config.optimization = {
        ...config.optimization,
        moduleIds: 'deterministic',
        chunkIds: 'deterministic',
      };
    }

    // Improve chunk splitting to prevent large bundle issues
    config.optimization = {
      ...config.optimization,
      splitChunks: {
        chunks: 'all',
        cacheGroups: {
          default: false,
          vendors: false,
          // Vendor chunk
          vendor: {
            name: 'vendor',
            chunks: 'all',
            test: /node_modules/,
            priority: 20
          },
          // Common chunk
          common: {
            name: 'common',
            minChunks: 2,
            chunks: 'all',
            priority: 10,
            reuseExistingChunk: true,
            enforce: true
          }
        }
      }
    };

    return config;
  },

  // Remove console.* in production builds
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production',
  },

  // Disable image optimization for static export if needed
  images: {
    unoptimized: false,
  },
  // Optimize performance
  reactStrictMode: true,

  // Disable verbose request logging
  logging: {
    fetches: {
      fullUrl: false,
    },
  },

  // Redirect root to /dapp
  async redirects() {
    return [
      {
        source: '/',
        destination: '/dapp',
        permanent: false,
      },
    ];
  },

  // SECURITY FIX: Add security headers including CSP
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'on'
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload'
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN'
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff'
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block'
          },
          {
            key: 'Referrer-Policy',
            value: 'origin-when-cross-origin'
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()'
          },
          // Content Security Policy
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://fonts.googleapis.com https://cpwebassets.codepen.io https://cdnjs.cloudflare.com http://cdnjs.cloudflare.com",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://public.codepenassets.com",
              "font-src 'self' https://fonts.gstatic.com https://fonts.googleapis.com https://fonts.reown.com https://secure.walletconnect.org https://secure.walletconnect.com https://*.walletconnect.org https://*.walletconnect.com https://api.web3modal.org https://api.web3modal.com data:",
              "img-src 'self' data: https: http: blob: https://solochain.io https://api.web3modal.org https://api.web3modal.com https://*.walletconnect.org https://*.walletconnect.com https://walletconnect.org https://walletconnect.com https://tokens-data.1inch.io https://tokens.1inch.io https://cdn.zerion.io",
              "connect-src 'self' http://localhost:3000 http://proxy ws://proxy https://rifts.finance https://app.rifts.finance https://app.rifts.finance/dapp/dapp/rpc https://*.rifts.finance https://*.solana.com https://mainnet.helius-rpc.com https://*.helius-rpc.com https://*.alchemy.com https://*.jup.ag https://quote-api.jup.ag https://token.jup.ag https://*.coingecko.com https://api.coingecko.com https://*.ankr.com https://*.sonic.game https://ipfs.io https://*.ipfs.io wss://*.solana.com wss://mainnet.helius-rpc.com wss://*.helius-rpc.com wss://*.alchemy.com https://*.supabase.co wss://*.supabase.co https://public.codepenassets.com https://cdnjs.cloudflare.com http://cdnjs.cloudflare.com https://api.dexscreener.com https://*.dexscreener.com https://api.web3modal.org https://api.web3modal.com https://rpc.walletconnect.com https://rpc.walletconnect.org https://*.walletconnect.org https://*.walletconnect.com wss://*.walletconnect.org wss://*.walletconnect.com https://relay.walletconnect.org https://relay.walletconnect.com wss://relay.walletconnect.org wss://relay.walletconnect.com https://pulse.walletconnect.com https://pulse.walletconnect.org https://keys.walletconnect.com https://keys.walletconnect.org https://notify.walletconnect.com https://notify.walletconnect.org https://echo.walletconnect.com https://echo.walletconnect.org https://push.walletconnect.com https://push.walletconnect.org wss://www.walletlink.org https://cca-lite.coinbase.com https://*.reown.com https://api.reown.com wss://*.reown.com https://*.solflare.com https://connect.solflare.com wss://*.solflare.com https://*.meteora.ag https://dlmm-api.meteora.ag https://pump.fun https://*.pump.fun https://pumpportal.fun https://*.pumpportal.fun https://frontend-api.pump.fun",
              "frame-src 'self' about: https://secure.walletconnect.org https://secure.walletconnect.com https://verify.walletconnect.org https://verify.walletconnect.com https://secure.reown.com https://verify.reown.com https://*.reown.com https://connect.solflare.com https://*.solflare.com",
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self'"
            ].join('; ')
          }
        ],
      },
    ];
  },
}

module.exports = nextConfig
