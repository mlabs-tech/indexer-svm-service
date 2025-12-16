/**
 * Arena Lifecycle Manager
 * 
 * Handles automatic starting and ending of arenas:
 * - After 10 minutes from first player join: automatically start arena
 * - When arena duration ends (10 min): automatically end arena (set end prices, finalize)
 * - Bot filler: automatically adds bots when waiting room is inactive for 1 minute
 */

import db from '../../db';
import logger from '../../utils/logger';
import { StartWorker } from './startWorker';
import { EndWorker } from './endWorker';
import { BotFiller, getBotFiller } from './botFiller';
import lifecycleConfig from './config';
import { ArenaStatus } from '../../types/accounts';

export class ArenaLifecycleManager {
  private startWorker: StartWorker;
  private endWorker: EndWorker;
  private botFiller: BotFiller;
  private isRunning: boolean = false;
  private countdownCheckInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    this.startWorker = new StartWorker();
    this.endWorker = new EndWorker();
    this.botFiller = getBotFiller();
  }
  
  /**
   * Start the lifecycle manager
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Arena lifecycle manager already running');
      return;
    }
    
    logger.info('Starting Arena Lifecycle Manager...');
    
    // Start workers
    await this.startWorker.start();
    await this.endWorker.start();
    
    // Start bot filler
    await this.botFiller.start();
    
    // Start countdown checker (checks every 10 seconds for arenas past 10 min countdown)
    this.countdownCheckInterval = setInterval(
      () => this.checkWaitingArenasCountdown(),
      lifecycleConfig.startCheckIntervalMs
    );
    
    this.isRunning = true;
    
    logger.info({ 
      startQueue: lifecycleConfig.queues.startArena, 
      endQueue: lifecycleConfig.queues.endArena,
      countdownMs: lifecycleConfig.waitingCountdownMs,
      botFillerEnabled: lifecycleConfig.botFiller.enabled,
    }, 'Arena Lifecycle Manager started');
  }
  
  /**
   * Check for waiting arenas that have passed the countdown (from first player join)
   * Also recovers stuck arenas in 'processing' status
   */
  private async checkWaitingArenasCountdown(): Promise<void> {
    try {
      const countdownThreshold = new Date(Date.now() - lifecycleConfig.waitingCountdownMs);
      const stuckThreshold = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes ago - if processing longer, consider stuck
      
      // Find waiting arenas with at least 1 player
      const waitingArenas = await db.arena.findMany({
        where: {
          status: ArenaStatus.Waiting,
          playerCount: { gte: 1 }, // At least 1 player
        },
        include: {
          playerEntries: {
            select: { playerWallet: true, assetIndex: true, createdAt: true },
          },
        },
      });
      
      for (const arena of waitingArenas) {
        // Check processing state
        const state = await db.arenaProcessingState.findUnique({
          where: { arenaId: arena.arenaId },
        });
        
        // Check for stuck 'processing' status (processing for more than 2 minutes)
        if (state && state.startStatus === 'processing') {
          const processingStartTime = state.updatedAt || state.createdAt;
          if (processingStartTime < stuckThreshold) {
            logger.warn({ 
              arenaId: arena.arenaId.toString(),
              processingSince: processingStartTime.toISOString(),
            }, 'Found stuck arena in processing status, resetting to failed for retry');
            
            // Reset to failed so it can be retried
            await db.arenaProcessingState.update({
              where: { arenaId: arena.arenaId },
              data: {
                startStatus: 'failed',
                startError: 'Stuck in processing status - reset for retry',
              },
            });
            // Continue to retry it below
          } else {
            continue; // Still processing, not stuck yet
          }
        }
        
        // Skip if already completed
        if (state && state.startStatus === 'completed') {
          continue;
        }
        
        // Get the first player entry time (countdown starts from first player join)
        if (arena.playerEntries.length === 0) {
          continue; // No players yet
        }
        
        const firstPlayerEntryTime = arena.playerEntries.reduce((earliest, entry) => 
          entry.createdAt < earliest ? entry.createdAt : earliest, 
          arena.playerEntries[0].createdAt
        );
        
        // Check if countdown has passed (first player joined more than countdown duration ago)
        if (firstPlayerEntryTime > countdownThreshold) {
          continue; // Countdown not reached yet
        }
        
        // Retry if failed, or start if pending/not started
        if (state && state.startStatus === 'failed') {
          logger.info({ 
            arenaId: arena.arenaId.toString(),
            previousError: state.startError,
          }, 'Retrying failed arena start');
        } else {
          logger.info({ 
            arenaId: arena.arenaId.toString(), 
            playerCount: arena.playerCount,
            firstPlayerJoinedAt: firstPlayerEntryTime.toISOString(),
            arenaCreatedAt: arena.createdAt.toISOString(),
          }, 'Countdown reached (from first player join), starting arena');
        }
        
        const assetIndices = arena.playerEntries.map(e => e.assetIndex);
        await this.startWorker.addJob(arena.arenaId, assetIndices);
      }
    } catch (error) {
      logger.error({ error }, 'Error checking waiting arenas countdown');
    }
  }
  
  /**
   * Called when a player joins an arena - notify bot filler to reset inactivity timer
   */
  onPlayerJoined(arenaId: bigint): void {
    this.botFiller.onPlayerJoined(arenaId);
  }
  
  /**
   * Called when an arena becomes Ready (10 players) - NOW: immediately start
   * Note: We keep this for immediate start when full, but main trigger is 10-min countdown
   */
  async onArenaReady(arenaId: bigint, assetIndices: number[]): Promise<void> {
    logger.info({ arenaId: arenaId.toString(), assets: assetIndices }, 'Arena ready (admin triggered), setting prices');
    
    await this.startWorker.addJob(arenaId, assetIndices);
  }
  
  /**
   * Called when an arena needs to be ended
   */
  async onArenaEndTime(arenaId: bigint, assetIndices: number[]): Promise<void> {
    logger.info({ arenaId: arenaId.toString(), assets: assetIndices }, 'Arena end time reached, triggering end');
    
    await this.endWorker.addJob(arenaId, assetIndices);
  }
  
  /**
   * Check and recover any arenas that might have been missed
   */
  async recoverMissedArenas(): Promise<void> {
    logger.info('Checking for missed arenas...');
    
    const now = new Date();
    const stuckThreshold = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes ago
    
    // Find Ready arenas that haven't been started
    const readyArenas = await db.arena.findMany({
      where: {
        status: 2, // Ready
      },
      include: { arenaAssets: true },
    });
    
    for (const arena of readyArenas) {
      const state = await db.arenaProcessingState.findUnique({
        where: { arenaId: arena.arenaId },
      });
      
      // Check for stuck processing status
      if (state && state.startStatus === 'processing') {
        const processingStartTime = state.updatedAt || state.createdAt;
        if (processingStartTime < stuckThreshold) {
          logger.warn({ 
            arenaId: arena.arenaId.toString(),
            processingSince: processingStartTime.toISOString(),
          }, 'Found stuck Ready arena in processing status, resetting to failed');
          
          await db.arenaProcessingState.update({
            where: { arenaId: arena.arenaId },
            data: {
              startStatus: 'failed',
              startError: 'Stuck in processing status - reset for retry',
            },
          });
        } else {
          continue; // Still processing, not stuck yet
        }
      }
      
      if (!state || state.startStatus === 'pending' || state.startStatus === 'failed') {
        logger.info({ arenaId: arena.arenaId.toString() }, 'Found missed Ready arena, triggering start');
        
        const assetIndices = arena.arenaAssets.map(a => a.assetIndex);
        await this.startWorker.addJob(arena.arenaId, assetIndices);
      }
    }
    
    // Also check for stuck Waiting arenas in processing status
    const stuckWaitingArenas = await db.arena.findMany({
      where: {
        status: ArenaStatus.Waiting,
        playerCount: { gte: 1 },
      },
      include: {
        playerEntries: {
          select: { playerWallet: true, assetIndex: true },
        },
      },
    });
    
    for (const arena of stuckWaitingArenas) {
      const state = await db.arenaProcessingState.findUnique({
        where: { arenaId: arena.arenaId },
      });
      
      if (state && state.startStatus === 'processing') {
        const processingStartTime = state.updatedAt || state.createdAt;
        if (processingStartTime < stuckThreshold) {
          logger.warn({ 
            arenaId: arena.arenaId.toString(),
            processingSince: processingStartTime.toISOString(),
          }, 'Found stuck Waiting arena in processing status, resetting to failed');
          
          await db.arenaProcessingState.update({
            where: { arenaId: arena.arenaId },
            data: {
              startStatus: 'failed',
              startError: 'Stuck in processing status - reset for retry',
            },
          });
          
          // Retry it
          const assetIndices = arena.playerEntries.map(e => e.assetIndex);
          await this.startWorker.addJob(arena.arenaId, assetIndices);
        }
      }
    }
    
    // Find Active arenas past their end time
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
          }, 'Found stuck Active arena end in processing status, resetting to failed');
          
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
      
      if (!state || state.endStatus === 'pending' || state.endStatus === 'scheduled' || state.endStatus === 'failed') {
        logger.info({ arenaId: arena.arenaId.toString() }, 'Found missed Active arena past end time, triggering end');
        
        const assetIndices = arena.arenaAssets.map(a => a.assetIndex);
        await this.endWorker.addJob(arena.arenaId, assetIndices);
      }
    }
    
    logger.info('Recovery check complete');
  }
  
  /**
   * Stop the lifecycle manager
   */
  async stop(): Promise<void> {
    logger.info('Stopping Arena Lifecycle Manager...');
    
    // Stop countdown checker
    if (this.countdownCheckInterval) {
      clearInterval(this.countdownCheckInterval);
      this.countdownCheckInterval = null;
    }
    
    await this.startWorker.stop();
    await this.endWorker.stop();
    await this.botFiller.stop();
    
    this.isRunning = false;
    
    logger.info('Arena Lifecycle Manager stopped');
  }
  
  /**
   * Get status
   */
  isActive(): boolean {
    return this.isRunning;
  }
}

// Singleton instance
let instance: ArenaLifecycleManager | null = null;

export function getArenaLifecycleManager(): ArenaLifecycleManager {
  if (!instance) {
    instance = new ArenaLifecycleManager();
  }
  return instance;
}

export default ArenaLifecycleManager;
