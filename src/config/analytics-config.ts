/**
 * Analytics configuration loader.
 *
 * Reads ANALYTICS_ENABLED and ANALYTICS_CACHE_TTL from the environment,
 * validates them, clamps numeric values to valid ranges, and logs warnings
 * or errors for invalid/out-of-range values without throwing.
 */

export type AnalyticsConfig = {
  /** Whether the analytics layer is active. Default: true */
  enabled: boolean;
  /** Result cache TTL in seconds. Range: [1, 86400]. Default: 300 */
  cacheTtl: number;
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

  return { enabled, cacheTtl };
}
