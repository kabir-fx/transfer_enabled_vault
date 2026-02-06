use anchor_lang::prelude::*;

declare_id!("H7N63tnhQaS6VJb3bAoqGwycD55cNV5Nn8qpNG4EPESd");

#[program]
pub mod transfer_enabled_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
