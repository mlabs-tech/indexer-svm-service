/**
 * Arena Lifecycle Manager
 * 
 * Handles automatic starting and ending of arenas:
 * - After 10 minutes from first player join: automatically start arena
 * - When arena duration ends (10 min): automatically end arena (set end prices, finalize)
 */

import db from '../../db';
import logger from '../../utils/logger';
import { StartWorker } from './startWorker';
import { EndWorker } from './endWorker';
import lifecycleConfig from './config';
import { ArenaStatus } from '../../types/accounts';

export class ArenaLifecycleManager {
  private startWorker: StartWorker;
  private endWorker: EndWorker;
  private isRunning: boolean = false;
  private countdownCheckInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    this.startWorker = new StartWorker();
    this.endWorker = new EndWorker();
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
    }, 'Arena Lifecycle Manager started');
  }
  
  /**
   * Check for waiting arenas that have passed the 10-minute countdown
   */
  private async checkWaitingArenasCountdown(): Promise<void> {
    try {
      const countdownThreshold = new Date(Date.now() - lifecycleConfig.waitingCountdownMs);
      
      // Find waiting arenas that were created more than 10 minutes ago
      const waitingArenas = await db.arena.findMany({
        where: {
          status: ArenaStatus.Waiting,
          playerCount: { gte: 1 }, // At least 1 player
          createdAt: { lte: countdownThreshold },
        },
        include: {
          playerEntries: {
            select: { playerWallet: true, assetIndex: true },
          },
        },
      });
      
      for (const arena of waitingArenas) {
        // Check if already being processed
        const state = await db.arenaProcessingState.findUnique({
          where: { arenaId: arena.arenaId },
        });
        
        if (state && state.startStatus !== 'pending' && state.startStatus !== 'failed') {
          continue; // Already processing
        }
        
        logger.info({ 
          arenaId: arena.arenaId.toString(), 
          playerCount: arena.playerCount,
          createdAt: arena.createdAt.toISOString(),
        }, '10-minute countdown reached, starting arena');
        
        const assetIndices = arena.playerEntries.map(e => e.assetIndex);
        await this.startWorker.addJob(arena.arenaId, assetIndices);
      }
    } catch (error) {
      logger.error({ error }, 'Error checking waiting arenas countdown');
    }
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
      
      if (!state || state.startStatus === 'pending' || state.startStatus === 'failed') {
        logger.info({ arenaId: arena.arenaId.toString() }, 'Found missed Ready arena, triggering start');
        
        const assetIndices = arena.arenaAssets.map(a => a.assetIndex);
        await this.startWorker.addJob(arena.arenaId, assetIndices);
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
