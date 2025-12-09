/**
 * Transaction Sender - Handles Solana transactions for arena lifecycle (cryptarena-sol)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';
import config from '../../config';
import logger from '../../utils/logger';
import prisma from '../../db';

// Program constants
const PROGRAM_ID = new PublicKey(config.programId);

// Instruction discriminators from cryptarena_sol IDL
const DISCRIMINATORS = {
  setStartPrice: Buffer.from([172, 199, 165, 159, 199, 210, 161, 245]),
  setEndPrice: Buffer.from([53, 149, 82, 113, 237, 242, 171, 28]),
  startArena: Buffer.from([76, 99, 3, 235, 111, 167, 248, 5]),
  endArena: Buffer.from([194, 154, 62, 175, 137, 204, 45, 164]),
};

export class TransactionSender {
  private connection: Connection;
  private adminKeypair: Keypair;
  
  constructor() {
    this.connection = new Connection(config.solanaRpcUrl, 'confirmed');
    
    // Load admin keypair from environment
    const privateKey = process.env.ADMIN_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('ADMIN_PRIVATE_KEY environment variable not set');
    }
    
    try {
      // Try base58 format first
      this.adminKeypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    } catch {
      // Try JSON array format
      try {
        const keyArray = JSON.parse(privateKey);
        this.adminKeypair = Keypair.fromSecretKey(Uint8Array.from(keyArray));
      } catch {
        throw new Error('Invalid ADMIN_PRIVATE_KEY format. Use base58 or JSON array.');
      }
    }
    
    logger.info({ admin: this.adminKeypair.publicKey.toString() }, 'TransactionSender initialized');
  }
  
  /**
   * Derive PDAs for arena operations (cryptarena-sol)
   */
  getGlobalStatePda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('global_state')],
      PROGRAM_ID
    );
    return pda;
  }
  
  getArenaPda(arenaId: bigint): PublicKey {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(arenaId);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('arena'), buffer],
      PROGRAM_ID
    );
    return pda;
  }
  
  getPlayerEntryPda(arenaPda: PublicKey, playerPubkey: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('player_entry'), arenaPda.toBuffer(), playerPubkey.toBuffer()],
      PROGRAM_ID
    );
    return pda;
  }
  
  /**
   * Set start price for a player's token (cryptarena-sol)
   * In cryptarena-sol, prices are stored on PlayerEntry accounts
   */
  async setStartPrice(arenaId: bigint, playerWallet: string, price: bigint): Promise<string> {
    const globalStatePda = this.getGlobalStatePda();
    const arenaPda = this.getArenaPda(arenaId);
    const playerPubkey = new PublicKey(playerWallet);
    const playerEntryPda = this.getPlayerEntryPda(arenaPda, playerPubkey);
    
    // Build instruction data: discriminator + price (u64)
    const priceBuffer = Buffer.alloc(8);
    priceBuffer.writeBigUInt64LE(price);
    const data = Buffer.concat([DISCRIMINATORS.setStartPrice, priceBuffer]);
    
    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: globalStatePda, isSigner: false, isWritable: false },
        { pubkey: arenaPda, isSigner: false, isWritable: false },
        { pubkey: playerEntryPda, isSigner: false, isWritable: true },
        { pubkey: this.adminKeypair.publicKey, isSigner: true, isWritable: false },
      ],
      data,
    });
    
    return this.sendTransaction([instruction], `setStartPrice(arena=${arenaId}, player=${playerWallet.slice(0, 8)})`);
  }
  
  /**
   * Set end price for a player's token (cryptarena-sol)
   */
  async setEndPrice(arenaId: bigint, playerWallet: string, price: bigint): Promise<string> {
    const globalStatePda = this.getGlobalStatePda();
    const arenaPda = this.getArenaPda(arenaId);
    const playerPubkey = new PublicKey(playerWallet);
    const playerEntryPda = this.getPlayerEntryPda(arenaPda, playerPubkey);
    
    // Build instruction data: discriminator + price (u64)
    const priceBuffer = Buffer.alloc(8);
    priceBuffer.writeBigUInt64LE(price);
    const data = Buffer.concat([DISCRIMINATORS.setEndPrice, priceBuffer]);
    
    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: globalStatePda, isSigner: false, isWritable: false },
        { pubkey: arenaPda, isSigner: false, isWritable: false },
        { pubkey: playerEntryPda, isSigner: false, isWritable: true },
        { pubkey: this.adminKeypair.publicKey, isSigner: true, isWritable: false },
      ],
      data,
    });
    
    return this.sendTransaction([instruction], `setEndPrice(arena=${arenaId}, player=${playerWallet.slice(0, 8)})`);
  }
  
  /**
   * Start arena (cryptarena-sol) - admin only
   */
  async startArena(arenaId: bigint): Promise<string> {
    const globalStatePda = this.getGlobalStatePda();
    const arenaPda = this.getArenaPda(arenaId);
    
    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: globalStatePda, isSigner: false, isWritable: true },
        { pubkey: arenaPda, isSigner: false, isWritable: true },
        { pubkey: this.adminKeypair.publicKey, isSigner: true, isWritable: false },
      ],
      data: DISCRIMINATORS.startArena,
    });
    
    return this.sendTransaction([instruction], `startArena(arena=${arenaId})`);
  }
  
  /**
   * End arena and determine winner (cryptarena-sol)
   * Requires all PlayerEntry PDAs as remaining accounts
   */
  async endArena(arenaId: bigint, playerWallets: string[]): Promise<string> {
    const globalStatePda = this.getGlobalStatePda();
    const arenaPda = this.getArenaPda(arenaId);
    
    // Get all player entry PDAs as remaining accounts
    const remainingAccounts = playerWallets.map(wallet => ({
      pubkey: this.getPlayerEntryPda(arenaPda, new PublicKey(wallet)),
      isSigner: false,
      isWritable: false,
    }));
    
    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: globalStatePda, isSigner: false, isWritable: false },
        { pubkey: arenaPda, isSigner: false, isWritable: true },
        { pubkey: this.adminKeypair.publicKey, isSigner: true, isWritable: false },
        ...remainingAccounts,
      ],
      data: DISCRIMINATORS.endArena,
    });
    
    return this.sendTransaction([instruction], `endArena(arena=${arenaId})`);
  }
  
  /**
   * Send transaction with compute budget and retry logic
   */
  private async sendTransaction(instructions: TransactionInstruction[], description: string): Promise<string> {
    const transaction = new Transaction();
    
    // Add compute budget for complex operations
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
    );
    
    // Add main instructions
    instructions.forEach(ix => transaction.add(ix));
    
    // Get recent blockhash
    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = this.adminKeypair.publicKey;
    
    // Sign and send
    const signature = await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [this.adminKeypair],
      { commitment: 'confirmed' }
    );
    
    logger.info({ description, signature }, 'Transaction sent successfully');
    
    return signature;
  }
  
  /**
   * Get arena info from chain (cryptarena-sol)
   */
  async getArenaInfo(arenaId: bigint): Promise<{
    status: number;
    playerCount: number;
    endTimestamp: bigint;
    winningAsset: number;
    isCanceled: boolean;
  } | null> {
    try {
      const arenaPda = this.getArenaPda(arenaId);
      const accountInfo = await this.connection.getAccountInfo(arenaPda);
      
      if (!accountInfo) return null;
      
      const data = accountInfo.data;
      // Parse arena data (skip 8 byte discriminator)
      // id: u64, status: u8, player_count: u8, winning_asset: u8, is_canceled: bool,
      // treasury_claimed: bool, bump: u8, start_timestamp: i64, end_timestamp: i64, total_pool: u64
      
      let offset = 8; // skip discriminator
      offset += 8; // skip id
      const status = data[offset];
      offset += 1;
      const playerCount = data[offset];
      offset += 1;
      const winningAsset = data[offset];
      offset += 1;
      const isCanceled = data[offset] === 1;
      offset += 1;
      offset += 1; // treasury_claimed
      offset += 1; // bump
      offset += 8; // start_timestamp
      const endTimestamp = data.readBigInt64LE(offset);
      
      return {
        status,
        playerCount,
        endTimestamp,
        winningAsset,
        isCanceled,
      };
    } catch (error) {
      logger.error({ arenaId: arenaId.toString(), error }, 'Failed to get arena info');
      return null;
    }
  }
  
  /**
   * Get player wallets in an arena from database
   */
  async getArenaPlayers(arenaId: bigint): Promise<string[]> {
    const entries = await prisma.playerEntry.findMany({
      where: { arenaId },
      select: { playerWallet: true },
    });
    
    return entries.map(e => e.playerWallet);
  }
}

export default TransactionSender;
