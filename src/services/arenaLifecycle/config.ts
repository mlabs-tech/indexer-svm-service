/**
 * Arena Lifecycle Configuration
 */

export const lifecycleConfig = {
  // Retry configuration
  maxRetryAttempts: 5,
  retryBackoffBaseMs: 1000,  // 1s, 2s, 4s, 8s, 16s
  
  // Timing
  priceSetDelayMs: 500,       // Delay between setting prices for each asset
  endCheckIntervalMs: 5000,   // How often to check for arenas needing to end
  startCheckIntervalMs: 10000, // How often to check for arenas needing to start (10 seconds)
  
  // Waiting room countdown (10 minutes from first player join)
  waitingCountdownMs: 10 * 60 * 1000,  // 10 minutes in milliseconds
  
  // Bot filler configuration
  botFiller: {
    enabled: true,
    inactivityTimeoutMs: 60 * 1000,     // 1 minute - add bot if no new player joins
    checkIntervalMs: 10 * 1000,          // Check every 10 seconds
    maxPlayersPerArena: 10,              // Max players before arena is full
    airdropAmountLamports: 100_000_000,  // 0.1 SOL airdrop when bot has insufficient balance
    minBalanceLamports: 60_000_000,      // Minimum balance needed (0.06 SOL = entry fee + tx fees)
  },
  
  // Job queue names
  queues: {
    startArena: 'arena-start',
    endArena: 'arena-end',
  },
  
  // Job options
  jobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential' as const,
      delay: 1000,
    },
    removeOnComplete: 100,  // Keep last 100 completed jobs
    removeOnFail: 500,      // Keep last 500 failed jobs for debugging
  },
};

export default lifecycleConfig;

