'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Zap, PiggyBank, Shield, LucideIcon } from 'lucide-react';

interface Step {
  icon: LucideIcon;
  title: string;
  description: string;
  details: string[];
}

interface CodeBlock {
  title: string;
  lang: string;
  code: string;
}

const Protocol: React.FC = () => {
  const steps: Step[] = [
    {
      icon: Zap,
      title: 'Oracle',
      description: 'Exploit-resistant price feeds. Our self-updating oracle eliminates drift during low activity and safeguards liquidity pools against underpriced redemptions.',
      details: ['Real-time market tracking', 'Exploit prevention', 'Liquidity protection']
    },
    {
      icon: PiggyBank,
      title: 'Fees',
      description: 'Built-in buyback engine. 75% of protocol fees are directed to RIFTS buybacks and burns, while 25% fuels long-term ecosystem growth.',
      details: ['Continuous buy pressure', 'Deflationary tokenomics', 'Growth reinvestment']
    },
    {
      icon: Shield,
      title: 'Token Utility',
      description: 'Yield without inflation. $RIFTS derives sustainable value from real economic activity—swaps, arbitrage, and flash loans—powering buybacks and burns with no emissions.',
      details: ['Fee-driven demand', 'Deflationary mechanics', 'Sustainable yield']
    }
  ];

  const codeBlocks: CodeBlock[] = [
    {
      title: 'Oracle Update Structure',
      lang: 'rust',
      code: `pub struct UpdateOracle<'info> {
    #[account(mut)]
    pub rift: Account<'info, Rift>,
    
    pub price_update: Account<'info, JupiterPriceUpdate>,
    
    pub oracle_authority: Signer<'info>,
}`
    },
    {
      title: 'Fee Collection Logic',
      lang: 'rust',
      code: `...collector.total_fees_collected = collector.total_fees_collected
    .checked_add(fee_amount)
    .ok_or(FeeCollectorError::MathOverflow)?;

emit!(FeesCollected {
    rift: ctx.accounts.rift_fee_account.key(),
    amount: fee_amount,
    total_collected: collector.total_fees_collected,
});

Ok(())`
    },
    {
      title: 'Wrap Event',
      lang: 'rust',
      code: `emit!(WrapAndPoolCreated {
    rift: rift.key(),
    user: ctx.accounts.user.key(),
    underlying_amount: amount,
    fee_amount: wrap_fee,
    tokens_minted: rift_tokens_to_user,
    pool_underlying: amount_after_fee,
    pool_rift: initial_rift_amount,
    lp_tokens_minted: rift.lp_token_supply,
    trading_fee_bps,
});`
    },
  ];

  return (
    <section id="protocol" className="py-20 relative overflow-hidden">
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          viewport={{ once: true, amount: 0.5 }}
          className="text-center mb-16"
        >
          <h2 className="text-4xl md:text-5xl font-bold mb-6">
            How It <span className="text-glow">Works</span>
          </h2>
          <p className="text-xl text-white/70 max-w-3xl mx-auto">
            Our protocol leverages a sophisticated three-layer architecture to deliver a seamless volatility farming experience.
          </p>
        </motion.div>

        <div className="max-w-6xl mx-auto">
          {steps.map((step, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, x: index % 2 === 0 ? -50 : 50 }}
              whileInView={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.8, delay: 0.2 }}
              viewport={{ once: true, amount: 0.5 }}
              className={`flex flex-col lg:flex-row items-center gap-12 mb-20 ${
                index % 2 === 1 ? 'lg:flex-row-reverse' : ''
              }`}
            >
              <div className="flex-1 space-y-6">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-white/10 rounded-lg flex items-center justify-center border border-white/20">
                    <step.icon className="w-6 h-6 text-white" />
                  </div>
                  <span className="text-sm font-mono text-white/50">
                    LAYER {String(index + 1).padStart(2, '0')}
                  </span>
                </div>
                
                <h3 className="text-3xl font-bold text-glow">{step.title}</h3>
                <p className="text-lg text-white/70 leading-relaxed">
                  {step.description}
                </p>
                
                <ul className="space-y-2">
                  {step.details.map((detail, detailIndex) => (
                    <li key={detailIndex} className="flex items-center gap-3 text-white/60">
                      <ArrowRight className="w-4 h-4 text-white/40 flex-shrink-0" />
                      <span>{detail}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex-1 w-full">
                <motion.div
                  whileHover={{ scale: 1.05, y: -5 }}
                  className="bg-black/40 border border-white/10 rounded-2xl p-6 backdrop-blur-sm relative overflow-hidden tech-border animated-gradient-border hover:bg-black/20"
                >
                  <div className="scanline-effect" />
                  <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent" />
                  
                  <div className="relative z-10">
                     <p className="font-mono text-white/40 mb-4 text-sm">{codeBlocks[index].title}</p>
                     <pre className="font-mono text-xs sm:text-sm whitespace-pre-wrap text-green-400 overflow-x-auto">
                       <code>{codeBlocks[index].code}</code>
                     </pre>
                   </div>

                  <div className="absolute top-4 right-4 w-2 h-2 bg-white/30 rounded-full pulse-glow" />
                  <div className="absolute bottom-4 left-4 w-1 h-1 bg-white/20 rounded-full float" />
                </motion.div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Protocol;