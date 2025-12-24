'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { Twitter, Github, MessageCircle, FileText, LucideIcon } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

interface LinkItem {
  name?: string;
  url?: string;
}

interface LinkSection {
  title: string;
  items: (string | LinkItem)[];
}

interface SocialButton {
  icon: LucideIcon;
  label: string;
  url?: string;
}

const Footer: React.FC = () => {
  const { toast } = useToast();

  const handleLinkClick = (item: string | LinkItem): void => {
    if (typeof item === 'object' && item.url) {
      window.open(item.url, '_blank');
    } else {
      const name = typeof item === 'string' ? item : item.name || 'Unknown';
      toast({
        title: `🚧 ${name} Link`,
        description: "This feature isn't implemented yet—but don't worry! You can request it in your next prompt! 🚀"
      });
    }
  };

  const links: LinkSection[] = [
    {
      title: 'Protocol',
      items: [
        { name: 'Documentation', url: 'https://rifts.gitbook.io/rifts-docs' },
        'Audits',
        'Bug Bounty'
      ]
    },
    {
      title: 'Community',
      items: [
        { name: 'Twitter', url: 'https://x.com/riftsfinance' },
        { name: 'Telegram', url: 'https://t.me/riftsfinance' }
      ]
    },
    {
      title: 'Developers',
      items: [{ name: 'GitHub', url: 'https://github.com/riftsprotocol' }]
    }
  ];

  const socialButtons: SocialButton[] = [
    { icon: Twitter, label: 'Twitter', url: 'https://x.com/riftsfinance' },
    { icon: Github, label: 'GitHub', url: 'https://github.com/riftsprotocol' },
  ];

  return (
    <footer className="py-20 border-t border-white/10 relative">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-12 mb-12">
          <div className="col-span-2 lg:col-span-2">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              viewport={{ once: true, amount: 0.3 }}
              className="space-y-4"
            >
              <div className="flex items-center space-x-1">
                <img 
                  src="/Logo RIFTS.png" 
                  alt="RIFTS Finance Logo" 
                  className="h-10 md:h-12 object-contain"
                />
              </div>
              <p className="text-white/60 text-sm leading-relaxed max-w-xs">
                Revolutionary volatility farming protocol with institutional-grade security.
              </p>
              <div className="flex space-x-4 pt-2">
                {socialButtons.map((social, index) => (
                  <motion.button
                    key={index}
                    onClick={() => handleLinkClick(social)}
                    whileHover={{ scale: 1.1, y: -2 }}
                    className="w-10 h-10 bg-white/10 rounded-lg flex items-center justify-center hover:bg-white/20 transition-colors"
                  >
                    <social.icon className="w-5 h-5" />
                  </motion.button>
                ))}
              </div>
            </motion.div>
          </div>

          {links.map((section, sectionIndex) => (
            <div key={sectionIndex}>
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: (sectionIndex + 1) * 0.1 }}
                viewport={{ once: true, amount: 0.3 }}
              >
                <h3 className="font-semibold mb-4 text-white">{section.title}</h3>
                <ul className="space-y-3">
                  {section.items.map((item, itemIndex) => (
                    <li key={itemIndex}>
                      <button
                        onClick={() => handleLinkClick(item)}
                        className="text-white/60 hover:text-white transition-colors text-sm"
                      >
                        {typeof item === 'string' ? item : item.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </motion.div>
            </div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.5 }}
          viewport={{ once: true, amount: 0.3 }}
          className="pt-8 border-t border-white/10 text-center"
        >
          <p className="text-white/40 text-sm">
            © {new Date().getFullYear()} RIFTS Protocol. All rights reserved.
          </p>
        </motion.div>
      </div>
    </footer>
  );
};

export default Footer;