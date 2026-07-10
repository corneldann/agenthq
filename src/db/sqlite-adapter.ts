/**
 * SQLite database adapter using the built-in `bun:sqlite` driver.
 *
 * Implements the {@link DbAdapter} interface for SQLite databases.
 * Foreign keys are enabled on construction; WAL mode is enabled lazily
 * via {@link SQLiteAdapter.enableWal} (called by `createDbAdapter` after
 * construction so that in-memory test databases can skip WAL if desired).
 */

import { Database } from 'bun:sqlite';
import type { DbAdapter, ExecResult, QueryResult } from './adapter.js';

export class SQLiteAdapter implements DbAdapter {
  private db: Database;

  /**
   * Open (or create) a SQLite database at the given path.
   *
   * Pass `':memory:'` for an in-memory database (useful in tests).
   *
   * Foreign-key enforcement is turned on immediately after opening.
   *
   * @param path Filesystem path or `':memory:'`
   */
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  /**
   * Enable WAL (Write-Ahead Logging) journal mode.
   *
   * Call this once after construction for production SQLite databases.
   * Skipped automatically for PostgreSQL — the `createDbAdapter` factory
   * only calls this for SQLite adapters.
   */
  enableWal(): void {
    this.db.exec('PRAGMA journal_mode = WAL');
  }

  /**
   * Execute a SELECT (or any row-returning) statement.
   *
   * @param sql    Parameterized SQL with `?` placeholders
   * @param params Positional parameter values (spread into `stmt.all`)
   */
  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const stmt = this.db.prepare(sql);
    // bun:sqlite's overloaded signature requires SQLQueryBindings[]; unknown[]
    // satisfies the runtime contract and a cast is the least-invasive fix.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = stmt.all(...(params as any[])) as T[];
    return { rows, rowCount: rows.length };
  }

  /**
   * Execute a non-SELECT statement (INSERT, UPDATE, DELETE, DDL).
   *
   * @param sql    Parameterized SQL with `?` placeholders
   * @param params Positional parameter values (spread into `stmt.run`)
   */
  async execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
    const stmt = this.db.prepare(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = stmt.run(...(params as any[]));
    return {
      rowsAffected: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  /**
   * Run an async function inside a SQLite transaction.
   *
   * Issues `BEGIN` before calling `fn(this)`, then `COMMIT` on success.
   * On any error, issues `ROLLBACK` and re-throws so callers can handle
   * the failure (e.g. log the error, surface it to the user).
   *
   * @param fn Async callback that receives this adapter and performs DB work
   */
  async transaction(fn: (adapter: DbAdapter) => Promise<void>): Promise<void> {
    this.db.exec('BEGIN');
    try {
      await fn(this);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Close the underlying SQLite database connection. */
  async close(): Promise<void> {
    this.db.close();
  }
}
