/**
 * End Worker - Handles ending arenas when their duration is complete (cryptarena-sol)
 */

import { Worker, Job, Queue } from 'bullmq';
import Redis from 'ioredis';
import db from '../../db';
import logger from '../../utils/logger';
import config from '../../config';
import lifecycleConfig from './config';
import TransactionSender from './transactionSender';
import { fetchPricesFromCMC } from '../priceFetcher';
import { ASSETS, ArenaStatus } from '../../types/accounts';

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
   * Also recovers stuck arenas in 'processing' status
   */
  private async checkAndScheduleEndJobs(): Promise<void> {
    // Add 2 second buffer to ensure arena duration is actually complete on-chain
    const now = new Date(Date.now() - 2 * 1000); // 2 seconds ago to account for timing differences
    const stuckThreshold = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes ago - if processing longer, consider stuck
    
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
      const arenaData = await db.arena.findUnique({
        where: { arenaId: arena.arenaId },
      });
      
      if (!arenaData) continue;
      
      // Only process Active arenas (status = 2 in cryptarena-sol)
      if (arenaData.status !== ArenaStatus.Active) {
        logger.warn({ arenaId: arena.arenaId.toString(), status: arenaData.status }, 'Arena not in Active status, skipping end');
        continue;
      }
      
      // Get player entries for asset indices
      const playerEntries = await db.playerEntry.findMany({
        where: { arenaId: arena.arenaId },
      });
      const assetIndices = playerEntries.map(e => e.assetIndex);
      
      await this.addJob(arena.arenaId, assetIndices);
    }
    
    // Also check for Active arenas in the database that might have been missed
    // Use a buffer to ensure on-chain duration is complete
    const activeArenas = await db.arena.findMany({
      where: {
        status: ArenaStatus.Active,
        endTimestamp: {
          lte: now, // Already has 2 second buffer from above
        },
      },
    });
    
    for (const arena of activeArenas) {
      // Check processing state
      const state = await db.arenaProcessingState.findUnique({
        where: { arenaId: arena.arenaId },
      });
      
      // Check for stuck 'processing' status
      if (state && state.endStatus === 'processing') {
        const processingStartTime = state.updatedAt || state.createdAt;
        if (processingStartTime < stuckThreshold) {
          logger.warn({ 
            arenaId: arena.arenaId.toString(),
            processingSince: processingStartTime.toISOString(),
          }, 'Found stuck arena end in processing status, resetting to failed for retry');
          
          // Reset to failed so it can be retried
          await db.arenaProcessingState.update({
            where: { arenaId: arena.arenaId },
            data: {
              endStatus: 'failed',
              endError: 'Stuck in processing status - reset for retry',
            },
          });
          // Continue to retry it below
        } else {
          continue; // Still processing, not stuck yet
        }
      }
      
      // Skip if already completed
      if (state && state.endStatus === 'completed') {
        continue;
      }
      
      // Retry if failed, or start if pending/not started
      if (state && state.endStatus === 'failed') {
        logger.info({ 
          arenaId: arena.arenaId.toString(),
          previousError: state.endError,
        }, 'Retrying failed arena end');
      } else {
        logger.info({ 
          arenaId: arena.arenaId.toString(),
          endTimestamp: arena.endTimestamp?.toISOString(),
        }, 'Arena end time reached, ending arena');
      }
      
      // Get player entries for asset indices
      const playerEntries = await db.playerEntry.findMany({
        where: { arenaId: arena.arenaId },
      });
      const assetIndices = playerEntries.map(e => e.assetIndex);
      
      await this.addJob(arena.arenaId, assetIndices);
    }
  }
  
  /**
   * Add a job to end an arena
   * For immediate processing, we process synchronously first, then queue for retry logic
   */
  async addJob(arenaId: bigint, assetIndices: number[]): Promise<string | null> {
    // Check if job already exists
    const existingState = await db.arenaProcessingState.findUnique({
      where: { arenaId },
    });
    
    if (existingState && existingState.endStatus === 'completed') {
      logger.debug({ arenaId: arenaId.toString() }, 'Arena already ended');
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
    
    // Process immediately (don't wait for queue polling)
    try {
      logger.info({ arenaId: arenaId.toString(), assets: assetIndices }, 'Processing arena end immediately');
      await this.processEndArena(arenaId, assetIndices);
      
      logger.info({ arenaId: arenaId.toString() }, 'Arena end processed successfully - immediate processing completed');
      
      // If successful, still add to queue for tracking (but mark as completed)
      const job = await this.queue.add(
        `end-arena-${arenaId}`,
        {
          arenaId: arenaId.toString(),
          assetIndices,
        },
        {
          ...lifecycleConfig.jobOptions,
          jobId: `end-${arenaId}`,
          removeOnComplete: true, // Remove immediately since already processed
        }
      );
      
      await db.arenaProcessingState.update({
        where: { arenaId },
        data: { endJobId: job.id },
      });
      
      return job.id || null;
    } catch (error) {
      // If immediate processing fails, mark as failed and queue it for retry
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      // Check if it's the ArenaDurationNotComplete error - schedule retry with delay
      const isDurationNotComplete = errorMessage.includes('0x1775') || 
                                     errorMessage.includes('6005') || 
                                     errorMessage.includes('ArenaDurationNotComplete') ||
                                     errorMessage.includes('Arena duration not complete');
      
      if (isDurationNotComplete) {
        logger.warn({ 
          arenaId: arenaId.toString(), 
          error: errorMessage,
        }, 'Arena duration not complete, will retry after delay');
        
        // Get on-chain end timestamp to calculate delay
        try {
          const arenaInfo = await this.transactionSender.getArenaInfo(arenaId);
          if (arenaInfo) {
            const onChainEndTimestamp = Number(arenaInfo.endTimestamp);
            const nowSeconds = Math.floor(Date.now() / 1000);
            const remainingSeconds = Math.max(0, onChainEndTimestamp - nowSeconds);
            const delayMs = (remainingSeconds + 5) * 1000; // Add 5 second buffer
            
            logger.info({ 
              arenaId: arenaId.toString(),
              onChainEndTimestamp,
              nowSeconds,
              remainingSeconds,
              delayMs,
            }, 'Scheduling retry after arena duration completes');
            
            // Schedule job with delay
            const job = await this.queue.add(
              `end-arena-${arenaId}`,
              {
                arenaId: arenaId.toString(),
                assetIndices,
              },
              {
                ...lifecycleConfig.jobOptions,
                jobId: `end-${arenaId}`,
                delay: delayMs,
              }
            );
            
            await db.arenaProcessingState.update({
              where: { arenaId },
              data: { 
                endJobId: job.id,
                endStatus: 'scheduled', // Keep as scheduled since we're waiting
                endError: `Arena duration not complete, retrying in ${remainingSeconds + 5}s`,
              },
            });
            
            return job.id || null;
          }
        } catch (infoError) {
          logger.error({ arenaId: arenaId.toString(), error: infoError }, 'Failed to get arena info for retry scheduling');
        }
      }
      
      logger.error({ 
        arenaId: arenaId.toString(), 
        error: errorMessage,
        stack: errorStack,
      }, 'Immediate end failed, queuing for retry');
      
      const job = await this.queue.add(
        `end-arena-${arenaId}`,
        {
          arenaId: arenaId.toString(),
          assetIndices,
        },
        {
          ...lifecycleConfig.jobOptions,
          jobId: `end-${arenaId}`,
        }
      );
      
      await db.arenaProcessingState.update({
        where: { arenaId },
        data: { 
          endJobId: job.id,
          endStatus: 'failed', // Mark as failed so it can be retried
          endError: errorMessage,
        },
      });
      
      return job.id || null;
    }
  }
  
  /**
   * Process end arena immediately (extracted from processJob for reuse)
   */
  private async processEndArena(arenaId: bigint, assetIndices: number[]): Promise<void> {
    const arenaIdStr = arenaId.toString();
    
    logger.info({ arenaId: arenaIdStr, assets: assetIndices }, 'Processing end arena');
    
    // Verify on-chain that arena duration is actually complete before proceeding
    const arenaInfo = await this.transactionSender.getArenaInfo(arenaId);
    if (!arenaInfo) {
      throw new Error('Failed to get arena info from chain');
    }
    
    const onChainEndTimestamp = Number(arenaInfo.endTimestamp);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const remainingSeconds = onChainEndTimestamp - nowSeconds;
    
    // Check if arena duration is actually complete on-chain (with 1 second buffer for safety)
    if (remainingSeconds > 1) {
      const errorMsg = `Arena duration not complete on-chain. End timestamp: ${onChainEndTimestamp}, Now: ${nowSeconds}, Remaining: ${remainingSeconds}s`;
      logger.warn({ 
        arenaId: arenaIdStr,
        onChainEndTimestamp,
        nowSeconds,
        remainingSeconds,
        status: arenaInfo.status,
      }, errorMsg);
      throw new Error(errorMsg);
    }
    
    logger.info({ 
      arenaId: arenaIdStr,
      onChainEndTimestamp,
      nowSeconds,
      remainingSeconds,
      status: arenaInfo.status,
    }, 'Verified arena duration complete on-chain, proceeding with end');
    
    // Get player entries from database
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
    
    // Fetch current prices from CoinMarketCap
    const prices = await fetchPricesFromCMC(symbols);
    
    if (Object.keys(prices).length === 0) {
      throw new Error('Failed to fetch prices from CoinMarketCap');
    }
    
    // Set end price for each player
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
      }, 'Setting end price');
      
      try {
        await this.transactionSender.setEndPrice(
          arenaId,
          entry.playerWallet,
          onchainPrice
        );
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // Check if it's the ArenaDurationNotComplete error (0x1775 = 6005)
        if (errorMessage.includes('0x1775') || errorMessage.includes('6005') || errorMessage.includes('ArenaDurationNotComplete')) {
          logger.warn({ 
            arenaId: arenaIdStr,
            player: entry.playerWallet.slice(0, 8),
            error: errorMessage,
          }, 'Arena duration not complete on-chain, will retry after delay');
          
          // Re-check on-chain state
          const arenaInfo = await this.transactionSender.getArenaInfo(arenaId);
          if (arenaInfo) {
            const onChainEndTimestamp = Number(arenaInfo.endTimestamp);
            const nowSeconds = Math.floor(Date.now() / 1000);
            const remainingSeconds = onChainEndTimestamp - nowSeconds;
            
            if (remainingSeconds > 0) {
              // Wait a bit longer than remaining time to ensure it's complete
              const waitMs = (remainingSeconds + 2) * 1000; // Add 2 second buffer
              logger.info({ 
                arenaId: arenaIdStr,
                remainingSeconds,
                waitMs,
              }, 'Waiting for arena duration to complete on-chain');
              
              await this.sleep(waitMs);
              
              // Retry setting end price
              await this.transactionSender.setEndPrice(
                arenaId,
                entry.playerWallet,
                onchainPrice
              );
            } else {
              throw error; // Re-throw if we can't determine wait time
            }
          } else {
            throw error; // Re-throw if we can't get arena info
          }
        } else {
          throw error; // Re-throw other errors
        }
      }
      
      // Small delay between transactions
      await this.sleep(lifecycleConfig.priceSetDelayMs);
    }
    
    // Get player wallets for endArena call
    const playerWallets = playerEntries.map(e => e.playerWallet);
    
    // End arena and determine winner
    logger.info({ 
      arenaId: arenaIdStr,
      playerCount: playerWallets.length,
      playerWallets: playerWallets.map(w => w.slice(0, 8)),
    }, 'Calling endArena on Solana program');
    
    const txSignature = await this.transactionSender.endArena(
      arenaId,
      playerWallets
    );
    
    logger.info({ 
      arenaId: arenaIdStr,
      signature: txSignature,
    }, 'endArena transaction sent successfully');
    
    // Update processing state
    await db.arenaProcessingState.update({
      where: { arenaId },
      data: {
        endStatus: 'completed',
        endedAt: new Date(),
      },
    });
    
    logger.info({ arenaId: arenaIdStr }, 'Arena ended successfully');
  }
  
  /**
   * Process end arena job (from queue - used for retries)
   */
  private async processJob(job: Job<EndArenaJobData>): Promise<void> {
    const { arenaId: arenaIdStr, assetIndices } = job.data;
    const arenaIdBigInt = BigInt(arenaIdStr);
    
    logger.info({ arenaId: arenaIdStr, attempt: job.attemptsMade + 1, assets: assetIndices }, 'Processing end arena job from queue');
    
    try {
      await this.processEndArena(arenaIdBigInt, assetIndices);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await db.arenaProcessingState.update({
        where: { arenaId: arenaIdBigInt },
        data: {
          endStatus: job.attemptsMade >= lifecycleConfig.maxRetryAttempts - 1 ? 'failed' : 'processing',
          endError: errorMessage,
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
