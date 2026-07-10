/**
 * Database configuration loader.
 *
 * Reads DB_ENABLED, DB_TYPE, DB_PATH, and DB_URL from the environment
 * and validates them, throwing on any invalid or missing value.
 */

export type DbConfig = {
  /** Whether the database layer is active. Default: true */
  enabled: boolean;
  /** Database engine to use. Default: "sqlite" */
  type: 'sqlite' | 'postgres';
  /** Path to the SQLite file. Default: ".agenthq.db" */
  path: string;
  /** Connection URL — required when type is "postgres" */
  url?: string;
};

/**
 * Parse and validate database configuration from environment variables.
 *
 * @param env - An object of environment variable key/value pairs
 *              (pass `process.env` in production, a plain object in tests).
 * @returns Validated {@link DbConfig}
 * @throws {Error} When DB_ENABLED is not "true" or "false" (case-insensitive)
 * @throws {Error} When DB_TYPE is not "sqlite" or "postgres"
 * @throws {Error} When DB_TYPE is "postgres" and DB_URL is absent
 */
export function loadDbConfig(env: Record<string, string | undefined>): DbConfig {
  // --- DB_ENABLED ---
  // Accept "true" / "false" case-insensitively; reject everything else.
  const rawEnabled = env['DB_ENABLED'];
  const enabledNorm = rawEnabled?.toLowerCase();
  if (enabledNorm !== undefined && enabledNorm !== 'true' && enabledNorm !== 'false') {
    throw new Error(`DB_ENABLED must be 'true' or 'false', got '${enabledNorm}'`);
  }

  // --- DB_TYPE ---
  const rawType = env['DB_TYPE'] ?? 'sqlite';
  if (rawType !== 'sqlite' && rawType !== 'postgres') {
    throw new Error(`DB_TYPE must be 'sqlite' or 'postgres', got '${rawType}'`);
  }
  const type = rawType as 'sqlite' | 'postgres';

  // --- DB_URL (required for postgres) ---
  if (type === 'postgres' && !env['DB_URL']) {
    throw new Error('DB_URL is required when DB_TYPE=postgres');
  }

  return {
    enabled: enabledNorm !== 'false',
    type,
    path: env['DB_PATH'] ?? '.agenthq.db',
    url: env['DB_URL'],
  };
}
