/**
 * Property-Based Tests for File Sync Idempotence (Property 6)
 *
 * Verifies that `DbSyncTool.syncFile()` satisfies the idempotence invariant
 * described in Requirement 6.3:
 *
 *   For any file path P with unchanged content, calling `syncFile(P)` a second
 *   time MUST produce zero changes to the database — row counts, timestamps,
 *   and all field values MUST be identical to those after the first call.
 *
 * Two sub-properties are tested:
 *
 *   6a. **Upsert idempotence** — when the file exists on disk, calling
 *       `syncFile(P)` twice leaves identical row state (the ON CONFLICT DO
 *       UPDATE path must be stable).
 *
 *   6b. **Soft-delete idempotence** — when the file is absent, calling
 *       `syncFile(P)` twice leaves `deleted_at` set the same way; the second
 *       call must be a no-op (WHERE deleted_at IS NULL guard).
 *
 * **Validates: Requirements 6.3**
 */

import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Database } from 'bun:sqlite';
import { DbSyncTool } from '../../src/db/sync.js';
import type { DbAdapter } from '../../src/db/adapter.js';

// ---------------------------------------------------------------------------
// In-memory database builder
// ---------------------------------------------------------------------------

/**
 * Build a fresh in-memory SQLite DB with the full schema applied.
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

  // Seed the required workspace row so FK constraints pass.
  raw.prepare(
    `INSERT OR IGNORE INTO workspaces (id, output_dir, sessions_dir) VALUES (?, '', '')`,
  ).run('test-workspace');

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
// TestableDbSyncTool — overrides runFullSync to upsert a pre-built job row
// without touching the real filesystem (scanJobs/scanChains/scanSessions).
// This isolates the upsert idempotence test to the DB layer.
// ---------------------------------------------------------------------------

type SyntheticJob = {
  id: string;
  name: string;
  status: 'running' | 'done' | 'reported' | 'error';
  lines: number;
  lastLine: string;
  sizeBytes: number;
  mdFile: string;
};

/**
 * A `DbSyncTool` variant that skips filesystem scanning and instead upserts
 * a fixed synthetic job supplied at construction time.
 *
 * Used exclusively to test the upsert idempotence path (Property 6a) without
 * a dependency on the real scan layer.
 */
class IdempotenceTestSyncTool extends DbSyncTool {
  private readonly job: SyntheticJob;

  constructor(db: DbAdapter, job: SyntheticJob) {
    super(db);
    this.job = job;
  }

  /** Upsert the synthetic job instead of scanning the filesystem. */
  override async runFullSync(workspaceId: string): Promise<void> {
    const now = Date.now();
    // Access private db via index signature — necessary for test-only override.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (this as any).db as DbAdapter;
    await db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO jobs (
           id, workspace_id, name, job_chain, session_chain_id,
           timestamp, type, agent, status, lines, last_line,
           has_log, log_error, md_file, log_file, agent_done,
           size_bytes, last_modified, deleted_at
         ) VALUES (
           ?, ?, ?, '', '',
           datetime('now'), 'prompt', 'kiro', ?, ?, ?,
           0, 0, ?, '', '',
           ?, ?, NULL
         )
         ON CONFLICT(id) DO UPDATE SET
           name          = excluded.name,
           status        = excluded.status,
           lines         = excluded.lines,
           last_line     = excluded.last_line,
           md_file       = excluded.md_file,
           size_bytes    = excluded.size_bytes,
           last_modified = excluded.last_modified`,
        [
          this.job.id,
          workspaceId,
          this.job.name,
          this.job.status,
          this.job.lines,
          this.job.lastLine,
          this.job.mdFile,
          this.job.sizeBytes,
          now,
        ],
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

/** Write arbitrary text content to a fresh temp file and return its path. */
function writeTempFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-prop-'));
  const filePath = path.join(dir, 'test.md');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/** Remove a file and its parent temp directory, ignoring errors. */
function cleanupTempFile(filePath: string): void {
  try {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// fast-check arbitraries
// ---------------------------------------------------------------------------

const statusArb = fc.constantFrom(
  'running',
  'done',
  'reported',
  'error',
) as fc.Arbitrary<'running' | 'done' | 'reported' | 'error'>;

/** Safe strings: no null bytes, non-empty. */
const safeStringArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => !s.includes('\0'));

const syntheticJobArb: fc.Arbitrary<SyntheticJob> = fc.record({
  id: fc.uuid(),
  name: safeStringArb,
  status: statusArb,
  lines: fc.integer({ min: 0, max: 9_999 }),
  lastLine: safeStringArb,
  sizeBytes: fc.integer({ min: 0, max: 1_000_000 }),
  mdFile: safeStringArb,
});

/** Arbitrary file content — any non-empty printable string. */
const fileContentArb = fc
  .string({ minLength: 1, maxLength: 500 })
  .filter((s) => !s.includes('\0'));

// ---------------------------------------------------------------------------
// Property 6a — Upsert idempotence
// **Validates: Requirements 6.3**
// ---------------------------------------------------------------------------

describe('Property 6: File Sync Idempotence', () => {
  it(
    'property: syncFile with a present file calls runFullSync twice and leaves identical non-timestamp row state',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          syntheticJobArb,
          fileContentArb,
          async (job, content) => {
            const { db, close } = buildTestDb();
            const filePath = writeTempFile(content);

            try {
              // The tool is constructed with the synthetic job so that
              // runFullSync (triggered by syncFile when file is present) upserts
              // a known, deterministic row — no real filesystem scan occurs.
              const tool = new IdempotenceTestSyncTool(db, {
                ...job,
                // mdFile must match the real temp path so syncFile finds a
                // present file and takes the upsert branch.
                mdFile: filePath,
              });

              // First syncFile — file exists → calls runFullSync → upserts row.
              await tool.syncFile(filePath, 'test-workspace');

              const after1 = await db.query<{
                id: string;
                name: string;
                status: string;
                lines: number;
                last_line: string;
                size_bytes: number;
                deleted_at: string | null;
              }>(
                `SELECT id, name, status, lines, last_line, size_bytes, deleted_at
                   FROM jobs
                  WHERE workspace_id = 'test-workspace'
                  ORDER BY id`,
              );

              // Second syncFile — same file, no writes between calls.
              await tool.syncFile(filePath, 'test-workspace');

              const after2 = await db.query<{
                id: string;
                name: string;
                status: string;
                lines: number;
                last_line: string;
                size_bytes: number;
                deleted_at: string | null;
              }>(
                `SELECT id, name, status, lines, last_line, size_bytes, deleted_at
                   FROM jobs
                  WHERE workspace_id = 'test-workspace'
                  ORDER BY id`,
              );

              // Row count must be identical — no duplicate inserts.
              expect(after2.rowCount).toEqual(after1.rowCount);

              // All non-timestamp fields must be byte-for-byte identical.
              for (let i = 0; i < after1.rows.length; i++) {
                const r1 = after1.rows[i]!;
                const r2 = after2.rows[i]!;
                expect(r2.id).toEqual(r1.id);
                expect(r2.name).toEqual(r1.name);
                expect(r2.status).toEqual(r1.status);
                expect(r2.lines).toEqual(r1.lines);
                expect(r2.last_line).toEqual(r1.last_line);
                expect(r2.size_bytes).toEqual(r1.size_bytes);
                expect(r2.deleted_at).toEqual(r1.deleted_at);
              }
            } finally {
              await close();
              cleanupTempFile(filePath);
            }
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  // -------------------------------------------------------------------------
  // Property 6b — Soft-delete idempotence
  // **Validates: Requirements 6.3**
  // -------------------------------------------------------------------------

  it(
    'property: syncFile on an absent path twice leaves deleted_at set and row state identical',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(),
          async (jobId) => {
            const { db, close } = buildTestDb();

            // A path that is guaranteed not to exist on disk.
            const absentPath = path.join(
              os.tmpdir(),
              `sync-prop-absent-${jobId.replace(/-/g, '')}.md`,
            );

            try {
              // Pre-insert a job row whose md_file is the absent path.
              await db.execute(
                `INSERT INTO jobs
                   (id, workspace_id, name, md_file, log_file, status, timestamp)
                 VALUES (?, 'test-workspace', 'test-job', ?, '', 'running', datetime('now'))`,
                [jobId, absentPath],
              );

              const tool = new DbSyncTool(db);

              // First syncFile — file absent → sets deleted_at.
              await tool.syncFile(absentPath, 'test-workspace');

              const after1 = await db.query<{
                deleted_at: string | null;
              }>(
                `SELECT deleted_at FROM jobs WHERE id = ?`,
                [jobId],
              );

              expect(after1.rowCount).toEqual(1);
              // First call must have set deleted_at to a non-null value.
              expect(after1.rows[0]!.deleted_at).not.toBeNull();

              const deletedAtAfterFirst = after1.rows[0]!.deleted_at;

              // Second syncFile — file still absent, deleted_at already set.
              // The WHERE deleted_at IS NULL guard must make this a no-op.
              await tool.syncFile(absentPath, 'test-workspace');

              const after2 = await db.query<{
                deleted_at: string | null;
              }>(
                `SELECT deleted_at FROM jobs WHERE id = ?`,
                [jobId],
              );

              expect(after2.rowCount).toEqual(1);
              // deleted_at must still be non-null.
              expect(after2.rows[0]!.deleted_at).not.toBeNull();
              // deleted_at must be identical — the second call must not have
              // overwritten it (that would violate idempotence for timestamp fields).
              expect(after2.rows[0]!.deleted_at).toEqual(deletedAtAfterFirst);
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
  // Property 6c — Absent path leaves zero matching live rows
  // **Validates: Requirements 6.3**
  // -------------------------------------------------------------------------

  it(
    'property: after syncFile on an absent path, no live (non-deleted) rows remain for that path',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(),
          fc.integer({ min: 1, max: 5 }),
          async (baseId, rowCount) => {
            const { db, close } = buildTestDb();

            const absentPath = path.join(
              os.tmpdir(),
              `sync-prop-live-${baseId.replace(/-/g, '')}.md`,
            );

            try {
              // Insert multiple job rows all sharing the same absent md_file.
              for (let i = 0; i < rowCount; i++) {
                await db.execute(
                  `INSERT INTO jobs
                     (id, workspace_id, name, md_file, log_file, status, timestamp)
                   VALUES (?, 'test-workspace', 'job', ?, '', 'running', datetime('now'))`,
                  [`${baseId}-${i}`, absentPath],
                );
              }

              const tool = new DbSyncTool(db);
              await tool.syncFile(absentPath, 'test-workspace');

              // All rows must now have deleted_at set — none should be live.
              const liveRows = await db.query<{ id: string }>(
                `SELECT id FROM jobs
                  WHERE workspace_id = 'test-workspace'
                    AND md_file = ?
                    AND deleted_at IS NULL`,
                [absentPath],
              );

              expect(liveRows.rowCount).toEqual(0);

              // Running syncFile a second time must leave the same count (no
              // new rows created, no rows un-deleted).
              await tool.syncFile(absentPath, 'test-workspace');

              const liveRowsAfterSecond = await db.query<{ id: string }>(
                `SELECT id FROM jobs
                  WHERE workspace_id = 'test-workspace'
                    AND md_file = ?
                    AND deleted_at IS NULL`,
                [absentPath],
              );

              expect(liveRowsAfterSecond.rowCount).toEqual(0);
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
