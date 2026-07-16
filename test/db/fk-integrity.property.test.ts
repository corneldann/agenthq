/**
 * Property-Based Tests for Foreign Key Integrity (Property 3)
 *
 * Verifies that the database enforces referential integrity between the
 * jobs, chains, and sessions tables and the workspaces table, as required
 * by Requirement 1.5:
 *
 *   THE Database_Schema SHALL define foreign key constraints between
 *   jobs/chains/sessions and their workspaces.
 *
 * Property 3 (from design.md):
 *   For any insert or upsert into jobs, chains, or sessions, the operation
 *   MUST reference a workspace_id that already exists in the workspaces
 *   table; the database MUST reject any insert that violates this constraint
 *   via `FOREIGN KEY ON DELETE CASCADE`.
 *
 * Three sub-properties are tested:
 *
 *   3a. **Jobs FK rejection** — inserting a job with an arbitrary random
 *       workspace_id (without a prior workspace row) is always rejected.
 *
 *   3b. **Chains FK rejection** — inserting a chain with an arbitrary random
 *       workspace_id (without a prior workspace row) is always rejected.
 *
 *   3c. **Sessions FK rejection** — inserting a session with an arbitrary
 *       random workspace_id (without a prior workspace row) is always rejected.
 *
 * A positive "happy path" is also verified:
 *
 *   3d. **Valid workspace_id succeeds** — after inserting the workspace row,
 *       inserts into all three tables are accepted.
 *
 * **Validates: Requirements 1.5**
 */

import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import { Database } from 'bun:sqlite';
import type { DbAdapter } from '../../src/db/adapter.js';

// ---------------------------------------------------------------------------
// In-memory database builder
// ---------------------------------------------------------------------------

/**
 * Build a fresh in-memory SQLite DB with the full schema (jobs, chains,
 * sessions referencing workspaces) and foreign keys enabled.
 *
 * WAL mode is intentionally skipped — in-memory databases do not support WAL.
 * Foreign keys MUST be ON for the property under test to be observable.
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
    );
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

/**
 * Generates arbitrary workspace_id strings that will never be pre-inserted
 * into the workspaces table, guaranteeing every generated value is orphaned.
 *
 * UUIDs are used to avoid accidental collisions with any pre-seeded row.
 */
const orphanWorkspaceIdArb = fc.uuid();

/**
 * Generates arbitrary job IDs (UUIDs) — unique per trial so there are no
 * duplicate-PK conflicts across the property runs.
 */
const jobIdArb = fc.uuid();

/** Arbitrary chain IDs and workflow hashes for sessions. */
const chainIdArb = fc.uuid();
const workflowHashArb = fc.uuid();

// ---------------------------------------------------------------------------
// Property 3a — Jobs FK rejection
// **Validates: Requirements 1.5**
// ---------------------------------------------------------------------------

describe('Property 3: Foreign Key Integrity', () => {
  it(
    'property: inserting a job with a non-existent workspace_id is always rejected',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          jobIdArb,
          orphanWorkspaceIdArb,
          async (jobId, orphanWorkspaceId) => {
            const { db, close } = buildTestDb();
            // No workspace row inserted — any workspace_id must be rejected.
            try {
              await expect(
                db.execute(
                  `INSERT INTO jobs (id, workspace_id, name, timestamp, status)
                   VALUES (?, ?, 'test-job', datetime('now'), 'running')`,
                  [jobId, orphanWorkspaceId],
                ),
              ).rejects.toThrow();

              // The rejected insert must leave zero rows in jobs.
              const result = await db.query<{ id: string }>(
                `SELECT id FROM jobs WHERE id = ?`,
                [jobId],
              );
              expect(result.rowCount).toEqual(0);
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
  // Property 3b — Chains FK rejection
  // **Validates: Requirements 1.5**
  // -------------------------------------------------------------------------

  it(
    'property: inserting a chain with a non-existent workspace_id is always rejected',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          chainIdArb,
          orphanWorkspaceIdArb,
          async (chainId, orphanWorkspaceId) => {
            const { db, close } = buildTestDb();
            try {
              await expect(
                db.execute(
                  `INSERT INTO chains (chain_id, workspace_id, created_at, last_active_at)
                   VALUES (?, ?, datetime('now'), datetime('now'))`,
                  [chainId, orphanWorkspaceId],
                ),
              ).rejects.toThrow();

              const result = await db.query<{ chain_id: string }>(
                `SELECT chain_id FROM chains WHERE chain_id = ?`,
                [chainId],
              );
              expect(result.rowCount).toEqual(0);
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
  // Property 3c — Sessions FK rejection
  // **Validates: Requirements 1.5**
  // -------------------------------------------------------------------------

  it(
    'property: inserting a session with a non-existent workspace_id is always rejected',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          chainIdArb,
          workflowHashArb,
          orphanWorkspaceIdArb,
          async (chainId, workflowHash, orphanWorkspaceId) => {
            const { db, close } = buildTestDb();
            try {
              await expect(
                db.execute(
                  `INSERT INTO sessions (chain_id, workspace_id, workflow_hash, last_message_at)
                   VALUES (?, ?, ?, datetime('now'))`,
                  [chainId, orphanWorkspaceId, workflowHash],
                ),
              ).rejects.toThrow();

              const result = await db.query<{ chain_id: string }>(
                `SELECT chain_id FROM sessions WHERE chain_id = ? AND workflow_hash = ?`,
                [chainId, workflowHash],
              );
              expect(result.rowCount).toEqual(0);
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
  // Property 3d — Valid workspace_id succeeds for all three tables
  // Positive case: confirms the constraint is tight (not broken/always-fail).
  // **Validates: Requirements 1.5**
  // -------------------------------------------------------------------------

  it(
    'property: inserts into jobs, chains, and sessions succeed when workspace_id exists',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(), // workspace ID
          jobIdArb,
          chainIdArb,
          workflowHashArb,
          async (workspaceId, jobId, chainId, workflowHash) => {
            const { db, close } = buildTestDb();
            try {
              // Pre-insert the workspace so FK constraints are satisfied.
              await db.execute(
                `INSERT INTO workspaces (id, output_dir, sessions_dir)
                 VALUES (?, '/out', '/sessions')`,
                [workspaceId],
              );

              // Insert a job — must succeed.
              await db.execute(
                `INSERT INTO jobs (id, workspace_id, name, timestamp, status)
                 VALUES (?, ?, 'valid-job', datetime('now'), 'running')`,
                [jobId, workspaceId],
              );

              // Insert a chain — must succeed.
              await db.execute(
                `INSERT INTO chains (chain_id, workspace_id, created_at, last_active_at)
                 VALUES (?, ?, datetime('now'), datetime('now'))`,
                [chainId, workspaceId],
              );

              // Insert a session — must succeed.
              await db.execute(
                `INSERT INTO sessions (chain_id, workspace_id, workflow_hash, last_message_at)
                 VALUES (?, ?, ?, datetime('now'))`,
                [chainId, workspaceId, workflowHash],
              );

              // Verify all three rows were accepted.
              const jobResult = await db.query<{ id: string }>(
                `SELECT id FROM jobs WHERE id = ? AND workspace_id = ?`,
                [jobId, workspaceId],
              );
              expect(jobResult.rowCount).toEqual(1);

              const chainResult = await db.query<{ chain_id: string }>(
                `SELECT chain_id FROM chains WHERE chain_id = ? AND workspace_id = ?`,
                [chainId, workspaceId],
              );
              expect(chainResult.rowCount).toEqual(1);

              const sessionResult = await db.query<{ chain_id: string }>(
                `SELECT chain_id FROM sessions
                  WHERE chain_id = ? AND workspace_id = ? AND workflow_hash = ?`,
                [chainId, workspaceId, workflowHash],
              );
              expect(sessionResult.rowCount).toEqual(1);
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
