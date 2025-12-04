import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { getPriceHistory, getLatestPrices, calculateVolatility } from '../../services/priceFetcher';
import { ASSETS } from '../../types/accounts';

const prisma = new PrismaClient();

export async function pricesRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Get latest prices for all assets
   */
  app.get('/api/v1/prices/latest', async (request, reply) => {
    try {
      const prices = await getLatestPrices();
      
      return {
        data: prices.map(p => ({
          ...p,
          symbol: ASSETS.find(a => a.index === p.assetIndex)?.symbol || `TOKEN_${p.assetIndex}`,
        })),
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      reply.status(500).send({ error: 'Failed to fetch latest prices' });
    }
  });

  /**
   * Get price history for specific assets
   * Query params:
   * - assets: comma-separated asset indices (e.g., "0,1,4")
   * - startTime: ISO timestamp
   * - endTime: ISO timestamp
   * - interval: '1m' | '5m' | '15m' | '1h' | '4h'
   */
  app.get('/api/v1/prices/history', async (request, reply) => {
    const { assets, startTime, endTime, interval } = request.query as {
      assets?: string;
      startTime?: string;
      endTime?: string;
      interval?: '1m' | '5m' | '15m' | '1h' | '4h';
    };

    // Parse asset indices
    const assetIndices = assets 
      ? assets.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n))
      : Array.from({ length: 14 }, (_, i) => i); // Default to all assets

    // Parse time range
    const start = startTime ? new Date(startTime) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const end = endTime ? new Date(endTime) : new Date();

    try {
      const history = await getPriceHistory({
        assetIndices,
        startTime: start,
        endTime: end,
        interval: interval || '1m',
      });

      return {
        data: history.map(h => ({
          assetIndex: h.assetIndex,
          symbol: ASSETS.find(a => a.index === h.assetIndex)?.symbol || `TOKEN_${h.assetIndex}`,
          prices: h.prices.map(p => ({
            timestamp: p.timestamp.toISOString(),
            price: p.price,
          })),
        })),
        meta: {
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          interval: interval || '1m',
          assetCount: history.length,
        },
      };
    } catch (error) {
      reply.status(500).send({ error: 'Failed to fetch price history' });
    }
  });

  /**
   * Get volatility data for an arena
   * This returns price history + volatility calculations for all assets in the arena
   */
  app.get('/api/v1/prices/arena/:arenaId/volatility', async (request, reply) => {
    const { arenaId } = request.params as { arenaId: string };
    const { interval } = request.query as { interval?: '1m' | '5m' | '15m' | '1h' | '4h' };

    try {
      // Get arena details
      const arena = await prisma.arena.findUnique({
        where: { arenaId: BigInt(arenaId) },
        include: {
          arenaAssets: true,
        },
      });

      if (!arena) {
        return reply.status(404).send({ error: 'Arena not found' });
      }

      // Get the asset indices for this arena
      const assetIndices = arena.arenaAssets.map(a => a.assetIndex);

      // Find the earliest available price data
      const earliestPrice = await prisma.priceHistory.findFirst({
        where: { assetIndex: { in: assetIndices } },
        orderBy: { timestamp: 'asc' },
      });

      // Determine time range - use available data, not arena timestamps
      // Use earliest price data or arena start, whichever is later
      const arenaStart = arena.startTimestamp || arena.createdAt;
      const dataStart = earliestPrice?.timestamp || new Date();
      const startTime = dataStart > arenaStart ? dataStart : arenaStart;
      
      // End time is always now for live data
      const endTime = new Date();

      // Get price history
      const history = await getPriceHistory({
        assetIndices,
        startTime,
        endTime,
        interval: interval || '1m',
      });

      // Get start prices from arena assets or from first available price
      const startPrices = new Map<number, number>();
      for (const asset of arena.arenaAssets) {
        if (asset.startPrice && Number(asset.startPrice) > 0) {
          startPrices.set(asset.assetIndex, Number(asset.startPrice));
        }
      }

      // If we don't have start prices from arena, use first price from history
      for (const h of history) {
        if (!startPrices.has(h.assetIndex) && h.prices.length > 0) {
          startPrices.set(h.assetIndex, h.prices[0].price);
        }
      }

      // Calculate volatility for each data point
      const volatilityData = history.map(h => {
        const startPrice = startPrices.get(h.assetIndex) || (h.prices[0]?.price || 0);
        const symbol = ASSETS.find(a => a.index === h.assetIndex)?.symbol || `TOKEN_${h.assetIndex}`;
        
        return {
          assetIndex: h.assetIndex,
          symbol,
          startPrice,
          data: h.prices.map(p => ({
            timestamp: p.timestamp.toISOString(),
            price: p.price,
            volatility: startPrice > 0 ? calculateVolatility(startPrice, p.price) : 0,
          })),
        };
      });

      return {
        arenaId: arena.arenaId.toString(),
        status: arena.status,
        startTimestamp: startTime.toISOString(),
        endTimestamp: endTime.toISOString(),
        winningAsset: arena.winningAsset,
        assets: volatilityData,
        meta: {
          interval: interval || '1m',
          assetCount: assetIndices.length,
        },
      };
    } catch (error) {
      console.error('Error fetching arena volatility:', error);
      reply.status(500).send({ error: 'Failed to fetch arena volatility data' });
    }
  });

  /**
   * Get current volatility snapshot for active arenas
   */
  app.get('/api/v1/prices/active-arenas/volatility', async (request, reply) => {
    try {
      // Find active arenas (status 3 = Active)
      const activeArenas = await prisma.arena.findMany({
        where: { status: 3 },
        include: {
          arenaAssets: true,
        },
      });

      if (activeArenas.length === 0) {
        return { arenas: [] };
      }

      // Get latest prices
      const latestPrices = await getLatestPrices();
      const priceMap = new Map(latestPrices.map(p => [p.assetIndex, p.price]));

      const arenaData = activeArenas.map(arena => {
        const assets = arena.arenaAssets.map(asset => {
          const currentPrice = priceMap.get(asset.assetIndex) || 0;
          const startPrice = asset.startPrice ? Number(asset.startPrice) : currentPrice;
          
          return {
            assetIndex: asset.assetIndex,
            symbol: ASSETS.find(a => a.index === asset.assetIndex)?.symbol || `TOKEN_${asset.assetIndex}`,
            startPrice,
            currentPrice,
            volatility: calculateVolatility(startPrice, currentPrice),
            playerCount: asset.playerCount,
          };
        });

        // Sort by volatility (highest first)
        assets.sort((a, b) => b.volatility - a.volatility);

        return {
          arenaId: arena.arenaId.toString(),
          startTimestamp: arena.startTimestamp?.toISOString(),
          endTimestamp: arena.endTimestamp?.toISOString(),
          playerCount: arena.playerCount,
          assets,
          leader: assets[0] || null,
        };
      });

      return { arenas: arenaData };
    } catch (error) {
      console.error('Error fetching active arena volatility:', error);
      reply.status(500).send({ error: 'Failed to fetch active arena volatility' });
    }
  });
}

