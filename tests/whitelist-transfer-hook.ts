import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createInitializeMintInstruction,
  getMintLen,
  ExtensionType,
  createTransferCheckedWithTransferHookInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeTransferHookInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import {
  SendTransactionError,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { WhitelistTransferHook } from "../target/types/whitelist_transfer_hook";

describe("whitelist-transfer-hook", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const wallet = provider.wallet as anchor.Wallet;

  const program = anchor.workspace
    .whitelistTransferHook as Program<WhitelistTransferHook>;

  const mint2022 = anchor.web3.Keypair.generate();

  // Vault must be an ATA derived from the mint and admin (wallet)
  // This is derived AFTER mint creation, but declared here as a function
  // to compute it when needed (since mint2022 pubkey is known at declaration time)
  const getVaultAddress = () =>
    getAssociatedTokenAddressSync(
      mint2022.publicKey,
      wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

  // Sender token account address
  const sourceTokenAccount = getAssociatedTokenAddressSync(
    mint2022.publicKey,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Recipient token account address
  const recipient = anchor.web3.Keypair.generate();
  const destinationTokenAccount = getAssociatedTokenAddressSync(
    mint2022.publicKey,
    recipient.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // ExtraAccountMetaList address
  // Store extra accounts required by the custom transfer hook instruction
  const [extraAccountMetaListPDA] =
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), mint2022.publicKey.toBuffer()],
      program.programId,
    );

  const whitelist = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist")],
    program.programId,
  )[0];

  const whitelistEntry = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), provider.publicKey.toBytes()],
    program.programId,
  )[0];

  it("Create Mint Account with Transfer Hook Extension", async () => {
    const txSig = await program.methods
      .createMint()
      .accountsPartial({
        payer: wallet.publicKey,
        mint: mint2022.publicKey,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([mint2022])
      .rpc();

    const txDetails = await program.provider.connection.getTransaction(txSig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    //console.log(txDetails.meta.logMessages);

    console.log("\nTransaction Signature: ", txSig);
  });

  it("Initializes the Whitelist", async () => {
    const tx = await program.methods
      .initializeWhitelist()
      .accountsPartial({
        admin: provider.publicKey,
        whitelist,
        tokenMint: mint2022.publicKey,
        vault: getVaultAddress(),
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("\nWhitelist initialized:", whitelist.toBase58());
    console.log("Transaction signature:", tx);
  });

  it("Add user to whitelist", async () => {
    const tx = await program.methods
      .addToWhitelist(provider.publicKey)
      .accountsPartial({
        admin: provider.publicKey,
        whitelist,
        whitelistEntry,
      })
      .rpc();

    console.log("\nUser added to whitelist:", provider.publicKey.toBase58());
    console.log("Transaction signature:", tx);
  });

  it("Create Token Accounts and Mint Tokens", async () => {
    // 100 tokens
    const amount = 100 * 10 ** 9;

    // NOTE: sourceTokenAccount is the same as vault (both derived from mint + wallet)
    // The vault was already created in initializeWhitelist, so we only create destination
    const transaction = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        destinationTokenAccount,
        recipient.publicKey,
        mint2022.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createMintToInstruction(
        mint2022.publicKey,
        sourceTokenAccount,
        wallet.publicKey,
        amount,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    );

    const txSig = await sendAndConfirmTransaction(
      provider.connection,
      transaction,
      [wallet.payer],
      { skipPreflight: true },
    );

    console.log("\nTransaction Signature: ", txSig);
  });

  // Account to store extra accounts required by the transfer hook instruction
  it("Create ExtraAccountMetaList Account", async () => {
    const initializeExtraAccountMetaListInstruction = await program.methods
      .initializeTransferHook()
      .accountsPartial({
        payer: wallet.publicKey,
        mint: mint2022.publicKey,
        extraAccountMetaList: extraAccountMetaListPDA,
        systemProgram: SystemProgram.programId,
      })
      //.instruction();
      .rpc();

    //const transaction = new Transaction().add(initializeExtraAccountMetaListInstruction);

    //const txSig = await sendAndConfirmTransaction(provider.connection, transaction, [wallet.payer], { skipPreflight: true, commitment: 'confirmed' });
    console.log(
      "\nExtraAccountMetaList Account created:",
      extraAccountMetaListPDA.toBase58(),
    );
    console.log(
      "Transaction Signature:",
      initializeExtraAccountMetaListInstruction,
    );
  });

  it("Transfer Hook with Extra Account Meta", async () => {
    // Derive whitelist entries first
    const [destWhitelistEntry] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), recipient.publicKey.toBytes()],
      program.programId,
    );

    // 1. Whitelist the recipient so their whitelist entry exists
    await program.methods
      .addToWhitelist(recipient.publicKey)
      .accounts({
        admin: provider.publicKey,
        whitelist,
        whitelistEntry: destWhitelistEntry,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("Recipient whitelisted:", recipient.publicKey.toBase58());

    const amount = 1 * 10 ** 9;
    const amountBigInt = BigInt(amount);

    // 2. Create the base transfer instruction
    const transferInstruction = createTransferCheckedInstruction(
      sourceTokenAccount,
      mint2022.publicKey,
      destinationTokenAccount,
      wallet.publicKey,
      amountBigInt,
      9,
      [],
      TOKEN_2022_PROGRAM_ID,
    );

    // 3. Manually add extra accounts required by the hook
    // Order: [extraMeta, whitelist, sourceEntry, destEntry, programId]

    // Derive whitelist entries
    const [sourceWhitelistEntry] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), wallet.publicKey.toBytes()],
      program.programId,
    );

    // Append accounts to the instruction
    transferInstruction.keys.push(
      // ExtraAccountMetaList PDA
      { pubkey: extraAccountMetaListPDA, isSigner: false, isWritable: false },
      // Whitelist PDA (Account 5 in TransferHook context? No, strictly following ExtraAccountMetaList definition)
      { pubkey: whitelist, isSigner: false, isWritable: false },
      // Source Whitelist Entry
      { pubkey: sourceWhitelistEntry, isSigner: false, isWritable: false },
      // Destination Whitelist Entry
      { pubkey: destWhitelistEntry, isSigner: false, isWritable: false },
      // Transfer hook program (Account Executing the hook)
      { pubkey: program.programId, isSigner: false, isWritable: false },
    );

    const transaction = new Transaction().add(transferInstruction);

    try {
      const txSig = await sendAndConfirmTransaction(
        provider.connection,
        transaction,
        [wallet.payer],
        { skipPreflight: true, commitment: "finalized" },
      );
      console.log("Transfer Signature:", txSig);
    } catch (error) {
      console.error("Transfer failed", error);
      throw error;
    }
  });

  it("Remove user from whitelist (cleanup)", async () => {
    const tx = await program.methods
      .removeFromWhitelist(provider.publicKey)
      .accountsPartial({
        admin: provider.publicKey,
        whitelistEntry,
      })
      .rpc();

    console.log(
      "\nUser removed from whitelist:",
      provider.publicKey.toBase58(),
    );
    console.log("Transaction signature:", tx);
  });
});
