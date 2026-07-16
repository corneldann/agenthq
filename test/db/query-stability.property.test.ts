/**
 * Property-Based Tests for Query Result Stability (Property 7)
 *
 * Verifies that identical parameterized queries executed with no intervening
 * writes always produce identical result sets, as required by Requirements
 * 3.1, 3.3, and 3.5.
 *
 * Property 7 (from design.md):
 *   For any two identical SQL queries with identical parameters executed with
 *   no intervening writes, the result sets MUST be identical (modulo
 *   auto-generated timestamp fields).
 *
 * Three query types from the requirements are covered:
 *
 *   7a. **Job workspace+status filter** (Req 3.1) — runs the indexed
 *       workspace+status filter query twice and asserts deep equality of
 *       the returned rows (id, workspace_id, status, name, timestamp).
 *
 *   7b. **Chain workspace ORDER BY last_active_at** (Req 3.3) — runs the
 *       chains-by-workspace query ordered by last_active_at DESC twice and
 *       asserts deep equality, including ordering stability.
 *
 *   7c. **Job status aggregation** (Req 3.5) — runs the GROUP BY status
 *       COUNT(*) aggregation query twice and asserts that every status bucket
 *       has the identical count in both results.
 *
 * **Validates: Requirements 3.1, 3.3, 3.5**
 */

import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import { Database } from 'bun:sqlite';
import type { DbAdapter } from '../../src/db/adapter.js';

// ---------------------------------------------------------------------------
// In-memory database builder
// ---------------------------------------------------------------------------

/**
 * Build a fresh in-memory SQLite DB with the full production schema and
 * indexes applied.  Foreign keys are enabled so FK constraints are enforced.
 * WAL mode is intentionally skipped — in-memory databases do not support WAL.
 *
 * Returns a thin DbAdapter wrapper and a close() function.
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

    CREATE TABLE IF NOT EXISTS chains (
      chain_id         TEXT PRIMARY KEY,
      workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      display_name     TEXT NOT NULL DEFAULT '',
      created_at       TEXT NOT NULL,
      last_active_at   TEXT NOT NULL,
      total_messages   INTEGER NOT NULL DEFAULT 0,
      last_modified    INTEGER NOT NULL DEFAULT 0,
      deleted_at       TEXT
    );

    -- Indexes matching the production schema (Requirement 3)
    CREATE INDEX IF NOT EXISTS idx_jobs_workspace_status
      ON jobs(workspace_id, status) WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_workspace_timestamp
      ON jobs(workspace_id, timestamp DESC) WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_chains_workspace_active
      ON chains(workspace_id, last_active_at DESC) WHERE deleted_at IS NULL;
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
// Arbitraries
// ---------------------------------------------------------------------------

/** Valid job statuses matching the CHECK constraint. */
const statusArb = fc.constantFrom(
  'running',
  'done',
  'reported',
  'error',
) as fc.Arbitrary<'running' | 'done' | 'reported' | 'error'>;

/**
 * Generates a safe non-empty string: no null bytes, no leading/trailing
 * whitespace issues, bounded length.
 */
const safeStringArb = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => !s.includes('\0'));

/**
 * ISO 8601-like timestamp strings anchored to 2024 so they sort predictably.
 *
 * Generates values like "2024-01-01T00:00:00.000Z" .. "2024-12-31T23:59:59.999Z"
 * by constructing from an epoch offset within the year 2024.
 */
const BASE_EPOCH_2024 = 1_704_067_200_000; // 2024-01-01T00:00:00.000Z
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const isoTimestampArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: ONE_YEAR_MS })
  .map((offset) => new Date(BASE_EPOCH_2024 + offset).toISOString());

/** A single job record for seeding. */
type SeedJob = {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly status: 'running' | 'done' | 'reported' | 'error';
  readonly timestamp: string;
};

/** A single chain record for seeding. */
type SeedChain = {
  readonly chainId: string;
  readonly workspaceId: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly lastActiveAt: string;
  readonly totalMessages: number;
};

/**
 * Generates 1–10 job records all sharing the same workspaceId so the
 * workspace+status filter has meaningful data to work with.
 */
function makeJobsArb(workspaceId: string): fc.Arbitrary<readonly SeedJob[]> {
  return fc.array(
    fc.record({
      id: fc.uuid(),
      name: safeStringArb,
      status: statusArb,
      timestamp: isoTimestampArb,
    }),
    { minLength: 1, maxLength: 10 },
  ).map((jobs) =>
    jobs.map((j) => ({ ...j, workspaceId })),
  );
}

/**
 * Generates 1–8 chain records all sharing the same workspaceId.
 */
function makeChainsArb(workspaceId: string): fc.Arbitrary<readonly SeedChain[]> {
  return fc.array(
    fc.record({
      chainId: fc.uuid(),
      displayName: safeStringArb,
      createdAt: isoTimestampArb,
      lastActiveAt: isoTimestampArb,
      totalMessages: fc.integer({ min: 0, max: 500 }),
    }),
    { minLength: 1, maxLength: 8 },
  ).map((chains) =>
    chains.map((c) => ({ ...c, workspaceId })),
  );
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/** Insert a workspace row, ignoring conflicts for test idempotency. */
async function seedWorkspace(db: DbAdapter, workspaceId: string): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO workspaces (id, output_dir, sessions_dir) VALUES (?, '', '')`,
    [workspaceId],
  );
}

/** Bulk-insert a set of job rows. */
async function seedJobs(db: DbAdapter, jobs: readonly SeedJob[]): Promise<void> {
  for (const j of jobs) {
    await db.execute(
      `INSERT OR IGNORE INTO jobs
         (id, workspace_id, name, timestamp, status)
       VALUES (?, ?, ?, ?, ?)`,
      [j.id, j.workspaceId, j.name, j.timestamp, j.status],
    );
  }
}

/** Bulk-insert a set of chain rows. */
async function seedChains(db: DbAdapter, chains: readonly SeedChain[]): Promise<void> {
  for (const c of chains) {
    await db.execute(
      `INSERT OR IGNORE INTO chains
         (chain_id, workspace_id, display_name, created_at, last_active_at, total_messages)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [c.chainId, c.workspaceId, c.displayName, c.createdAt, c.lastActiveAt, c.totalMessages],
    );
  }
}

// ---------------------------------------------------------------------------
// Property 7a — Job workspace+status filter stability (Requirement 3.1)
// **Validates: Requirements 3.1, 3.3, 3.5**
// ---------------------------------------------------------------------------

describe('Property 7: Query Result Stability', () => {
  it(
    'property: job workspace+status filter query returns identical results on two consecutive runs with no intervening writes',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(),   // workspaceId
          statusArb,   // status to filter by
          async (workspaceId, filterStatus) => {
            const { db, close } = buildTestDb();

            try {
              // ── Arrange — seed workspace + jobs ──────────────────────────
              await seedWorkspace(db, workspaceId);
              const jobs = await fc.sample(makeJobsArb(workspaceId), 1)[0]!;
              await seedJobs(db, jobs);

              // ── Act — run the same query twice with no writes in between ─
              const sql = `
                SELECT id, workspace_id, name, status, timestamp
                FROM jobs
                WHERE workspace_id = ? AND status = ? AND deleted_at IS NULL
                ORDER BY timestamp DESC, id ASC
              `;
              const params = [workspaceId, filterStatus];

              type JobRow = {
                id: string;
                workspace_id: string;
                name: string;
                status: string;
                timestamp: string;
              };

              const result1 = await db.query<JobRow>(sql, params);
              const result2 = await db.query<JobRow>(sql, params);

              // ── Assert — both calls must return identical result sets ────
              expect(result2.rowCount).toEqual(result1.rowCount);
              expect(result2.rows).toEqual(result1.rows);
            } finally {
              await close();
            }
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  // -------------------------------------------------------------------------
  // Property 7b — Chain workspace ORDER BY last_active_at stability (Req 3.3)
  // **Validates: Requirements 3.1, 3.3, 3.5**
  // -------------------------------------------------------------------------

  it(
    'property: chain workspace query ordered by last_active_at returns identical results on two consecutive runs with no intervening writes',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(),   // workspaceId
          async (workspaceId) => {
            const { db, close } = buildTestDb();

            try {
              // ── Arrange — seed workspace + chains ────────────────────────
              await seedWorkspace(db, workspaceId);
              const chains = await fc.sample(makeChainsArb(workspaceId), 1)[0]!;
              await seedChains(db, chains);

              // ── Act — run the same query twice ───────────────────────────
              const sql = `
                SELECT chain_id, workspace_id, display_name, last_active_at, total_messages
                FROM chains
                WHERE workspace_id = ? AND deleted_at IS NULL
                ORDER BY last_active_at DESC, chain_id ASC
              `;
              const params = [workspaceId];

              type ChainRow = {
                chain_id: string;
                workspace_id: string;
                display_name: string;
                last_active_at: string;
                total_messages: number;
              };

              const result1 = await db.query<ChainRow>(sql, params);
              const result2 = await db.query<ChainRow>(sql, params);

              // ── Assert — both calls must return identical ordered results ─
              expect(result2.rowCount).toEqual(result1.rowCount);
              expect(result2.rows).toEqual(result1.rows);
            } finally {
              await close();
            }
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  // -------------------------------------------------------------------------
  // Property 7c — Job status aggregation stability (Req 3.5)
  // **Validates: Requirements 3.1, 3.3, 3.5**
  // -------------------------------------------------------------------------

  it(
    'property: job status aggregation query returns identical status counts on two consecutive runs with no intervening writes',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(),   // workspaceId
          async (workspaceId) => {
            const { db, close } = buildTestDb();

            try {
              // ── Arrange — seed workspace + jobs ──────────────────────────
              await seedWorkspace(db, workspaceId);
              const jobs = await fc.sample(makeJobsArb(workspaceId), 1)[0]!;
              await seedJobs(db, jobs);

              // ── Act — run the same aggregation query twice ───────────────
              const sql = `
                SELECT status, COUNT(*) as count
                FROM jobs
                WHERE workspace_id = ? AND deleted_at IS NULL
                GROUP BY status
                ORDER BY status ASC
              `;
              const params = [workspaceId];

              type AggRow = {
                status: string;
                count: number;
              };

              const result1 = await db.query<AggRow>(sql, params);
              const result2 = await db.query<AggRow>(sql, params);

              // ── Assert — aggregation buckets must be identical ────────────
              expect(result2.rowCount).toEqual(result1.rowCount);
              expect(result2.rows).toEqual(result1.rows);
            } finally {
              await close();
            }
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  // -------------------------------------------------------------------------
  // Property 7d — Multi-workspace isolation stability
  // Running the workspace+status query for workspace A must not be affected
  // by the existence of data in workspace B — and the result is stable across
  // two calls even when both workspaces are populated.
  // **Validates: Requirements 3.1, 3.3, 3.5**
  // -------------------------------------------------------------------------

  it(
    'property: job workspace+status query result is stable and unaffected by data in another workspace',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(),    // workspaceId A (query target)
          fc.uuid(),    // workspaceId B (noise)
          statusArb,    // status to filter by in workspace A
          async (workspaceIdA, workspaceIdB, filterStatus) => {
            // Ensure the two generated IDs are distinct.
            fc.pre(workspaceIdA !== workspaceIdB);

            const { db, close } = buildTestDb();

            try {
              // ── Arrange — seed both workspaces ───────────────────────────
              await seedWorkspace(db, workspaceIdA);
              await seedWorkspace(db, workspaceIdB);

              const jobsA = await fc.sample(makeJobsArb(workspaceIdA), 1)[0]!;
              const jobsB = await fc.sample(makeJobsArb(workspaceIdB), 1)[0]!;
              await seedJobs(db, jobsA);
              await seedJobs(db, jobsB);

              // ── Act — query workspace A twice; no writes between calls ───
              const sql = `
                SELECT id, workspace_id, name, status, timestamp
                FROM jobs
                WHERE workspace_id = ? AND status = ? AND deleted_at IS NULL
                ORDER BY timestamp DESC, id ASC
              `;
              const params = [workspaceIdA, filterStatus];

              type JobRow = {
                id: string;
                workspace_id: string;
                name: string;
                status: string;
                timestamp: string;
              };

              const result1 = await db.query<JobRow>(sql, params);
              const result2 = await db.query<JobRow>(sql, params);

              // ── Assert — both results are identical ──────────────────────
              expect(result2.rowCount).toEqual(result1.rowCount);
              expect(result2.rows).toEqual(result1.rows);

              // All returned rows must belong to workspace A only.
              for (const row of result1.rows) {
                expect(row.workspace_id).toEqual(workspaceIdA);
              }
            } finally {
              await close();
            }
          },
        ),
        { numRuns: 50 },
      );
    },
  );
});
