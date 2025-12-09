import { PublicKey } from '@solana/web3.js';
import { parsePlayerEntry } from '../parsers/accounts';
import prisma from '../db';
import logger from '../utils/logger';
import { cacheService } from '../services/cacheService';

/**
 * Process PlayerEntry account update (cryptarena-sol)
 * Players now enter with SOL entry fee instead of tokens
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

  // Convert entry fee from lamports to SOL
  const entryFeeSol = Number(entry.entryFee) / 1e9;
  const entryTimestamp = new Date(Number(entry.entryTimestamp) * 1000);

  // Convert prices (8 decimals)
  const startPrice = entry.startPrice > 0n ? Number(entry.startPrice) / 1e8 : null;
  const endPrice = entry.endPrice > 0n ? Number(entry.endPrice) / 1e8 : null;
  const priceMovementBps = Number(entry.priceMovement);

  const existingEntry = await prisma.playerEntry.findUnique({
    where: { pda },
  });

  // For backward compatibility with frontend:
  // - tokenAmount stores the SOL entry fee
  // - usdValue stores the entry fee (can be updated to actual USD value later)
  const entryData = {
    playerWallet: entry.player.toString(),
    playerIndex: entry.playerIndex,
    assetIndex: entry.assetIndex,
    tokenAmount: entryFeeSol,          // SOL entry fee
    usdValue: entryFeeSol,             // Entry fee (SOL amount for now)
    entryPrice: startPrice,            // Start price when available
    actualUsdValue: startPrice ? entryFeeSol * startPrice : null,
    entryTimestamp,
    isWinner: entry.isWinner,
    ownTokensClaimed: entry.hasClaimed, // Using hasClaimed for compatibility
    rewardsClaimedCount: entry.hasClaimed ? 1 : 0,
    rewardsClaimedBitmap: entry.hasClaimed ? '1' : '0',
  };

  if (existingEntry) {
    const wasWinner = existingEntry.isWinner;
    const isNowWinner = entry.isWinner;

    await prisma.playerEntry.update({
      where: { pda },
      data: entryData,
    });

    // Invalidate cache for this arena
    await cacheService.invalidateArena(arena.arenaId.toString());

    // Update ArenaAsset with price data from PlayerEntry
    await updateArenaAssetFromPlayerEntry(arena.arenaId, entry.assetIndex, startPrice, endPrice, priceMovementBps, entry.isWinner);

    // Update player stats if winner status changed
    if (!wasWinner && isNowWinner) {
      await prisma.playerStats.upsert({
        where: { playerWallet: entry.player.toString() },
        update: {
          totalWins: { increment: 1 },
        },
        create: {
          playerWallet: entry.player.toString(),
          totalWins: 1,
        },
      });
      logger.info(
        { player: entry.player.toString().slice(0, 8), arenaId: arena.arenaId.toString() },
        'Player won arena - stats updated'
      );
    }

    logger.debug(
      { 
        arenaId: arena.arenaId.toString(),
        player: entry.player.toString().slice(0, 8),
        isWinner: entry.isWinner,
        claimed: entry.hasClaimed,
        priceMovement: priceMovementBps,
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

    // Invalidate cache for this arena
    await cacheService.invalidateArena(arena.arenaId.toString());

    // Create/update ArenaAsset for this token
    await updateArenaAssetFromPlayerEntry(arena.arenaId, entry.assetIndex, startPrice, endPrice, priceMovementBps, entry.isWinner);

    // Create player action event
    await prisma.playerAction.create({
      data: {
        arenaId: arena.arenaId,
        playerWallet: entry.player.toString(),
        actionType: 'enter_arena',
        assetIndex: entry.assetIndex,
        tokenAmount: entryFeeSol,
        usdValue: entryFeeSol,
        data: {
          playerIndex: entry.playerIndex,
          entryFeeLamports: entry.entryFee.toString(),
        },
      },
    });

    // Update or create player stats
    await prisma.playerStats.upsert({
      where: { playerWallet: entry.player.toString() },
      update: {
        totalArenasPlayed: { increment: 1 },
        totalUsdWagered: { increment: entryFeeSol },
        lastPlayedAt: entryTimestamp,
      },
      create: {
        playerWallet: entry.player.toString(),
        totalArenasPlayed: 1,
        totalUsdWagered: entryFeeSol,
        lastPlayedAt: entryTimestamp,
      },
    });

    logger.info(
      { 
        arenaId: arena.arenaId.toString(),
        player: entry.player.toString().slice(0, 8),
        assetIndex: entry.assetIndex,
        entryFeeSol,
      },
      'PlayerEntry created'
    );
  }
}

/**
 * Update ArenaAsset from PlayerEntry data
 * In cryptarena-sol, prices are stored on PlayerEntry, but we maintain ArenaAsset for frontend compatibility
 */
async function updateArenaAssetFromPlayerEntry(
  arenaId: bigint,
  assetIndex: number,
  startPrice: number | null,
  endPrice: number | null,
  priceMovementBps: number,
  isWinner: boolean
): Promise<void> {
  // Generate a deterministic PDA-like string for the ArenaAsset
  const arenaPda = `arena_asset_${arenaId}_${assetIndex}`;

  await prisma.arenaAsset.upsert({
    where: { pda: arenaPda },
    update: {
      startPrice,
      endPrice,
      priceMovementBps,
      isWinner,
      playerCount: 1, // Each token can only have 1 player in cryptarena-sol
    },
    create: {
      arenaId,
      pda: arenaPda,
      assetIndex,
      playerCount: 1,
      startPrice,
      endPrice,
      priceMovementBps,
      isWinner,
    },
  });
}
