import { PublicKey } from '@solana/web3.js';
import { processGlobalState } from './globalState';
import { processArena } from './arena';
import { processArenaAsset } from './arenaAsset';
import { processPlayerEntry } from './playerEntry';
import { SKIP_ACCOUNT_TYPES } from '../parsers/accounts';
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
  // Skip certain account types that don't need processing
  if (SKIP_ACCOUNT_TYPES.includes(accountType)) {
    logger.debug({ accountType, pubkey: pubkey.toString() }, 'Skipping account type');
    return;
  }

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
      case 'WhitelistedToken':
        // Whitelisted tokens are not stored in DB, just used for validation
        logger.debug({ pubkey: pubkey.toString() }, 'WhitelistedToken account detected');
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

