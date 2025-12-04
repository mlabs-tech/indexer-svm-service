import { PublicKey, ConfirmedSignatureInfo, ParsedTransactionWithMeta } from '@solana/web3.js';
import { getConnection } from '../solana/connection';
import config from '../config';
import logger from '../utils/logger';
import prisma from '../db';
import { processTransaction } from '../processors/transaction';

const PROGRAM_ID = new PublicKey(config.programId);
const BATCH_SIZE = 100; // Number of signatures to fetch per batch
const POLL_INTERVAL = 2000; // 2 seconds between polls
const MAX_RETRIES = 3;

let pollInterval: NodeJS.Timeout | null = null;
let isPolling = false;
let lastSignature: string | null = null;

/**
 * Get the last processed signature from database
 */
async function getLastProcessedSignature(): Promise<string | null> {
  const syncState = await prisma.syncState.findUnique({
    where: { key: 'last_processed_signature' },
  });
  return syncState?.value || null;
}

/**
 * Save the last processed signature to database
 */
async function saveLastProcessedSignature(signature: string): Promise<void> {
  await prisma.syncState.upsert({
    where: { key: 'last_processed_signature' },
    update: { value: signature },
    create: { key: 'last_processed_signature', value: signature },
  });
}

/**
 * Get the last processed slot from database
 */
async function getLastProcessedSlot(): Promise<number> {
  const syncState = await prisma.syncState.findUnique({
    where: { key: 'last_processed_slot' },
  });
  return syncState ? parseInt(syncState.value) : 0;
}

/**
 * Save the last processed slot to database
 */
async function saveLastProcessedSlot(slot: number): Promise<void> {
  await prisma.syncState.upsert({
    where: { key: 'last_processed_slot' },
    update: { value: slot.toString() },
    create: { key: 'last_processed_slot', value: slot.toString() },
  });
}

/**
 * Fetch transaction signatures for the program
 */
async function fetchSignatures(beforeSignature?: string): Promise<ConfirmedSignatureInfo[]> {
  const connection = getConnection();
  
  const options: any = {
    limit: BATCH_SIZE,
  };
  
  if (beforeSignature) {
    options.before = beforeSignature;
  }

  return connection.getSignaturesForAddress(PROGRAM_ID, options, 'confirmed');
}

/**
 * Fetch and parse a transaction
 */
async function fetchTransaction(signature: string, retries = 0): Promise<ParsedTransactionWithMeta | null> {
  const connection = getConnection();
  
  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    return tx;
  } catch (error) {
    if (retries < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, 1000 * (retries + 1)));
      return fetchTransaction(signature, retries + 1);
    }
    logger.error({ error, signature }, 'Failed to fetch transaction after retries');
    return null;
  }
}

/**
 * Process new transactions since last checkpoint
 */
async function pollNewTransactions(): Promise<void> {
  if (isPolling) {
    return;
  }

  isPolling = true;
  const startTime = Date.now();

  try {
    // Get signatures newer than our last processed
    // Note: getSignaturesForAddress returns newest first, so we need to reverse for processing
    const signatures = await fetchSignatures();
    
    if (signatures.length === 0) {
      isPolling = false;
      return;
    }

    // Filter out already processed signatures
    const newSignatures: ConfirmedSignatureInfo[] = [];
    for (const sig of signatures) {
      if (lastSignature && sig.signature === lastSignature) {
        break; // We've reached our last processed signature
      }
      newSignatures.push(sig);
    }

    if (newSignatures.length === 0) {
      isPolling = false;
      return;
    }

    // Process in chronological order (reverse since API returns newest first)
    const toProcess = newSignatures.reverse();
    
    logger.info({ count: toProcess.length }, 'Processing new transactions');

    let processed = 0;
    let maxSlot = 0;

    for (const sigInfo of toProcess) {
      // Skip failed transactions
      if (sigInfo.err) {
        continue;
      }

      // Check if already processed (deduplication)
      const existing = await prisma.transaction.findUnique({
        where: { signature: sigInfo.signature },
      });
      
      if (existing) {
        continue;
      }

      // Fetch full transaction
      const tx = await fetchTransaction(sigInfo.signature);
      
      if (tx && !tx.meta?.err) {
        await processTransaction(tx, sigInfo.signature, sigInfo.slot);
        processed++;
        maxSlot = Math.max(maxSlot, sigInfo.slot);
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Update last processed
    if (toProcess.length > 0) {
      lastSignature = toProcess[toProcess.length - 1].signature;
      await saveLastProcessedSignature(lastSignature);
      
      if (maxSlot > 0) {
        await saveLastProcessedSlot(maxSlot);
      }
    }

    const duration = Date.now() - startTime;
    logger.info({ processed, duration, lastSignature: lastSignature?.slice(0, 16) }, 'Poll complete');

  } catch (error) {
    logger.error({ error }, 'Error polling transactions');
  } finally {
    isPolling = false;
  }
}

/**
 * Backfill historical transactions
 */
export async function backfillTransactions(fromSlot?: number): Promise<void> {
  logger.info({ fromSlot }, 'Starting transaction backfill...');

  let beforeSignature: string | undefined;
  let totalProcessed = 0;
  let batchCount = 0;
  const maxBatches = 100; // Safety limit

  while (batchCount < maxBatches) {
    batchCount++;
    
    const signatures = await fetchSignatures(beforeSignature);
    
    if (signatures.length === 0) {
      break;
    }

    logger.info({ batch: batchCount, count: signatures.length }, 'Processing batch');

    for (const sigInfo of signatures) {
      // Skip failed transactions
      if (sigInfo.err) {
        continue;
      }

      // Stop if we've gone past the fromSlot
      if (fromSlot && sigInfo.slot < fromSlot) {
        logger.info({ slot: sigInfo.slot, fromSlot }, 'Reached target slot, stopping backfill');
        return;
      }

      // Check if already processed
      const existing = await prisma.transaction.findUnique({
        where: { signature: sigInfo.signature },
      });
      
      if (existing) {
        continue;
      }

      // Fetch and process
      const tx = await fetchTransaction(sigInfo.signature);
      
      if (tx && !tx.meta?.err) {
        await processTransaction(tx, sigInfo.signature, sigInfo.slot);
        totalProcessed++;

        if (totalProcessed % 50 === 0) {
          logger.info({ processed: totalProcessed }, 'Backfill progress');
        }
      }

      await new Promise(resolve => setTimeout(resolve, 100)); // Rate limiting
    }

    // Move to next batch
    beforeSignature = signatures[signatures.length - 1].signature;
  }

  logger.info({ totalProcessed }, 'Backfill complete');
}

/**
 * Start the transaction poller
 */
export async function startTransactionPoller(): Promise<void> {
  logger.info({ interval: POLL_INTERVAL }, 'Starting transaction poller');

  // Load last processed signature
  lastSignature = await getLastProcessedSignature();
  logger.info({ lastSignature: lastSignature?.slice(0, 16) || 'none' }, 'Resuming from checkpoint');

  // Initial poll
  await pollNewTransactions();

  // Schedule periodic polling
  pollInterval = setInterval(pollNewTransactions, POLL_INTERVAL);
}

/**
 * Stop the transaction poller
 */
export function stopTransactionPoller(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    logger.info('Transaction poller stopped');
  }
}

export default {
  startTransactionPoller,
  stopTransactionPoller,
  backfillTransactions,
  pollNewTransactions,
};

