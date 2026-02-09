use anchor_lang::prelude::*;

#[account]
pub struct Whitelist {
    pub bump: u8,
    pub token_mint: Pubkey,
    pub admin: Pubkey,
    pub vault_mint: Pubkey,
}
