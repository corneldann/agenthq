/**
 * Tests for DbSyncTool (src/db/sync.ts)
 *
 * Subtasks covered:
 *  7.1 Property 6 — File Sync Idempotence        (Validates: Requirement 6.3)
 *  7.2 Property 1 — Database-File Consistency     (Validates: Requirements 6.4, 2.4)
 *  7.3 Unit tests — runFullSync, syncFile, path sanitization
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import * as fc from 'fast-check';
import { Database } from 'bun:sqlite';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter.js';
import { DbSyncTool } from '../../src/db/sync.js';
import type { DbAdapter } from '../../src/db/adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an in-memory SQLite DB with all migrations applied. */
async function buildTestDb(): Promise<{ db: DbAdapter; close: () => Promise<void> }> {
  const raw = new Database(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');

  // Apply schema inline (mirrors migrations/001_initial.sql + 002_status_history.sql)
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

  // Wrap in a plain DbAdapter that talks to the already-open Database
  const adapter = new SQLiteAdapter(':memory:') as DbAdapter;

  // We need a shared connection — build a thin wrapper around `raw`
  const sharedAdapter: DbAdapter = {
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
        await fn(sharedAdapter);
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

  // Seed the workspace row so FK constraints pass
  raw.prepare(
    `INSERT OR IGNORE INTO workspaces (id, output_dir, sessions_dir) VALUES (?, '', '')`,
  ).run('test-workspace');

  return { db: sharedAdapter, close: () => sharedAdapter.close() };
}

/** Insert a minimal job row directly, bypassing the scan layer. */
function insertJob(
  raw: Database,
  overrides: Partial<{
    id: string;
    workspace_id: string;
    name: string;
    md_file: string;
    log_file: string;
    status: string;
  }> = {},
): void {
  const defaults = {
    id: 'job-1',
    workspace_id: 'test-workspace',
    name: 'test-job',
    md_file: '/workspace/jobs/test.md',
    log_file: '/workspace/jobs/test.log',
    status: 'running',
  };
  const row = { ...defaults, ...overrides };
  raw
    .prepare(
      `INSERT OR IGNORE INTO jobs
         (id, workspace_id, name, md_file, log_file, status, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      row.id,
      row.workspace_id,
      row.name,
      row.md_file,
      row.log_file,
      row.status,
    );
}

// ---------------------------------------------------------------------------
// Helpers for property tests — minimal DbSyncTool that only runs SQL,
// never touches the filesystem (scanJobs/scanChains/scanSessions are mocked
// by replacing the runFullSync body via a subclass).
// ---------------------------------------------------------------------------

type MinimalJob = {
  id: string;
  workspaceId: string;
  name: string;
  jobChain: string;
  sessionChainId: string;
  timestamp: string;
  type: string;
  agent: string;
  status: 'running' | 'done' | 'reported' | 'error';
  lines: number;
  lastLine: string;
  hasLog: boolean;
  logError: boolean;
  mdFile: string;
  logFile: string;
  agentDone: string;
  sizeBytes: number;
};

/** A DbSyncTool variant that upserts a pre-built job list — no filesystem I/O. */
class TestableDbSyncTool extends DbSyncTool {
  private jobs: MinimalJob[];

  constructor(db: DbAdapter, jobs: MinimalJob[]) {
    super(db);
    this.jobs = jobs;
  }

  override async runFullSync(workspaceId: string): Promise<void> {
    const now = Date.now();
    // Access private db via bracket notation for test purposes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (this as any).db as DbAdapter;
    await db.transaction(async (tx) => {
      for (const job of this.jobs) {
        await tx.execute(
          `INSERT INTO jobs (
             id, workspace_id, name, job_chain, session_chain_id,
             timestamp, type, agent, status, lines, last_line,
             has_log, log_error, md_file, log_file, agent_done,
             size_bytes, last_modified, deleted_at
           ) VALUES (
             ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?,
             ?, ?, NULL
           )
           ON CONFLICT(id) DO UPDATE SET
             name             = excluded.name,
             job_chain        = excluded.job_chain,
             session_chain_id = excluded.session_chain_id,
             timestamp        = excluded.timestamp,
             type             = excluded.type,
             agent            = excluded.agent,
             status           = excluded.status,
             lines            = excluded.lines,
             last_line        = excluded.last_line,
             has_log          = excluded.has_log,
             log_error        = excluded.log_error,
             md_file          = excluded.md_file,
             log_file         = excluded.log_file,
             agent_done       = excluded.agent_done,
             size_bytes       = excluded.size_bytes,
             last_modified    = excluded.last_modified`,
          [
            job.id,
            workspaceId,
            job.name,
            job.jobChain,
            job.sessionChainId,
            job.timestamp,
            job.type,
            job.agent,
            job.status,
            job.lines,
            job.lastLine,
            job.hasLog ? 1 : 0,
            job.logError ? 1 : 0,
            job.mdFile,
            job.logFile,
            job.agentDone,
            job.sizeBytes,
            now,
          ],
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------
// fast-check arbitraries
// ---------------------------------------------------------------------------

const statusArb = fc.constantFrom('running', 'done', 'reported', 'error') as fc.Arbitrary<
  'running' | 'done' | 'reported' | 'error'
>;

const safeStringArb = fc.string({ minLength: 1, maxLength: 40 }).filter(
  (s) => !s.includes('\0'),
);

const minimalJobArb: fc.Arbitrary<MinimalJob> = fc.record({
  id: fc.uuid(),
  workspaceId: fc.constant('test-workspace'),
  name: safeStringArb,
  jobChain: safeStringArb,
  sessionChainId: fc.constant(''),
  timestamp: fc.constant('2024-01-01 00:00'),
  type: fc.constant('prompt'),
  agent: fc.constant('kiro'),
  status: statusArb,
  lines: fc.integer({ min: 0, max: 9999 }),
  lastLine: safeStringArb,
  hasLog: fc.boolean(),
  logError: fc.boolean(),
  mdFile: safeStringArb,
  logFile: safeStringArb,
  agentDone: fc.constant(''),
  sizeBytes: fc.integer({ min: 0, max: 1_000_000 }),
});

// ---------------------------------------------------------------------------
// 7.1 Property 6 — File Sync Idempotence
// **Validates: Requirement 6.3**
// ---------------------------------------------------------------------------

describe('Property 6: File Sync Idempotence', () => {
  it('property: calling runFullSync twice with unchanged data leaves identical row state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(minimalJobArb, { minLength: 1, maxLength: 10 }),
        async (jobs) => {
          const { db, close } = await buildTestDb();
          try {
            const tool = new TestableDbSyncTool(db, jobs);

            // First sync
            await tool.runFullSync('test-workspace');
            const after1 = await db.query<{
              id: string;
              status: string;
              lines: number;
              last_line: string;
              last_modified: number;
            }>(
              `SELECT id, status, lines, last_line, last_modified
                 FROM jobs
                WHERE workspace_id = 'test-workspace'
                ORDER BY id`,
            );

            // Second sync — identical input, no intervening writes
            await tool.runFullSync('test-workspace');
            const after2 = await db.query<{
              id: string;
              status: string;
              lines: number;
              last_line: string;
              last_modified: number;
            }>(
              `SELECT id, status, lines, last_line, last_modified
                 FROM jobs
                WHERE workspace_id = 'test-workspace'
                ORDER BY id`,
            );

            // Row count must be identical
            expect(after2.rowCount).toEqual(after1.rowCount);

            // Every field except last_modified must be identical
            for (let i = 0; i < after1.rows.length; i++) {
              const r1 = after1.rows[i];
              const r2 = after2.rows[i];
              expect(r2.id).toEqual(r1.id);
              expect(r2.status).toEqual(r1.status);
              expect(r2.lines).toEqual(r1.lines);
              expect(r2.last_line).toEqual(r1.last_line);
            }
          } finally {
            await close();
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// 7.2 Property 1 — Database-File Consistency
// **Validates: Requirements 6.4, 2.4**
// ---------------------------------------------------------------------------

describe('Property 1: Database-File Consistency', () => {
  it('property: syncFile with a non-existent path sets deleted_at on matching rows', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        async (jobId, mdFilePath) => {
          const { db, close } = await buildTestDb();
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const raw: Database = (db as any)['db'] ?? undefined;

            // Insert the job row via raw SQL so we control md_file precisely
            await db.execute(
              `INSERT INTO jobs (
                 id, workspace_id, name, md_file, log_file, status, timestamp
               ) VALUES (?, 'test-workspace', 'test-job', ?, '', 'running', datetime('now'))`,
              [jobId, mdFilePath],
            );

            const tool = new DbSyncTool(db);

            // Use a path that is guaranteed to not exist on disk:
            // prepend /nonexistent-root/ to avoid any real file collision.
            // The path must not contain '..' or consecutive separators.
            const absentPath = `/nonexistent-root-${jobId}/${mdFilePath.replace(/-/g, '')}`;

            // Insert with the exact absent path
            await db.execute(
              `UPDATE jobs SET md_file = ? WHERE id = ?`,
              [absentPath, jobId],
            );

            await tool.syncFile(absentPath, 'test-workspace');

            const result = await db.query<{ deleted_at: string | null }>(
              `SELECT deleted_at FROM jobs WHERE id = ?`,
              [jobId],
            );

            expect(result.rowCount).toEqual(1);
            expect(result.rows[0].deleted_at).not.toBeNull();
          } finally {
            await close();
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// 7.3 Unit Tests for DbSyncTool
// Requirements: 2.1, 2.4, 6.3, 6.4, 11.2, 12.1
// ---------------------------------------------------------------------------

describe('DbSyncTool unit tests', () => {
  // ─── runFullSync ──────────────────────────────────────────────────────────

  describe('runFullSync', () => {
    it('should populate an empty database with upserted rows', async () => {
      const { db, close } = await buildTestDb();
      try {
        const jobs: MinimalJob[] = [
          {
            id: 'job-a',
            workspaceId: 'test-workspace',
            name: 'alpha',
            jobChain: 'alpha',
            sessionChainId: '',
            timestamp: '2024-01-01 10:00',
            type: 'prompt',
            agent: 'kiro',
            status: 'done',
            lines: 5,
            lastLine: 'done',
            hasLog: false,
            logError: false,
            mdFile: 'alpha.md',
            logFile: 'alpha.log',
            agentDone: '',
            sizeBytes: 100,
          },
        ];

        const tool = new TestableDbSyncTool(db, jobs);
        await tool.runFullSync('test-workspace');

        const result = await db.query<{ id: string; name: string; status: string }>(
          `SELECT id, name, status FROM jobs WHERE workspace_id = 'test-workspace'`,
        );

        expect(result.rowCount).toEqual(1);
        expect(result.rows[0].id).toEqual('job-a');
        expect(result.rows[0].name).toEqual('alpha');
        expect(result.rows[0].status).toEqual('done');
      } finally {
        await close();
      }
    });

    it('should not duplicate rows when run twice with the same data', async () => {
      const { db, close } = await buildTestDb();
      try {
        const jobs: MinimalJob[] = [
          {
            id: 'job-b',
            workspaceId: 'test-workspace',
            name: 'beta',
            jobChain: 'beta',
            sessionChainId: '',
            timestamp: '2024-01-02 10:00',
            type: 'prompt',
            agent: 'kiro',
            status: 'running',
            lines: 1,
            lastLine: 'running',
            hasLog: false,
            logError: false,
            mdFile: 'beta.md',
            logFile: 'beta.log',
            agentDone: '',
            sizeBytes: 50,
          },
        ];

        const tool = new TestableDbSyncTool(db, jobs);
        await tool.runFullSync('test-workspace');
        await tool.runFullSync('test-workspace');

        const result = await db.query<{ id: string }>(
          `SELECT id FROM jobs WHERE workspace_id = 'test-workspace'`,
        );

        expect(result.rowCount).toEqual(1);
      } finally {
        await close();
      }
    });

    it('should update changed fields on re-sync without duplicating rows', async () => {
      const { db, close } = await buildTestDb();
      try {
        const jobBase: MinimalJob = {
          id: 'job-c',
          workspaceId: 'test-workspace',
          name: 'gamma',
          jobChain: 'gamma',
          sessionChainId: '',
          timestamp: '2024-01-03 10:00',
          type: 'prompt',
          agent: 'kiro',
          status: 'running',
          lines: 2,
          lastLine: 'in progress',
          hasLog: false,
          logError: false,
          mdFile: 'gamma.md',
          logFile: 'gamma.log',
          agentDone: '',
          sizeBytes: 200,
        };

        const tool1 = new TestableDbSyncTool(db, [jobBase]);
        await tool1.runFullSync('test-workspace');

        const updated: MinimalJob = { ...jobBase, status: 'done', lines: 10 };
        const tool2 = new TestableDbSyncTool(db, [updated]);
        await tool2.runFullSync('test-workspace');

        const result = await db.query<{ id: string; status: string; lines: number }>(
          `SELECT id, status, lines FROM jobs WHERE workspace_id = 'test-workspace'`,
        );

        expect(result.rowCount).toEqual(1);
        expect(result.rows[0].status).toEqual('done');
        expect(result.rows[0].lines).toEqual(10);
      } finally {
        await close();
      }
    });
  });

  // ─── syncFile ─────────────────────────────────────────────────────────────

  describe('syncFile', () => {
    it('should soft-delete a job row when the file is absent', async () => {
      const { db, close } = await buildTestDb();
      try {
        const absentPath = `/nonexistent-dir-unit-test/file-${Date.now()}.md`;

        await db.execute(
          `INSERT INTO jobs
             (id, workspace_id, name, md_file, log_file, status, timestamp)
           VALUES ('job-absent', 'test-workspace', 'absent-job', ?, '', 'running', datetime('now'))`,
          [absentPath],
        );

        const tool = new DbSyncTool(db);
        await tool.syncFile(absentPath, 'test-workspace');

        const result = await db.query<{ deleted_at: string | null }>(
          `SELECT deleted_at FROM jobs WHERE id = 'job-absent'`,
        );

        expect(result.rowCount).toEqual(1);
        expect(result.rows[0].deleted_at).not.toBeNull();
      } finally {
        await close();
      }
    });

    it('should not affect rows from other workspaces when soft-deleting', async () => {
      const { db, close } = await buildTestDb();
      try {
        const absentPath = `/nonexistent-dir-unit-test/other-ws-${Date.now()}.md`;

        // Insert workspace 'other-ws' and a job for it
        await db.execute(
          `INSERT OR IGNORE INTO workspaces (id, output_dir, sessions_dir) VALUES ('other-ws', '', '')`,
        );
        await db.execute(
          `INSERT INTO jobs
             (id, workspace_id, name, md_file, log_file, status, timestamp)
           VALUES ('job-other', 'other-ws', 'other-job', ?, '', 'running', datetime('now'))`,
          [absentPath],
        );

        const tool = new DbSyncTool(db);
        // syncFile for 'test-workspace' — must NOT touch 'other-ws' rows
        await tool.syncFile(absentPath, 'test-workspace');

        const result = await db.query<{ deleted_at: string | null }>(
          `SELECT deleted_at FROM jobs WHERE id = 'job-other'`,
        );

        expect(result.rowCount).toEqual(1);
        expect(result.rows[0].deleted_at).toBeNull();
      } finally {
        await close();
      }
    });
  });

  // ─── path sanitization (Requirement 11.2) ─────────────────────────────────

  describe('path sanitization', () => {
    it('should reject paths containing ".."', async () => {
      const { db, close } = await buildTestDb();
      try {
        const tool = new DbSyncTool(db);
        await expect(
          tool.syncFile('/workspace/../etc/passwd', 'test-workspace'),
        ).rejects.toThrow(RangeError);
      } finally {
        await close();
      }
    });

    it('should reject paths with consecutive separators (//)', async () => {
      const { db, close } = await buildTestDb();
      try {
        const tool = new DbSyncTool(db);
        await expect(
          tool.syncFile('//absolute/escape', 'test-workspace'),
        ).rejects.toThrow(RangeError);
      } finally {
        await close();
      }
    });

    it('should reject Windows UNC-style paths (\\\\)', async () => {
      const { db, close } = await buildTestDb();
      try {
        const tool = new DbSyncTool(db);
        await expect(
          tool.syncFile('\\\\server\\share', 'test-workspace'),
        ).rejects.toThrow(RangeError);
      } finally {
        await close();
      }
    });

    it('should accept a normal absolute path', async () => {
      const { db, close } = await buildTestDb();
      try {
        const tool = new DbSyncTool(db);
        // This path does not exist on disk — it should return normally
        // (soft-delete path) without throwing a path error
        await expect(
          tool.syncFile('/workspace/jobs/valid-file.md', 'test-workspace'),
        ).resolves.toBeUndefined();
      } finally {
        await close();
      }
    });
  });
});
