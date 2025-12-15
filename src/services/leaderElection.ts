import Redis from 'ioredis';
import config from '../config';
import logger from '../utils/logger';

/**
 * Redis-based Leader Election
 * 
 * Uses Redis SET with NX (only if not exists) and EX (expiry) for distributed locking.
 * This is more reliable than PostgreSQL advisory locks with Prisma's connection pooling.
 * 
 * How it works:
 * 1. Try to SET the lock key with our instance ID (only succeeds if key doesn't exist)
 * 2. If we acquire it, refresh the TTL every 10 seconds (heartbeat)
 * 3. If we lose connection or crash, the lock expires after 30 seconds
 * 4. On graceful shutdown, we delete the lock immediately
 * 
 * During deployments:
 * - New task starts, tries to acquire lock, fails (old task holds it)
 * - New task runs as FOLLOWER (API only)
 * - Old task receives SIGTERM, releases lock, shuts down
 * - New task's next heartbeat acquires the lock, becomes LEADER
 */

const LEADER_LOCK_KEY = 'cryptarena:indexer:leader';
const LOCK_TTL_SECONDS = 30; // Lock expires after 30 seconds if not renewed
const HEARTBEAT_INTERVAL_MS = 10000; // Renew lock every 10 seconds

export interface LeaderElectionState {
  isLeader: boolean;
  instanceId: string;
  lockHolder?: string;
}

let redis: Redis | null = null;
let isLeader = false;
let heartbeatInterval: NodeJS.Timeout | null = null;
let isShuttingDown = false;
const instanceId = `instance-${Date.now()}-${Math.random().toString(36).substring(7)}`;

// Callback for when this instance becomes the leader (used for follower promotion)
let onBecomeLeaderCallback: (() => Promise<void>) | null = null;

/**
 * Register a callback to be called when this instance becomes the leader.
 * Used for follower promotion - the callback should start leader tasks.
 */
export function onBecomeLeader(callback: () => Promise<void>): void {
  onBecomeLeaderCallback = callback;
}

/**
 * Initialize Redis connection for leader election
 */
async function initRedis(): Promise<void> {
  if (redis) return;
  
  redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy: (times) => {
      if (times > 10) return null; // Stop retrying after 10 attempts
      return Math.min(times * 100, 3000);
    },
  });

  redis.on('error', (err) => {
    logger.error({ error: err, instanceId }, 'Leader election Redis error');
  });

  await redis.connect();
}

/**
 * Try to acquire the leader lock using Redis SET NX EX
 * 
 * SET key value EX seconds NX:
 * - EX seconds: Set expiry time in seconds
 * - NX: Only set if key does not exist (atomic check-and-set)
 */
export async function tryAcquireLeaderLock(): Promise<boolean> {
  try {
    await initRedis();
    
    if (!redis) {
      logger.error({ instanceId }, 'Redis not initialized for leader election');
      return false;
    }

    // Try to acquire lock atomically
    // Returns 'OK' if we got the lock, null if someone else has it
    const result = await redis.set(
      LEADER_LOCK_KEY,
      instanceId,
      'EX', LOCK_TTL_SECONDS,
      'NX'
    );

    if (result === 'OK') {
      isLeader = true;
      logger.info({ instanceId }, '🏆 Acquired leader lock - this instance is now the LEADER');
      startHeartbeat();
      return true;
    } else {
      // Someone else holds the lock - check who
      const currentHolder = await redis.get(LEADER_LOCK_KEY);
      isLeader = false;
      logger.info({ instanceId, currentHolder }, '👥 Could not acquire leader lock - this instance is a FOLLOWER');
      
      // Start a background check to try acquiring lock if it becomes available
      startFollowerCheck();
      return false;
    }
  } catch (error) {
    logger.error({ error, instanceId }, 'Failed to acquire leader lock');
    isLeader = false;
    return false;
  }
}

/**
 * Release the leader lock on graceful shutdown
 */
export async function releaseLeaderLock(): Promise<void> {
  isShuttingDown = true;
  stopHeartbeat();
  
  if (!isLeader || !redis) {
    return;
  }

  try {
    // Only delete if we still own the lock (use Lua script for atomicity)
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await redis.eval(script, 1, LEADER_LOCK_KEY, instanceId);
    isLeader = false;
    logger.info({ instanceId }, '🔓 Released leader lock');
  } catch (error) {
    logger.error({ error, instanceId }, 'Failed to release leader lock');
  }
}

/**
 * Heartbeat: Refresh the lock TTL while we're the leader
 */
function startHeartbeat(): void {
  if (heartbeatInterval) return;

  heartbeatInterval = setInterval(async () => {
    if (isShuttingDown || !redis) return;

    try {
      // Only refresh if we still own the lock
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("expire", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;
      const result = await redis.eval(script, 1, LEADER_LOCK_KEY, instanceId, LOCK_TTL_SECONDS);
      
      if (result === 0) {
        // We lost the lock! Another instance took over
        logger.warn({ instanceId }, '⚠️ Lost leader lock - another instance may have taken over');
        isLeader = false;
        stopHeartbeat();
        // Don't exit - just become a follower
        // The main process can check isLeader and adjust behavior
      } else {
        logger.debug({ instanceId }, 'Leader heartbeat OK - lock refreshed');
      }
    } catch (error) {
      logger.error({ error, instanceId }, 'Leader heartbeat failed');
      // Don't crash - just log the error
      // If Redis is truly down, the lock will expire and another instance can take over
    }
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Follower check: Periodically try to become leader if the lock becomes available
 */
let followerCheckInterval: NodeJS.Timeout | null = null;

function startFollowerCheck(): void {
  if (followerCheckInterval || isLeader) return;

  followerCheckInterval = setInterval(async () => {
    if (isShuttingDown || isLeader || !redis) {
      stopFollowerCheck();
      return;
    }

    try {
      // Try to acquire the lock
      const result = await redis.set(
        LEADER_LOCK_KEY,
        instanceId,
        'EX', LOCK_TTL_SECONDS,
        'NX'
      );

      if (result === 'OK') {
        isLeader = true;
        logger.info({ instanceId }, '🏆 Follower promoted to LEADER - lock acquired');
        stopFollowerCheck();
        startHeartbeat();
        
        // Call the callback to start leader tasks
        if (onBecomeLeaderCallback) {
          logger.info({ instanceId }, 'Starting leader tasks after promotion...');
          onBecomeLeaderCallback().catch((error) => {
            logger.error({ error, instanceId }, 'Failed to start leader tasks after promotion');
          });
        }
      }
    } catch (error) {
      logger.debug({ error, instanceId }, 'Follower lock check failed');
    }
  }, HEARTBEAT_INTERVAL_MS * 2); // Check less frequently than heartbeat
}

function stopFollowerCheck(): void {
  if (followerCheckInterval) {
    clearInterval(followerCheckInterval);
    followerCheckInterval = null;
  }
}

function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/**
 * Get current leader status
 */
export function getLeaderStatus(): LeaderElectionState {
  return {
    isLeader,
    instanceId,
  };
}

/**
 * Check if this instance is the leader
 */
export function isInstanceLeader(): boolean {
  return isLeader;
}

/**
 * Cleanup Redis connection
 */
export async function cleanupLeaderElection(): Promise<void> {
  await releaseLeaderLock();
  stopFollowerCheck();
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

export { instanceId };
