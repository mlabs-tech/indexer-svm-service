import { PublicKey } from '@solana/web3.js';
import { parseArena } from '../parsers/accounts';
import { ArenaStatus, ArenaStatusLabels } from '../types/accounts';
import prisma from '../db';
import logger from '../utils/logger';
import { submitArenaResults } from '../services/backendApi';
import { getArenaLifecycleManager } from '../services/arenaLifecycle';
import { cacheService } from '../services/cacheService';

/**
 * Process Arena account update (cryptarena-sol)
 */
export async function processArena(pubkey: PublicKey, data: Buffer): Promise<void> {
  const arena = parseArena(data);
  const pda = pubkey.toString();

  // Convert timestamps to Date objects
  const startTimestamp = arena.startTimestamp > 0n 
    ? new Date(Number(arena.startTimestamp) * 1000) 
    : null;
  const endTimestamp = arena.endTimestamp > 0n 
    ? new Date(Number(arena.endTimestamp) * 1000) 
    : null;

  // Total pool is in lamports, convert to SOL
  const totalPoolSol = Number(arena.totalPool) / 1e9;

  const existingArena = await prisma.arena.findUnique({
    where: { arenaId: arena.id },
  });

  const arenaData = {
    pda,
    status: arena.status,
    playerCount: arena.playerCount,
    assetCount: arena.playerCount, // In cryptarena-sol, each player = 1 unique asset
    winningAsset: arena.winningAsset === 255 ? null : arena.winningAsset,
    isSuspended: arena.isCanceled, // Map isCanceled to isSuspended for compatibility
    startTimestamp,
    endTimestamp,
    totalPoolUsd: totalPoolSol, // Store SOL amount (can be converted to USD later)
  };

  if (existingArena) {
    // Track status changes for events
    const statusChanged = existingArena.status !== arena.status;

    await prisma.arena.update({
      where: { arenaId: arena.id },
      data: arenaData,
    });

    // Invalidate cache for this arena
    await cacheService.invalidateArena(arena.id.toString());

    // Create event if status changed
    if (statusChanged) {
      const eventType = getStatusChangeEventType(existingArena.status, arena.status, arena.isCanceled);
      if (eventType) {
        await prisma.arenaEvent.create({
          data: {
            arenaId: arena.id,
            eventType,
            data: {
              previousStatus: ArenaStatusLabels[existingArena.status as ArenaStatus] || `Unknown(${existingArena.status})`,
              newStatus: ArenaStatusLabels[arena.status] || `Unknown(${arena.status})`,
              winningAsset: arena.winningAsset !== 255 ? arena.winningAsset : null,
              isCanceled: arena.isCanceled,
              treasuryClaimed: arena.treasuryClaimed,
            },
          },
        });
      }

      // If arena just became Active, trigger lifecycle manager
      if (arena.status === ArenaStatus.Active && existingArena.status === ArenaStatus.Waiting) {
        logger.info({ arenaId: arena.id.toString() }, 'Arena started by admin');
        
        // Get player entries to determine asset indices
        const playerEntries = await prisma.playerEntry.findMany({
          where: { arenaId: arena.id },
        });
        const assetIndices = playerEntries.map(e => e.assetIndex);
        
        // Trigger lifecycle manager
        const lifecycleManager = getArenaLifecycleManager();
        if (lifecycleManager.isActive()) {
          await lifecycleManager.onArenaReady(arena.id, assetIndices);
        }
      }

      // If arena just ended, update player win/loss stats
      if (arena.status === ArenaStatus.Ended && arena.winningAsset !== 255) {
        await updatePlayerWinLossStats(arena.id, arena.winningAsset);
        await submitArenaResultsToBackend(arena.id, arena.winningAsset);
      }

      // If arena was canceled (tie scenario)
      if (arena.status === ArenaStatus.Canceled && arena.isCanceled) {
        logger.info({ arenaId: arena.id.toString() }, 'Arena canceled (tie detected)');
        await prisma.arenaEvent.create({
          data: {
            arenaId: arena.id,
            eventType: 'arena_canceled',
            data: { reason: 'tie_detected' },
          },
        });
      }
    }

    logger.debug(
      { 
        arenaId: arena.id.toString(), 
        status: ArenaStatusLabels[arena.status] || `Unknown(${arena.status})`,
        players: arena.playerCount,
        totalPoolSol,
      },
      'Arena updated'
    );
  } else {
    await prisma.arena.create({
      data: {
        arenaId: arena.id,
        ...arenaData,
      },
    });

    // Invalidate cache for new arena
    await cacheService.invalidateArena(arena.id.toString());

    // Create arena created event
    await prisma.arenaEvent.create({
      data: {
        arenaId: arena.id,
        eventType: 'arena_created',
        data: { pda },
      },
    });

    logger.info({ arenaId: arena.id.toString(), pda }, 'Arena created');
  }
}

/**
 * Determine event type based on status change (cryptarena-sol statuses)
 */
function getStatusChangeEventType(oldStatus: number, newStatus: number, isCanceled: boolean): string | null {
  if (newStatus === ArenaStatus.Active && oldStatus === ArenaStatus.Waiting) {
    return 'arena_started';
  }
  if (newStatus === ArenaStatus.Ended && oldStatus !== ArenaStatus.Ended) {
    return 'arena_ended';
  }
  if (newStatus === ArenaStatus.Canceled || isCanceled) {
    return 'arena_canceled';
  }
  return null;
}

/**
 * Update player win/loss stats when arena ends
 */
async function updatePlayerWinLossStats(arenaId: bigint, winningAsset: number): Promise<void> {
  const playerEntries = await prisma.playerEntry.findMany({
    where: { arenaId },
  });

  for (const entry of playerEntries) {
    const isWinner = entry.assetIndex === winningAsset;
    
    // Check if we already processed this result
    const existingAction = await prisma.playerAction.findFirst({
      where: {
        arenaId,
        playerWallet: entry.playerWallet,
        actionType: { in: ['arena_win', 'arena_loss'] },
      },
    });

    if (existingAction) continue;

    if (isWinner) {
      await prisma.playerStats.update({
        where: { playerWallet: entry.playerWallet },
        data: {
          totalWins: { increment: 1 },
        },
      });

      await prisma.playerAction.create({
        data: {
          arenaId,
          playerWallet: entry.playerWallet,
          actionType: 'arena_win',
          assetIndex: entry.assetIndex,
          usdValue: entry.usdValue,
        },
      });

      logger.info(
        { player: entry.playerWallet.slice(0, 8), arenaId: arenaId.toString() },
        'Player won - stats updated'
      );
    } else {
      await prisma.playerStats.update({
        where: { playerWallet: entry.playerWallet },
        data: {
          totalLosses: { increment: 1 },
          totalUsdLost: { increment: entry.usdValue },
        },
      });

      await prisma.playerAction.create({
        data: {
          arenaId,
          playerWallet: entry.playerWallet,
          actionType: 'arena_loss',
          assetIndex: entry.assetIndex,
          usdValue: entry.usdValue,
        },
      });

      logger.info(
        { player: entry.playerWallet.slice(0, 8), arenaId: arenaId.toString() },
        'Player lost - stats updated'
      );
    }
  }

  // Update win rates for all affected players
  for (const entry of playerEntries) {
    const stats = await prisma.playerStats.findUnique({
      where: { playerWallet: entry.playerWallet },
    });
    
    if (stats) {
      const totalGames = stats.totalWins + stats.totalLosses;
      const winRate = totalGames > 0 ? Number(((stats.totalWins / totalGames) * 100).toFixed(2)) : 0;
      
      await prisma.playerStats.update({
        where: { playerWallet: entry.playerWallet },
        data: { winRate },
      });
    }
  }

  logger.info({ arenaId: arenaId.toString(), winningAsset }, 'Updated all player win/loss stats');
}

/**
 * Submit arena results to backend for mastery point allocation
 */
async function submitArenaResultsToBackend(arenaId: bigint, winningAsset: number): Promise<void> {
  try {
    const playerEntries = await prisma.playerEntry.findMany({
      where: { arenaId },
    });

    if (playerEntries.length === 0) {
      logger.warn({ arenaId: arenaId.toString() }, 'No player entries found for arena result submission');
      return;
    }

    // Get arena assets to get volatility data
    const arenaAssets = await prisma.arenaAsset.findMany({
      where: { arenaId },
    });

    const assetVolatility = new Map<number, number>();
    for (const asset of arenaAssets) {
      assetVolatility.set(asset.assetIndex, Number(asset.priceMovementBps) || 0);
    }

    const formattedEntries = playerEntries.map(entry => ({
      playerWallet: entry.playerWallet,
      assetIndex: entry.assetIndex,
      tokenAmount: Number(entry.tokenAmount),
      usdValue: Number(entry.usdValue),
      volatility: assetVolatility.get(entry.assetIndex) || 0,
    }));

    const success = await submitArenaResults(arenaId, formattedEntries, winningAsset);
    
    if (success) {
      logger.info({ arenaId: arenaId.toString() }, 'Arena results submitted to backend');
    } else {
      logger.warn({ arenaId: arenaId.toString() }, 'Failed to submit arena results to backend');
    }
  } catch (error) {
    logger.error(
      { arenaId: arenaId.toString(), error: error instanceof Error ? error.message : String(error) },
      'Error submitting arena results to backend'
    );
  }
}
