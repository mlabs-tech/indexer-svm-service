import { PublicKey } from '@solana/web3.js';
import { parseGlobalState } from '../parsers/accounts';
import prisma from '../db';
import config from '../config';
import logger from '../utils/logger';

/**
 * Process GlobalState account update (cryptarena-sol)
 */
export async function processGlobalState(pubkey: PublicKey, data: Buffer): Promise<void> {
  const state = parseGlobalState(data);

  // Convert entry fee from lamports to SOL
  const entryFeeSol = Number(state.entryFee) / 1e9;

  await prisma.protocolState.upsert({
    where: { programId: config.programId },
    update: {
      admin: state.admin.toString(),
      treasuryWallet: state.treasuryWallet.toString(),
      arenaDuration: Number(state.arenaDuration),
      currentArenaId: state.currentArenaId,
      maxPlayersPerArena: 10,  // Hardcoded in cryptarena-sol
      maxSameAsset: 1,         // Each token can only be picked once in cryptarena-sol
      isPaused: state.isPaused,
    },
    create: {
      programId: config.programId,
      admin: state.admin.toString(),
      treasuryWallet: state.treasuryWallet.toString(),
      arenaDuration: Number(state.arenaDuration),
      currentArenaId: state.currentArenaId,
      maxPlayersPerArena: 10,
      maxSameAsset: 1,
      isPaused: state.isPaused,
    },
  });

  logger.info(
    { 
      currentArenaId: state.currentArenaId.toString(),
      entryFeeSol,
      arenaDuration: Number(state.arenaDuration),
      isPaused: state.isPaused 
    },
    'GlobalState updated'
  );
}
