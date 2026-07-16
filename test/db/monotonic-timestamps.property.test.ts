/**
 * Property-Based Tests for Monotonic Status History Timestamps (Property 2)
 *
 * Verifies that rows inserted into `job_status_history` in wall-clock order
 * always yield non-decreasing `changed_at` values when queried by insertion
 * order (`id ASC`), as required by Requirements 4.1 and 4.4:
 *
 *   Requirement 4.1 — WHEN a job status changes, THE DB_Layer SHALL insert a
 *   record into job_status_history with old status, new status, and timestamp.
 *
 *   Requirement 4.4 — WHEN querying status history for a job, THE DB_Layer
 *   SHALL return results ordered by timestamp descending.
 *
 * Property 2 (from design.md):
 *   For any job_id in `job_status_history`, all rows ordered by `changed_at`
 *   DESC MUST reflect a non-decreasing sequence of wall-clock times — no
 *   status-change record MAY have a `changed_at` earlier than any previously
 *   inserted record for the same job.
 *
 * The test inserts N transitions whose `changed_at` values are derived from a
 * monotonically increasing epoch offset sequence, then reads them back ordered
 * by `id ASC` (insertion order) and asserts each successive `changed_at` is
 * ≥ the previous one.
 *
 * **Validates: Requirements 4.1, 4.4**
 */

import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import { Database } from 'bun:sqlite';
import type { DbAdapter } from '../../src/db/adapter.js';

// ---------------------------------------------------------------------------
// In-memory database builder
// ---------------------------------------------------------------------------

/**
 * Build a fresh in-memory SQLite database containing the minimal schema
 * required for the monotonic-timestamps property:
 *   - workspaces  (needed for FK-safe job inserts)
 *   - jobs        (referenced by job_status_history as job_id)
 *   - job_status_history
 *
 * WAL mode is intentionally skipped — in-memory databases do not support WAL.
 * Foreign keys are ON so the FK constraints in migrations are honoured.
 */
function buildTestDb(): { db: DbAdapter; close: () => Promise<void> } {
  const raw = new Database(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');

  raw.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id           TEXT PRIMARY KEY,
      output_dir   TEXT NOT NULL DEFAULT '',
      sessions_dir TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

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
    );

    CREATE TABLE IF NOT EXISTS job_status_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id       TEXT    NOT NULL,
      workspace_id TEXT    NOT NULL,
      old_status   TEXT    NOT NULL,
      new_status   TEXT    NOT NULL,
      reason       TEXT,
      changed_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_status_history_job
      ON job_status_history(job_id, changed_at DESC);
  `);

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

  return { db, close: () => db.close() };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an epoch millisecond value to an ISO 8601 UTC string with
 * millisecond precision, matching the format SQLite stores via
 * `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`.
 *
 * Example: 1_700_000_000_000 → "2023-11-14T22:13:20.000Z"
 */
function epochToIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Given an array of ISO 8601 strings, assert that each element is
 * lexicographically ≥ the previous element.
 *
 * ISO 8601 strings with the same format are safely compared this way because
 * their lexicographic order equals their chronological order.
 */
function assertNonDecreasing(timestamps: readonly string[]): void {
  for (let i = 1; i < timestamps.length; i++) {
    const prev = timestamps[i - 1]!;
    const curr = timestamps[i]!;
    expect(curr >= prev).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Statuses valid for the jobs table CHECK constraint. */
const statusArb = fc.constantFrom(
  'running',
  'done',
  'reported',
  'error',
) as fc.Arbitrary<'running' | 'done' | 'reported' | 'error'>;

/**
 * Generates a sorted array of N epoch-millisecond values representing
 * wall-clock insertion times.
 *
 * - min length 1, max length 20 — keeps test runtime manageable
 * - base epoch anchored at 2024-01-01T00:00:00Z to avoid pre-epoch edge cases
 * - offsets are non-negative integers, then sorted ascending so the sequence
 *   is guaranteed monotonically non-decreasing before we insert it
 */
const BASE_EPOCH_MS = 1_704_067_200_000; // 2024-01-01T00:00:00.000Z

const monotonicEpochsArb: fc.Arbitrary<number[]> = fc
  .array(
    fc.integer({ min: 0, max: 86_400_000 }), // offsets within one day
    { minLength: 1, maxLength: 20 },
  )
  .map((offsets) => offsets.map((o) => BASE_EPOCH_MS + o).sort((a, b) => a - b));

/**
 * Generates a pair of consecutive statuses for a single transition.
 * We simply pick two independent statuses — they may be equal (a
 * same-status "transition") which is intentional: the schema has no
 * uniqueness constraint on (old_status, new_status).
 */
const transitionArb = fc.record({
  oldStatus: statusArb,
  newStatus: statusArb,
});

// ---------------------------------------------------------------------------
// Property 2 — Monotonic Status History Timestamps
// **Validates: Requirements 4.1, 4.4**
// ---------------------------------------------------------------------------

describe('Property 2: Monotonic Status History Timestamps', () => {
  it(
    'property: changed_at values are non-decreasing when rows are queried by id ASC',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(),    // workspaceId
          fc.uuid(),    // jobId
          monotonicEpochsArb,
          fc.array(transitionArb, { minLength: 1, maxLength: 20 }),
          async (workspaceId, jobId, epochsMs, transitions) => {
            // Normalise: use whichever array is shorter so lengths match.
            const count = Math.min(epochsMs.length, transitions.length);
            const epochs = epochsMs.slice(0, count);
            const trans = transitions.slice(0, count);

            const { db, close } = buildTestDb();

            try {
              // ----------------------------------------------------------------
              // Arrange — seed workspace + job so FK constraints pass.
              // ----------------------------------------------------------------
              await db.execute(
                `INSERT INTO workspaces (id, output_dir, sessions_dir)
                 VALUES (?, '/out', '/sessions')`,
                [workspaceId],
              );

              await db.execute(
                `INSERT INTO jobs
                   (id, workspace_id, name, timestamp, status)
                 VALUES (?, ?, 'test-job', datetime('now'), 'running')`,
                [jobId, workspaceId],
              );

              // ----------------------------------------------------------------
              // Act — insert N transitions with explicit, wall-clock-ordered
              // changed_at values derived from the generated epoch sequence.
              // ----------------------------------------------------------------
              for (let i = 0; i < count; i++) {
                const changedAt = epochToIso(epochs[i]!);
                const { oldStatus, newStatus } = trans[i]!;

                await db.execute(
                  `INSERT INTO job_status_history
                     (job_id, workspace_id, old_status, new_status, changed_at)
                   VALUES (?, ?, ?, ?, ?)`,
                  [jobId, workspaceId, oldStatus, newStatus, changedAt],
                );
              }

              // ----------------------------------------------------------------
              // Assert — query back ordered by id ASC (insertion order) and
              // verify changed_at is non-decreasing.
              // ----------------------------------------------------------------
              const result = await db.query<{ changed_at: string }>(
                `SELECT changed_at
                   FROM job_status_history
                  WHERE job_id = ?
                  ORDER BY id ASC`,
                [jobId],
              );

              expect(result.rowCount).toEqual(count);
              assertNonDecreasing(result.rows.map((r) => r.changed_at));
            } finally {
              await close();
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  // -------------------------------------------------------------------------
  // Positive baseline — single transition is trivially non-decreasing.
  // -------------------------------------------------------------------------

  it('should store a single status transition with the correct changed_at value', async () => {
    // Arrange
    const { db, close } = buildTestDb();
    const workspaceId = 'ws-single';
    const jobId = 'job-single';
    const changedAt = '2024-06-15T12:00:00.000Z';

    try {
      await db.execute(
        `INSERT INTO workspaces (id, output_dir, sessions_dir) VALUES (?, '/out', '/sessions')`,
        [workspaceId],
      );
      await db.execute(
        `INSERT INTO jobs (id, workspace_id, name, timestamp, status)
         VALUES (?, ?, 'baseline-job', datetime('now'), 'running')`,
        [jobId, workspaceId],
      );

      // Act
      await db.execute(
        `INSERT INTO job_status_history
           (job_id, workspace_id, old_status, new_status, changed_at)
         VALUES (?, ?, 'running', 'done', ?)`,
        [jobId, workspaceId, changedAt],
      );

      // Assert
      const result = await db.query<{ changed_at: string; old_status: string; new_status: string }>(
        `SELECT changed_at, old_status, new_status
           FROM job_status_history
          WHERE job_id = ?
          ORDER BY id ASC`,
        [jobId],
      );

      expect(result.rowCount).toEqual(1);
      expect(result.rows[0]!.changed_at).toEqual(changedAt);
      expect(result.rows[0]!.old_status).toEqual('running');
      expect(result.rows[0]!.new_status).toEqual('done');
    } finally {
      await close();
    }
  });

  // -------------------------------------------------------------------------
  // Edge case — equal timestamps (same-millisecond transitions) are allowed.
  // -------------------------------------------------------------------------

  it('should accept multiple transitions with identical changed_at timestamps', async () => {
    // Arrange
    const { db, close } = buildTestDb();
    const workspaceId = 'ws-equal';
    const jobId = 'job-equal';
    const sameTs = '2024-06-15T12:00:00.000Z';

    try {
      await db.execute(
        `INSERT INTO workspaces (id, output_dir, sessions_dir) VALUES (?, '/out', '/sessions')`,
        [workspaceId],
      );
      await db.execute(
        `INSERT INTO jobs (id, workspace_id, name, timestamp, status)
         VALUES (?, ?, 'eq-job', datetime('now'), 'running')`,
        [jobId, workspaceId],
      );

      // Act — three transitions all at the same millisecond
      for (const [oldS, newS] of [
        ['running', 'error'] as const,
        ['error', 'running'] as const,
        ['running', 'done'] as const,
      ]) {
        await db.execute(
          `INSERT INTO job_status_history
             (job_id, workspace_id, old_status, new_status, changed_at)
           VALUES (?, ?, ?, ?, ?)`,
          [jobId, workspaceId, oldS, newS, sameTs],
        );
      }

      // Assert — all rows stored, timestamps non-decreasing (trivially equal)
      const result = await db.query<{ changed_at: string }>(
        `SELECT changed_at FROM job_status_history WHERE job_id = ? ORDER BY id ASC`,
        [jobId],
      );

      expect(result.rowCount).toEqual(3);
      assertNonDecreasing(result.rows.map((r) => r.changed_at));
    } finally {
      await close();
    }
  });
});
