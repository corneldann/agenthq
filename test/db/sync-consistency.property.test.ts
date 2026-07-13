/**
 * Property-Based Tests for Database-File Consistency (Property 1)
 *
 * Verifies that `DbSyncTool.syncFile()` satisfies the consistency invariant
 * described in Requirements 6.4 and 2.4:
 *
 *   IF a database record exists but the source file is missing,
 *   THEN `syncFile(path)` MUST set `deleted_at` to a non-null timestamp
 *   (soft delete) within the same call.
 *
 * Three sub-properties are tested:
 *
 *   1a. **Single-record soft delete** — after `syncFile(absent-path)`,
 *       the single matching job row has `deleted_at IS NOT NULL`.
 *
 *   1b. **Multi-record soft delete** — all rows sharing the same absent
 *       `md_file` path are soft-deleted in one call; no live rows remain.
 *
 *   1c. **Workspace isolation** — rows belonging to a different workspace
 *       are never soft-deleted even if they share the same file path.
 *
 * **Validates: Requirements 6.4, 2.4**
 */

import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import * as os from 'os';
import * as path from 'path';
import { Database } from 'bun:sqlite';
import { DbSyncTool } from '../../src/db/sync.js';
import type { DbAdapter } from '../../src/db/adapter.js';

// ---------------------------------------------------------------------------
// In-memory database builder — matches the pattern from sync.property.test.ts
// ---------------------------------------------------------------------------

/**
 * Build a fresh in-memory SQLite DB with the full schema applied and a
 * seeded `test-workspace` row so FK constraints pass.
 *
 * Returns a thin `DbAdapter` wrapper and a `close()` function.
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

  // Seed required workspace rows so FK constraints pass.
  raw.prepare(
    `INSERT OR IGNORE INTO workspaces (id, output_dir, sessions_dir) VALUES (?, '', '')`,
  ).run('test-workspace');

  raw.prepare(
    `INSERT OR IGNORE INTO workspaces (id, output_dir, sessions_dir) VALUES (?, '', '')`,
  ).run('other-workspace');

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
// Path helpers — generate confirmed-absent paths without path traversal
// ---------------------------------------------------------------------------

/**
 * Build a guaranteed-absent file path from a UUID-like token.
 *
 * The path uses the OS temp dir as a stable root so the path is absolute and
 * safe, but the subdirectory is unique per test run so the file never exists.
 * The token has hyphens stripped to avoid any accidental `..` sequences.
 */
function absentPathFor(token: string): string {
  const safe = token.replace(/-/g, '');
  return path.join(os.tmpdir(), `consistency-prop-absent-${safe}`, 'job.md');
}

// ---------------------------------------------------------------------------
// Property 1a — Single-record soft delete
// **Validates: Requirements 6.4, 2.4**
// ---------------------------------------------------------------------------

describe('Property 1: Database-File Consistency', () => {
  it(
    'property: syncFile with a confirmed-absent path sets deleted_at IS NOT NULL on the matching job row',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(), // arbitrary job ID
          async (jobId) => {
            const { db, close } = buildTestDb();

            const absent = absentPathFor(jobId);

            try {
              // Pre-insert a job row whose md_file points to the absent path.
              await db.execute(
                `INSERT INTO jobs
                   (id, workspace_id, name, md_file, log_file, status, timestamp)
                 VALUES (?, 'test-workspace', 'test-job', ?, '', 'running', datetime('now'))`,
                [jobId, absent],
              );

              const tool = new DbSyncTool(db);
              await tool.syncFile(absent, 'test-workspace');

              const result = await db.query<{ deleted_at: string | null }>(
                `SELECT deleted_at FROM jobs WHERE id = ?`,
                [jobId],
              );

              // Row must still exist — soft delete, not hard delete.
              expect(result.rowCount).toEqual(1);
              // deleted_at must be set to a non-null timestamp.
              expect(result.rows[0]!.deleted_at).not.toBeNull();
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
  // Property 1b — Multi-record soft delete
  // After syncFile on an absent path, ALL live rows for that path are marked.
  // **Validates: Requirements 6.4, 2.4**
  // -------------------------------------------------------------------------

  it(
    'property: syncFile with a confirmed-absent path soft-deletes every live job row matching that path',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(),                            // base token for the path
          fc.integer({ min: 1, max: 5 }),       // arbitrary number of matching rows
          async (baseToken, rowCount) => {
            const { db, close } = buildTestDb();

            const absent = absentPathFor(baseToken);

            try {
              // Insert multiple job rows all sharing the same absent md_file.
              for (let i = 0; i < rowCount; i++) {
                const rowId = `${baseToken.replace(/-/g, '')}-${i}`;
                await db.execute(
                  `INSERT INTO jobs
                     (id, workspace_id, name, md_file, log_file, status, timestamp)
                   VALUES (?, 'test-workspace', 'job', ?, '', 'running', datetime('now'))`,
                  [rowId, absent],
                );
              }

              const tool = new DbSyncTool(db);
              await tool.syncFile(absent, 'test-workspace');

              // All rows must now have deleted_at set — zero live rows remain.
              const liveRows = await db.query<{ id: string }>(
                `SELECT id FROM jobs
                  WHERE workspace_id = 'test-workspace'
                    AND md_file = ?
                    AND deleted_at IS NULL`,
                [absent],
              );

              expect(liveRows.rowCount).toEqual(0);

              // Total row count is unchanged — soft delete, not hard delete.
              const allRows = await db.query<{ id: string }>(
                `SELECT id FROM jobs
                  WHERE workspace_id = 'test-workspace'
                    AND md_file = ?`,
                [absent],
              );

              expect(allRows.rowCount).toEqual(rowCount);
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
  // Property 1c — Workspace isolation
  // syncFile must never soft-delete rows belonging to a different workspace.
  // **Validates: Requirements 6.4, 2.4**
  // -------------------------------------------------------------------------

  it(
    'property: syncFile only soft-deletes rows in the target workspace, leaving other-workspace rows untouched',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(), // job ID for target workspace
          fc.uuid(), // job ID for other workspace
          async (targetJobId, otherJobId) => {
            const { db, close } = buildTestDb();

            const absent = absentPathFor(targetJobId);

            try {
              // Insert a job in the target workspace.
              await db.execute(
                `INSERT INTO jobs
                   (id, workspace_id, name, md_file, log_file, status, timestamp)
                 VALUES (?, 'test-workspace', 'target-job', ?, '', 'running', datetime('now'))`,
                [targetJobId, absent],
              );

              // Insert a job in the other workspace sharing the same file path.
              await db.execute(
                `INSERT INTO jobs
                   (id, workspace_id, name, md_file, log_file, status, timestamp)
                 VALUES (?, 'other-workspace', 'other-job', ?, '', 'running', datetime('now'))`,
                [otherJobId, absent],
              );

              const tool = new DbSyncTool(db);
              // Sync only for 'test-workspace' — must NOT affect 'other-workspace'.
              await tool.syncFile(absent, 'test-workspace');

              // Target workspace row must be soft-deleted.
              const targetResult = await db.query<{ deleted_at: string | null }>(
                `SELECT deleted_at FROM jobs WHERE id = ?`,
                [targetJobId],
              );

              expect(targetResult.rowCount).toEqual(1);
              expect(targetResult.rows[0]!.deleted_at).not.toBeNull();

              // Other-workspace row must remain live.
              const otherResult = await db.query<{ deleted_at: string | null }>(
                `SELECT deleted_at FROM jobs WHERE id = ?`,
                [otherJobId],
              );

              expect(otherResult.rowCount).toEqual(1);
              expect(otherResult.rows[0]!.deleted_at).toBeNull();
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
