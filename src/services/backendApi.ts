/**
 * Backend API Service
 * Handles communication with the cryptarena-be backend service
 */

import logger from '../utils/logger';

const BACKEND_API_URL = process.env.BACKEND_API_URL || 'http://localhost:8080';
const BACKEND_API_KEY = process.env.BACKEND_API_KEY || '';

// ============================================================================
// Mastery Points Types
// ============================================================================

interface PlayerResult {
  walletAddress: string;
  assetIndex: number;
  placement: number;
  isWinner: boolean;
  tokenAmount: number;
  usdValue: number;
}

interface ArenaResultRequest {
  arenaId: number;
  results: PlayerResult[];
}

/**
 * Submit arena results to the backend for mastery point allocation
 */
export async function submitArenaResults(arenaId: bigint, playerEntries: {
  playerWallet: string;
  assetIndex: number;
  tokenAmount: number;
  usdValue: number;
  volatility: number; // Price movement in basis points
}[], winningAsset: number): Promise<boolean> {
  try {
    // Calculate placements based on winning asset and volatility
    // Winners share 1st place, losers are ranked 2nd through 10th by volatility (descending)
    const winners = playerEntries.filter(e => e.assetIndex === winningAsset);
    const losers = playerEntries.filter(e => e.assetIndex !== winningAsset);

    // Sort losers by volatility (highest volatility = better placement)
    const sortedLosers = [...losers].sort((a, b) => b.volatility - a.volatility);

    const results: PlayerResult[] = [];

    // All winners get 1st place (they share the top spot)
    for (const winner of winners) {
      results.push({
        walletAddress: winner.playerWallet,
        assetIndex: winner.assetIndex,
        placement: 1,
        isWinner: true,
        tokenAmount: winner.tokenAmount,
        usdValue: winner.usdValue,
      });
    }

    // Losers get placements 2-10, sorted by volatility (highest first)
    let loserPlacement = 2;
    for (const loser of sortedLosers) {
      results.push({
        walletAddress: loser.playerWallet,
        assetIndex: loser.assetIndex,
        placement: loserPlacement,
        isWinner: false,
        tokenAmount: loser.tokenAmount,
        usdValue: loser.usdValue,
      });
      loserPlacement++;
    }

    logger.debug(
      { 
        arenaId: arenaId.toString(), 
        placements: results.map(r => ({ wallet: r.walletAddress.slice(0, 8), placement: r.placement, isWinner: r.isWinner }))
      },
      'Calculated placements for arena'
    );

    const request: ArenaResultRequest = {
      arenaId: Number(arenaId),
      results,
    };

    logger.info(
      { arenaId: arenaId.toString(), playerCount: results.length, winnerCount: winners.length },
      'Submitting arena results to backend'
    );

    const response = await fetch(`${BACKEND_API_URL}/api/mastery/internal/arena-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Indexer-Api-Key': BACKEND_API_KEY,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        { arenaId: arenaId.toString(), status: response.status, error: errorText },
        'Backend API returned error'
      );
      return false;
    }

    const result = await response.json();
    logger.info(
      { arenaId: arenaId.toString(), result },
      'Arena results submitted successfully to backend'
    );

    return true;
  } catch (error) {
    logger.error(
      { arenaId: arenaId.toString(), error: error instanceof Error ? error.message : String(error) },
      'Failed to submit arena results to backend'
    );
    return false;
  }
}

