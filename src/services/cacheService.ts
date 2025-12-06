import Redis from 'ioredis';
import config from '../config';

class CacheService {
  private redis: Redis;

  constructor() {
    this.redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    this.redis.on('error', (err) => {
      console.error('Redis Cache Error:', err);
    });

    this.redis.on('connect', () => {
      console.log('✓ Redis cache connected');
    });
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  /**
   * Get cached value
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.redis.get(key);
      if (!value) return null;
      return JSON.parse(value) as T;
    } catch (error) {
      console.error(`Cache get error for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Set cache with TTL (in seconds)
   */
  async set(key: string, value: any, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.setex(key, ttlSeconds, JSON.stringify(value));
    } catch (error) {
      console.error(`Cache set error for key ${key}:`, error);
    }
  }

  /**
   * Delete cache key
   */
  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (error) {
      console.error(`Cache delete error for key ${key}:`, error);
    }
  }

  /**
   * Delete all keys matching a pattern
   */
  async deletePattern(pattern: string): Promise<void> {
    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (error) {
      console.error(`Cache delete pattern error for ${pattern}:`, error);
    }
  }

  /**
   * Check if key exists
   */
  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.redis.exists(key);
      return result === 1;
    } catch (error) {
      console.error(`Cache exists error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Get remaining TTL for a key (in seconds)
   */
  async ttl(key: string): Promise<number> {
    try {
      return await this.redis.ttl(key);
    } catch (error) {
      console.error(`Cache TTL error for key ${key}:`, error);
      return -1;
    }
  }

  /**
   * Invalidate arena-related caches
   */
  async invalidateArena(arenaId: string): Promise<void> {
    await Promise.all([
      this.delete(`arena:${arenaId}`),
      this.delete(`arena:${arenaId}:players`),
      this.delete(`arena:${arenaId}:assets`),
      this.deletePattern('arenas:list:*'),
      this.deletePattern('arenas:active'),
      this.deletePattern('arenas:current'),
    ]);
  }

  /**
   * Disconnect Redis
   */
  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}

// Singleton instance
export const cacheService = new CacheService();
export default cacheService;

