import { PublicKey, Connection, Transaction, SystemProgram } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import crypto from 'crypto';

// Governance Program ID (deployed) - from programs/governance-keypair.json
export const GOVERNANCE_PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_GOVERNANCE_PROGRAM_ID || 'EbVBCs4g7MQo7iDAtVcZhmV9FMq37JKah3iheLpqJbPo');

// RIFTS Token Mint - CORRECT ACTIVE MINT
export const RIFTS_MINT = new PublicKey("9aJ1VBBGgTptJWYbKwbK2kbAebfgWpv93LCpV5bGwK5P");

/**
 * Generate Anchor instruction discriminator
 * Anchor uses SHA256 hash of "global:function_name" and takes first 8 bytes
 */
function getDiscriminator(name: string): Buffer {
  const preimage = `global:${name}`;
  const hash = crypto.createHash('sha256').update(preimage).digest();
  return hash.slice(0, 8);
}

/**
 * Derive governance PDA from authority
 * Seeds: [b"governance", authority.key()]
 */
export function getGovernancePDA(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('governance'), authority.toBuffer()],
    GOVERNANCE_PROGRAM_ID
  );
}

export enum ProposalType {
    ParameterChange = 'ParameterChange',
    TreasurySpend = 'TreasurySpend',
    ProtocolUpgrade = 'ProtocolUpgrade',
    EmergencyAction = 'EmergencyAction'
}

export enum ProposalStatus {
    Active = 'Active',
    Executed = 'Executed',
    Cancelled = 'Cancelled',
    Failed = 'Failed'
}

export enum VoteChoice {
    For = 'For',
    Against = 'Against'
}

export interface Proposal {
    id: number;
    proposer: PublicKey;
    title: string;
    description: string;
    proposalType: ProposalType;
    votingStart: number;
    votingEnd: number;
    votesFor: BN;
    votesAgainst: BN;
    totalVoters: number;
    status: ProposalStatus;
    createdAt: number;
    executedAt: number;
}

export interface GovernanceStats {
    totalProposals: number;
    totalExecuted: number;
    activeProposals: number;
    userVotingPower: number;
    minProposalThreshold: number;
    minVoteThreshold: number;
}

export class GovernanceService {
    private connection: Connection;
    private program: Program | null = null;
    private provider: AnchorProvider | null = null;
    
    constructor(connection: Connection) {
        this.connection = connection;
    }
    
    async initialize(wallet: unknown) {
        if (!(wallet as unknown as { publicKey?: unknown })?.publicKey) {
            throw new Error('Wallet not connected');
        }
        
        this.provider = new AnchorProvider(
            this.connection,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            wallet as unknown as any,
            { commitment: 'confirmed' }
        );
        
        // Load the REAL governance IDL from the deployed program
        const idlResponse = await fetch('/idl/governance.json');
        const idl = await idlResponse.json();

        // Backup IDL in case fetch fails
        const fallbackIdl = {
            address: GOVERNANCE_PROGRAM_ID.toBase58(),
            metadata: {
                name: "governance",
                version: "0.1.0",
                spec: "0.1.0"
            },
            instructions: [
                {
                    name: "initializeGovernance",
                    discriminator: [1, 0, 0, 0, 0, 0, 0, 0],
                    accounts: [
                        { name: "authority", writable: true, signer: true },
                        { name: "governance", writable: true },
                        { name: "systemProgram" }
                    ],
                    args: [
                        { name: "riftsMint", type: { array: ["u8", 32] } },
                        { name: "minVotingPeriod", type: "i64" },
                        { name: "minExecutionDelay", type: "i64" }
                    ]
                },
                {
                    name: "createProposal",
                    discriminator: [2, 0, 0, 0, 0, 0, 0, 0],
                    accounts: [
                        { name: "proposer", writable: true, signer: true },
                        { name: "governance", writable: true },
                        { name: "proposal", writable: true },
                        { name: "proposerRiftsAccount" },
                        { name: "systemProgram" }
                    ],
                    args: [
                        { name: "title", type: "string" },
                        { name: "description", type: "string" },
                        { name: "proposalType", type: { defined: { name: "ProposalType" } } },
                        { name: "executionData", type: { vec: "u8" } }
                    ]
                },
                {
                    name: "castVote",
                    discriminator: [3, 0, 0, 0, 0, 0, 0, 0],
                    accounts: [
                        { name: "voter", writable: true, signer: true },
                        { name: "proposal", writable: true },
                        { name: "voteRecord", writable: true },
                        { name: "voterRiftsAccount" },
                        { name: "systemProgram" }
                    ],
                    args: [
                        { name: "vote", type: { defined: { name: "VoteChoice" } } }
                    ]
                },
                {
                    name: "executeProposal",
                    discriminator: [4, 0, 0, 0, 0, 0, 0, 0],
                    accounts: [
                        { name: "executor", writable: true, signer: true },
                        { name: "governance", writable: true },
                        { name: "proposal", writable: true }
                    ],
                    args: []
                }
            ],
            accounts: [
                {
                    name: "governance",
                    discriminator: [5, 0, 0, 0, 0, 0, 0, 0]
                },
                {
                    name: "proposal",
                    discriminator: [6, 0, 0, 0, 0, 0, 0, 0]
                }
            ],
            types: [
                {
                    name: "ProposalType",
                    type: {
                        kind: "enum",
                        variants: [
                            { name: "ParameterChange" },
                            { name: "TreasurySpend" },
                            { name: "ProtocolUpgrade" },
                            { name: "EmergencyAction" }
                        ]
                    }
                },
                {
                    name: "ProposalStatus",
                    type: {
                        kind: "enum",
                        variants: [
                            { name: "Active" },
                            { name: "Executed" },
                            { name: "Cancelled" },
                            { name: "Failed" }
                        ]
                    }
                },
                {
                    name: "VoteChoice",
                    type: {
                        kind: "enum",
                        variants: [
                            { name: "For" },
                            { name: "Against" }
                        ]
                    }
                }
            ]
        };
        
        try {
            // Try to initialize with the REAL IDL from file
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            // @ts-ignore - IDL type will be properly loaded in production
            this.program = new Program(idl as any, this.provider);
        } catch (error) {
            // Create a mock program for fallback
            this.program = {
                methods: {},
                account: {},
                programId: GOVERNANCE_PROGRAM_ID
            } as any;
        }
    }
    
    async getGovernanceStats(wallet: PublicKey | string): Promise<GovernanceStats & { isInitialized: boolean }> {
        try {
            // Ensure wallet is a PublicKey instance
            const walletPubkey = typeof wallet === 'string' ? new PublicKey(wallet) : wallet;

            // Get user's RIFTS token balance for voting power
            const riftsTokenAccount = await getAssociatedTokenAddress(
                RIFTS_MINT,
                walletPubkey
            );

            let votingPower = 0;
            try {
                const tokenBalance = await this.connection.getTokenAccountBalance(riftsTokenAccount);
                votingPower = parseInt(tokenBalance.value.amount) / 1e9;
            } catch {
            }

            // Derive governance PDA from wallet
            const [governancePda] = getGovernancePDA(walletPubkey);

            // Check if governance account exists
            const governanceAccountInfo = await this.connection.getAccountInfo(governancePda);
            const isInitialized = governanceAccountInfo !== null && governanceAccountInfo.data.length > 0;

            // Fetch real governance data from blockchain using Anchor deserialization
            if (isInitialized) {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const governanceAccount = (this.program?.account as any)?.governance;
                    if (this.program && governanceAccount) {
                        const governanceData = await governanceAccount.fetch(governancePda);

                        return {
                            totalProposals: Number(governanceData.totalProposals || 0),
                            totalExecuted: Number(governanceData.totalExecuted || 0),
                            activeProposals: 0, // Calculate from proposals list
                            userVotingPower: votingPower,
                            minProposalThreshold: 1000, // Program requires 1000 RIFTS
                            minVoteThreshold: 100,
                            isInitialized: true
                        };
                    }
                } catch (error) {
                    console.log('Error fetching governance data:', error);
                }
            }

            // Return defaults if governance not initialized
            return {
                totalProposals: 0,
                totalExecuted: 0,
                activeProposals: 0,
                userVotingPower: votingPower,
                minProposalThreshold: 1000, // Program requires 1000 RIFTS
                minVoteThreshold: 100,
                isInitialized: false
            };
        } catch (error) {
            return {
                totalProposals: 0,
                totalExecuted: 0,
                activeProposals: 0,
                userVotingPower: 0,
                minProposalThreshold: 1000, // Program requires 1000 RIFTS
                minVoteThreshold: 100,
                isInitialized: false
            };
        }
    }
    
    async getActiveProposals(): Promise<Proposal[]> {
        // FETCH FROM SUPABASE FIRST FOR INSTANT DISPLAY!
        try {
            const { createClient } = await import('@supabase/supabase-js');
            const supabase = createClient(
                process.env.NEXT_PUBLIC_SUPABASE_URL!,
                process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
            );

            const { data: supabaseProposals, error } = await supabase
                .from('governance_proposals')
                .select('*')
                .order('created_at', { ascending: false });

            if (!error && supabaseProposals && supabaseProposals.length > 0) {
                console.log('✅ Loaded', supabaseProposals.length, 'proposals from Supabase');

                // DEBUG: Log raw Supabase data
                console.log('🔍 DEBUG - Raw Supabase data for latest proposal:', {
                    id: supabaseProposals[0].id,
                    title: supabaseProposals[0].title,
                    created_at_raw: supabaseProposals[0].created_at,
                    voting_start_raw: supabaseProposals[0].voting_start,
                    voting_end_raw: supabaseProposals[0].voting_end
                });

                return supabaseProposals.map((p: any) => ({
                    id: p.id,
                    proposer: new PublicKey(p.proposer),
                    title: p.title,
                    description: p.description,
                    proposalType: p.proposal_type as ProposalType,
                    // FIX: Append 'Z' to force UTC interpretation if missing
                    votingStart: new Date(p.voting_start.endsWith('Z') ? p.voting_start : p.voting_start + 'Z').getTime() / 1000,
                    votingEnd: new Date(p.voting_end.endsWith('Z') ? p.voting_end : p.voting_end + 'Z').getTime() / 1000,
                    votesFor: new BN(p.votes_for || 0),
                    votesAgainst: new BN(p.votes_against || 0),
                    totalVoters: p.total_voters || 0,
                    status: p.status as ProposalStatus,
                    createdAt: new Date(p.created_at.endsWith('Z') ? p.created_at : p.created_at + 'Z').getTime() / 1000,
                    executedAt: 0
                }));
            }
        } catch (error) {
            console.error('Error loading from Supabase, falling back to blockchain:', error);
        }

        // Fallback to blockchain if Supabase fails
        try {
            const proposalAccounts = await this.connection.getProgramAccounts(
                GOVERNANCE_PROGRAM_ID,
                {
                    filters: [
                        { dataSize: 512 }, // Proposal account size
                        {
                            memcmp: {
                                offset: 0,
                                bytes: Buffer.from([1]).toString('base64') // Proposal discriminator
                            }
                        }
                    ]
                }
            );

            const proposals: Proposal[] = [];

            for (const account of proposalAccounts) {
                try {
                    const data = account.account.data;

                    // Parse proposal data from account
                    const proposal: Proposal = {
                        id: data.readUInt32LE(8),
                        proposer: new PublicKey(data.slice(12, 44)),
                        title: data.slice(44, 144).toString('utf8').replace(/\0/g, ''),
                        description: data.slice(144, 400).toString('utf8').replace(/\0/g, ''),
                        proposalType: data.readUInt8(400) as unknown as ProposalType,
                        votingStart: Number(data.readBigUInt64LE(401)),
                        votingEnd: Number(data.readBigUInt64LE(409)),
                        votesFor: new BN(data.readBigUInt64LE(417).toString()),
                        votesAgainst: new BN(data.readBigUInt64LE(425).toString()),
                        totalVoters: data.readUInt32LE(433),
                        status: data.readUInt8(437) as unknown as ProposalStatus,
                        createdAt: Number(data.readBigUInt64LE(438)),
                        executedAt: Number(data.readBigUInt64LE(446))
                    };

                    proposals.push(proposal);
                } catch (error) {
                }
            }

            return proposals;
        } catch (error) {
            return [];
        }
    }
    
    async createProposal(
        title: string,
        description: string,
        proposalType: ProposalType,
        // executionData: Buffer = Buffer.from([])
    ): Promise<string> {
        if (!this.program || !this.provider) {
            throw new Error('Governance not initialized');
        }

        console.log('🔍 Creating proposal...');

        // Ensure wallet publicKey is a PublicKey instance
        const walletPubkey = typeof this.provider.wallet.publicKey === 'string'
            ? new PublicKey(this.provider.wallet.publicKey)
            : this.provider.wallet.publicKey;

        console.log('👤 Wallet:', walletPubkey.toBase58());

        // Derive governance PDA from wallet
        const [governancePda] = getGovernancePDA(walletPubkey);
        console.log('🏛️ Governance PDA:', governancePda.toBase58());
        console.log('ℹ️ Proposal PDA will be auto-derived by Anchor from governance account');

        // Get proposer's RIFTS token account
        const proposerRiftsAccount = await getAssociatedTokenAddress(
            RIFTS_MINT,
            walletPubkey
        );
        console.log('💰 Proposer RIFTS account:', proposerRiftsAccount.toBase58());

        // We need to derive the proposal PDA first to create the vote snapshot seeds
        // But we don't know the proposal ID yet... we need to get it from governance
        let nextProposalId = 0;
        try {
            const governanceAccount = (this.program?.account as any)?.governance;
            if (this.program && governanceAccount) {
                const governanceData = await governanceAccount.fetch(governancePda);
                nextProposalId = Number(governanceData.totalProposals);
            }
        } catch (error) {
            console.log('Failed to get next proposal ID');
        }

        // Derive the proposal PDA that WILL be created
        const proposalIdBuffer = Buffer.alloc(8);
        // Browser-compatible BigInt writing using DataView
        const proposalIdView = new DataView(proposalIdBuffer.buffer, proposalIdBuffer.byteOffset, proposalIdBuffer.byteLength);
        proposalIdView.setBigUint64(0, BigInt(nextProposalId), true); // true = little-endian
        const [futureProposalPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('proposal'), governancePda.toBuffer(), proposalIdBuffer],
            GOVERNANCE_PROGRAM_ID
        );

        // Derive proposer's vote snapshot PDA
        const [proposerVoteSnapshotPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('vote_snapshot'), futureProposalPda.toBuffer(), walletPubkey.toBuffer()],
            GOVERNANCE_PROGRAM_ID
        );
        console.log('📸 Proposer vote snapshot PDA:', proposerVoteSnapshotPda.toBase58());

        // Convert TypeScript enum to Anchor enum format
        const anchorProposalType = this.convertToAnchorEnum(proposalType);
        console.log('📋 Proposal Type (Anchor format):', anchorProposalType);

        // Execution data as Buffer (empty for now)
        const executionData = Buffer.from([]);
        console.log('📊 Execution data:', executionData);

        // Create real proposal transaction
        const transaction = new Transaction();

        // Add create proposal instruction
        // DEBUG: Log all accounts being passed
        console.log('🔍 DEBUG - Accounts being passed to createProposal:');
        console.log('  proposer:', walletPubkey.toBase58());
        console.log('  governance:', governancePda.toBase58());
        console.log('  futureProposalPda:', futureProposalPda.toBase58());
        console.log('  proposerRiftsAccount:', proposerRiftsAccount.toBase58());
        console.log('  riftsMint:', RIFTS_MINT.toBase58());
        console.log('  proposerVoteSnapshot:', proposerVoteSnapshotPda.toBase58());
        console.log('  systemProgram:', SystemProgram.programId.toBase58());

        // Note: Anchor will auto-derive the 'proposal' PDA using seeds from the IDL
        const instruction = await this.program.methods
            .createProposal(title, description, anchorProposalType, executionData)
            .accounts({
                proposer: walletPubkey,
                governance: governancePda,
                // proposal PDA auto-derived by Anchor from: ["proposal", governance, governance.total_proposals]
                proposerRiftsAccount: proposerRiftsAccount,
                riftsMint: RIFTS_MINT,
                proposerVoteSnapshot: proposerVoteSnapshotPda, // **AUTO-SNAPSHOT**: Create snapshot for proposer
                systemProgram: SystemProgram.programId,
            })
            .instruction();

        console.log('📋 Instruction created');
        console.log('🔍 DEBUG - Instruction keys:');
        instruction.keys.forEach((key, index) => {
            console.log(`  [${index}] ${key.pubkey.toBase58()} (writable: ${key.isWritable}, signer: ${key.isSigner})`);
        });

        transaction.add(instruction);

        // Get recent blockhash
        const { blockhash } = await this.connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = walletPubkey;

        console.log('📝 Transaction ready to sign:', {
            feePayer: transaction.feePayer.toBase58(),
            recentBlockhash: transaction.recentBlockhash,
            instructions: transaction.instructions.length
        });

        // Sign transaction with Phantom wallet directly
        console.log('📤 Requesting signature from Phantom...');

        // Access Phantom wallet from window
        if (typeof window === 'undefined' || !(window as any).solana) {
            throw new Error('Phantom wallet not found');
        }

        const phantom = (window as any).solana;

        // Sign the transaction
        const signedTx = await phantom.signTransaction(transaction);
        console.log('✅ Transaction signed by wallet');

        // Send signed transaction
        console.log('📡 Broadcasting transaction...');
        const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed'
        });
        console.log('📨 Transaction sent:', signature);

        // Wait for confirmation
        console.log('⏳ Waiting for confirmation...');
        await this.connection.confirmTransaction(signature, 'confirmed');
        console.log('✅ Transaction confirmed:', signature);

        // SAVE TO SUPABASE IMMEDIATELY FOR INSTANT DISPLAY!
        // READ REAL DATA FROM BLOCKCHAIN TO GET CORRECT TIMESTAMPS
        try {
            const { createClient } = await import('@supabase/supabase-js');
            const supabase = createClient(
                process.env.NEXT_PUBLIC_SUPABASE_URL!,
                process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
            );

            // Get governance account to get the actual proposal ID
            let proposalId = 0;
            try {
                const governanceAccount = (this.program?.account as any)?.governance;
                if (this.program && governanceAccount) {
                    const governanceData = await governanceAccount.fetch(governancePda);
                    proposalId = Number(governanceData.totalProposals) - 1;
                    console.log('📊 Created proposal ID:', proposalId);
                }
            } catch (error) {
                console.log('Failed to get proposal ID, using 0');
            }

            // NOW READ THE ACTUAL PROPOSAL FROM BLOCKCHAIN TO GET REAL TIMESTAMPS!
            console.log('📖 Reading proposal from blockchain...');
            const proposalPda = await this.getProposalPDA(proposalId);

            let realProposalData;
            try {
                const proposalAccount = (this.program?.account as any)?.proposal;
                if (this.program && proposalAccount) {
                    realProposalData = await proposalAccount.fetch(proposalPda);
                    console.log('✅ Got real proposal data from blockchain (RAW):', {
                        votingStart: Number(realProposalData.votingStart),
                        votingStartDate: new Date(Number(realProposalData.votingStart) * 1000).toISOString(),
                        votingEnd: Number(realProposalData.votingEnd),
                        votingEndDate: new Date(Number(realProposalData.votingEnd) * 1000).toISOString(),
                        createdAt: Number(realProposalData.createdAt),
                        createdAtDate: new Date(Number(realProposalData.createdAt) * 1000).toISOString()
                    });
                }
            } catch (error) {
                console.error('Failed to read proposal from blockchain:', error);
            }

            // Use REAL timestamps from blockchain, or fallback to immediate start
            const votingStart = realProposalData
                ? new Date(Number(realProposalData.votingStart) * 1000)
                : new Date(); // Fallback: NOW

            const votingEnd = realProposalData
                ? new Date(Number(realProposalData.votingEnd) * 1000)
                : new Date(votingStart.getTime() + 86400 * 1000); // Fallback: 24h from now

            const proposalData = {
                id: proposalId,
                proposer: walletPubkey.toBase58(),
                title: title,
                description: description,
                proposal_type: proposalType,
                voting_start: votingStart.toISOString(), // REAL timestamp from blockchain
                voting_end: votingEnd.toISOString(), // REAL timestamp from blockchain
                votes_for: realProposalData ? Number(realProposalData.votesFor) : 0,
                votes_against: realProposalData ? Number(realProposalData.votesAgainst) : 0,
                total_voters: realProposalData ? Number(realProposalData.totalVoters) : 0,
                status: 'Active',
                created_at: realProposalData
                    ? new Date(Number(realProposalData.createdAt) * 1000).toISOString()
                    : new Date().toISOString(),
                signature: signature
            };

            console.log('💾 Saving proposal to Supabase with REAL blockchain data:', proposalData);
            console.log('🔍 DEBUG - Timestamps being saved:', {
                created_at: proposalData.created_at,
                voting_start: proposalData.voting_start,
                voting_end: proposalData.voting_end
            });

            const { error } = await supabase
                .from('governance_proposals')
                .upsert(proposalData, { onConflict: 'id' });

            if (error) {
                console.error('❌ Failed to save proposal to Supabase:', error);
            } else {
                console.log('✅ Proposal saved to Supabase!');
            }
        } catch (error) {
            console.error('❌ Error saving to Supabase:', error);
        }

        return signature;
    }
    
    async castVote(proposalId: number, vote: VoteChoice): Promise<string> {
        if (!this.program || !this.provider) {
            throw new Error('Governance not initialized');
        }

        // Ensure wallet publicKey is a PublicKey instance
        const walletPubkey = typeof this.provider.wallet.publicKey === 'string'
            ? new PublicKey(this.provider.wallet.publicKey)
            : this.provider.wallet.publicKey;

        console.log('🗳️ Casting vote...');
        console.log('Proposal ID:', proposalId);
        console.log('Vote:', vote);

        // Convert vote to Anchor enum format
        const anchorVote = vote === VoteChoice.For ? { for: {} } : { against: {} };
        console.log('Anchor vote format:', anchorVote);

        // Get proposal PDA
        const proposalPda = await this.getProposalPDA(proposalId);
        console.log('Proposal PDA:', proposalPda.toBase58());

        // Get voter's RIFTS token account
        const voterRiftsAccount = await getAssociatedTokenAddress(
            RIFTS_MINT,
            walletPubkey
        );
        console.log('Voter RIFTS account:', voterRiftsAccount.toBase58());

        // Derive governance PDA
        const [governancePda] = getGovernancePDA(walletPubkey);

        // Derive vote record PDA: ["vote", proposal, voter]
        const [voteRecordPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('vote'), proposalPda.toBuffer(), walletPubkey.toBuffer()],
            GOVERNANCE_PROGRAM_ID
        );

        // Derive vote snapshot PDA: ["vote_snapshot", proposal, voter]
        const [voteSnapshotPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('vote_snapshot'), proposalPda.toBuffer(), walletPubkey.toBuffer()],
            GOVERNANCE_PROGRAM_ID
        );

        // CHECK IF VOTE SNAPSHOT EXISTS - if not, create it first!
        const snapshotAccount = await this.connection.getAccountInfo(voteSnapshotPda);
        const needsSnapshot = !snapshotAccount || snapshotAccount.data.length === 0;

        if (needsSnapshot) {
            console.log('⚠️ Vote snapshot not found, creating it first...');
        } else {
            console.log('✅ Vote snapshot already exists');
        }

        // Create real vote transaction
        const transaction = new Transaction();

        // IF SNAPSHOT DOESN'T EXIST, CREATE IT FIRST
        if (needsSnapshot) {
            const createSnapshotIx = await this.program.methods
                .createVoteSnapshot(new BN(proposalId))
                .accounts({
                    voter: walletPubkey,
                    voteSnapshot: voteSnapshotPda,
                    proposal: proposalPda,
                    voterRiftsAccount: voterRiftsAccount,
                    governance: governancePda,
                    systemProgram: SystemProgram.programId,
                })
                .instruction();

            console.log('📸 Adding create snapshot instruction');
            transaction.add(createSnapshotIx);
        }

        // Add vote instruction - only takes vote as argument, NOT proposalId
        const instruction = await this.program.methods
            .castVote(anchorVote)
            .accounts({
                voter: walletPubkey,
                proposal: proposalPda,
                voteRecord: voteRecordPda,
                voterRiftsAccount: voterRiftsAccount,
                voteSnapshot: voteSnapshotPda,
                governance: governancePda,
                riftsMint: RIFTS_MINT,
                systemProgram: SystemProgram.programId,
            })
            .instruction();

        console.log('📋 Vote instruction created');
        transaction.add(instruction);

        // Get recent blockhash
        const { blockhash } = await this.connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = walletPubkey;

        console.log('📤 Requesting signature from Phantom...');

        // Sign transaction with Phantom wallet directly
        if (typeof window === 'undefined' || !(window as any).solana) {
            throw new Error('Phantom wallet not found');
        }

        const phantom = (window as any).solana;
        const signedTx = await phantom.signTransaction(transaction);
        console.log('✅ Transaction signed');

        // Send signed transaction
        console.log('📡 Broadcasting vote...');
        const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed'
        });
        console.log('📨 Vote transaction sent:', signature);

        // Wait for confirmation
        await this.connection.confirmTransaction(signature, 'confirmed');
        console.log('✅ Vote confirmed:', signature);

        return signature;
    }

    async createSnapshot(proposalId: number): Promise<string> {
        if (!this.program || !this.provider) {
            throw new Error('Governance not initialized');
        }

        console.log('📸 Creating vote snapshot for proposal', proposalId);

        // Ensure wallet publicKey is a PublicKey instance
        const walletPubkey = typeof this.provider.wallet.publicKey === 'string'
            ? new PublicKey(this.provider.wallet.publicKey)
            : this.provider.wallet.publicKey;

        // Get voter's RIFTS token account
        const voterRiftsAccount = await getAssociatedTokenAddress(
            RIFTS_MINT,
            walletPubkey
        );

        // Derive governance PDA from wallet
        const [governancePda] = getGovernancePDA(walletPubkey);

        // Get proposal PDA
        const proposalPda = await this.getProposalPDA(proposalId);

        // Derive vote snapshot PDA: ["vote_snapshot", proposal, voter]
        const [voteSnapshotPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('vote_snapshot'), proposalPda.toBuffer(), walletPubkey.toBuffer()],
            GOVERNANCE_PROGRAM_ID
        );

        // Check if snapshot already exists
        const snapshotAccount = await this.connection.getAccountInfo(voteSnapshotPda);
        if (snapshotAccount && snapshotAccount.data.length > 0) {
            console.log('✅ Snapshot already exists');
            throw new Error('Snapshot already created for this proposal');
        }

        // Create snapshot transaction
        const transaction = new Transaction();

        const createSnapshotIx = await this.program.methods
            .createVoteSnapshot(new BN(proposalId))
            .accounts({
                voter: walletPubkey,
                voteSnapshot: voteSnapshotPda,
                proposal: proposalPda,
                voterRiftsAccount: voterRiftsAccount,
                governance: governancePda,
                systemProgram: SystemProgram.programId,
            })
            .instruction();

        transaction.add(createSnapshotIx);

        // Get recent blockhash
        const { blockhash } = await this.connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = walletPubkey;

        console.log('📤 Requesting signature from Phantom...');

        // Sign transaction with Phantom wallet
        if (typeof window === 'undefined' || !(window as any).solana) {
            throw new Error('Phantom wallet not found');
        }

        const phantom = (window as any).solana;
        const signedTx = await phantom.signTransaction(transaction);
        console.log('✅ Transaction signed');

        // Send signed transaction
        console.log('📡 Broadcasting snapshot creation...');
        const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed'
        });
        console.log('📨 Snapshot transaction sent:', signature);

        // Wait for confirmation
        await this.connection.confirmTransaction(signature, 'confirmed');
        console.log('✅ Snapshot confirmed:', signature);

        return signature;
    }

    async hasUserCreatedSnapshot(proposalId: number, userWallet: string): Promise<boolean> {
        if (!this.program) {
            throw new Error('Governance not initialized');
        }

        const walletPubkey = new PublicKey(userWallet);
        const proposalPda = await this.getProposalPDA(proposalId);

        // Derive vote snapshot PDA
        const [voteSnapshotPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('vote_snapshot'), proposalPda.toBuffer(), walletPubkey.toBuffer()],
            GOVERNANCE_PROGRAM_ID
        );

        // Check if snapshot exists
        const snapshotAccount = await this.connection.getAccountInfo(voteSnapshotPda);
        return snapshotAccount !== null && snapshotAccount.data.length > 0;
    }

    async getProposalPDA(proposalId: number, governancePda?: PublicKey): Promise<PublicKey> {
        // If governance PDA not provided, derive it from the current wallet
        if (!governancePda) {
            const walletPubkey = typeof this.provider!.wallet.publicKey === 'string'
                ? new PublicKey(this.provider!.wallet.publicKey)
                : this.provider!.wallet.publicKey;
            [governancePda] = getGovernancePDA(walletPubkey);
        }

        // Derive using correct seeds: ["proposal", governance, proposal_id_as_u64]
        const proposalIdBuffer = Buffer.alloc(8);
        // Browser-compatible BigInt writing using DataView
        const proposalIdView = new DataView(proposalIdBuffer.buffer, proposalIdBuffer.byteOffset, proposalIdBuffer.byteLength);
        proposalIdView.setBigUint64(0, BigInt(proposalId), true); // true = little-endian

        const [proposalPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("proposal"), governancePda.toBuffer(), proposalIdBuffer],
            GOVERNANCE_PROGRAM_ID
        );
        return proposalPDA;
    }
    
    async executeProposal(proposalId: number): Promise<string> {
        if (!this.program || !this.provider) {
            throw new Error('Governance not initialized');
        }

        // Ensure wallet publicKey is a PublicKey instance
        const walletPubkey = typeof this.provider.wallet.publicKey === 'string'
            ? new PublicKey(this.provider.wallet.publicKey)
            : this.provider.wallet.publicKey;

        // Derive governance PDA from wallet
        const [governancePda] = getGovernancePDA(walletPubkey);

        // Create real proposal execution transaction
        const transaction = new Transaction();

        // Add execute instruction
        const instruction = await this.program.methods
            .executeProposal(proposalId)
            .accounts({
                executor: walletPubkey,
                proposal: await this.getProposalPDA(proposalId),
                governance: governancePda,
            })
            .instruction();

        transaction.add(instruction);

        // Send transaction
        const signature = await this.provider.sendAndConfirm(transaction);

        return signature;
    }

    async initializeGovernance(): Promise<string> {
        if (!this.program || !this.provider) {
            throw new Error('Governance not initialized');
        }


        // Ensure wallet publicKey is a PublicKey instance
        const walletPubkey = typeof this.provider.wallet.publicKey === 'string'
            ? new PublicKey(this.provider.wallet.publicKey)
            : this.provider.wallet.publicKey;

        // Derive governance PDA from wallet
        const [governancePda] = getGovernancePDA(walletPubkey);

        // Create initialization transaction
        const transaction = new Transaction();

        // Note: Program enforces minimum 24h voting (86400s) and 6h execution delay (21600s)
        // Add initialize instruction (using snake_case as per IDL)
        const instruction = await this.program.methods
            .initializeGovernance(
                RIFTS_MINT,
                new BN(86400), // 24 hours min voting period (required by program)
                new BN(21600)  // 6 hours min execution delay (required by program)
            )
            .accounts({
                authority: walletPubkey,
                governance: governancePda,
                riftsMint: RIFTS_MINT,  // Anchor converts snake_case rifts_mint to camelCase
                systemProgram: SystemProgram.programId,
            })
            .instruction();

        transaction.add(instruction);

        // Get recent blockhash
        const { blockhash } = await this.connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = walletPubkey;

        console.log('📝 Initialize governance transaction ready');

        // Sign transaction with Phantom wallet directly
        if (typeof window === 'undefined' || !(window as any).solana) {
            throw new Error('Phantom wallet not found');
        }

        const phantom = (window as any).solana;

        // Sign the transaction
        const signedTx = await phantom.signTransaction(transaction);
        console.log('✅ Transaction signed');

        // Send signed transaction
        const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed'
        });
        console.log('📨 Transaction sent:', signature);

        // Wait for confirmation
        await this.connection.confirmTransaction(signature, 'confirmed');
        console.log('✅ Governance initialized:', signature);

        return signature;
    }

    /**
     * Convert TypeScript ProposalType enum to Anchor enum format
     * Anchor expects: { parameterChange: {} } instead of "ParameterChange"
     */
    private convertToAnchorEnum(proposalType: ProposalType): Record<string, object> {
        switch (proposalType) {
            case ProposalType.ParameterChange:
                return { parameterChange: {} };
            case ProposalType.TreasurySpend:
                return { treasurySpend: {} };
            case ProposalType.ProtocolUpgrade:
                return { protocolUpgrade: {} };
            case ProposalType.EmergencyAction:
                return { emergencyAction: {} };
            default:
                return { parameterChange: {} };
        }
    }

    formatVotingPower(amount: BN): string {
        const power = amount.div(new BN(10).pow(new BN(9)));
        return power.toNumber().toLocaleString();
    }
    
    calculateVotePercentage(votesFor: BN, votesAgainst: BN): { for: number, against: number } {
        const total = votesFor.add(votesAgainst);
        if (total.isZero()) {
            return { for: 0, against: 0 };
        }
        
        const forPercentage = votesFor.mul(new BN(100)).div(total).toNumber();
        const againstPercentage = 100 - forPercentage;
        
        return { for: forPercentage, against: againstPercentage };
    }
    
    isVotingActive(proposal: Proposal): boolean {
        const currentTime = Date.now() / 1000;
        return currentTime >= proposal.votingStart && currentTime <= proposal.votingEnd;
    }
    
    canExecute(proposal: Proposal, minExecutionDelay: number = 86400): boolean {
        const currentTime = Date.now() / 1000;
        return proposal.status === ProposalStatus.Active &&
               currentTime > proposal.votingEnd + minExecutionDelay &&
               proposal.votesFor.gt(proposal.votesAgainst);
    }
}

// Export singleton instance - uses Alchemy from env variable
export const governanceService = new GovernanceService(
    typeof window !== 'undefined'
        ? (() => {
            const { ProxiedConnection } = require('./rpc-client');
            return new ProxiedConnection();
          })()
        : new Connection(
            require('./rpc-endpoints').getHeliusHttpRpcUrl(),
            {
              commitment: 'confirmed',
              wsEndpoint: undefined,
              disableRetryOnRateLimit: true,
            }
          )
);
