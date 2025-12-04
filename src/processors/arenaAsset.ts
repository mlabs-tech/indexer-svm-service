import { PublicKey } from '@solana/web3.js';
import { parseArenaAsset } from '../parsers/accounts';
import prisma from '../db';
import logger from '../utils/logger';

/**
 * Process ArenaAsset account update
 */
export async function processArenaAsset(pubkey: PublicKey, data: Buffer): Promise<void> {
  const arenaAsset = parseArenaAsset(data);
  const pda = pubkey.toString();

  // Find the arena by its PDA
  const arena = await prisma.arena.findFirst({
    where: { pda: arenaAsset.arena.toString() },
  });

  if (!arena) {
    logger.warn(
      { arenaPda: arenaAsset.arena.toString() },
      'ArenaAsset references unknown arena'
    );
    return;
  }

  // Convert prices (8 decimals)
  const startPrice = arenaAsset.startPrice > 0n 
    ? Number(arenaAsset.startPrice) / 1e8 
    : null;
  const endPrice = arenaAsset.endPrice > 0n 
    ? Number(arenaAsset.endPrice) / 1e8 
    : null;
  const priceMovementBps = Number(arenaAsset.priceMovement);

  // Check if this is the winning asset
  const isWinner = arena.winningAsset === arenaAsset.assetIndex;

  await prisma.arenaAsset.upsert({
    where: { pda },
    update: {
      playerCount: arenaAsset.playerCount,
      startPrice,
      endPrice,
      priceMovementBps,
      isWinner,
    },
    create: {
      arenaId: arena.arenaId,
      pda,
      assetIndex: arenaAsset.assetIndex,
      playerCount: arenaAsset.playerCount,
      startPrice,
      endPrice,
      priceMovementBps,
      isWinner,
    },
  });

  // Update asset stats
  if (arenaAsset.playerCount > 0) {
    await prisma.assetStats.upsert({
      where: { assetIndex: arenaAsset.assetIndex },
      update: {
        timesChosen: { increment: 0 }, // Will be calculated separately
      },
      create: {
        assetIndex: arenaAsset.assetIndex,
      },
    });
  }

  logger.debug(
    { 
      arenaId: arena.arenaId.toString(),
      assetIndex: arenaAsset.assetIndex,
      players: arenaAsset.playerCount,
      startPrice,
      endPrice,
      movementBps: priceMovementBps,
    },
    'ArenaAsset updated'
  );
}

