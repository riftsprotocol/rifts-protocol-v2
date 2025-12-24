'use client';

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

const Header: React.FC = () => {
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [scrolled, setScrolled] = useState<boolean>(false);
  const router = useRouter();

  useEffect(() => {
    const handleScroll = (): void => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const handleNavClick = (item: string): void => {
    const section = document.getElementById(item.toLowerCase());
    if (section) {
      section.scrollIntoView({ behavior: 'smooth' });
    }
    setIsOpen(false);
  };

  const handleLaunchApp = (): void => {
    router.push('/dapp');
  };

  return (
    <motion.header
      initial={{ y: -100 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.5 }}
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled || isOpen ? 'bg-white/5 backdrop-blur-sm border-b border-white/10' : 'bg-transparent'
      }`}
    >
      <div className="container mx-auto px-6 py-2">
        <div className="flex items-center justify-between">
          <motion.div 
            className="flex items-center cursor-pointer h-16 overflow-hidden"
            whileHover={{ scale: 1.05 }}
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          >
            <Image 
              src="/Logo RIFTS.png" 
              alt="RIFTS Protocol Logo" 
              width={240} 
              height={240} 
              className="w-60 h-60 object-contain"
            />
          </motion.div>

          <nav className="hidden md:flex items-center space-x-8 -ml-32">
            {['Protocol'].map((item) => (
              <motion.button
                key={item}
                onClick={() => handleNavClick(item)}
                className="text-white/80 hover:text-white transition-colors font-medium relative group"
                whileHover={{ y: -2 }}
              >
                <span>{item}</span>
                <span className="absolute -bottom-1 left-0 w-full h-0.5 bg-white scale-x-0 group-hover:scale-x-100 transition-transform origin-center duration-300"/>
              </motion.button>
            ))}
          </nav>

          <div className="hidden md:flex items-center space-x-4">
            <Button
              onClick={handleLaunchApp}
              className="bg-white text-black hover:bg-white/90 font-semibold"
            >
              Launch App
            </Button>
          </div>

          <button
            className="md:hidden text-white z-50"
            onClick={() => setIsOpen(!isOpen)}
          >
            {isOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        <motion.div
          initial={false}
          animate={{ height: isOpen ? 'auto' : 0 }}
          className="md:hidden overflow-hidden"
        >
          <nav className="flex flex-col space-y-2 pt-4 pb-2 border-t border-white/10 mt-4">
            {['Protocol'].map((item) => (
              <button
                key={item}
                onClick={() => handleNavClick(item)}
                className="text-white/80 hover:text-white transition-colors text-left text-lg py-3 px-2 rounded-md hover:bg-white/10"
              >
                {item}
              </button>
            ))}
            <Button
              onClick={handleLaunchApp}
              className="bg-white text-black hover:bg-white/90 w-full mt-4"
            >
              Launch App
            </Button>
          </nav>
        </motion.div>
      </div>
    </motion.header>
  );
};

export default Header;