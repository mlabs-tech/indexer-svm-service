import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';

const prisma = new PrismaClient();

// Pyth Hermes API configuration
const PYTH_HERMES_URL = process.env.PYTH_HERMES_URL || 'https://hermes.pyth.network';

// Token to Pyth feed ID mapping (hardcoded for reliability)
const TOKEN_PYTH_FEEDS: Record<number, { symbol: string; feedId: string }> = {
  // Solana tokens
  0: { symbol: 'SOL', feedId: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d' },
  1: { symbol: 'TRUMP', feedId: '0x879551021853eec7a7dc827578e8e69da7e4fa8148339aa0d3d5296405be4b1a' },
  2: { symbol: 'PUMP', feedId: '0x7a01fca212788bba7c5bf8c9efd576a8a722f070d2c17596ff7bb609b8d5c3b9' },
  3: { symbol: 'BONK', feedId: '0x72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419' },
  4: { symbol: 'JUP', feedId: '0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996' },
  5: { symbol: 'PENGU', feedId: '0xbed3097008b9b5e3c93bec20be79cb43986b85a996475589351a21e67bae9b61' },
  6: { symbol: 'PYTH', feedId: '0x0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff' },
  7: { symbol: 'HNT', feedId: '0x649fdd7ec08e8e2a20f425729854e90293dcbe2376abc47197a14da6ff339756' },
  8: { symbol: 'FARTCOIN', feedId: '0x58cd29ef0e714c5affc44f269b2c1899a52da4169d7acc147b9da692e6953608' },
  9: { symbol: 'RAY', feedId: '0x91568baa8beb53db23eb3fb7f22c6e8bd303d103919e19733f2bb642d3e7987a' },
  10: { symbol: 'JTO', feedId: '0xb43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2' },
  11: { symbol: 'KMNO', feedId: '0xb17e5bc5de742a8a378b54c9c75442b7d51e30ada63f28d9bd28d3c0e26511a0' },
  12: { symbol: 'MET', feedId: '0x0292e0f405bcd4a496d34e48307f6787349ad2bcd8505c3d3a9f77d81a67a682' },
  13: { symbol: 'W', feedId: '0xeff7446475e218517566ea99e72a4abec2e1bd8498b43b7d8331e29dcb059389' },
  // EVM tokens
  14: { symbol: 'ETH', feedId: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace' },
  15: { symbol: 'UNI', feedId: '0x78d185a741d07edb3412b09008b7c5cfb9bbbd7d568bf00ba737b456ba171501' },
  16: { symbol: 'LINK', feedId: '0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221' },
  17: { symbol: 'PEPE', feedId: '0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4' },
  18: { symbol: 'SHIB', feedId: '0xf0d57deca57b3da2fe63a493f4c25925fdfd8edf834b20f93e1f84dbd1504d4a' },
};

// Symbol to feed ID lookup
const SYMBOL_TO_FEED_ID: Record<string, string> = Object.fromEntries(
  Object.values(TOKEN_PYTH_FEEDS).map(t => [t.symbol, t.feedId])
);

let fetchInterval: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Get feed ID for a symbol (without 0x prefix for API calls)
 */
function getFeedIdForApi(feedId: string): string {
  return feedId.startsWith('0x') ? feedId.slice(2) : feedId;
}

/**
 * Fetch current prices for all tokens from Pyth Hermes
 */
async function fetchPrices(): Promise<void> {
  try {
    // Get all feed IDs
    const feedIds = Object.values(TOKEN_PYTH_FEEDS).map(t => getFeedIdForApi(t.feedId));
    const feedIdToAssetIndex: Map<string, number> = new Map();

    for (const [indexStr, tokenInfo] of Object.entries(TOKEN_PYTH_FEEDS)) {
      feedIdToAssetIndex.set(getFeedIdForApi(tokenInfo.feedId), parseInt(indexStr));
    }

    // Fetch prices from Pyth Hermes
    const idsParam = feedIds.map(id => `ids[]=${id}`).join('&');
    const response = await fetch(`${PYTH_HERMES_URL}/v2/updates/price/latest?${idsParam}`);

    if (!response.ok) {
      throw new Error(`Pyth API error: ${response.status}`);
    }

    const data = await response.json() as {
      parsed: Array<{
        id: string;
        price: {
          price: string;
          expo: number;
          conf: string;
          publish_time: number;
        };
      }>;
    };

    const timestamp = new Date();
    const priceRecords = [];

    for (const priceData of data.parsed || []) {
      const assetIndex = feedIdToAssetIndex.get(priceData.id);
      if (assetIndex === undefined) continue;

      // Convert Pyth price format: price * 10^expo
      const price = Number(priceData.price.price) * Math.pow(10, priceData.price.expo);

      if (price > 0) {
        priceRecords.push({
          assetIndex,
          price,
          timestamp,
          source: 'pyth',
        });
      }
    }

    if (priceRecords.length > 0) {
      await prisma.priceHistory.createMany({
        data: priceRecords,
      });
      logger.debug({ count: priceRecords.length }, 'Stored price history records from Pyth');
    }

  } catch (error) {
    logger.error({ error }, 'Failed to fetch prices from Pyth');
    // Fallback to mock prices on error
    await storeMockPrices();
  }
}

/**
 * Store mock prices (for development/testing)
 */
async function storeMockPrices(): Promise<void> {
  const timestamp = new Date();
  const basePrices: Record<number, number> = {
    0: 200,      // SOL
    1: 15,       // TRUMP
    2: 0.02,     // PUMP
    3: 0.00003,  // BONK
    4: 1.2,      // JUP
    5: 0.03,     // PENGU
    6: 0.40,     // PYTH
    7: 6,        // HNT
    8: 1.5,      // FARTCOIN
    9: 5,        // RAY
    10: 3.5,     // JTO
    11: 0.15,    // KMNO
    12: 0.05,    // MET
    13: 0.30,    // W
    14: 3500,    // ETH
    15: 12,      // UNI
    16: 18,      // LINK
    17: 0.00001, // PEPE
    18: 0.00002, // SHIB
  };

  const priceRecords = Object.entries(basePrices).map(([indexStr, basePrice]) => {
    // Add some random volatility (-2% to +2%)
    const volatility = (Math.random() - 0.5) * 0.04;
    const price = basePrice * (1 + volatility);
    
    return {
      assetIndex: parseInt(indexStr),
      price,
      timestamp,
      source: 'mock',
    };
  });

  await prisma.priceHistory.createMany({
    data: priceRecords,
  });
  
  logger.debug({ count: priceRecords.length }, 'Stored mock price history records');
}

/**
 * Start the price fetcher cron job (runs every 10 seconds for Pyth)
 */
export function startPriceFetcher(): void {
  if (isRunning) {
    logger.warn('Price fetcher is already running');
    return;
  }

  isRunning = true;
  logger.info('Starting Pyth price fetcher service (10s interval)');

  // Fetch immediately on start
  fetchPrices();

  // Then fetch every 10 seconds (Pyth updates frequently)
  fetchInterval = setInterval(fetchPrices, 10 * 1000);
}

/**
 * Stop the price fetcher cron job
 */
export function stopPriceFetcher(): void {
  if (fetchInterval) {
    clearInterval(fetchInterval);
    fetchInterval = null;
  }
  isRunning = false;
  logger.info('Price fetcher service stopped');
}

/**
 * Get price history for specific assets within a timeframe
 */
export async function getPriceHistory(params: {
  assetIndices: number[];
  startTime: Date;
  endTime: Date;
  interval?: '1m' | '5m' | '15m' | '1h' | '4h';
}): Promise<{ assetIndex: number; prices: { timestamp: Date; price: number }[] }[]> {
  const { assetIndices, startTime, endTime, interval = '1m' } = params;

  const records = await prisma.priceHistory.findMany({
    where: {
      assetIndex: { in: assetIndices },
      timestamp: {
        gte: startTime,
        lte: endTime,
      },
    },
    orderBy: { timestamp: 'asc' },
  });

  const groupedByAsset = new Map<number, { timestamp: Date; price: number }[]>();
  
  for (const record of records) {
    if (!groupedByAsset.has(record.assetIndex)) {
      groupedByAsset.set(record.assetIndex, []);
    }
    groupedByAsset.get(record.assetIndex)!.push({
      timestamp: record.timestamp,
      price: Number(record.price),
    });
  }

  const intervalMs = getIntervalMs(interval);
  
  const result = assetIndices.map(assetIndex => {
    const prices = groupedByAsset.get(assetIndex) || [];
    
    if (intervalMs > 10000 && prices.length > 0) {
      return {
        assetIndex,
        prices: aggregatePrices(prices, intervalMs),
      };
    }
    
    return { assetIndex, prices };
  });

  return result;
}

function getIntervalMs(interval: string): number {
  switch (interval) {
    case '1m': return 60 * 1000;
    case '5m': return 5 * 60 * 1000;
    case '15m': return 15 * 60 * 1000;
    case '1h': return 60 * 60 * 1000;
    case '4h': return 4 * 60 * 60 * 1000;
    default: return 60 * 1000;
  }
}

function aggregatePrices(
  prices: { timestamp: Date; price: number }[],
  intervalMs: number
): { timestamp: Date; price: number }[] {
  if (prices.length === 0) return [];

  const aggregated: { timestamp: Date; price: number }[] = [];
  let currentBucket = Math.floor(prices[0].timestamp.getTime() / intervalMs) * intervalMs;
  let bucketPrices: number[] = [];

  for (const p of prices) {
    const pBucket = Math.floor(p.timestamp.getTime() / intervalMs) * intervalMs;
    
    if (pBucket !== currentBucket) {
      if (bucketPrices.length > 0) {
        aggregated.push({
          timestamp: new Date(currentBucket),
          price: bucketPrices[bucketPrices.length - 1],
        });
      }
      currentBucket = pBucket;
      bucketPrices = [];
    }
    
    bucketPrices.push(p.price);
  }

  if (bucketPrices.length > 0) {
    aggregated.push({
      timestamp: new Date(currentBucket),
      price: bucketPrices[bucketPrices.length - 1],
    });
  }

  return aggregated;
}

/**
 * Get latest prices for all assets
 */
export async function getLatestPrices(): Promise<{ assetIndex: number; price: number; timestamp: Date }[]> {
  const latestPrices = await prisma.$queryRaw<{ asset_index: number; price: number; timestamp: Date }[]>`
    SELECT DISTINCT ON (asset_index) 
      asset_index, 
      price::float8 as price, 
      timestamp
    FROM price_history
    ORDER BY asset_index, timestamp DESC
  `;

  return latestPrices.map(p => ({
    assetIndex: p.asset_index,
    price: p.price,
    timestamp: p.timestamp,
  }));
}

/**
 * Calculate volatility (percentage change) from start price
 */
export function calculateVolatility(startPrice: number, currentPrice: number): number {
  if (startPrice === 0) return 0;
  return ((currentPrice - startPrice) / startPrice) * 100;
}

/**
 * Fetch prices from Pyth Hermes for specific symbols (on-demand)
 * Returns a map of symbol -> price
 */
export async function fetchPricesFromPyth(symbols: string[]): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  
  try {
    // Get feed IDs for requested symbols
    const feedIds: string[] = [];
    const feedIdToSymbol: Map<string, string> = new Map();

    for (const symbol of symbols) {
      const feedId = SYMBOL_TO_FEED_ID[symbol];
      if (feedId) {
        const apiId = getFeedIdForApi(feedId);
        feedIds.push(apiId);
        feedIdToSymbol.set(apiId, symbol);
      } else {
        logger.debug({ symbol }, 'No Pyth feed ID found for symbol');
      }
    }

    if (feedIds.length === 0) {
      logger.warn({ symbols }, 'No Pyth feed IDs found for any symbols, using mock prices');
      return getMockPrices(symbols);
    }

    // Fetch prices from Pyth Hermes
    const idsParam = feedIds.map(id => `ids[]=${id}`).join('&');
    const response = await fetch(`${PYTH_HERMES_URL}/v2/updates/price/latest?${idsParam}`);

    if (!response.ok) {
      throw new Error(`Pyth API error: ${response.status}`);
    }

    const data = await response.json() as {
      parsed: Array<{
        id: string;
        price: {
          price: string;
          expo: number;
        };
      }>;
    };

    for (const priceData of data.parsed || []) {
      const symbol = feedIdToSymbol.get(priceData.id);
      if (!symbol) continue;

      const price = Number(priceData.price.price) * Math.pow(10, priceData.price.expo);
      if (price > 0) {
        prices[symbol] = price;
      }
    }

    logger.info({ symbols, priceCount: Object.keys(prices).length }, 'Fetched prices from Pyth');

  } catch (error) {
    logger.error({ error, symbols }, 'Failed to fetch prices from Pyth for lifecycle');
    return getMockPrices(symbols);
  }
  
  return prices;
}

/**
 * Get mock prices for symbols (fallback)
 */
function getMockPrices(symbols: string[]): Record<string, number> {
  const mockPrices: Record<string, number> = {
    SOL: 200, TRUMP: 15, PUMP: 0.02, BONK: 0.00003, JUP: 1.2,
    PENGU: 0.03, PYTH: 0.4, HNT: 6, FARTCOIN: 0.8, RAY: 5,
    JTO: 3, KMNO: 0.1, MET: 0.01, W: 0.3,
    ETH: 3500, UNI: 12, LINK: 18, PEPE: 0.00001, SHIB: 0.00002,
  };
  
  const prices: Record<string, number> = {};
  for (const symbol of symbols) {
    if (mockPrices[symbol]) {
      prices[symbol] = mockPrices[symbol];
    }
  }
  return prices;
}

// Alias for backward compatibility with existing code
export const fetchPricesFromCMC = fetchPricesFromPyth;

/**
 * Get the actual price for an asset at a specific time (or closest available)
 */
export async function getPriceAtTime(assetIndex: number, timestamp: Date): Promise<number | null> {
  const twoMinutesAgo = new Date(timestamp.getTime() - 2 * 60 * 1000);
  const twoMinutesLater = new Date(timestamp.getTime() + 2 * 60 * 1000);
  
  const closestPrice = await prisma.priceHistory.findFirst({
    where: {
      assetIndex,
      timestamp: {
        gte: twoMinutesAgo,
        lte: twoMinutesLater,
      },
    },
    orderBy: [
      {
        timestamp: 'desc',
      },
    ],
  });
  
  if (closestPrice) {
    return Number(closestPrice.price);
  }
  
  const latestPrice = await prisma.priceHistory.findFirst({
    where: { assetIndex },
    orderBy: { timestamp: 'desc' },
  });
  
  if (latestPrice) {
    logger.warn(
      { assetIndex, requestedTime: timestamp, latestPriceTime: latestPrice.timestamp },
      'No price found within 2 minutes, using latest available price'
    );
    return Number(latestPrice.price);
  }
  
  logger.error({ assetIndex, timestamp }, 'No price data available for asset');
  return null;
}
