/**
 * Transaction Sender - Handles Solana transactions for arena lifecycle
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

// Program constants
const PROGRAM_ID = new PublicKey(config.programId);

// Instruction discriminators - sha256("global:instruction_name")[0..8]
const DISCRIMINATORS = {
  setStartPrice: Buffer.from([172, 199, 165, 159, 199, 210, 161, 245]),
  setEndPrice: Buffer.from([53, 149, 82, 113, 237, 242, 171, 28]),
  finalizeArena: Buffer.from([66, 155, 212, 24, 174, 62, 93, 81]),
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
   * Derive PDAs for arena operations
   */
  getGlobalStatePda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('global_state_v2')],
      PROGRAM_ID
    );
    return pda;
  }
  
  getArenaPda(arenaId: bigint): PublicKey {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(arenaId);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('arena_v2'), buffer],
      PROGRAM_ID
    );
    return pda;
  }
  
  getArenaAssetPda(arenaPda: PublicKey, assetIndex: number): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('arena_asset_v2'), arenaPda.toBuffer(), Buffer.from([assetIndex])],
      PROGRAM_ID
    );
    return pda;
  }
  
  /**
   * Set start price for an asset
   */
  async setStartPrice(arenaId: bigint, assetIndex: number, price: bigint): Promise<string> {
    const globalStatePda = this.getGlobalStatePda();
    const arenaPda = this.getArenaPda(arenaId);
    const arenaAssetPda = this.getArenaAssetPda(arenaPda, assetIndex);
    
    // Build instruction data: discriminator + price (u64)
    const priceBuffer = Buffer.alloc(8);
    priceBuffer.writeBigUInt64LE(price);
    const data = Buffer.concat([DISCRIMINATORS.setStartPrice, priceBuffer]);
    
    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: globalStatePda, isSigner: false, isWritable: false },
        { pubkey: arenaPda, isSigner: false, isWritable: true },
        { pubkey: arenaAssetPda, isSigner: false, isWritable: true },
        { pubkey: this.adminKeypair.publicKey, isSigner: true, isWritable: false },
      ],
      data,
    });
    
    return this.sendTransaction([instruction], `setStartPrice(arena=${arenaId}, asset=${assetIndex})`);
  }
  
  /**
   * Set end price for an asset
   */
  async setEndPrice(arenaId: bigint, assetIndex: number, price: bigint): Promise<string> {
    const globalStatePda = this.getGlobalStatePda();
    const arenaPda = this.getArenaPda(arenaId);
    const arenaAssetPda = this.getArenaAssetPda(arenaPda, assetIndex);
    
    // Build instruction data: discriminator + price (u64)
    const priceBuffer = Buffer.alloc(8);
    priceBuffer.writeBigUInt64LE(price);
    const data = Buffer.concat([DISCRIMINATORS.setEndPrice, priceBuffer]);
    
    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: globalStatePda, isSigner: false, isWritable: false },
        { pubkey: arenaPda, isSigner: false, isWritable: true },
        { pubkey: arenaAssetPda, isSigner: false, isWritable: true },
        { pubkey: this.adminKeypair.publicKey, isSigner: true, isWritable: false },
      ],
      data,
    });
    
    return this.sendTransaction([instruction], `setEndPrice(arena=${arenaId}, asset=${assetIndex})`);
  }
  
  /**
   * Finalize arena and determine winner
   */
  async finalizeArena(arenaId: bigint, assetIndices: number[]): Promise<string> {
    const globalStatePda = this.getGlobalStatePda();
    const arenaPda = this.getArenaPda(arenaId);
    
    // Get all arena asset PDAs as remaining accounts
    const remainingAccounts = assetIndices.map(assetIndex => ({
      pubkey: this.getArenaAssetPda(arenaPda, assetIndex),
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
      data: DISCRIMINATORS.finalizeArena,
    });
    
    return this.sendTransaction([instruction], `finalizeArena(arena=${arenaId})`);
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
   * Get arena info from chain
   */
  async getArenaInfo(arenaId: bigint): Promise<{
    status: number;
    assetCount: number;
    endTimestamp: bigint;
    winningAsset: number;
  } | null> {
    try {
      const arenaPda = this.getArenaPda(arenaId);
      const accountInfo = await this.connection.getAccountInfo(arenaPda);
      
      if (!accountInfo) return null;
      
      const data = accountInfo.data;
      // Parse arena data (skip 8 byte discriminator)
      // id: u64, status: u8, player_count: u8, asset_count: u8, prices_set: u8,
      // end_prices_set: u8, winning_asset: u8, is_suspended: bool, bump: u8,
      // start_timestamp: i64, end_timestamp: i64, total_pool: u64
      
      return {
        status: data[16],
        assetCount: data[18],
        endTimestamp: data.readBigInt64LE(24 + 8), // offset to end_timestamp
        winningAsset: data[21],
      };
    } catch (error) {
      logger.error({ arenaId: arenaId.toString(), error }, 'Failed to get arena info');
      return null;
    }
  }
  
  /**
   * Get assets in an arena
   */
  async getArenaAssets(arenaId: bigint): Promise<number[]> {
    const assets: number[] = [];
    const arenaPda = this.getArenaPda(arenaId);
    
    for (let i = 0; i < 14; i++) {
      try {
        const assetPda = this.getArenaAssetPda(arenaPda, i);
        const accountInfo = await this.connection.getAccountInfo(assetPda);
        
        if (accountInfo && accountInfo.data.length > 0) {
          // Check player count (offset 33 after discriminator + arena pubkey)
          const playerCount = accountInfo.data[8 + 32 + 1];
          if (playerCount > 0) {
            assets.push(i);
          }
        }
      } catch {
        // Asset doesn't exist, continue
      }
    }
    
    return assets;
  }
}

export default TransactionSender;
