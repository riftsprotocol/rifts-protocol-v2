'use client'

import dynamic from 'next/dynamic'
import { Suspense } from 'react'

const ChromeGridClient = dynamic(
  () => import('./ChromeGridClient').then((mod) => ({ default: mod.ChromeGridClient })),
  {
    ssr: false,
    loading: () => (
      <div className="fixed inset-0 h-full w-full bg-black z-0">
        <div className="absolute inset-0 bg-gradient-to-br from-gray-900 via-black to-gray-800" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin" />
        </div>
      </div>
    )
  }
)

export function ChromeGrid() {
  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 h-full w-full bg-black z-0">
          <div className="absolute inset-0 bg-gradient-to-br from-gray-900 via-black to-gray-800" />
        </div>
      }
    >
      <ChromeGridClient />
    </Suspense>
  )
}

export default ChromeGrid