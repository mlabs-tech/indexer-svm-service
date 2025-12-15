import { connectDatabase, disconnectDatabase } from './db';
import { startServer, stopServer } from './api/server';
import { startWebSocketListener, stopWebSocketListener } from './listeners/websocket';
import { startTransactionPoller, stopTransactionPoller, backfillTransactions } from './listeners/transactionPoller';
import { startPriceFetcher, stopPriceFetcher } from './services/priceFetcher';
import { getArenaLifecycleManager } from './services/arenaLifecycle';
import { cacheService } from './services/cacheService';
import { tryAcquireLeaderLock, releaseLeaderLock, cleanupLeaderElection, getLeaderStatus, isInstanceLeader, instanceId, onBecomeLeader } from './services/leaderElection';
import logger from './utils/logger';
import config from './config';

let isShuttingDown = false;
let indexerStarted = false;
let workersStarted = false;

async function main(): Promise<void> {
  logger.info({ instanceId }, 'Starting Cryptarena Indexer Service...');
  logger.info({ programId: config.programId }, 'Configuration loaded');

  try {
    // Connect to database
    await connectDatabase();

    // Connect to Redis cache
    await cacheService.connect();

    // Start API server (all instances run the API)
    await startServer();

    // Register callback for when this instance gets promoted to leader
    // This handles the case where a follower becomes leader during deployment
    onBecomeLeader(async () => {
      await startLeaderTasks();
    });

    // Try to become the leader
    const isLeader = await tryAcquireLeaderLock();

    if (isLeader) {
      // Leader: Run indexer and workers
      await startLeaderTasks();
    } else {
      // Follower: Only run API server (will be promoted to leader when lock is released)
      logger.info('═'.repeat(60));
      logger.info({ instanceId }, 'Running as FOLLOWER - API only');
      logger.info('  🌐 API Server: http://' + config.host + ':' + config.port);
      logger.info('  📊 Indexer: DISABLED (not leader)');
      logger.info('  🤖 Workers: DISABLED (not leader)');
      logger.info('  ⏳ Waiting to be promoted to leader...');
      logger.info('═'.repeat(60));
    }

  } catch (error) {
    logger.error({ error }, 'Failed to start indexer service');
    await shutdown();
    process.exit(1);
  }
}

/**
 * Start all leader-specific tasks: indexer, workers, price fetcher
 */
async function startLeaderTasks(): Promise<void> {
  logger.info({ instanceId }, 'Starting leader tasks...');

  // Check if we need to backfill
  const args = process.argv.slice(2);
  if (args.includes('--backfill')) {
    logger.info('Running backfill...');
    await backfillTransactions();
    logger.info('Backfill complete. Starting normal indexing...');
  }

  // Start transaction poller (primary indexing method - never misses txs)
  await startTransactionPoller();
  indexerStarted = true;

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
    workersStarted = true;
  } else {
    logger.warn('  🤖 Arena Lifecycle: DISABLED (ADMIN_PRIVATE_KEY not set)');
  }

  logger.info('═'.repeat(60));
  logger.info({ instanceId }, 'Running as LEADER - Full service');
  logger.info('  📊 Transaction Poller: Active (guaranteed delivery)');
  logger.info('  🔌 WebSocket: Active (real-time updates)');
  logger.info('  💰 Price Fetcher: Active (30s interval)');
  logger.info('  🌐 API Server: http://' + config.host + ':' + config.port);
  logger.info('═'.repeat(60));
}

/**
 * Stop leader-specific tasks
 */
async function stopLeaderTasks(): Promise<void> {
  if (!isInstanceLeader()) {
    return;
  }

  logger.info({ instanceId }, 'Stopping leader tasks...');

  // Stop arena lifecycle manager
  if (workersStarted) {
    const lifecycleManager = getArenaLifecycleManager();
    if (lifecycleManager.isActive()) {
      await lifecycleManager.stop();
    }
    workersStarted = false;
  }

  // Stop price fetcher
  stopPriceFetcher();

  // Stop transaction poller
  if (indexerStarted) {
    stopTransactionPoller();
    indexerStarted = false;
  }

  // Stop WebSocket listener
  await stopWebSocketListener();
}

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ instanceId }, 'Shutting down indexer service...');

  try {
    // Release leader lock first (allows another instance to take over quickly)
    await cleanupLeaderElection();

    // Stop leader tasks if we were the leader
    await stopLeaderTasks();

    // Stop API server
    await stopServer();

    // Disconnect cache service
    await cacheService.disconnect();

    // Disconnect database
    await disconnectDatabase();

    logger.info({ instanceId }, 'Indexer service shut down gracefully');
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

// Export leader status getter for health checks
export { getLeaderStatus };

// Start the service
main();
