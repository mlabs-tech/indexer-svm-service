import { PublicKey } from '@solana/web3.js';
import { processGlobalState } from './globalState';
import { processArena } from './arena';
import { processArenaAsset } from './arenaAsset';
import { processPlayerEntry } from './playerEntry';
import logger from '../utils/logger';

/**
 * Route account updates to the appropriate processor
 */
export async function processAccountUpdate(
  pubkey: PublicKey,
  data: Buffer,
  accountType: string,
  slot: number
): Promise<void> {
  try {
    switch (accountType) {
      case 'GlobalState':
        await processGlobalState(pubkey, data);
        break;
      case 'Arena':
        await processArena(pubkey, data);
        break;
      case 'ArenaAsset':
        await processArenaAsset(pubkey, data);
        break;
      case 'PlayerEntry':
        await processPlayerEntry(pubkey, data);
        break;
      default:
        logger.warn({ accountType }, 'Unknown account type');
    }
  } catch (error) {
    logger.error({ error, pubkey: pubkey.toString(), accountType }, 'Error processing account');
    throw error;
  }
}

export * from './globalState';
export * from './arena';
export * from './arenaAsset';
export * from './playerEntry';

