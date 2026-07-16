/**
 * Unit tests for DbAdapter operations against the full schema.
 *
 * Each test runs against an in-memory SQLite database (`:memory:`) with the
 * full schema applied via setupSchema(). The SQLiteAdapter is used as the
 * concrete implementation behind the DbAdapter interface.
 *
 * Requirements: 1.5, 12.1
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter';
import type { DbAdapter, DbJob, DbJobStatusHistory } from '../../src/db/adapter';

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

/**
 * Apply the full production schema to an in-memory adapter.
 *
 * PRAGMA foreign_keys is already ON from the SQLiteAdapter constructor.
 * WAL is intentionally skipped — in-memory DBs do not support WAL.
 */
async function setupSchema(adapter: DbAdapter): Promise<void> {
  // --- 001_initial.sql tables ---
  await adapter.execute(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version        INTEGER PRIMARY KEY,
      applied_at     TEXT    NOT NULL,
      migration_name TEXT    NOT NULL
    )
  `);

  await adapter.execute(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id           TEXT PRIMARY KEY,
      output_dir   TEXT NOT NULL,
      sessions_dir TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  await adapter.execute(`
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

  await adapter.execute(`
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

  await adapter.execute(`
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

  // --- 002_status_history.sql ---
  await adapter.execute(`
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
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Insert a workspace row. All tests that insert jobs must call this first. */
async function insertWorkspace(
  adapter: DbAdapter,
  id: string,
  outputDir = '/out',
  sessionsDir = '/sessions',
): Promise<void> {
  await adapter.execute(
    `INSERT INTO workspaces (id, output_dir, sessions_dir) VALUES (?, ?, ?)`,
    [id, outputDir, sessionsDir],
  );
}

/** Minimal required fields for a job row. */
type JobFixture = Pick<DbJob, 'id' | 'workspace_id' | 'name' | 'timestamp' | 'status'>;

async function insertJob(adapter: DbAdapter, job: JobFixture): Promise<void> {
  await adapter.execute(
    `INSERT INTO jobs (id, workspace_id, name, timestamp, status) VALUES (?, ?, ?, ?, ?)`,
    [job.id, job.workspace_id, job.name, job.timestamp, job.status],
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('DbAdapter — full schema operations', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = new SQLiteAdapter(':memory:');
    await setupSchema(adapter);
  });

  afterEach(async () => {
    try {
      await adapter.close();
    } catch {
      // Already closed in the test — fine.
    }
  });

  // -------------------------------------------------------------------------
  // 1. Insert job row
  // -------------------------------------------------------------------------

  it('should insert a workspace then a job row with rowsAffected === 1', async () => {
    // Arrange
    await insertWorkspace(adapter, 'ws-1');

    // Act
    const result = await adapter.execute(
      `INSERT INTO jobs (id, workspace_id, name, timestamp, status) VALUES (?, ?, ?, ?, ?)`,
      ['job-1', 'ws-1', 'My Job', '2024-01-01T00:00:00Z', 'running'],
    );

    // Assert
    expect(result.rowsAffected).toBe(1);
    // TEXT primary key — lastInsertRowid is the internal rowid (bun:sqlite returns it even for TEXT PKs)
    expect(result.lastInsertRowid).toBeDefined();
  });

  it('should query back an inserted job with correct fields', async () => {
    // Arrange
    await insertWorkspace(adapter, 'ws-1');
    await insertJob(adapter, {
      id: 'job-1',
      workspace_id: 'ws-1',
      name: 'Alpha Job',
      timestamp: '2024-03-15T12:00:00Z',
      status: 'running',
    });

    // Act
    const result = await adapter.query<DbJob>(
      `SELECT * FROM jobs WHERE id = ?`,
      ['job-1'],
    );

    // Assert
    expect(result.rowCount).toBe(1);
    const row = result.rows[0]!;
    expect(row.id).toBe('job-1');
    expect(row.workspace_id).toBe('ws-1');
    expect(row.name).toBe('Alpha Job');
    expect(row.status).toBe('running');
    expect(row.deleted_at).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 2. Update status
  // -------------------------------------------------------------------------

  it('should update a job status and read back the new value', async () => {
    // Arrange
    await insertWorkspace(adapter, 'ws-1');
    await insertJob(adapter, {
      id: 'job-2',
      workspace_id: 'ws-1',
      name: 'Status Job',
      timestamp: '2024-01-01T00:00:00Z',
      status: 'running',
    });

    // Act
    const updateResult = await adapter.execute(
      `UPDATE jobs SET status = ? WHERE id = ?`,
      ['done', 'job-2'],
    );

    // Assert — update affected exactly one row
    expect(updateResult.rowsAffected).toBe(1);

    const queryResult = await adapter.query<Pick<DbJob, 'status'>>(
      `SELECT status FROM jobs WHERE id = ?`,
      ['job-2'],
    );
    expect(queryResult.rows[0]?.status).toBe('done');
  });

  // -------------------------------------------------------------------------
  // 3. Query by workspace + status
  // -------------------------------------------------------------------------

  it('should return only the jobs matching a given workspace_id and status', async () => {
    // Arrange — 3 jobs: 2 running in ws-a, 1 done in ws-a
    await insertWorkspace(adapter, 'ws-a');
    await insertJob(adapter, { id: 'j1', workspace_id: 'ws-a', name: 'A1', timestamp: '2024-01-01T00:00:00Z', status: 'running' });
    await insertJob(adapter, { id: 'j2', workspace_id: 'ws-a', name: 'A2', timestamp: '2024-01-02T00:00:00Z', status: 'running' });
    await insertJob(adapter, { id: 'j3', workspace_id: 'ws-a', name: 'A3', timestamp: '2024-01-03T00:00:00Z', status: 'done' });

    // Act
    const result = await adapter.query<DbJob>(
      `SELECT * FROM jobs WHERE workspace_id = ? AND status = ? AND deleted_at IS NULL`,
      ['ws-a', 'running'],
    );

    // Assert
    expect(result.rowCount).toBe(2);
    for (const row of result.rows) {
      expect(row.workspace_id).toBe('ws-a');
      expect(row.status).toBe('running');
    }
  });

  // -------------------------------------------------------------------------
  // 4. Soft-delete
  // -------------------------------------------------------------------------

  it('should hide a soft-deleted job when filtering deleted_at IS NULL', async () => {
    // Arrange
    await insertWorkspace(adapter, 'ws-1');
    await insertJob(adapter, { id: 'job-del', workspace_id: 'ws-1', name: 'Del Job', timestamp: '2024-01-01T00:00:00Z', status: 'running' });

    // Act — soft-delete
    await adapter.execute(
      `UPDATE jobs SET deleted_at = datetime('now') WHERE id = ?`,
      ['job-del'],
    );

    // Assert — filtered query returns 0 rows
    const filteredResult = await adapter.query<DbJob>(
      `SELECT * FROM jobs WHERE deleted_at IS NULL AND id = ?`,
      ['job-del'],
    );
    expect(filteredResult.rowCount).toBe(0);
  });

  it('should return a soft-deleted job when querying without deleted_at filter', async () => {
    // Arrange
    await insertWorkspace(adapter, 'ws-1');
    await insertJob(adapter, { id: 'job-del', workspace_id: 'ws-1', name: 'Del Job', timestamp: '2024-01-01T00:00:00Z', status: 'running' });
    await adapter.execute(
      `UPDATE jobs SET deleted_at = datetime('now') WHERE id = ?`,
      ['job-del'],
    );

    // Act
    const unfilteredResult = await adapter.query<DbJob>(
      `SELECT * FROM jobs WHERE id = ?`,
      ['job-del'],
    );

    // Assert — row exists, deleted_at is non-null
    expect(unfilteredResult.rowCount).toBe(1);
    expect(unfilteredResult.rows[0]?.deleted_at).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 5. Aggregate count
  // -------------------------------------------------------------------------

  it('should aggregate job counts by status within a workspace', async () => {
    // Arrange — 2 running, 1 done
    await insertWorkspace(adapter, 'ws-agg');
    await insertJob(adapter, { id: 'a1', workspace_id: 'ws-agg', name: 'Agg1', timestamp: '2024-01-01T00:00:00Z', status: 'running' });
    await insertJob(adapter, { id: 'a2', workspace_id: 'ws-agg', name: 'Agg2', timestamp: '2024-01-02T00:00:00Z', status: 'running' });
    await insertJob(adapter, { id: 'a3', workspace_id: 'ws-agg', name: 'Agg3', timestamp: '2024-01-03T00:00:00Z', status: 'done' });

    // Act
    const result = await adapter.query<{ status: string; count: number }>(
      `SELECT status, COUNT(*) as count FROM jobs WHERE workspace_id = ? AND deleted_at IS NULL GROUP BY status ORDER BY status`,
      ['ws-agg'],
    );

    // Assert
    expect(result.rowCount).toBe(2);

    const byStatus = Object.fromEntries(result.rows.map((r) => [r.status, r.count]));
    expect(byStatus['running']).toBe(2);
    expect(byStatus['done']).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 6. FK constraint rejects unknown workspace_id
  // -------------------------------------------------------------------------

  it('should reject an INSERT with a non-existent workspace_id due to FK constraint', async () => {
    // Arrange — no workspace row inserted
    // Act + Assert
    await expect(
      adapter.execute(
        `INSERT INTO jobs (id, workspace_id, name, timestamp, status) VALUES (?, ?, ?, ?, ?)`,
        ['orphan-job', 'nonexistent-ws', 'Orphan', '2024-01-01T00:00:00Z', 'running'],
      ),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // 7. Job status history insert + query
  // -------------------------------------------------------------------------

  it('should insert a job_status_history row and query it back with all fields', async () => {
    // Arrange
    await insertWorkspace(adapter, 'ws-hist');
    await insertJob(adapter, { id: 'job-hist', workspace_id: 'ws-hist', name: 'Hist Job', timestamp: '2024-01-01T00:00:00Z', status: 'running' });

    // Act
    const insertResult = await adapter.execute(
      `INSERT INTO job_status_history (job_id, workspace_id, old_status, new_status, reason) VALUES (?, ?, ?, ?, ?)`,
      ['job-hist', 'ws-hist', 'running', 'done', 'task completed'],
    );

    // Assert insert
    expect(insertResult.rowsAffected).toBe(1);

    // Assert query
    const queryResult = await adapter.query<DbJobStatusHistory>(
      `SELECT * FROM job_status_history WHERE job_id = ?`,
      ['job-hist'],
    );

    expect(queryResult.rowCount).toBe(1);
    const row = queryResult.rows[0]!;
    expect(row.job_id).toBe('job-hist');
    expect(row.workspace_id).toBe('ws-hist');
    expect(row.old_status).toBe('running');
    expect(row.new_status).toBe('done');
    expect(row.reason).toBe('task completed');
    // changed_at is set by SQLite DEFAULT — must be a non-empty string
    expect(typeof row.changed_at).toBe('string');
    expect(row.changed_at.length).toBeGreaterThan(0);
    // id is AUTOINCREMENT — must be a positive integer
    expect(typeof row.id).toBe('number');
    expect(row.id).toBeGreaterThan(0);
  });

  it('should store a null reason in job_status_history when reason is omitted', async () => {
    // Arrange
    await insertWorkspace(adapter, 'ws-hist');
    await insertJob(adapter, { id: 'job-hist2', workspace_id: 'ws-hist', name: 'Hist Job 2', timestamp: '2024-01-01T00:00:00Z', status: 'running' });

    // Act
    await adapter.execute(
      `INSERT INTO job_status_history (job_id, workspace_id, old_status, new_status) VALUES (?, ?, ?, ?)`,
      ['job-hist2', 'ws-hist', 'running', 'error'],
    );

    // Assert
    const result = await adapter.query<DbJobStatusHistory>(
      `SELECT reason FROM job_status_history WHERE job_id = ?`,
      ['job-hist2'],
    );
    expect(result.rows[0]?.reason).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 8. Multiple workspaces isolation
  // -------------------------------------------------------------------------

  it('should isolate jobs when querying by workspace_id across two workspaces', async () => {
    // Arrange — 2 jobs in ws-x, 1 job in ws-y
    await insertWorkspace(adapter, 'ws-x');
    await insertWorkspace(adapter, 'ws-y');

    await insertJob(adapter, { id: 'x1', workspace_id: 'ws-x', name: 'X1', timestamp: '2024-01-01T00:00:00Z', status: 'running' });
    await insertJob(adapter, { id: 'x2', workspace_id: 'ws-x', name: 'X2', timestamp: '2024-01-02T00:00:00Z', status: 'done' });
    await insertJob(adapter, { id: 'y1', workspace_id: 'ws-y', name: 'Y1', timestamp: '2024-01-03T00:00:00Z', status: 'running' });

    // Act
    const wsXResult = await adapter.query<DbJob>(
      `SELECT * FROM jobs WHERE workspace_id = ? AND deleted_at IS NULL`,
      ['ws-x'],
    );
    const wsYResult = await adapter.query<DbJob>(
      `SELECT * FROM jobs WHERE workspace_id = ? AND deleted_at IS NULL`,
      ['ws-y'],
    );

    // Assert — each query returns only its own workspace's jobs
    expect(wsXResult.rowCount).toBe(2);
    for (const row of wsXResult.rows) {
      expect(row.workspace_id).toBe('ws-x');
    }

    expect(wsYResult.rowCount).toBe(1);
    expect(wsYResult.rows[0]?.workspace_id).toBe('ws-y');
    expect(wsYResult.rows[0]?.id).toBe('y1');
  });
});
