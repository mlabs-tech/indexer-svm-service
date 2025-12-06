/**
 * End Worker - Handles ending arenas when their duration is complete
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

export interface EndArenaJobData {
  arenaId: string; // Stored as string because BigInt can't be serialized to JSON
  assetIndices: number[];
}

export class EndWorker {
  private worker: Worker | null = null;
  private queue: Queue;
  private transactionSender: TransactionSender;
  private redisConnection: Redis;
  private checkInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    this.redisConnection = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null,
    });
    
    this.queue = new Queue(lifecycleConfig.queues.endArena, {
      connection: this.redisConnection,
    });
    
    this.transactionSender = new TransactionSender();
  }
  
  /**
   * Start the worker and scheduler
   */
  async start(): Promise<void> {
    // Start the job processor
    this.worker = new Worker(
      lifecycleConfig.queues.endArena,
      async (job: Job<EndArenaJobData>) => {
        return this.processJob(job);
      },
      {
        connection: this.redisConnection,
        concurrency: 1, // Process one arena at a time
      }
    );
    
    this.worker.on('completed', (job) => {
      logger.info({ jobId: job.id, arenaId: String(job.data.arenaId) }, 'Arena end job completed');
    });
    
    this.worker.on('failed', (job, error) => {
      logger.error({ 
        jobId: job?.id, 
        arenaId: String(job?.data?.arenaId),
        error: error.message,
        attempts: job?.attemptsMade,
      }, 'Arena end job failed');
    });
    
    // Start scheduler to check for arenas that need to end
    this.startScheduler();
    
    logger.info('End worker initialized');
  }
  
  /**
   * Start the scheduler that checks for arenas ready to end
   */
  private startScheduler(): void {
    this.checkInterval = setInterval(async () => {
      try {
        await this.checkAndScheduleEndJobs();
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage }, 'Error in end scheduler');
      }
    }, lifecycleConfig.endCheckIntervalMs);
    
    // Also run immediately
    this.checkAndScheduleEndJobs().catch(err => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMessage }, 'Initial end check failed');
    });
  }
  
  /**
   * Check for arenas that need to be ended
   */
  private async checkAndScheduleEndJobs(): Promise<void> {
    const now = new Date();
    
    // Find arenas that are scheduled to end and the time has passed
    const arenasToEnd = await db.arenaProcessingState.findMany({
      where: {
        endStatus: 'scheduled',
        scheduledEndTime: {
          lte: now,
        },
      },
    });
    
    for (const arena of arenasToEnd) {
      // Also check from database arenas table
      const arenaData = await db.arena.findUnique({
        where: { arenaId: arena.arenaId },
        include: { arenaAssets: true },
      });
      
      if (!arenaData) continue;
      
      // Only process Active arenas (status = 3)
      if (arenaData.status !== 3) {
        logger.warn({ arenaId: arena.arenaId.toString(), status: arenaData.status }, 'Arena not in Active status, skipping end');
        continue;
      }
      
      const assetIndices = arenaData.arenaAssets.map(a => a.assetIndex);
      await this.addJob(arena.arenaId, assetIndices);
    }
    
    // Also check for Active arenas in the database that might have been missed
    const activeArenas = await db.arena.findMany({
      where: {
        status: 3, // Active
        endTimestamp: {
          lte: now,
        },
      },
      include: { arenaAssets: true },
    });
    
    for (const arena of activeArenas) {
      // Check if already being processed
      const state = await db.arenaProcessingState.findUnique({
        where: { arenaId: arena.arenaId },
      });
      
      if (state && (state.endStatus === 'processing' || state.endStatus === 'completed')) {
        continue;
      }
      
      const assetIndices = arena.arenaAssets.map(a => a.assetIndex);
      await this.addJob(arena.arenaId, assetIndices);
    }
  }
  
  /**
   * Add a job to end an arena
   */
  async addJob(arenaId: bigint, assetIndices: number[]): Promise<string | null> {
    // Check if job already exists
    const existingState = await db.arenaProcessingState.findUnique({
      where: { arenaId },
    });
    
    if (existingState && (existingState.endStatus === 'processing' || existingState.endStatus === 'completed')) {
      logger.debug({ arenaId: arenaId.toString() }, 'Arena already being processed for end');
      return null;
    }
    
    // Update processing state
    await db.arenaProcessingState.upsert({
      where: { arenaId },
      create: {
        arenaId,
        startStatus: 'completed',
        endStatus: 'processing',
      },
      update: {
        endStatus: 'processing',
      },
    });
    
    const job = await this.queue.add(
      `end-arena-${arenaId}`,
      {
        arenaId: arenaId.toString(), // Convert BigInt to string for JSON serialization
        assetIndices,
      },
      {
        ...lifecycleConfig.jobOptions,
        jobId: `end-${arenaId}`,
      }
    );
    
    await db.arenaProcessingState.update({
      where: { arenaId },
      data: { endJobId: job.id },
    });
    
    logger.info({ jobId: job.id, arenaId: arenaId.toString(), assets: assetIndices }, 'Added end arena job');
    
    return job.id || null;
  }
  
  /**
   * Process end arena job
   */
  private async processJob(job: Job<EndArenaJobData>): Promise<void> {
    const { arenaId: arenaIdStr, assetIndices } = job.data;
    const arenaIdBigInt = BigInt(arenaIdStr);
    
    logger.info({ arenaId: arenaIdStr, attempt: job.attemptsMade + 1, assets: assetIndices }, 'Processing end arena job');
    
    try {
      // Fetch current prices from CoinMarketCap
      const symbols = assetIndices.map(i => ASSETS[i]?.symbol).filter(Boolean) as string[];
      const prices = await fetchPricesFromCMC(symbols);
      
      if (Object.keys(prices).length === 0) {
        throw new Error('Failed to fetch prices from CoinMarketCap');
      }
      
      // Set end price for each asset
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
        
        logger.info({ arenaId: arenaIdStr, symbol, price, onchainPrice: onchainPrice.toString() }, 'Setting end price');
        
        await this.transactionSender.setEndPrice(
          arenaIdBigInt,
          assetIndex,
          onchainPrice
        );
        
        // Small delay between transactions
        await this.sleep(lifecycleConfig.priceSetDelayMs);
      }
      
      // Finalize arena to determine winner
      logger.info({ arenaId: arenaIdStr }, 'Finalizing arena');
      await this.transactionSender.finalizeArena(
        arenaIdBigInt,
        assetIndices
      );
      
      // Update processing state
      await db.arenaProcessingState.update({
        where: { arenaId: arenaIdBigInt },
        data: {
          endStatus: 'completed',
          endedAt: new Date(),
        },
      });
      
      logger.info({ arenaId: arenaIdStr }, 'Arena ended successfully');
      
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Update processing state with error
      await db.arenaProcessingState.update({
        where: { arenaId: arenaIdBigInt },
        data: {
          endStatus: job.attemptsMade >= lifecycleConfig.maxRetryAttempts - 1 ? 'failed' : 'processing',
          endError: errorMessage,
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
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    if (this.worker) {
      await this.worker.close();
    }
    await this.queue.close();
    this.redisConnection.disconnect();
  }
}

export default EndWorker;
