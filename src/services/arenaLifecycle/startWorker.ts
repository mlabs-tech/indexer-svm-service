/**
 * Start Worker - Handles starting arenas when they reach 10 players
 */

import { Worker, Job, Queue } from 'bullmq';
import Redis from 'ioredis';
import db from '../../db';
import logger from '../../utils/logger';
import config from '../../config';
import lifecycleConfig from './config';
import TransactionSender from './transactionSender';
import { fetchPricesFromCMC } from '../priceFetcher';
import { ASSETS } from '../../types/accounts';

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
   * Add a job to start an arena
   */
  async addJob(arenaId: bigint, assetIndices: number[]): Promise<string | null> {
    // Check if job already exists for this arena
    const existingState = await db.arenaProcessingState.findUnique({
      where: { arenaId },
    });
    
    if (existingState && existingState.startStatus !== 'pending') {
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
    
    const job = await this.queue.add(
      `start-arena-${arenaId}`,
      {
        arenaId: arenaId.toString(), // Convert BigInt to string for JSON serialization
        assetIndices,
      },
      {
        ...lifecycleConfig.jobOptions,
        jobId: `start-${arenaId}`,
      }
    );
    
    // Update with job ID
    await db.arenaProcessingState.update({
      where: { arenaId },
      data: { startJobId: job.id },
    });
    
    logger.info({ jobId: job.id, arenaId: arenaId.toString(), assets: assetIndices }, 'Added start arena job');
    
    return job.id || null;
  }
  
  /**
   * Process start arena job
   */
  private async processJob(job: Job<StartArenaJobData>): Promise<void> {
    const { arenaId: arenaIdStr, assetIndices } = job.data;
    const arenaIdBigInt = BigInt(arenaIdStr);
    
    logger.info({ arenaId: arenaIdStr, attempt: job.attemptsMade + 1, assets: assetIndices }, 'Processing start arena job');
    
    try {
      // Fetch current prices from CoinMarketCap
      const symbols = assetIndices.map(i => ASSETS[i]?.symbol).filter(Boolean) as string[];
      const prices = await fetchPricesFromCMC(symbols);
      
      if (Object.keys(prices).length === 0) {
        throw new Error('Failed to fetch prices from CoinMarketCap');
      }
      
      // Set start price for each asset
      for (const assetIndex of assetIndices) {
        const symbol = ASSETS[assetIndex]?.symbol;
        if (!symbol) continue;
        
        const price = prices[symbol];
        if (!price) {
          logger.warn({ symbol, assetIndex }, 'No price found for asset');
          continue;
        }
        
        // Convert price to on-chain format (8 decimals)
        const onchainPrice = BigInt(Math.floor(price * 1e8));
        
        logger.info({ arenaId: arenaIdStr, symbol, price, onchainPrice: onchainPrice.toString() }, 'Setting start price');
        
        await this.transactionSender.setStartPrice(
          arenaIdBigInt,
          assetIndex,
          onchainPrice
        );
        
        // Small delay between transactions
        await this.sleep(lifecycleConfig.priceSetDelayMs);
      }
      
      // Update processing state
      await db.arenaProcessingState.update({
        where: { arenaId: arenaIdBigInt },
        data: {
          startStatus: 'completed',
          startedAt: new Date(),
        },
      });
      
      // Get arena info to schedule end job
      const arenaInfo = await this.transactionSender.getArenaInfo(arenaIdBigInt);
      if (arenaInfo && arenaInfo.status === 3) { // Active
        // Emit event to schedule end job
        const endTime = new Date(Number(arenaInfo.endTimestamp) * 1000);
        logger.info({ arenaId: arenaIdStr, endTime: endTime.toISOString() }, 'Arena started successfully');
        
        // Schedule end job (will be picked up by end worker)
        await db.arenaProcessingState.update({
          where: { arenaId: arenaIdBigInt },
          data: {
            endStatus: 'scheduled',
            scheduledEndTime: endTime,
          },
        });
      }
      
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Update processing state with error
      await db.arenaProcessingState.update({
        where: { arenaId: arenaIdBigInt },
        data: {
          startStatus: job.attemptsMade >= lifecycleConfig.maxRetryAttempts - 1 ? 'failed' : 'processing',
          startError: errorMessage,
          retryCount: job.attemptsMade + 1,
        },
      });
      
      throw error; // Re-throw to trigger retry
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
