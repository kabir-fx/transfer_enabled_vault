import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  SystemProgram,
  Transaction,
  Keypair,
  PublicKey,
  Connection,
} from "@solana/web3.js";
import { LiteSVM } from "litesvm";
import { WhitelistTransferHook } from "../target/types/whitelist_transfer_hook";
import path from "path";

describe("whitelist-transfer-hook", () => {
  // ---- LiteSVM setup ----
  let svm: LiteSVM;

  // Keypairs
  const wallet = Keypair.generate();
  const mint2022 = Keypair.generate();
  const recipient = Keypair.generate();

  // Program ID from Anchor.toml / IDL
  const programId = new PublicKey(
    "H7N63tnhQaS6VJb3bAoqGwycD55cNV5Nn8qpNG4EPESd",
  );

  // Anchor program instance (used only to build instructions)
  let program: Program<WhitelistTransferHook>;

  // Derived addresses (computed after setup)
  let sourceTokenAccount: PublicKey;
  let destinationTokenAccount: PublicKey;
  let extraAccountMetaListPDA: PublicKey;
  let whitelist: PublicKey;
  let whitelistEntry: PublicKey;

  // Helper: build, sign and send a transaction through LiteSVM
  function sendTx(
    instructions: anchor.web3.TransactionInstruction[],
    signers: Keypair[],
  ) {
    const tx = new Transaction().add(...instructions);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = wallet.publicKey;
    for (const s of signers) {
      tx.partialSign(s);
    }
    const res = svm.sendTransaction(tx);
    return res;
  }

  before(() => {
    // 1. Boot LiteSVM
    svm = new LiteSVM();

    // 2. Load the compiled program
    const soPath = path.join(
      __dirname,
      "..",
      "target",
      "deploy",
      "transfer_enabled_vault.so",
    );
    svm.addProgramFromFile(programId, soPath);

    // 3. Fund the wallet and recipient
    svm.airdrop(wallet.publicKey, BigInt(100_000_000_000)); // 100 SOL
    svm.airdrop(recipient.publicKey, BigInt(1_000_000_000)); // 1 SOL

    // 4. Build a dummy Anchor provider so we can use program.methods.xxx().instruction()
    const dummyConnection = new Connection("http://localhost:8899"); // not actually used
    const dummyWallet = new anchor.Wallet(wallet);
    const dummyProvider = new anchor.AnchorProvider(
      dummyConnection,
      dummyWallet,
      { commitment: "confirmed" },
    );

    // Load IDL and create Program instance
    const idl = require("../target/idl/whitelist_transfer_hook.json");
    program = new Program<WhitelistTransferHook>(idl, dummyProvider);

    // 5. Pre-derive addresses
    sourceTokenAccount = getAssociatedTokenAddressSync(
      mint2022.publicKey,
      wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    destinationTokenAccount = getAssociatedTokenAddressSync(
      mint2022.publicKey,
      recipient.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    [extraAccountMetaListPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), mint2022.publicKey.toBuffer()],
      programId,
    );

    whitelist = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist")],
      programId,
    )[0];

    whitelistEntry = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), wallet.publicKey.toBytes()],
      programId,
    )[0];
  });

  // Helper: get vault (ATA of mint for wallet via Token-2022)
  const getVaultAddress = () =>
    getAssociatedTokenAddressSync(
      mint2022.publicKey,
      wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

  it("Create Mint Account with Transfer Hook Extension", async () => {
    const ix = await program.methods
      .createMint()
      .accountsPartial({
        payer: wallet.publicKey,
        mint: mint2022.publicKey,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    const res = sendTx([ix], [wallet, mint2022]);
    console.log("\nCreate Mint tx sent via LiteSVM");
  });

  it("Initializes the Whitelist", async () => {
    const ix = await program.methods
      .initializeWhitelist()
      .accountsPartial({
        admin: wallet.publicKey,
        whitelist,
        tokenMint: mint2022.publicKey,
        vault: getVaultAddress(),
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const res = sendTx([ix], [wallet]);
    console.log("\nWhitelist initialized:", whitelist.toBase58());
  });

  it("Add user to whitelist", async () => {
    const ix = await program.methods
      .addToWhitelist(wallet.publicKey)
      .accountsPartial({
        admin: wallet.publicKey,
        whitelist,
        whitelistEntry,
      })
      .instruction();

    const res = sendTx([ix], [wallet]);
    console.log("\nUser added to whitelist:", wallet.publicKey.toBase58());
  });

  it("Create Token Accounts and Mint Tokens", async () => {
    // 100 tokens
    const amount = 100 * 10 ** 9;

    // sourceTokenAccount (vault) was already created in initializeWhitelist,
    // so we only create the destination ATA and mint tokens.
    const createDestAtaIx = createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      destinationTokenAccount,
      recipient.publicKey,
      mint2022.publicKey,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const mintToIx = createMintToInstruction(
      mint2022.publicKey,
      sourceTokenAccount,
      wallet.publicKey,
      amount,
      [],
      TOKEN_2022_PROGRAM_ID,
    );

    const res = sendTx([createDestAtaIx, mintToIx], [wallet]);
    console.log("\nToken accounts created and tokens minted");
  });

  it("Create ExtraAccountMetaList Account", async () => {
    const ix = await program.methods
      .initializeTransferHook()
      .accountsPartial({
        payer: wallet.publicKey,
        mint: mint2022.publicKey,
        extraAccountMetaList: extraAccountMetaListPDA,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const res = sendTx([ix], [wallet]);
    console.log(
      "\nExtraAccountMetaList Account created:",
      extraAccountMetaListPDA.toBase58(),
    );
  });

  it("Transfer Hook with Extra Account Meta", async () => {
    // Derive whitelist entries
    const [destWhitelistEntry] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), recipient.publicKey.toBytes()],
      programId,
    );

    // 1. Whitelist the recipient
    const whitelistIx = await program.methods
      .addToWhitelist(recipient.publicKey)
      .accounts({
        admin: wallet.publicKey,
        whitelist,
        whitelistEntry: destWhitelistEntry,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    sendTx([whitelistIx], [wallet]);
    console.log("Recipient whitelisted:", recipient.publicKey.toBase58());

    // Need a fresh blockhash for the next transaction
    svm.expireBlockhash();

    // 2. Build the transfer instruction with extra accounts for the hook
    const amount = 1 * 10 ** 9;
    const amountBigInt = BigInt(amount);

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

    // Derive source whitelist entry
    const [sourceWhitelistEntry] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), wallet.publicKey.toBytes()],
      programId,
    );

    // Append extra accounts required by the hook
    transferInstruction.keys.push(
      { pubkey: extraAccountMetaListPDA, isSigner: false, isWritable: false },
      { pubkey: whitelist, isSigner: false, isWritable: false },
      { pubkey: sourceWhitelistEntry, isSigner: false, isWritable: false },
      { pubkey: destWhitelistEntry, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
    );

    const res = sendTx([transferInstruction], [wallet]);
    console.log("Transfer completed via LiteSVM");
  });

  it("Remove user from whitelist (cleanup)", async () => {
    // Expire blockhash so we get a fresh one
    svm.expireBlockhash();

    const ix = await program.methods
      .removeFromWhitelist(wallet.publicKey)
      .accountsPartial({
        admin: wallet.publicKey,
        whitelistEntry,
      })
      .instruction();

    const res = sendTx([ix], [wallet]);
    console.log("\nUser removed from whitelist:", wallet.publicKey.toBase58());
  });
});
