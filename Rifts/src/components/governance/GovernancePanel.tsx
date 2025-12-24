import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { 
    Vote, Users, CheckCircle2, 
    Clock, AlertCircle, Plus,
    Gavel, Shield, DollarSign, Zap
} from 'lucide-react';
import { 
    governanceService, 
    GovernanceStats, 
    Proposal, 
    ProposalType, 
    ProposalStatus,
    VoteChoice 
} from '@/lib/solana/governance-service';
import { LuxuryButton } from '@/components/ui/luxury-button';
import { LuxuryModal } from '@/components/ui/luxury-modal';
import { debugLog, debugError } from '@/utils/debug';

interface GovernancePanelProps {
    wallet: {publicKey?: string; connected?: boolean};
    isOpen: boolean;
    onClose: () => void;
    addToast?: (message: string, type: 'success' | 'error' | 'pending', signature?: string) => void;
}

export const GovernancePanel: React.FC<GovernancePanelProps> = ({ wallet, isOpen, onClose, addToast }) => {
    const [stats, setStats] = useState<GovernanceStats | null>(null);
    const [proposals, setProposals] = useState<Proposal[]>([]);
    const [loading, setLoading] = useState(false);
    const [createProposalOpen, setCreateProposalOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<'active' | 'history'>('active');
    const [governanceInitialized, setGovernanceInitialized] = useState(false);
    const [snapshotStatus, setSnapshotStatus] = useState<Record<number, boolean>>({});
    const [currentTime, setCurrentTime] = useState(Date.now());

    // Form states for new proposal
    const [proposalTitle, setProposalTitle] = useState('');
    const [proposalDescription, setProposalDescription] = useState('');
    const [proposalType, setProposalType] = useState<ProposalType>(ProposalType.ParameterChange);
    
    const loadGovernanceData = useCallback(async () => {
        if (!wallet?.publicKey) return;

        setLoading(true);
        try {
            await governanceService.initialize(wallet);

            // Convert wallet.publicKey to string if it's not already a PublicKey instance
            const walletAddress = typeof wallet.publicKey === 'string'
                ? wallet.publicKey
                : (wallet.publicKey as unknown as { toString: () => string }).toString();

            const [governanceStats, activeProposals] = await Promise.all([
                governanceService.getGovernanceStats(walletAddress),
                governanceService.getActiveProposals()
            ]);

            setStats(governanceStats);
            setProposals(activeProposals);

            // Check if governance is initialized from the stats
            setGovernanceInitialized((governanceStats as any).isInitialized || false);
        } catch (error) {
            debugError('Error loading governance data:', error);
            setGovernanceInitialized(false);
        } finally {
            setLoading(false);
        }
    }, [wallet]);
    
    useEffect(() => {
        // debugLog('GovernancePanel - isOpen:', isOpen, 'wallet:', wallet?.publicKey);
        if (isOpen && wallet?.publicKey) {
            loadGovernanceData();
        }
    }, [isOpen, wallet, loadGovernanceData]);

    // Update current time every second for countdown
    useEffect(() => {
        if (!isOpen) return;

        const interval = setInterval(() => {
            setCurrentTime(Date.now());
        }, 1000);

        return () => clearInterval(interval);
    }, [isOpen]);

    // Check snapshot status for all proposals
    useEffect(() => {
        const checkSnapshots = async () => {
            if (!wallet?.publicKey || proposals.length === 0) return;

            const walletAddress = typeof wallet.publicKey === 'string'
                ? wallet.publicKey
                : (wallet.publicKey as unknown as { toString: () => string }).toString();

            const statuses: Record<number, boolean> = {};
            for (const proposal of proposals) {
                try {
                    const hasSnapshot = await governanceService.hasUserCreatedSnapshot(proposal.id, walletAddress);
                    statuses[proposal.id] = hasSnapshot;
                } catch (error) {
                    statuses[proposal.id] = false;
                }
            }
            setSnapshotStatus(statuses);
        };

        checkSnapshots();
    }, [proposals, wallet]);

    const handleVote = async (proposalId: number, vote: VoteChoice) => {
        if (!wallet?.publicKey) return;
        
        try {
            setLoading(true);
            const signature = await governanceService.castVote(proposalId, vote);
            debugLog('Vote cast:', signature);
            
            // Reload data
            await loadGovernanceData();
            
            // Show success message (you could add a toast notification here)
            addToast?.(`Vote cast successfully! Transaction: ${signature}`, 'success', signature);
        } catch (error) {
            debugError('Error casting vote:', error);
            addToast?.('Failed to cast vote. Please try again.', 'error');
        } finally {
            setLoading(false);
        }
    };

    const handleCreateSnapshot = async (proposalId: number) => {
        if (!wallet?.publicKey) return;

        try {
            setLoading(true);
            const signature = await governanceService.createSnapshot(proposalId);
            debugLog('Snapshot created:', signature);

            // Reload data
            await loadGovernanceData();

            addToast?.(`Snapshot created successfully! You can vote when voting starts. Transaction: ${signature}`, 'success', signature);
        } catch (error: any) {
            debugError('Error creating snapshot:', error);
            if (error.message?.includes('already created')) {
                addToast?.('You have already created a snapshot for this proposal.', 'error');
            } else {
                addToast?.('Failed to create snapshot. Please try again.', 'error');
            }
        } finally {
            setLoading(false);
        }
    };

    const handleInitializeGovernance = async () => {
        if (!wallet?.publicKey) return;

        try {
            debugLog('🏛️ Initializing governance...');
            setLoading(true);
            const signature = await governanceService.initializeGovernance();

            debugLog('✅ Governance initialized:', signature);
            addToast?.(`Governance initialized successfully! Transaction: ${signature}`, 'success', signature);

            // Reload data
            await loadGovernanceData();
        } catch (error) {
            debugError('❌ Error initializing governance:', error);
            addToast?.('Failed to initialize governance. Please try again.', 'error');
        } finally {
            setLoading(false);
        }
    };

    const handleCreateProposal = async () => {
        debugLog('🚀 handleCreateProposal called');
        debugLog('Wallet:', wallet?.publicKey);
        debugLog('Proposal Title:', proposalTitle);
        debugLog('Proposal Description:', proposalDescription);
        debugLog('Proposal Type:', proposalType);

        if (!wallet?.publicKey) {
            debugLog('❌ No wallet connected');
            return;
        }

        if (!proposalTitle || !proposalDescription) {
            debugLog('❌ Missing title or description');
            addToast?.('Please fill in all fields', 'error');
            return;
        }

        try {
            debugLog('📝 Starting proposal creation...');
            setLoading(true);
            const signature = await governanceService.createProposal(
                proposalTitle,
                proposalDescription,
                proposalType
            );

            debugLog('✅ Proposal created:', signature);
            addToast?.(`Proposal created successfully! Transaction: ${signature}`, 'success', signature);

            // Reset form and close modal
            setProposalTitle('');
            setProposalDescription('');
            setCreateProposalOpen(false);

            // Reload data
            await loadGovernanceData();
        } catch (error) {
            debugError('❌ Error creating proposal:', error);
            addToast?.('Failed to create proposal. Please ensure you have enough RIFTS tokens.', 'error');
        } finally {
            setLoading(false);
        }
    };
    
    const getProposalIcon = (type: ProposalType) => {
        switch (type) {
            case ProposalType.ParameterChange:
                return <Gavel className="w-5 h-5" />;
            case ProposalType.TreasurySpend:
                return <DollarSign className="w-5 h-5" />;
            case ProposalType.ProtocolUpgrade:
                return <Zap className="w-5 h-5" />;
            case ProposalType.EmergencyAction:
                return <Shield className="w-5 h-5" />;
        }
    };
    
    const getStatusColor = (status: ProposalStatus) => {
        switch (status) {
            case ProposalStatus.Active:
                return 'text-green-400';
            case ProposalStatus.Executed:
                return 'text-blue-400';
            case ProposalStatus.Cancelled:
                return 'text-red-400';
            case ProposalStatus.Failed:
                return 'text-gray-400';
        }
    };
    
    const formatTimeRemaining = (endTime: number) => {
        const now = Date.now() / 1000;
        const remaining = endTime - now;

        if (remaining <= 0) return 'Voting ended';

        const days = Math.floor(remaining / 86400);
        const hours = Math.floor((remaining % 86400) / 3600);

        if (days > 0) return `${days} day${days > 1 ? 's' : ''} remaining`;
        return `${hours} hour${hours > 1 ? 's' : ''} remaining`;
    };

    const formatCountdown = (startTime: number) => {
        const now = currentTime / 1000;
        const remaining = startTime - now;

        if (remaining <= 0) return null;

        const hours = Math.floor(remaining / 3600);
        const minutes = Math.floor((remaining % 3600) / 60);
        const seconds = Math.floor(remaining % 60);

        return `${hours}h ${minutes}m ${seconds}s`;
    };

    const isInPrepWindow = (proposal: Proposal) => {
        const now = currentTime / 1000;
        return now < proposal.votingStart;
    };

    return (
        <LuxuryModal isOpen={isOpen} onClose={onClose} title="RIFTS Governance" zIndex={150}>
            <div className="space-y-6">
                {/* Governance Stats */}
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                    <motion.div 
                        className="relative inline-flex items-center justify-center font-medium tracking-wide transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-black overflow-hidden select-none bg-black text-emerald-500 hover:bg-gray-900 active:bg-gray-950 focus:ring-emerald-500 shadow-[0_0_20px_rgba(0,0,0,0.5)] hover:shadow-[0_0_30px_rgba(16,185,129,0.3)] border border-emerald-500/30 hover:border-emerald-400/50 px-4 py-3 text-sm gap-2.5 flex-col"
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                    >
                        {/* Luxury background patterns */}
                        <div className="absolute inset-0 opacity-30">
                            <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
                            <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
                        </div>
                        {/* Corner accents */}
                        <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-current opacity-50" />
                        <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-current opacity-50" />
                        <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-current opacity-50" />
                        <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-current opacity-50" />
                        <div className="relative z-10 text-center">
                            <div className="flex items-center justify-center gap-2 mb-2 text-gray-400">
                                <Vote className="w-4 h-4" />
                                <span className="text-xs">Voting Power</span>
                            </div>
                            <div className="text-xl font-bold text-emerald-400">
                                {stats?.userVotingPower.toLocaleString() || '0'}
                            </div>
                            <div className="text-xs text-gray-400">RIFTS</div>
                        </div>
                    </motion.div>
                    
                    <motion.div 
                        className="relative inline-flex items-center justify-center font-medium tracking-wide transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-black overflow-hidden select-none bg-black text-emerald-500 hover:bg-gray-900 active:bg-gray-950 focus:ring-emerald-500 shadow-[0_0_20px_rgba(0,0,0,0.5)] hover:shadow-[0_0_30px_rgba(16,185,129,0.3)] border border-emerald-500/30 hover:border-emerald-400/50 px-4 py-3 text-sm gap-2.5 flex-col"
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                    >
                        {/* Luxury background patterns */}
                        <div className="absolute inset-0 opacity-30">
                            <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
                            <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
                        </div>
                        {/* Corner accents */}
                        <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-current opacity-50" />
                        <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-current opacity-50" />
                        <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-current opacity-50" />
                        <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-current opacity-50" />
                        <div className="relative z-10 text-center">
                            <div className="flex items-center justify-center gap-2 mb-2 text-gray-400">
                                <Users className="w-4 h-4" />
                                <span className="text-xs">Total Proposals</span>
                            </div>
                            <div className="text-xl font-bold text-emerald-400">
                                {stats?.totalProposals || 0}
                            </div>
                        </div>
                    </motion.div>
                    
                    <motion.div 
                        className="relative inline-flex items-center justify-center font-medium tracking-wide transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-black overflow-hidden select-none bg-black text-emerald-500 hover:bg-gray-900 active:bg-gray-950 focus:ring-emerald-500 shadow-[0_0_20px_rgba(0,0,0,0.5)] hover:shadow-[0_0_30px_rgba(16,185,129,0.3)] border border-emerald-500/30 hover:border-emerald-400/50 px-4 py-3 text-sm gap-2.5 flex-col"
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                    >
                        {/* Luxury background patterns */}
                        <div className="absolute inset-0 opacity-30">
                            <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
                            <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
                        </div>
                        {/* Corner accents */}
                        <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-current opacity-50" />
                        <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-current opacity-50" />
                        <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-current opacity-50" />
                        <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-current opacity-50" />
                        <div className="relative z-10 text-center">
                            <div className="flex items-center justify-center gap-2 mb-2 text-gray-400">
                                <CheckCircle2 className="w-4 h-4" />
                                <span className="text-xs">Executed</span>
                            </div>
                            <div className="text-xl font-bold text-emerald-400">
                                {stats?.totalExecuted || 0}
                            </div>
                        </div>
                    </motion.div>
                    
                    <motion.div 
                        className="relative inline-flex items-center justify-center font-medium tracking-wide transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-black overflow-hidden select-none bg-black text-emerald-500 hover:bg-gray-900 active:bg-gray-950 focus:ring-emerald-500 shadow-[0_0_20px_rgba(0,0,0,0.5)] hover:shadow-[0_0_30px_rgba(16,185,129,0.3)] border border-emerald-500/30 hover:border-emerald-400/50 px-4 py-3 text-sm gap-2.5 flex-col"
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                    >
                        {/* Luxury background patterns */}
                        <div className="absolute inset-0 opacity-30">
                            <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
                            <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_50%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
                        </div>
                        {/* Corner accents */}
                        <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-current opacity-50" />
                        <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-current opacity-50" />
                        <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-current opacity-50" />
                        <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-current opacity-50" />
                        <div className="relative z-10 text-center">
                            <div className="flex items-center justify-center gap-2 mb-2 text-gray-400">
                                <Clock className="w-4 h-4" />
                                <span className="text-xs">Active</span>
                            </div>
                            <div className="text-xl font-bold text-emerald-400">
                                {stats?.activeProposals || 0}
                            </div>
                        </div>
                    </motion.div>
                </div>
                
                {/* Initialize Governance Button - Show if not initialized */}
                {!governanceInitialized && stats && (
                    <div className="p-4 mb-4 border bg-blue-900/20 border-blue-600/50 rounded-xl">
                        <div className="flex items-start gap-3">
                            <AlertCircle className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" />
                            <div className="flex-1">
                                <p className="mb-1 text-sm font-medium text-blue-200">
                                    Governance Not Initialized
                                </p>
                                <p className="mb-3 text-xs text-blue-300/80">
                                    You need to initialize the governance system before creating proposals. This is a one-time setup.
                                </p>
                                <LuxuryButton
                                    onClick={handleInitializeGovernance}
                                    variant="primary"
                                    disabled={loading}
                                    size="sm"
                                >
                                    <Shield className="w-4 h-4 mr-2" />
                                    Initialize Governance
                                </LuxuryButton>
                            </div>
                        </div>
                    </div>
                )}

                {/* Create Proposal Button */}
                {governanceInitialized && stats && stats.userVotingPower >= stats.minProposalThreshold && (
                    <div className="flex justify-end">
                        <LuxuryButton
                            onClick={() => setCreateProposalOpen(true)}
                            variant="primary"
                            disabled={loading}
                        >
                            <Plus className="w-4 h-4 mr-2" />
                            Create Proposal
                        </LuxuryButton>
                    </div>
                )}
                
                {/* Tabs */}
                <div className="flex gap-4 border-b border-gray-700">
                    <button
                        onClick={() => setActiveTab('active')}
                        className={`pb-2 px-1 ${
                            activeTab === 'active' 
                                ? 'text-purple-400 border-b-2 border-purple-400' 
                                : 'text-gray-400'
                        }`}
                    >
                        Active Proposals
                    </button>
                    <button
                        onClick={() => setActiveTab('history')}
                        className={`pb-2 px-1 ${
                            activeTab === 'history' 
                                ? 'text-purple-400 border-b-2 border-purple-400' 
                                : 'text-gray-400'
                        }`}
                    >
                        History
                    </button>
                </div>
                
                {/* Proposals List */}
                <div className="space-y-4 overflow-y-auto max-h-96">
                    {proposals
                        .filter(p => activeTab === 'active' 
                            ? p.status === ProposalStatus.Active 
                            : p.status !== ProposalStatus.Active
                        )
                        .map((proposal) => {
                            const votePercentages = governanceService.calculateVotePercentage(
                                proposal.votesFor,
                                proposal.votesAgainst
                            );
                            const isVotingActive = governanceService.isVotingActive(proposal);

                            // DEBUG: Log proposal timestamps
                            console.log(`Proposal #${proposal.id} "${proposal.title}":`, {
                                votingStart: proposal.votingStart,
                                votingStartDate: new Date(proposal.votingStart * 1000).toISOString(),
                                createdAt: proposal.createdAt,
                                createdAtDate: new Date(proposal.createdAt * 1000).toISOString(),
                                currentTime: currentTime / 1000,
                                currentTimeDate: new Date(currentTime).toISOString(),
                                hoursUntilVoting: ((proposal.votingStart - currentTime / 1000) / 3600).toFixed(2)
                            });

                            return (
                                <motion.div
                                    key={proposal.id}
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="p-6 transition-all border border-gray-700 cursor-pointer bg-gray-800/50 rounded-xl hover:border-purple-500/50"
                                >
                                    <div className="flex items-start justify-between mb-4">
                                        <div className="flex items-start gap-3">
                                            {getProposalIcon(proposal.proposalType)}
                                            <div>
                                                <h3 className="mb-1 font-semibold text-white">
                                                    {proposal.title}
                                                </h3>
                                                <p className="text-sm text-gray-400 line-clamp-2">
                                                    {proposal.description}
                                                </p>
                                            </div>
                                        </div>
                                        <span className={`text-xs px-2 py-1 rounded-full bg-gray-700 ${getStatusColor(proposal.status)}`}>
                                            {proposal.status}
                                        </span>
                                    </div>
                                    
                                    {/* Voting Progress */}
                                    <div className="space-y-2">
                                        <div className="flex justify-between text-sm">
                                            <span className="text-green-400">
                                                For: {governanceService.formatVotingPower(proposal.votesFor)} ({votePercentages.for}%)
                                            </span>
                                            <span className="text-red-400">
                                                Against: {governanceService.formatVotingPower(proposal.votesAgainst)} ({votePercentages.against}%)
                                            </span>
                                        </div>
                                        
                                        <div className="w-full h-2 overflow-hidden bg-gray-700 rounded-full">
                                            <div className="flex h-full">
                                                <div 
                                                    className="transition-all bg-green-400"
                                                    style={{ width: `${votePercentages.for}%` }}
                                                />
                                                <div 
                                                    className="transition-all bg-red-400"
                                                    style={{ width: `${votePercentages.against}%` }}
                                                />
                                            </div>
                                        </div>
                                        
                                        <div className="flex justify-between text-xs text-gray-400">
                                            <span>{proposal.totalVoters} voters</span>
                                            <span>{formatTimeRemaining(proposal.votingEnd)}</span>
                                        </div>
                                    </div>
                                    
                                    {/* Prep Window - Countdown & Snapshot Button */}
                                    {isInPrepWindow(proposal) && stats && stats.userVotingPower >= stats.minVoteThreshold && (
                                        <div className="mt-4 space-y-3">
                                            <div className="flex items-center justify-between p-3 text-sm border border-yellow-500/30 bg-yellow-500/10 rounded-lg">
                                                <div className="flex items-center gap-2">
                                                    <Clock className="w-4 h-4 text-yellow-400" />
                                                    <span className="text-yellow-400">Voting starts in:</span>
                                                </div>
                                                <span className="font-mono font-semibold text-yellow-300">
                                                    {formatCountdown(proposal.votingStart)}
                                                </span>
                                            </div>

                                            {snapshotStatus[proposal.id] ? (
                                                <div className="flex items-center justify-center gap-2 p-3 text-sm text-green-400 border border-green-500/30 bg-green-500/10 rounded-lg">
                                                    <CheckCircle2 className="w-4 h-4" />
                                                    <span>Snapshot created - Ready to vote when voting starts</span>
                                                </div>
                                            ) : (
                                                <LuxuryButton
                                                    onClick={() => handleCreateSnapshot(proposal.id)}
                                                    variant="primary"
                                                    size="sm"
                                                    disabled={loading}
                                                    className="w-full"
                                                >
                                                    Create Snapshot to Vote
                                                </LuxuryButton>
                                            )}
                                        </div>
                                    )}

                                    {/* Vote Buttons */}
                                    {isVotingActive && !isInPrepWindow(proposal) && stats && stats.userVotingPower >= stats.minVoteThreshold && (
                                        <div className="flex gap-2 mt-4">
                                            <LuxuryButton
                                                onClick={() => {
                                                    handleVote(proposal.id, VoteChoice.For);
                                                }}
                                                variant="success"
                                                size="sm"
                                                disabled={loading}
                                                className="flex-1"
                                            >
                                                Vote For
                                            </LuxuryButton>
                                            <LuxuryButton
                                                onClick={() => {
                                                    handleVote(proposal.id, VoteChoice.Against);
                                                }}
                                                variant="danger"
                                                size="sm"
                                                disabled={loading}
                                                className="flex-1"
                                            >
                                                Vote Against
                                            </LuxuryButton>
                                        </div>
                                    )}
                                </motion.div>
                            );
                        })}
                    
                    {proposals.filter(p => activeTab === 'active' 
                        ? p.status === ProposalStatus.Active 
                        : p.status !== ProposalStatus.Active
                    ).length === 0 && (
                        <div className="py-8 text-center text-gray-400">
                            No {activeTab === 'active' ? 'active' : 'past'} proposals
                        </div>
                    )}
                </div>
                
                {/* Insufficient Voting Power Warning */}
                {stats && stats.userVotingPower < stats.minVoteThreshold && (
                    <div className="p-4 border bg-yellow-900/20 border-yellow-600/50 rounded-xl">
                        <div className="flex items-start gap-3">
                            <AlertCircle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                            <div>
                                <p className="mb-1 text-sm font-medium text-yellow-200">
                                    Insufficient Voting Power
                                </p>
                                <p className="text-xs text-yellow-300/80">
                                    You need at least {stats.minVoteThreshold} RIFTS to vote on proposals.
                                    Current balance: {stats.userVotingPower} RIFTS
                                </p>
                            </div>
                        </div>
                    </div>
                )}
            </div>
            
            {/* Create Proposal Modal */}
            <LuxuryModal
                isOpen={createProposalOpen}
                onClose={() => setCreateProposalOpen(false)}
                title="Create New Proposal"
                zIndex={200}
            >
                <div className="space-y-4">
                    <div>
                        <label className="block mb-2 text-sm text-gray-400">Proposal Title</label>
                        <input
                            type="text"
                            value={proposalTitle}
                            onChange={(e) => setProposalTitle(e.target.value)}
                            className="w-full px-4 py-2 text-white bg-gray-800 border border-gray-700 rounded-lg"
                            placeholder="Enter proposal title..."
                        />
                    </div>
                    
                    <div>
                        <label className="block mb-2 text-sm text-gray-400">Description</label>
                        <textarea
                            value={proposalDescription}
                            onChange={(e) => setProposalDescription(e.target.value)}
                            className="w-full h-32 px-4 py-2 text-white bg-gray-800 border border-gray-700 rounded-lg"
                            placeholder="Describe your proposal..."
                        />
                    </div>
                    
                    <div>
                        <label className="block mb-2 text-sm text-gray-400">Proposal Type</label>
                        <select
                            value={proposalType}
                            onChange={(e) => setProposalType(e.target.value as ProposalType)}
                            className="w-full px-4 py-2 text-white bg-gray-800 border border-gray-700 rounded-lg"
                        >
                            <option value={ProposalType.ParameterChange}>Parameter Change</option>
                            <option value={ProposalType.TreasurySpend}>Treasury Spend</option>
                            <option value={ProposalType.ProtocolUpgrade}>Protocol Upgrade</option>
                            <option value={ProposalType.EmergencyAction}>Emergency Action</option>
                        </select>
                    </div>
                    
                    <div className="flex gap-2">
                        <LuxuryButton
                            onClick={() => {
                                debugLog('🔘 Create Proposal button clicked!');
                                handleCreateProposal();
                            }}
                            variant="primary"
                            disabled={loading || !proposalTitle || !proposalDescription}
                            className="flex-1"
                        >
                            Create Proposal
                        </LuxuryButton>
                        <LuxuryButton
                            onClick={() => setCreateProposalOpen(false)}
                            variant="secondary"
                            className="flex-1"
                        >
                            Cancel
                        </LuxuryButton>
                    </div>
                </div>
            </LuxuryModal>
        </LuxuryModal>
    );
};