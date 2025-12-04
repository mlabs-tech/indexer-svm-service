import { PublicKey } from '@solana/web3.js';
import { parseArena } from '../parsers/accounts';
import { ArenaStatus, ArenaStatusLabels } from '../types/accounts';
import prisma from '../db';
import logger from '../utils/logger';
import { submitArenaResults } from '../services/backendApi';

/**
 * Process Arena account update
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

  // Calculate total pool in USD (6 decimals)
  const totalPoolUsd = Number(arena.totalPool) / 1_000_000;

  const existingArena = await prisma.arena.findUnique({
    where: { arenaId: arena.id },
  });

  const arenaData = {
    pda,
    status: arena.status,
    playerCount: arena.playerCount,
    assetCount: arena.assetCount,
    winningAsset: arena.winningAsset === 255 ? null : arena.winningAsset,
    isSuspended: arena.isSuspended,
    startTimestamp,
    endTimestamp,
    totalPoolUsd,
  };

  if (existingArena) {
    // Track status changes for events
    const statusChanged = existingArena.status !== arena.status;

    await prisma.arena.update({
      where: { arenaId: arena.id },
      data: arenaData,
    });

    // Create event if status changed
    if (statusChanged) {
      const eventType = getStatusChangeEventType(existingArena.status, arena.status);
      if (eventType) {
        await prisma.arenaEvent.create({
          data: {
            arenaId: arena.id,
            eventType,
            data: {
              previousStatus: ArenaStatusLabels[existingArena.status as ArenaStatus],
              newStatus: ArenaStatusLabels[arena.status],
              winningAsset: arena.winningAsset !== 255 ? arena.winningAsset : null,
            },
          },
        });
      }

      // If arena just ended (Ended or Finalized status), update player win/loss stats
      if (arena.status === ArenaStatus.Ended && arena.winningAsset !== 255) {
        await updatePlayerWinLossStats(arena.id, arena.winningAsset);
        
        // Submit results to backend for mastery point allocation
        await submitArenaResultsToBackend(arena.id, arena.winningAsset);
      }
    }

    logger.debug(
      { 
        arenaId: arena.id.toString(), 
        status: ArenaStatusLabels[arena.status],
        players: arena.playerCount 
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
 * Determine event type based on status change
 */
function getStatusChangeEventType(oldStatus: number, newStatus: number): string | null {
  if (newStatus === ArenaStatus.Ready && oldStatus === ArenaStatus.Waiting) {
    return 'arena_full';
  }
  if (newStatus === ArenaStatus.Active && oldStatus !== ArenaStatus.Active) {
    return 'arena_started';
  }
  if (newStatus === ArenaStatus.Ended && oldStatus !== ArenaStatus.Ended) {
    return 'arena_ended';
  }
  return null;
}

/**
 * Update player win/loss stats when arena ends
 */
async function updatePlayerWinLossStats(arenaId: bigint, winningAsset: number): Promise<void> {
  // Get all player entries for this arena
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

    if (existingAction) continue; // Already processed

    if (isWinner) {
      // Update winner stats
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
      // Update loser stats
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
    // Get all player entries for this arena
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

    // Create a map of asset index to volatility (price movement in bps)
    const assetVolatility = new Map<number, number>();
    for (const asset of arenaAssets) {
      assetVolatility.set(asset.assetIndex, Number(asset.priceMovementBps) || 0);
    }

    // Format entries for the backend API with volatility
    const formattedEntries = playerEntries.map(entry => ({
      playerWallet: entry.playerWallet,
      assetIndex: entry.assetIndex,
      tokenAmount: Number(entry.tokenAmount),
      usdValue: Number(entry.usdValue),
      volatility: assetVolatility.get(entry.assetIndex) || 0,
    }));

    const success = await submitArenaResults(arenaId, formattedEntries, winningAsset);
    
    if (success) {
      logger.info({ arenaId: arenaId.toString() }, 'Arena results submitted to backend for mastery allocation');
    } else {
      logger.warn({ arenaId: arenaId.toString() }, 'Failed to submit arena results to backend (non-fatal)');
    }
  } catch (error) {
    // Non-fatal error - don't fail the indexing process if backend is unavailable
    logger.error(
      { arenaId: arenaId.toString(), error: error instanceof Error ? error.message : String(error) },
      'Error submitting arena results to backend (non-fatal)'
    );
  }
}

