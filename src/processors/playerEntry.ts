import { PublicKey } from '@solana/web3.js';
import { parsePlayerEntry } from '../parsers/accounts';
import prisma from '../db';
import logger from '../utils/logger';

/**
 * Process PlayerEntry account update
 */
export async function processPlayerEntry(pubkey: PublicKey, data: Buffer): Promise<void> {
  const entry = parsePlayerEntry(data);
  const pda = pubkey.toString();

  // Find the arena by its PDA
  const arena = await prisma.arena.findFirst({
    where: { pda: entry.arena.toString() },
  });

  if (!arena) {
    logger.warn(
      { arenaPda: entry.arena.toString() },
      'PlayerEntry references unknown arena'
    );
    return;
  }

  // Convert amounts
  const tokenAmount = Number(entry.amount) / 1e9;
  const usdValue = Number(entry.usdValue) / 1e6;
  const entryTimestamp = new Date(Number(entry.entryTimestamp) * 1000);

  // Count claimed rewards from bitmap
  let rewardsClaimedCount = 0;
  let bitmap = entry.rewardsClaimedBitmap;
  while (bitmap > 0n) {
    rewardsClaimedCount += Number(bitmap & 1n);
    bitmap >>= 1n;
  }

  const existingEntry = await prisma.playerEntry.findUnique({
    where: { pda },
  });

  const entryData = {
    playerWallet: entry.player.toString(),
    playerIndex: entry.playerIndex,
    assetIndex: entry.assetIndex,
    tokenAmount,
    usdValue,
    entryTimestamp,
    isWinner: entry.isWinner,
    ownTokensClaimed: entry.ownTokensClaimed,
    rewardsClaimedCount,
  };

  if (existingEntry) {
    // Check if winner status changed (arena finalized)
    const wasWinner = existingEntry.isWinner;
    const isNowWinner = entry.isWinner;

    await prisma.playerEntry.update({
      where: { pda },
      data: entryData,
    });

    // Update player stats if winner status changed and arena is finalized
    if (!wasWinner && isNowWinner) {
      // Player became a winner
      await prisma.playerStats.update({
        where: { playerWallet: entry.player.toString() },
        data: {
          totalWins: { increment: 1 },
          winRate: {
            set: await calculateWinRate(entry.player.toString(), true),
          },
        },
      });
      logger.info(
        { player: entry.player.toString().slice(0, 8), arenaId: arena.arenaId.toString() },
        'Player won arena - stats updated'
      );
    } else if (wasWinner === false && isNowWinner === false && existingEntry.ownTokensClaimed === false && entry.ownTokensClaimed === false) {
      // Check if arena is now finalized and this player lost
      // We detect this by checking if the arena's winning_asset is set and different from player's asset
      const updatedArena = await prisma.arena.findUnique({
        where: { arenaId: arena.arenaId },
      });
      
      if (updatedArena && updatedArena.winningAsset !== null && updatedArena.winningAsset !== entry.assetIndex) {
        // Check if we already counted this loss
        const playerStats = await prisma.playerStats.findUnique({
          where: { playerWallet: entry.player.toString() },
        });
        
        // Only count loss once per arena - use arena events to track
        const lossEvent = await prisma.playerAction.findFirst({
          where: {
            arenaId: arena.arenaId,
            playerWallet: entry.player.toString(),
            actionType: 'arena_loss',
          },
        });
        
        if (!lossEvent) {
          await prisma.playerStats.update({
            where: { playerWallet: entry.player.toString() },
            data: {
              totalLosses: { increment: 1 },
              totalUsdLost: { increment: existingEntry.usdValue },
              winRate: {
                set: await calculateWinRate(entry.player.toString(), false),
              },
            },
          });
          
          // Record the loss event to prevent double counting
          await prisma.playerAction.create({
            data: {
              arenaId: arena.arenaId,
              playerWallet: entry.player.toString(),
              actionType: 'arena_loss',
              assetIndex: entry.assetIndex,
              usdValue: existingEntry.usdValue,
            },
          });
          
          logger.info(
            { player: entry.player.toString().slice(0, 8), arenaId: arena.arenaId.toString() },
            'Player lost arena - stats updated'
          );
        }
      }
    }

    logger.debug(
      { 
        arenaId: arena.arenaId.toString(),
        player: entry.player.toString().slice(0, 8),
        isWinner: entry.isWinner,
        claimed: entry.ownTokensClaimed,
      },
      'PlayerEntry updated'
    );
  } else {
    await prisma.playerEntry.create({
      data: {
        arenaId: arena.arenaId,
        pda,
        ...entryData,
      },
    });

    // Create player action event
    await prisma.playerAction.create({
      data: {
        arenaId: arena.arenaId,
        playerWallet: entry.player.toString(),
        actionType: 'enter_arena',
        assetIndex: entry.assetIndex,
        tokenAmount,
        usdValue,
        data: {
          playerIndex: entry.playerIndex,
        },
      },
    });

    // Update or create player stats
    await prisma.playerStats.upsert({
      where: { playerWallet: entry.player.toString() },
      update: {
        totalArenasPlayed: { increment: 1 },
        totalUsdWagered: { increment: usdValue },
        lastPlayedAt: entryTimestamp,
      },
      create: {
        playerWallet: entry.player.toString(),
        totalArenasPlayed: 1,
        totalUsdWagered: usdValue,
        lastPlayedAt: entryTimestamp,
      },
    });

    logger.info(
      { 
        arenaId: arena.arenaId.toString(),
        player: entry.player.toString().slice(0, 8),
        assetIndex: entry.assetIndex,
        usdValue,
      },
      'PlayerEntry created'
    );
  }
}

/**
 * Calculate win rate for a player
 */
async function calculateWinRate(playerWallet: string, justWon: boolean): Promise<number> {
  const stats = await prisma.playerStats.findUnique({
    where: { playerWallet },
  });
  
  if (!stats) return 0;
  
  const totalWins = stats.totalWins + (justWon ? 1 : 0);
  const totalLosses = stats.totalLosses + (justWon ? 0 : 1);
  const totalGames = totalWins + totalLosses;
  
  if (totalGames === 0) return 0;
  
  return Number(((totalWins / totalGames) * 100).toFixed(2));
}

