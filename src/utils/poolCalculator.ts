import prisma from '../db';
import { getLatestPrices } from '../services/priceFetcher';
import logger from './logger';

// SOL asset index
const SOL_ASSET_INDEX = 0;

export interface PoolValue {
  totalPoolSol: number;
  totalPoolUsd: number;
}

/**
 * Calculate the real-time total pool value for an arena
 * In cryptarena-sol, users pay SOL entry fees, so pool = total SOL × SOL price
 */
export async function calculateRealTimePoolValue(arenaId: bigint): Promise<PoolValue> {
  try {
    // Get all player entries for this arena
    const playerEntries = await prisma.playerEntry.findMany({
      where: { arenaId },
      select: {
        usdValue: true, // This is actually the entry fee in SOL (stored in usdValue for compatibility)
      },
    });

    if (playerEntries.length === 0) {
      return { totalPoolSol: 0, totalPoolUsd: 0 };
    }

    // Calculate total SOL entry fees
    const totalSolEntries = playerEntries.reduce((sum, entry) => {
      return sum + Number(entry.usdValue);
    }, 0);

    // Get latest SOL price
    const latestPrices = await getLatestPrices();
    const solPrice = latestPrices.find(p => p.assetIndex === SOL_ASSET_INDEX)?.price || 0;

    if (solPrice === 0) {
      logger.warn({ arenaId: arenaId.toString() }, 'No SOL price found for pool calculation');
      return { totalPoolSol: totalSolEntries, totalPoolUsd: 0 };
    }

    // Total pool in USD = total SOL entries × SOL price
    return { 
      totalPoolSol: totalSolEntries, 
      totalPoolUsd: totalSolEntries * solPrice 
    };
  } catch (error) {
    logger.error({ error, arenaId: arenaId.toString() }, 'Failed to calculate real-time pool value');
    return { totalPoolSol: 0, totalPoolUsd: 0 };
  }
}

/**
 * Calculate real-time pool value for multiple arenas in batch
 * More efficient when calculating for many arenas at once
 */
export async function calculateRealTimePoolValueBatch(arenaIds: bigint[]): Promise<Map<string, PoolValue>> {
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
        usdValue: true, // Entry fee in SOL
      },
    });

    // Get latest SOL price
    const latestPrices = await getLatestPrices();
    const solPrice = latestPrices.find(p => p.assetIndex === SOL_ASSET_INDEX)?.price || 0;

    // Group entries by arena and calculate totals
    const poolValues = new Map<string, PoolValue>();
    
    for (const arenaId of arenaIds) {
      const arenaEntries = playerEntries.filter(e => e.arenaId === arenaId);
      
      // Sum all SOL entry fees
      const totalSolEntries = arenaEntries.reduce((sum, entry) => {
        return sum + Number(entry.usdValue);
      }, 0);
      
      poolValues.set(arenaId.toString(), {
        totalPoolSol: totalSolEntries,
        totalPoolUsd: solPrice > 0 ? totalSolEntries * solPrice : 0,
      });
    }

    return poolValues;
  } catch (error) {
    logger.error({ error }, 'Failed to calculate real-time pool values in batch');
    return new Map();
  }
}
