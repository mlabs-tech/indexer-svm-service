import { FastifyInstance } from 'fastify';
import prisma from '../../db';
import { getConnection, getSlot } from '../../solana/connection';
import logger from '../../utils/logger';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  // Basic health check
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Database health check
  app.get('/health/db', async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'connected' };
    } catch (error) {
      logger.error({ error }, 'Database health check failed');
      return { status: 'error', database: 'disconnected' };
    }
  });

  // Solana RPC health check
  app.get('/health/rpc', async () => {
    try {
      const slot = await getSlot();
      return { status: 'ok', rpc: 'connected', slot };
    } catch (error) {
      logger.error({ error }, 'RPC health check failed');
      return { status: 'error', rpc: 'disconnected' };
    }
  });

  // Sync status - now tracks both slot and signature
  app.get('/health/sync', async () => {
    try {
      const [slotState, signatureState, txCount, currentSlot] = await Promise.all([
        prisma.syncState.findUnique({ where: { key: 'last_processed_slot' } }),
        prisma.syncState.findUnique({ where: { key: 'last_processed_signature' } }),
        prisma.transaction.count(),
        getSlot(),
      ]);

      const lastSlot = slotState ? parseInt(slotState.value) : 0;
      const lastSignature = signatureState?.value || null;
      const lag = currentSlot - lastSlot;

      return {
        status: lag < 50 ? 'ok' : lag < 200 ? 'syncing' : 'lagging',
        currentSlot,
        lastProcessedSlot: lastSlot,
        lastSignature: lastSignature ? lastSignature.slice(0, 20) + '...' : null,
        slotLag: lag,
        transactionsIndexed: txCount,
        indexingMethod: 'transaction-based',
      };
    } catch (error) {
      logger.error({ error }, 'Sync health check failed');
      return { status: 'error' };
    }
  });

  // Detailed indexer stats
  app.get('/health/indexer', async () => {
    try {
      const [
        txCount,
        arenaCount,
        playerCount,
        eventCount,
        lastTx,
      ] = await Promise.all([
        prisma.transaction.count(),
        prisma.arena.count(),
        prisma.playerEntry.count(),
        prisma.arenaEvent.count(),
        prisma.transaction.findFirst({
          orderBy: { slot: 'desc' },
          select: { signature: true, slot: true, createdAt: true },
        }),
      ]);

      return {
        status: 'ok',
        stats: {
          transactionsIndexed: txCount,
          arenasIndexed: arenaCount,
          playerEntriesIndexed: playerCount,
          eventsRecorded: eventCount,
        },
        lastTransaction: lastTx ? {
          signature: lastTx.signature.slice(0, 20) + '...',
          slot: Number(lastTx.slot),
          indexedAt: lastTx.createdAt,
        } : null,
      };
    } catch (error) {
      logger.error({ error }, 'Indexer stats check failed');
      return { status: 'error' };
    }
  });
}
