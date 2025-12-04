import { PublicKey } from '@solana/web3.js';
import { getConnection, getProgramAccounts } from '../solana/connection';
import config from '../config';
import logger from '../utils/logger';
import { identifyAccountType } from '../parsers/accounts';
import { processAccountUpdate } from '../processors';
import prisma from '../db';

const PROGRAM_ID = new PublicKey(config.programId);

let pollInterval: NodeJS.Timeout | null = null;
let isPolling = false;

/**
 * Poll all program accounts and process updates
 */
async function pollAccounts(): Promise<void> {
  if (isPolling) {
    logger.warn('Previous poll still running, skipping');
    return;
  }

  isPolling = true;
  const startTime = Date.now();

  try {
    const connection = getConnection();
    const currentSlot = await connection.getSlot();

    // Get last synced slot
    const syncState = await prisma.syncState.findUnique({
      where: { key: 'last_polled_slot' },
    });
    const lastSlot = syncState ? parseInt(syncState.value) : 0;

    logger.debug({ currentSlot, lastSlot }, 'Polling accounts');

    // Fetch all program accounts
    const accounts = await getProgramAccounts(PROGRAM_ID);

    let processed = 0;
    for (const { pubkey, account } of accounts) {
      const accountType = identifyAccountType(account.data);
      if (accountType) {
        await processAccountUpdate(pubkey, account.data, accountType, currentSlot);
        processed++;
      }
    }

    // Update last polled slot
    await prisma.syncState.upsert({
      where: { key: 'last_polled_slot' },
      update: { value: currentSlot.toString() },
      create: { key: 'last_polled_slot', value: currentSlot.toString() },
    });

    const duration = Date.now() - startTime;
    logger.info({ accounts: processed, duration, slot: currentSlot }, 'Poll complete');

  } catch (error) {
    logger.error({ error }, 'Error polling accounts');
  } finally {
    isPolling = false;
  }
}

/**
 * Start the account poller
 */
export function startPoller(): void {
  logger.info({ interval: config.pollInterval }, 'Starting account poller');

  // Initial poll
  pollAccounts();

  // Schedule periodic polling
  pollInterval = setInterval(pollAccounts, config.pollInterval);
}

/**
 * Stop the account poller
 */
export function stopPoller(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    logger.info('Account poller stopped');
  }
}

export default {
  startPoller,
  stopPoller,
  pollAccounts,
};

