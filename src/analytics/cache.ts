/**
 * In-memory TTL cache for analytics computation results.
 *
 * Caches any serialisable value under a string key for a configurable
 * duration (default 5 minutes). Entries are evicted lazily on read.
 * Use `invalidateWorkspace` to eagerly purge all keys that belong to a
 * particular workspace when fresh data becomes available.
 *
 * @example
 * ```ts
 * import { analyticsCache } from './cache.ts';
 *
 * const key = `perf:${workspaceId}:${range}`;
 * let metrics = analyticsCache.get<PerformanceMetrics>(key);
 * if (metrics === null) {
 *   metrics = await computePerformanceMetrics(db, workspaceId, range);
 *   analyticsCache.set(key, metrics);
 * }
 * ```
 */

/** Internal cache entry — pairs a value with its expiry wall-clock time. */
type AnalyticsCacheEntry<T> = {
  readonly data: T;
  readonly expiresAt: number;
};

/** Default TTL: 5 minutes in milliseconds. */
const DEFAULT_TTL_MS = 5 * 60 * 1_000;

export class AnalyticsCache {
  private readonly cache = new Map<string, AnalyticsCacheEntry<unknown>>();
  private readonly ttlMs: number;

  /**
   * @param ttlMs - Time-to-live in milliseconds. Defaults to 300,000 (5 min).
   *                Pass `config.cacheTtl * 1000` to use {@link AnalyticsConfig}.
   */
  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Retrieve a cached value by key.
   *
   * Returns `null` when the key is absent or the entry has expired.
   * Expired entries are deleted from the map on access.
   *
   * @param key - Cache key
   * @returns Cached value, or `null` on miss / expiry
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (entry === undefined) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  /**
   * Store a value under the given key with the configured TTL.
   *
   * Overwrites any existing entry for the same key.
   *
   * @param key  - Cache key
   * @param data - Value to cache
   */
  set<T>(key: string, data: T): void {
    this.cache.set(key, { data, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * Delete all cached entries whose key contains `workspaceId`.
   *
   * Call this when a job completes so the next request re-computes fresh
   * analytics for that workspace rather than returning stale data.
   *
   * @param workspaceId - Workspace identifier substring to match against keys
   */
  invalidateWorkspace(workspaceId: string): void {
    for (const key of this.cache.keys()) {
      if (key.includes(workspaceId)) {
        this.cache.delete(key);
      }
    }
  }
}

/**
 * Module-level singleton that uses the default 5-minute TTL.
 *
 * To honour `AnalyticsConfig.cacheTtl`, construct a dedicated instance:
 * ```ts
 * const cache = new AnalyticsCache(config.cacheTtl * 1000);
 * ```
 */
export const analyticsCache = new AnalyticsCache();
