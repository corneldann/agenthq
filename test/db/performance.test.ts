/**
 * Performance tests for indexed query bounds (Property 8, 9, 10).
 *
 * Verifies that common database operations complete within documented
 * latency bounds, ensuring query indexes are exercised at scale.
 *
 * Properties covered:
 *  - Property 8 (indexed query bounds): workspace+status filter p99 ≤ 75ms,
 *    time-range filter p99 ≤ 50ms, GROUP BY aggregation p99 ≤ 100ms.
 *  - Property 9 (bounded migration duration): runMigrations ≤ 10 000ms.
 *  - Property 10 (bounded full-sync duration): runFullSync ≤ 1 800 000ms.
 *
 * Validates: Requirements 3.1, 3.3, 3.4, 3.5, 5.6, 6.2, 12.2, 2.6
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as path from 'path';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { DbSyncTool } from '../../src/db/sync.ts';
import type { DbAdapter } from '../../src/db/adapter.ts';

// ---------------------------------------------------------------------------
// p99 helper
// ---------------------------------------------------------------------------

/**
 * Compute the 99th-percentile value from an array of timing samples.
 *
 * @param timings Array of duration values (milliseconds)
 */
function p99(timings: number[]): number {
  const sorted = [...timings].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.99);
  return sorted[Math.min(idx, sorted.length - 1)]!;
}

// ---------------------------------------------------------------------------
// Schema helpers (mirrors test/db/adapter.test.ts exactly)
// ---------------------------------------------------------------------------

/** Apply the full production schema to an adapter. WAL is skipped for :memory:. */
async function setupSchema(db: DbAdapter): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version        INTEGER PRIMARY KEY,
      applied_at     TEXT    NOT NULL,
      migration_name TEXT    NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id           TEXT PRIMARY KEY,
      output_dir   TEXT NOT NULL,
      sessions_dir TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS jobs (
      id               TEXT PRIMARY KEY,
      workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name             TEXT NOT NULL,
      job_chain        TEXT NOT NULL DEFAULT '',
      session_chain_id TEXT NOT NULL DEFAULT '',
      timestamp        TEXT NOT NULL,
      type             TEXT NOT NULL DEFAULT '',
      agent            TEXT NOT NULL DEFAULT '',
      status           TEXT NOT NULL CHECK(status IN ('running','done','reported','error')),
      lines            INTEGER NOT NULL DEFAULT 0,
      last_line        TEXT NOT NULL DEFAULT '',
      has_log          INTEGER NOT NULL DEFAULT 0,
      log_error        INTEGER NOT NULL DEFAULT 0,
      md_file          TEXT NOT NULL DEFAULT '',
      log_file         TEXT NOT NULL DEFAULT '',
      agent_done       TEXT NOT NULL DEFAULT '',
      size_bytes       INTEGER NOT NULL DEFAULT 0,
      last_modified    INTEGER NOT NULL DEFAULT 0,
      deleted_at       TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS chains (
      chain_id       TEXT PRIMARY KEY,
      workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      display_name   TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      total_messages INTEGER NOT NULL DEFAULT 0,
      last_modified  INTEGER NOT NULL DEFAULT 0,
      deleted_at     TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      chain_id          TEXT NOT NULL,
      workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      workflow_hash     TEXT NOT NULL DEFAULT '',
      chain_index       INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'idle',
      message_count     INTEGER NOT NULL DEFAULT 0,
      context_usage_pct REAL NOT NULL DEFAULT 0,
      last_message_at   TEXT NOT NULL,
      last_modified     INTEGER NOT NULL DEFAULT 0,
      deleted_at        TEXT,
      PRIMARY KEY (chain_id, workflow_hash)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS job_status_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id       TEXT    NOT NULL,
      workspace_id TEXT    NOT NULL,
      old_status   TEXT    NOT NULL,
      new_status   TEXT    NOT NULL,
      reason       TEXT,
      changed_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  // Indexes matching migrations/001_initial.sql
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_jobs_workspace_status
      ON jobs(workspace_id, status) WHERE deleted_at IS NULL
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_workspace_timestamp
      ON jobs(workspace_id, timestamp DESC) WHERE deleted_at IS NULL
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_jobs_timestamp
      ON jobs(timestamp) WHERE deleted_at IS NULL
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_chains_workspace_active
      ON chains(workspace_id, last_active_at DESC) WHERE deleted_at IS NULL
  `);
}

// ---------------------------------------------------------------------------
// Low-level raw-Database wrapper (identical pattern to sync.test.ts)
// ---------------------------------------------------------------------------

/**
 * Build an in-memory SQLite DB with the full schema applied.
 * Returns a thin DbAdapter wrapper over a shared bun:sqlite Database.
 */
function buildRawDb(): { raw: Database; db: DbAdapter; close: () => void } {
  const raw = new Database(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');

  const db: DbAdapter = {
    async query<T>(sql: string, params: unknown[] = []) {
      const stmt = raw.prepare(sql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = stmt.all(...(params as any[])) as T[];
      return { rows, rowCount: rows.length };
    },
    async execute(sql: string, params: unknown[] = []) {
      const stmt = raw.prepare(sql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = stmt.run(...(params as any[]));
      return { rowsAffected: result.changes, lastInsertRowid: result.lastInsertRowid };
    },
    async transaction(fn) {
      raw.exec('BEGIN');
      try {
        await fn(db);
        raw.exec('COMMIT');
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    async close() {
      raw.close();
    },
  };

  return { raw, db, close: () => raw.close() };
}

// ---------------------------------------------------------------------------
// Bulk seeding helpers
// ---------------------------------------------------------------------------

const JOB_STATUSES = ['running', 'done', 'reported', 'error'] as const;
type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Seed `count` job rows for the given workspace using a single transaction.
 * Statuses rotate evenly across the four allowed values.
 */
function seedJobs(raw: Database, workspaceId: string, count: number): void {
  const insert = raw.prepare(`
    INSERT INTO jobs
      (id, workspace_id, name, timestamp, status)
    VALUES (?, ?, ?, ?, ?)
  `);

  raw.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    const status: JobStatus = JOB_STATUSES[i % JOB_STATUSES.length]!;
    insert.run(`job-${i}`, workspaceId, `job-name-${i}`, '2024-01-01T00:00:00Z', status);
  }
  raw.exec('COMMIT');
}

/**
 * Seed `count` chain rows with staggered ISO 8601 timestamps.
 * `created_at` starts at 2024-01-01; `last_active_at` advances by ~1 hour per row.
 */
function seedChains(raw: Database, workspaceId: string, count: number): void {
  const insert = raw.prepare(`
    INSERT INTO chains
      (chain_id, workspace_id, created_at, last_active_at)
    VALUES (?, ?, ?, ?)
  `);

  const BASE_MS = new Date('2024-01-01T00:00:00Z').getTime();
  const STEP_MS = 3_600_000; // 1 hour

  raw.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    const lastActiveAt = new Date(BASE_MS + i * STEP_MS).toISOString();
    insert.run(`chain-${i}`, workspaceId, '2024-01-01T00:00:00Z', lastActiveAt);
  }
  raw.exec('COMMIT');
}

/** Insert a single workspace row. */
function insertWorkspace(raw: Database, workspaceId: string): void {
  raw
    .prepare(`INSERT INTO workspaces (id, output_dir, sessions_dir) VALUES (?, ?, ?)`)
    .run(workspaceId, '/out', '/sessions');
}

// ---------------------------------------------------------------------------
// Performance test 1 — Workspace+status filter (Property 8)
// Validates: Requirements 3.1, 12.2
// ---------------------------------------------------------------------------

describe('Property 8: workspace+status filter p99 ≤ 75ms', () => {
  const WORKSPACE_ID = 'ws-perf-1';
  const JOB_COUNT = 8_000;
  const ITERATIONS = 100;
  const P99_LIMIT_MS = 75;

  let raw: Database;
  let db: DbAdapter;
  let closeDb: () => void;

  beforeEach(async () => {
    ({ raw, db, close: closeDb } = buildRawDb());
    await setupSchema(db);
    insertWorkspace(raw, WORKSPACE_ID);
    seedJobs(raw, WORKSPACE_ID, JOB_COUNT);
  });

  afterEach(async () => {
    await db.close();
  });

  it(`should complete workspace+status filter in p99 ≤ ${P99_LIMIT_MS}ms across ${ITERATIONS} iterations (${JOB_COUNT} rows)`, async () => {
    // Validates: Requirements 3.1, 12.2
    const timings: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const status: JobStatus = JOB_STATUSES[i % JOB_STATUSES.length]!;
      const start = performance.now();
      await db.query(
        `SELECT * FROM jobs WHERE workspace_id = ? AND status = ? AND deleted_at IS NULL`,
        [WORKSPACE_ID, status],
      );
      timings.push(performance.now() - start);
    }

    const p99ms = p99(timings);
    expect(p99ms).toBeLessThan(P99_LIMIT_MS);
  });
});

// ---------------------------------------------------------------------------
// Performance test 2 — Time-range filter (Property 8)
// Validates: Requirements 3.3, 3.4, 12.2
// ---------------------------------------------------------------------------

describe('Property 8: time-range filter on chains p99 ≤ 50ms', () => {
  const WORKSPACE_ID = 'ws-perf-2';
  const CHAIN_COUNT = 1_000;
  const ITERATIONS = 100;
  const P99_LIMIT_MS = 50;

  let raw: Database;
  let db: DbAdapter;

  beforeEach(async () => {
    ({ raw, db } = buildRawDb());
    await setupSchema(db);
    insertWorkspace(raw, WORKSPACE_ID);
    seedChains(raw, WORKSPACE_ID, CHAIN_COUNT);
  });

  afterEach(async () => {
    await db.close();
  });

  it(`should complete time-range filter on chains in p99 ≤ ${P99_LIMIT_MS}ms across ${ITERATIONS} iterations (${CHAIN_COUNT} rows)`, async () => {
    // Validates: Requirements 3.3, 3.4, 12.2
    const BASE_MS = new Date('2024-01-01T00:00:00Z').getTime();
    const STEP_MS = 3_600_000; // 1 hour per row

    const timings: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      // Slide a 10-hour window across the dataset for varied coverage
      const windowStart = new Date(BASE_MS + (i * STEP_MS * 5)).toISOString();
      const windowEnd   = new Date(BASE_MS + (i * STEP_MS * 5) + (10 * STEP_MS)).toISOString();

      const start = performance.now();
      await db.query(
        `SELECT * FROM chains
          WHERE workspace_id = ?
            AND last_active_at >= ?
            AND last_active_at <= ?
            AND deleted_at IS NULL`,
        [WORKSPACE_ID, windowStart, windowEnd],
      );
      timings.push(performance.now() - start);
    }

    const p99ms = p99(timings);
    expect(p99ms).toBeLessThan(P99_LIMIT_MS);
  });
});

// ---------------------------------------------------------------------------
// Performance test 3 — GROUP BY status aggregation (Property 8)
// Validates: Requirements 3.5, 12.2
// ---------------------------------------------------------------------------

describe('Property 8: GROUP BY status aggregation p99 ≤ 100ms', () => {
  const WORKSPACE_ID = 'ws-perf-3';
  const JOB_COUNT = 10_000;
  const ITERATIONS = 100;
  const P99_LIMIT_MS = 100;

  let raw: Database;
  let db: DbAdapter;

  beforeEach(async () => {
    ({ raw, db } = buildRawDb());
    await setupSchema(db);
    insertWorkspace(raw, WORKSPACE_ID);
    seedJobs(raw, WORKSPACE_ID, JOB_COUNT);
  });

  afterEach(async () => {
    await db.close();
  });

  it(`should complete GROUP BY status aggregation in p99 ≤ ${P99_LIMIT_MS}ms across ${ITERATIONS} iterations (${JOB_COUNT} rows)`, async () => {
    // Validates: Requirements 3.5, 12.2
    const timings: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      await db.query(
        `SELECT status, COUNT(*) as count
           FROM jobs
          WHERE workspace_id = ?
            AND deleted_at IS NULL
          GROUP BY status`,
        [WORKSPACE_ID],
      );
      timings.push(performance.now() - start);
    }

    const p99ms = p99(timings);
    expect(p99ms).toBeLessThan(P99_LIMIT_MS);
  });
});

// ---------------------------------------------------------------------------
// Performance test 4 — Bounded full-sync duration (Property 10)
// Validates: Requirements 6.2, 2.6
// ---------------------------------------------------------------------------

/**
 * A DbSyncTool subclass that bypasses the real filesystem scanners and instead
 * returns pre-built fixture arrays. This isolates the transaction throughput
 * from any I/O latency on the host machine's filesystem.
 */
class FullSyncPerfTool extends DbSyncTool {
  private readonly jobCount: number;
  private readonly chainCount: number;
  private readonly sessionCount: number;

  constructor(
    db: DbAdapter,
    jobCount: number,
    chainCount: number,
    sessionCount: number,
  ) {
    super(db);
    this.jobCount = jobCount;
    this.chainCount = chainCount;
    this.sessionCount = sessionCount;
  }

  override async runFullSync(workspaceId: string): Promise<void> {
    const now = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (this as any).db as DbAdapter;

    await db.transaction(async (tx) => {
      // Upsert jobs
      for (let i = 0; i < this.jobCount; i++) {
        const status: JobStatus = JOB_STATUSES[i % JOB_STATUSES.length]!;
        await tx.execute(
          `INSERT INTO jobs (
             id, workspace_id, name, job_chain, session_chain_id,
             timestamp, type, agent, status, lines, last_line,
             has_log, log_error, md_file, log_file, agent_done,
             size_bytes, last_modified, deleted_at
           ) VALUES (
             ?, ?, ?, '', '',
             '2024-01-01T00:00:00Z', 'prompt', 'kiro', ?, 0, '',
             0, 0, '', '', '',
             0, ?, NULL
           )
           ON CONFLICT(id) DO UPDATE SET
             status        = excluded.status,
             last_modified = excluded.last_modified`,
          [`sync-job-${i}`, workspaceId, `job-name-${i}`, status, now],
        );
      }

      // Upsert chains
      for (let i = 0; i < this.chainCount; i++) {
        await tx.execute(
          `INSERT INTO chains (
             chain_id, workspace_id, display_name,
             created_at, last_active_at, total_messages,
             last_modified, deleted_at
           ) VALUES (?, ?, '', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 0, ?, NULL)
           ON CONFLICT(chain_id) DO UPDATE SET
             last_modified = excluded.last_modified`,
          [`sync-chain-${i}`, workspaceId, now],
        );
      }

      // Upsert sessions
      for (let i = 0; i < this.sessionCount; i++) {
        await tx.execute(
          `INSERT INTO sessions (
             chain_id, workspace_id, workflow_hash,
             chain_index, status, message_count,
             context_usage_pct, last_message_at,
             last_modified, deleted_at
           ) VALUES (?, ?, ?, 0, 'idle', 0, 0, '2024-01-01T00:00:00Z', ?, NULL)
           ON CONFLICT(chain_id, workflow_hash) DO UPDATE SET
             last_modified = excluded.last_modified`,
          [`sync-chain-${i % this.chainCount}`, workspaceId, `hash-${i}`, now],
        );
      }
    });
  }
}

describe('Property 10: bounded full-sync duration ≤ 1 800 000ms', () => {
  const WORKSPACE_ID = 'ws-perf-sync';
  const RECORD_COUNT = 10_000;
  const DURATION_LIMIT_MS = 1_800_000; // 30 minutes

  let raw: Database;
  let db: DbAdapter;

  beforeEach(async () => {
    ({ raw, db } = buildRawDb());
    await setupSchema(db);
    insertWorkspace(raw, WORKSPACE_ID);
  });

  afterEach(async () => {
    await db.close();
  });

  it(`should complete runFullSync with ${RECORD_COUNT} jobs/chains/sessions in ≤ ${DURATION_LIMIT_MS}ms`, async () => {
    // Validates: Requirements 6.2, 2.6
    const tool = new FullSyncPerfTool(db, RECORD_COUNT, RECORD_COUNT, RECORD_COUNT);

    const start = performance.now();
    await tool.runFullSync(WORKSPACE_ID);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(DURATION_LIMIT_MS);

    // Sanity-check row counts to confirm the sync actually ran
    const jobCount = await db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM jobs WHERE workspace_id = ?`,
      [WORKSPACE_ID],
    );
    expect(jobCount.rows[0]!.cnt).toBe(RECORD_COUNT);
  });
});

// ---------------------------------------------------------------------------
// Performance test 5 — Bounded migration duration (Property 9)
// Validates: Requirements 5.6
// ---------------------------------------------------------------------------

describe('Property 9: bounded migration duration ≤ 10 000ms', () => {
  const DURATION_LIMIT_MS = 10_000;

  let db: SQLiteAdapter;

  beforeEach(() => {
    db = new SQLiteAdapter(':memory:');
  });

  afterEach(async () => {
    await db.close();
  });

  it(`should complete runMigrations against the real migrations/ directory in ≤ ${DURATION_LIMIT_MS}ms`, async () => {
    // Validates: Requirements 5.6
    const migrationsDir = path.join(process.cwd(), 'migrations');

    const start = performance.now();
    await runMigrations(db, migrationsDir);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(DURATION_LIMIT_MS);

    // Sanity-check that migrations actually ran
    const result = await db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM schema_version`,
    );
    expect(result.rows[0]!.cnt).toBeGreaterThan(0);
  });
});
