/**
 * Start Worker - Handles starting arenas and setting start prices (cryptarena-sol)
 * Flow: 1) Call startArena on program 2) Set start prices for each player
 */

import { Worker, Job, Queue } from 'bullmq';
import Redis from 'ioredis';
import db from '../../db';
import logger from '../../utils/logger';
import config from '../../config';
import lifecycleConfig from './config';
import TransactionSender from './transactionSender';
import { fetchPricesFromPyth } from '../priceFetcher';
import { ASSETS, ArenaStatus } from '../../types/accounts';

export interface StartArenaJobData {
  arenaId: string; // Stored as string because BigInt can't be serialized to JSON
  assetIndices: number[];
}

export class StartWorker {
  private worker: Worker | null = null;
  private queue: Queue;
  private transactionSender: TransactionSender;
  private redisConnection: Redis;
  
  constructor() {
    this.redisConnection = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null,
    });
    
    this.queue = new Queue(lifecycleConfig.queues.startArena, {
      connection: this.redisConnection,
    });
    
    this.transactionSender = new TransactionSender();
  }
  
  /**
   * Start the worker
   */
  async start(): Promise<void> {
    this.worker = new Worker(
      lifecycleConfig.queues.startArena,
      async (job: Job<StartArenaJobData>) => {
        return this.processJob(job);
      },
      {
        connection: this.redisConnection,
        concurrency: 1, // Process one arena at a time to avoid race conditions
      }
    );
    
    this.worker.on('completed', (job) => {
      logger.info({ jobId: job.id, arenaId: String(job.data.arenaId) }, 'Arena start job completed');
    });
    
    this.worker.on('failed', (job, error) => {
      logger.error({ 
        jobId: job?.id, 
        arenaId: String(job?.data?.arenaId),
        error: error.message,
        attempts: job?.attemptsMade,
      }, 'Arena start job failed');
    });
    
    logger.info('Start worker initialized');
  }
  
  /**
   * Add a job to set start prices for an arena
   * Note: In cryptarena-sol, admin starts arenas via startArena instruction
   * This worker handles setting start prices after arena is started
   * 
   * For immediate processing, we process synchronously first, then queue for retry logic
   */
  async addJob(arenaId: bigint, assetIndices: number[]): Promise<string | null> {
    // Check if job already exists for this arena
    const existingState = await db.arenaProcessingState.findUnique({
      where: { arenaId },
    });
    
    if (existingState && existingState.startStatus !== 'pending' && existingState.startStatus !== 'failed') {
      logger.warn({ arenaId: arenaId.toString() }, 'Arena already being processed for start');
      return null;
    }
    
    // Create or update processing state
    await db.arenaProcessingState.upsert({
      where: { arenaId },
      create: {
        arenaId,
        startStatus: 'processing',
      },
      update: {
        startStatus: 'processing',
      },
    });
    
    // Process immediately (don't wait for queue polling)
    try {
      logger.info({ arenaId: arenaId.toString(), assets: assetIndices }, 'Processing arena start immediately');
      await this.processStartArena(arenaId, assetIndices);
      
      // If successful, still add to queue for tracking (but mark as completed)
      const job = await this.queue.add(
        `start-arena-${arenaId}`,
        {
          arenaId: arenaId.toString(),
          assetIndices,
        },
        {
          ...lifecycleConfig.jobOptions,
          jobId: `start-${arenaId}`,
          removeOnComplete: true, // Remove immediately since already processed
        }
      );
      
      await db.arenaProcessingState.update({
        where: { arenaId },
        data: { startJobId: job.id },
      });
      
      logger.info({ jobId: job.id, arenaId: arenaId.toString() }, 'Arena start processed successfully');
      return job.id || null;
    } catch (error) {
      // If immediate processing fails, mark as failed and queue it for retry
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ arenaId: arenaId.toString(), error: errorMessage }, 'Immediate start failed, queuing for retry');
      
      const job = await this.queue.add(
        `start-arena-${arenaId}`,
        {
          arenaId: arenaId.toString(),
          assetIndices,
        },
        {
          ...lifecycleConfig.jobOptions,
          jobId: `start-${arenaId}`,
        }
      );
      
      await db.arenaProcessingState.update({
        where: { arenaId },
        data: { 
          startJobId: job.id,
          startStatus: 'failed', // Mark as failed so it can be retried
          startError: errorMessage,
        },
      });
      
      return job.id || null;
    }
  }
  
  /**
   * Process start arena immediately (extracted from processJob for reuse)
   */
  private async processStartArena(arenaId: bigint, assetIndices: number[]): Promise<void> {
    const arenaIdStr = arenaId.toString();
    
    logger.info({ arenaId: arenaIdStr, assets: assetIndices }, 'Processing start arena');
    
    // Step 1: Call startArena on the program
    logger.info({ arenaId: arenaIdStr }, 'Calling startArena on program...');
    await this.transactionSender.startArena(arenaId);
    
    // Small delay after starting
    await this.sleep(1000);
    
    // Step 2: Get player entries from database
    const playerEntries = await db.playerEntry.findMany({
      where: { arenaId },
    });
    
    if (playerEntries.length === 0) {
      throw new Error('No player entries found for arena');
    }
    
    // Get unique symbols from player entries
    const symbols = [...new Set(
      playerEntries.map(e => ASSETS.find(a => a.index === e.assetIndex)?.symbol).filter(Boolean)
    )] as string[];
    
    // Step 3: Fetch current prices from Pyth
    const prices = await fetchPricesFromPyth(symbols);
    
    if (Object.keys(prices).length === 0) {
      throw new Error('Failed to fetch prices from Pyth');
    }
    
    // Step 4: Set start price for each player
    for (const entry of playerEntries) {
      const asset = ASSETS.find(a => a.index === entry.assetIndex);
      if (!asset) continue;
      
      const price = prices[asset.symbol];
      if (!price) {
        logger.warn({ symbol: asset.symbol, assetIndex: entry.assetIndex }, 'No price found for asset');
        continue;
      }
      
      // Convert price to on-chain format (12 decimals)
      const onchainPrice = BigInt(Math.floor(price * 1e12));
      
      logger.info({ 
        arenaId: arenaIdStr, 
        player: entry.playerWallet.slice(0, 8), 
        symbol: asset.symbol, 
        price, 
        onchainPrice: onchainPrice.toString() 
      }, 'Setting start price');
      
      await this.transactionSender.setStartPrice(
        arenaId,
        entry.playerWallet,
        onchainPrice
      );
      
      // Small delay between transactions
      await this.sleep(lifecycleConfig.priceSetDelayMs);
    }
    
    // Update processing state
    await db.arenaProcessingState.update({
      where: { arenaId },
      data: {
        startStatus: 'completed',
        startedAt: new Date(),
      },
    });
    
    // Get arena info to schedule end job
    const arenaInfo = await this.transactionSender.getArenaInfo(arenaId);
    if (arenaInfo && arenaInfo.status === ArenaStatus.Active) {
      const endTime = new Date(Number(arenaInfo.endTimestamp) * 1000);
      logger.info({ arenaId: arenaIdStr, endTime: endTime.toISOString() }, 'Arena started successfully');
      
      // Schedule end job
      await db.arenaProcessingState.update({
        where: { arenaId },
        data: {
          endStatus: 'scheduled',
          scheduledEndTime: endTime,
        },
      });
    }
  }
  
  /**
   * Process start arena job (from queue - used for retries)
   * 1. Call startArena on program (changes status from Waiting to Active)
   * 2. Set start prices for all players
   */
  private async processJob(job: Job<StartArenaJobData>): Promise<void> {
    const { arenaId: arenaIdStr, assetIndices } = job.data;
    const arenaIdBigInt = BigInt(arenaIdStr);
    
    logger.info({ arenaId: arenaIdStr, attempt: job.attemptsMade + 1, assets: assetIndices }, 'Processing start arena job from queue');
    
    try {
      await this.processStartArena(arenaIdBigInt, assetIndices);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await db.arenaProcessingState.update({
        where: { arenaId: arenaIdBigInt },
        data: {
          startStatus: job.attemptsMade >= lifecycleConfig.maxRetryAttempts - 1 ? 'failed' : 'processing',
          startError: errorMessage,
          retryCount: job.attemptsMade + 1,
        },
      });
      
      throw error;
    }
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Stop the worker
   */
  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
    await this.queue.close();
    this.redisConnection.disconnect();
  }
}

export default StartWorker;
