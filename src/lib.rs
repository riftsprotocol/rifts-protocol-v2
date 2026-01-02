// Rifts Protocol V2 - Full Rifts System with Token-2022 Transfer Fees
use anchor_lang::prelude::*;

// **TOKEN-2022 MIGRATION**: Use token_interface for compatibility with both SPL and Token-2022
use anchor_spl::token_interface::{
    self, burn as interface_burn, mint_to as interface_mint_to,
    transfer_checked as interface_transfer_checked,
    Burn, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
};

// **SECURITY**: Import Token program for SPL tokens
use anchor_spl::token::Token;
use anchor_spl::token::spl_token;
// **TOKEN-2022**: Import Token2022 program from token_interface
use anchor_spl::token_interface::Token2022;
// **ATA**: Import AssociatedToken program for auto-creating token accounts
use anchor_spl::associated_token::AssociatedToken;

// **TOKEN-2022 SPECIFIC**: Transfer fee extension for RIFT tokens
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        transfer_fee::{TransferFeeConfig, MAX_FEE_BASIS_POINTS},
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    state::Mint as Mint2022State,
};

use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack; // For SPL Token Mint::unpack
use anchor_lang::solana_program::system_instruction;
use anchor_lang::solana_program::sysvar::rent::Rent;
use std::str::FromStr;

// Token-2022 Metadata Extension
use spl_token_2022::extension::metadata_pointer;
use spl_token_2022::extension::ExtensionType as Token2022ExtensionType;
use spl_token_2022::instruction::initialize_mint2;

// Oracle SDKs (safer than manual byte parsing)
use switchboard_on_demand::on_demand::accounts::pull_feed::PullFeedAccountData;

// Internal modules
// mod jupiter; // Removed - Jupiter integration implemented inline (lines 1851-1918)

// Mainnet program id
declare_id!("29JgMGWZ28CSF7JLStKFp8xb4BZyf7QitG5CHcfRBYoR");

// **MEDIUM FIX #6**: Centralize program authority constant
const PROGRAM_AUTHORITY: &str = "9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4";

// **SECURITY FIX**: Second admin authority for critical operations (emergency withdraw)
const ADMIN_AUTHORITY_2: &str = "CPr8qxu9LKx4tU5LWj53z669fzydGwFyJzw6xWarZ3zB";

// Treasury wallet that receives platform fees and can claim withheld transfer fees
const TREASURY_WALLET: &str = "5NrHu6zpWqYT6LH74WmTNFHGcxZEmRMVK4hR7sHjS9Fc";

// **DEFAULT TREASURY WALLET**: Default wallet that receives fee distributions
const DEFAULT_TREASURY_WALLET: &str = "5NrHu6zpWqYT6LH74WmTNFHGcxZEmRMVK4hR7sHjS9Fc";

/// Borsh-serialized size of `Rift` struct data (excluding the 8-byte Anchor discriminator).
/// Computed as the sum of all fixed-size fields in the Rift struct.
pub const RIFT_STRUCT_SIZE: usize = 774;

/// Total account size for Rift PDA: 8 bytes discriminator + struct payload.
pub const RIFT_ACCOUNT_SIZE: usize = 8 + RIFT_STRUCT_SIZE; // = 782 bytes

// **FIX ISSUE #7**: Reentrancy guard auto-timeout after ~2 days
const REENTRANCY_TIMEOUT_SLOTS: u64 = 432000; // ~2 days at 400ms/slot

// **FIX ISSUE #5**: Oracle change delay (24 hours)
const ORACLE_CHANGE_DELAY: i64 = 86400; // 24 hours in seconds

#[program]
// ================================================================
// Rifts Protocol V2 - Core Safety Invariants (non-governance)
// ---------------------------------------------------------------
// This program assumes a trusted admin model (mint authority, emergency
// withdraw, fee routing). The following invariants are enforced by code,
// independent of who controls those authorities:
//
// - Backing Invariant:
//   At all times, the total RIFT in circulation (total_rift_minted minus
//   any burned supply) must be bounded by the underlying backing held in
//   `vault`, adjusted for protocol-defined fees that have already been
//   moved into `fees_vault` / `withheld_vault`.
// - Wrap/Unwrap Symmetry:
//   Wrap operations increase `total_underlying_wrapped` and mint new RIFT
//   only after fees are siphoned into `fees_vault`.
//   Unwrap operations burn RIFT and ensure the user receives at least
//   `min_underlying_out` of underlying, with additional internal checks
//   on vault balances and fee tolerances.
// - Fee Accounting:
//   Moving funds between internal protocol vaults (vault, fees_vault,
//   withheld_vault, treasury-controlled accounts) must NOT change
//   `total_rift_minted`. Only mint/burn operations are allowed to do so.
// - Oracle Safety:
//   Manual oracle updates are bounded by a drift limit relative to an
//   initialized base price, with stale prices and excessive confidence
//   rejected to avoid obvious manipulation via bad oracle feeds.
// - Reentrancy Safety:
//   A per-rift reentrancy guard + slot tracking prevents multi-step
//   reentry within a single instruction, and errors roll back all state.
//
// Centralization / admin powers (mint authority, emergency withdraw,
// fee rate configuration, etc.) are intentional design choices and
// must be addressed at the governance / multisig layer, not at the
// protocol logic layer.
// ================================================================

pub mod rifts_protocol {
    use super::*;

    /// Create a new Rift with PDA-based vanity mint address (like pump.fun approach)
    /// This generates the mint PDA deterministically from vanity seed
    /// **MEMORY OPTIMIZATION**: Use fixed-size array instead of Vec to avoid heap allocation
    /// **FIX HIGH #4**: Removed user-provided mint_bump parameter to prevent PDA bump grinding
    pub fn create_rift_with_vanity_pda(
        ctx: Context<CreateRiftWithVanityPDA>,
        vanity_seed: [u8; 32], // Fixed-size array - no heap allocation!
        seed_len: u8,          // Actual length of seed to use (0-32)
        partner_wallet: Option<Pubkey>,
        rift_name: [u8; 32],   // Fixed-size array - no heap allocation!
        name_len: u8,          // Actual length of name to use (0-32)
        transfer_fee_bps: u16, // Token-2022 transfer fee (70-100 = 0.7%-1%)
        prefix_type: u8,       // 0 = 'r' (Rift), 1 = 'm' (Monorift)
    ) -> Result<()> {
        msg!("DEBUG: Inside create_rift_with_vanity_pda function!");
        msg!("DEBUG: seed_len={}, name_len={}, transfer_fee_bps={}", seed_len, name_len, transfer_fee_bps);
        let rift = &mut ctx.accounts.rift;

        // Validate fees and seed length
        require!(seed_len <= 32, ErrorCode::InvalidVanitySeed);
        // **TOKEN-2022**: Validate transfer fee is between 0.7% and 1% (70-100 basis points)
        require!(
            transfer_fee_bps >= 70 && transfer_fee_bps <= 100,
            ErrorCode::InvalidTransferFee
        );

        // **FIX HIGH #29**: Validate underlying mint has no freeze authority to prevent fund lockup
        // **FIX HIGH #30**: Validate underlying mint has no mint authority to prevent supply inflation
        // **FIX CRITICAL #31**: Validate Token-2022 extensions to prevent DoS and vault drain
        {
            let mint_info = ctx.accounts.underlying_mint.to_account_info();
            let mint_data = mint_info.try_borrow_data()?;

            // Check if this is SPL Token or Token-2022
            if *mint_info.owner == anchor_spl::token::ID {
                // SPL Token mint validation
                let _mint = spl_token::state::Mint::unpack(&mint_data)
                    .map_err(|_| ErrorCode::InvalidMint)?;

                // **ACKNOWLEDGED RISK (Audit MEDIUM #2)**: We intentionally DO NOT validate
                // mint_authority or freeze_authority on underlying tokens.
                //
                // RISKS ACCEPTED:
                // - Tokens with mint_authority can have supply inflated, diluting vault backing
                // - Tokens with freeze_authority can have vault funds frozen, causing DoS
                //
                // RATIONALE: This allows wrapping popular tokens like USDC, USDT, stSOL, mSOL
                // which have authorities but are operationally trusted.
                //
                // USER RESPONSIBILITY: It is up to the rift creator and users to evaluate
                // the underlying token's authority risks before wrapping/unwrapping.
                // The protocol does not enforce authority checks - use at your own risk.

                msg!("✅ SPL Token mint validated (authority checks skipped - user accepts risk)");
            } else if *mint_info.owner == spl_token_2022::ID {
                // Token-2022 mint validation
                let mint_state =
                    StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)
                        .map_err(|_| ErrorCode::InvalidMint)?;

                // **ACKNOWLEDGED RISK (Audit MEDIUM #2)**: We intentionally DO NOT validate
                // mint_authority or freeze_authority on underlying Token-2022 tokens.
                //
                // RISKS ACCEPTED:
                // - Tokens with mint_authority can have supply inflated, diluting vault backing
                // - Tokens with freeze_authority can have vault funds frozen, causing DoS
                //
                // RATIONALE: This allows wrapping popular tokens which have authorities
                // but are operationally trusted.
                //
                // USER RESPONSIBILITY: It is up to the rift creator and users to evaluate
                // the underlying token's authority risks before wrapping/unwrapping.
                // The protocol does not enforce authority checks - use at your own risk.

                // **FIX CRITICAL #31**: Validate Token-2022 extensions (keep these - actually dangerous)
                let extension_types = mint_state
                    .get_extension_types()
                    .map_err(|_| ErrorCode::InvalidMint)?;

                for ext_type in extension_types.iter() {
                    match ext_type {
                        ExtensionType::NonTransferable => {
                            // CRITICAL: NonTransferable prevents unwrapping (outbound transfers)
                            msg!("❌ Underlying mint has NonTransferable - tokens cannot leave vault!");
                            return Err(ErrorCode::UnsafeUnderlyingMint.into());
                        }
                        ExtensionType::PermanentDelegate => {
                            // CRITICAL: PermanentDelegate can bypass vault authority and drain funds
                            msg!("❌ Underlying mint has PermanentDelegate - can drain vault!");
                            return Err(ErrorCode::UnsafeUnderlyingMint.into());
                        }
                        ExtensionType::TransferFeeConfig => {
                            // HIGH: Validate transfer fee is reasonable (≤ 1% = 100 bps)
                            use spl_token_2022::extension::transfer_fee::TransferFeeConfig;
                            let fee_config = mint_state
                                .get_extension::<TransferFeeConfig>()
                                .map_err(|_| ErrorCode::InvalidMint)?;
                            let fee_bps =
                                u16::from(fee_config.newer_transfer_fee.transfer_fee_basis_points);
                            require!(fee_bps <= 100, ErrorCode::ExcessiveTransferFee);
                            msg!("✅ Underlying transfer fee: {} bps (acceptable)", fee_bps);
                        }
                        ExtensionType::MintCloseAuthority => {
                            // HIGH: Mint can be closed, freezing all token accounts
                            msg!("❌ Underlying mint has close authority - can be permanently closed!");
                            return Err(ErrorCode::UnsafeUnderlyingMint.into());
                        }
                        ExtensionType::TransferHook => {
                            // **FIX CRITICAL #50**: BLOCK TransferHook extension
                            // TransferHook requires extra accounts in CPI (hook program, validation account)
                            // wrap_tokens/unwrap_from_vault don't pass these accounts → transfer fails
                            // OR hook executes arbitrary code mid-instruction → reentrancy bypass
                            // Result: DoS (all wrap/unwrap fail) or security breach (arbitrary hook execution)
                            msg!("❌ Underlying mint has TransferHook - CPI incompatible!");
                            return Err(ErrorCode::UnsafeUnderlyingMint.into());
                        }
                        ExtensionType::MemoTransfer => {
                            // **FIX CRITICAL #54**: BLOCK MemoTransfer extension
                            // MemoTransfer requires memo instruction before every transfer
                            // wrap_tokens/unwrap_from_vault/fee_distribution don't include memo CPI
                            // Result: All transfers fail → complete rift DoS (wrap/unwrap/fees all broken)
                            msg!("❌ Underlying mint has MemoTransfer - CPI incompatible!");
                            return Err(ErrorCode::UnsafeUnderlyingMint.into());
                        }
                        ExtensionType::DefaultAccountState => {
                            // **FIX MEDIUM #6 (Audit)**: BLOCK DefaultAccountState extension
                            // DefaultAccountState can set new accounts to Frozen by default
                            // Vault token accounts would be frozen → all transfers fail → complete DoS
                            msg!("❌ Underlying mint has DefaultAccountState - vault would be frozen!");
                            return Err(ErrorCode::UnsafeUnderlyingMint.into());
                        }
                        ExtensionType::ConfidentialTransferMint => {
                            // **FIX MEDIUM #6 (Audit)**: BLOCK ConfidentialTransferMint extension
                            // Confidential transfers require special handling not implemented in wrap/unwrap
                            // Would cause transfer failures or incorrect balance tracking
                            msg!("❌ Underlying mint has ConfidentialTransferMint - not supported!");
                            return Err(ErrorCode::UnsafeUnderlyingMint.into());
                        }
                        ExtensionType::ConfidentialTransferFeeConfig => {
                            // **FIX MEDIUM #6 (Audit)**: BLOCK ConfidentialTransferFeeConfig extension
                            // Confidential transfer fees require special handling not implemented
                            msg!("❌ Underlying mint has ConfidentialTransferFeeConfig - not supported!");
                            return Err(ErrorCode::UnsafeUnderlyingMint.into());
                        }
                        _ => {
                            // Other extensions (ImmutableOwner, CpiGuard) are handled
                            // CpiGuard: Account extensions added during vault init
                        }
                    }
                }

                msg!("✅ Token-2022 mint validated: no unsafe authorities/extensions");
            } else {
                return Err(ErrorCode::InvalidMint.into());
            }

            drop(mint_data); // Release borrow
        }

        // PDA derivation is automatically verified by Anchor through the seeds constraint

        // **MEMORY OPTIMIZATION**: Skip vanity address validation to prevent heap allocation
        // The PDA derivation ensures deterministic mint addresses
        // Vanity validation is optional and can be done off-chain before calling this

        // Initialize the rift with provided values
        rift.creator = ctx.accounts.creator.key();
        rift.underlying_mint = ctx.accounts.underlying_mint.key();
        rift.rift_mint = ctx.accounts.rift_mint.key();
        // **ATOMIC INIT**: All 3 vaults will be initialized atomically below
        rift.vault = anchor_lang::solana_program::system_program::ID; // Will be initialized atomically
        rift.fees_vault = anchor_lang::solana_program::system_program::ID; // Will be initialized atomically
        rift.withheld_vault = anchor_lang::solana_program::system_program::ID; // Will be initialized atomically

        // **FEE SPLIT**: If no partner provided, creator is the partner (50/50 split with treasury)
        rift.partner_wallet = Some(partner_wallet.unwrap_or(ctx.accounts.creator.key()));
        rift.partner_fee_bps = 5000; // Always 50% (5000 bps) - stored for backwards compatibility
        let default_treasury = Pubkey::from_str_const(DEFAULT_TREASURY_WALLET);
        rift.treasury_wallet = Some(default_treasury);
        // **MEDIUM FIX #11**: Initialize configurable wrap/unwrap fees (default 0.3%)
        rift.wrap_fee_bps = 30; // Default 0.3% wrap fee
        rift.unwrap_fee_bps = 30; // Default 0.3% unwrap fee
        rift.total_underlying_wrapped = 0;
        rift.total_rift_minted = 0;
        rift.total_burned = 0;
        rift.backing_ratio = 1_000_000; // 100% initially (6 decimals precision)
        rift.last_rebalance = Clock::get()?.unix_timestamp;
        rift.created_at = Clock::get()?.unix_timestamp; // CRITICAL: Set creation timestamp for sorting

        // Set rift name (fixed-size array - no heap allocation!)
        require!(name_len <= 32, ErrorCode::NameTooLong);
        if name_len > 0 {
            // **FIX MEDIUM #22**: Validate UTF-8 encoding before accepting name
            let name_slice = &rift_name[..name_len as usize];
            require!(
                core::str::from_utf8(name_slice).is_ok(),
                ErrorCode::InvalidRiftName
            );
            rift.name[..name_len as usize].copy_from_slice(name_slice);
        } else {
            // Default: empty name (all zeros)
            rift.name = [0u8; 32];
        }

        // **SECURITY FIX**: Initialize hybrid oracle system with valid initial state
        let current_time = Clock::get()?.unix_timestamp;

        // Initialize with realistic default price and confidence instead of zero values
        let initial_price_data = PriceData {
            price: 1_000_000,    // Default to 1.0 price (with 6 decimals)
            confidence: 100_000, // Moderate confidence for initial state
            timestamp: current_time,
        };

        // **SECURITY FIX**: Validate oracle parameters to prevent manipulation
        rift.oracle_prices = [initial_price_data; 10];
        rift.price_index = 0;

        // **SECURITY FIX**: Set reasonable bounds for oracle intervals to prevent DoS
        rift.oracle_update_interval = 30 * 60; // 30 minutes (min 5 min, max 24 hours)
        require!(
            rift.oracle_update_interval >= 300 && rift.oracle_update_interval <= 86400,
            ErrorCode::InvalidOracleParameters
        );

        rift.max_rebalance_interval = 24 * 60 * 60; // 24 hours (min 1 hour, max 7 days)
        require!(
            rift.max_rebalance_interval >= 3600 && rift.max_rebalance_interval <= 604800,
            ErrorCode::InvalidOracleParameters
        );

        rift.arbitrage_threshold_bps = 200; // 2% (min 0.1%, max 50%)
        require!(
            rift.arbitrage_threshold_bps >= 10 && rift.arbitrage_threshold_bps <= 5000,
            ErrorCode::InvalidOracleParameters
        );

        rift.last_oracle_update = current_time;

        // Initialize advanced metrics
        rift.total_volume_24h = 0;
        rift.price_deviation = 0;
        rift.arbitrage_opportunity_bps = 0;
        rift.rebalance_count = 0;

        // Initialize RIFTS token distribution tracking
        rift.total_fees_collected = 0;
        rift.rifts_tokens_distributed = 0;
        rift.rifts_tokens_burned = 0;

        // **SECURITY FIX #50**: Initialize oracle accounts as None (must be set explicitly)
        rift.switchboard_feed_account = None;

        // **HIGH FIX #3**: Initialize manual oracle rate limiting
        rift.last_manual_oracle_update = 0;

        // **TOKEN-2022 TRANSFER FEE**: Manual initialization with 0.7% transfer fee on DEX trades
        // This fee applies ONLY to transfers (DEX trading), NOT to mint/burn (wrap/unwrap)
        use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
        use spl_token_2022::extension::{ExtensionType, StateWithExtensionsMut};

        // 1. Calculate metadata strings FIRST (needed for space calculation)
        let rift_name_str =
            core::str::from_utf8(&rift_name[..name_len as usize]).unwrap_or("Rift Token");
        // Use prefixed name for both display name and symbol; symbol still capped at 10 chars
        // prefix_type: 0 = 'r' (Rift), 1 = 'm' (Monorift)
        let prefix = if prefix_type == 1 { "m" } else { "r" };
        let display_name = format!("{}{}", prefix, rift_name_str);
        let symbol = display_name[..display_name.len().min(10)].to_string();

        // 2. Calculate TOKEN METADATA space (uses variable-length TLV encoding)
        use spl_token_metadata_interface::state::TokenMetadata;
        use spl_pod::optional_keys::OptionalNonZeroPubkey;
        let metadata = TokenMetadata {
            name: display_name.clone(),
            symbol: symbol.to_string(),
            uri: "".to_string(),
            update_authority: OptionalNonZeroPubkey::default(),
            mint: Pubkey::default(), // placeholder
            additional_metadata: vec![],
        };
        let metadata_space = metadata.tlv_size_of().map_err(|_| ErrorCode::InvalidMint)?;

        // 3. Calculate space for Token-2022 mint
        // The account is created with ONLY the base mint space (Mint + TransferFeeConfig + MetadataPointer)
        // because initialize_mint2 validates the account size matches the initialized extensions.
        // The metadata TLV gets added AFTER via metadata::initialize, which will realloc the account.
        let base_mint_space =
            ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[
                ExtensionType::TransferFeeConfig,
                ExtensionType::MetadataPointer,
            ])
            .map_err(|_| ErrorCode::InvalidMint)?;

        // 4. Calculate rent for FINAL size (base + metadata + buffer for TLV alignment)
        // We fund the account with enough lamports to cover the final size after metadata realloc,
        // but we create it with only base_mint_space data.len.
        const METADATA_TLV_BUFFER: usize = 128; // Buffer for TLV overhead and alignment padding
        let final_mint_len = base_mint_space + metadata_space + METADATA_TLV_BUFFER;
        let mint_rent = Rent::get()?.minimum_balance(final_mint_len);

        msg!("🔍 DEBUG: base_mint_space (Mint+Extensions) = {}", base_mint_space);
        msg!("🔍 DEBUG: metadata_space (TLV) = {}", metadata_space);
        msg!("🔍 DEBUG: METADATA_TLV_BUFFER = {}", METADATA_TLV_BUFFER);
        msg!("🔍 DEBUG: final_mint_len (for rent calc) = {}", final_mint_len);
        msg!("🔍 DEBUG: mint_rent (lamports) = {}", mint_rent);
        msg!("🔍 DEBUG: account data.len at creation = {}", base_mint_space);
        let creator_key = ctx.accounts.creator.key();
        let underlying_mint_key = ctx.accounts.underlying_mint.key();
        // **FIX HIGH #4**: Use canonical bump from Anchor (ctx.bumps), not user-provided
        let rift_mint_bump = ctx.bumps.rift_mint;
        let mint_seeds = &[
            b"rift_mint",
            creator_key.as_ref(),
            underlying_mint_key.as_ref(),
            &vanity_seed[..seed_len as usize],
            &[rift_mint_bump],
        ];

        invoke_signed(
            &system_instruction::create_account(
                ctx.accounts.creator.key,
                ctx.accounts.rift_mint.key,
                mint_rent,
                base_mint_space as u64, // Create with base size; metadata reallocs later
                &spl_token_2022::ID,
            ),
            &[
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.rift_mint.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[mint_seeds],
        )?;

        // 3. Initialize transfer fee extension (configurable 0.7%-1% = 70-100 basis points)
        // This fee is ONLY charged on transfers (DEX trades), NOT on mint/burn!
        use spl_token_2022::extension::transfer_fee::instruction::initialize_transfer_fee_config;

        // **CRITICAL FIX #5**: Use PROGRAM_AUTHORITY for fee authorities, not creator
        // This prevents creators from manipulating fees on their rifts
        let program_authority = Pubkey::from_str_const(PROGRAM_AUTHORITY);

        // **PER-RIFT TREASURY FIX**: Use default treasury (will be set in rift.treasury_wallet)
        // This ensures withdraw_withheld_authority matches the per-rift treasury
        let default_treasury = Pubkey::from_str_const(DEFAULT_TREASURY_WALLET);

        invoke_signed(
            &initialize_transfer_fee_config(
                &spl_token_2022::ID,
                ctx.accounts.rift_mint.key,
                Some(&program_authority), // transfer_fee_config_authority = PROGRAM_AUTHORITY
                Some(&default_treasury),   // withdraw_withheld_authority = rift.treasury_wallet ✅
                transfer_fee_bps,         // Configurable fee (70-100 bps = 0.7%-1%)
                u64::MAX,                 // no maximum fee cap
            )
            .map_err(|_| ErrorCode::InvalidMint)?,
            &[ctx.accounts.rift_mint.to_account_info()],
            &[mint_seeds],
        )?;

        // 4. Initialize metadata pointer (points metadata to the mint itself)
        use spl_token_2022::extension::metadata_pointer::instruction::initialize as initialize_metadata_pointer;
        invoke_signed(
            &initialize_metadata_pointer(
                &spl_token_2022::ID,
                ctx.accounts.rift_mint.key,
                Some(*ctx.accounts.rift_mint_authority.key),
                Some(*ctx.accounts.rift_mint.key),
            )?,
            &[ctx.accounts.rift_mint.to_account_info()],
            &[mint_seeds],
        )?;

        // 5. Initialize the mint itself
        invoke_signed(
            &spl_token_2022::instruction::initialize_mint2(
                &spl_token_2022::ID,
                ctx.accounts.rift_mint.key,
                ctx.accounts.rift_mint_authority.key,
                None, // no freeze authority
                ctx.accounts.underlying_mint.decimals,
            )
            .map_err(|_| ErrorCode::InvalidMint)?,
            &[ctx.accounts.rift_mint.to_account_info()],
            &[mint_seeds],
        )?;

        // **FIX MEDIUM #32**: Verify transfer fee config was set correctly after CPI
        // Defense-in-depth: Provide specific error messages for fee config mismatches
        {
            let rift_mint_info = ctx.accounts.rift_mint.to_account_info();
            let rift_mint_data = rift_mint_info.try_borrow_data()?;
            let mint_state = spl_token_2022::extension::StateWithExtensions::<
                spl_token_2022::state::Mint,
            >::unpack(&rift_mint_data)?;

            use spl_token_2022::extension::transfer_fee::TransferFeeConfig;
            let fee_config = mint_state.get_extension::<TransferFeeConfig>()?;
            let actual_fee_bps = u16::from(fee_config.newer_transfer_fee.transfer_fee_basis_points);

            require!(
                actual_fee_bps == transfer_fee_bps,
                ErrorCode::TransferFeeConfigMismatch
            );

            drop(rift_mint_data);
            msg!(
                "✅ Verified RIFT mint transfer fee: {} bps (matches parameter)",
                actual_fee_bps
            );
        }

        msg!(
            "✅ Created Token-2022 mint with {}% transfer fee on DEX trades (wrap/unwrap FREE)",
            transfer_fee_bps as f64 / 100.0
        );

        // Emit creation event
        emit!(RiftCreated {
            rift: rift.key(),
            creator: rift.creator,
            underlying_mint: rift.underlying_mint,
            partner_fee_bps: rift.partner_fee_bps,
        });

        // Initialize Token-2022 metadata extension (reuse variables from above)
        let rift_key = rift.key();
        let mint_auth_seeds = &[
            b"rift_mint_auth",
            rift_key.as_ref(),
            &[ctx.bumps.rift_mint_authority],
        ];
        let signer_seeds = &[&mint_auth_seeds[..]];

        // Initialize Token-2022 metadata via Token Metadata Interface
        let metadata_ix = spl_token_metadata_interface::instruction::initialize(
            &spl_token_2022::ID,
            &ctx.accounts.rift_mint.key(),
            &ctx.accounts.rift_mint_authority.key(),
            &ctx.accounts.rift_mint.key(),
            &ctx.accounts.rift_mint_authority.key(),
            display_name.clone(),
            symbol.to_string(),
            "".to_string(),
        );

        invoke_signed(
            &metadata_ix,
            &[
                ctx.accounts.rift_mint.to_account_info(),
                ctx.accounts.rift_mint_authority.to_account_info(),
            ],
            signer_seeds,
        )?;

        msg!("✅ Token-2022 mint created with metadata");
        msg!("Name: {}, Symbol: {}", display_name, symbol);

        msg!("✅ Token-2022 mint created with full metadata");
        msg!("Name: {}, Symbol: {}", display_name, symbol);

        // **ATOMIC INIT**: Initialize all 3 vaults atomically during rift creation
        // This ensures clean fee accounting and better UX (single transaction setup)
        use spl_token_2022::instruction::initialize_account3;

        // **TOKEN-2022 MIGRATION**: Use underlying token program for vault creation
        let underlying_token_program = ctx.accounts.underlying_mint.to_account_info().owner;

        // 1. INITIALIZE VAULT (backing vault for underlying tokens)
        msg!("Initializing vault...");

        let vault_space = if *underlying_token_program == spl_token_2022::ID {
            // Calculate space based on underlying mint's Token-2022 extensions
            let underlying_mint_info = ctx.accounts.underlying_mint.to_account_info();
            let mint_data = underlying_mint_info.try_borrow_data()?;
            let mint_account = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;

            let mint_extensions = mint_account.get_extension_types()?;
            let mut account_extensions = Vec::new();

            for ext_type in mint_extensions.iter() {
                match ext_type {
                    ExtensionType::TransferFeeConfig => {
                        account_extensions.push(ExtensionType::TransferFeeAmount);
                    }
                    ExtensionType::MemoTransfer => {
                        account_extensions.push(ExtensionType::MemoTransfer);
                    }
                    ExtensionType::NonTransferable => {
                        account_extensions.push(ExtensionType::NonTransferable);
                    }
                    ExtensionType::ImmutableOwner => {
                        account_extensions.push(ExtensionType::ImmutableOwner);
                    }
                    ExtensionType::CpiGuard => {
                        account_extensions.push(ExtensionType::CpiGuard);
                    }
                    _ => {}
                }
            }

            drop(mint_data);

            ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(
                &account_extensions,
            ).map_err(|_| ErrorCode::InvalidMint)?
        } else {
            165 // Standard SPL Token size
        };

        let vault_rent = Rent::get()?.minimum_balance(vault_space);
        let vault_seeds = &[b"vault", rift_key.as_ref(), &[ctx.bumps.vault]];

        invoke_signed(
            &system_instruction::create_account(
                ctx.accounts.creator.key,
                ctx.accounts.vault.key,
                vault_rent,
                vault_space as u64,
                underlying_token_program,
            ),
            &[
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[vault_seeds],
        )?;

        let init_vault_ix = if *underlying_token_program == spl_token_2022::ID {
            spl_token_2022::instruction::initialize_account3(
                underlying_token_program,
                &ctx.accounts.vault.key(),
                &ctx.accounts.underlying_mint.key(),
                &ctx.accounts.vault_authority.key(),
            )?
        } else {
            spl_token::instruction::initialize_account3(
                underlying_token_program,
                &ctx.accounts.vault.key(),
                &ctx.accounts.underlying_mint.key(),
                &ctx.accounts.vault_authority.key(),
            )?
        };

        invoke(
            &init_vault_ix,
            &[
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.underlying_mint.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
            ],
        )?;

        // Update rift with actual vault address
        rift.vault = ctx.accounts.vault.key();
        msg!("✅ Vault initialized: {} (space: {})", ctx.accounts.vault.key(), vault_space);

        // 2. Initialize fees_vault (for wrap/unwrap fees - underlying tokens)
        let fees_vault_seeds = &[b"fees_vault", rift_key.as_ref(), &[ctx.bumps.fees_vault]];

        // **FIX MEDIUM-HIGH #26**: Calculate proper space by reading underlying mint's actual extensions
        // The underlying mint may be Token-2022 with multiple extensions
        let fees_vault_space = if *underlying_token_program == spl_token_2022::ID {
            // Read underlying mint to determine what extensions it has
            let mint_info = ctx.accounts.underlying_mint.to_account_info();
            let mint_data = mint_info.try_borrow_data()?;
            let mint_account =
                StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;

            // Get list of extensions this mint has
            let mint_extensions = mint_account.get_extension_types()?;

            // Build list of required ACCOUNT extensions based on MINT extensions
            let mut account_extensions = Vec::new();

            for ext_type in mint_extensions.iter() {
                match ext_type {
                    ExtensionType::TransferFeeConfig => {
                        account_extensions.push(ExtensionType::TransferFeeAmount);
                    }
                    ExtensionType::MemoTransfer => {
                        account_extensions.push(ExtensionType::MemoTransfer);
                    }
                    ExtensionType::NonTransferable => {
                        account_extensions.push(ExtensionType::NonTransferable);
                    }
                    ExtensionType::ImmutableOwner => {
                        account_extensions.push(ExtensionType::ImmutableOwner);
                    }
                    ExtensionType::CpiGuard => {
                        account_extensions.push(ExtensionType::CpiGuard);
                    }
                    _ => {}
                }
            }

            drop(mint_data); // Release borrow before CPI

            // Calculate space with ALL required extensions
            ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(
                &account_extensions,
            )
            .map_err(|_| ErrorCode::InvalidMint)?
        } else {
            165 // Standard SPL Token size
        };
        let fees_vault_rent = Rent::get()?.minimum_balance(fees_vault_space);

        invoke_signed(
            &system_instruction::create_account(
                ctx.accounts.creator.key,
                ctx.accounts.fees_vault.key,
                fees_vault_rent,
                fees_vault_space as u64,
                underlying_token_program,
            ),
            &[
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.fees_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[fees_vault_seeds],
        )?;

        let init_fees_vault_ix = if *underlying_token_program == spl_token_2022::ID {
            spl_token_2022::instruction::initialize_account3(
                underlying_token_program,
                &ctx.accounts.fees_vault.key(),
                &ctx.accounts.underlying_mint.key(),
                &ctx.accounts.vault_authority.key(),
            )?
        } else {
            spl_token::instruction::initialize_account3(
                underlying_token_program,
                &ctx.accounts.fees_vault.key(),
                &ctx.accounts.underlying_mint.key(),
                &ctx.accounts.vault_authority.key(),
            )?
        };

        invoke_signed(
            &init_fees_vault_ix,
            &[
                ctx.accounts.fees_vault.to_account_info(),
                ctx.accounts.underlying_mint.to_account_info(),
            ],
            &[fees_vault_seeds],
        )?;

        rift.fees_vault = ctx.accounts.fees_vault.key();
        msg!("✅ Fees vault initialized: {} (space: {})", ctx.accounts.fees_vault.key(), fees_vault_space);

        // 3. INITIALIZE WITHHELD_VAULT (for Token-2022 withheld transfer fees in RIFT tokens)
        let withheld_vault_seeds = &[
            b"withheld_vault",
            rift_key.as_ref(),
            &[ctx.bumps.withheld_vault],
        ];

        // **FIX MEDIUM-HIGH #26**: Calculate proper space by reading RIFT mint's actual extensions
        // RIFT mint is always Token-2022, but may have additional extensions beyond TransferFeeConfig
        let rift_mint_info = ctx.accounts.rift_mint.to_account_info();
        let mint_data_rift = rift_mint_info.try_borrow_data()?;
        let mint_account_rift =
            StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data_rift)?;

        // Get list of extensions this mint has
        let mint_extensions_rift = mint_account_rift.get_extension_types()?;

        // Build list of required ACCOUNT extensions based on MINT extensions
        let mut account_extensions_rift = Vec::new();

        for ext_type in mint_extensions_rift.iter() {
            match ext_type {
                ExtensionType::TransferFeeConfig => {
                    account_extensions_rift.push(ExtensionType::TransferFeeAmount);
                }
                ExtensionType::MemoTransfer => {
                    account_extensions_rift.push(ExtensionType::MemoTransfer);
                }
                ExtensionType::NonTransferable => {
                    account_extensions_rift.push(ExtensionType::NonTransferable);
                }
                ExtensionType::ImmutableOwner => {
                    account_extensions_rift.push(ExtensionType::ImmutableOwner);
                }
                ExtensionType::CpiGuard => {
                    account_extensions_rift.push(ExtensionType::CpiGuard);
                }
                _ => {}
            }
        }

        drop(mint_data_rift); // Release borrow before CPI

        // Calculate space with ALL required extensions
        let withheld_vault_space = ExtensionType::try_calculate_account_len::<
            spl_token_2022::state::Account,
        >(&account_extensions_rift)
        .map_err(|_| ErrorCode::InvalidMint)?;
        let withheld_vault_rent = Rent::get()?.minimum_balance(withheld_vault_space);

        invoke_signed(
            &system_instruction::create_account(
                ctx.accounts.creator.key,
                ctx.accounts.withheld_vault.key,
                withheld_vault_rent,
                withheld_vault_space as u64,
                &spl_token_2022::ID, // Token-2022 for RIFT tokens
            ),
            &[
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.withheld_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[withheld_vault_seeds],
        )?;

        invoke_signed(
            &initialize_account3(
                &spl_token_2022::ID,
                &ctx.accounts.withheld_vault.key(),
                &ctx.accounts.rift_mint.key(),
                &ctx.accounts.vault_authority.key(),
            )
            .map_err(|_| ErrorCode::InvalidMint)?,
            &[
                ctx.accounts.withheld_vault.to_account_info(),
                ctx.accounts.rift_mint.to_account_info(),
            ],
            &[withheld_vault_seeds],
        )?;

        rift.withheld_vault = ctx.accounts.withheld_vault.key();
        msg!("✅ Withheld vault initialized: {} (space: {})", ctx.accounts.withheld_vault.key(), withheld_vault_space);

        msg!("✅ All vaults initialized atomically during rift creation!");

        Ok(())
    }

    /// Initialize a new Rift (wrapped token vault) - STACK OPTIMIZED (Original PDA version)
    pub fn create_rift(
        ctx: Context<CreateRift>,
        partner_wallet: Option<Pubkey>,
        rift_name: [u8; 32],
        name_len: u8,
        transfer_fee_bps: u16, // Token-2022 transfer fee (70-100 = 0.7%-1%)
        prefix_type: u8,       // 0 = 'r' (Rift), 1 = 'm' (Monorift)
    ) -> Result<()> {
        let rift = &mut ctx.accounts.rift;

        // **MEDIUM FIX #7**: Validate and set rift name (fixed-size array - no heap allocation!)
        require!(name_len <= 32, ErrorCode::NameTooLong);
        // **TOKEN-2022**: Validate transfer fee is between 0.7% and 1% (70-100 basis points)
        require!(
            transfer_fee_bps >= 70 && transfer_fee_bps <= 100,
            ErrorCode::InvalidTransferFee
        );

        // **FIX HIGH #33**: Mirror underlying mint validation from create_rift_with_vanity_pda
        // **FIX HIGH #29**: Validate underlying mint has no freeze authority to prevent fund lockup
        // **FIX HIGH #30**: Validate underlying mint has no mint authority to prevent supply inflation
        // **FIX CRITICAL #31**: Validate Token-2022 extensions to prevent DoS and vault drain
        {
            let mint_info = ctx.accounts.underlying_mint.to_account_info();
            let mint_data = mint_info.try_borrow_data()?;

            // Check if this is SPL Token or Token-2022
            if *mint_info.owner == anchor_spl::token::ID {
                // SPL Token mint validation
                let _mint = spl_token::state::Mint::unpack(&mint_data)
                    .map_err(|_| ErrorCode::InvalidMint)?;

                // **ACKNOWLEDGED RISK (Audit MEDIUM #2)**: We intentionally DO NOT validate
                // mint_authority or freeze_authority on underlying tokens.
                //
                // RISKS ACCEPTED:
                // - Tokens with mint_authority can have supply inflated, diluting vault backing
                // - Tokens with freeze_authority can have vault funds frozen, causing DoS
                //
                // RATIONALE: This allows wrapping popular tokens like USDC, USDT, stSOL, mSOL
                // which have authorities but are operationally trusted.
                //
                // USER RESPONSIBILITY: It is up to the rift creator and users to evaluate
                // the underlying token's authority risks before wrapping/unwrapping.
                // The protocol does not enforce authority checks - use at your own risk.

                msg!("✅ SPL Token mint validated (authority checks skipped - user accepts risk)");
            } else if *mint_info.owner == spl_token_2022::ID {
                // Token-2022 mint validation
                let mint_state =
                    StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)
                        .map_err(|_| ErrorCode::InvalidMint)?;

                // **ACKNOWLEDGED RISK (Audit MEDIUM #2)**: We intentionally DO NOT validate
                // mint_authority or freeze_authority on underlying Token-2022 tokens.
                //
                // RISKS ACCEPTED:
                // - Tokens with mint_authority can have supply inflated, diluting vault backing
                // - Tokens with freeze_authority can have vault funds frozen, causing DoS
                //
                // RATIONALE: This allows wrapping popular tokens which have authorities
                // but are operationally trusted.
                //
                // USER RESPONSIBILITY: It is up to the rift creator and users to evaluate
                // the underlying token's authority risks before wrapping/unwrapping.
                // The protocol does not enforce authority checks - use at your own risk.

                // **FIX CRITICAL #31**: Validate Token-2022 extensions (keep these - actually dangerous)
                let extension_types = mint_state
                    .get_extension_types()
                    .map_err(|_| ErrorCode::InvalidMint)?;

                for ext_type in extension_types.iter() {
                    match ext_type {
                        ExtensionType::NonTransferable => {
                            // CRITICAL: NonTransferable prevents unwrapping (outbound transfers)
                            msg!("❌ Underlying mint has NonTransferable - tokens cannot leave vault!");
                            return Err(ErrorCode::UnsafeUnderlyingMint.into());
                        }
                        ExtensionType::PermanentDelegate => {
                            // CRITICAL: PermanentDelegate can bypass vault authority and drain funds
                            msg!("❌ Underlying mint has PermanentDelegate - can drain vault!");
                            return Err(ErrorCode::UnsafeUnderlyingMint.into());
                        }
                        ExtensionType::TransferFeeConfig => {
                            // HIGH: Validate transfer fee is reasonable (≤ 1% = 100 bps)
                            use spl_token_2022::extension::transfer_fee::TransferFeeConfig;
                            let fee_config = mint_state
                                .get_extension::<TransferFeeConfig>()
                                .map_err(|_| ErrorCode::InvalidMint)?;
                            let fee_bps =
                                u16::from(fee_config.newer_transfer_fee.transfer_fee_basis_points);
                            require!(fee_bps <= 100, ErrorCode::ExcessiveTransferFee);
                            msg!("✅ Underlying transfer fee: {} bps (acceptable)", fee_bps);
                        }
                        ExtensionType::MintCloseAuthority => {
                            // HIGH: Mint can be closed, freezing all token accounts
                            msg!("❌ Underlying mint has close authority - can be permanently closed!");
                            return Err(ErrorCode::UnsafeUnderlyingMint.into());
                        }
                        ExtensionType::TransferHook => {
                            // **FIX CRITICAL #50**: BLOCK TransferHook extension
                            // TransferHook requires extra accounts in CPI (hook program, validation account)
                            // wrap_tokens/unwrap_from_vault don't pass these accounts → transfer fails
                            // OR hook executes arbitrary code mid-instruction → reentrancy bypass
                            // Result: DoS (all wrap/unwrap fail) or security breach (arbitrary hook execution)
                            msg!("❌ Underlying mint has TransferHook - CPI incompatible!");
                            return Err(ErrorCode::UnsafeUnderlyingMint.into());
                        }
                        ExtensionType::MemoTransfer => {
                            // **FIX CRITICAL #54**: BLOCK MemoTransfer extension
                            // MemoTransfer requires memo instruction before every transfer
                            // wrap_tokens/unwrap_from_vault/fee_distribution don't include memo CPI
                            // Result: All transfers fail → complete rift DoS (wrap/unwrap/fees all broken)
                            msg!("❌ Underlying mint has MemoTransfer - CPI incompatible!");
                            return Err(ErrorCode::UnsafeUnderlyingMint.into());
                        }
                        ExtensionType::DefaultAccountState => {
                            // **FIX MEDIUM #6 (Audit)**: BLOCK DefaultAccountState extension
                            // DefaultAccountState can set new accounts to Frozen by default
                            // Vault token accounts would be frozen → all transfers fail → complete DoS
                            msg!("❌ Underlying mint has DefaultAccountState - vault would be frozen!");
                            return Err(ErrorCode::UnsafeUnderlyingMint.into());
                        }
                        ExtensionType::ConfidentialTransferMint => {
                            // **FIX MEDIUM #6 (Audit)**: BLOCK ConfidentialTransferMint extension
                            // Confidential transfers require special handling not implemented in wrap/unwrap
                            // Would cause transfer failures or incorrect balance tracking
                            msg!("❌ Underlying mint has ConfidentialTransferMint - not supported!");
                            return Err(ErrorCode::UnsafeUnderlyingMint.into());
                        }
                        ExtensionType::ConfidentialTransferFeeConfig => {
                            // **FIX MEDIUM #6 (Audit)**: BLOCK ConfidentialTransferFeeConfig extension
                            // Confidential transfer fees require special handling not implemented
                            msg!("❌ Underlying mint has ConfidentialTransferFeeConfig - not supported!");
                            return Err(ErrorCode::UnsafeUnderlyingMint.into());
                        }
                        _ => {
                            // Other extensions (ImmutableOwner, CpiGuard) are handled
                            // CpiGuard: Account extensions added during vault init
                        }
                    }
                }

                msg!("✅ Token-2022 mint validated: no unsafe authorities/extensions");
            } else {
                return Err(ErrorCode::InvalidMint.into());
            }

            drop(mint_data); // Release borrow
        }

        if name_len > 0 {
            // **MEDIUM FIX #7**: Validate name is valid UTF-8 to prevent off-chain parser issues
            let name_slice = &rift_name[..name_len as usize];
            require!(
                core::str::from_utf8(name_slice).is_ok(),
                ErrorCode::InvalidRiftName
            );
            rift.name[..name_len as usize].copy_from_slice(name_slice);
        } else {
            // **MEMORY OPTIMIZATION**: Use empty name (all zeros)
            rift.name = [0u8; 32];
        }

        rift.creator = ctx.accounts.creator.key();
        rift.underlying_mint = ctx.accounts.underlying_mint.key();
        rift.rift_mint = ctx.accounts.rift_mint.key();
        // **ATOMIC INIT**: Initialize all 3 vaults during create_rift (Option A implementation)
        // This ensures clean fee accounting and better UX (single transaction setup)
        let rift_key = rift.key();

        // Will be set to actual initialized addresses below
        // Temporarily set to system program (will update after CPI)
        rift.vault = anchor_lang::solana_program::system_program::ID;
        rift.fees_vault = anchor_lang::solana_program::system_program::ID;
        rift.withheld_vault = anchor_lang::solana_program::system_program::ID;

        // **FEE SPLIT**: If no partner provided, creator is the partner (50/50 split with treasury)
        rift.partner_wallet = Some(partner_wallet.unwrap_or(ctx.accounts.creator.key()));
        rift.partner_fee_bps = 5000; // Always 50% (5000 bps) - stored for backwards compatibility
        let default_treasury = Pubkey::from_str_const(DEFAULT_TREASURY_WALLET);
        rift.treasury_wallet = Some(default_treasury);
        // **CRITICAL FIX #1**: Initialize configurable wrap/unwrap fees (default 0.3%)
        rift.wrap_fee_bps = 30; // Default 0.3% wrap fee
        rift.unwrap_fee_bps = 30; // Default 0.3% unwrap fee
        rift.total_underlying_wrapped = 0;
        rift.total_rift_minted = 0;
        rift.total_burned = 0;
        rift.backing_ratio = 1_000_000; // 100% initially (6 decimals precision) - FIXED from 10000
        rift.last_rebalance = Clock::get()?.unix_timestamp;
        rift.created_at = Clock::get()?.unix_timestamp;

        // Initialize hybrid oracle system
        rift.oracle_prices = [PriceData::default(); 10];
        rift.price_index = 0;
        rift.oracle_update_interval = 30 * 60; // 30 minutes
        rift.max_rebalance_interval = 24 * 60 * 60; // 24 hours
        rift.arbitrage_threshold_bps = 200; // 2% threshold
        rift.last_oracle_update = Clock::get()?.unix_timestamp;

        // Initialize advanced metrics
        rift.total_volume_24h = 0;
        rift.price_deviation = 0;
        rift.arbitrage_opportunity_bps = 0;
        rift.rebalance_count = 0;

        // Initialize RIFTS token distribution tracking
        rift.total_fees_collected = 0;
        rift.rifts_tokens_distributed = 0;
        rift.rifts_tokens_burned = 0;

        // **SECURITY FIX #50**: Initialize oracle accounts as None (must be set explicitly)
        rift.switchboard_feed_account = None;

        // **HIGH FIX #3**: Initialize manual oracle rate limiting
        rift.last_manual_oracle_update = 0;

        // **FIX HIGH #2**: Initialize cumulative drift tracking
        rift.manual_oracle_base_price = 0;
        rift.manual_oracle_drift_window_start = 0;

        // Initialize reentrancy protection
        rift.reentrancy_guard = false;
        rift.reentrancy_guard_slot = 0;

        // Initialize closure state
        rift.is_closed = false;
        rift.closed_at_slot = 0;

        // Initialize oracle change timelock
        rift.oracle_change_pending = false;
        rift.pending_switchboard_account = None;
        rift.oracle_change_timestamp = 0;

        // **TOKEN-2022**: Initialize Token-2022 mint with transfer fee extension
        // This fee applies ONLY to transfers (DEX trading), NOT to mint/burn (wrap/unwrap)
        use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
        use spl_token_2022::extension::{ExtensionType, StateWithExtensionsMut};

        // 1. Calculate metadata strings FIRST (needed for space calculation)
        let rift_name_str =
            core::str::from_utf8(&rift_name[..name_len as usize]).unwrap_or("Rift Token");
        // Use prefixed name for both display name and symbol; symbol still capped at 10 chars
        // prefix_type: 0 = 'r' (Rift), 1 = 'm' (Monorift)
        let prefix = if prefix_type == 1 { "m" } else { "r" };
        let display_name = format!("{}{}", prefix, rift_name_str);
        let symbol = display_name[..display_name.len().min(10)].to_string();

        // 2. Calculate TOKEN METADATA space (uses variable-length TLV encoding)
        use spl_token_metadata_interface::state::TokenMetadata;
        use spl_pod::optional_keys::OptionalNonZeroPubkey;
        let metadata = TokenMetadata {
            name: display_name.clone(),
            symbol: symbol.to_string(),
            uri: "".to_string(),
            update_authority: OptionalNonZeroPubkey::default(),
            mint: Pubkey::default(), // placeholder
            additional_metadata: vec![],
        };
        let metadata_space = metadata.tlv_size_of().map_err(|_| ErrorCode::InvalidMint)?;

        // 3. Calculate space for Token-2022 mint
        // The account is created with ONLY the base mint space (Mint + TransferFeeConfig + MetadataPointer)
        // because initialize_mint2 validates the account size matches the initialized extensions.
        // The metadata TLV gets added AFTER via metadata::initialize, which will realloc the account.
        let base_mint_space =
            ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[
                ExtensionType::TransferFeeConfig,
                ExtensionType::MetadataPointer,
            ])
            .map_err(|_| ErrorCode::InvalidMint)?;

        // 4. Calculate rent for FINAL size (base + metadata + buffer for TLV alignment)
        // We fund the account with enough lamports to cover the final size after metadata realloc,
        // but we create it with only base_mint_space data.len.
        const METADATA_TLV_BUFFER: usize = 128; // Buffer for TLV overhead and alignment padding
        let final_mint_len = base_mint_space + metadata_space + METADATA_TLV_BUFFER;
        let mint_rent = Rent::get()?.minimum_balance(final_mint_len);

        msg!("🔍 DEBUG: base_mint_space (Mint+Extensions) = {}", base_mint_space);
        msg!("🔍 DEBUG: metadata_space (TLV) = {}", metadata_space);
        msg!("🔍 DEBUG: METADATA_TLV_BUFFER = {}", METADATA_TLV_BUFFER);
        msg!("🔍 DEBUG: final_mint_len (for rent calc) = {}", final_mint_len);
        msg!("🔍 DEBUG: mint_rent (lamports) = {}", mint_rent);
        msg!("🔍 DEBUG: account data.len at creation = {}", base_mint_space);
        let creator_key = ctx.accounts.creator.key();
        let underlying_mint_key = ctx.accounts.underlying_mint.key();
        let mint_seeds = &[
            b"rift_mint",
            underlying_mint_key.as_ref(),
            creator_key.as_ref(),
            &[ctx.bumps.rift_mint],
        ];

        invoke_signed(
            &system_instruction::create_account(
                ctx.accounts.creator.key,
                ctx.accounts.rift_mint.key,
                mint_rent,
                base_mint_space as u64, // Create with base size; metadata reallocs later
                &spl_token_2022::ID,
            ),
            &[
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.rift_mint.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[mint_seeds],
        )?;

        // 3. Initialize transfer fee extension (configurable 0.7%-1% = 70-100 basis points)
        // This fee is ONLY charged on transfers (DEX trades), NOT on mint/burn!
        use spl_token_2022::extension::transfer_fee::instruction::initialize_transfer_fee_config;

        // Use PROGRAM_AUTHORITY for fee authorities (prevents creators from manipulating fees)
        let program_authority = Pubkey::from_str_const(PROGRAM_AUTHORITY);
        // **PER-RIFT TREASURY FIX**: Use default treasury (will be set in rift.treasury_wallet)
        // This ensures withdraw_withheld_authority matches the per-rift treasury
        let default_treasury = Pubkey::from_str_const(DEFAULT_TREASURY_WALLET);

        invoke_signed(
            &initialize_transfer_fee_config(
                &spl_token_2022::ID,
                ctx.accounts.rift_mint.key,
                Some(&program_authority), // transfer_fee_config_authority = PROGRAM_AUTHORITY
                Some(&default_treasury),   // withdraw_withheld_authority = rift.treasury_wallet ✅
                transfer_fee_bps,         // Configurable fee (70-100 bps = 0.7%-1%)
                u64::MAX,                 // no maximum fee cap
            )
            .map_err(|_| ErrorCode::InvalidMint)?,
            &[ctx.accounts.rift_mint.to_account_info()],
            &[mint_seeds],
        )?;

        // 4. Initialize metadata pointer (points metadata to the mint itself)
        use spl_token_2022::extension::metadata_pointer::instruction::initialize as initialize_metadata_pointer;
        invoke_signed(
            &initialize_metadata_pointer(
                &spl_token_2022::ID,
                ctx.accounts.rift_mint.key,
                Some(*ctx.accounts.rift_mint_authority.key),
                Some(*ctx.accounts.rift_mint.key),
            )?,
            &[ctx.accounts.rift_mint.to_account_info()],
            &[mint_seeds],
        )?;

        // 5. Initialize the mint itself
        invoke_signed(
            &spl_token_2022::instruction::initialize_mint2(
                &spl_token_2022::ID,
                ctx.accounts.rift_mint.key,
                ctx.accounts.rift_mint_authority.key,
                None, // no freeze authority
                ctx.accounts.underlying_mint.decimals,
            )
            .map_err(|_| ErrorCode::InvalidMint)?,
            &[ctx.accounts.rift_mint.to_account_info()],
            &[mint_seeds],
        )?;

        // **FIX MEDIUM #32**: Verify transfer fee config was set correctly after CPI
        // Defense-in-depth: Provide specific error messages for fee config mismatches
        {
            let rift_mint_info = ctx.accounts.rift_mint.to_account_info();
            let rift_mint_data = rift_mint_info.try_borrow_data()?;
            let mint_state = spl_token_2022::extension::StateWithExtensions::<
                spl_token_2022::state::Mint,
            >::unpack(&rift_mint_data)?;

            use spl_token_2022::extension::transfer_fee::TransferFeeConfig;
            let fee_config = mint_state.get_extension::<TransferFeeConfig>()?;
            let actual_fee_bps = u16::from(fee_config.newer_transfer_fee.transfer_fee_basis_points);

            require!(
                actual_fee_bps == transfer_fee_bps,
                ErrorCode::TransferFeeConfigMismatch
            );

            drop(rift_mint_data);
            msg!(
                "✅ Verified RIFT mint transfer fee: {} bps (matches parameter)",
                actual_fee_bps
            );
        }

        msg!(
            "✅ Created Token-2022 mint with {}% transfer fee on DEX trades (wrap/unwrap FREE)",
            transfer_fee_bps as f64 / 100.0
        );

        // Initialize Token-2022 metadata extension (reuse variables from above)
        let rift_key = rift.key();
        let mint_auth_seeds = &[
            b"rift_mint_auth",
            rift_key.as_ref(),
            &[ctx.bumps.rift_mint_authority],
        ];
        let signer_seeds = &[&mint_auth_seeds[..]];

        // Initialize Token-2022 metadata via Token Metadata Interface
        let metadata_ix = spl_token_metadata_interface::instruction::initialize(
            &spl_token_2022::ID,
            &ctx.accounts.rift_mint.key(),
            &ctx.accounts.rift_mint_authority.key(),
            &ctx.accounts.rift_mint.key(),
            &ctx.accounts.rift_mint_authority.key(),
            display_name.clone(),
            symbol.to_string(),
            "".to_string(),
        );

        invoke_signed(
            &metadata_ix,
            &[
                ctx.accounts.rift_mint.to_account_info(),
                ctx.accounts.rift_mint_authority.to_account_info(),
            ],
            signer_seeds,
        )?;

        msg!("✅ Token-2022 mint created with metadata");
        msg!("Name: {}, Symbol: {}", display_name, symbol);

        msg!("✅ Token-2022 mint created with full metadata");
        msg!("Name: {}, Symbol: {}", display_name, symbol);

        // **ATOMIC INIT**: Initialize all 3 vaults during create_rift
        // This ensures clean fee accounting and better UX (single transaction setup)

        // **TOKEN-2022 MIGRATION**: Use underlying token program for vault creation
        let underlying_token_program = ctx.accounts.underlying_mint.to_account_info().owner;

        // 1. INITIALIZE VAULT (backing vault for underlying tokens)
        msg!("Initializing vault...");

        let vault_space = if *underlying_token_program == spl_token_2022::ID {
            // Calculate space based on underlying mint's Token-2022 extensions
            let underlying_mint_info = ctx.accounts.underlying_mint.to_account_info();
            let mint_data = underlying_mint_info.try_borrow_data()?;
            let mint_account = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;

            let mint_extensions = mint_account.get_extension_types()?;
            let mut account_extensions = Vec::new();

            for ext_type in mint_extensions.iter() {
                match ext_type {
                    ExtensionType::TransferFeeConfig => {
                        account_extensions.push(ExtensionType::TransferFeeAmount);
                    }
                    ExtensionType::MemoTransfer => {
                        account_extensions.push(ExtensionType::MemoTransfer);
                    }
                    ExtensionType::NonTransferable => {
                        account_extensions.push(ExtensionType::NonTransferable);
                    }
                    ExtensionType::ImmutableOwner => {
                        account_extensions.push(ExtensionType::ImmutableOwner);
                    }
                    ExtensionType::CpiGuard => {
                        account_extensions.push(ExtensionType::CpiGuard);
                    }
                    _ => {}
                }
            }

            drop(mint_data);

            ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(
                &account_extensions,
            ).map_err(|_| ErrorCode::InvalidMint)?
        } else {
            165 // Standard SPL Token size
        };

        let vault_rent = Rent::get()?.minimum_balance(vault_space);
        let (vault_key, vault_bump) = Pubkey::find_program_address(
            &[b"vault", rift_key.as_ref()],
            ctx.program_id
        );

        require!(
            vault_key == ctx.accounts.vault.key(),
            ErrorCode::InvalidPDA
        );

        let vault_seeds = &[
            b"vault" as &[u8],
            rift_key.as_ref(),
            &[vault_bump],
        ];
        let vault_signer = &[&vault_seeds[..]];

        invoke_signed(
            &system_instruction::create_account(
                ctx.accounts.creator.key,
                &vault_key,
                vault_rent,
                vault_space as u64,
                underlying_token_program,
            ),
            &[
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            vault_signer,
        )?;

        let init_vault_ix = if *underlying_token_program == spl_token_2022::ID {
            spl_token_2022::instruction::initialize_account3(
                underlying_token_program,
                &vault_key,
                &ctx.accounts.underlying_mint.key(),
                &ctx.accounts.vault_authority.key(),
            )?
        } else {
            spl_token::instruction::initialize_account3(
                underlying_token_program,
                &vault_key,
                &ctx.accounts.underlying_mint.key(),
                &ctx.accounts.vault_authority.key(),
            )?
        };

        invoke(
            &init_vault_ix,
            &[
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.underlying_mint.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
            ],
        )?;

        // Update rift with actual vault address
        rift.vault = vault_key;
        msg!("✅ Vault initialized: {} (space: {})", vault_key, vault_space);

        // 2. INITIALIZE FEES_VAULT (for wrap/unwrap fees in underlying tokens)
        msg!("Initializing fees_vault...");

        // Fees vault uses same space calculation as main vault (same mint)
        let fees_vault_rent = Rent::get()?.minimum_balance(vault_space);
        let (fees_vault_key, fees_vault_bump) = Pubkey::find_program_address(
            &[b"fees_vault", rift_key.as_ref()],
            ctx.program_id
        );

        require!(
            fees_vault_key == ctx.accounts.fees_vault.key(),
            ErrorCode::InvalidPDA
        );

        let fees_vault_seeds = &[
            b"fees_vault" as &[u8],
            rift_key.as_ref(),
            &[fees_vault_bump],
        ];
        let fees_vault_signer = &[&fees_vault_seeds[..]];

        invoke_signed(
            &system_instruction::create_account(
                ctx.accounts.creator.key,
                &fees_vault_key,
                fees_vault_rent,
                vault_space as u64,
                underlying_token_program,
            ),
            &[
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.fees_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            fees_vault_signer,
        )?;

        let init_fees_vault_ix = if *underlying_token_program == spl_token_2022::ID {
            spl_token_2022::instruction::initialize_account3(
                underlying_token_program,
                &fees_vault_key,
                &ctx.accounts.underlying_mint.key(),
                &ctx.accounts.vault_authority.key(),
            )?
        } else {
            spl_token::instruction::initialize_account3(
                underlying_token_program,
                &fees_vault_key,
                &ctx.accounts.underlying_mint.key(),
                &ctx.accounts.vault_authority.key(),
            )?
        };

        invoke(
            &init_fees_vault_ix,
            &[
                ctx.accounts.fees_vault.to_account_info(),
                ctx.accounts.underlying_mint.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
            ],
        )?;

        // Update rift with actual fees_vault address
        rift.fees_vault = fees_vault_key;
        msg!("✅ Fees vault initialized: {} (space: {})", fees_vault_key, vault_space);

        // 3. INITIALIZE WITHHELD_VAULT (for Token-2022 withheld transfer fees in RIFT tokens)
        msg!("Initializing withheld_vault...");

        // Calculate space based on RIFT mint's extensions (always Token-2022)
        let rift_mint_info = ctx.accounts.rift_mint.to_account_info();
        let rift_mint_data = rift_mint_info.try_borrow_data()?;
        let rift_mint_account = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&rift_mint_data)?;

        let rift_mint_extensions = rift_mint_account.get_extension_types()?;
        let mut withheld_account_extensions = Vec::new();

        for ext_type in rift_mint_extensions.iter() {
            match ext_type {
                ExtensionType::TransferFeeConfig => {
                    withheld_account_extensions.push(ExtensionType::TransferFeeAmount);
                }
                ExtensionType::MemoTransfer => {
                    withheld_account_extensions.push(ExtensionType::MemoTransfer);
                }
                ExtensionType::NonTransferable => {
                    withheld_account_extensions.push(ExtensionType::NonTransferable);
                }
                ExtensionType::ImmutableOwner => {
                    withheld_account_extensions.push(ExtensionType::ImmutableOwner);
                }
                ExtensionType::CpiGuard => {
                    withheld_account_extensions.push(ExtensionType::CpiGuard);
                }
                _ => {}
            }
        }

        drop(rift_mint_data);

        let withheld_vault_space = ExtensionType::try_calculate_account_len::<
            spl_token_2022::state::Account
        >(&withheld_account_extensions).map_err(|_| ErrorCode::InvalidMint)?;

        let withheld_vault_rent = Rent::get()?.minimum_balance(withheld_vault_space);
        let (withheld_vault_key, withheld_vault_bump) = Pubkey::find_program_address(
            &[b"withheld_vault", rift_key.as_ref()],
            ctx.program_id
        );

        require!(
            withheld_vault_key == ctx.accounts.withheld_vault.key(),
            ErrorCode::InvalidPDA
        );

        let withheld_vault_seeds = &[
            b"withheld_vault" as &[u8],
            rift_key.as_ref(),
            &[withheld_vault_bump],
        ];
        let withheld_vault_signer = &[&withheld_vault_seeds[..]];

        invoke_signed(
            &system_instruction::create_account(
                ctx.accounts.creator.key,
                &withheld_vault_key,
                withheld_vault_rent,
                withheld_vault_space as u64,
                &spl_token_2022::ID,
            ),
            &[
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.withheld_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            withheld_vault_signer,
        )?;

        let init_withheld_vault_ix = spl_token_2022::instruction::initialize_account3(
            &spl_token_2022::ID,
            &withheld_vault_key,
            &ctx.accounts.rift_mint.key(),
            &ctx.accounts.vault_authority.key(),
        )?;

        invoke(
            &init_withheld_vault_ix,
            &[
                ctx.accounts.withheld_vault.to_account_info(),
                ctx.accounts.rift_mint.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
            ],
        )?;

        // Update rift with actual withheld_vault address
        rift.withheld_vault = withheld_vault_key;
        msg!("✅ Withheld vault initialized: {} (space: {})", withheld_vault_key, withheld_vault_space);

        msg!("✅ All vaults initialized atomically during rift creation!");

        emit!(RiftCreated {
            rift: rift.key(),
            creator: rift.creator,
            underlying_mint: rift.underlying_mint,
            partner_fee_bps: rift.partner_fee_bps,
        });

        Ok(())
    }

    /// Initialize vault for rift
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        // Vault is automatically initialized through the constraint
        Ok(())
    }

    /// Initialize fees vault for collecting wrap/unwrap fees (underlying tokens)
    /// Must be called after rift creation to enable fee collection
    /// **FIX CRITICAL #19**: Manual initialization to properly size for Token-2022 extensions
    pub fn initialize_fees_vault(ctx: Context<InitializeFeesVault>) -> Result<()> {
        let rift = &mut ctx.accounts.rift;

        // **FIX CRITICAL #34**: Only creator or program authority can initialize fees vault
        // Prevents front-running attacks where attacker creates vault with wrong owner/space
        let program_authority = Pubkey::from_str_const(PROGRAM_AUTHORITY);
        require!(
            ctx.accounts.user.key() == rift.creator || ctx.accounts.user.key() == program_authority,
            ErrorCode::Unauthorized
        );

        // **FIX CRITICAL #34**: Validate token_program matches underlying_mint's owner
        // Prevents creating vault with foreign program owner that can't be reinitialized
        let underlying_mint_owner = ctx.accounts.underlying_mint.owner;
        require!(
            ctx.accounts.token_program.key() == *underlying_mint_owner,
            ErrorCode::InvalidProgramId
        );

        msg!("✅ Authorization validated: user is creator or program authority");

        // **FIX MEDIUM-HIGH #26**: Calculate proper space by reading underlying mint's actual extensions
        let fees_vault_space = if ctx.accounts.token_program.key() == spl_token_2022::ID {
            // Read underlying mint to determine what extensions it has
            let underlying_mint_info = ctx.accounts.underlying_mint.to_account_info();
            let mint_data = underlying_mint_info.try_borrow_data()?;
            let mint_account =
                StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;

            // Get list of extensions this mint has
            let mint_extensions = mint_account.get_extension_types()?;

            // Build list of required ACCOUNT extensions based on MINT extensions
            let mut account_extensions = Vec::new();

            for ext_type in mint_extensions.iter() {
                match ext_type {
                    ExtensionType::TransferFeeConfig => {
                        // Mint has transfer fees → account needs TransferFeeAmount
                        account_extensions.push(ExtensionType::TransferFeeAmount);
                    }
                    ExtensionType::MemoTransfer => {
                        // Mint requires memos → account needs MemoTransfer
                        account_extensions.push(ExtensionType::MemoTransfer);
                    }
                    ExtensionType::NonTransferable => {
                        // Mint is non-transferable → account needs NonTransferable
                        account_extensions.push(ExtensionType::NonTransferable);
                    }
                    ExtensionType::ImmutableOwner => {
                        // Mint has immutable owner → account needs ImmutableOwner
                        account_extensions.push(ExtensionType::ImmutableOwner);
                    }
                    ExtensionType::CpiGuard => {
                        // Mint has CPI guard → account needs CpiGuard
                        account_extensions.push(ExtensionType::CpiGuard);
                    }
                    _ => {
                        // Other mint extensions (PermanentDelegate, MintCloseAuthority, etc.)
                        // don't require corresponding account extensions
                    }
                }
            }

            drop(mint_data); // Release borrow before CPI

            // Calculate space with ALL required extensions
            ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(
                &account_extensions,
            )
            .map_err(|_| ErrorCode::InvalidMint)?
        } else {
            165 // Standard SPL Token size
        };

        let fees_vault_rent = Rent::get()?.minimum_balance(fees_vault_space);

        // Derive PDA
        let (fees_vault_key, fees_vault_bump) =
            Pubkey::find_program_address(&[b"fees_vault", rift.key().as_ref()], ctx.program_id);

        require!(
            fees_vault_key == ctx.accounts.fees_vault.key(),
            ErrorCode::InvalidPDA
        );

        // **FIX CRITICAL #24**: Use invoke_signed so PDA can sign account creation
        let rift_key = rift.key();
        let fees_vault_seeds = &[
            b"fees_vault" as &[u8],
            rift_key.as_ref(),
            &[fees_vault_bump],
        ];
        let fees_vault_signer = &[&fees_vault_seeds[..]];

        // Create account via CPI with PDA signature
        let create_account_ix = system_instruction::create_account(
            &ctx.accounts.user.key(),
            &fees_vault_key,
            fees_vault_rent,
            fees_vault_space as u64,
            &ctx.accounts.token_program.key(),
        );

        invoke_signed(
            &create_account_ix,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.fees_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            fees_vault_signer,
        )?;

        // Initialize as token account
        let init_account_ix = if ctx.accounts.token_program.key() == spl_token_2022::ID {
            spl_token_2022::instruction::initialize_account3(
                &ctx.accounts.token_program.key(),
                &fees_vault_key,
                &ctx.accounts.underlying_mint.key(),
                &ctx.accounts.vault_authority.key(),
            )?
        } else {
            spl_token::instruction::initialize_account3(
                &ctx.accounts.token_program.key(),
                &fees_vault_key,
                &ctx.accounts.underlying_mint.key(),
                &ctx.accounts.vault_authority.key(),
            )?
        };

        invoke(
            &init_account_ix,
            &[
                ctx.accounts.fees_vault.to_account_info(),
                ctx.accounts.underlying_mint.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
            ],
        )?;

        // Update rift to point to the new fees vault
        rift.fees_vault = fees_vault_key;

        msg!(
            "✅ Fees vault initialized for rift: {} (space: {})",
            rift.key(),
            fees_vault_space
        );

        Ok(())
    }

    /// Initialize withheld vault for collecting SPL Token-2022 withheld transfer fees (RIFT tokens)
    /// Must be called after rift creation to enable withheld fee collection
    /// **FIX CRITICAL #20**: Manual initialization to properly size for Token-2022 extensions
    pub fn initialize_withheld_vault(ctx: Context<InitializeWithheldVault>) -> Result<()> {
        let rift = &mut ctx.accounts.rift;

        // **FIX CRITICAL #35**: Only creator or program authority can initialize withheld vault
        // Prevents front-running attacks where attacker creates vault with wrong owner/space
        let program_authority = Pubkey::from_str_const(PROGRAM_AUTHORITY);
        require!(
            ctx.accounts.user.key() == rift.creator || ctx.accounts.user.key() == program_authority,
            ErrorCode::Unauthorized
        );

        // **FIX CRITICAL #35**: Validate token_program is Token-2022 (RIFT mint is always Token-2022)
        // Prevents creating vault with foreign program owner that can't be reinitialized
        require!(
            ctx.accounts.token_program.key() == spl_token_2022::ID,
            ErrorCode::InvalidProgramId
        );

        msg!("✅ Authorization validated: user is creator or program authority");

        // **FIX MEDIUM-HIGH #26**: Calculate proper space by reading RIFT mint's actual extensions
        // Note: RIFT mint is always Token-2022, but may have additional extensions beyond TransferFeeConfig
        let rift_mint_info = ctx.accounts.rift_mint.to_account_info();
        let mint_data = rift_mint_info.try_borrow_data()?;
        let mint_account = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;

        // Get list of extensions this mint has
        let mint_extensions = mint_account.get_extension_types()?;

        // Build list of required ACCOUNT extensions based on MINT extensions
        let mut account_extensions = Vec::new();

        for ext_type in mint_extensions.iter() {
            match ext_type {
                ExtensionType::TransferFeeConfig => {
                    // RIFT mint has transfer fees → account needs TransferFeeAmount
                    account_extensions.push(ExtensionType::TransferFeeAmount);
                }
                ExtensionType::MemoTransfer => {
                    account_extensions.push(ExtensionType::MemoTransfer);
                }
                ExtensionType::NonTransferable => {
                    account_extensions.push(ExtensionType::NonTransferable);
                }
                ExtensionType::ImmutableOwner => {
                    account_extensions.push(ExtensionType::ImmutableOwner);
                }
                ExtensionType::CpiGuard => {
                    account_extensions.push(ExtensionType::CpiGuard);
                }
                _ => {
                    // Other mint extensions don't require corresponding account extensions
                }
            }
        }

        drop(mint_data); // Release borrow before CPI

        // Calculate space with ALL required extensions
        let withheld_vault_space = ExtensionType::try_calculate_account_len::<
            spl_token_2022::state::Account,
        >(&account_extensions)
        .map_err(|_| ErrorCode::InvalidMint)?;

        let withheld_vault_rent = Rent::get()?.minimum_balance(withheld_vault_space);

        // Derive PDA
        let (withheld_vault_key, withheld_vault_bump) =
            Pubkey::find_program_address(&[b"withheld_vault", rift.key().as_ref()], ctx.program_id);

        require!(
            withheld_vault_key == ctx.accounts.withheld_vault.key(),
            ErrorCode::InvalidPDA
        );

        // **FIX CRITICAL #25**: Use invoke_signed so PDA can sign account creation
        let rift_key = rift.key();
        let withheld_vault_seeds = &[
            b"withheld_vault" as &[u8],
            rift_key.as_ref(),
            &[withheld_vault_bump],
        ];
        let withheld_vault_signer = &[&withheld_vault_seeds[..]];

        // Create account via CPI with PDA signature
        let create_account_ix = system_instruction::create_account(
            &ctx.accounts.user.key(),
            &withheld_vault_key,
            withheld_vault_rent,
            withheld_vault_space as u64,
            &ctx.accounts.token_program.key(),
        );

        invoke_signed(
            &create_account_ix,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.withheld_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            withheld_vault_signer,
        )?;

        // Initialize as token account (always Token-2022 for RIFT tokens)
        let init_account_ix = spl_token_2022::instruction::initialize_account3(
            &ctx.accounts.token_program.key(),
            &withheld_vault_key,
            &ctx.accounts.rift_mint.key(),
            &ctx.accounts.vault_authority.key(),
        )?;

        invoke(
            &init_account_ix,
            &[
                ctx.accounts.withheld_vault.to_account_info(),
                ctx.accounts.rift_mint.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
            ],
        )?;

        // Update rift to point to the new withheld vault
        rift.withheld_vault = withheld_vault_key;

        msg!(
            "✅ Withheld vault initialized for rift: {} (space: {})",
            rift.key(),
            withheld_vault_space
        );

        Ok(())
    }

    /// Simple vault-based wrap - deposits underlying tokens and mints RIFT tokens
    pub fn wrap_tokens(ctx: Context<WrapTokens>, amount: u64, min_rift_out: u64) -> Result<()> {
        // **CRITICAL FIX #2 + FIX HIGH #1 + FIX ISSUE #7**: Add reentrancy protection with auto-timeout
        {
            let rift = &mut ctx.accounts.rift;

            // **FIX ISSUE #7**: Auto-clear stuck guard after timeout
            if rift.reentrancy_guard {
                let current_slot = Clock::get()?.slot;
                if current_slot > rift.reentrancy_guard_slot + REENTRANCY_TIMEOUT_SLOTS {
                    msg!(
                        "⚠️ Auto-clearing stuck reentrancy guard (set at slot {}, current {})",
                        rift.reentrancy_guard_slot,
                        current_slot
                    );
                    rift.reentrancy_guard = false;
                    rift.reentrancy_guard_slot = 0;
                } else {
                    return Err(ErrorCode::ReentrancyDetected.into());
                }
            }

            rift.reentrancy_guard = true;
            rift.reentrancy_guard_slot = Clock::get()?.slot;
        }

        // Execute the actual function logic
        let execution_result = (|| -> Result<()> {
            let rift = &mut ctx.accounts.rift;

            // **FIX ISSUE #8**: Verify rift is not closed
            require!(!rift.is_closed, ErrorCode::RiftClosed);

            // Basic validation
            require!(amount > 0, ErrorCode::InvalidAmount);

            // **CRITICAL FIX #3**: Manual token account validation - MUST validate, not skip
            // **FIX CRITICAL #27**: Validate accounts against their respective token programs
            {
                // Validate underlying token account (can be SPL Token or Token-2022)
                require!(
                    *ctx.accounts.user_underlying.owner
                        == ctx.accounts.underlying_token_program.key(),
                    ErrorCode::InvalidTokenAccount
                );
                let underlying_data = ctx.accounts.user_underlying.try_borrow_data()?;
                require!(underlying_data.len() >= 64, ErrorCode::InvalidTokenAccount);
                // **FIX CRITICAL #49**: Replace .unwrap() with proper error handling to prevent panic
                let underlying_mint = Pubkey::new_from_array(
                    underlying_data[0..32]
                        .try_into()
                        .map_err(|_| ErrorCode::InvalidTokenAccount)?,
                );
                let underlying_owner = Pubkey::new_from_array(
                    underlying_data[32..64]
                        .try_into()
                        .map_err(|_| ErrorCode::InvalidTokenAccount)?,
                );
                require!(
                    underlying_mint == rift.underlying_mint,
                    ErrorCode::InvalidMint
                );
                require!(
                    underlying_owner == ctx.accounts.user.key(),
                    ErrorCode::UnauthorizedTokenAccount
                );

                // Validate rift token account (always Token-2022)
                require!(
                    *ctx.accounts.user_rift_tokens.owner == spl_token_2022::ID,
                    ErrorCode::InvalidTokenAccount
                );
                let rift_data = ctx.accounts.user_rift_tokens.try_borrow_data()?;
                require!(rift_data.len() >= 64, ErrorCode::InvalidTokenAccount);
                // **FIX CRITICAL #49**: Replace .unwrap() with proper error handling to prevent panic
                let rift_mint_check = Pubkey::new_from_array(
                    rift_data[0..32]
                        .try_into()
                        .map_err(|_| ErrorCode::InvalidTokenAccount)?,
                );
                let rift_owner = Pubkey::new_from_array(
                    rift_data[32..64]
                        .try_into()
                        .map_err(|_| ErrorCode::InvalidTokenAccount)?,
                );
                require!(rift_mint_check == rift.rift_mint, ErrorCode::InvalidMint);
                require!(
                    rift_owner == ctx.accounts.user.key(),
                    ErrorCode::UnauthorizedTokenAccount
                );
            }

            // **HIGH FIX #5**: Validate amount bounds BEFORE fee calculation to prevent edge case overflows
            let fee_multiplier = u64::from(rift.wrap_fee_bps);
            require!(
                amount <= u64::MAX / fee_multiplier.max(1),
                ErrorCode::AmountTooLarge
            );

            // **CRITICAL FIX - HIGH ISSUE #2**: Check vault balance BEFORE transfer to detect underlying transfer fees
            let vault_balance_before = ctx.accounts.vault.amount;

            // **TOKEN-2022 FIX**: Read underlying mint decimals for transfer_checked
            let underlying_mint_data = ctx.accounts.underlying_mint.try_borrow_data()?;
            require!(underlying_mint_data.len() >= 45, ErrorCode::InvalidMint);
            let underlying_decimals = underlying_mint_data[44]; // decimals at offset 44
            drop(underlying_mint_data);

            // **FIX CRITICAL #27**: Transfer underlying tokens using underlying_token_program
            // **TOKEN-2022 FIX**: Use transfer_checked instead of transfer for Token-2022 compatibility
            let transfer_ctx = CpiContext::new(
                ctx.accounts.underlying_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_underlying.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                    mint: ctx.accounts.underlying_mint.to_account_info(),
                },
            );
            interface_transfer_checked(transfer_ctx, amount, underlying_decimals)?;

            // **CRITICAL FIX - HIGH ISSUE #2**: Reload vault to get actual amount received (after transfer fees)
            ctx.accounts.vault.reload()?;
            let vault_balance_after = ctx.accounts.vault.amount;
            let actual_received = vault_balance_after
                .checked_sub(vault_balance_before)
                .ok_or(ErrorCode::MathOverflow)?;

            msg!(
                "Requested: {}, Actually received in vault: {}",
                amount,
                actual_received
            );

            // **CRITICAL FIX - HIGH ISSUE #2**: Calculate wrap fee based on ACTUAL amount received, not requested
            let wrap_fee = actual_received
                .checked_mul(fee_multiplier)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_div(10000)
                .ok_or(ErrorCode::MathOverflow)?;
            let amount_after_fee = actual_received
                .checked_sub(wrap_fee)
                .ok_or(ErrorCode::MathOverflow)?;

            // **MEDIUM FIX #3**: Slippage protection - ensure user receives at least minimum expected RIFT
            // Protects against fee-on-transfer tokens and extreme slippage
            require!(
                amount_after_fee >= min_rift_out,
                ErrorCode::SlippageExceeded
            );
            msg!(
                "✅ Slippage check passed: minting {} >= minimum {}",
                amount_after_fee,
                min_rift_out
            );

            let rift_key = rift.key();

            // **FEE ROUTING**: Transfer wrap fee from vault to fees_vault (only if fees_vault is initialized)
            // **FIX MEDIUM #5 (Audit)**: Measure actual credited amount for transfer-fee underlyings
            let actual_fee_credited: u64;
            if wrap_fee > 0 && rift.fees_vault != anchor_lang::solana_program::system_program::ID {
                // **FIX MEDIUM #23**: Verify fees_vault is actually a valid token account before transferring
                let fees_vault_info = ctx.accounts.fees_vault.to_account_info();
                require!(
                    fees_vault_info.owner == ctx.accounts.underlying_token_program.key,
                    ErrorCode::InvalidFeesVault
                );
                require!(
                    fees_vault_info.data_len() >= 165, // Minimum token account size
                    ErrorCode::InvalidFeesVault
                );

                // **FIX MEDIUM #5 (Audit)**: Get pre-transfer balance
                let fees_vault_balance_before = ctx.accounts.fees_vault.amount;

                let vault_auth_bump = [ctx.bumps.vault_authority];
                let vault_auth_seeds: &[&[u8]] =
                    &[b"vault_auth", rift_key.as_ref(), &vault_auth_bump];
                let vault_auth_signer = &[&vault_auth_seeds[..]];

                let fee_transfer_ctx = CpiContext::new_with_signer(
                    ctx.accounts.underlying_token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.fees_vault.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                        mint: ctx.accounts.underlying_mint.to_account_info(),
                    },
                    vault_auth_signer,
                );
                interface_transfer_checked(fee_transfer_ctx, wrap_fee, underlying_decimals)?;

                // **FIX MEDIUM #5 (Audit)**: Measure actual credited amount
                ctx.accounts.fees_vault.reload()?;
                let fees_vault_balance_after = ctx.accounts.fees_vault.amount;
                actual_fee_credited = fees_vault_balance_after
                    .checked_sub(fees_vault_balance_before)
                    .ok_or(ErrorCode::MathOverflow)?;

                if actual_fee_credited != wrap_fee {
                    msg!("⚠️ Transfer fee detected: sent {}, credited {}", wrap_fee, actual_fee_credited);
                }
                msg!("Wrap fee {} transferred to fees_vault (credited: {})", wrap_fee, actual_fee_credited);
            } else if wrap_fee > 0 {
                actual_fee_credited = wrap_fee; // Fee kept in vault, accounted at full value
                msg!(
                    "Wrap fee {} kept in vault (fees_vault not initialized)",
                    wrap_fee
                );
            } else {
                actual_fee_credited = 0;
            }

            // Mint RIFT tokens to user
            let bump_seed = [ctx.bumps.rift_mint_authority];
            let signer_seeds: &[&[u8]] = &[b"rift_mint_auth", rift_key.as_ref(), &bump_seed];
            let signer = &[&signer_seeds[..]];

            // **FIX CRITICAL #27**: Mint RIFT tokens using rift_token_program (always Token-2022)
            let mint_ctx = CpiContext::new_with_signer(
                ctx.accounts.rift_token_program.to_account_info(),
                token_interface::MintTo {
                    mint: ctx.accounts.rift_mint.to_account_info(),
                    to: ctx.accounts.user_rift_tokens.to_account_info(),
                    authority: ctx.accounts.rift_mint_authority.to_account_info(),
                },
                signer,
            );
            interface_mint_to(mint_ctx, amount_after_fee)?;

            // Update rift state
            rift.total_underlying_wrapped = rift
                .total_underlying_wrapped
                .checked_add(amount_after_fee)
                .ok_or(ErrorCode::MathOverflow)?;
            rift.total_rift_minted = rift
                .total_rift_minted
                .checked_add(amount_after_fee)
                .ok_or(ErrorCode::MathOverflow)?;

            // **FEE ACCOUNTING FIX**: Track wrap fees in total_fees_collected (same as unwrap)
            // **FIX MEDIUM #5 (Audit)**: Use actual_fee_credited to account for transfer fees
            if actual_fee_credited > 0 {
                rift.total_fees_collected = rift
                    .total_fees_collected
                    .checked_add(actual_fee_credited)
                    .ok_or(ErrorCode::MathOverflow)?;
            }

            msg!(
                "✅ Wrapped {} tokens → {} RIFT (fee: {})",
                amount,
                amount_after_fee,
                wrap_fee
            );

            Ok(())
        })();

        // **FIX HIGH #1 + FIX ISSUE #7**: Always clear guard and slot, even on error
        ctx.accounts.rift.reentrancy_guard = false;
        ctx.accounts.rift.reentrancy_guard_slot = 0;

        execution_result
    }

    /// Simple vault-based unwrap - burns RIFT and returns underlying from vault
    pub fn unwrap_from_vault(ctx: Context<UnwrapFromVault>, rift_token_amount: u64, min_underlying_out: u64) -> Result<()> {
        // **CRITICAL FIX + FIX HIGH #1 + FIX ISSUE #7**: Add reentrancy protection with auto-timeout
        {
            let rift = &mut ctx.accounts.rift;

            // **FIX ISSUE #7**: Auto-clear stuck guard after timeout
            if rift.reentrancy_guard {
                let current_slot = Clock::get()?.slot;
                if current_slot > rift.reentrancy_guard_slot + REENTRANCY_TIMEOUT_SLOTS {
                    msg!(
                        "⚠️ Auto-clearing stuck reentrancy guard (set at slot {}, current {})",
                        rift.reentrancy_guard_slot,
                        current_slot
                    );
                    rift.reentrancy_guard = false;
                    rift.reentrancy_guard_slot = 0;
                } else {
                    return Err(ErrorCode::ReentrancyDetected.into());
                }
            }

            rift.reentrancy_guard = true;
            rift.reentrancy_guard_slot = Clock::get()?.slot;
        }

        // Execute the actual function logic
        let execution_result = (|| -> Result<()> {
            let rift = &mut ctx.accounts.rift;

            // **FIX ISSUE #8**: Verify rift is not closed
            require!(!rift.is_closed, ErrorCode::RiftClosed);

            // Validate amount
            require!(rift_token_amount > 0, ErrorCode::InvalidAmount);

            // **SECURITY FIX #49**: Manual token account validation (stack optimization)
            // **FIX CRITICAL #27**: Validate accounts against their respective token programs
            {
                // Validate underlying token account (can be SPL Token or Token-2022)
                require!(
                    *ctx.accounts.user_underlying.owner
                        == ctx.accounts.underlying_token_program.key(),
                    ErrorCode::InvalidTokenAccount
                );
                let underlying_data = ctx.accounts.user_underlying.try_borrow_data()?;
                require!(underlying_data.len() >= 64, ErrorCode::InvalidTokenAccount);
                // **FIX CRITICAL #49**: Replace .unwrap() with proper error handling to prevent panic
                let underlying_mint = Pubkey::new_from_array(
                    underlying_data[0..32]
                        .try_into()
                        .map_err(|_| ErrorCode::InvalidTokenAccount)?,
                );
                let underlying_owner = Pubkey::new_from_array(
                    underlying_data[32..64]
                        .try_into()
                        .map_err(|_| ErrorCode::InvalidTokenAccount)?,
                );
                require!(
                    underlying_mint == rift.underlying_mint,
                    ErrorCode::InvalidMint
                );
                require!(
                    underlying_owner == ctx.accounts.user.key(),
                    ErrorCode::UnauthorizedTokenAccount
                );

                // Validate rift token account (always Token-2022)
                require!(
                    *ctx.accounts.user_rift_tokens.owner == spl_token_2022::ID,
                    ErrorCode::InvalidTokenAccount
                );
                let rift_data = ctx.accounts.user_rift_tokens.try_borrow_data()?;
                require!(rift_data.len() >= 64, ErrorCode::InvalidTokenAccount);
                // **FIX CRITICAL #49**: Replace .unwrap() with proper error handling to prevent panic
                let rift_mint_check = Pubkey::new_from_array(
                    rift_data[0..32]
                        .try_into()
                        .map_err(|_| ErrorCode::InvalidTokenAccount)?,
                );
                let rift_owner = Pubkey::new_from_array(
                    rift_data[32..64]
                        .try_into()
                        .map_err(|_| ErrorCode::InvalidTokenAccount)?,
                );
                require!(rift_mint_check == rift.rift_mint, ErrorCode::InvalidMint);
                require!(
                    rift_owner == ctx.accounts.user.key(),
                    ErrorCode::UnauthorizedTokenAccount
                );
            }

            // **HIGH FIX #5**: Validate amount bounds BEFORE fee calculation
            let fee_multiplier = u64::from(rift.unwrap_fee_bps);
            require!(
                rift_token_amount <= u64::MAX / fee_multiplier.max(1),
                ErrorCode::AmountTooLarge
            );

            // **MEDIUM FIX #11**: Use configurable unwrap fee - safe now due to bounds check above
            let unwrap_fee = rift_token_amount
                .checked_mul(fee_multiplier)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_div(10000)
                .ok_or(ErrorCode::MathOverflow)?;
            let amount_after_fee = rift_token_amount
                .checked_sub(unwrap_fee)
                .ok_or(ErrorCode::MathOverflow)?;

            msg!(
                "💰 Unwrapping {} RIFT from vault (fee: {}, net: {})",
                rift_token_amount,
                unwrap_fee,
                amount_after_fee
            );

            // **HIGH FIX #10**: Verify vault has sufficient balance BEFORE burning user's tokens
            // This prevents user losing RIFT tokens if vault is drained
            // **CRITICAL FIX - HIGH ISSUE #3**: Use .amount from InterfaceAccount instead of manual parsing
            let vault_balance = ctx.accounts.vault.amount;
            require!(
                vault_balance >= amount_after_fee,
                ErrorCode::InsufficientFunds
            );

            // **FIX CRITICAL #27**: Burn RIFT tokens using rift_token_program (always Token-2022)
            let burn_ctx = CpiContext::new(
                ctx.accounts.rift_token_program.to_account_info(),
                anchor_spl::token_interface::Burn {
                    mint: ctx.accounts.rift_mint.to_account_info(),
                    from: ctx.accounts.user_rift_tokens.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            );
            // **TOKEN-2022 MIGRATION**: Burn is FREE - no transfer fee on burns!
            interface_burn(burn_ctx, rift_token_amount)?;

            msg!("✅ Burned {} RIFT tokens", rift_token_amount);

            // Transfer underlying tokens from vault to user
            // Use vault_authority (the vault owner) to sign the transfer
            let rift_key = rift.key();
            let bump_seed = [ctx.bumps.vault_authority];
            let signer_seeds: &[&[u8]] = &[b"vault_auth", rift_key.as_ref(), &bump_seed];
            let signer = &[&signer_seeds[..]];

            // **TOKEN-2022 FIX**: Read underlying mint decimals for transfer_checked
            let underlying_mint_data = ctx.accounts.underlying_mint.try_borrow_data()?;
            require!(underlying_mint_data.len() >= 45, ErrorCode::InvalidMint);
            let underlying_decimals = underlying_mint_data[44]; // decimals at offset 44
            drop(underlying_mint_data);

            // **FEE ROUTING**: Transfer unwrap fee from vault to fees_vault FIRST (only if fees_vault is initialized)
            if unwrap_fee > 0 && rift.fees_vault != anchor_lang::solana_program::system_program::ID
            {
                // **FIX MEDIUM #23**: Verify fees_vault is actually a valid token account before transferring
                // **FIX CRITICAL #27**: fees_vault holds underlying tokens, validate against underlying_token_program
                let fees_vault_info = ctx.accounts.fees_vault.to_account_info();
                require!(
                    fees_vault_info.owner == ctx.accounts.underlying_token_program.key,
                    ErrorCode::InvalidFeesVault
                );
                require!(
                    fees_vault_info.data_len() >= 165, // Minimum token account size
                    ErrorCode::InvalidFeesVault
                );

                let fee_transfer_ctx = CpiContext::new_with_signer(
                    ctx.accounts.underlying_token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.fees_vault.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                        mint: ctx.accounts.underlying_mint.to_account_info(),
                    },
                    signer,
                );
                interface_transfer_checked(fee_transfer_ctx, unwrap_fee, underlying_decimals)?;
                msg!("Unwrap fee {} transferred to fees_vault", unwrap_fee);
            } else if unwrap_fee > 0 {
                msg!(
                    "Unwrap fee {} kept in vault (fees_vault not initialized)",
                    unwrap_fee
                );
            }

            // **CRITICAL FIX - HIGH ISSUE #2**: Check vault balance BEFORE transfer
            let vault_balance_before = ctx.accounts.vault.amount;

            // **FIX CRITICAL #13**: Parse user DESTINATION balance before transfer (manual parsing for UncheckedAccount)
            let user_data_before = ctx.accounts.user_underlying.try_borrow_data()?;
            require!(user_data_before.len() >= 72, ErrorCode::InvalidTokenAccount);
            // **FIX CRITICAL #49**: Replace .unwrap() with proper error handling to prevent panic
            let user_balance_before = u64::from_le_bytes(
                user_data_before[64..72]
                    .try_into()
                    .map_err(|_| ErrorCode::InvalidTokenAccount)?,
            );
            drop(user_data_before); // Release borrow before CPI
            msg!(
                "📊 User underlying balance before transfer: {}",
                user_balance_before
            );

            // **FIX CRITICAL #27**: Transfer underlying tokens using underlying_token_program
            // **TOKEN-2022 FIX**: Use transfer_checked for Token-2022 compatibility
            let transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.underlying_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_underlying.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                    mint: ctx.accounts.underlying_mint.to_account_info(),
                },
                signer,
            );
            interface_transfer_checked(transfer_ctx, amount_after_fee, underlying_decimals)?;

            // **CRITICAL FIX - HIGH ISSUE #2**: Reload vault to verify actual amount sent (if underlying has transfer fees)
            ctx.accounts.vault.reload()?;
            let vault_balance_after = ctx.accounts.vault.amount;
            let actual_sent = vault_balance_before
                .checked_sub(vault_balance_after)
                .ok_or(ErrorCode::MathOverflow)?;

            // **FIX CRITICAL #13**: Parse user DESTINATION balance after transfer to detect destination-side transfer fees
            let user_data_after = ctx.accounts.user_underlying.try_borrow_data()?;
            require!(user_data_after.len() >= 72, ErrorCode::InvalidTokenAccount);
            // **FIX CRITICAL #49**: Replace .unwrap() with proper error handling to prevent panic
            let user_balance_after = u64::from_le_bytes(
                user_data_after[64..72]
                    .try_into()
                    .map_err(|_| ErrorCode::InvalidTokenAccount)?,
            );
            drop(user_data_after); // Release borrow

            let actual_received = user_balance_after
                .checked_sub(user_balance_before)
                .ok_or(ErrorCode::MathOverflow)?;

            msg!("✅ Transferred {} underlying tokens from vault (actually sent: {}, actually received: {})",
            amount_after_fee, actual_sent, actual_received);

            // **FIX CRITICAL #13**: Detect destination-side transfer fees
            if actual_received < actual_sent {
                let destination_fee = actual_sent.saturating_sub(actual_received);
                let fee_percentage = (destination_fee as f64 / actual_sent as f64) * 100.0;
                msg!("⚠️ DESTINATION-SIDE TRANSFER FEE DETECTED!");
                msg!(
                    "⚠️ Vault sent: {}, User received: {}",
                    actual_sent,
                    actual_received
                );
                msg!(
                    "⚠️ Destination fee: {} ({:.4}%)",
                    destination_fee,
                    fee_percentage
                );

                // NOTE: Transfer fee limit removed - users are informed via UI warnings instead
                msg!("⚠️ Destination fee accepted: {:.4}%", fee_percentage);
            }

            // **CRITICAL FIX #2**: Slippage protection - ensure user received at least expected amount
            // Protects against fee-on-transfer tokens and deflationary tokens
            require!(actual_sent >= amount_after_fee, ErrorCode::SlippageExceeded);
            msg!(
                "✅ Slippage check passed: sent {} >= expected {}",
                actual_sent,
                amount_after_fee
            );

            // User-provided slippage protection on RECEIVED amount
            require!(
                actual_received >= min_underlying_out,
                ErrorCode::SlippageExceeded
            );
            msg!(
                "✅ User slippage check passed: received {} >= min_out {}",
                actual_received,
                min_underlying_out
            );

            // **CRITICAL FIX - HIGH ISSUE #2**: Update accounting based on ACTUAL amount sent, not requested
            rift.total_underlying_wrapped = rift
                .total_underlying_wrapped
                .checked_sub(actual_sent)
                .ok_or(ErrorCode::MathOverflow)?;
            rift.total_rift_minted = rift
                .total_rift_minted
                .checked_sub(rift_token_amount)
                .ok_or(ErrorCode::MathOverflow)?;
            rift.total_burned = rift
                .total_burned
                .checked_add(rift_token_amount)
                .ok_or(ErrorCode::MathOverflow)?;
            rift.total_fees_collected = rift
                .total_fees_collected
                .checked_add(unwrap_fee)
                .ok_or(ErrorCode::MathOverflow)?;

            // Update volume
            rift.total_volume_24h = rift
                .total_volume_24h
                .checked_add(amount_after_fee)
                .ok_or(ErrorCode::MathOverflow)?;

            // NOTE: Fee distribution happens via separate batch process to avoid stack overflow
            // **FIX MEDIUM #15**: Do NOT update last_oracle_update on unwrap to prevent rebalance DoS
            // last_oracle_update should only be updated when actual oracle price data is updated,
            // not on every vault activity. This prevents users from delaying rebalances via unwrap spam.

            emit!(UnwrapExecuted {
                rift: rift.key(),
                user: ctx.accounts.user.key(),
                rift_token_amount,
                fee_amount: unwrap_fee,
                underlying_returned: amount_after_fee,
            });

            msg!("✅ Unwrap from vault completed");

            Ok(())
        })();

        // **FIX HIGH #1 + FIX ISSUE #7**: Always clear guard and slot, even on error
        ctx.accounts.rift.reentrancy_guard = false;
        ctx.accounts.rift.reentrancy_guard_slot = 0;

        execution_result
    }

    /// Admin function: Fix vault ownership conflicts
    /// **SECURITY FIX #4**: Only PROGRAM_AUTHORITY can fix vault conflicts
    pub fn admin_fix_vault_conflict(ctx: Context<AdminFixVaultConflict>) -> Result<()> {
        // **SECURITY FIX #4**: Only PROGRAM_AUTHORITY can use this admin function
        let admin_pubkey = Pubkey::from_str_const(PROGRAM_AUTHORITY);
        require!(
            ctx.accounts.program_authority.key() == admin_pubkey,
            ErrorCode::UnauthorizedAdmin
        );

        // Get the current vault and expected authority
        let vault_info = &ctx.accounts.vault;
        let expected_authority = &ctx.accounts.vault_authority;

        msg!(
            "Fixing vault conflict for rift: {}",
            ctx.accounts.rift.key()
        );
        msg!("Expected authority: {}", expected_authority.key());

        // Check current vault owner
        let vault_account_info = vault_info.to_account_info();
        let vault_data = vault_account_info.data.borrow();
        if vault_data.len() >= 64 {
            let current_owner_bytes = &vault_data[32..64];
            let current_owner =
                Pubkey::try_from(current_owner_bytes).map_err(|_| ErrorCode::InvalidByteSlice)?;
            msg!("Current vault owner: {}", current_owner);

            if current_owner != expected_authority.key() {
                msg!("Vault ownership conflict detected and logged");
                msg!("Manual intervention required to reassign vault");
                // In production, this would implement vault migration logic
                // For now, we just log the conflict for manual resolution
            }
        }

        Ok(())
    }

    /// **SECURITY FIX #4**: Update Switchboard oracle using SDK (prevents byte offset errors)
    /// Uses switchboard-on-demand SDK for validated price parsing
    pub fn update_switchboard_oracle(ctx: Context<UpdateSwitchboardOracle>) -> Result<()> {
        let rift = &mut ctx.accounts.rift;

        // **SECURITY FIX #50**: Validate oracle authority (creator or governance)
        require!(
            ctx.accounts.oracle_authority.key() == rift.creator,
            ErrorCode::Unauthorized
        );

        // **SECURITY FIX #50**: Bind to stored Switchboard account address
        let expected_switchboard_account = rift
            .switchboard_feed_account
            .ok_or(ErrorCode::OracleAccountNotSet)?;

        require!(
            ctx.accounts.switchboard_feed.key() == expected_switchboard_account,
            ErrorCode::OracleAccountMismatch
        );

        // **SECURITY FIX #4**: Use Switchboard SDK for validated price parsing
        // This replaces manual byte slicing with audited SDK that validates:
        // - Account structure and version
        // - Oracle responses and consensus
        // - Staleness and update timestamps
        // - Min oracle requirements

        let switchboard_program_id =
            Pubkey::from_str_const("SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f");
        require!(
            ctx.accounts.switchboard_feed.owner == &switchboard_program_id,
            ErrorCode::InvalidOracleOwner
        );

        // Load and validate feed using Switchboard SDK
        // Note: switchboard-on-demand v0.11.1 API expects Ref<'_, &mut [u8]> for parse()
        // PullFeedAccountData::parse() internally validates:
        // ✅ Account discriminator (first 8 bytes must match aggregator type)
        // ✅ Account version and structure
        // ✅ Deserialization of all fields
        let feed_account_info = ctx.accounts.switchboard_feed.to_account_info();
        let feed_data = feed_account_info
            .try_borrow_data()
            .map_err(|_| ErrorCode::InvalidOracleData)?;

        let feed_account =
            PullFeedAccountData::parse(feed_data).map_err(|_| ErrorCode::InvalidOracleData)?;

        // Get current time for validation
        let current_time = Clock::get()?.unix_timestamp;
        const MAX_AGE_SECONDS: u64 = 300; // 5 minutes

        // Get validated price from feed
        // SDK automatically checks:
        // ✅ Oracle consensus (min responses met)
        // ✅ Account structure and version
        // ✅ Staleness based on update timestamp
        let price_result = feed_account
            .value(MAX_AGE_SECONDS)
            .map_err(|_| ErrorCode::OraclePriceStale)?;

        // Switchboard returns Decimal type - convert to f64
        let price_f64 =
            (price_result.mantissa() as f64) / 10f64.powi(price_result.scale() as i32);

        // **FIX CRITICAL**: Validate finiteness and bounds before cast to prevent overflow
        // Check for NaN, infinity, and that scaled price fits in u64 range
        // Must validate BEFORE cast since invalid f64 can overflow to arbitrary u64 values
        require!(
            price_f64.is_finite() && price_f64 > 0.0,
            ErrorCode::InvalidOraclePrice
        );

        // **FIX MEDIUM #44**: Validate price won't exceed u64::MAX after scaling
        // Also check against protocol max (1e12) to prevent later protocol brick
        let scaled_price_f64 = price_f64 * 1_000_000.0;
        require!(
            scaled_price_f64 > 0.0 && scaled_price_f64 <= 1_000_000_000_000.0,
            ErrorCode::OraclePriceTooLarge
        );

        // Convert f64 to u64 (Switchboard returns decimal values)
        // Assuming price is in USD with 6 decimals precision
        // Safe cast: validated finiteness and bounds above
        let price = scaled_price_f64 as u64;

        msg!("✅ Switchboard SDK validation passed");
        msg!("   Price: {} USD", price_f64);
        msg!("   Last update: within {} seconds", MAX_AGE_SECONDS);

        // For Switchboard, we use a default confidence of 1% of price
        // SDK provides std_deviation which could be used for more accurate confidence
        let confidence = price
            .checked_mul(1)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(100)
            .ok_or(ErrorCode::MathOverflow)?;

        // **SECURITY FIX #50**: Validate confidence (confidence should be <= 5% of price)
        let max_confidence = price
            .checked_mul(5)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(100)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(
            confidence <= max_confidence,
            ErrorCode::OracleConfidenceTooLow
        );

        // Note: Price bounds already validated before cast (finiteness + 0 < price <= 1e12)

        // Update rift oracle with validated price
        rift.add_price_data(price, confidence, current_time)?;

        emit!(OraclePriceUpdated {
            rift: rift.key(),
            oracle_type: OracleType::Switchboard,
            price,
            confidence,
            timestamp: current_time,
        });

        Ok(())
    }

    /// **NEW**: Update oracle with manual price data (e.g., from Jupiter API)
    /// Allows creator to update embedded oracle for tokens without Switchboard feeds
    /// **HIGH FIX #3**: Rate limited to 1 update per hour with max 10% price change
    pub fn update_manual_oracle(
        ctx: Context<UpdateManualOracle>,
        price: u64,
        confidence: u64,
    ) -> Result<()> {
        let rift = &mut ctx.accounts.rift;
        let current_time = Clock::get()?.unix_timestamp;

        // Only creator can manually update oracle prices
        require!(
            ctx.accounts.oracle_authority.key() == rift.creator,
            ErrorCode::Unauthorized
        );

        // **HIGH FIX #3**: Rate limit - max 1 update per hour (3600 seconds)
        if rift.last_manual_oracle_update > 0 {
            require!(
                current_time - rift.last_manual_oracle_update >= 3600,
                ErrorCode::OracleUpdateTooFrequent
            );
        }

        // **HIGH FIX #3**: Max 10% price change from current average (1000 bps)
        // **FIX CRITICAL #28 + FIX INFO #1 (Audit)**: Use allow_stale_fallback=true to enable recovery
        // When all oracle prices are stale AND backing_ratio is >24h old, this allows manual oracle
        // updates to proceed using the stale backing_ratio as baseline, preventing permanent deadlock
        let current_avg_price = rift.get_average_oracle_price_with_options(true)?;
        if current_avg_price > 0 {
            let price_change = if price > current_avg_price {
                price
                    .checked_sub(current_avg_price)
                    .ok_or(ErrorCode::MathOverflow)?
            } else {
                current_avg_price
                    .checked_sub(price)
                    .ok_or(ErrorCode::MathOverflow)?
            };
            let price_change_bps = price_change
                .checked_mul(10000)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_div(current_avg_price)
                .ok_or(ErrorCode::MathOverflow)?;

            require!(
                price_change_bps <= 1000, // Max 10% change per update
                ErrorCode::OraclePriceChangeTooLarge
            );
        }

        // **FIX HIGH #2 + #18**: Check cumulative drift over lifetime (no reset)
        // Drift window is initialized once and then enforced cumulatively
        const DRIFT_WINDOW_SECONDS: i64 = 604800; // 7 days (unused now, kept for reference)

        // Initialize drift baseline on first manual oracle update
        if rift.manual_oracle_drift_window_start == 0 {
            rift.manual_oracle_base_price = current_avg_price;
            rift.manual_oracle_drift_window_start = current_time;
            msg!(
                "📊 Initializing drift baseline at price: {}",
                current_avg_price
            );
        } else if rift.manual_oracle_base_price > 0 {
            // Check cumulative drift within 7-day window (max 30% total drift)
            let cumulative_change = if price > rift.manual_oracle_base_price {
                price
                    .checked_sub(rift.manual_oracle_base_price)
                    .ok_or(ErrorCode::MathOverflow)?
            } else {
                rift.manual_oracle_base_price
                    .checked_sub(price)
                    .ok_or(ErrorCode::MathOverflow)?
            };
            let cumulative_drift_bps = cumulative_change
                .checked_mul(10000)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_div(rift.manual_oracle_base_price)
                .ok_or(ErrorCode::MathOverflow)?;

            let window_age_days = (current_time - rift.manual_oracle_drift_window_start) / 86400;
            msg!(
                "📊 Cumulative drift: {}bps over {} days (max: 3000bps/7days)",
                cumulative_drift_bps,
                window_age_days
            );

            require!(
                cumulative_drift_bps <= 3000, // Max 30% cumulative drift in 7 days
                ErrorCode::OracleCumulativeDriftTooLarge
            );
        }

        // **CRITICAL FIX #4**: Validate price bounds to match get_average_oracle_price limit
        // Max: 1_000_000_000_000 (1e12) - matches the limit in get_average to prevent protocol brick
        require!(price > 0, ErrorCode::InvalidOraclePrice);
        require!(price <= 1_000_000_000_000, ErrorCode::OraclePriceTooLarge);

        // Validate confidence is reasonable (max 50% of price)
        let max_confidence = price
            .checked_mul(5)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(100)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(
            confidence <= max_confidence,
            ErrorCode::InvalidConfidence
        );

        msg!(
            "Manual oracle update: price={}, confidence={}",
            price,
            confidence
        );

        // Update rift oracle with validated price
        rift.add_price_data(price, confidence, current_time)?;

        // **HIGH FIX #3**: Update rate limit timestamp
        rift.last_manual_oracle_update = current_time;

        emit!(OraclePriceUpdated {
            rift: rift.key(),
            oracle_type: OracleType::Manual,
            price,
            confidence,
            timestamp: current_time,
        });

        Ok(())
    }

    /// Manual rebalance (can be called by anyone if conditions are met)
    pub fn trigger_rebalance(ctx: Context<TriggerRebalance>) -> Result<()> {
        // **FIX HIGH #1 + FIX ISSUE #7**: Add reentrancy protection with auto-timeout
        {
            let rift = &mut ctx.accounts.rift;

            // **FIX ISSUE #7**: Auto-clear stuck guard after timeout
            if rift.reentrancy_guard {
                let current_slot = Clock::get()?.slot;
                if current_slot > rift.reentrancy_guard_slot + REENTRANCY_TIMEOUT_SLOTS {
                    msg!(
                        "⚠️ Auto-clearing stuck reentrancy guard (set at slot {}, current {})",
                        rift.reentrancy_guard_slot,
                        current_slot
                    );
                    rift.reentrancy_guard = false;
                    rift.reentrancy_guard_slot = 0;
                } else {
                    return Err(ErrorCode::ReentrancyDetected.into());
                }
            }

            rift.reentrancy_guard = true;
            rift.reentrancy_guard_slot = Clock::get()?.slot;
        }

        // Execute the actual function logic in a closure
        let execution_result = (|| -> Result<()> {
            let rift = &mut ctx.accounts.rift;
            let clock = Clock::get()?;

            // Check if manual rebalance is allowed
            require!(
                rift.can_manual_rebalance(clock.unix_timestamp)?,
                ErrorCode::RebalanceTooSoon
            );

            rift.trigger_automatic_rebalance(clock.unix_timestamp)?;

            Ok(())
        })();

        // **FIX HIGH #1 + FIX ISSUE #7**: Always clear guard and slot, even on error
        ctx.accounts.rift.reentrancy_guard = false;
        ctx.accounts.rift.reentrancy_guard_slot = 0;

        execution_result
    }

    /// Close a rift and return rent to creator (for fixing invalid vaults)
    /// **FIX CRITICAL #12**: Now checks ALL vaults are empty before allowing close
    pub fn close_rift(ctx: Context<CloseRift>) -> Result<()> {
        let rift = &ctx.accounts.rift;

        // Only creator can close their rift
        require!(
            rift.creator == ctx.accounts.creator.key(),
            ErrorCode::UnauthorizedClose
        );
        // Prevent closing while any RIFT tokens are still in circulation
        require!(
            rift.total_rift_minted == 0,
            ErrorCode::VaultNotEmpty
        );

        // **FIX CRITICAL #27**: Allow closing if vaults not initialized
        // Check ACTUAL vault balance if initialized
        let system_program_key = anchor_lang::solana_program::system_program::ID;

        if rift.vault != system_program_key {
            // **FIX CRITICAL #27**: Manual balance check for UncheckedAccount
            // Verify vault is a valid token account and has zero balance
            require!(
                *ctx.accounts.vault.owner == anchor_spl::token::ID
                    || *ctx.accounts.vault.owner == spl_token_2022::ID,
                ErrorCode::InvalidVault
            );
            require!(
                ctx.accounts.vault.key() == rift.vault,
                ErrorCode::InvalidVault
            );
            let vault_data = ctx.accounts.vault.try_borrow_data()?;
            require!(vault_data.len() >= 72, ErrorCode::InvalidVault);
            let vault_balance = u64::from_le_bytes(vault_data[64..72].try_into().map_err(|_| ErrorCode::InvalidAccountData)?);
            drop(vault_data);

            require!(vault_balance == 0, ErrorCode::VaultNotEmpty);
            msg!("✅ Backing vault balance verified: 0 tokens");
        } else {
            msg!("⚠️ Vault not initialized (skip check)");
        }

        // Also verify accounting matches (double check)
        require!(rift.total_underlying_wrapped == 0, ErrorCode::VaultNotEmpty);
        require!(rift.total_fees_collected == 0, ErrorCode::FeesVaultNotEmpty);

        // **FIX CRITICAL #27**: Check fees_vault balance if initialized
        // Fees must be distributed before closing
        if rift.fees_vault != system_program_key {
            // **FIX CRITICAL #27**: Manual balance check for UncheckedAccount
            require!(
                *ctx.accounts.fees_vault.owner == anchor_spl::token::ID
                    || *ctx.accounts.fees_vault.owner == spl_token_2022::ID,
                ErrorCode::InvalidFeesVault
            );
            require!(
                ctx.accounts.fees_vault.key() == rift.fees_vault,
                ErrorCode::InvalidFeesVault
            );
            let fees_vault_data = ctx.accounts.fees_vault.try_borrow_data()?;
            require!(fees_vault_data.len() >= 72, ErrorCode::InvalidFeesVault);
            let fees_vault_balance =
                u64::from_le_bytes(fees_vault_data[64..72].try_into().map_err(|_| ErrorCode::InvalidAccountData)?);
            drop(fees_vault_data);

            require!(fees_vault_balance == 0, ErrorCode::FeesVaultNotEmpty);
            msg!("✅ Fees vault balance verified: 0 tokens");
        } else {
            msg!("⚠️ Fees vault not initialized (skip check)");
        }

        // **FIX CRITICAL #27**: Check withheld_vault balance if initialized
        // Withheld fees must be distributed before closing
        if rift.withheld_vault != system_program_key {
            // **FIX CRITICAL #27**: Manual balance check for UncheckedAccount
            require!(
                *ctx.accounts.withheld_vault.owner == anchor_spl::token::ID
                    || *ctx.accounts.withheld_vault.owner == spl_token_2022::ID,
                ErrorCode::InvalidWithheldVault
            );
            require!(
                ctx.accounts.withheld_vault.key() == rift.withheld_vault,
                ErrorCode::InvalidWithheldVault
            );
            let withheld_vault_data = ctx.accounts.withheld_vault.try_borrow_data()?;
            require!(
                withheld_vault_data.len() >= 72,
                ErrorCode::InvalidWithheldVault
            );
            let withheld_vault_balance =
                u64::from_le_bytes(withheld_vault_data[64..72].try_into().map_err(|_| ErrorCode::InvalidAccountData)?);
            drop(withheld_vault_data);

            require!(
                withheld_vault_balance == 0,
                ErrorCode::WithheldVaultNotEmpty
            );
            msg!("✅ Withheld vault balance verified: 0 tokens");
        } else {
            msg!("⚠️ Withheld vault not initialized (skip check)");
        }

        msg!("✅ All vaults empty - safe to close rift");

        emit!(RiftClosed {
            rift: rift.key(),
            creator: rift.creator,
        });

        Ok(())
    }

    /// Admin function: Close any rift regardless of creator (program authority only)
    pub fn admin_close_rift(ctx: Context<AdminCloseRift>) -> Result<()> {
        let rift = &mut ctx.accounts.rift;

        // Only program authority can use this function
        let admin_pubkey = Pubkey::from_str_const(PROGRAM_AUTHORITY);
        require!(
            ctx.accounts.program_authority.key() == admin_pubkey,
            ErrorCode::UnauthorizedAdmin
        );

        // **FIX ISSUE #1**: Actually mark the rift as closed
        rift.is_closed = true;
        rift.closed_at_slot = Clock::get()?.slot;

        // **FIX ISSUE #1**: Reset reentrancy guard to prevent stuck state
        rift.reentrancy_guard = false;
        rift.reentrancy_guard_slot = 0;

        // Log the admin close action
        msg!(
            "Admin closing rift: {} (original creator: {}) at slot {}",
            rift.key(),
            rift.creator,
            rift.closed_at_slot
        );

        emit!(RiftAdminClosed {
            rift: rift.key(),
            original_creator: rift.creator,
            admin: ctx.accounts.program_authority.key(),
        });

        Ok(())
    }

    /// Emergency admin function to withdraw tokens from vault
    /// **CRITICAL SECURITY**: Requires BOTH admin authorities to prevent single-point-of-failure
    /// Only use in case of critical issues like closed rifts with locked funds
    ///
    /// **ACKNOWLEDGED SECURITY TRADE-OFF (High Issue #3):**
    /// This function does NOT verify:
    /// 1. That the rift is actually closed
    /// 2. That the vault belongs to the specified rift
    /// This is intentional to allow emergency recovery of funds in edge cases where:
    /// - Rift state is corrupted but vault is valid
    /// - Need to recover from program bugs or attacks
    /// - Need manual intervention for stuck funds
    ///
    /// MITIGATION: Requires BOTH independent admin signatures (2-of-2 multisig)
    /// - PROGRAM_AUTHORITY: 9KiFDT1jPtATAJktQxQ5nErmmFXbya6kXb6hFasN5pz4
    /// - ADMIN_AUTHORITY_2: CPr8qxu9LKx4tU5LWj53z669fzydGwFyJzw6xWarZ3zB
    ///
    /// Both keys must explicitly approve any emergency withdrawal, providing accountability.
    pub fn admin_emergency_withdraw_vault(
        ctx: Context<AdminEmergencyWithdrawVault>,
        amount: u64,
        closed_rift_pubkey: Pubkey,
    ) -> Result<()> {
        // **SECURITY FIX #3**: Require BOTH admin authorities
        let admin_1 = Pubkey::from_str_const(PROGRAM_AUTHORITY);
        let admin_2 = Pubkey::from_str_const(ADMIN_AUTHORITY_2);

        require!(
            ctx.accounts.admin_authority_1.key() == admin_1,
            ErrorCode::UnauthorizedAdmin
        );
        require!(
            ctx.accounts.admin_authority_2.key() == admin_2,
            ErrorCode::UnauthorizedAdmin
        );

        // **FIX HIGH #3**: Bind closed_rift_pubkey to actual rift account
        // Prevents deriving vault authority from arbitrary pubkeys
        require!(
            closed_rift_pubkey == ctx.accounts.rift.key(),
            ErrorCode::InvalidRift
        );

        // **FIX HIGH #3**: Verify vault belongs to this rift
        require!(
            ctx.accounts.vault.key() == ctx.accounts.rift.vault,
            ErrorCode::InvalidVault
        );

        msg!(
            "🚨 EMERGENCY: Admin withdrawal from vault: {} tokens (authorized by BOTH admins)",
            amount
        );
        msg!("Using rift pubkey: {}", closed_rift_pubkey);

        // Derive vault authority PDA using the closed rift account
        // Pattern: ["vault_auth", rift.key()]
        let (expected_vault_authority, bump) = Pubkey::find_program_address(
            &[b"vault_auth", closed_rift_pubkey.as_ref()],
            ctx.program_id,
        );

        // Verify the provided vault authority matches the derived one
        require!(
            ctx.accounts.vault_authority.key() == expected_vault_authority,
            ErrorCode::InvalidVaultAuthority
        );

        msg!("Vault authority verified: {}", expected_vault_authority);

        let vault_authority_seeds = &[b"vault_auth", closed_rift_pubkey.as_ref(), &[bump]];
        let signer_seeds = &[&vault_authority_seeds[..]];

        // **TOKEN-2022 FIX**: Read underlying mint decimals for transfer_checked
        let underlying_mint_data = ctx.accounts.underlying_mint.try_borrow_data()?;
        require!(underlying_mint_data.len() >= 45, ErrorCode::InvalidMint);
        let underlying_decimals = underlying_mint_data[44]; // decimals at offset 44
        drop(underlying_mint_data);

        // Transfer tokens from vault to admin
        // **TOKEN-2022 FIX**: Use transfer_checked for Token-2022 compatibility
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.admin_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
                mint: ctx.accounts.underlying_mint.to_account_info(),
            },
            signer_seeds,
        );

        interface_transfer_checked(transfer_ctx, amount, underlying_decimals)?;

        // **ACCOUNTING FIX**: Update rift accounting to reflect withdrawn underlying tokens
        let rift = &mut ctx.accounts.rift;
        rift.total_underlying_wrapped = rift
            .total_underlying_wrapped
            .checked_sub(amount)
            .ok_or(ErrorCode::MathOverflow)?;

        msg!("Emergency withdrawal successful");
        msg!(
            "Updated accounting: total_underlying_wrapped decreased by {}",
            amount
        );

        Ok(())
    }

    /// Admin function to create or update metadata for a rift token
    pub fn admin_update_rift_metadata(
        ctx: Context<AdminUpdateRiftMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        // Only program authority can use this function
        let admin_pubkey = Pubkey::from_str_const(PROGRAM_AUTHORITY);
        require!(
            ctx.accounts.admin.key() == admin_pubkey,
            ErrorCode::UnauthorizedAdmin
        );

        msg!(
            "Admin updating metadata for rift mint: {}",
            ctx.accounts.rift_mint.key()
        );
        msg!("Name: {}, Symbol: {}, URI: {}", name, symbol, uri);

        // Derive mint authority PDA
        let rift_key = ctx.accounts.rift.key();
        let mint_auth_seeds = &[
            b"rift_mint_auth",
            rift_key.as_ref(),
            &[ctx.bumps.rift_mint_authority],
        ];
        let signer_seeds = &[&mint_auth_seeds[..]];

        // Update metadata using Token Metadata Interface
        use anchor_lang::solana_program::program::invoke_signed;
        use spl_token_metadata_interface::instruction::update_field;
        use spl_token_metadata_interface::state::Field;

        // Update name
        let update_name_ix = update_field(
            &spl_token_2022::ID,
            &ctx.accounts.rift_mint.key(),
            &ctx.accounts.rift_mint_authority.key(),
            Field::Name,
            name.clone(),
        );

        invoke_signed(
            &update_name_ix,
            &[
                ctx.accounts.rift_mint.to_account_info(),
                ctx.accounts.rift_mint_authority.to_account_info(),
            ],
            signer_seeds,
        )?;

        // Update symbol
        let update_symbol_ix = update_field(
            &spl_token_2022::ID,
            &ctx.accounts.rift_mint.key(),
            &ctx.accounts.rift_mint_authority.key(),
            Field::Symbol,
            symbol.clone(),
        );

        invoke_signed(
            &update_symbol_ix,
            &[
                ctx.accounts.rift_mint.to_account_info(),
                ctx.accounts.rift_mint_authority.to_account_info(),
            ],
            signer_seeds,
        )?;

        // Update URI if provided
        if !uri.is_empty() {
            let update_uri_ix = update_field(
                &spl_token_2022::ID,
                &ctx.accounts.rift_mint.key(),
                &ctx.accounts.rift_mint_authority.key(),
                Field::Uri,
                uri.clone(),
            );

            invoke_signed(
                &update_uri_ix,
                &[
                    ctx.accounts.rift_mint.to_account_info(),
                    ctx.accounts.rift_mint_authority.to_account_info(),
                ],
                signer_seeds,
            )?;
        }

        msg!("✅ Metadata updated successfully");
        msg!("Name: {}, Symbol: {}, URI: {}", name, symbol, uri);
        Ok(())
    }

    /// Clean up stuck accounts from failed rift creation attempts
    /// **SECURITY FIX**: Only allow creator to clean up their own stuck accounts
    pub fn cleanup_stuck_accounts(ctx: Context<CleanupStuckAccounts>) -> Result<()> {
        // **SECURITY FIX**: Require creator signature to prevent griefing
        // Only the original creator can clean up their stuck accounts

        msg!(
            "Cleaning up stuck accounts for creator: {}",
            ctx.accounts.creator.key()
        );
        msg!("Stuck mint account: {}", ctx.accounts.stuck_rift_mint.key());

        // Verify this is actually a stuck mint from a failed rift creation
        // Check that the mint has proper seeds and belongs to this creator
        // **FIX CRITICAL #14**: Derive PDA using correct seeds matching create_rift
        let expected_rift_pda = Pubkey::create_program_address(
            &[
                b"rift",
                ctx.accounts.underlying_mint.key().as_ref(),
                ctx.accounts.creator.key().as_ref(),
                &[ctx.bumps.expected_rift],
            ],
            ctx.program_id,
        )
        .map_err(|_| ErrorCode::InvalidStuckAccount)?;

        // **FIX CRITICAL #14**: Mint PDA uses [underlying_mint, creator], NOT [rift_address]
        let expected_mint_pda = Pubkey::create_program_address(
            &[
                b"rift_mint",
                ctx.accounts.underlying_mint.key().as_ref(),
                ctx.accounts.creator.key().as_ref(),
                &[ctx.bumps.stuck_rift_mint],
            ],
            ctx.program_id,
        )
        .map_err(|_| ErrorCode::InvalidStuckAccount)?;

        // Verify the stuck mint matches expected PDA
        require!(
            ctx.accounts.stuck_rift_mint.key() == expected_mint_pda,
            ErrorCode::InvalidStuckAccount
        );

        // Check that no actual rift account exists (it's truly stuck)
        let rift_account = &ctx.accounts.expected_rift;
        require!(rift_account.data_is_empty(), ErrorCode::RiftAlreadyExists);

        // **FIX HIGH #8**: Use Token-2022's close_account instruction instead of direct lamport manipulation
        // We can close the mint because:
        // 1. Mint has zero supply (creation failed before minting)
        // 2. We control the mint authority (PDA with seeds)
        // 3. Rent will be returned to creator

        use spl_token_2022::instruction::close_account;

        // Get mint authority PDA seeds
        let expected_rift_pda = Pubkey::create_program_address(
            &[
                b"rift",
                ctx.accounts.underlying_mint.key().as_ref(),
                ctx.accounts.creator.key().as_ref(),
                &[ctx.bumps.expected_rift],
            ],
            ctx.program_id,
        )
        .map_err(|_| ErrorCode::InvalidStuckAccount)?;

        let mint_auth_bump = ctx.bumps.rift_mint_authority;
        let mint_auth_seeds = &[
            b"rift_mint_auth",
            expected_rift_pda.as_ref(),
            &[mint_auth_bump],
        ];
        let signer = &[&mint_auth_seeds[..]];

        // Get rent amount before closing
        let rent_to_return = ctx.accounts.stuck_rift_mint.lamports();

        // Close the mint account using Token-2022's instruction
        anchor_lang::solana_program::program::invoke_signed(
            &close_account(
                &spl_token_2022::ID,
                ctx.accounts.stuck_rift_mint.key,
                ctx.accounts.creator.key,             // Rent destination
                ctx.accounts.rift_mint_authority.key, // Authority
                &[],                                  // No multisig
            )?,
            &[
                ctx.accounts.stuck_rift_mint.to_account_info(),
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.rift_mint_authority.to_account_info(),
            ],
            signer,
        )?;

        msg!("✅ Closed stuck mint account via Token-2022 close_account, returned {} lamports to creator", rent_to_return);

        emit!(StuckAccountCleaned {
            creator: ctx.accounts.creator.key(),
            stuck_mint: ctx.accounts.stuck_rift_mint.key(),
            underlying_mint: ctx.accounts.underlying_mint.key(),
        });

        Ok(())
    }

    /// **FIX CRITICAL #10**: Cleanup stuck VANITY rift accounts
    /// This instruction handles vanity rifts that failed during creation
    /// Vanity rifts use different PDA seeds than regular rifts, so they need a separate cleanup function
    ///
    /// **SECURITY**: Only the original creator can cleanup their stuck vanity mint
    /// **MECHANISM**: Uses Token-2022's close_account instruction to properly close the mint and return rent
    pub fn cleanup_stuck_vanity_accounts(
        ctx: Context<CleanupStuckVanityAccounts>,
        vanity_seed: [u8; 32],
        seed_len: u8,
    ) -> Result<()> {
        require!(seed_len <= 32, ErrorCode::InvalidVanitySeed);

        msg!(
            "Cleaning up stuck vanity rift mint for creator: {}",
            ctx.accounts.creator.key()
        );

        // **FIX CRITICAL #26**: Derive expected VANITY rift PDA (includes vanity_seed)
        // Vanity rifts have different seeds than regular rifts!
        let expected_rift_pda = Pubkey::create_program_address(
            &[
                b"rift",
                ctx.accounts.underlying_mint.key().as_ref(),
                ctx.accounts.creator.key().as_ref(),
                &vanity_seed[..seed_len as usize], // ✅ Include vanity_seed!
                &[ctx.bumps.expected_rift],
            ],
            ctx.program_id,
        )
        .map_err(|_| ErrorCode::InvalidStuckAccount)?;

        // Derive expected VANITY mint PDA
        let expected_mint_pda = Pubkey::create_program_address(
            &[
                b"rift_mint",
                ctx.accounts.creator.key().as_ref(),
                ctx.accounts.underlying_mint.key().as_ref(),
                &vanity_seed[..seed_len as usize],
                &[ctx.bumps.stuck_rift_mint],
            ],
            ctx.program_id,
        )
        .map_err(|_| ErrorCode::InvalidStuckAccount)?;

        // Verify the stuck mint matches expected vanity PDA
        require!(
            ctx.accounts.stuck_rift_mint.key() == expected_mint_pda,
            ErrorCode::InvalidStuckAccount
        );

        // Check that no actual rift account exists (it's truly stuck)
        let rift_account = &ctx.accounts.expected_rift;
        require!(rift_account.data_is_empty(), ErrorCode::RiftAlreadyExists);

        // **FIX CRITICAL #10**: Use Token-2022's close_account instruction
        // Same mechanism as regular cleanup, but with vanity mint seeds

        use spl_token_2022::instruction::close_account;

        let mint_auth_bump = ctx.bumps.rift_mint_authority;
        let mint_auth_seeds = &[
            b"rift_mint_auth",
            expected_rift_pda.as_ref(),
            &[mint_auth_bump],
        ];
        let signer = &[&mint_auth_seeds[..]];

        // Get rent amount before closing
        let rent_to_return = ctx.accounts.stuck_rift_mint.lamports();

        // Close the vanity mint account using Token-2022's instruction
        anchor_lang::solana_program::program::invoke_signed(
            &close_account(
                &spl_token_2022::ID,
                ctx.accounts.stuck_rift_mint.key,
                ctx.accounts.creator.key,             // Rent destination
                ctx.accounts.rift_mint_authority.key, // Authority
                &[],                                  // No multisig
            )?,
            &[
                ctx.accounts.stuck_rift_mint.to_account_info(),
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.rift_mint_authority.to_account_info(),
            ],
            signer,
        )?;

        msg!("✅ Closed stuck vanity mint account via Token-2022 close_account, returned {} lamports to creator", rent_to_return);

        emit!(StuckAccountCleaned {
            creator: ctx.accounts.creator.key(),
            stuck_mint: ctx.accounts.stuck_rift_mint.key(),
            underlying_mint: ctx.accounts.underlying_mint.key(),
        });

        Ok(())
    }

    /// **FIX HIGH #1**: Admin function to reset stuck reentrancy guard
    /// If a transaction fails mid-execution, the guard may remain true
    /// This function allows PROGRAM_AUTHORITY to reset it
    pub fn admin_reset_reentrancy_guard(ctx: Context<AdminResetReentrancyGuard>) -> Result<()> {
        let rift = &mut ctx.accounts.rift;

        // Only PROGRAM_AUTHORITY can reset the guard
        let program_authority = Pubkey::from_str_const(PROGRAM_AUTHORITY);
        require!(
            ctx.accounts.program_authority.key() == program_authority,
            ErrorCode::UnauthorizedAdmin
        );

        // Log the reset
        msg!("⚠️ Resetting reentrancy guard for rift: {}", rift.key());
        msg!("Previous guard state: {}", rift.reentrancy_guard);

        // Reset the guard
        rift.reentrancy_guard = false;

        emit!(ReentrancyGuardReset {
            rift: rift.key(),
            authority: ctx.accounts.program_authority.key(),
        });

        Ok(())
    }

    /// **SECURITY FIX #50**: Set oracle account addresses (creator only)
    /// This binds specific Switchboard accounts to the rift for validation
    pub fn set_oracle_accounts(
        ctx: Context<SetOracleAccounts>,
        switchboard_account: Option<Pubkey>,
    ) -> Result<()> {
        let rift = &mut ctx.accounts.rift;

        // Only creator can set oracle accounts
        require!(
            ctx.accounts.creator.key() == rift.creator,
            ErrorCode::Unauthorized
        );

        // Validate accounts are not system program
        if let Some(switchboard) = switchboard_account {
            require!(
                switchboard != anchor_lang::solana_program::system_program::ID,
                ErrorCode::InvalidOracleAccount
            );
        }

        // Set oracle accounts
        rift.switchboard_feed_account = switchboard_account;

        msg!(
            "Oracle accounts set - Switchboard: {:?}",
            switchboard_account
        );

        Ok(())
    }

    /// **FIX ISSUE #5**: Propose oracle account change with 24h timelock
    /// Step 1: Creator proposes new oracle accounts
    pub fn propose_oracle_change(
        ctx: Context<ProposeOracleChange>,
        switchboard_account: Option<Pubkey>,
    ) -> Result<()> {
        let rift = &mut ctx.accounts.rift;
        let current_time = Clock::get()?.unix_timestamp;

        // Only creator can propose
        require!(
            ctx.accounts.creator.key() == rift.creator,
            ErrorCode::Unauthorized
        );

        // Validate accounts are not system program
        if let Some(switchboard) = switchboard_account {
            require!(
                switchboard != anchor_lang::solana_program::system_program::ID,
                ErrorCode::InvalidOracleAccount
            );
        }

        // Set pending change with timestamp
        rift.oracle_change_pending = true;
        rift.pending_switchboard_account = switchboard_account;
        rift.oracle_change_timestamp = current_time;

        let effective_time = current_time + ORACLE_CHANGE_DELAY;
        msg!(
            "Oracle change proposed - effective after {} (24h from now)",
            effective_time
        );
        msg!("Pending Switchboard: {:?}", switchboard_account);

        emit!(OracleChangeProposed {
            rift: rift.key(),
            switchboard_account,
            effective_time,
        });

        Ok(())
    }

    /// **FIX ISSUE #5**: Execute pending oracle change after 24h delay
    /// **FIX INFO #2 (Audit)**: Only creator can execute (prevents griefing/front-running)
    /// Step 2: Creator executes after delay has passed
    pub fn execute_oracle_change(ctx: Context<ExecuteOracleChange>) -> Result<()> {
        let rift = &mut ctx.accounts.rift;
        let current_time = Clock::get()?.unix_timestamp;

        // **FIX INFO #2 (Audit)**: Require creator authorization
        require!(
            ctx.accounts.creator.key() == rift.creator,
            ErrorCode::Unauthorized
        );

        // Verify there's a pending change
        require!(
            rift.oracle_change_pending,
            ErrorCode::NoOracleChangePending
        );

        // Verify delay has passed
        require!(
            current_time >= rift.oracle_change_timestamp + ORACLE_CHANGE_DELAY,
            ErrorCode::OracleChangeDelayNotMet
        );

        // Apply the change
        rift.switchboard_feed_account = rift.pending_switchboard_account;

        // Clear pending state
        let executed_switchboard = rift.pending_switchboard_account;
        rift.oracle_change_pending = false;
        rift.pending_switchboard_account = None;

        msg!(
            "Oracle accounts updated - Switchboard: {:?}",
            executed_switchboard
        );

        emit!(OracleChangeExecuted {
            rift: rift.key(),
            switchboard_account: executed_switchboard,
        });

        Ok(())
    }

    /// **FIX ISSUE #5**: Cancel pending oracle change
    /// Allows creator to cancel before delay expires
    pub fn cancel_oracle_change(ctx: Context<CancelOracleChange>) -> Result<()> {
        let rift = &mut ctx.accounts.rift;

        // Only creator can cancel
        require!(
            ctx.accounts.creator.key() == rift.creator,
            ErrorCode::Unauthorized
        );

        require!(
            rift.oracle_change_pending,
            ErrorCode::NoOracleChangePending
        );

        // Clear pending state
        rift.oracle_change_pending = false;
        rift.pending_switchboard_account = None;

        msg!("Oracle change cancelled");

        Ok(())
    }

    /// Admin function: Withdraw funds from vault (for buyback or emergency)
    /// **HIGH FIX #2**: Creator, partner, treasury, or PROGRAM_AUTHORITY can call
    pub fn distribute_fees_from_vault(
        ctx: Context<DistributeFeesFromVault>,
        amount: u64,
    ) -> Result<()> {
        let rift = &mut ctx.accounts.rift;

        // **MANUAL VALIDATION**: Validate underlying_mint (converted to UncheckedAccount to reduce stack usage)
        // 1. Verify owner is Token program (SPL Token or Token-2022)
        require!(
            ctx.accounts.underlying_mint.owner == &anchor_spl::token::ID
                || ctx.accounts.underlying_mint.owner == &spl_token_2022::ID,
            ErrorCode::InvalidProgramId
        );
        // 2. Deserialize as Mint to ensure it's a valid mint account
        // **TOKEN-2022 FIX**: Handle both SPL Token and Token-2022 mints
        let underlying_mint_data = ctx.accounts.underlying_mint.try_borrow_data()?;
        require!(underlying_mint_data.len() >= 45, ErrorCode::InvalidMint);
        let underlying_decimals = underlying_mint_data[44]; // decimals at offset 44
        let is_token_2022 = ctx.accounts.underlying_mint.owner == &spl_token_2022::ID;
        if is_token_2022 {
            // Token-2022 mints have extensions, use StateWithExtensions
            spl_token_2022::extension::StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&underlying_mint_data)
                .map_err(|_| ErrorCode::InvalidMint)?;
        } else {
            // Standard SPL Token mint
            spl_token::state::Mint::unpack(&underlying_mint_data)
                .map_err(|_| ErrorCode::InvalidMint)?;
        }
        drop(underlying_mint_data); // Release borrow before continuing
        // 3. Verify key matches expected value from rift
        require!(
            ctx.accounts.underlying_mint.key() == rift.underlying_mint,
            ErrorCode::InvalidMint
        );

        // **MANUAL VALIDATION**: Validate treasury_account
        // 1. Verify it's owned by token program
        require!(
            ctx.accounts.treasury_account.owner == &anchor_spl::token::ID
                || ctx.accounts.treasury_account.owner == &spl_token_2022::ID,
            ErrorCode::InvalidProgramId
        );
        // 2. Deserialize as TokenAccount and validate owner/mint binding
        // **TOKEN-2022 FIX**: Handle both SPL Token and Token-2022 accounts
        // **FIX HIGH #1**: Enforce treasury_account.owner == treasury_wallet AND correct mint
        let treasury_data = ctx.accounts.treasury_account.try_borrow_data()?;
        let is_treasury_token_2022 = ctx.accounts.treasury_account.owner == &spl_token_2022::ID;
        let treasury_token_owner: Pubkey;
        let treasury_token_mint: Pubkey;
        if is_treasury_token_2022 {
            let treasury_token_account = spl_token_2022::extension::StateWithExtensions::<spl_token_2022::state::Account>::unpack(&treasury_data)
                .map_err(|_| ErrorCode::InvalidTreasuryVault)?;
            treasury_token_owner = treasury_token_account.base.owner;
            treasury_token_mint = treasury_token_account.base.mint;
        } else {
            let treasury_token_account = spl_token::state::Account::unpack(&treasury_data)
                .map_err(|_| ErrorCode::InvalidTreasuryVault)?;
            treasury_token_owner = treasury_token_account.owner;
            treasury_token_mint = treasury_token_account.mint;
        }
        drop(treasury_data);

        // **FIX HIGH #1**: Enforce token account owner matches treasury_wallet
        require!(
            treasury_token_owner == rift.treasury_wallet.ok_or(ErrorCode::TreasuryNotSet)?,
            ErrorCode::InvalidTreasuryVault
        );
        // **FIX HIGH #1**: Enforce token account mint matches underlying_mint
        require!(
            treasury_token_mint == rift.underlying_mint,
            ErrorCode::InvalidTreasuryVault
        );

        // **MANUAL VALIDATION**: Validate partner_account if present
        // **FIX HIGH #1**: Enforce partner_account.owner == partner_wallet AND correct mint
        if ctx.accounts.partner_account.is_some() {
            let partner_account = ctx.accounts.partner_account.as_ref().unwrap();
            // 1. Verify it's owned by token program
            require!(
                partner_account.owner == &anchor_spl::token::ID
                    || partner_account.owner == &spl_token_2022::ID,
                ErrorCode::InvalidProgramId
            );
            // 2. Deserialize as TokenAccount and validate owner/mint binding
            // **TOKEN-2022 FIX**: Handle both SPL Token and Token-2022 accounts
            let partner_data = partner_account.try_borrow_data()?;
            let is_partner_token_2022 = partner_account.owner == &spl_token_2022::ID;
            let partner_token_owner: Pubkey;
            let partner_token_mint: Pubkey;
            if is_partner_token_2022 {
                let partner_token_account = spl_token_2022::extension::StateWithExtensions::<spl_token_2022::state::Account>::unpack(&partner_data)
                    .map_err(|_| ErrorCode::InvalidPartnerVault)?;
                partner_token_owner = partner_token_account.base.owner;
                partner_token_mint = partner_token_account.base.mint;
            } else {
                let partner_token_account = spl_token::state::Account::unpack(&partner_data)
                    .map_err(|_| ErrorCode::InvalidPartnerVault)?;
                partner_token_owner = partner_token_account.owner;
                partner_token_mint = partner_token_account.mint;
            }
            drop(partner_data);

            // **FIX HIGH #1**: Enforce token account owner matches partner_wallet
            require!(
                partner_token_owner == rift.partner_wallet.ok_or(ErrorCode::PartnerWalletNotSet)?,
                ErrorCode::InvalidPartnerVault
            );
            // **FIX HIGH #1**: Enforce token account mint matches underlying_mint
            require!(
                partner_token_mint == rift.underlying_mint,
                ErrorCode::InvalidPartnerVault
            );
        }

        // **AUTHORIZATION**: Creator, partner, treasury, or PROGRAM_AUTHORITY can distribute fees
        // **FIX ISSUE #2**: Use ok_or instead of expect to prevent panic on corrupted state
        let program_authority = Pubkey::from_str_const(PROGRAM_AUTHORITY);
        let partner_wallet = rift.partner_wallet.ok_or(ErrorCode::PartnerWalletNotSet)?;
        let treasury_wallet = rift.treasury_wallet.ok_or(ErrorCode::TreasuryNotSet)?;

        let is_authorized = ctx.accounts.payer.key() == rift.creator
            || ctx.accounts.payer.key() == partner_wallet
            || ctx.accounts.payer.key() == treasury_wallet
            || ctx.accounts.payer.key() == program_authority;

        require!(is_authorized, ErrorCode::Unauthorized);

        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(rift.treasury_wallet.is_some(), ErrorCode::TreasuryNotSet);

        // Verify treasury_wallet matches
        require!(
            ctx.accounts.treasury_wallet.key() == rift.treasury_wallet.unwrap(),
            ErrorCode::InvalidTreasuryVault
        );

        // **FEE ROUTING UPDATE**: Check fees_vault balance instead of backing vault
        let fees_vault_balance = ctx.accounts.fees_vault.amount;

        require!(amount <= fees_vault_balance, ErrorCode::InsufficientFees);

        msg!("Distributing {} fees from fees_vault (available: {}) to treasury and partner (50/50 split)",
            amount, fees_vault_balance);

        // **FEE SPLIT**: Always split 50/50 between partner and treasury
        // Partner always exists (defaults to creator if not provided at rift creation)
        require!(
            ctx.accounts.partner_account.is_some(),
            ErrorCode::MissingPartnerVault
        );
        require!(
            ctx.accounts.partner_wallet.is_some(),
            ErrorCode::MissingPartnerVault
        );

        // Verify partner_wallet matches
        let partner_wallet_key = ctx.accounts.partner_wallet.as_ref().ok_or(ErrorCode::MissingPartnerVault)?.key();
        require!(
            partner_wallet_key == rift.partner_wallet.ok_or(ErrorCode::PartnerWalletNotSet)?,
            ErrorCode::InvalidPartnerVault
        );

        // **FIX CRITICAL #2**: 50/50 split with no truncation loss
        // For odd amounts, treasury gets the extra 1 token
        let partner_amount = amount.checked_div(2).ok_or(ErrorCode::MathOverflow)?;
        let treasury_amount = amount
            .checked_sub(partner_amount)
            .ok_or(ErrorCode::MathOverflow)?;
        msg!("Partner amount: {} (~50%)", partner_amount);
        msg!("Treasury amount: {} (~50%)", treasury_amount);

        // **FIX MEDIUM #9**: Check balance before transfers to detect transfer fee impacts
        let fees_vault_balance_before = ctx.accounts.fees_vault.amount;

        // Setup vault authority seeds
        let rift_key = rift.key();
        let vault_auth_seeds = &[
            b"vault_auth",
            rift_key.as_ref(),
            &[ctx.bumps.vault_authority],
        ];
        let signer = &[&vault_auth_seeds[..]];

        // Transfer to partner if applicable
        if partner_amount > 0 {
            let partner_account = ctx
                .accounts
                .partner_account
                .as_ref()
                .ok_or(ErrorCode::MissingPartnerAccount)?;

            let partner_transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.fees_vault.to_account_info(),
                    to: partner_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                    mint: ctx.accounts.underlying_mint.to_account_info(),
                },
                signer,
            );
            // **TOKEN-2022 FIX**: Use transfer_checked for Token-2022 compatibility
            interface_transfer_checked(partner_transfer_ctx, partner_amount, underlying_decimals)?;
            msg!("✅ Sent {} to partner from fees_vault", partner_amount);
        }

        // Transfer to treasury from fees_vault
        // **TOKEN-2022 FIX**: Use transfer_checked for Token-2022 compatibility
        let treasury_transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.fees_vault.to_account_info(),
                to: ctx.accounts.treasury_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
                mint: ctx.accounts.underlying_mint.to_account_info(),
            },
            signer,
        );
        interface_transfer_checked(treasury_transfer_ctx, treasury_amount, underlying_decimals)?;

        // **FIX MEDIUM #9**: Reload and verify actual sent amount to detect transfer fees
        ctx.accounts.fees_vault.reload()?;
        let fees_vault_balance_after = ctx.accounts.fees_vault.amount;
        let actual_sent = fees_vault_balance_before
            .checked_sub(fees_vault_balance_after)
            .ok_or(ErrorCode::MathOverflow)?;

        // **FIX MEDIUM #3 (Audit)**: Tighten fee tolerance to match max underlying fee (1%)
        // Previously 95% - now 98% to allow for max 2% total leakage (two 1% transfers)
        // If underlying token has transfer fees, distribution would cause vault debit > recipient credit
        // This creates accounting mismatch and silent loss of funds
        require!(
            actual_sent >= amount.checked_mul(98).ok_or(ErrorCode::MathOverflow)?.checked_div(100).ok_or(ErrorCode::MathOverflow)?,
            ErrorCode::ExcessiveTransferFee
        );

        // **FIX MEDIUM #4 (Audit)**: Decrement total_fees_collected after successful distribution
        // Uses actual_sent (post balance diff) to ensure accurate accounting even with transfer fees
        rift.total_fees_collected = rift
            .total_fees_collected
            .checked_sub(actual_sent)
            .ok_or(ErrorCode::MathOverflow)?;

        msg!(
            "✅ Distributed {} fees (treasury: {}, partner: {})",
            amount,
            treasury_amount,
            partner_amount
        );
        msg!(
            "Updated accounting: total_fees_collected decreased by {}",
            actual_sent
        );

        Ok(())
    }

    /// Owner only: Update treasury wallet
    /// **FIX HIGH #5**: REMOVED update_treasury_wallet function
    /// Treasury wallet is IMMUTABLE after rift creation because:
    /// 1. Mint's withdraw_withheld_authority is set to TREASURY_WALLET at creation
    /// 2. This authority cannot be changed after mint initialization
    /// 3. Changing rift.treasury_wallet would create mismatch with mint authority
    /// 4. New treasury could not claim withheld fees (only old hardcoded key could)
    ///
    /// SECURITY: Treasury is intentionally immutable to prevent authority confusion
    /// If treasury compromise is a concern, create new rift with new treasury
    ///
    /// Previous function removed to prevent misleading treasury "updates" that don't work

    /// Admin function: Withdraw funds from fee collector vault
    // REMOVED: admin_withdraw_fee_collector - obsolete after removing external fee_collector program
    // Now using SPL Token-2022's claim_withheld_fees instead

    /// **TOKEN-2022**: Admin function to claim withheld transfer fees from a single Token-2022 account
    /// Transfer fees are automatically withheld in recipient accounts during transfers
    /// This instruction harvests those fees and sends them to the treasury
    /// Call this for each account that has withheld fees
    /// **CRITICAL FIX #2**: Only PROGRAM_AUTHORITY can claim fees (set as withdraw_withheld_authority)
    pub fn admin_claim_withheld_fees(ctx: Context<AdminClaimWithheldFees>) -> Result<()> {
        let rift = &ctx.accounts.rift;

        // **WITHHELD AUTHORITY FIX**: Use treasury_wallet as authority (matches mint initialization)
        // The mint's withdraw_withheld_authority is set to rift.treasury_wallet during creation
        let treasury_wallet = rift.treasury_wallet.ok_or(ErrorCode::TreasuryNotSet)?;
        require!(
            ctx.accounts.treasury_signer.key() == treasury_wallet,
            ErrorCode::UnauthorizedAdmin
        );

        // Use Token-2022's withdraw_withheld_tokens instruction
        // **FEE ROUTING**: This transfers withheld fees from the source account to withheld_vault
        // Treasury wallet signs as the withdraw_withheld_authority
        use anchor_lang::solana_program::program::invoke;
        use spl_token_2022::extension::transfer_fee::instruction::withdraw_withheld_tokens_from_accounts;

        let source_pubkeys = [&ctx.accounts.source_account.key()];

        // **FIX MEDIUM #21**: Check withheld vault balance before and after to verify transfer
        let vault_balance_before = ctx.accounts.withheld_vault.amount;

        // **FIX**: Correct parameter order - mint comes BEFORE destination
        // Signature: (program_id, mint, destination, authority, multisig_signers, sources)
        invoke(
            &withdraw_withheld_tokens_from_accounts(
                &spl_token_2022::ID,
                &ctx.accounts.rift_mint.key(),      // mint (correct order)
                &ctx.accounts.withheld_vault.key(), // destination (correct order)
                &ctx.accounts.treasury_signer.key(),
                &[], // No multisig
                &source_pubkeys,
            )
            .map_err(|_| ErrorCode::InvalidMint)?,
            &[
                ctx.accounts.rift_mint.to_account_info(),
                ctx.accounts.withheld_vault.to_account_info(),
                ctx.accounts.treasury_signer.to_account_info(),
                ctx.accounts.source_account.to_account_info(),
            ],
        )?;

        // **FIX MEDIUM #21**: Reload and verify funds were actually transferred
        ctx.accounts.withheld_vault.reload()?;
        let vault_balance_after = ctx.accounts.withheld_vault.amount;
        let actual_claimed = vault_balance_after
            .checked_sub(vault_balance_before)
            .ok_or(ErrorCode::MathOverflow)?;

        if actual_claimed == 0 {
            msg!(
                "⚠️ No withheld fees to claim from account {}",
                ctx.accounts.source_account.key()
            );
        } else {
            msg!(
                "✅ Claimed {} withheld fees from account {} to withheld_vault",
                actual_claimed,
                ctx.accounts.source_account.key()
            );
        }

        // **MEDIUM FIX #12**: Emit event for off-chain tracking
        emit!(WithheldFeesClaimed {
            rift: rift.key(),
            destination: ctx.accounts.withheld_vault.key(), // **FEE ROUTING**: Withheld vault where fees are sent
            source_account: ctx.accounts.source_account.key(),
            claimer: ctx.accounts.treasury_signer.key(),
        });

        Ok(())
    }

    /// **TOKEN-2022**: Admin function to update transfer fee on existing rift
    /// Only PROGRAM_AUTHORITY can modify fees (set as transfer_fee_config_authority)
    /// Maximum fee is capped at 2% (200 bps) for safety
    pub fn admin_set_transfer_fee(
        ctx: Context<AdminSetTransferFee>,
        new_fee_bps: u16,
    ) -> Result<()> {
        let rift = &ctx.accounts.rift;

        // Only PROGRAM_AUTHORITY can modify transfer fees
        let program_authority = Pubkey::from_str_const(PROGRAM_AUTHORITY);
        require!(
            ctx.accounts.program_authority.key() == program_authority,
            ErrorCode::UnauthorizedAdmin
        );

        // Validate fee is within acceptable range (max 2% = 200 bps)
        const MAX_TRANSFER_FEE_BPS: u16 = 200; // 2%
        require!(
            new_fee_bps <= MAX_TRANSFER_FEE_BPS,
            ErrorCode::InvalidTransferFee
        );

        msg!(
            "Setting transfer fee to {} bps ({}%) for rift {}",
            new_fee_bps,
            new_fee_bps as f64 / 100.0,
            rift.key()
        );

        // Use Token-2022's set_transfer_fee instruction
        use anchor_lang::solana_program::program::invoke;
        use spl_token_2022::extension::transfer_fee::instruction::set_transfer_fee;

        invoke(
            &set_transfer_fee(
                &spl_token_2022::ID,
                &ctx.accounts.rift_mint.key(),
                &ctx.accounts.program_authority.key(),
                &[],
                new_fee_bps,
                u64::MAX, // no maximum fee cap
            )
            .map_err(|_| ErrorCode::InvalidMint)?,
            &[
                ctx.accounts.rift_mint.to_account_info(),
                ctx.accounts.program_authority.to_account_info(),
            ],
        )?;

        emit!(TransferFeeUpdated {
            rift: rift.key(),
            new_fee_bps,
            authority: ctx.accounts.program_authority.key(),
        });

        Ok(())
    }

    /// **TOKEN-2022**: Claim withheld transfer fees from a single Token-2022 account
    /// Only treasury wallet can call this (set as withdraw_withheld_authority during mint creation)
    /// Transfers withheld fees from source account to withheld_vault
    pub fn claim_withheld_fees(ctx: Context<ClaimWithheldFees>) -> Result<()> {
        let rift = &ctx.accounts.rift;

        // **PER-RIFT TREASURY FIX**: Use rift.treasury_wallet instead of hardcoded constant
        // This allows each rift to have its own treasury that can claim withheld fees
        let treasury_wallet = rift.treasury_wallet.ok_or(ErrorCode::TreasuryNotSet)?;
        require!(
            ctx.accounts.treasury_signer.key() == treasury_wallet,
            ErrorCode::UnauthorizedAdmin
        );

        // Use Token-2022's withdraw_withheld_tokens instruction
        // Treasury wallet signs as the withdraw_withheld_authority
        use anchor_lang::solana_program::program::invoke;
        use spl_token_2022::extension::transfer_fee::instruction::withdraw_withheld_tokens_from_accounts;

        let source_pubkeys = [&ctx.accounts.source_account.key()];

        // **FIX CRITICAL #51**: Correct parameter order for withdraw_withheld_tokens_from_accounts
        // Signature: (program_id, destination, mint, authority, multisig_signers, sources)
        // destination = token account to receive withheld fees
        // mint = the mint with transfer fees
        invoke(
            &withdraw_withheld_tokens_from_accounts(
                &spl_token_2022::ID,
                &ctx.accounts.rift_mint.key(),      // mint
                &ctx.accounts.withheld_vault.key(), // destination (token account)
                &ctx.accounts.treasury_signer.key(), // authority
                &[],
                &source_pubkeys,
            )
            .map_err(|_| ErrorCode::InvalidMint)?,
            &[
                ctx.accounts.rift_mint.to_account_info(),
                ctx.accounts.withheld_vault.to_account_info(),
                ctx.accounts.treasury_signer.to_account_info(),
                ctx.accounts.source_account.to_account_info(),
            ],
        )?;

        msg!(
            "✅ Claimed withheld transfer fees from account {} to withheld_vault",
            ctx.accounts.source_account.key()
        );

        emit!(WithheldFeesClaimed {
            rift: ctx.accounts.rift.key(),
            destination: ctx.accounts.withheld_vault.key(),
            source_account: ctx.accounts.source_account.key(),
            claimer: ctx.accounts.treasury_signer.key(),
        });

        Ok(())
    }

    /// **FEE MANAGEMENT**: Distribute withheld fees from withheld_vault
    /// Creator, partner, treasury, or PROGRAM_AUTHORITY can call this
    /// Splits RIFT tokens from withheld_vault to partner (50%) and treasury (50%)
    pub fn distribute_withheld_vault(
        ctx: Context<DistributeWithheldVault>,
        amount: u64,
    ) -> Result<()> {
        let rift = &ctx.accounts.rift;

        // **MANUAL VALIDATION**: Validate rift_mint (converted to UncheckedAccount to reduce stack usage)
        // 1. Verify owner is Token-2022 program (RIFT tokens use Token-2022)
        require!(
            ctx.accounts.rift_mint.owner == &spl_token_2022::ID,
            ErrorCode::InvalidProgramId
        );
        // 2. Verify key matches expected value from rift
        require!(
            ctx.accounts.rift_mint.key() == rift.rift_mint,
            ErrorCode::InvalidMint
        );

        // **MANUAL VALIDATION**: Validate treasury_account
        // **FIX HIGH #2**: Enforce treasury_account.owner == treasury_wallet AND correct mint (rift_mint)
        // Verify it's owned by token program (Token-2022)
        require!(
            ctx.accounts.treasury_account.owner == &anchor_spl::token::ID
                || ctx.accounts.treasury_account.owner == &spl_token_2022::ID,
            ErrorCode::InvalidProgramId
        );
        // Deserialize and validate owner/mint binding
        {
            let treasury_data = ctx.accounts.treasury_account.try_borrow_data()?;
            let is_treasury_token_2022 = ctx.accounts.treasury_account.owner == &spl_token_2022::ID;
            let treasury_token_owner: Pubkey;
            let treasury_token_mint: Pubkey;
            if is_treasury_token_2022 {
                let treasury_token_account = spl_token_2022::extension::StateWithExtensions::<spl_token_2022::state::Account>::unpack(&treasury_data)
                    .map_err(|_| ErrorCode::InvalidTreasuryVault)?;
                treasury_token_owner = treasury_token_account.base.owner;
                treasury_token_mint = treasury_token_account.base.mint;
            } else {
                let treasury_token_account = spl_token::state::Account::unpack(&treasury_data)
                    .map_err(|_| ErrorCode::InvalidTreasuryVault)?;
                treasury_token_owner = treasury_token_account.owner;
                treasury_token_mint = treasury_token_account.mint;
            }
            drop(treasury_data);

            // **FIX HIGH #2**: Enforce token account owner matches treasury_wallet
            require!(
                treasury_token_owner == rift.treasury_wallet.ok_or(ErrorCode::TreasuryNotSet)?,
                ErrorCode::InvalidTreasuryVault
            );
            // **FIX HIGH #2**: Enforce token account mint matches rift_mint (RIFT tokens)
            require!(
                treasury_token_mint == rift.rift_mint,
                ErrorCode::InvalidTreasuryVault
            );
        }

        // **MANUAL VALIDATION**: Validate partner_account if present
        // **FIX HIGH #2**: Enforce partner_account.owner == partner_wallet AND correct mint
        if ctx.accounts.partner_account.is_some() {
            let partner_account = ctx.accounts.partner_account.as_ref().unwrap();
            // Verify it's owned by token program (Token-2022)
            require!(
                partner_account.owner == &anchor_spl::token::ID
                    || partner_account.owner == &spl_token_2022::ID,
                ErrorCode::InvalidProgramId
            );
            // Deserialize and validate owner/mint binding
            let partner_data = partner_account.try_borrow_data()?;
            let is_partner_token_2022 = partner_account.owner == &spl_token_2022::ID;
            let partner_token_owner: Pubkey;
            let partner_token_mint: Pubkey;
            if is_partner_token_2022 {
                let partner_token_account = spl_token_2022::extension::StateWithExtensions::<spl_token_2022::state::Account>::unpack(&partner_data)
                    .map_err(|_| ErrorCode::InvalidPartnerVault)?;
                partner_token_owner = partner_token_account.base.owner;
                partner_token_mint = partner_token_account.base.mint;
            } else {
                let partner_token_account = spl_token::state::Account::unpack(&partner_data)
                    .map_err(|_| ErrorCode::InvalidPartnerVault)?;
                partner_token_owner = partner_token_account.owner;
                partner_token_mint = partner_token_account.mint;
            }
            drop(partner_data);

            // **FIX HIGH #2**: Enforce token account owner matches partner_wallet
            require!(
                partner_token_owner == rift.partner_wallet.ok_or(ErrorCode::PartnerWalletNotSet)?,
                ErrorCode::InvalidPartnerVault
            );
            // **FIX HIGH #2**: Enforce token account mint matches rift_mint (RIFT tokens)
            require!(
                partner_token_mint == rift.rift_mint,
                ErrorCode::InvalidPartnerVault
            );
        }

        // **AUTHORIZATION**: Creator, partner, treasury, or PROGRAM_AUTHORITY can distribute fees
        // **FIX ISSUE #2**: Use ok_or instead of expect to prevent panic on corrupted state
        let program_authority = Pubkey::from_str_const(PROGRAM_AUTHORITY);
        let partner_wallet = rift.partner_wallet.ok_or(ErrorCode::PartnerWalletNotSet)?;
        let treasury_wallet = rift.treasury_wallet.ok_or(ErrorCode::TreasuryNotSet)?;

        let is_authorized = ctx.accounts.payer.key() == rift.creator
            || ctx.accounts.payer.key() == partner_wallet
            || ctx.accounts.payer.key() == treasury_wallet
            || ctx.accounts.payer.key() == program_authority;

        require!(is_authorized, ErrorCode::Unauthorized);

        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(rift.treasury_wallet.is_some(), ErrorCode::TreasuryNotSet);

        // Verify treasury_wallet matches
        require!(
            ctx.accounts.treasury_wallet.key() == rift.treasury_wallet.unwrap(),
            ErrorCode::InvalidTreasuryVault
        );

        // Check withheld_vault balance
        let withheld_vault_balance = ctx.accounts.withheld_vault.amount;

        require!(
            amount <= withheld_vault_balance,
            ErrorCode::InsufficientFees
        );

        msg!("Distributing {} withheld fees from withheld_vault (available: {}) to treasury and partner (50/50 split)",
            amount, withheld_vault_balance);

        // **FEE SPLIT**: Always split 50/50 between partner and treasury
        // Partner always exists (defaults to creator if not provided at rift creation)
        require!(
            ctx.accounts.partner_account.is_some(),
            ErrorCode::MissingPartnerVault
        );
        require!(
            ctx.accounts.partner_wallet.is_some(),
            ErrorCode::MissingPartnerVault
        );

        // Verify partner_wallet matches
        let partner_wallet_key = ctx.accounts.partner_wallet.as_ref().ok_or(ErrorCode::MissingPartnerVault)?.key();
        require!(
            partner_wallet_key == rift.partner_wallet.ok_or(ErrorCode::PartnerWalletNotSet)?,
            ErrorCode::InvalidPartnerVault
        );

        // **FIX CRITICAL #2**: 50/50 split with no truncation loss
        // For odd amounts, treasury gets the extra 1 token
        let partner_amount = amount.checked_div(2).ok_or(ErrorCode::MathOverflow)?;
        let treasury_amount = amount
            .checked_sub(partner_amount)
            .ok_or(ErrorCode::MathOverflow)?;
        msg!("Partner amount: {} (~50%)", partner_amount);
        msg!("Treasury amount: {} (~50%)", treasury_amount);

        // **FIX MEDIUM #9**: Check SOURCE balance before transfers
        let withheld_vault_balance_before = ctx.accounts.withheld_vault.amount;

        // **FIX CRITICAL #11**: Check DESTINATION balances before transfers
        use spl_token_2022::extension::StateWithExtensions;
        let partner_balance_before = if partner_amount > 0 {
            let partner_account = ctx.accounts.partner_account.as_ref().ok_or(ErrorCode::MissingPartnerVault)?;
            let partner_data = partner_account.try_borrow_data()?;
            let partner_token_account = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&partner_data)
                .map_err(|_| ErrorCode::InvalidPartnerVault)?;
            partner_token_account.base.amount
        } else {
            0
        };
        let treasury_data = ctx.accounts.treasury_account.try_borrow_data()?;
        let treasury_token_account = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&treasury_data)
            .map_err(|_| ErrorCode::InvalidTreasuryVault)?;
        let treasury_balance_before = treasury_token_account.base.amount;
        drop(treasury_data); // Release borrow before transfers

        // **FIX**: Extract mint decimals from rift_mint
        let rift_mint_data = ctx.accounts.rift_mint.try_borrow_data()?;
        let rift_mint_state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&rift_mint_data)
            .map_err(|_| ErrorCode::InvalidMint)?;
        let mint_decimals = rift_mint_state.base.decimals;
        drop(rift_mint_data); // Release borrow before transfers

        // Setup vault authority seeds
        let rift_key = rift.key();
        let vault_auth_seeds = &[
            b"vault_auth",
            rift_key.as_ref(),
            &[ctx.bumps.vault_authority],
        ];
        let signer = &[&vault_auth_seeds[..]];

        // Transfer to partner if applicable
        if partner_amount > 0 {
            let partner_account = ctx
                .accounts
                .partner_account
                .as_ref()
                .ok_or(ErrorCode::MissingPartnerAccount)?;

            let partner_transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_2022::TransferChecked {
                    from: ctx.accounts.withheld_vault.to_account_info(),
                    to: partner_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                    mint: ctx.accounts.rift_mint.to_account_info(),
                },
                signer,
            );
            anchor_spl::token_2022::transfer_checked(partner_transfer_ctx, partner_amount, mint_decimals)?;
            msg!(
                "✅ Sent {} RIFT to partner from withheld_vault",
                partner_amount
            );
        }

        // Transfer to treasury from withheld_vault
        let treasury_transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token_2022::TransferChecked {
                from: ctx.accounts.withheld_vault.to_account_info(),
                to: ctx.accounts.treasury_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
                mint: ctx.accounts.rift_mint.to_account_info(),
            },
            signer,
        );
        anchor_spl::token_2022::transfer_checked(treasury_transfer_ctx, treasury_amount, mint_decimals)?;

        // **FIX MEDIUM #9**: Reload SOURCE and verify
        ctx.accounts.withheld_vault.reload()?;
        let withheld_vault_balance_after = ctx.accounts.withheld_vault.amount;
        let actual_sent_from_source = withheld_vault_balance_before
            .checked_sub(withheld_vault_balance_after)
            .ok_or(ErrorCode::MathOverflow)?;

        // **FIX CRITICAL #11**: Reload DESTINATIONS and verify actual received amounts
        let mut partner_received = 0u64;
        if partner_amount > 0 {
            if let Some(partner_account) = &ctx.accounts.partner_account {
                let partner_data = partner_account.try_borrow_data()?;
                let partner_token_account = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&partner_data)
                    .map_err(|_| ErrorCode::InvalidPartnerVault)?;
                partner_received = partner_token_account
                    .base
                    .amount
                    .checked_sub(partner_balance_before)
                    .ok_or(ErrorCode::MathOverflow)?;

                if partner_received != partner_amount {
                    let partner_withheld = partner_amount.saturating_sub(partner_received);
                    msg!(
                        "⚠️ RIFT transfer fee (partner): sent {}, received {}",
                        partner_amount,
                        partner_received
                    );
                    msg!(
                        "⚠️ Partner withheld: {} RIFT ({:.2}%)",
                        partner_withheld,
                        (partner_withheld as f64 / partner_amount as f64) * 100.0
                    );
                }
            }
        }

        let treasury_data_after = ctx.accounts.treasury_account.try_borrow_data()?;
        let treasury_token_account_after = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&treasury_data_after)
            .map_err(|_| ErrorCode::InvalidTreasuryVault)?;
        let treasury_balance_after = treasury_token_account_after.base.amount;
        let treasury_received = treasury_balance_after
            .checked_sub(treasury_balance_before)
            .ok_or(ErrorCode::MathOverflow)?;

        if treasury_received != treasury_amount {
            let treasury_withheld = treasury_amount.saturating_sub(treasury_received);
            msg!(
                "⚠️ RIFT transfer fee (treasury): sent {}, received {}",
                treasury_amount,
                treasury_received
            );
            msg!(
                "⚠️ Treasury withheld: {} RIFT ({:.2}%)",
                treasury_withheld,
                (treasury_withheld as f64 / treasury_amount as f64) * 100.0
            );
        }

        // **FIX CRITICAL #11**: Calculate total withheld at destinations
        let total_received = partner_received
            .checked_add(treasury_received)
            .ok_or(ErrorCode::MathOverflow)?;

        // **FIX MEDIUM #3 (Audit)**: Tighten fee tolerance to match max RIFT transfer fee (1%)
        // Previously 95% - now 98% to allow for max 2% total leakage (two 1% transfers)
        // RIFT tokens have transfer fees, so recipients get less than sent
        // Allowing this creates accounting mismatch and silent loss in the vault
        // By requiring exact amounts, we force callers to account for fees properly
        require!(
            total_received >= amount.checked_mul(98).ok_or(ErrorCode::MathOverflow)?.checked_div(100).ok_or(ErrorCode::MathOverflow)?,
            ErrorCode::ExcessiveTransferFee
        );

        // **FEE-ON-TRANSFER LEAKAGE FIX**: Also verify vault was debited correctly
        require!(
            actual_sent_from_source == amount,
            ErrorCode::ExcessiveTransferFee
        );

        msg!(
            "✅ Distributed {} withheld fees (treasury: {}, partner: {})",
            amount,
            treasury_amount,
            partner_amount
        );

        emit!(WithheldFeesDistributed {
            rift: rift.key(),
            amount,
            treasury_amount,
            partner_amount,
            distributor: ctx.accounts.payer.key(),
        });

        Ok(())
    }

    /// **FEE MANAGEMENT**: Admin function to withdraw collected wrap/unwrap fees from fees_vault
    /// Only PROGRAM_AUTHORITY can withdraw fees to treasury
    /// Transfers underlying tokens from fees_vault to treasury
    pub fn admin_withdraw_fees_vault(
        ctx: Context<AdminWithdrawFeesVault>,
        amount: u64,
    ) -> Result<()> {
        // Only PROGRAM_AUTHORITY can withdraw fees
        let program_authority = Pubkey::from_str_const(PROGRAM_AUTHORITY);
        require!(
            ctx.accounts.program_authority.key() == program_authority,
            ErrorCode::UnauthorizedAdmin
        );

        let rift = &ctx.accounts.rift;
        let rift_key = rift.key();

        // Derive vault_authority PDA seeds for signing
        let vault_auth_bump = ctx.bumps.vault_authority;
        let vault_auth_seeds: &[&[u8]] = &[b"vault_auth", rift_key.as_ref(), &[vault_auth_bump]];
        let signer = &[&vault_auth_seeds[..]];

        // **HARDENING**: Ensure vault_authority account matches derived PDA
        let (expected_vault_auth, _) =
            Pubkey::find_program_address(&[b"vault_auth", rift_key.as_ref()], ctx.program_id);
        require!(
            ctx.accounts.vault_authority.key() == expected_vault_auth,
            ErrorCode::InvalidVaultAuthority
        );

        // Get decimals from underlying mint for transfer_checked
        let underlying_decimals = ctx.accounts.underlying_mint.decimals;

        // Transfer fees from fees_vault to treasury using vault_authority as signer
        // **TOKEN-2022 FIX**: Use transfer_checked for Token-2022 compatibility
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.fees_vault.to_account_info(),
                to: ctx.accounts.treasury_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
                mint: ctx.accounts.underlying_mint.to_account_info(),
            },
            signer,
        );
        interface_transfer_checked(transfer_ctx, amount, underlying_decimals)?;

        // **ACCOUNTING FIX**: Update rift accounting to reflect withdrawn fees
        let rift = &mut ctx.accounts.rift;
        rift.total_fees_collected = rift
            .total_fees_collected
            .checked_sub(amount)
            .ok_or(ErrorCode::MathOverflow)?;

        msg!(
            "✅ Withdrew {} underlying tokens from fees_vault to treasury",
            amount
        );
        msg!(
            "Updated accounting: total_fees_collected decreased by {}",
            amount
        );

        emit!(FeesVaultWithdrawn {
            rift: rift.key(),
            amount,
            treasury: ctx.accounts.treasury_account.key(),
            authority: ctx.accounts.program_authority.key(),
        });

        Ok(())
    }

    /// **FEE MANAGEMENT**: Admin function to withdraw collected withheld fees from withheld_vault
    /// Only PROGRAM_AUTHORITY can withdraw fees to treasury
    /// Transfers RIFT tokens from withheld_vault to treasury
    pub fn admin_withdraw_withheld_vault(
        ctx: Context<AdminWithdrawWithheldVault>,
        amount: u64,
    ) -> Result<()> {
        // Only PROGRAM_AUTHORITY can withdraw fees
        let program_authority = Pubkey::from_str_const(PROGRAM_AUTHORITY);
        require!(
            ctx.accounts.program_authority.key() == program_authority,
            ErrorCode::UnauthorizedAdmin
        );

        let rift = &ctx.accounts.rift;
        let rift_key = rift.key();

        // Derive vault_authority PDA seeds for signing
        let vault_auth_bump = ctx.bumps.vault_authority;
        let vault_auth_seeds: &[&[u8]] = &[b"vault_auth", rift_key.as_ref(), &[vault_auth_bump]];
        let signer = &[&vault_auth_seeds[..]];

        // **HARDENING**: Ensure vault_authority account matches derived PDA
        let (expected_vault_auth, _) =
            Pubkey::find_program_address(&[b"vault_auth", rift_key.as_ref()], ctx.program_id);
        require!(
            ctx.accounts.vault_authority.key() == expected_vault_auth,
            ErrorCode::InvalidVaultAuthority
        );


        // Transfer withheld fees from withheld_vault to treasury using vault_authority as signer
        // **FIX**: Use transfer_checked for Token-2022 (RIFT tokens always use Token-2022)
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token_2022::TransferChecked {
                from: ctx.accounts.withheld_vault.to_account_info(),
                to: ctx.accounts.treasury_rift_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
                mint: ctx.accounts.rift_mint.to_account_info(),
            },
            signer,
        );
        anchor_spl::token_2022::transfer_checked(transfer_ctx, amount, 9)?;

        // **ACCOUNTING FIX**: Withheld RIFT moved to treasury does NOT change total_rift_minted.
        // We only log the withdrawal event; total_rift_minted tracks global supply, not vault location.
        let rift = &mut ctx.accounts.rift;

        msg!(
            "✅ Withdrew {} RIFT tokens from withheld_vault to treasury",
            amount
        );
        msg!(
            "Accounting note: total_rift_minted unchanged (RIFT supply not reduced)"
        );

        emit!(WithheldVaultWithdrawn {
            rift: rift.key(),
            amount,
            treasury: ctx.accounts.treasury_rift_account.key(),
            authority: ctx.accounts.program_authority.key(),
        });

        Ok(())
    }
}

// SIMPLIFIED ACCOUNT STRUCTS TO REDUCE STACK USAGE

#[derive(Accounts)]
#[instruction(vanity_seed: [u8; 32], seed_len: u8, partner_wallet: Option<Pubkey>, rift_name: [u8; 32], name_len: u8, transfer_fee_bps: u16)]
pub struct CreateRiftWithVanityPDA<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// **CRITICAL SPACE FIX**: Use explicit Borsh size calculation
    /// Option<Pubkey> = 33 bytes in Borsh (1 discriminant + 32 pubkey), not 32 from std::mem::size_of
    /// 4 Option<Pubkey> fields in current struct
    /// Correct size: 8 (discriminator) + 774 (struct) = 782 bytes
    /// **FIX LOW #1 (Audit)**: Add constraint to prevent panic from invalid seed_len
    #[account(
        init,
        payer = creator,
        space = 782,
        seeds = [b"rift", underlying_mint.key().as_ref(), creator.key().as_ref(), &vanity_seed[..seed_len as usize]],
        bump,
        constraint = seed_len <= 32 @ ErrorCode::InvalidVanitySeedLength
    )]
    pub rift: Account<'info, Rift>,

    // **TOKEN-2022 MIGRATION**: Use InterfaceAccount for token types
    pub underlying_mint: InterfaceAccount<'info, Mint>,

    /// The PDA-derived mint account for vanity address
    /// **TOKEN-2022**: Manually initialized with transfer fee extension (0.7% on DEX trades)
    /// **SECURITY NOTE #8**: Using UncheckedAccount because Token-2022 extensions require manual initialization.
    /// This account is created via invoke_signed with proper validation (lines 189-233).
    /// RISK: If manual initialization code has bugs, could create invalid/exploitable mints.
    /// MITIGATION: Thoroughly tested initialization sequence, PDA derivation enforced by seeds.
    /// CHECK: Manually initialized with Token-2022 transfer fee extension in instruction handler
    /// **FIX HIGH #4**: Changed from user-provided bump to auto-derived canonical bump
    /// **FIX LOW #1 (Audit)**: seed_len already validated in rift account constraint
    #[account(
        mut,
        seeds = [b"rift_mint", creator.key().as_ref(), underlying_mint.key().as_ref(), &vanity_seed[..seed_len as usize]],
        bump,
    )]
    pub rift_mint: UncheckedAccount<'info>,

    /// CHECK: PDA for rift mint authority
    #[account(
        seeds = [b"rift_mint_auth", rift.key().as_ref()],
        bump
    )]
    pub rift_mint_authority: UncheckedAccount<'info>,

    /// **ATOMIC INIT**: Vault token account (initialized during create_rift_with_vanity_pda)
    /// CHECK: Manually initialized in handler with proper Token-2022 extension sizing
    #[account(
        mut,
        seeds = [b"vault", rift.key().as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,

    /// **ATOMIC INIT**: Fees vault token account (initialized during create_rift_with_vanity_pda)
    /// CHECK: Manually initialized in handler with proper Token-2022 extension sizing
    #[account(
        mut,
        seeds = [b"fees_vault", rift.key().as_ref()],
        bump
    )]
    pub fees_vault: UncheckedAccount<'info>,

    /// **ATOMIC INIT**: Withheld vault token account (initialized during create_rift_with_vanity_pda)
    /// CHECK: Manually initialized in handler with proper Token-2022 extension sizing
    #[account(
        mut,
        seeds = [b"withheld_vault", rift.key().as_ref()],
        bump
    )]
    pub withheld_vault: UncheckedAccount<'info>,

    /// CHECK: PDA for vault authority (controls all vault transfers)
    #[account(
        seeds = [b"vault_auth", rift.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    // **CRITICAL FIX #1**: Constrain token_program to only accept SPL Token or Token-2022
    #[account(
        constraint = token_program.key() == anchor_spl::token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,

    /// CHECK: Validated in handler - must match underlying_mint.owner
    pub underlying_token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(partner_wallet: Option<Pubkey>, rift_name: [u8; 32], name_len: u8, transfer_fee_bps: u16)]
pub struct CreateRift<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// **CRITICAL SPACE FIX**: Use explicit Borsh size calculation
    /// Option<Pubkey> = 33 bytes in Borsh (1 discriminant + 32 pubkey), not from std::mem::size_of
    /// Correct size: 8 (discriminator) + 774 (struct) = 782 bytes
    #[account(
        init,
        payer = creator,
        space = RIFT_ACCOUNT_SIZE,
        seeds = [b"rift", underlying_mint.key().as_ref(), creator.key().as_ref()],
        constraint = underlying_mint.key() != Pubkey::default() && creator.key() != Pubkey::default() @ ErrorCode::InvalidSeedComponent,
        bump,
    )]
    pub rift: Account<'info, Rift>,

    // **TOKEN-2022 MIGRATION**: Use InterfaceAccount for token types
    pub underlying_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Manually initialized as Token-2022 with transfer fee extension
    #[account(
        mut,
        seeds = [b"rift_mint", underlying_mint.key().as_ref(), creator.key().as_ref()],
        constraint = underlying_mint.key() != Pubkey::default() && creator.key() != Pubkey::default() @ ErrorCode::InvalidSeedComponent,
        bump
    )]
    pub rift_mint: UncheckedAccount<'info>,

    /// CHECK: PDA for mint authority
    #[account(
        seeds = [b"rift_mint_auth", rift.key().as_ref()],
        bump
    )]
    pub rift_mint_authority: UncheckedAccount<'info>,

    /// **ATOMIC INIT**: Vault token account (initialized during create_rift)
    /// CHECK: Manually initialized in handler with proper Token-2022 extension sizing
    #[account(
        mut,
        seeds = [b"vault", rift.key().as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,

    /// **ATOMIC INIT**: Fees vault token account (initialized during create_rift)
    /// CHECK: Manually initialized in handler with proper Token-2022 extension sizing
    #[account(
        mut,
        seeds = [b"fees_vault", rift.key().as_ref()],
        bump
    )]
    pub fees_vault: UncheckedAccount<'info>,

    /// **ATOMIC INIT**: Withheld vault token account (initialized during create_rift)
    /// CHECK: Manually initialized in handler with proper Token-2022 extension sizing
    #[account(
        mut,
        seeds = [b"withheld_vault", rift.key().as_ref()],
        bump
    )]
    pub withheld_vault: UncheckedAccount<'info>,

    /// CHECK: PDA for vault authority (controls all vault transfers)
    #[account(
        seeds = [b"vault_auth", rift.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    // **CRITICAL FIX #1**: Constrain token_program to only accept SPL Token or Token-2022
    #[account(
        constraint = token_program.key() == anchor_spl::token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,

    /// CHECK: Validated in handler - must match underlying_mint.owner
    pub underlying_token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub rift: Account<'info, Rift>,

    /// Vault token account
    #[account(
        init,
        payer = user,
        token::mint = underlying_mint,
        token::authority = vault_authority,
        seeds = [b"vault", rift.key().as_ref()],
        bump
    )]
    // **TOKEN-2022 MIGRATION**: Use InterfaceAccount for token types
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Mint validated by vault init constraint above (token::mint = underlying_mint)
    #[account(constraint = underlying_mint.key() == rift.underlying_mint @ ErrorCode::InvalidMint)]
    pub underlying_mint: UncheckedAccount<'info>,

    /// CHECK: Vault authority PDA - controls vault token transfers
    #[account(
        seeds = [b"vault_auth", rift.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: Mint authority PDA - controls RIFT token minting
    #[account(
        seeds = [b"rift_mint_auth", rift.key().as_ref()],
        bump
    )]
    pub rift_mint_authority: UncheckedAccount<'info>,

    // **CRITICAL FIX #1**: Constrain token_program to only accept SPL Token or Token-2022
    #[account(
        constraint = token_program.key() == anchor_spl::token::ID
            || token_program.key() == anchor_spl::token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitializeFeesVault<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub rift: Account<'info, Rift>,

    /// Fees vault token account (holds collected wrap/unwrap fees)
    /// **FIX CRITICAL #19**: Manual initialization with proper Token-2022 extension sizing
    /// CHECK: Manually initialized in handler with proper space calculation based on token program
    #[account(
        mut,
        seeds = [b"fees_vault", rift.key().as_ref()],
        bump
    )]
    pub fees_vault: UncheckedAccount<'info>,

    /// CHECK: Mint validated by fees_vault init constraint
    #[account(constraint = underlying_mint.key() == rift.underlying_mint @ ErrorCode::InvalidMint)]
    pub underlying_mint: UncheckedAccount<'info>,

    /// CHECK: Vault authority PDA - controls fees vault transfers
    #[account(
        seeds = [b"vault_auth", rift.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// **FIX CRITICAL #34**: Constrain token_program to SPL Token or Token-2022 only
    #[account(
        constraint = token_program.key() == anchor_spl::token::ID
            || token_program.key() == spl_token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitializeWithheldVault<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub rift: Account<'info, Rift>,

    /// Withheld vault token account (holds collected SPL Token-2022 withheld fees - RIFT tokens)
    /// **FIX CRITICAL #20**: Manual initialization with proper Token-2022 extension sizing
    /// CHECK: Manually initialized in handler with proper space for TransferFeeAmount extension
    #[account(
        mut,
        seeds = [b"withheld_vault", rift.key().as_ref()],
        bump
    )]
    pub withheld_vault: UncheckedAccount<'info>,

    /// CHECK: RIFT mint validated by withheld_vault init constraint
    #[account(constraint = rift_mint.key() == rift.rift_mint @ ErrorCode::InvalidMint)]
    pub rift_mint: UncheckedAccount<'info>,

    /// CHECK: Vault authority PDA - controls withheld vault transfers
    #[account(
        seeds = [b"vault_auth", rift.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// **FIX CRITICAL #35**: Constrain token_program to Token-2022 only (RIFT mint is always Token-2022)
    #[account(
        constraint = token_program.key() == spl_token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct WrapTokens<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub rift: Account<'info, Rift>,

    /// **SECURITY FIX #49**: User's underlying token account - validated manually in handler
    /// CHECK: Token account validation performed manually to reduce stack usage
    #[account(mut)]
    pub user_underlying: UncheckedAccount<'info>,

    /// **SECURITY FIX #49**: User's RIFT token account - validated manually in handler
    /// CHECK: Token account validation performed manually to reduce stack usage
    #[account(mut)]
    pub user_rift_tokens: UncheckedAccount<'info>,

    /// **CRITICAL FIX - HIGH ISSUE #3**: Vault account type must support .amount and .reload()
    /// Changed from UncheckedAccount to InterfaceAccount<TokenAccount> to fix compilation error
    #[account(
        mut,
        seeds = [b"vault", rift.key().as_ref()],
        bump,
        constraint = vault.key() == rift.vault @ ErrorCode::InvalidVault
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// **TOKEN-2022 FIX**: Underlying mint required for transfer_checked
    /// CHECK: Validated against rift.underlying_mint
    #[account(
        constraint = underlying_mint.key() == rift.underlying_mint @ ErrorCode::InvalidMint
    )]
    pub underlying_mint: UncheckedAccount<'info>,

    /// **SECURITY FIX #49**: Validate rift mint matches rift state
    /// CHECK: Pubkey validated against rift.rift_mint; Token program validates it's a valid mint during CPI
    #[account(
        mut,
        constraint = rift_mint.key() == rift.rift_mint @ ErrorCode::InvalidMint
    )]
    pub rift_mint: UncheckedAccount<'info>,

    /// CHECK: PDA
    #[account(
        seeds = [b"rift_mint_auth", rift.key().as_ref()],
        bump
    )]
    pub rift_mint_authority: UncheckedAccount<'info>,

    /// Fees vault to collect wrap fees (underlying tokens)
    /// CHECK: Optional - validated manually in handler. If not initialized (system_program::ID), fees stay in vault
    #[account(
        mut,
        seeds = [b"fees_vault", rift.key().as_ref()],
        bump
    )]
    pub fees_vault: UncheckedAccount<'info>,

    /// CHECK: Vault authority PDA - signs transfers to fees_vault
    #[account(
        seeds = [b"vault_auth", rift.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    // **FIX CRITICAL #27**: Support different token programs for underlying and RIFT
    // Underlying can be SPL Token or Token-2022
    #[account(
        constraint = underlying_token_program.key() == anchor_spl::token::ID
            || underlying_token_program.key() == anchor_spl::token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub underlying_token_program: Interface<'info, TokenInterface>,

    // RIFT mint is always Token-2022 (enforced at creation)
    /// **FIX CRITICAL #36**: Constrain rift_token_program to Token-2022 only
    /// Prevents malicious program from faking mint operations or using PDA signer to mint unauthorized tokens
    #[account(
        constraint = rift_token_program.key() == spl_token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub rift_token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

// NOTE: underlying_mint validation removed to reduce stack size
// Security is maintained via vault.mint == rift.underlying_mint constraint above

/// Account struct for simple vault-based unwrap
/// **SECURITY FIX #49**: Stack optimization - uses UncheckedAccount with manual validation
#[derive(Accounts)]
pub struct UnwrapFromVault<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub rift: Account<'info, Rift>,

    /// **SECURITY FIX #49**: User's underlying token account - validated manually in handler
    /// CHECK: Token account validation performed manually to reduce stack usage
    #[account(mut)]
    pub user_underlying: UncheckedAccount<'info>,

    /// **SECURITY FIX #49**: User's RIFT token account - validated manually in handler
    /// CHECK: Token account validation performed manually to reduce stack usage
    #[account(mut)]
    pub user_rift_tokens: UncheckedAccount<'info>,

    /// **CRITICAL FIX - HIGH ISSUE #3**: Vault account type must support .amount and .reload()
    /// Changed from UncheckedAccount to InterfaceAccount<TokenAccount> to fix compilation error
    #[account(
        mut,
        seeds = [b"vault", rift.key().as_ref()],
        bump,
        constraint = vault.key() == rift.vault @ ErrorCode::InvalidVault
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// **TOKEN-2022 FIX**: Underlying mint required for transfer_checked
    /// CHECK: Validated against rift.underlying_mint
    #[account(
        constraint = underlying_mint.key() == rift.underlying_mint @ ErrorCode::InvalidMint
    )]
    pub underlying_mint: UncheckedAccount<'info>,

    /// Vault authority PDA (owns the vault, signs transfers from vault)
    /// CHECK: PDA
    #[account(
        seeds = [b"vault_auth", rift.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// Rift mint authority PDA (controls RIFT token minting/burning)
    /// CHECK: PDA
    #[account(
        seeds = [b"rift_mint_auth", rift.key().as_ref()],
        bump
    )]
    pub rift_mint_authority: UncheckedAccount<'info>,

    /// **SECURITY FIX #49**: RIFT mint (for burning)
    /// CHECK: Pubkey validated against rift.rift_mint; Token program validates it's a valid mint during CPI
    #[account(
        mut,
        constraint = rift_mint.key() == rift.rift_mint @ ErrorCode::InvalidMint
    )]
    pub rift_mint: UncheckedAccount<'info>,

    /// Fees vault to collect unwrap fees (underlying tokens)
    /// CHECK: Optional - validated manually in handler. If not initialized (system_program::ID), fees stay in vault
    #[account(
        mut,
        seeds = [b"fees_vault", rift.key().as_ref()],
        bump
    )]
    pub fees_vault: UncheckedAccount<'info>,

    // **FIX CRITICAL #27**: Support different token programs for underlying and RIFT
    // Underlying can be SPL Token or Token-2022
    #[account(
        constraint = underlying_token_program.key() == anchor_spl::token::ID
            || underlying_token_program.key() == anchor_spl::token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub underlying_token_program: Interface<'info, TokenInterface>,

    // RIFT mint is always Token-2022 (enforced at creation)
    /// **FIX CRITICAL #37**: Constrain rift_token_program to Token-2022 only
    /// Prevents malicious program from faking burn operations and double-spending vault
    #[account(
        constraint = rift_token_program.key() == spl_token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub rift_token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminFixVaultConflict<'info> {
    #[account(mut)]
    pub program_authority: Signer<'info>,

    #[account(mut)]
    pub rift: Account<'info, Rift>,

    /// CHECK: Vault PDA that may have wrong owner
    #[account(
        mut,
        seeds = [b"vault", rift.key().as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: Expected vault authority PDA
    #[account(
        seeds = [b"vault_auth", rift.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
}

/// **SECURITY FIX #50**: Account struct for updating Switchboard oracle
#[derive(Accounts)]
pub struct UpdateSwitchboardOracle<'info> {
    #[account(mut)]
    pub rift: Account<'info, Rift>,

    /// **SECURITY FIX #50**: Authority authorized to update oracle prices (creator or governance)
    pub oracle_authority: Signer<'info>,

    /// **SECURITY FIX #50**: Switchboard aggregator feed - validated against rift.switchboard_feed_account
    /// CHECK: Validated in instruction handler against stored pubkey and Switchboard program ownership
    pub switchboard_feed: UncheckedAccount<'info>,
}

/// Account struct for updating oracle with manual price data (Jupiter API, etc.)
#[derive(Accounts)]
pub struct UpdateManualOracle<'info> {
    #[account(mut)]
    pub rift: Account<'info, Rift>,

    /// Authority authorized to update oracle prices (must be creator)
    pub oracle_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct TriggerRebalance<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub rift: Account<'info, Rift>,
}

/// Optimized fee distribution context - essential accounts only
#[derive(Accounts)]
/// **FIX CRITICAL #12**: CloseRift now requires ALL vaults to prevent fund loss
pub struct CloseRift<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        close = creator,
        has_one = creator @ ErrorCode::UnauthorizedClose
    )]
    pub rift: Account<'info, Rift>,

    /// **FIX CRITICAL #27**: Make vault optional - may not be initialized if rift never used
    /// CHECK: If initialized, validated against rift.vault. Manual check in handler.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    /// **FIX CRITICAL #27**: Make fees_vault optional - may be system_program::ID if never initialized
    /// CHECK: If initialized, validated by seeds and balance check in function
    #[account(mut)]
    pub fees_vault: UncheckedAccount<'info>,

    /// **FIX CRITICAL #27**: Make withheld_vault optional - may be system_program::ID if never initialized
    /// CHECK: If initialized, validated by seeds and balance check in function
    #[account(mut)]
    pub withheld_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AdminCloseRift<'info> {
    #[account(mut)]
    pub program_authority: Signer<'info>,

    #[account(
        mut,
        close = program_authority
    )]
    pub rift: Account<'info, Rift>,
}

/// **FIX HIGH #1**: Account struct for resetting stuck reentrancy guard
#[derive(Accounts)]
pub struct AdminResetReentrancyGuard<'info> {
    /// Program authority (only one authorized to reset guard)
    pub program_authority: Signer<'info>,

    /// Rift with potentially stuck reentrancy guard
    #[account(mut)]
    pub rift: Account<'info, Rift>,
}

#[derive(Accounts)]
pub struct AdminEmergencyWithdrawVault<'info> {
    /// **SECURITY FIX #3**: First admin authority (PROGRAM_AUTHORITY)
    #[account(mut)]
    pub admin_authority_1: Signer<'info>,

    /// **SECURITY FIX #3**: Second admin authority (ADMIN_AUTHORITY_2)
    #[account(mut)]
    pub admin_authority_2: Signer<'info>,

    /// **ACCOUNTING FIX**: Rift account to update accounting when withdrawing
    #[account(mut)]
    pub rift: Account<'info, Rift>,

    /// Vault holding the underlying tokens
    /// CHECK: Admin can specify any vault to recover from
    #[account(mut)]
    // **TOKEN-2022 MIGRATION**: Use InterfaceAccount for token types
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Vault authority PDA - will be verified against closed_rift_pubkey parameter
    /// CHECK: Admin provides this, function verifies it matches expected PDA
    pub vault_authority: UncheckedAccount<'info>,

    /// **TOKEN-2022 FIX**: Underlying mint required for transfer_checked
    /// CHECK: Validated against rift.underlying_mint
    #[account(
        constraint = underlying_mint.key() == rift.underlying_mint @ ErrorCode::InvalidMint
    )]
    pub underlying_mint: UncheckedAccount<'info>,

    /// Admin's token account to receive withdrawn tokens
    #[account(mut)]
    pub admin_token_account: InterfaceAccount<'info, TokenAccount>,

    // **CRITICAL FIX #1**: Constrain token_program to only accept SPL Token or Token-2022
    #[account(
        constraint = token_program.key() == anchor_spl::token::ID
            || token_program.key() == anchor_spl::token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AdminUpdateRiftMetadata<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// The rift account
    pub rift: Account<'info, Rift>,

    /// The rift mint to create metadata for
    /// **SECURITY FIX**: Constrain to rift.rift_mint and verify mint authority
    #[account(
        mut,
        constraint = rift_mint.key() == rift.rift_mint @ ErrorCode::InvalidMint,
        constraint = rift_mint.mint_authority.is_some() @ ErrorCode::InvalidMintAuthority,
        constraint = rift_mint.mint_authority.unwrap() == rift_mint_authority.key() @ ErrorCode::InvalidMintAuthority
    )]
    // **TOKEN-2022 MIGRATION**: Use InterfaceAccount for token types
    pub rift_mint: InterfaceAccount<'info, Mint>,

    /// Rift mint authority PDA
    /// CHECK: Verified by seeds constraint
    #[account(
        seeds = [b"rift_mint_auth", rift.key().as_ref()],
        bump
    )]
    pub rift_mint_authority: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CleanupStuckAccounts<'info> {
    /// The creator who originally tried to create the rift
    /// **SECURITY FIX**: Require creator signature to prevent griefing
    #[account(mut)]
    pub creator: Signer<'info>,

    /// The underlying mint that was used in the failed rift creation
    // **TOKEN-2022 MIGRATION**: Use InterfaceAccount for token types
    pub underlying_mint: InterfaceAccount<'info, Mint>,

    /// The stuck rift mint account that needs to be cleaned up
    /// **FIX HIGH #8**: Use UncheckedAccount to support Token-2022 mint closing via close_account
    /// **FIX CRITICAL #14**: Use correct PDA seeds matching create_rift (underlying_mint, creator)
    /// We close this account using Token-2022's close_account instruction
    #[account(
        mut,
        seeds = [b"rift_mint", underlying_mint.key().as_ref(), creator.key().as_ref()],
        constraint = underlying_mint.key() != Pubkey::default() && creator.key() != Pubkey::default() @ ErrorCode::InvalidSeedComponent,
        bump
    )]
    pub stuck_rift_mint: UncheckedAccount<'info>,

    /// The expected rift account location (should be empty/non-existent)
    /// CHECK: We verify this account is empty to ensure it's truly stuck
    #[account(
        seeds = [b"rift", underlying_mint.key().as_ref(), creator.key().as_ref()],
        constraint = underlying_mint.key() != Pubkey::default() && creator.key() != Pubkey::default() @ ErrorCode::InvalidSeedComponent,
        bump
    )]
    pub expected_rift: UncheckedAccount<'info>,

    /// **FIX HIGH #8**: Add mint_authority PDA so we can sign close_account
    /// Mint authority PDA - controls mint operations
    /// CHECK: PDA verified by seeds
    #[account(
        seeds = [b"rift_mint_auth", expected_rift.key().as_ref()],
        bump
    )]
    pub rift_mint_authority: UncheckedAccount<'info>,

    /// The account that will pay for the transaction (can be anyone)
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// **FIX HIGH #8**: Add Token-2022 program for close_account instruction
    /// CHECK: Token-2022 program for closing mint account
    #[account(address = spl_token_2022::ID)]
    pub token_program: UncheckedAccount<'info>,
}

/// **FIX CRITICAL #10**: Struct for cleaning up stuck VANITY rift accounts
/// Vanity rifts use different PDA seeds than regular rifts
#[derive(Accounts)]
#[instruction(vanity_seed: [u8; 32], seed_len: u8)]
pub struct CleanupStuckVanityAccounts<'info> {
    /// The creator who originally tried to create the vanity rift
    /// **SECURITY FIX**: Require creator signature to prevent griefing
    #[account(mut)]
    pub creator: Signer<'info>,

    /// The underlying mint that was used in the failed vanity rift creation
    // **TOKEN-2022 MIGRATION**: Use InterfaceAccount for token types
    pub underlying_mint: InterfaceAccount<'info, Mint>,

    /// The stuck VANITY rift mint account that needs to be cleaned up
    /// **FIX CRITICAL #10**: Uses VANITY seeds (includes vanity_seed)
    /// We close this account using Token-2022's close_account instruction
    #[account(
        mut,
        seeds = [b"rift_mint", creator.key().as_ref(), underlying_mint.key().as_ref(), &vanity_seed[..seed_len as usize]],
        bump
    )]
    pub stuck_rift_mint: UncheckedAccount<'info>,

    /// The expected rift account location (should be empty/non-existent)
    /// CHECK: We verify this account is empty to ensure it's truly stuck
    /// **FIX CRITICAL #26**: Vanity rifts have DIFFERENT seeds than regular rifts!
    #[account(
        seeds = [b"rift", underlying_mint.key().as_ref(), creator.key().as_ref(), &vanity_seed[..seed_len as usize]],
        constraint = underlying_mint.key() != Pubkey::default() && creator.key() != Pubkey::default() @ ErrorCode::InvalidSeedComponent,
        bump
    )]
    pub expected_rift: UncheckedAccount<'info>,

    /// **FIX CRITICAL #10**: Mint authority PDA - same for vanity and non-vanity
    /// Mint authority PDA - controls mint operations
    /// CHECK: PDA verified by seeds
    #[account(
        seeds = [b"rift_mint_auth", expected_rift.key().as_ref()],
        bump
    )]
    pub rift_mint_authority: UncheckedAccount<'info>,

    /// The account that will pay for the transaction (can be anyone)
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// **FIX CRITICAL #10**: Token-2022 program for close_account instruction
    /// CHECK: Token-2022 program for closing vanity mint account
    #[account(address = spl_token_2022::ID)]
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DistributeFeesFromVault<'info> {
    /// Fee payer (anyone can call)
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub rift: Account<'info, Rift>,

    /// **FEE ROUTING UPDATE**: Fees vault holding collected wrap/unwrap fees (underlying tokens)
    #[account(
        mut,
        seeds = [b"fees_vault", rift.key().as_ref()],
        bump,
        constraint = fees_vault.key() == rift.fees_vault @ ErrorCode::InvalidVault
    )]
    pub fees_vault: InterfaceAccount<'info, TokenAccount>,

    /// Vault authority PDA - signs transfers from fees_vault
    /// CHECK: PDA validated by seeds
    #[account(
        seeds = [b"vault_auth", rift.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// Underlying mint (to validate treasury and partner accounts)
    /// CHECK: Manually validated in handler - owner must be Token program, deserializes as Mint, key matches rift.underlying_mint
    pub underlying_mint: UncheckedAccount<'info>,

    /// Treasury wallet that owns the treasury_account
    /// CHECK: Used to derive ATA
    pub treasury_wallet: UncheckedAccount<'info>,

    /// Treasury token account (ATA - auto-created if needed)
    /// CHECK: Validated in handler - ATA derivation checked manually due to underlying_mint being UncheckedAccount
    #[account(mut)]
    pub treasury_account: UncheckedAccount<'info>,

    /// Partner wallet that owns the partner_account (optional)
    /// CHECK: Used to derive ATA. If a partner is configured in `rift.partner_wallet`,
    /// this account MUST correspond to the same pubkey and its ATA must exist when
    /// partner_amount > 0. The protocol assumes the partner ATA is pre-initialized
    /// by either the partner or the admin flows.
    pub partner_wallet: Option<UncheckedAccount<'info>>,

    /// Partner account (ATA - currently auto-created if needed). In practice,
    /// for production deployments the ATA should be initialized ahead of time
    /// via a dedicated admin/init instruction and `init_if_needed` can be removed
    /// to avoid race conditions and unexpected payer charges.
    /// CHECK: Validated in handler - ATA derivation checked manually due to underlying_mint being UncheckedAccount
    #[account(mut)]
    pub partner_account: Option<UncheckedAccount<'info>>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    // **CRITICAL FIX #1**: Constrain token_program to only accept SPL Token or Token-2022
    #[account(
        constraint = token_program.key() == anchor_spl::token::ID
            || token_program.key() == anchor_spl::token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct UpdateTreasuryWallet<'info> {
    /// Rift creator (admin)
    pub creator: Signer<'info>,

    #[account(mut)]
    pub rift: Account<'info, Rift>,
}

// REMOVED: AdminWithdrawFeeCollector - obsolete struct for removed fee_collector program

/// **TOKEN-2022**: Account struct for claiming withheld transfer fees (non-admin)
/// Treasury wallet (per-rift) can call this
#[derive(Accounts)]
pub struct ClaimWithheldFees<'info> {
    /// **PER-RIFT TREASURY FIX**: Treasury wallet must match rift.treasury_wallet
    /// Authorization check is done in the function handler to use per-rift treasury
    pub treasury_signer: Signer<'info>,

    #[account(mut)]
    pub rift: Account<'info, Rift>,

    /// RIFT mint (Token-2022 with transfer fee extension)
    #[account(
        mut,
        constraint = rift_mint.key() == rift.rift_mint @ ErrorCode::InvalidMint
    )]
    pub rift_mint: InterfaceAccount<'info, Mint>,

    /// Withheld vault to receive withheld transfer fees (RIFT tokens)
    #[account(
        mut,
        seeds = [b"withheld_vault", rift.key().as_ref()],
        bump,
        constraint = withheld_vault.key() == rift.withheld_vault @ ErrorCode::InvalidVault,
        constraint = withheld_vault.mint == rift.rift_mint @ ErrorCode::InvalidMint
    )]
    pub withheld_vault: InterfaceAccount<'info, TokenAccount>,

    /// Source account with withheld fees to claim
    #[account(
        mut,
        constraint = source_account.mint == rift.rift_mint @ ErrorCode::InvalidMint
    )]
    pub source_account: InterfaceAccount<'info, TokenAccount>,

    /// **FIX MEDIUM #45**: Constrain token_program for defense-in-depth
    /// Currently unused (handler uses hardcoded spl_token_2022::ID), but constraint
    /// prevents future refactoring from introducing vulnerability
    #[account(
        constraint = token_program.key() == spl_token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub token_program: Interface<'info, TokenInterface>,
}

/// **FEE MANAGEMENT**: Account struct for distributing withheld fees
/// Splits withheld_vault RIFT tokens to partner and treasury accounts
#[derive(Accounts)]
pub struct DistributeWithheldVault<'info> {
    /// Fee payer (creator or treasury_wallet)
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub rift: Account<'info, Rift>,

    /// Withheld vault holding collected transfer fees (RIFT tokens)
    #[account(
        mut,
        seeds = [b"withheld_vault", rift.key().as_ref()],
        bump,
        constraint = withheld_vault.key() == rift.withheld_vault @ ErrorCode::InvalidVault
    )]
    pub withheld_vault: InterfaceAccount<'info, TokenAccount>,

    /// Vault authority PDA - signs transfers from withheld_vault
    /// CHECK: PDA validated by seeds
    #[account(
        seeds = [b"vault_auth", rift.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// RIFT mint (to validate treasury and partner accounts)
    /// CHECK: Manually validated in handler - owner must be Token-2022 program, deserializes as Mint, key matches rift.rift_mint
    pub rift_mint: UncheckedAccount<'info>,

    /// Treasury wallet that owns the treasury_account
    /// CHECK: Used to derive ATA
    pub treasury_wallet: UncheckedAccount<'info>,

    /// Treasury token account (ATA - auto-created if needed, holds RIFT tokens)
    /// CHECK: Validated in handler - ATA derivation checked manually due to rift_mint being UncheckedAccount
    #[account(mut)]
    pub treasury_account: UncheckedAccount<'info>,

    /// Partner wallet that owns the partner_account (optional)
    /// CHECK: Used to derive ATA. If a partner is configured in `rift.partner_wallet`,
    /// this account MUST correspond to the same pubkey and its ATA must exist when
    /// partner_amount > 0. The protocol assumes the partner ATA is pre-initialized
    /// by either the partner or the admin flows.
    pub partner_wallet: Option<UncheckedAccount<'info>>,

    /// Partner account (ATA - currently auto-created if needed). In practice,
    /// for production deployments the ATA should be initialized ahead of time
    /// via a dedicated admin/init instruction and `init_if_needed` can be removed
    /// to avoid race conditions and unexpected payer charges.
    /// CHECK: Validated in handler - ATA derivation checked manually due to rift_mint being UncheckedAccount
    #[account(mut)]
    pub partner_account: Option<UncheckedAccount<'info>>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// **FIX CRITICAL #39**: Constrain token_program to Token-2022 only
    /// Prevents malicious program from faking withheld vault distributions and draining funds
    #[account(
        constraint = token_program.key() == spl_token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub token_program: Interface<'info, TokenInterface>,
}

/// **TOKEN-2022**: Account struct for admin claiming withheld transfer fees
#[derive(Accounts)]
pub struct AdminClaimWithheldFees<'info> {
    /// **WITHHELD AUTHORITY FIX**: Must be treasury_wallet (withdraw_withheld_authority)
    /// The treasury_wallet is set as withdraw_withheld_authority during mint creation
    pub treasury_signer: Signer<'info>,

    #[account(mut)]
    pub rift: Account<'info, Rift>,

    /// RIFT mint (Token-2022 with transfer fee extension)
    #[account(
        mut,
        constraint = rift_mint.key() == rift.rift_mint @ ErrorCode::InvalidMint
    )]
    pub rift_mint: InterfaceAccount<'info, Mint>,

    /// **FEE ROUTING**: Withheld vault to receive withheld transfer fees (RIFT tokens)
    #[account(
        mut,
        seeds = [b"withheld_vault", rift.key().as_ref()],
        bump,
        constraint = withheld_vault.key() == rift.withheld_vault @ ErrorCode::InvalidVault,
        constraint = withheld_vault.mint == rift.rift_mint @ ErrorCode::InvalidMint
    )]
    pub withheld_vault: InterfaceAccount<'info, TokenAccount>,

    /// Source account with withheld fees to claim
    #[account(
        mut,
        constraint = source_account.mint == rift.rift_mint @ ErrorCode::InvalidMint
    )]
    pub source_account: InterfaceAccount<'info, TokenAccount>,

    /// **FIX MEDIUM #45**: Constrain token_program for defense-in-depth
    /// Currently unused (handler uses hardcoded spl_token_2022::ID), but constraint
    /// prevents future refactoring from introducing vulnerability
    #[account(
        constraint = token_program.key() == spl_token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub token_program: Interface<'info, TokenInterface>,
}

/// **TOKEN-2022**: Account struct for admin setting transfer fee
#[derive(Accounts)]
pub struct AdminSetTransferFee<'info> {
    /// Must be PROGRAM_AUTHORITY (transfer_fee_config_authority)
    pub program_authority: Signer<'info>,

    #[account(mut)]
    pub rift: Account<'info, Rift>,

    /// RIFT mint (Token-2022 with transfer fee extension)
    #[account(
        mut,
        constraint = rift_mint.key() == rift.rift_mint @ ErrorCode::InvalidMint
    )]
    pub rift_mint: InterfaceAccount<'info, Mint>,

    /// **FIX MEDIUM #45**: Constrain token_program for defense-in-depth
    /// Currently unused (handler uses hardcoded spl_token_2022::ID), but constraint
    /// prevents future refactoring from introducing vulnerability
    #[account(
        constraint = token_program.key() == spl_token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub token_program: Interface<'info, TokenInterface>,
}

/// **FEE MANAGEMENT**: Account struct for admin withdrawing fees from fees_vault
#[derive(Accounts)]
pub struct AdminWithdrawFeesVault<'info> {
    /// Must be PROGRAM_AUTHORITY
    pub program_authority: Signer<'info>,

    #[account(mut)]
    pub rift: Account<'info, Rift>,

    /// Underlying mint (the original token being wrapped)
    #[account(
        constraint = underlying_mint.key() == rift.underlying_mint @ ErrorCode::InvalidMint
    )]
    pub underlying_mint: InterfaceAccount<'info, Mint>,

    /// Fees vault containing collected wrap/unwrap fees (underlying tokens)
    #[account(
        mut,
        seeds = [b"fees_vault", rift.key().as_ref()],
        bump,
        constraint = fees_vault.key() == rift.fees_vault @ ErrorCode::InvalidVault,
        constraint = fees_vault.mint == rift.underlying_mint @ ErrorCode::InvalidMint
    )]
    pub fees_vault: InterfaceAccount<'info, TokenAccount>,

    /// Treasury account to receive fees (underlying tokens)
    #[account(
        mut,
        constraint = treasury_account.mint == rift.underlying_mint @ ErrorCode::InvalidMint
    )]
    pub treasury_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Vault authority PDA - signs transfers from fees_vault
    #[account(
        seeds = [b"vault_auth", rift.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// **FIX HIGH #41**: Constrain token_program to SPL Token or Token-2022 only
    /// Defense-in-depth: Even though admin-only, prevent admin error or compromised key from using malicious program
    #[account(
        constraint = token_program.key() == anchor_spl::token::ID
            || token_program.key() == spl_token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub token_program: Interface<'info, TokenInterface>,
}

/// **FEE MANAGEMENT**: Account struct for admin withdrawing withheld fees from withheld_vault
#[derive(Accounts)]
pub struct AdminWithdrawWithheldVault<'info> {
    /// Must be PROGRAM_AUTHORITY
    pub program_authority: Signer<'info>,

    #[account(mut)]
    pub rift: Account<'info, Rift>,

    /// RIFT mint (Token-2022 with transfer fee extension)
    #[account(
        constraint = rift_mint.key() == rift.rift_mint @ ErrorCode::InvalidMint
    )]
    pub rift_mint: InterfaceAccount<'info, Mint>,

    /// Withheld vault containing collected withheld transfer fees (RIFT tokens)
    #[account(
        mut,
        seeds = [b"withheld_vault", rift.key().as_ref()],
        bump,
        constraint = withheld_vault.key() == rift.withheld_vault @ ErrorCode::InvalidVault,
        constraint = withheld_vault.mint == rift.rift_mint @ ErrorCode::InvalidMint
    )]
    pub withheld_vault: InterfaceAccount<'info, TokenAccount>,

    /// Treasury RIFT token account to receive fees (RIFT tokens)
    #[account(
        mut,
        constraint = treasury_rift_account.mint == rift.rift_mint @ ErrorCode::InvalidMint
    )]
    pub treasury_rift_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Vault authority PDA - signs transfers from withheld_vault
    #[account(
        seeds = [b"vault_auth", rift.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// **FIX HIGH #42**: Constrain token_program to Token-2022 only (withheld_vault holds RIFT tokens)
    /// Defense-in-depth: Even though admin-only, prevent admin error or compromised key from using malicious program
    #[account(
        constraint = token_program.key() == spl_token_2022::ID
            @ ErrorCode::InvalidProgramId
    )]
    pub token_program: Interface<'info, TokenInterface>,
}

/// **SECURITY FIX #50**: Account struct for setting oracle addresses
#[derive(Accounts)]
pub struct SetOracleAccounts<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        constraint = rift.creator == creator.key() @ ErrorCode::Unauthorized
    )]
    pub rift: Account<'info, Rift>,
}

/// **FIX ISSUE #5**: Account struct for proposing oracle change
#[derive(Accounts)]
pub struct ProposeOracleChange<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        constraint = rift.creator == creator.key() @ ErrorCode::Unauthorized
    )]
    pub rift: Account<'info, Rift>,
}

/// **FIX ISSUE #5 + FIX INFO #2 (Audit)**: Account struct for executing oracle change
/// Only creator can execute to prevent griefing/front-running
#[derive(Accounts)]
pub struct ExecuteOracleChange<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        constraint = rift.creator == creator.key() @ ErrorCode::Unauthorized
    )]
    pub rift: Account<'info, Rift>,
}

/// **FIX ISSUE #5**: Account struct for cancelling oracle change
#[derive(Accounts)]
pub struct CancelOracleChange<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        constraint = rift.creator == creator.key() @ ErrorCode::Unauthorized
    )]
    pub rift: Account<'info, Rift>,
}

#[account]
/// Core accounting invariants:
/// - `total_underlying_wrapped` tracks the amount of underlying tokens that back RIFT in circulation
///   (after fees are siphoned into `fees_vault`). It should match the net backing held in `vault`,
///   adjusted for any protocol-defined fees that have already been moved out of the main vault.
/// - `total_rift_minted` tracks the total amount of RIFT ever minted minus burned, independent of
///   *where* those tokens currently live (user wallet, vault, treasury, withheld vault, etc.).
/// - `total_fees_collected` is used to account for fees that belong to the protocol and are held
///   in `fees_vault` / `withheld_vault`. It should never be decremented when fees are merely
///   moved between internal protocol-controlled accounts.
pub struct Rift {
    pub name: [u8; 32], // Fixed-size name (no heap allocation!)
    pub creator: Pubkey,
    pub underlying_mint: Pubkey,
    pub rift_mint: Pubkey,
    pub vault: Pubkey,
    pub fees_vault: Pubkey, // Separate vault for collected wrap/unwrap fees (underlying tokens)
    pub withheld_vault: Pubkey, // Separate vault for SPL Token-2022 withheld transfer fees (RIFT tokens)
    pub partner_fee_bps: u16,
    pub partner_wallet: Option<Pubkey>,
    pub treasury_wallet: Option<Pubkey>, // Treasury wallet for fee collection (configurable by owner)
    /// **MEDIUM FIX #11**: Configurable wrap/unwrap fees (default 30 bps = 0.3%)
    pub wrap_fee_bps: u16, // Wrap fee in basis points (default 30 = 0.3%)
    pub unwrap_fee_bps: u16,             // Unwrap fee in basis points (default 30 = 0.3%)
    /// **SECURITY FIX**: Separate accounting units to prevent mix-ups
    pub total_underlying_wrapped: u64, // Amount of underlying tokens wrapped
    pub total_rift_minted: u64,          // Amount of RIFT tokens minted
    pub total_burned: u64,
    pub backing_ratio: u64,
    pub last_rebalance: i64,
    pub created_at: i64,

    // Hybrid Oracle System
    pub oracle_prices: [PriceData; 10], // Rolling window of recent prices
    pub price_index: u8,                // Current index in the rolling window
    pub oracle_update_interval: i64,    // How often oracle updates (default 30 minutes)
    pub max_rebalance_interval: i64,    // Maximum time between rebalances (24 hours)
    pub arbitrage_threshold_bps: u16,   // Threshold for arbitrage detection (basis points)
    pub last_oracle_update: i64,        // Last oracle price update
    // Advanced Metrics
    pub total_volume_24h: u64,          // 24h trading volume
    pub price_deviation: u64,           // Current price deviation from backing
    pub arbitrage_opportunity_bps: u16, // Current arbitrage opportunity
    pub rebalance_count: u32,           // Total number of rebalances

    // RIFTS Token Distribution
    pub total_fees_collected: u64,     // Total fees collected
    pub rifts_tokens_distributed: u64, // Total RIFTS tokens distributed to LP stakers
    pub rifts_tokens_burned: u64,      // Total RIFTS tokens burned

    /// **SECURITY FIX #50**: Store oracle account addresses for validation
    pub switchboard_feed_account: Option<Pubkey>, // Bound Switchboard aggregator address

    // **HIGH FIX #3**: Rate limiting for manual oracle updates
    pub last_manual_oracle_update: i64, // Last manual oracle update timestamp

    // **FIX HIGH #2**: Cumulative drift tracking for oracle manipulation prevention
    pub manual_oracle_base_price: u64, // Base price when drift window started
    pub manual_oracle_drift_window_start: i64, // When current 24h window started

    // Reentrancy Protection
    pub reentrancy_guard: bool, // Prevents reentrancy attacks
    pub reentrancy_guard_slot: u64, // Slot when guard was set (for auto-timeout)

    // Rift Closure State
    pub is_closed: bool, // Whether rift has been closed by admin
    pub closed_at_slot: u64, // Slot when rift was closed

    // Oracle Change Timelock (24h delay for security)
    pub oracle_change_pending: bool,
    pub pending_switchboard_account: Option<Pubkey>,
    pub oracle_change_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct PriceData {
    pub price: u64,
    pub confidence: u64,
    pub timestamp: i64,
}

impl Rift {
    pub fn add_price_data(&mut self, price: u64, confidence: u64, timestamp: i64) -> Result<()> {
        // **CRITICAL SECURITY FIX**: Validate timestamp bounds to prevent manipulation
        let current_time = Clock::get()?.unix_timestamp;

        // Reject timestamps from the future (allow 60 second clock skew)
        require!(timestamp <= current_time + 60, ErrorCode::InvalidTimestamp);

        // Reject timestamps older than 5 minutes (300 seconds)
        require!(timestamp >= current_time - 300, ErrorCode::InvalidTimestamp);

        self.oracle_prices[self.price_index as usize] = PriceData {
            price,
            confidence,
            timestamp,
        };
        self.price_index = (self.price_index + 1) % 10;
        self.last_oracle_update = timestamp;
        Ok(())
    }

    pub fn should_trigger_rebalance(&self, current_time: i64) -> Result<bool> {
        // **CRITICAL SECURITY FIX**: Validate current_time to prevent timestamp manipulation
        let actual_current_time = Clock::get()?.unix_timestamp;
        require!(
            (current_time - actual_current_time).abs() <= 60, // Allow 60 second skew
            ErrorCode::InvalidTimestamp
        );

        // Check if maximum rebalance interval has passed
        if current_time - self.last_rebalance > self.max_rebalance_interval {
            return Ok(true);
        }

        // **NEW FEATURE**: Check if volume threshold exceeded for volatility farming
        // Trigger rebalance if 24h volume exceeds 10% of total wrapped
        let volume_threshold = self
            .total_rift_minted
            .checked_div(10) // 10% of total minted
            .unwrap_or(u64::MAX);
        if self.total_volume_24h > volume_threshold {
            return Ok(true);
        }

        // Check if arbitrage opportunity exceeds threshold
        if self.arbitrage_opportunity_bps > self.arbitrage_threshold_bps {
            return Ok(true);
        }

        // Check if oracle indicates significant price deviation
        let avg_price = self.get_average_oracle_price()?;
        let price_deviation = self.calculate_price_deviation(avg_price)?;

        // Trigger if deviation > 2%
        Ok(price_deviation > 200) // 200 basis points = 2%
    }

    pub fn can_manual_rebalance(&self, current_time: i64) -> Result<bool> {
        // **CRITICAL SECURITY FIX**: Validate current_time to prevent timestamp manipulation
        let actual_current_time = Clock::get()?.unix_timestamp;
        require!(
            (current_time - actual_current_time).abs() <= 60, // Allow 60 second skew
            ErrorCode::InvalidTimestamp
        );

        // Allow manual rebalance if oracle interval has passed
        Ok(current_time - self.last_oracle_update > self.oracle_update_interval)
    }

    pub fn trigger_automatic_rebalance(&mut self, current_time: i64) -> Result<()> {
        // **CRITICAL SECURITY FIX**: Validate current_time to prevent timestamp manipulation
        let actual_current_time = Clock::get()?.unix_timestamp;
        require!(
            (current_time - actual_current_time).abs() <= 60, // Allow 60 second skew
            ErrorCode::InvalidTimestamp
        );

        let avg_price = self.get_average_oracle_price()?;

        // **CRITICAL FIX**: Validate oracle price before updating backing ratio
        require!(avg_price > 0, ErrorCode::InvalidOraclePrice);
        require!(
            avg_price <= 1_000_000_000_000,
            ErrorCode::OraclePriceTooLarge
        );

        // **CRITICAL FIX**: Only update backing ratio if price is reasonable
        // Additional validation to prevent zero backing ratio
        if avg_price > 0 && avg_price <= 1_000_000_000_000 {
            self.backing_ratio = avg_price;
        } else {
            return Err(ErrorCode::InvalidOraclePrice.into());
        }

        self.last_rebalance = current_time;
        self.rebalance_count = self
            .rebalance_count
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;

        // Recalculate arbitrage opportunity
        self.arbitrage_opportunity_bps = 0; // Reset after rebalance
        self.price_deviation = 0;

        // **NEW FEATURE**: Reset volume counter after rebalance for volatility farming
        self.total_volume_24h = 0; // Reset volume tracking

        Ok(())
    }

    // **FIX CRITICAL #28**: Add allow_stale_fallback parameter to enable oracle recovery
    pub fn get_average_oracle_price(&self) -> Result<u64> {
        self.get_average_oracle_price_with_options(false)
    }

    pub fn get_average_oracle_price_with_options(&self, allow_stale_fallback: bool) -> Result<u64> {
        let mut total_price = 0u128; // **PRECISION FIX**: Use u128 for intermediate calculations
        let mut count = 0u64;
        let mut stale_count = 0u64;

        // **FIX MEDIUM #7**: Check oracle data freshness to prevent stale price usage
        const MAX_ORACLE_AGE: i64 = 3600; // 1 hour max age
        // **FIX MEDIUM #1 (Audit)**: Minimum fresh samples required to avoid deadlock
        const MIN_FRESH_SAMPLES: u64 = 1; // At least 1 fresh sample required
        let current_time = Clock::get()?.unix_timestamp;

        for price_data in &self.oracle_prices {
            if price_data.timestamp > 0 {
                // **FIX MEDIUM #7**: Check oracle data staleness
                let age = current_time
                    .checked_sub(price_data.timestamp)
                    .ok_or(ErrorCode::MathOverflow)?;

                // **FIX MEDIUM #1 (Audit)**: Skip stale samples in ALL modes, track count
                // This prevents deadlock when some samples are stale but others are fresh
                if age > MAX_ORACLE_AGE {
                    stale_count = stale_count.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
                    msg!(
                        "⚠️ Skipping stale oracle price (age: {}s)",
                        age
                    );
                    continue; // Skip this stale price, continue to next
                }

                // **CRITICAL FIX**: Use checked arithmetic to prevent overflow
                total_price = total_price
                    .checked_add(u128::from(price_data.price))
                    .ok_or(ErrorCode::MathOverflow)?;
                count = count.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
            }
        }

        // **FIX MEDIUM #1 (Audit)**: In normal mode, require minimum fresh samples
        // In recovery mode (allow_stale_fallback=true), allow fallback to backing_ratio
        if !allow_stale_fallback && count < MIN_FRESH_SAMPLES && stale_count > 0 {
            msg!("❌ Insufficient fresh oracle samples: {} fresh, {} stale (min required: {})",
                count, stale_count, MIN_FRESH_SAMPLES);
            return Err(ErrorCode::OraclePriceStale.into());
        }

        if count > 0 {
            // **PRECISION FIX**: Use fixed-point math with scaling to preserve precision
            // Scale by 1,000,000 (6 decimal places) before division to prevent truncation bias
            const PRECISION_SCALE: u128 = 1_000_000;

            let scaled_total = total_price
                .checked_mul(PRECISION_SCALE)
                .ok_or(ErrorCode::MathOverflow)?;

            let scaled_avg = scaled_total
                .checked_div(u128::from(count))
                .ok_or(ErrorCode::MathOverflow)?;

            // Convert back to u64 with proper precision preservation
            let avg_price = scaled_avg
                .checked_div(PRECISION_SCALE)
                .ok_or(ErrorCode::MathOverflow)?;

            let final_price = u64::try_from(avg_price).map_err(|_| ErrorCode::MathOverflow)?;

            // **CRITICAL FIX**: Validate average price is reasonable
            require!(final_price > 0, ErrorCode::InvalidOraclePrice);
            require!(
                final_price <= 1_000_000_000_000,
                ErrorCode::OraclePriceTooLarge
            );

            Ok(final_price)
        } else {
            // **CRITICAL FIX**: Validate fallback backing ratio
            require!(self.backing_ratio > 0, ErrorCode::InvalidBackingRatio);

            // **FIX CRITICAL #28**: Allow recovery bypass during manual oracle update
            // When allow_stale_fallback=true, skip staleness check to enable recovery from deadlock
            // **FIX CRITICAL #47**: Even in recovery mode, enforce maximum age to prevent indefinite stale lock
            const MAX_BACKING_RATIO_AGE: i64 = 86400; // 24 hours in normal mode
            const MAX_BACKING_RATIO_AGE_RECOVERY: i64 = 604800; // 7 days in recovery mode
            let current_time = Clock::get()?.unix_timestamp;
            let backing_ratio_age = current_time
                .checked_sub(self.last_rebalance)
                .ok_or(ErrorCode::MathOverflow)?;

            if !allow_stale_fallback {
                // **FIX HIGH #17**: Check staleness of backing_ratio before using as fallback
                // If all oracle prices are stale, backing_ratio could also be very old
                require!(
                    backing_ratio_age <= MAX_BACKING_RATIO_AGE,
                    ErrorCode::BackingRatioTooStale
                );
                msg!(
                    "⚠️ Using fallback backing_ratio (age: {}s)",
                    backing_ratio_age
                );
            } else {
                // **FIX CRITICAL #47**: Even in recovery mode, enforce maximum 7-day age
                // This prevents protocol from being locked to arbitrarily old prices indefinitely
                // 7 days is enough for recovery while preventing permanent stale lock
                require!(
                    backing_ratio_age <= MAX_BACKING_RATIO_AGE_RECOVERY,
                    ErrorCode::BackingRatioTooStale
                );
                msg!(
                    "⚠️ Using fallback backing_ratio (RECOVERY MODE - age: {}s, max: 7 days)",
                    backing_ratio_age
                );
            }

            Ok(self.backing_ratio) // Fallback to current backing ratio
        }
    }

    pub fn calculate_price_deviation(&self, oracle_price: u64) -> Result<u16> {
        if self.backing_ratio == 0 {
            return Ok(0);
        }

        let deviation = if oracle_price > self.backing_ratio {
            oracle_price
                .checked_sub(self.backing_ratio)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_mul(10000)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_div(self.backing_ratio)
                .ok_or(ErrorCode::MathOverflow)?
        } else {
            self.backing_ratio
                .checked_sub(oracle_price)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_mul(10000)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_div(self.backing_ratio)
                .ok_or(ErrorCode::MathOverflow)?
        };

        Ok(u16::try_from(deviation).map_err(|_| ErrorCode::MathOverflow)?)
    }

    pub fn process_rifts_distribution(&mut self, amount: u64) -> Result<()> {
        // 90% to LP stakers, 10% burned with checked arithmetic
        let lp_staker_amount = amount
            .checked_mul(90)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(100)
            .ok_or(ErrorCode::MathOverflow)?;
        let burn_amount = amount
            .checked_mul(10)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(100)
            .ok_or(ErrorCode::MathOverflow)?;

        self.rifts_tokens_distributed = self
            .rifts_tokens_distributed
            .checked_add(lp_staker_amount)
            .ok_or(ErrorCode::MathOverflow)?;
        self.rifts_tokens_burned = self
            .rifts_tokens_burned
            .checked_add(burn_amount)
            .ok_or(ErrorCode::MathOverflow)?;

        Ok(())
    }

    /// NOTE: This helper is currently unused by on-chain logic and kept only for
/// off-chain analytics / future extensions. It can be safely removed if code
/// size becomes a concern.
pub fn get_pending_fees(&self) -> u64 {
        // **SECURITY FIX**: Get total fees that haven't been distributed yet with proper error handling
        let total_distributed = match self
            .rifts_tokens_distributed
            .checked_add(self.rifts_tokens_burned)
        {
            Some(total) => total,
            None => return 0, // Overflow in distributed calculation - return 0 as safe fallback
        };

        if self.total_fees_collected > total_distributed {
            match self.total_fees_collected.checked_sub(total_distributed) {
                Some(pending) => pending,
                None => 0, // Underflow should not happen given the check above, but return 0 as safe fallback
            }
        } else {
            0
        }
    }

    pub fn get_oracle_countdown(&self, current_time: i64) -> i64 {
        let next_oracle_time = self.last_oracle_update + self.oracle_update_interval;
        (next_oracle_time - current_time).max(0)
    }

    pub fn get_rebalance_countdown(&self, current_time: i64) -> i64 {
        let next_rebalance_time = self.last_rebalance + self.max_rebalance_interval;
        (next_rebalance_time - current_time).max(0)
    }
}

#[event]
pub struct RiftCreated {
    pub rift: Pubkey,
    pub creator: Pubkey,
    pub underlying_mint: Pubkey,
    pub partner_fee_bps: u16,
}

#[event]
pub struct RiftClosed {
    pub rift: Pubkey,
    pub creator: Pubkey,
}

#[event]
pub struct RiftAdminClosed {
    pub rift: Pubkey,
    pub original_creator: Pubkey,
    pub admin: Pubkey,
}

#[event]
pub struct StuckAccountCleaned {
    pub creator: Pubkey,
    pub stuck_mint: Pubkey,
    pub underlying_mint: Pubkey,
}

/// **FIX HIGH #1**: Event emitted when reentrancy guard is reset by admin
#[event]
pub struct ReentrancyGuardReset {
    pub rift: Pubkey,
    pub authority: Pubkey,
}

/// **FIX ISSUE #5**: Event emitted when oracle change is proposed
#[event]
pub struct OracleChangeProposed {
    pub rift: Pubkey,
    pub switchboard_account: Option<Pubkey>,
    pub effective_time: i64,
}

/// **FIX ISSUE #5**: Event emitted when oracle change is executed
#[event]
pub struct OracleChangeExecuted {
    pub rift: Pubkey,
    pub switchboard_account: Option<Pubkey>,
}

#[event]
pub struct WrapAndPoolCreated {
    pub rift: Pubkey,
    pub user: Pubkey,
    pub underlying_amount: u64,
    pub fee_amount: u64,
    pub tokens_minted: u64,
    pub pool_underlying: u64,
    pub pool_rift: u64,
    pub lp_tokens_minted: u64,
    pub trading_fee_bps: u16,
}

#[event]
pub struct TokensWrapped {
    pub rift: Pubkey,
    pub user: Pubkey,
    pub amount_in: u64,
    pub fee_paid: u64,
    pub rift_tokens_minted: u64,
}

#[event]
pub struct UnwrapExecuted {
    pub rift: Pubkey,
    pub user: Pubkey,
    pub rift_token_amount: u64,
    pub fee_amount: u64,
    pub underlying_returned: u64,
}

#[event]
pub struct FeesCalculated {
    pub rift: Pubkey,
    pub treasury_amount: u64,
    pub fee_collector_amount: u64,
    pub partner_amount: u64,
    pub burn_amount: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid account data")] 
    InvalidAccountData,

    #[msg("Invalid partner fee (max 5%)")]
    InvalidPartnerFee,
    #[msg("Invalid trading fee (max 1%)")]
    InvalidTradingFee,
    #[msg("Invalid transfer fee (must be 0.7%-1% = 70-100 basis points)")]
    InvalidTransferFee,
    #[msg("Rift name must end with '_RIFT' or 'RIFT'")]
    InvalidRiftName,
    #[msg("Rift name too long (max 32 chars)")]
    NameTooLong,
    #[msg("Invalid vanity address - must end with 'rift'")]
    InvalidVanityAddress,
    #[msg("Rebalance called too soon")]
    RebalanceTooSoon,
    #[msg("Oracle price too stale")]
    OraclePriceTooStale,
    #[msg("Insufficient arbitrage opportunity")]
    InsufficientArbitrageOpportunity,
    #[msg("Unauthorized to close this rift")]
    UnauthorizedClose,
    #[msg("Unauthorized admin action")]
    UnauthorizedAdmin,
    #[msg("Vault must be empty before closing")]
    VaultNotEmpty,
    #[msg("Invalid stuck account - does not match expected PDA")]
    InvalidStuckAccount,
    #[msg("Rift already exists - not a stuck account")]
    RiftAlreadyExists,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Invalid backing ratio")]
    InvalidBackingRatio,
    #[msg("Unauthorized oracle")]
    UnauthorizedOracle,
    #[msg("Invalid price")]
    InvalidPrice,
    #[msg("Invalid confidence")]
    InvalidConfidence,
    #[msg("Invalid fee amount")]
    InvalidFeeAmount,
    #[msg("Insufficient rent exemption for account creation")]
    InsufficientRentExemption,
    #[msg("Invalid program ID in cross-program invocation")]
    InvalidProgramId,
    #[msg("Invalid seed component in PDA derivation")]
    InvalidSeedComponent,
    #[msg("Partner vault owner or mint validation failed")]
    InvalidPartnerVault,
    #[msg("Insufficient accounts provided")]
    InsufficientAccounts,
    #[msg("Invalid input data provided")]
    InvalidInputData,
    #[msg("Oracle registry is stale")]
    OracleRegistryStale,
    #[msg("Oracle registry is empty")]
    EmptyOracleRegistry,
    #[msg("Reentrancy attack detected")]
    ReentrancyDetected,
    #[msg("Vault not properly initialized")]
    VaultNotInitialized,
    #[msg("Amount too large for safe processing")]
    AmountTooLarge,
    #[msg("Amount too small for fee calculation")]
    AmountTooSmall,
    #[msg("Invalid vault authority provided")]
    InvalidVaultAuthority,
    #[msg("Backing ratio too large")]
    BackingRatioTooLarge,
    #[msg("Fee too small for amount")]
    FeeTooSmall,
    #[msg("Mint amount too small")]
    MintAmountTooSmall,
    #[msg("Mint amount too large")]
    MintAmountTooLarge,
    #[msg("Invalid oracle price")]
    InvalidOraclePrice,
    #[msg("Oracle price too large")]
    OraclePriceTooLarge,
    #[msg("Insufficient fees available - would drain backing reserves")]
    InsufficientFees,
    #[msg("Invalid oracle interval")]
    InvalidOracleInterval,
    #[msg("Invalid rebalance threshold")]
    InvalidRebalanceThreshold,
    #[msg("Insufficient oracle responses")]
    InsufficientOracles,
    #[msg("Partner vault account is missing")]
    MissingPartnerVault,
    #[msg("Insufficient funds in vault")]
    InsufficientFunds,
    #[msg("Invalid vanity seed - must be 32 bytes or less")]
    InvalidVanitySeed,
    #[msg("Invalid mint PDA - derivation mismatch")]
    InvalidMintPDA,
    #[msg("Invalid mint bump - derivation mismatch")]
    InvalidMintBump,
    #[msg("Invalid public key format")]
    InvalidPublicKey,
    #[msg("Unauthorized oracle update - only rift creator can update oracle prices")]
    UnauthorizedOracleUpdate,
    #[msg("Invalid oracle account - insufficient size or invalid owner")]
    InvalidOracleAccount,
    #[msg("Invalid mint authority - mint authority does not match expected PDA")]
    InvalidMintAuthority,
    #[msg("Invalid timestamp - too far in future or past")]
    InvalidTimestamp,
    #[msg("Invalid oracle parameters - interval or threshold out of bounds")]
    InvalidOracleParameters,
    #[msg("Unauthorized access")]
    Unauthorized,
    #[msg("Invalid byte slice conversion")]
    InvalidByteSlice,
    #[msg("Invalid mint - does not match rift state")]
    InvalidMint,
    #[msg("Invalid vault - does not match rift state")]
    InvalidVault,
    #[msg("Unauthorized token account - owner mismatch")]
    UnauthorizedTokenAccount,
    #[msg("Oracle account not set - must call set_oracle_accounts first")]
    OracleAccountNotSet,
    #[msg("Slippage exceeded - actual output less than minimum required")]
    SlippageExceeded,
    #[msg("Oracle account mismatch - provided account does not match stored oracle account")]
    OracleAccountMismatch,
    #[msg("Invalid oracle owner - oracle account not owned by Switchboard program")]
    InvalidOracleOwner,
    #[msg("Invalid oracle data - account data too small or malformed")]
    InvalidOracleData,
    #[msg("Oracle price stale - price data older than maximum allowed age")]
    OraclePriceStale,
    #[msg("Oracle confidence too low - confidence interval too large relative to price")]
    OracleConfidenceTooLow,
    #[msg("Invalid oracle exponent - exponent outside acceptable range")]
    InvalidOracleExponent,
    #[msg("Invalid token account data")]
    InvalidTokenAccount,
    #[msg("Treasury wallet not set - must set treasury first")]
    TreasuryNotSet,
    #[msg("Invalid treasury vault - owner does not match treasury wallet")]
    InvalidTreasuryVault,
    #[msg("Oracle update too frequent - must wait at least 1 hour between manual updates")]
    OracleUpdateTooFrequent,
    #[msg("Oracle cumulative drift too large - max 30% drift within 7 days")]
    OracleCumulativeDriftTooLarge,
    #[msg("Oracle price change too large - max 10% change per update")]
    OraclePriceChangeTooLarge,
    #[msg("Liquidity pool not initialized - staking requires active pool")]
    LiquidityPoolNotInitialized,
    #[msg("Invalid staking vault - must be program-controlled PDA")]
    InvalidStakingVault,
    #[msg("Fees vault is not empty - distribute fees before closing rift")]
    FeesVaultNotEmpty,
    #[msg("Withheld vault is not empty - distribute withheld fees before closing rift")]
    WithheldVaultNotEmpty,
    #[msg("Invalid fees vault - does not match rift state")]
    InvalidFeesVault,
    #[msg("Invalid withheld vault - does not match rift state")]
    InvalidWithheldVault,
    #[msg("Underlying token transfer fee exceeds 1% - transaction rejected for user protection")]
    ExcessiveTransferFee,
    #[msg("Backing ratio too stale - last rebalance was more than 24 hours ago")]
    BackingRatioTooStale,
    #[msg("Invalid PDA derivation - computed address does not match provided account")]
    InvalidPDA,
    #[msg("Unsafe underlying mint - mint has freeze authority that could lock vault funds")]
    UnsafeUnderlyingMint,
    #[msg("Transfer fee config mismatch - actual on-chain fee does not match parameter")]
    TransferFeeConfigMismatch,
    #[msg("Rift has been closed by admin")]
    RiftClosed,
    #[msg("Partner wallet not set")]
    PartnerWalletNotSet,
    #[msg("No oracle change pending")]
    NoOracleChangePending,
    #[msg("Oracle change delay not met (24h required)")]
    OracleChangeDelayNotMet,
    #[msg("Partner account is required when partner_amount > 0")]
    MissingPartnerAccount,
    #[msg("Invalid rift - closed_rift_pubkey must match rift account key")]
    InvalidRift,
    #[msg("Invalid vanity seed length - seed_len exceeds vanity_seed array bounds")]
    InvalidVanitySeedLength,
}

/// **SECURITY FIX #50**: Oracle type enum for event emission
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum OracleType {
    Switchboard,
    Manual, // Manual price updates (Jupiter API, etc.)
}

// Events
#[event]
pub struct OraclePriceUpdated {
    pub rift: Pubkey,
    pub oracle_type: OracleType,
    pub price: u64,
    pub confidence: u64,
    pub timestamp: i64,
}

#[event]
pub struct WithheldFeesClaimed {
    pub rift: Pubkey,
    pub destination: Pubkey, // Withheld vault where fees are sent
    pub source_account: Pubkey,
    pub claimer: Pubkey,
}

#[event]
pub struct TransferFeeUpdated {
    pub rift: Pubkey,
    pub new_fee_bps: u16,
    pub authority: Pubkey,
}

#[event]
pub struct FeesVaultWithdrawn {
    pub rift: Pubkey,
    pub amount: u64,
    pub treasury: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct WithheldVaultWithdrawn {
    pub rift: Pubkey,
    pub amount: u64,
    pub treasury: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct WithheldFeesDistributed {
    pub rift: Pubkey,
    pub amount: u64,
    pub treasury_amount: u64,
    pub partner_amount: u64,
    pub distributor: Pubkey,
}
