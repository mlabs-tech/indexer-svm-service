import { connectDatabase, disconnectDatabase } from './db';
import { startServer, stopServer } from './api/server';
import { startWebSocketListener, stopWebSocketListener } from './listeners/websocket';
import { startTransactionPoller, stopTransactionPoller, backfillTransactions } from './listeners/transactionPoller';
import { startPriceFetcher, stopPriceFetcher } from './services/priceFetcher';
import { getArenaLifecycleManager } from './services/arenaLifecycle';
import { cacheService } from './services/cacheService';
import logger from './utils/logger';
import config from './config';

let isShuttingDown = false;

async function main(): Promise<void> {
  logger.info('Starting Cryptarena Indexer Service...');
  logger.info({ programId: config.programId }, 'Configuration loaded');

  try {
    // Connect to database
    await connectDatabase();

    // Connect to Redis cache
    await cacheService.connect();

    // Start API server
    await startServer();

    // Check if we need to backfill
    const args = process.argv.slice(2);
    if (args.includes('--backfill')) {
      logger.info('Running backfill...');
      await backfillTransactions();
      logger.info('Backfill complete. Starting normal indexing...');
    }

    // Start transaction poller (primary indexing method - never misses txs)
    await startTransactionPoller();

    // Start WebSocket listener for real-time account updates (faster UI updates)
    await startWebSocketListener();

    // Start price fetcher cron (fetches prices every 30 seconds)
    startPriceFetcher();

    // Start arena lifecycle manager (auto-start and auto-end arenas)
    const lifecycleManager = getArenaLifecycleManager();
    if (process.env.ADMIN_PRIVATE_KEY) {
      await lifecycleManager.start();
      // Recover any missed arenas on startup
      await lifecycleManager.recoverMissedArenas();
      logger.info('  🤖 Arena Lifecycle: Active (auto-start & auto-end)');
    } else {
      logger.warn('  🤖 Arena Lifecycle: DISABLED (ADMIN_PRIVATE_KEY not set)');
    }

    logger.info('═'.repeat(60));
    logger.info('Indexer service fully started');
    logger.info('  📊 Transaction Poller: Active (guaranteed delivery)');
    logger.info('  🔌 WebSocket: Active (real-time updates)');
    logger.info('  💰 Price Fetcher: Active (30s interval)');
    logger.info('  🌐 API Server: http://' + config.host + ':' + config.port);
    logger.info('═'.repeat(60));

  } catch (error) {
    logger.error({ error }, 'Failed to start indexer service');
    await shutdown();
    process.exit(1);
  }
}

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Shutting down indexer service...');

  try {
    // Stop arena lifecycle manager
    const lifecycleManager = getArenaLifecycleManager();
    if (lifecycleManager.isActive()) {
      await lifecycleManager.stop();
    }

    // Stop price fetcher
    stopPriceFetcher();

    // Stop transaction poller
    stopTransactionPoller();

    // Stop WebSocket listener
    await stopWebSocketListener();

    // Stop API server
    await stopServer();

    // Disconnect cache service
    await cacheService.disconnect();

    // Disconnect database
    await disconnectDatabase();

    logger.info('Indexer service shut down gracefully');
  } catch (error) {
    logger.error({ error }, 'Error during shutdown');
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT');
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM');
  await shutdown();
  process.exit(0);
});

process.on('uncaughtException', async (error) => {
  logger.error({ error }, 'Uncaught exception');
  await shutdown();
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
  await shutdown();
  process.exit(1);
});

// Start the service
main();
