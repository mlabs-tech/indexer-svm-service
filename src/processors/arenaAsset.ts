import { PublicKey } from '@solana/web3.js';
import prisma from '../db';
import logger from '../utils/logger';

/**
 * Process ArenaAsset (cryptarena-sol)
 * NOTE: In cryptarena-sol, ArenaAsset account type no longer exists on-chain.
 * Price data is now stored directly on PlayerEntry accounts.
 * This processor is kept for compatibility but won't receive on-chain updates.
 * ArenaAsset records are created/updated via playerEntry.ts when processing PlayerEntry accounts.
 */
export async function processArenaAsset(pubkey: PublicKey, data: Buffer): Promise<void> {
  // ArenaAsset doesn't exist in cryptarena-sol
  // This function is kept for compatibility but shouldn't be called
  logger.warn(
    { pubkey: pubkey.toString() },
    'processArenaAsset called but ArenaAsset accounts do not exist in cryptarena-sol'
  );
}
