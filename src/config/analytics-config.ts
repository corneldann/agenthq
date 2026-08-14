/**
 * Analytics configuration loader.
 *
 * Reads ANALYTICS_ENABLED, ANALYTICS_CACHE_TTL, ANALYTICS_CACHE_LOG_ENABLED,
 * and ANALYTICS_LOG_LEVEL from the environment, validates them, clamps numeric
 * values to valid ranges, and logs warnings or errors for invalid/out-of-range
 * values without throwing.
 */

/** Recognised log level values, ordered from least to most severe. */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

const LOG_LEVELS: readonly LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

export type AnalyticsConfig = {
  /** Whether the analytics layer is active. Default: true */
  enabled: boolean;
  /** Result cache TTL in seconds. Range: [1, 86400]. Default: 300 */
  cacheTtl: number;
  /**
   * Whether the cache should emit hit/miss rate logs periodically.
   * Env: ANALYTICS_CACHE_LOG_ENABLED. Default: false.
   */
  cacheLoggingEnabled: boolean;
  /**
   * Minimum log level for cache observability output.
   * Env: ANALYTICS_LOG_LEVEL. Default: 'INFO'.
   * Logging fires only when this level is INFO or above (≥ INFO).
   */
  logLevel: LogLevel;
};

const CACHE_TTL_MIN = 1;
const CACHE_TTL_MAX = 86400;
const CACHE_TTL_DEFAULT = 300;

/**
 * Parse and validate analytics configuration from environment variables.
 *
 * Invalid or out-of-range values are logged and corrected (clamped / defaulted)
 * rather than causing a throw, so the application can continue to start up.
 *
 * @param env - An object of environment variable key/value pairs
 *              (pass `process.env` in production, a plain object in tests).
 * @returns Validated {@link AnalyticsConfig}
 */
export function loadAnalyticsConfig(env: Record<string, string | undefined>): AnalyticsConfig {
  // --- ANALYTICS_ENABLED ---
  const rawEnabled = env['ANALYTICS_ENABLED'];
  const enabledNorm = rawEnabled?.toLowerCase();

  if (enabledNorm !== undefined && enabledNorm !== '' && enabledNorm !== 'true' && enabledNorm !== 'false') {
    console.error(`Configuration error: ANALYTICS_ENABLED: must be 'true' or 'false', got '${rawEnabled}'`);
  }

  const enabled = enabledNorm !== 'false';

  // --- ANALYTICS_CACHE_TTL ---
  const rawCacheTtl = env['ANALYTICS_CACHE_TTL'];
  let cacheTtl: number;

  if (rawCacheTtl === undefined || rawCacheTtl === '') {
    cacheTtl = CACHE_TTL_DEFAULT;
  } else {
    const parsed = parseInt(rawCacheTtl, 10);

    if (isNaN(parsed) || rawCacheTtl.trim() === '') {
      console.error(`Configuration error: ANALYTICS_CACHE_TTL: must be a numeric integer, got '${rawCacheTtl}'`);
      cacheTtl = CACHE_TTL_DEFAULT;
    } else {
      cacheTtl = parsed;
    }
  }

  if (cacheTtl < CACHE_TTL_MIN || cacheTtl > CACHE_TTL_MAX) {
    const clamped = Math.max(CACHE_TTL_MIN, Math.min(CACHE_TTL_MAX, cacheTtl));
    console.warn(`ANALYTICS_CACHE_TTL ${cacheTtl} adjusted to ${clamped}`);
    cacheTtl = clamped;
  }

  // --- ANALYTICS_CACHE_LOG_ENABLED ---
  const rawCacheLog = env['ANALYTICS_CACHE_LOG_ENABLED'];
  const cacheLogNorm = rawCacheLog?.toLowerCase();

  if (cacheLogNorm !== undefined && cacheLogNorm !== '' && cacheLogNorm !== 'true' && cacheLogNorm !== 'false') {
    console.error(`Configuration error: ANALYTICS_CACHE_LOG_ENABLED: must be 'true' or 'false', got '${rawCacheLog}'`);
  }

  const cacheLoggingEnabled = cacheLogNorm === 'true';

  // --- ANALYTICS_LOG_LEVEL ---
  const rawLogLevel = env['ANALYTICS_LOG_LEVEL'];
  let logLevel: LogLevel;

  if (rawLogLevel === undefined || rawLogLevel === '') {
    logLevel = 'INFO';
  } else {
    const upper = rawLogLevel.toUpperCase() as LogLevel;
    if (LOG_LEVELS.includes(upper)) {
      logLevel = upper;
    } else {
      console.error(
        `Configuration error: ANALYTICS_LOG_LEVEL: must be one of [${LOG_LEVELS.join(', ')}], got '${rawLogLevel}'`
      );
      logLevel = 'INFO';
    }
  }

  return { enabled, cacheTtl, cacheLoggingEnabled, logLevel };
}
