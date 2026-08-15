/**
 * Database adapter interface, result types, row interfaces, and factory.
 *
 * The `DbAdapter` interface abstracts SQLite and PostgreSQL behind a unified
 * async API. Use `createDbAdapter(config)` to obtain the correct implementation
 * at runtime — it enables WAL mode automatically for SQLite after construction.
 *
 * Row interfaces mirror the database schema column-for-column so that the
 * TypeScript type system catches any schema/query mismatches at compile time.
 */

import type { DbConfig } from '../config/db-config.js';
import { SQLiteAdapter } from './sqlite-adapter.js';
import { PostgresAdapter } from './postgres-adapter.js';

// ---------------------------------------------------------------------------
// Core adapter interface
// ---------------------------------------------------------------------------

/**
 * Unified async database interface for SQLite and PostgreSQL.
 *
 * All methods are async to allow the same call-sites to work with both
 * drivers without modification.
 */
export interface DbAdapter {
  /**
   * Execute a SELECT (or any query that returns rows).
   *
   * @param sql    Parameterized SQL string (use `?` for SQLite, `$1` for Postgres)
   * @param params Positional parameter values
   */
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;

  /**
   * Execute a non-SELECT statement (INSERT, UPDATE, DELETE, DDL).
   *
   * @param sql    Parameterized SQL string
   * @param params Positional parameter values
   */
  execute(sql: string, params?: unknown[]): Promise<ExecResult>;

  /**
   * Run a block of work inside a database transaction.
   *
   * The adapter opens `BEGIN`, calls `fn(adapter)`, then either `COMMIT`s on
   * success or `ROLLBACK`s and re-throws on any error.
   *
   * @param fn Async callback that performs database operations via the adapter
   */
  transaction(fn: (adapter: DbAdapter) => Promise<void>): Promise<void>;

  /** Close the underlying connection / pool. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Returned by {@link DbAdapter.query}. */
export type QueryResult<T> = {
  rows: T[];
  rowCount: number;
};

/** Returned by {@link DbAdapter.execute}. */
export type ExecResult = {
  rowsAffected: number;
  /**
   * The rowid / serial of the last inserted row.
   * Only meaningful after an INSERT; undefined for UPDATE/DELETE/DDL.
   */
  lastInsertRowid?: number | bigint;
};

// ---------------------------------------------------------------------------
// Row interfaces — mirror the database schema exactly
// ---------------------------------------------------------------------------

/**
 * A row from the `jobs` table.
 *
 * Boolean columns (`has_log`, `log_error`) are stored as integers (0/1) in
 * SQLite; PostgreSQL maps them to `boolean` but the interface uses `number`
 * so that a single type covers both drivers without a mapping layer.
 */
export type DbJob = {
  id: string;
  workspace_id: string;
  name: string;
  job_chain: string;
  session_chain_id: string;
  /** ISO 8601 timestamp string. */
  timestamp: string;
  type: string;
  agent: string;
  status: 'running' | 'done' | 'reported' | 'error';
  lines: number;
  last_line: string;
  /** SQLite stores booleans as 0/1 integers. */
  has_log: number;
  /** SQLite stores booleans as 0/1 integers. */
  log_error: number;
  md_file: string;
  log_file: string;
  agent_done: string;
  size_bytes: number;
  /** Unix epoch milliseconds — used for incremental sync. */
  last_modified: number;
  deleted_at: string | null;
};

/** A row from the `chains` table. */
export type DbChain = {
  chain_id: string;
  workspace_id: string;
  display_name: string;
  /** ISO 8601 timestamp string. */
  created_at: string;
  /** ISO 8601 timestamp string. */
  last_active_at: string;
  total_messages: number;
  /** Unix epoch milliseconds. */
  last_modified: number;
  deleted_at: string | null;
};

/** A row from the `sessions` table. */
export type DbSession = {
  chain_id: string;
  workspace_id: string;
  workflow_hash: string;
  chain_index: number;
  status: string;
  message_count: number;
  context_usage_pct: number;
  /** ISO 8601 timestamp string. */
  last_message_at: string;
  /** Unix epoch milliseconds. */
  last_modified: number;
  deleted_at: string | null;
};

/** A row from the `job_status_history` table. */
export type DbJobStatusHistory = {
  /** Auto-increment primary key. */
  id: number;
  job_id: string;
  workspace_id: string;
  old_status: string;
  new_status: string;
  reason: string | null;
  /** ISO 8601 UTC timestamp string. */
  changed_at: string;
};

/** A row from the `schema_version` table. */
export type SchemaVersion = {
  version: number;
  /** ISO 8601 UTC timestamp string. */
  applied_at: string;
  migration_name: string;
};

/**
 * A row from the `memory_extraction` table (migration 004).
 *
 * Tracks per-job memory extraction status, quality metrics, and embedding
 * tier assignment. `embedding_status` is constrained by a SQLite CHECK to
 * one of `'pending' | 'embedded' | 'failed'`; `tier` to `'hot' | 'cold'`.
 *
 * `last_modified` is a Unix epoch millisecond timestamp (INTEGER in SQLite).
 * `deleted_at` is an ISO 8601 string or `null` — soft-delete sentinel.
 */
export type DbMemoryExtraction = {
  /** Auto-increment primary key. */
  id: number;
  /** Foreign key → `jobs.id`. */
  job_id: string;
  workspace_id: string;
  /** ISO 8601 UTC timestamp string — when extraction ran. */
  extracted_at: string;
  /** Full raw text of the job output file passed to the extractor. */
  raw_text: string;
  /** Number of facts successfully retained in Hindsight. */
  memory_count: number;
  /** Weighted mean quality score across accepted facts ∈ [0, 1]. */
  quality_score: number;
  /** Current embedding status — constrained by DB CHECK. */
  embedding_status: 'pending' | 'embedded' | 'failed';
  /**
   * Number of actual Voyage batch submissions for this row.
   * Incremented only after a successful `submit()` call — never incremented
   * for pre-submission API errors.
   */
  embed_attempts: number;
  /** Embedding tier assigned at extraction time — constrained by DB CHECK. */
  tier: 'hot' | 'cold';
  /** Unix epoch milliseconds — used for incremental sync. */
  last_modified: number;
  /** ISO 8601 string when soft-deleted, or `null` if active. */
  deleted_at: string | null;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create and return a `DbAdapter` for the given configuration.
 *
 * - When `config.type === 'postgres'`, returns a {@link PostgresAdapter}.
 * - Otherwise, returns a {@link SQLiteAdapter} and enables WAL journal mode
 *   immediately after construction (WAL is SQLite-only).
 *
 * @param config Validated database configuration from {@link loadDbConfig}
 */
export function createDbAdapter(config: DbConfig): DbAdapter {
  if (config.type === 'postgres') {
    return new PostgresAdapter(config.url!) as DbAdapter;
  }

  const adapter = new SQLiteAdapter(config.path) as DbAdapter & {
    enableWal(): void;
  };
  // WAL mode must be enabled after the SQLiteAdapter constructor completes;
  // it is intentionally skipped for PostgreSQL.
  adapter.enableWal();
  return adapter;
}
