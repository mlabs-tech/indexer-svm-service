/**
 * Arena Lifecycle Configuration
 */

// Ensure dotenv is loaded (in case this module is imported before main config)
import dotenv from 'dotenv';
dotenv.config();

// Waiting room countdown - configurable via environment variable
// Default: 10 minutes (600000ms) for production
// Local dev: 3 minutes (180000ms) via .env file
const WAITING_ROOM_COUNTDOWN_MS = process.env.WAITING_ROOM_COUNTDOWN_MS
  ? parseInt(process.env.WAITING_ROOM_COUNTDOWN_MS, 10)
  : 10 * 60 * 1000; // Default: 10 minutes in milliseconds

// Bot filler inactivity timeout - configurable via environment variable
// Default: 1 minute (60000ms) for production
// Local dev: 30 seconds (30000ms) via .env file
const BOT_FILLER_INACTIVITY_TIMEOUT_MS = process.env.BOT_FILLER_INACTIVITY_TIMEOUT_MS
  ? parseInt(process.env.BOT_FILLER_INACTIVITY_TIMEOUT_MS, 10)
  : 60 * 1000; // Default: 1 minute in milliseconds

export const lifecycleConfig = {
  // Retry configuration
  maxRetryAttempts: 5,
  retryBackoffBaseMs: 1000,  // 1s, 2s, 4s, 8s, 16s
  
  // Timing
  priceSetDelayMs: 500,       // Delay between setting prices for each asset
  endCheckIntervalMs: 5000,   // How often to check for arenas needing to end
  startCheckIntervalMs: 5000, // How often to check for arenas needing to start (5 seconds - reduced for faster response)
  
  // Waiting room countdown (configurable via WAITING_ROOM_COUNTDOWN_MS env var)
  waitingCountdownMs: WAITING_ROOM_COUNTDOWN_MS,
  
  // Bot filler configuration
  botFiller: {
    enabled: true,
    inactivityTimeoutMs: BOT_FILLER_INACTIVITY_TIMEOUT_MS, // Configurable via BOT_FILLER_INACTIVITY_TIMEOUT_MS env var
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

