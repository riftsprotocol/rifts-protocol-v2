import React from 'react';

export interface LuxuryModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  showSparkles?: boolean;
  zIndex?: number;
}

export const LuxuryModal: React.FC<LuxuryModalProps> = ({
  isOpen,
  onClose,
  children,
  title,
  subtitle,
  size = 'md',
  showSparkles = false,
  zIndex = 100
}) => {
  if (!isOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    // Only close if clicking on the backdrop itself, not the modal content
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // Define size classes for different modal widths with mobile-first responsive design
  const sizeClasses = {
    sm: 'max-w-sm md:max-w-lg',      // Mobile: ~384px, Desktop: ~512px
    md: 'max-w-lg md:max-w-2xl',     // Mobile: ~512px, Desktop: ~672px 
    lg: 'max-w-xl md:max-w-4xl',     // Mobile: ~576px, Desktop: ~896px
    xl: 'max-w-2xl md:max-w-6xl',    // Mobile: ~672px, Desktop: ~1152px
    full: 'max-w-3xl md:max-w-7xl'   // Mobile: ~768px, Desktop: ~1280px
  };

  const modalSizeClass = sizeClasses[size as keyof typeof sizeClasses] || sizeClasses.md;

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-2 md:p-4"
      style={{ zIndex }}
      onClick={handleBackdropClick}
    >
      <div className={`bg-gray-900/95 backdrop-blur-md border border-white/20 rounded-xl p-4 md:p-6 ${modalSizeClass} w-full max-h-[95vh] overflow-y-auto`}>
        <div className="flex justify-between items-center mb-4">
          {title && <h2 className="text-xl font-bold text-white">{title}</h2>}
          <button 
            onClick={onClose}
            className="text-white/70 hover:text-white transition-colors"
          >
            ✕
          </button>
        </div>
        <div className="text-white">{children}</div>
      </div>
    </div>
  );
};