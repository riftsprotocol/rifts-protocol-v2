"use client";
import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { Minimize2, Maximize2, X } from "lucide-react";
import { TypeAnimation } from "react-type-animation";

interface TerminalProps {
  className?: string;
}

export const Terminal: React.FC<TerminalProps> = ({ className }) => {
  const [isMinimized, setIsMinimized] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const terminalRef = useRef<HTMLDivElement>(null);

  const commands = [
    { 
      command: "$ initializing-protocol", 
      response: "✓ RIFTS Protocol initialized successfully",
      delay: 1000
    },
    { 
      command: "$ connect-oracle", 
      response: "✓ Oracle connection established\n✓ Price feeds active\n✓ Risk metrics synchronized",
      delay: 1500
    },
    { 
      command: "$ deploy-strategy-engine", 
      response: "✓ Strategy engine deployed\n✓ Algorithm validation complete\n✓ Portfolio optimization ready",
      delay: 2000
    },
    { 
      command: "$ activate-yield-distribution", 
      response: "✓ Yield distribution activated\n✓ Reward pools configured\n✓ Auto-compounding enabled",
      delay: 2500
    },
    { 
      command: "$ protocol-status", 
      response: "✓ All systems operational\n✓ TVL: $2.4M\n✓ APY: 12.5%\n✓ Active strategies: 3",
      delay: 3000
    }
  ];

  useEffect(() => {
    const timer = setTimeout(() => {
      if (currentStep < commands.length - 1) {
        setCurrentStep(currentStep + 1);
      }
    }, commands[currentStep]?.delay || 2000);

    return () => clearTimeout(timer);
  }, [currentStep, commands]);

  const toggleMinimize = () => {
    setIsMinimized(!isMinimized);
  };

  return (
    <motion.div
      ref={terminalRef}
      className={`bg-black/90 border border-green-500/30 rounded-lg shadow-2xl backdrop-blur-sm ${className}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      <div className="bg-gray-800/50 px-4 py-2 flex items-center justify-between border-b border-green-500/20 rounded-t-lg">
        <div className="flex items-center space-x-2">
          <div className="flex space-x-2">
            <div className="w-3 h-3 bg-red-500 rounded-full"></div>
            <div className="w-3 h-3 bg-yellow-500 rounded-full"></div>
            <div className="w-3 h-3 bg-green-500 rounded-full"></div>
          </div>
          <span className="text-green-400 text-sm font-mono ml-4">rifts-protocol-terminal</span>
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={toggleMinimize}
            className="text-gray-400 hover:text-white transition-colors"
          >
            {isMinimized ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
          </button>
          <button className="text-gray-400 hover:text-red-400 transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>
      
      <motion.div
        className="p-4 font-mono text-sm"
        animate={{ height: isMinimized ? 0 : "auto" }}
        style={{ overflow: "hidden" }}
      >
        <div className="text-green-400 space-y-2">
          <div className="text-gray-500">RIFTS Protocol v1.0.0</div>
          <div className="text-gray-500">Volatility Management System</div>
          <div className="border-b border-gray-700 my-2"></div>
          
          {commands.slice(0, currentStep + 1).map((cmd, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: index * 0.5 }}
            >
              <div className="flex items-center">
                <span className="text-blue-400 mr-2">rifts@protocol:~</span>
                <TypeAnimation
                  sequence={[cmd.command]}
                  wrapper="span"
                  speed={50}
                  className="text-green-300"
                  cursor={false}
                />
              </div>
              <div className="text-gray-300 ml-6 mt-1 whitespace-pre-line">
                {cmd.response}
              </div>
              {index < currentStep && <div className="my-2"></div>}
            </motion.div>
          ))}
          
          {currentStep === commands.length - 1 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1 }}
              className="flex items-center mt-4"
            >
              <span className="text-blue-400 mr-2">rifts@protocol:~</span>
              <span className="text-green-300">|</span>
              <motion.div
                className="w-2 h-5 bg-green-400 ml-1"
                animate={{ opacity: [1, 0] }}
                transition={{ duration: 1, repeat: Infinity }}
              />
            </motion.div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
};