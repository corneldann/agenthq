/**
 * PostgreSQL database adapter using the `pg` driver.
 *
 * Implements the {@link DbAdapter} interface for PostgreSQL databases.
 * The `pg` package is lazy-loaded inside the constructor so that the server
 * can start without crashing when only SQLite is configured and `pg` is not
 * installed.
 *
 * Requirements: 1.2, 10.1, 11.3
 */

// ---------------------------------------------------------------------------
// Minimal structural types for the `pg` driver — avoids a hard dependency on
// `@types/pg` while keeping the implementation fully type-safe.
// ---------------------------------------------------------------------------

/** Minimal shape of a pg Pool we depend on. */
type PgPool = {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult<unknown>>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
  on(event: string, handler: (err: Error) => void): void;
};

/** Minimal shape of a pg PoolClient we depend on. */
type PgClient = {
  query(sql: string): Promise<PgQueryResult<unknown>>;
  release(): void;
};

/** Minimal shape of a pg QueryResult we depend on. */
type PgQueryResult<T> = {
  rows: T[];
  rowCount: number | null;
};
import type { DbAdapter, ExecResult, QueryResult } from './adapter.js';

// ---------------------------------------------------------------------------
// Slow-query helpers (Requirement 10.1)
// ---------------------------------------------------------------------------

/**
 * Extract the primary table name from a SQL string.
 *
 * Handles the four most common DML forms:
 *  - `SELECT ... FROM table_name ...`
 *  - `INSERT INTO table_name ...`
 *  - `UPDATE table_name ...`
 *  - `DELETE FROM table_name ...`
 *
 * Returns `"unknown"` when the pattern cannot be matched.
 *
 * @param sql Raw SQL string (may be multi-line / mixed case)
 */
function extractTableName(sql: string): string {
  const normalised = sql.replace(/\s+/g, ' ').trim();

  const patterns: RegExp[] = [
    /\bFROM\s+(\w+)/i,
    /\bINTO\s+(\w+)/i,
    /\bUPDATE\s+(\w+)/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(normalised);
    if (match?.[1]) {
      return match[1];
    }
  }

  return 'unknown';
}

/**
 * Emit a slow-query warning when `duration_ms` exceeds 100ms (strictly >).
 */
function logSlowQueryIfNeeded(
  query_type: 'query' | 'execute',
  duration_ms: number,
  sql: string,
  params: unknown[],
): void {
  if (duration_ms > 100) {
    console.warn(
      JSON.stringify({
        level: 'WARN',
        query_type,
        duration_ms: Math.round(duration_ms),
        table_name: extractTableName(sql),
        filter_conditions: params,
      }),
    );
  }
}

export class PostgresAdapter implements DbAdapter {
  private pool: PgPool;

  /**
   * Create a connection pool for the given Postgres connection string.
   *
   * The `pg` package is loaded via `require('pg')` at construction time so
   * that the module can be imported without crashing when `pg` is absent.
   * If `pg` is not installed a descriptive error is thrown immediately.
   *
   * @param connectionString `postgres://user:pass@host:port/dbname` URL
   * @throws Error if the `pg` package is not installed
   */
  constructor(connectionString: string) {
    let PgPool: new (config: { connectionString: string }) => PgPool;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pg = require('pg') as { Pool: new (config: { connectionString: string }) => PgPool };
      PgPool = pg.Pool;
    } catch {
      throw new Error(
        'pg package is required for PostgreSQL support. Install it with: npm install pg'
      );
    }
    this.pool = new PgPool({ connectionString });

    // Surface connection errors safely — no URL, host, port, or credentials.
    this.pool.on('error', (err: Error) => {
      // Strip connection details from the message before logging.
      const safeMessage = err.message.replace(/postgres(?:ql)?:\/\/[^\s]*/gi, '[redacted]');
      console.error(`PostgreSQL pool error: ${safeMessage}`);
    });
  }

  /**
   * Execute a SELECT (or any row-returning) statement.
   *
   * Times the operation and emits a WARN log when execution exceeds 100ms
   * (Requirement 10.1).
   *
   * @param sql    Parameterized SQL with `$1`, `$2`, … placeholders
   * @param params Positional parameter values
   */
  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const start = performance.now();
    try {
      const result = await this.pool.query(sql, params) as PgQueryResult<T>;
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    } finally {
      logSlowQueryIfNeeded('query', performance.now() - start, sql, params);
    }
  }

  /**
   * Execute a non-SELECT statement (INSERT, UPDATE, DELETE, DDL).
   *
   * Times the operation and emits a WARN log when execution exceeds 100ms
   * (Requirement 10.1).
   *
   * @param sql    Parameterized SQL with `$1`, `$2`, … placeholders
   * @param params Positional parameter values
   */
  async execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
    const start = performance.now();
    try {
      const result = await this.pool.query(sql, params);
      return { rowsAffected: result.rowCount ?? 0 };
    } finally {
      logSlowQueryIfNeeded('execute', performance.now() - start, sql, params);
    }
  }

  /**
   * Run an async function inside a Postgres transaction.
   *
   * Acquires a dedicated client from the pool, issues `BEGIN`, calls
   * `fn(this)`, then either `COMMIT`s on success or `ROLLBACK`s and
   * re-throws on any error. The client is always released in `finally`.
   *
   * @param fn Async callback that performs database operations via the adapter
   */
  async transaction(fn: (adapter: DbAdapter) => Promise<void>): Promise<void> {
    const client: PgClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await fn(this);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Drain the connection pool and close all idle / active connections. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
