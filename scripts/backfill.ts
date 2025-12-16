/**
 * Backfill Script
 * 
 * Fetches all historical transactions and accounts from the Cryptarena program 
 * and populates the database. Uses transaction-based indexing to ensure no
 * transactions are missed.
 * 
 * Usage:
 *   npm run backfill                    # Full backfill
 *   npm run backfill -- --from-slot 123 # Backfill from specific slot
 *   npm run backfill -- --accounts-only # Only sync current account state
 */

import { PublicKey } from '@solana/web3.js';

import { connectDatabase, disconnectDatabase } from '../src/db';
import { getProgramAccounts } from '../src/solana/connection';
import { identifyAccountType } from '../src/parsers/accounts';
import { processAccountUpdate } from '../src/processors';
import { backfillTransactions } from '../src/listeners/transactionPoller';
import config from '../src/config';
import logger from '../src/utils/logger';

const PROGRAM_ID = new PublicKey(config.programId);

async function backfillAccounts(): Promise<void> {
  logger.info('Backfilling current account state...');

  // Fetch all program accounts
  logger.info({ programId: PROGRAM_ID.toString() }, 'Fetching all program accounts...');
  const accounts = await getProgramAccounts(PROGRAM_ID);
  logger.info({ count: accounts.length }, 'Fetched accounts');

  // Group accounts by type
  const accountsByType: Record<string, { pubkey: PublicKey; data: Buffer }[]> = {
    GlobalState: [],
    Arena: [],
    ArenaAsset: [],
    PlayerEntry: [],
  };

  for (const { pubkey, account } of accounts) {
    const accountType = identifyAccountType(account.data);
    if (accountType && accountsByType[accountType]) {
      accountsByType[accountType].push({ pubkey, data: account.data });
    }
  }

  logger.info({
    globalState: accountsByType.GlobalState.length,
    arenas: accountsByType.Arena.length,
    arenaAssets: accountsByType.ArenaAsset.length,
    playerEntries: accountsByType.PlayerEntry.length,
  }, 'Accounts by type');

  // Process in order: GlobalState -> Arena -> ArenaAsset -> PlayerEntry
  const processingOrder = ['GlobalState', 'Arena', 'ArenaAsset', 'PlayerEntry'];
  let totalProcessed = 0;

  for (const accountType of processingOrder) {
    const typeAccounts = accountsByType[accountType];
    logger.info({ type: accountType, count: typeAccounts.length }, `Processing ${accountType} accounts...`);

    for (const { pubkey, data } of typeAccounts) {
      try {
        await processAccountUpdate(pubkey, data, accountType, 0);
        totalProcessed++;

        if (totalProcessed % 100 === 0) {
          logger.info({ processed: totalProcessed }, 'Progress...');
        }
      } catch (error) {
        logger.error({ error, pubkey: pubkey.toString() }, `Failed to process ${accountType}`);
      }
    }
  }

  logger.info({ totalProcessed }, 'Account backfill complete');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const accountsOnly = args.includes('--accounts-only');
  const fromSlotArg = args.find(a => a.startsWith('--from-slot='));
  const fromSlot = fromSlotArg ? parseInt(fromSlotArg.split('=')[1]) : undefined;

  logger.info('═'.repeat(60));
  logger.info('Cryptarena Indexer - Backfill Script');
  logger.info('═'.repeat(60));
  logger.info({ accountsOnly, fromSlot }, 'Options');

  try {
    // Connect to database
    await connectDatabase();

    if (accountsOnly) {
      // Only sync current account state
      await backfillAccounts();
    } else {
      // Full transaction backfill
      logger.info('Starting transaction backfill...');
      logger.info('This will fetch all historical transactions for the program.');
      logger.info('This may take a while depending on transaction history.');
      logger.info('');

      await backfillTransactions(fromSlot);

      // Then sync current account state
      logger.info('');
      logger.info('Syncing current account state...');
      await backfillAccounts();
    }

    logger.info('═'.repeat(60));
    logger.info('Backfill complete!');
    logger.info('═'.repeat(60));

  } catch (error) {
    logger.error({ error }, 'Backfill failed');
    throw error;
  } finally {
    await disconnectDatabase();
  }
}

// Run backfill
main()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
