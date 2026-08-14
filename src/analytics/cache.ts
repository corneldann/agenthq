/**
 * In-memory TTL cache for analytics computation results.
 *
 * Caches any serialisable value under a string key for a configurable
 * duration (default 5 minutes). Entries are evicted lazily on read.
 * Use `invalidateWorkspace` to eagerly purge all keys that belong to a
 * particular workspace when fresh data becomes available.
 *
 * When constructed with `cacheLoggingEnabled: true` and a log level ≥ INFO,
 * the cache emits periodic hit/miss rate summaries every 5 minutes.
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

import type { LogLevel } from '../config/analytics-config.ts';

/** Internal cache entry — pairs a value with its expiry wall-clock time. */
type AnalyticsCacheEntry<T> = {
  readonly data: T;
  readonly expiresAt: number;
};

/** Per-prefix hit/miss counters. */
type PrefixCounters = {
  hits: number;
  misses: number;
};

/** Default TTL: 5 minutes in milliseconds. */
const DEFAULT_TTL_MS = 5 * 60 * 1_000;

/** Logging interval: 5 minutes in milliseconds. */
const LOG_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * Log levels that are considered ≥ INFO (i.e., INFO, WARN, ERROR, FATAL).
 * Cache logging only fires when the configured level is in this set.
 */
const LEVELS_AT_OR_ABOVE_INFO: ReadonlySet<LogLevel> = new Set<LogLevel>([
  'INFO', 'WARN', 'ERROR', 'FATAL',
]);

/** Options for enabling cache observability logging. */
type CacheLoggingOptions = {
  /** Whether hit/miss rates should be logged periodically. */
  readonly cacheLoggingEnabled: boolean;
  /** Only emit logs when this level is INFO or above. */
  readonly logLevel: LogLevel;
};

/**
 * Extract the prefix from a cache key: everything before the first colon.
 * For a key without any colon the entire key is used as the prefix.
 *
 * @example
 * keyPrefix('perf:ws-abc:24h') // → 'perf'
 * keyPrefix('standalone')       // → 'standalone'
 */
function keyPrefix(key: string): string {
  const idx = key.indexOf(':');
  return idx === -1 ? key : key.slice(0, idx);
}

export class AnalyticsCache {
  private readonly cache = new Map<string, AnalyticsCacheEntry<unknown>>();
  private readonly ttlMs: number;
  private readonly prefixCounters = new Map<string, PrefixCounters>();
  private loggingTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param ttlMs          - Time-to-live in milliseconds. Defaults to 300,000 (5 min).
   *                         Pass `config.cacheTtl * 1000` to use {@link AnalyticsConfig}.
   * @param loggingOptions - Optional observability options. When `cacheLoggingEnabled`
   *                         is true AND `logLevel` is INFO or higher, a 5-minute interval
   *                         is started to emit hit/miss rate summaries.
   */
  constructor(
    ttlMs: number = DEFAULT_TTL_MS,
    loggingOptions?: CacheLoggingOptions,
  ) {
    this.ttlMs = ttlMs;

    if (
      loggingOptions?.cacheLoggingEnabled === true &&
      LEVELS_AT_OR_ABOVE_INFO.has(loggingOptions.logLevel)
    ) {
      this.loggingTimer = setInterval(() => {
        this.emitHitMissLog();
      }, LOG_INTERVAL_MS);
    }
  }

  /**
   * Retrieve a cached value by key.
   *
   * Returns `null` when the key is absent or the entry has expired.
   * Expired entries are deleted from the map on access.
   * Hit/miss counters are updated per key prefix.
   *
   * @param key - Cache key
   * @returns Cached value, or `null` on miss / expiry
   */
  get<T>(key: string): T | null {
    const prefix = keyPrefix(key);
    const entry = this.cache.get(key);

    if (entry === undefined) {
      this.incrementMiss(prefix);
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.incrementMiss(prefix);
      return null;
    }

    this.incrementHit(prefix);
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
   * Hit/miss counters for prefixes whose keys were invalidated are also reset.
   *
   * @param workspaceId - Workspace identifier substring to match against keys
   */
  invalidateWorkspace(workspaceId: string): void {
    const invalidatedPrefixes = new Set<string>();

    for (const key of this.cache.keys()) {
      if (key.includes(workspaceId)) {
        invalidatedPrefixes.add(keyPrefix(key));
        this.cache.delete(key);
      }
    }

    for (const prefix of invalidatedPrefixes) {
      this.prefixCounters.delete(prefix);
    }
  }

  /**
   * Return a snapshot of hit/miss counters keyed by prefix.
   *
   * Useful for testing or external observability integrations.
   */
  getCounters(): ReadonlyMap<string, Readonly<PrefixCounters>> {
    return this.prefixCounters;
  }

  /**
   * Stop the periodic logging timer, if one was started.
   *
   * Call this during graceful shutdown to prevent the interval from
   * keeping the process alive.
   */
  stopLogging(): void {
    if (this.loggingTimer !== null) {
      clearInterval(this.loggingTimer);
      this.loggingTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private incrementHit(prefix: string): void {
    const counters = this.prefixCounters.get(prefix);
    if (counters === undefined) {
      this.prefixCounters.set(prefix, { hits: 1, misses: 0 });
    } else {
      counters.hits += 1;
    }
  }

  private incrementMiss(prefix: string): void {
    const counters = this.prefixCounters.get(prefix);
    if (counters === undefined) {
      this.prefixCounters.set(prefix, { hits: 0, misses: 1 });
    } else {
      counters.misses += 1;
    }
  }

  private emitHitMissLog(): void {
    if (this.prefixCounters.size === 0) {
      return;
    }

    const parts: string[] = [];

    for (const [prefix, { hits, misses }] of this.prefixCounters) {
      const total = hits + misses;
      if (total === 0) {
        parts.push(`${prefix}: 0 requests`);
      } else {
        const rate = (hits / total) * 100;
        parts.push(`${prefix}: ${hits} hits / ${misses} misses (${rate.toFixed(1)}%)`);
      }
    }

    console.info(`[AnalyticsCache] hit/miss rates — ${parts.join(', ')}`);
  }
}

/**
 * Module-level singleton that uses the default 5-minute TTL without logging.
 *
 * To honour `AnalyticsConfig.cacheTtl` and enable logging, construct a
 * dedicated instance at startup and pass it where needed:
 * ```ts
 * const cache = new AnalyticsCache(
 *   config.cacheTtl * 1000,
 *   { cacheLoggingEnabled: config.cacheLoggingEnabled, logLevel: config.logLevel }
 * );
 * ```
 */
export const analyticsCache = new AnalyticsCache();
