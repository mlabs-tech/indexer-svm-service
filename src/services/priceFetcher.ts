import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';

const prisma = new PrismaClient();

// CoinMarketCap API configuration
const CMC_API_KEY = process.env.CMC_API_KEY || '';
const CMC_API_URL = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest';

// Token symbols mapped to CoinMarketCap IDs
// IMPORTANT: These must be the correct Solana tokens!
const TOKEN_CMC_IDS: Record<number, { symbol: string; cmcId: number }> = {
  0: { symbol: 'SOL', cmcId: 5426 },       // Solana
  1: { symbol: 'TRUMP', cmcId: 35336 },    // Official Trump
  2: { symbol: 'PUMP', cmcId: 36507 },     // Pump.fun
  3: { symbol: 'BONK', cmcId: 23095 },     // Bonk
  4: { symbol: 'JUP', cmcId: 29210 },      // Jupiter
  5: { symbol: 'PENGU', cmcId: 34466 },    // Pudgy Penguins - FIXED: was 33498
  6: { symbol: 'PYTH', cmcId: 28177 },     // Pyth Network
  7: { symbol: 'HNT', cmcId: 5665 },       // Helium
  8: { symbol: 'FARTCOIN', cmcId: 33597 }, // Fartcoin
  9: { symbol: 'RAY', cmcId: 8526 },       // Raydium
  10: { symbol: 'JTO', cmcId: 28541 },     // Jito
  11: { symbol: 'KMNO', cmcId: 30986 },    // Kamino Finance - FIXED: was 29835
  12: { symbol: 'MET', cmcId: 38353 },     // Meteora
  13: { symbol: 'W', cmcId: 29587 },       // Wormhole
};

let fetchInterval: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Fetch current prices for all tokens from CoinMarketCap
 */
async function fetchPrices(): Promise<void> {
  if (!CMC_API_KEY) {
    logger.warn('CMC_API_KEY not set, using mock prices');
    await storeMockPrices();
    return;
  }

  try {
    const cmcIds = Object.values(TOKEN_CMC_IDS).map(t => t.cmcId).join(',');
    
    const response = await fetch(`${CMC_API_URL}?id=${cmcIds}`, {
      headers: {
        'X-CMC_PRO_API_KEY': CMC_API_KEY,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`CMC API error: ${response.status}`);
    }

    const data = await response.json() as { data: Record<string, { quote: { USD: { price: number } } }> };
    const timestamp = new Date();

    // Store prices for each token
    const priceRecords = [];
    for (const [indexStr, tokenInfo] of Object.entries(TOKEN_CMC_IDS)) {
      const assetIndex = parseInt(indexStr);
      const cmcData = data.data?.[tokenInfo.cmcId.toString()];
      
      if (cmcData?.quote?.USD?.price) {
        priceRecords.push({
          assetIndex,
          price: cmcData.quote.USD.price,
          timestamp,
          source: 'coinmarketcap',
        });
      }
    }

    if (priceRecords.length > 0) {
      await prisma.priceHistory.createMany({
        data: priceRecords,
      });
      logger.debug({ count: priceRecords.length }, 'Stored price history records');
    }

  } catch (error) {
    logger.error({ error }, 'Failed to fetch prices from CoinMarketCap');
    // Fallback to mock prices on error
    await storeMockPrices();
  }
}

/**
 * Store mock prices (for development/testing without API key)
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
 * Start the price fetcher cron job (runs every 30 seconds)
 */
export function startPriceFetcher(): void {
  if (isRunning) {
    logger.warn('Price fetcher is already running');
    return;
  }

  isRunning = true;
  logger.info('Starting price fetcher service (30s interval)');

  // Fetch immediately on start
  fetchPrices();

  // Then fetch every 30 seconds
  fetchInterval = setInterval(fetchPrices, 30 * 1000);
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

  // Get all price records in the timeframe
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

  // Group by asset
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

  // Apply interval aggregation if needed
  const intervalMs = getIntervalMs(interval);
  
  const result = assetIndices.map(assetIndex => {
    const prices = groupedByAsset.get(assetIndex) || [];
    
    if (intervalMs > 30000 && prices.length > 0) {
      // Aggregate prices by interval
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
      // Save previous bucket
      if (bucketPrices.length > 0) {
        aggregated.push({
          timestamp: new Date(currentBucket),
          price: bucketPrices[bucketPrices.length - 1], // Use last price in bucket
        });
      }
      currentBucket = pBucket;
      bucketPrices = [];
    }
    
    bucketPrices.push(p.price);
  }

  // Don't forget last bucket
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
  // Get the most recent price for each asset
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

