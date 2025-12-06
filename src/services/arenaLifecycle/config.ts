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
  startCheckIntervalMs: 2000, // How often to check for arenas needing to start
  
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

