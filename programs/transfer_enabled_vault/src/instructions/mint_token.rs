use crate::state::Whitelist;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::{
    token_2022::spl_token_2022::{
        extension::{
            transfer_hook::instruction::initialize as initialize_transfer_hook, ExtensionType,
        },
        instruction as token_instruction,
        state::Mint as MintState,
    },
    token_interface::TokenInterface,
};

#[derive(Accounts)]
pub struct CreateMint<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub mint: Signer<'info>,

    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

impl<'info> CreateMint<'info> {
    pub fn create_mint(&mut self) -> Result<()> {
        let size =
            ExtensionType::try_calculate_account_len::<MintState>(&[ExtensionType::TransferHook])?;

        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(size);

        // 1. Create Account
        anchor_lang::system_program::create_account(
            CpiContext::new(
                self.system_program.to_account_info(),
                anchor_lang::system_program::CreateAccount {
                    from: self.payer.to_account_info(),
                    to: self.mint.to_account_info(),
                },
            ),
            lamports,
            size as u64,
            &self.token_program.key(),
        )?;

        // 2. Initialize Transfer Hook Extension
        invoke(
            &initialize_transfer_hook(
                &self.token_program.key(),
                &self.mint.key(),
                Some(self.payer.key()), // Authority
                Some(crate::ID),        // Transfer Hook Program ID (this program)
            )?,
            &[
                self.token_program.to_account_info(),
                self.mint.to_account_info(),
            ],
        )?;

        // 3. Initialize Mint
        invoke(
            &token_instruction::initialize_mint(
                &self.token_program.key(),
                &self.mint.key(),
                &self.payer.key(), // Mint Authority
                None,              // Freeze Authority
                9,                 // Decimals
            )?,
            &[
                self.token_program.to_account_info(),
                self.mint.to_account_info(),
                self.rent.to_account_info(),
            ],
        )?;

        Ok(())
    }
}
