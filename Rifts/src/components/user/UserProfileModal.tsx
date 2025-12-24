import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Check, AlertCircle, Copy, Loader2, Link2, Share2 } from 'lucide-react';
import { UserProfile } from '@/hooks/useUserProfile';

interface UserProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: UserProfile | null;
  isLoading: boolean;
  onUpdateUserId: (newUserId: string) => Promise<{ success: boolean; error?: string }>;
  onCheckAvailability: (userId: string) => Promise<boolean>;
}

export function UserProfileModal({
  isOpen,
  onClose,
  user,
  isLoading,
  onUpdateUserId,
  onCheckAvailability
}: UserProfileModalProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [newUserId, setNewUserId] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [copied, setCopied] = useState(false);

  // Get referral link
  const getReferralLink = () => {
    const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';
    const refId = user?.userId || user?.walletAddress || '';
    return `${baseUrl}/dapp?ref=${refId}`;
  };

  useEffect(() => {
    if (user) {
      setNewUserId(user.userId);
    }
  }, [user]);

  useEffect(() => {
    if (!isEditing) {
      setNewUserId(user?.userId || '');
      setIsAvailable(null);
      setSaveError(null);
      setSaveSuccess(false);
    }
  }, [isEditing, user?.userId]);

  // Check availability when user types
  useEffect(() => {
    if (!isEditing || !newUserId || newUserId === user?.userId) {
      setIsAvailable(null);
      return;
    }

    const timer = setTimeout(async () => {
      setIsChecking(true);
      const available = await onCheckAvailability(newUserId);
      setIsAvailable(available);
      setIsChecking(false);
    }, 500);

    return () => clearTimeout(timer);
  }, [newUserId, isEditing, user?.userId, onCheckAvailability]);

  const handleSave = async () => {
    if (!newUserId || newUserId === user?.userId) {
      setIsEditing(false);
      return;
    }

    if (isAvailable === false) {
      setSaveError('This referral ID is already taken');
      return;
    }

    setIsSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    const result = await onUpdateUserId(newUserId);

    if (result.success) {
      setSaveSuccess(true);
      setTimeout(() => {
        setIsEditing(false);
        setSaveSuccess(false);
      }, 2000);
    } else {
      setSaveError(result.error || 'Failed to update referral ID');
    }

    setIsSaving(false);
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(getReferralLink());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ duration: 0.2 }}
          className="w-full max-w-md bg-black/90 backdrop-blur-md border border-emerald-500/30 rounded-xl shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-emerald-500/20">
            <div>
              <h2 className="text-base font-semibold text-emerald-400">Referrals</h2>
              <p className="text-xs text-gray-400 mt-0.5">Share your link and earn rewards</p>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Content */}
          <div className="px-5 py-4 space-y-4">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
              </div>
            ) : user ? (
              <>
                {/* Referral Link Display */}
                <div className="p-3 rounded-lg border border-emerald-500/20 bg-black/30">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-lg bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center">
                      <Link2 className="w-5 h-5 text-emerald-400" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-white">Your Referral Link</p>
                      <p className="text-xs text-gray-500">Share this to earn rewards</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 p-2 bg-black/50 border border-emerald-500/20 rounded-lg overflow-hidden">
                      <p className="text-xs font-mono text-emerald-400 truncate">
                        {getReferralLink()}
                      </p>
                    </div>
                    <button
                      onClick={copyToClipboard}
                      className="p-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
                    >
                      {copied ? (
                        <Check className="w-4 h-4" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Custom Referral ID */}
                <div className="rounded-lg border border-emerald-500/20 bg-black/50 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center">
                        <Share2 className="w-3 h-3 text-emerald-400" />
                      </div>
                      <span className="text-sm font-medium text-white">Referral ID</span>
                    </div>
                    {!isEditing && (
                      <button
                        onClick={() => setIsEditing(true)}
                        className="px-3 py-1.5 text-xs font-medium text-emerald-400 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 rounded-lg transition-colors"
                      >
                        Edit
                      </button>
                    )}
                  </div>

                  {isEditing ? (
                    <div className="space-y-3">
                      <div className="relative">
                        <input
                          type="text"
                          value={newUserId}
                          onChange={(e) => setNewUserId(e.target.value)}
                          placeholder="Enter custom ID (3-30 characters)"
                          className="w-full bg-transparent text-sm font-mono text-emerald-400 placeholder-gray-600 outline-none border-b border-emerald-500/30 pb-2"
                          maxLength={30}
                        />
                        {isChecking && (
                          <Loader2 className="absolute right-0 top-0 w-4 h-4 animate-spin text-gray-400" />
                        )}
                        {!isChecking && isAvailable !== null && newUserId !== user.userId && (
                          <div className="absolute right-0 top-0">
                            {isAvailable ? (
                              <Check className="w-4 h-4 text-emerald-400" />
                            ) : (
                              <AlertCircle className="w-4 h-4 text-red-400" />
                            )}
                          </div>
                        )}
                      </div>

                      <p className="text-xs text-gray-500">
                        3-30 characters: letters, numbers, dashes, underscores
                      </p>

                      {saveError && (
                        <div className="flex items-center gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400">
                          <AlertCircle className="w-4 h-4" />
                          {saveError}
                        </div>
                      )}

                      {saveSuccess && (
                        <div className="flex items-center gap-2 p-2 bg-emerald-500/10 border border-emerald-500/30 rounded text-xs text-emerald-400">
                          <Check className="w-4 h-4" />
                          Referral ID updated!
                        </div>
                      )}

                      <div className="flex gap-3">
                        <button
                          onClick={() => setIsEditing(false)}
                          disabled={isSaving}
                          className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-400 bg-black/50 border border-emerald-500/20 hover:border-emerald-500/40 rounded-lg transition-colors disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleSave}
                          disabled={isSaving || !newUserId || newUserId === user.userId || isAvailable === false}
                          className="flex-1 px-4 py-2.5 text-sm font-medium text-emerald-400 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 disabled:bg-black/30 disabled:border-gray-700 disabled:text-gray-600 rounded-lg transition-colors flex items-center justify-center gap-2"
                        >
                          {isSaving ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Saving...
                            </>
                          ) : (
                            <>
                              <Check className="w-4 h-4" />
                              Save
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm font-mono text-emerald-400">
                      {user.userId}
                    </p>
                  )}
                </div>

                {/* Info */}
                <div className="p-3 rounded-lg border border-emerald-500/10 bg-black/20">
                  <p className="text-xs text-gray-500 text-center">
                    Customize your referral ID to make your link easier to share
                  </p>
                </div>
              </>
            ) : (
              <div className="text-center py-8 text-gray-400 text-sm">
                Connect your wallet to get your referral link
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
