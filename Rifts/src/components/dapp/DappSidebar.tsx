"use client"

import React, { useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Image from 'next/image';
import { motion } from 'framer-motion';
import {
  LayoutDashboard, Layers, Target, BarChart3, DollarSign
} from 'lucide-react';
import { Sidebar, SidebarBody, SidebarLink } from '@/components/ui/sidebar';
import { IconChartBar, IconFileText, IconWallet } from '@tabler/icons-react';

interface WalletInfo {
  connected: boolean;
  connecting?: boolean;
  isConnecting?: boolean;
  publicKey?: string | null;
  formattedPublicKey?: string;
  connect: () => void;
  disconnect: () => void;
}

interface DappSidebarProps {
  user?: { userId?: string } | null;
  wallet?: WalletInfo;
  onMonoriftsClick?: () => void;
  onTradingClick?: () => void;
}

export default function DappSidebar({ user, wallet, onMonoriftsClick, onTradingClick }: DappSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const sidebarLinks = [
    {
      label: "Dashboard",
      href: "/dapp",
      icon: <LayoutDashboard className="w-5 h-5 shrink-0" />,
      onClick: () => router.push('/dapp'),
      disabled: false,
      comingSoon: false,
    },
    {
      label: "Monorifts",
      href: "#monorifts",
      icon: <Layers className="w-5 h-5 shrink-0" />,
      onClick: onMonoriftsClick || (() => router.push('/dapp')),
      disabled: false,
      comingSoon: false,
    },
    {
      label: "Trading",
      href: "#trading",
      icon: <IconChartBar className="w-5 h-5 shrink-0" />,
      onClick: onTradingClick || (() => router.push('/dapp')),
      disabled: false,
      comingSoon: false,
    },
    {
      label: "Analytics",
      href: "/dapp/dashboard",
      icon: <BarChart3 className="w-5 h-5 shrink-0" />,
      onClick: () => router.push('/dapp/dashboard'),
      disabled: false,
      comingSoon: false,
    },
    {
      label: "Arb Bot",
      href: "/dapp/arb-bot",
      icon: <Target className="w-5 h-5 shrink-0" />,
      onClick: () => router.push('/dapp/arb-bot'),
      disabled: false,
      comingSoon: false,
    },
    {
      label: "Claims",
      href: "/dapp/claims",
      icon: <DollarSign className="w-5 h-5 shrink-0" />,
      onClick: () => router.push('/dapp/claims'),
      disabled: false,
      comingSoon: false,
    },
    {
      label: "Documentation",
      href: "#docs",
      icon: <IconFileText className="w-5 h-5 shrink-0" />,
      onClick: () => window.open('https://rifts.gitbook.io/rifts-docs', '_blank'),
      disabled: false,
      comingSoon: false,
    },
  ];

  return (
    <Sidebar open={sidebarOpen} setOpen={setSidebarOpen}>
      <SidebarBody className="justify-between gap-10">
        <div className={`flex flex-col flex-1 overflow-x-hidden overflow-y-auto ${sidebarOpen ? '-mt-16' : ''}`}>
          {/* Logo */}
          <motion.div
            className={`relative z-10 flex items-center group cursor-pointer ${sidebarOpen ? 'justify-start pl-0 py-4' : 'justify-center py-0'}`}
            whileHover={{ scale: 1.05 }}
            transition={{ type: "spring", stiffness: 400 }}
            onClick={() => window.location.href = 'https://rifts.finance'}
          >
            <Image
              src="/Rifts-logo-greeno.png"
              alt="RIFTS Protocol Logo"
              width={sidebarOpen ? 160 : 60}
              height={sidebarOpen ? 160 : 60}
              className={`${sidebarOpen ? 'w-40 h-40' : 'w-14 h-14'} object-contain drop-shadow-lg transition-all duration-300 group-hover:drop-shadow-xl`}
            />
          </motion.div>

          {/* Navigation */}
          <div className={`flex flex-col gap-2 ${sidebarOpen ? '-mt-16' : 'mt-1'}`}>
            {sidebarLinks.map((link, idx) => {
              const isActive = link.href.startsWith('/') && (
                pathname === link.href ||
                (link.href === '/dapp' && pathname === '/dapp')
              );
              return (
                <div
                  key={idx}
                  onClick={(e) => {
                    e.preventDefault();
                    if (!link.disabled) {
                      link.onClick();
                    }
                  }}
                  className={`relative z-20 group ${link.disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                  title={link.comingSoon ? 'Coming Soon' : ''}
                >
                  {/* Active indicator */}
                  {isActive && (
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-emerald-400 rounded-r-full shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
                  )}
                  <div className={`${link.disabled ? 'opacity-50 pointer-events-none' : ''} ${isActive ? 'bg-emerald-500/10 rounded-lg' : ''}`}>
                    <SidebarLink
                      link={{
                        label: link.label,
                        href: link.href,
                        icon: link.icon
                      }}
                    />
                  </div>
                  {/* Coming Soon tooltip */}
                  {link.comingSoon && (
                    <div className="absolute top-1/2 left-full ml-2 -translate-y-1/2 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-50">
                      <div className="bg-gradient-to-r from-emerald-500 to-blue-500 text-white text-xs font-semibold px-3 py-1.5 rounded-lg shadow-lg whitespace-nowrap">
                        Coming Soon
                        <div className="absolute top-1/2 -left-1 -translate-y-1/2 w-2 h-2 bg-emerald-500 rotate-45"></div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Wallet Connection at bottom */}
        {wallet && (
          <div
            onClick={(e) => {
              e.preventDefault();
              if (!wallet.connected && !wallet.connecting) {
                wallet.connect();
              } else if (wallet.connected) {
                wallet.disconnect();
              }
            }}
            className="cursor-pointer"
          >
            <SidebarLink
              link={{
                label: wallet.connected
                  ? wallet.formattedPublicKey || `${wallet.publicKey?.slice(0, 4)}...${wallet.publicKey?.slice(-4)}`
                  : wallet.connecting || wallet.isConnecting
                    ? "Connecting..."
                    : "Connect Wallet",
                href: "#wallet",
                icon: (
                  <div className="flex items-center justify-center rounded-full h-7 w-7 shrink-0 bg-gradient-to-br from-green-400 to-green-600">
                    {wallet.connecting || wallet.isConnecting ? (
                      <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <IconWallet className="w-4 h-4 text-black" />
                    )}
                  </div>
                ),
              }}
            />
          </div>
        )}
      </SidebarBody>
    </Sidebar>
  );
}
