import { PublicKey } from '@solana/web3.js';
import { parseGlobalState } from '../parsers/accounts';
import prisma from '../db';
import config from '../config';
import logger from '../utils/logger';

/**
 * Process GlobalState account update
 */
export async function processGlobalState(pubkey: PublicKey, data: Buffer): Promise<void> {
  const state = parseGlobalState(data);

  await prisma.protocolState.upsert({
    where: { programId: config.programId },
    update: {
      admin: state.admin.toString(),
      treasuryWallet: state.treasuryWallet.toString(),
      arenaDuration: Number(state.arenaDuration),
      currentArenaId: state.currentArenaId,
      maxPlayersPerArena: state.maxPlayersPerArena,
      maxSameAsset: state.maxSameAsset,
      isPaused: state.isPaused,
    },
    create: {
      programId: config.programId,
      admin: state.admin.toString(),
      treasuryWallet: state.treasuryWallet.toString(),
      arenaDuration: Number(state.arenaDuration),
      currentArenaId: state.currentArenaId,
      maxPlayersPerArena: state.maxPlayersPerArena,
      maxSameAsset: state.maxSameAsset,
      isPaused: state.isPaused,
    },
  });

  logger.info(
    { 
      currentArenaId: state.currentArenaId.toString(),
      isPaused: state.isPaused 
    },
    'GlobalState updated'
  );
}

