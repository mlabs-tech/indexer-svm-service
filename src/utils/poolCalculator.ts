import prisma from '../db';
import { getLatestPrices } from '../services/priceFetcher';
import logger from './logger';

/**
 * Calculate the real-time total pool value for an arena
 * Uses latest market prices from price_history table
 */
export async function calculateRealTimePoolValue(arenaId: bigint): Promise<number> {
  try {
    // Get all player entries for this arena
    const playerEntries = await prisma.playerEntry.findMany({
      where: { arenaId },
      select: {
        assetIndex: true,
        tokenAmount: true,
      },
    });

    if (playerEntries.length === 0) {
      return 0;
    }

    // Get latest prices for all assets in this arena
    const latestPrices = await getLatestPrices();
    const priceMap = new Map<number, number>();
    latestPrices.forEach(p => {
      priceMap.set(p.assetIndex, p.price);
    });

    // Calculate total pool value
    let totalPoolValue = 0;
    
    for (const entry of playerEntries) {
      const tokenAmount = Number(entry.tokenAmount);
      const latestPrice = priceMap.get(entry.assetIndex);
      
      if (latestPrice && latestPrice > 0) {
        totalPoolValue += tokenAmount * latestPrice;
      } else {
        // Fallback: if no price available, log warning but continue
        logger.warn(
          { arenaId: arenaId.toString(), assetIndex: entry.assetIndex },
          'No latest price found for asset in pool calculation'
        );
      }
    }

    return totalPoolValue;
  } catch (error) {
    logger.error({ error, arenaId: arenaId.toString() }, 'Failed to calculate real-time pool value');
    // Return 0 on error rather than throwing
    return 0;
  }
}

/**
 * Calculate real-time pool value for multiple arenas in batch
 * More efficient when calculating for many arenas at once
 */
export async function calculateRealTimePoolValueBatch(arenaIds: bigint[]): Promise<Map<string, number>> {
  try {
    if (arenaIds.length === 0) {
      return new Map();
    }

    // Get all player entries for these arenas
    const playerEntries = await prisma.playerEntry.findMany({
      where: { 
        arenaId: { in: arenaIds }
      },
      select: {
        arenaId: true,
        assetIndex: true,
        tokenAmount: true,
      },
    });

    // Get latest prices once
    const latestPrices = await getLatestPrices();
    const priceMap = new Map<number, number>();
    latestPrices.forEach(p => {
      priceMap.set(p.assetIndex, p.price);
    });

    // Group entries by arena and calculate totals
    const poolValues = new Map<string, number>();
    
    for (const arenaId of arenaIds) {
      const arenaEntries = playerEntries.filter(e => e.arenaId === arenaId);
      let totalPoolValue = 0;
      
      for (const entry of arenaEntries) {
        const tokenAmount = Number(entry.tokenAmount);
        const latestPrice = priceMap.get(entry.assetIndex);
        
        if (latestPrice && latestPrice > 0) {
          totalPoolValue += tokenAmount * latestPrice;
        }
      }
      
      poolValues.set(arenaId.toString(), totalPoolValue);
    }

    return poolValues;
  } catch (error) {
    logger.error({ error }, 'Failed to calculate real-time pool values in batch');
    return new Map();
  }
}

