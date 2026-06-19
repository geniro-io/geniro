import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';
import IORedis from 'ioredis';

import { environment } from '../../../environments';

/**
 * Generic Redis cache service providing low-level Redis operations.
 * This service should be used as a foundation for domain-specific cache services.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private redis: IORedis;

  constructor(private readonly logger: DefaultLogger) {
    this.redis = new IORedis(environment.redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
      // `disableClientInfo: true` skips the telemetry CLIENT SETINFO
      // command on (re)connect. It is purely metadata for `CLIENT INFO`
      // debug output; skipping has zero functional impact and removes one
      // synchronous-write source that can throw EPIPE during teardown.
      // We deliberately KEEP `enableReadyCheck` at its default `true` so
      // commands wait for Redis to finish loading after restart/failover —
      // the cache has no BullMQ-style retry layer to compensate for
      // LOADING errors.
      disableClientInfo: true,
    });

    this.redis.on('error', (error) => {
      this.logger.error(error, 'Redis connection error');
    });
  }

  async onModuleDestroy() {
    try {
      if (this.redis.status === 'ready') {
        await this.redis.quit();
      }
    } catch {
      // Redis connection may already be closed during shutdown
    }
  }

  /**
   * Get a string value by key
   */
  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  /**
   * Set a string value with optional TTL
   * @param ttl Time to live in seconds (must be > 0)
   */
  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl != null && ttl > 0) {
      await this.redis.setex(key, ttl, value);
    } else {
      await this.redis.set(key, value);
    }
  }

  /**
   * Delete a key
   */
  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  /**
   * Atomically get a key's value AND delete it in a single round-trip (Redis
   * `GETDEL`, 6.2+). Use for single-use tokens where a separate get-then-del
   * would let two concurrent readers both observe the value before either
   * deletes it. Returns the prior value, or `null` if the key was absent.
   */
  async getDel(key: string): Promise<string | null> {
    return this.redis.getdel(key);
  }

  /**
   * Check if a key exists
   */
  async exists(key: string): Promise<boolean> {
    const result = await this.redis.exists(key);
    return result > 0;
  }

  /**
   * Set a hash field
   */
  async hset(key: string, field: string, value: string): Promise<void> {
    await this.redis.hset(key, field, value);
  }

  /**
   * Get a hash field
   */
  async hget(key: string, field: string): Promise<string | null> {
    return this.redis.hget(key, field);
  }

  /**
   * Get all hash fields
   */
  async hgetall(key: string): Promise<Record<string, string>> {
    return this.redis.hgetall(key);
  }

  /**
   * Delete a hash field
   */
  async hdel(key: string, field: string): Promise<void> {
    await this.redis.hdel(key, field);
  }

  /**
   * Set multiple hash fields at once
   */
  async hmset(key: string, data: Record<string, string>): Promise<void> {
    if (Object.keys(data).length === 0) {
      return;
    }
    await this.redis.hmset(key, data);
  }

  /**
   * Set expiration on a key
   * @param ttl Time to live in seconds
   */
  async expire(key: string, ttl: number): Promise<void> {
    await this.redis.expire(key, ttl);
  }

  /**
   * Get multiple hash objects in a single pipeline operation
   * @param keys Array of Redis keys to fetch
   * @returns Map of key to hash data
   */
  async hmgetall(keys: string[]): Promise<Map<string, Record<string, string>>> {
    if (keys.length === 0) {
      return new Map();
    }

    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      pipeline.hgetall(key);
    }

    const results = await pipeline.exec();
    const resultMap = new Map<string, Record<string, string>>();

    if (results) {
      for (let i = 0; i < keys.length; i++) {
        const result = results[i];
        if (!result) {
          continue;
        }

        const [error, data] = result;
        const key = keys[i];
        if (!error && data && key) {
          resultMap.set(key, data as Record<string, string>);
        }
      }
    }

    return resultMap;
  }
}
