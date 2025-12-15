/**
 * Bot Filler Service
 * 
 * Automatically fills waiting arenas with bot players when there's inactivity.
 * Uses test wallets from cryptarena-svm/test-wallets to enter arenas.
 * 
 * Flow:
 * - Monitor waiting arenas for 1 minute of inactivity (no new players)
 * - When inactivity detected, add a bot player with a random unused token
 * - Airdrop 0.1 SOL to bot wallet if needed
 * - Repeat until arena is full (10 players)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SystemProgram,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import db from '../../db';
import logger from '../../utils/logger';
import config from '../../config';
import lifecycleConfig from './config';
import { ArenaStatus, ASSETS } from '../../types/accounts';

// Program constants
const PROGRAM_ID = new PublicKey(config.programId);

// Instruction discriminator for enterArena (from IDL)
const ENTER_ARENA_DISCRIMINATOR = Buffer.from([237, 44, 241, 163, 152, 39, 13, 181]);

export class BotFiller {
  private connection: Connection;
  private funderKeypair: Keypair | null = null;
  private botWallets: Keypair[] = [];
  private isRunning: boolean = false;
  private checkInterval: NodeJS.Timeout | null = null;
  
  // Track last activity per arena (arenaId -> timestamp)
  private arenaLastActivity: Map<bigint, Date> = new Map();
  
  // Track which bot wallets are used in which arena (arenaId -> Set of wallet pubkeys)
  private botsInArena: Map<bigint, Set<string>> = new Map();
  
  constructor() {
    this.connection = new Connection(config.solanaRpcUrl, 'confirmed');
  }
  
  /**
   * Initialize the bot filler - load wallets
   */
  async initialize(): Promise<boolean> {
    if (!lifecycleConfig.botFiller.enabled) {
      logger.info('Bot filler is disabled in config');
      return false;
    }
    
    // Load funder wallet from env
    const funderPrivateKey = process.env.BOT_FUNDER_PRIVATE_KEY;
    if (!funderPrivateKey) {
      logger.warn('BOT_FUNDER_PRIVATE_KEY not set - bot filler will not be able to airdrop SOL');
    } else {
      try {
        // Try base58 format first
        this.funderKeypair = Keypair.fromSecretKey(bs58.decode(funderPrivateKey));
      } catch {
        // Try JSON array format
        try {
          const keyArray = JSON.parse(funderPrivateKey);
          this.funderKeypair = Keypair.fromSecretKey(Uint8Array.from(keyArray));
        } catch {
          logger.error('Invalid BOT_FUNDER_PRIVATE_KEY format. Use base58 or JSON array.');
          return false;
        }
      }
      logger.info({ funder: this.funderKeypair.publicKey.toString() }, 'Loaded funder wallet');
    }
    
    // Load bot wallets from bot-wallets directory (copied from cryptarena-svm/test-wallets)
    const testWalletsDir = path.resolve(__dirname, '../../../bot-wallets');
    
    for (let i = 1; i <= 10; i++) {
      const walletPath = path.join(testWalletsDir, `player${i}.json`);
      try {
        if (fs.existsSync(walletPath)) {
          const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
          const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
          this.botWallets.push(keypair);
        }
      } catch (error) {
        logger.warn({ walletPath, error }, 'Failed to load bot wallet');
      }
    }
    
    if (this.botWallets.length === 0) {
      logger.error('No bot wallets loaded - bot filler cannot function');
      return false;
    }
    
    logger.info({ count: this.botWallets.length }, 'Loaded bot wallets');
    return true;
  }
  
  /**
   * Start the bot filler service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Bot filler already running');
      return;
    }
    
    const initialized = await this.initialize();
    if (!initialized) {
      logger.warn('Bot filler initialization failed, not starting');
      return;
    }
    
    this.isRunning = true;
    
    // Start the check interval
    this.checkInterval = setInterval(
      () => this.checkAndFillArenas(),
      lifecycleConfig.botFiller.checkIntervalMs
    );
    
    logger.info({
      inactivityTimeoutMs: lifecycleConfig.botFiller.inactivityTimeoutMs,
      checkIntervalMs: lifecycleConfig.botFiller.checkIntervalMs,
      botWallets: this.botWallets.length,
    }, 'Bot filler started');
  }
  
  /**
   * Stop the bot filler service
   */
  async stop(): Promise<void> {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.isRunning = false;
    logger.info('Bot filler stopped');
  }
  
  /**
   * Called when a player joins an arena - reset inactivity timer
   */
  onPlayerJoined(arenaId: bigint): void {
    this.arenaLastActivity.set(arenaId, new Date());
    logger.debug({ arenaId: arenaId.toString() }, 'Player joined, reset inactivity timer');
  }
  
  /**
   * Check all waiting arenas and fill if needed
   */
  private async checkAndFillArenas(): Promise<void> {
    try {
      // Find all waiting arenas
      const waitingArenas = await db.arena.findMany({
        where: {
          status: ArenaStatus.Waiting,
          playerCount: { gte: 1, lt: lifecycleConfig.botFiller.maxPlayersPerArena },
        },
        include: {
          playerEntries: {
            select: { playerWallet: true, assetIndex: true, createdAt: true },
          },
        },
      });
      
      for (const arena of waitingArenas) {
        await this.checkArenaForBotFill(arena);
      }
    } catch (error) {
      logger.error({ error }, 'Error checking arenas for bot fill');
    }
  }
  
  /**
   * Check if a specific arena needs a bot fill
   */
  private async checkArenaForBotFill(arena: {
    arenaId: bigint;
    playerCount: number;
    playerEntries: { playerWallet: string; assetIndex: number; createdAt: Date }[];
  }): Promise<void> {
    const { arenaId, playerCount, playerEntries } = arena;
    
    // Check if arena is full
    if (playerCount >= lifecycleConfig.botFiller.maxPlayersPerArena) {
      return;
    }
    
    // Get last activity time (either from our tracking or from most recent player entry)
    let lastActivity = this.arenaLastActivity.get(arenaId);
    
    if (!lastActivity) {
      // Use the most recent player entry time
      const mostRecentEntry = playerEntries.reduce((latest, entry) => 
        entry.createdAt > latest ? entry.createdAt : latest, 
        new Date(0)
      );
      lastActivity = mostRecentEntry;
      this.arenaLastActivity.set(arenaId, lastActivity);
    }
    
    // Check if inactivity timeout has passed
    const inactivityMs = Date.now() - lastActivity.getTime();
    if (inactivityMs < lifecycleConfig.botFiller.inactivityTimeoutMs) {
      return;
    }
    
    logger.info({
      arenaId: arenaId.toString(),
      playerCount,
      inactivityMs,
    }, 'Arena inactive, adding bot player');
    
    // Get taken tokens in this arena
    const takenTokens = new Set(playerEntries.map(e => e.assetIndex));
    
    // Get bot wallets already in this arena
    const botsInThisArena = this.botsInArena.get(arenaId) || new Set();
    const usedBotWallets = playerEntries
      .map(e => e.playerWallet)
      .filter(wallet => this.botWallets.some(bw => bw.publicKey.toString() === wallet));
    
    usedBotWallets.forEach(w => botsInThisArena.add(w));
    this.botsInArena.set(arenaId, botsInThisArena);
    
    // Find an available bot wallet
    const availableBotWallet = this.botWallets.find(
      bw => !botsInThisArena.has(bw.publicKey.toString())
    );
    
    if (!availableBotWallet) {
      logger.warn({ arenaId: arenaId.toString() }, 'No available bot wallets for arena');
      return;
    }
    
    // Find an available token (not already taken)
    const availableTokens = ASSETS.filter(a => !takenTokens.has(a.index));
    if (availableTokens.length === 0) {
      logger.warn({ arenaId: arenaId.toString() }, 'No available tokens for bot');
      return;
    }
    
    // Pick a random available token
    const randomToken = availableTokens[Math.floor(Math.random() * availableTokens.length)];
    
    try {
      // Enter arena with bot
      await this.enterArenaWithBot(arenaId, availableBotWallet, randomToken.index);
      
      // Update tracking
      botsInThisArena.add(availableBotWallet.publicKey.toString());
      this.arenaLastActivity.set(arenaId, new Date());
      
      logger.info({
        arenaId: arenaId.toString(),
        botWallet: availableBotWallet.publicKey.toString().slice(0, 8) + '...',
        token: randomToken.symbol,
        newPlayerCount: playerCount + 1,
      }, 'Bot player added to arena');
      
    } catch (error) {
      logger.error({
        arenaId: arenaId.toString(),
        botWallet: availableBotWallet.publicKey.toString().slice(0, 8) + '...',
        error,
      }, 'Failed to add bot player');
    }
  }
  
  /**
   * Enter an arena with a bot wallet
   */
  private async enterArenaWithBot(
    arenaId: bigint,
    botWallet: Keypair,
    assetIndex: number
  ): Promise<string> {
    // Check bot wallet balance
    const balance = await this.connection.getBalance(botWallet.publicKey);
    
    if (balance < lifecycleConfig.botFiller.minBalanceLamports) {
      logger.info({
        botWallet: botWallet.publicKey.toString().slice(0, 8) + '...',
        balance: balance / LAMPORTS_PER_SOL,
        required: lifecycleConfig.botFiller.minBalanceLamports / LAMPORTS_PER_SOL,
      }, 'Bot wallet has insufficient balance, airdropping SOL');
      
      await this.airdropSolToBot(botWallet.publicKey);
    }
    
    // Build enter arena instruction
    const globalStatePda = this.getGlobalStatePda();
    const arenaPda = this.getArenaPda(arenaId);
    const arenaVaultPda = this.getArenaVaultPda(arenaId);
    const playerEntryPda = this.getPlayerEntryPda(arenaPda, botWallet.publicKey);
    const whitelistTokenPda = this.getWhitelistTokenPda(assetIndex);
    
    // Instruction data: discriminator + asset_index (u8)
    const data = Buffer.concat([
      ENTER_ARENA_DISCRIMINATOR,
      Buffer.from([assetIndex]),
    ]);
    
    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: globalStatePda, isSigner: false, isWritable: true },
        { pubkey: arenaPda, isSigner: false, isWritable: true },
        { pubkey: arenaVaultPda, isSigner: false, isWritable: true },
        { pubkey: playerEntryPda, isSigner: false, isWritable: true },
        { pubkey: whitelistTokenPda, isSigner: false, isWritable: false },
        { pubkey: botWallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    
    const transaction = new Transaction();
    
    // Add compute budget
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
    );
    
    transaction.add(instruction);
    
    // Get recent blockhash
    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = botWallet.publicKey;
    
    // Sign and send
    const signature = await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [botWallet],
      { commitment: 'confirmed' }
    );
    
    logger.info({
      arenaId: arenaId.toString(),
      signature,
      assetIndex,
    }, 'Bot entered arena');
    
    return signature;
  }
  
  /**
   * Airdrop SOL to a bot wallet from the funder wallet
   */
  private async airdropSolToBot(botPubkey: PublicKey): Promise<void> {
    if (!this.funderKeypair) {
      throw new Error('Funder wallet not configured - cannot airdrop SOL to bot');
    }
    
    // Check funder balance
    const funderBalance = await this.connection.getBalance(this.funderKeypair.publicKey);
    const airdropAmount = lifecycleConfig.botFiller.airdropAmountLamports;
    
    if (funderBalance < airdropAmount + 10_000) {
      throw new Error(`Funder wallet has insufficient balance: ${funderBalance / LAMPORTS_PER_SOL} SOL`);
    }
    
    // Transfer SOL
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.funderKeypair.publicKey,
        toPubkey: botPubkey,
        lamports: airdropAmount,
      })
    );
    
    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = this.funderKeypair.publicKey;
    
    const signature = await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [this.funderKeypair],
      { commitment: 'confirmed' }
    );
    
    logger.info({
      botWallet: botPubkey.toString().slice(0, 8) + '...',
      amount: airdropAmount / LAMPORTS_PER_SOL,
      signature,
    }, 'Airdropped SOL to bot wallet');
  }
  
  // PDA helpers
  private getGlobalStatePda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('global_state')],
      PROGRAM_ID
    );
    return pda;
  }
  
  private getArenaPda(arenaId: bigint): PublicKey {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(arenaId);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('arena'), buffer],
      PROGRAM_ID
    );
    return pda;
  }
  
  private getArenaVaultPda(arenaId: bigint): PublicKey {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(arenaId);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('arena_vault'), buffer],
      PROGRAM_ID
    );
    return pda;
  }
  
  private getPlayerEntryPda(arenaPda: PublicKey, playerPubkey: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('player_entry'), arenaPda.toBuffer(), playerPubkey.toBuffer()],
      PROGRAM_ID
    );
    return pda;
  }
  
  private getWhitelistTokenPda(assetIndex: number): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('whitelist_token'), Buffer.from([assetIndex])],
      PROGRAM_ID
    );
    return pda;
  }
}

// Singleton instance
let instance: BotFiller | null = null;

export function getBotFiller(): BotFiller {
  if (!instance) {
    instance = new BotFiller();
  }
  return instance;
}

export default BotFiller;

