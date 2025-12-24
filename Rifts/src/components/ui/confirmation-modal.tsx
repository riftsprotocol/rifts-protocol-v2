"use client";

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, AlertCircle, CheckCircle, Info, AlertTriangle } from 'lucide-react';
import { LuxuryButton } from './luxury-button';

export interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  type?: 'info' | 'warning' | 'danger' | 'success';
  icon?: React.ReactNode;
  details?: Array<{ label: string; value: string; highlight?: boolean }>;
}

export const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  type = 'info',
  icon,
  details
}) => {
  if (!isOpen) return null;

  const typeConfig = {
    info: {
      iconBg: 'bg-blue-500/20 border-blue-500/30',
      iconColor: 'text-blue-400',
      textColor: 'text-blue-400',
      Icon: Info,
      gradient: 'from-blue-500/20 to-cyan-500/20',
      border: 'border-blue-500/30',
      glow: 'bg-blue-500/20',
      cornerBorder: 'border-blue-500/30'
    },
    warning: {
      iconBg: 'bg-yellow-500/20 border-yellow-500/30',
      iconColor: 'text-yellow-400',
      textColor: 'text-yellow-400',
      Icon: AlertTriangle,
      gradient: 'from-yellow-500/20 to-orange-500/20',
      border: 'border-yellow-500/30',
      glow: 'bg-yellow-500/20',
      cornerBorder: 'border-yellow-500/30'
    },
    danger: {
      iconBg: 'bg-red-500/20 border-red-500/30',
      iconColor: 'text-red-400',
      textColor: 'text-red-400',
      Icon: AlertCircle,
      gradient: 'from-red-500/20 to-pink-500/20',
      border: 'border-red-500/30',
      glow: 'bg-red-500/20',
      cornerBorder: 'border-red-500/30'
    },
    success: {
      iconBg: 'bg-emerald-500/20 border-emerald-500/30',
      iconColor: 'text-emerald-400',
      textColor: 'text-emerald-400',
      Icon: CheckCircle,
      gradient: 'from-emerald-500/20 to-green-500/20',
      border: 'border-emerald-500/30',
      glow: 'bg-emerald-500/20',
      cornerBorder: 'border-emerald-500/30'
    }
  };

  const config = typeConfig[type];
  const IconComponent = icon || <config.Icon className="w-8 h-8" />;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm"
          />

          {/* Modal */}
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ type: "spring", duration: 0.5 }}
              className="relative w-full max-w-md pointer-events-auto"
            >
              {/* Glow effect */}
              <div className={`absolute inset-0 ${config.glow} blur-3xl -z-10`} />

              {/* Content */}
              <div className={`relative bg-gradient-to-br ${config.gradient} border ${config.border} rounded-2xl shadow-2xl overflow-hidden`}>
                {/* Background pattern */}
                <div className="absolute inset-0 opacity-5">
                  <div className="absolute inset-0 bg-gradient-to-br from-white to-transparent" />
                </div>

                {/* Header */}
                <div className="relative p-6 pb-4 border-b border-gray-700/50">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-4">
                      <div className={`flex items-center justify-center w-12 h-12 rounded-xl ${config.iconBg} border`}>
                        <div className={config.iconColor}>
                          {IconComponent}
                        </div>
                      </div>
                      <div>
                        <h3 className="text-xl font-bold text-white">{title}</h3>
                      </div>
                    </div>
                    <button
                      onClick={onClose}
                      className="p-2 transition-colors rounded-lg hover:bg-white/10"
                    >
                      <X className="w-5 h-5 text-gray-400" />
                    </button>
                  </div>
                </div>

                {/* Body */}
                <div className="relative p-6 space-y-4">
                  <p className="text-gray-300">{message}</p>

                  {/* Details */}
                  {details && details.length > 0 && (
                    <div className="p-4 space-y-3 border rounded-xl bg-black/30 border-gray-700/50">
                      {details.map((detail, index) => (
                        <div key={index} className="flex items-center justify-between">
                          <span className="text-sm text-gray-400">{detail.label}</span>
                          <span className={`font-semibold ${detail.highlight ? config.textColor : 'text-white'}`}>
                            {detail.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div className="relative flex gap-3 p-6 pt-4 border-t border-gray-700/50">
                  <LuxuryButton
                    variant="ghost"
                    size="lg"
                    onClick={onClose}
                    fullWidth
                  >
                    {cancelText}
                  </LuxuryButton>
                  <LuxuryButton
                    variant={type === 'danger' ? 'danger' : type === 'success' ? 'success' : 'primary'}
                    size="lg"
                    onClick={() => {
                      onConfirm();
                      onClose();
                    }}
                    fullWidth
                    glow
                  >
                    {confirmText}
                  </LuxuryButton>
                </div>

                {/* Corner decorations */}
                <div className={`absolute top-0 right-0 w-20 h-20 border-t-2 border-r-2 ${config.cornerBorder} rounded-tr-2xl`} />
                <div className={`absolute bottom-0 left-0 w-20 h-20 border-b-2 border-l-2 ${config.cornerBorder} rounded-bl-2xl`} />
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
};
