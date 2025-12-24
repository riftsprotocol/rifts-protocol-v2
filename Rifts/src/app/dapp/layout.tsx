import type { Metadata } from 'next'
import Script from 'next/script'
import { WalletProvider } from '@/components/wallet/WalletProvider'

export const metadata: Metadata = {
  title: 'RIFTS Protocol - Advanced Volatility Farming',
  description: 'Revolutionary DeFi protocol for volatility farming with advanced risk management and automated yield optimization.',
  metadataBase: new URL('https://app.rifts.finance'),
  icons: {
    icon: '/favicon-96x96.png',
    shortcut: '/favicon-96x96.png',
    apple: '/PFP3.png',
  },
  openGraph: {
    title: 'RIFTS Protocol - Advanced Volatility Farming',
    description: 'Revolutionary DeFi protocol for volatility farming with advanced risk management and automated yield optimization.',
    images: [{ url: '/PFP3.png' }],
    siteName: 'RIFTS Protocol',
  },
}

export default function DappLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <>
      <WalletProvider>
        {children}
      </WalletProvider>
    </>
  )
}
