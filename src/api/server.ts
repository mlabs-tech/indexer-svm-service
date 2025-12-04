import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import config from '../config';
import logger from '../utils/logger';
import { registerArenaRoutes } from './routes/arenas';
import { registerPlayerRoutes } from './routes/players';
import { registerStatsRoutes } from './routes/stats';
import { registerHealthRoutes } from './routes/health';
import { pricesRoutes } from './routes/prices';

let app: FastifyInstance | null = null;

export async function createServer(): Promise<FastifyInstance> {
  app = Fastify({
    logger: false, // We use our own logger
  });

  // Register plugins
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(websocket);

  // Register routes
  await registerHealthRoutes(app);
  await registerArenaRoutes(app);
  await registerPlayerRoutes(app);
  await registerStatsRoutes(app);
  await pricesRoutes(app);

  return app;
}

export async function startServer(): Promise<void> {
  if (!app) {
    app = await createServer();
  }

  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info({ port: config.port, host: config.host }, 'API server started');
  } catch (error) {
    logger.error({ error }, 'Failed to start API server');
    throw error;
  }
}

export async function stopServer(): Promise<void> {
  if (app) {
    await app.close();
    logger.info('API server stopped');
    app = null;
  }
}

export { app };

