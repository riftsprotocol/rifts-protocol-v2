"use client";

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { 
    Settings, Wifi, WifiOff, RefreshCw, Save, RotateCcw,
    Copy, CheckCircle, AlertTriangle, ExternalLink
} from 'lucide-react';
import { LuxuryModal } from '@/components/ui/luxury-modal';
import { LuxuryButton } from '@/components/ui/luxury-button';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    wallet: {
        connected: boolean;
        publicKey?: string;
        formattedPublicKey: string;
    };
}

interface UserSettings {
    // Trading preferences
    defaultSlippage: number;
    priorityFee: number; // lamports
    
    // Privacy & Security
    hideBalance: boolean;
    
    // Advanced
    customRPC: string;
    autoRefresh: boolean;
    refreshInterval: number; // seconds
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ 
    isOpen, 
    onClose, 
    wallet 
}) => {
    const [settings, setSettings] = useState<UserSettings>({
        defaultSlippage: 1.0,
        priorityFee: 5000,
        hideBalance: false,
        customRPC: process.env.NEXT_PUBLIC_SOLANA_RPC_URL || '',
        autoRefresh: true,
        refreshInterval: 30
    });

    const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
    const [saving, setSaving] = useState(false);
    const [showRPCTest, setShowRPCTest] = useState(false);
    const [rpcStatus, setRpcStatus] = useState<'testing' | 'success' | 'error' | null>(null);

    // Load settings from localStorage on mount
    useEffect(() => {
        const savedSettings = localStorage.getItem('rifts-settings');
        if (savedSettings) {
            try {
                const parsed = JSON.parse(savedSettings);
                setSettings(prev => ({ ...prev, ...parsed }));
            } catch (error) {
                console.error('Error loading settings:', error);
            }
        }
    }, []);

    const updateSetting = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
        setSettings(prev => ({ ...prev, [key]: value }));
        setHasUnsavedChanges(true);
    };

    const saveSettings = async () => {
        setSaving(true);
        try {
            // Save to localStorage
            localStorage.setItem('rifts-settings', JSON.stringify(settings));
            
            // Settings saved successfully
            
            setHasUnsavedChanges(false);
            
            // Show success feedback
            setTimeout(() => setSaving(false), 1000);
        } catch (error) {
            console.error('Error saving settings:', error);
            setSaving(false);
        }
    };

    const resetToDefaults = () => {
        if (confirm('Are you sure you want to reset all settings to their default values?')) {
            setSettings({
                defaultSlippage: 1.0,
                priorityFee: 5000,
                hideBalance: false,
                customRPC: process.env.NEXT_PUBLIC_SOLANA_RPC_URL || '',
                autoRefresh: true,
                refreshInterval: 30
            });
            setHasUnsavedChanges(true);
        }
    };

    const testRPCConnection = async () => {
        setShowRPCTest(true);
        setRpcStatus('testing');
        
        try {
            const response = await fetch(settings.customRPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getHealth'
                })
            });
            
            if (response.ok) {
                setRpcStatus('success');
            } else {
                setRpcStatus('error');
            }
        } catch {
            setRpcStatus('error');
        }
        
        setTimeout(() => {
            setShowRPCTest(false);
            setRpcStatus(null);
        }, 3000);
    };

    const copyWalletAddress = () => {
        if (wallet.publicKey) {
            navigator.clipboard.writeText(wallet.publicKey);
        }
    };

    return (
        <LuxuryModal 
            isOpen={isOpen} 
            onClose={onClose} 
            title="Settings"
            subtitle="Configure your RIFTS Protocol preferences"
            size="lg"
        >
            <div className="space-y-6">
                {/* Trading Preferences */}
                <div className="space-y-6">
                    <h3 className="text-lg font-semibold text-white">Trading Preferences</h3>
                    
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">Default Slippage (%)</label>
                            <input
                                type="number"
                                min="0.1"
                                max="50"
                                step="0.1"
                                value={settings.defaultSlippage}
                                onChange={(e) => updateSetting('defaultSlippage', parseFloat(e.target.value) || 1.0)}
                                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-emerald-500"
                            />
                            <p className="text-xs text-gray-400 mt-1">Higher slippage allows faster execution but may result in worse prices</p>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">Priority Fee (lamports)</label>
                            <input
                                type="number"
                                min="0"
                                max="100000"
                                step="1000"
                                value={settings.priorityFee}
                                onChange={(e) => updateSetting('priorityFee', parseInt(e.target.value) || 5000)}
                                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-emerald-500"
                            />
                            <p className="text-xs text-gray-400 mt-1">Higher fees help transactions get processed faster during network congestion</p>
                        </div>
                    </div>
                </div>

                {/* Privacy & Security */}
                <div className="space-y-6">
                    <h3 className="text-lg font-semibold text-white">Privacy & Security</h3>
                    
                    <div className="flex items-center justify-between p-4 bg-gray-800/50 border border-gray-700 rounded-lg">
                        <div>
                            <h4 className="font-medium text-white">Hide Balance</h4>
                            <p className="text-sm text-gray-400">Hide your balance amounts in the interface</p>
                        </div>
                        <button
                            onClick={() => updateSetting('hideBalance', !settings.hideBalance)}
                            className={`relative w-12 h-6 rounded-full transition-colors ${
                                settings.hideBalance ? 'bg-emerald-500' : 'bg-gray-600'
                            }`}
                        >
                            <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${
                                settings.hideBalance ? 'translate-x-7' : 'translate-x-1'
                            }`} />
                        </button>
                    </div>
                </div>

                {/* Advanced Settings */}
                <div className="space-y-6">
                    <h3 className="text-lg font-semibold text-white">Advanced</h3>
                    
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">Custom RPC Endpoint</label>
                            <div className="flex gap-2">
                                <input
                                    type="url"
                                    value={settings.customRPC}
                                    onChange={(e) => updateSetting('customRPC', e.target.value)}
                                    className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-emerald-500"
                                    placeholder="https://api.mainnet-beta.solana.com"
                                />
                                <LuxuryButton
                                    variant="ghost"
                                    size="sm"
                                    onClick={testRPCConnection}
                                    disabled={showRPCTest}
                                >
                                    {showRPCTest ? (
                                        <RefreshCw className="w-4 h-4 animate-spin" />
                                    ) : rpcStatus === 'success' ? (
                                        <CheckCircle className="w-4 h-4 text-green-400" />
                                    ) : rpcStatus === 'error' ? (
                                        <AlertTriangle className="w-4 h-4 text-red-400" />
                                    ) : (
                                        <Wifi className="w-4 h-4" />
                                    )}
                                </LuxuryButton>
                            </div>
                            {showRPCTest && (
                                <p className="text-xs mt-1">
                                    {rpcStatus === 'testing' && <span className="text-yellow-400">Testing connection...</span>}
                                    {rpcStatus === 'success' && <span className="text-green-400">Connection successful!</span>}
                                    {rpcStatus === 'error' && <span className="text-red-400">Connection failed</span>}
                                </p>
                            )}
                        </div>

                        <div className="flex items-center justify-between p-4 bg-gray-800/50 border border-gray-700 rounded-lg">
                            <div>
                                <h4 className="font-medium text-white">Auto Refresh</h4>
                                <p className="text-sm text-gray-400">Automatically refresh data</p>
                            </div>
                            <button
                                onClick={() => updateSetting('autoRefresh', !settings.autoRefresh)}
                                className={`relative w-12 h-6 rounded-full transition-colors ${
                                    settings.autoRefresh ? 'bg-emerald-500' : 'bg-gray-600'
                                }`}
                            >
                                <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${
                                    settings.autoRefresh ? 'translate-x-7' : 'translate-x-1'
                                }`} />
                            </button>
                        </div>

                        {settings.autoRefresh && (
                            <div>
                                <label className="block text-sm font-medium text-gray-300 mb-2">Refresh Interval (seconds)</label>
                                <input
                                    type="number"
                                    min="5"
                                    max="300"
                                    step="5"
                                    value={settings.refreshInterval}
                                    onChange={(e) => updateSetting('refreshInterval', parseInt(e.target.value) || 30)}
                                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-emerald-500"
                                />
                            </div>
                        )}
                    </div>
                </div>

                {/* Wallet Info */}
                {wallet.connected && (
                    <div>
                        <h3 className="text-lg font-semibold text-white mb-4">Wallet</h3>
                        <div className="p-4 bg-gray-800/50 border border-gray-700 rounded-lg">
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm text-gray-400">Connected Wallet</p>
                                    <p className="text-white font-mono">{wallet.formattedPublicKey}</p>
                                </div>
                                <LuxuryButton
                                    variant="ghost"
                                    size="sm"
                                    onClick={copyWalletAddress}
                                >
                                    <Copy className="w-4 h-4" />
                                </LuxuryButton>
                            </div>
                        </div>
                    </div>
                )}

                {/* Action Buttons */}
                <div className="flex justify-between pt-4 border-t border-gray-700">
                    <LuxuryButton
                        variant="ghost"
                        onClick={resetToDefaults}
                        className="text-gray-400 hover:text-white"
                    >
                        <RotateCcw className="w-4 h-4 mr-2" />
                        Reset to Defaults
                    </LuxuryButton>
                    
                    <div className="flex gap-3">
                        <LuxuryButton
                            variant="outline"
                            onClick={onClose}
                        >
                            Cancel
                        </LuxuryButton>
                        <LuxuryButton
                            onClick={saveSettings}
                            disabled={!hasUnsavedChanges || saving}
                        >
                            {saving ? (
                                <>
                                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                                    Saving...
                                </>
                            ) : (
                                <>
                                    <Save className="w-4 h-4 mr-2" />
                                    Save Changes
                                </>
                            )}
                        </LuxuryButton>
                    </div>
                </div>
            </div>
        </LuxuryModal>
    );
};