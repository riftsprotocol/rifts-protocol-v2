import type { Metadata } from 'next'
import { Poppins } from 'next/font/google'
import './globals.css'

const poppins = Poppins({
  subsets: ['latin'],
  display: 'swap',
  weight: ['400', '500', '600', '700'],
  preload: true
})

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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={poppins.className} suppressHydrationWarning>{children}</body>
    </html>
  )
}
