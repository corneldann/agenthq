/**
 * Unit tests for CommandHandler (src/ws/commands.ts).
 *
 * Uses an in-memory SQLite database with the DDL for jobs, sessions, and
 * job_status_history tables applied directly — no migration files needed.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 9.2, 11.2
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter';
import { CommandHandler } from '../../src/ws/commands';
import type { DbAdapter } from '../../src/db/adapter';

// ---------------------------------------------------------------------------
// DDL — minimal schema required by CommandHandler (one statement per element
// because SQLiteAdapter.execute() uses db.prepare() which rejects multi-statement strings)
// ---------------------------------------------------------------------------

const DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS workspaces (
    id           TEXT PRIMARY KEY,
    output_dir   TEXT NOT NULL,
    sessions_dir TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,

  `CREATE TABLE IF NOT EXISTS jobs (
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
  )`,

  `CREATE TABLE IF NOT EXISTS chains (
    chain_id         TEXT PRIMARY KEY,
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    display_name     TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL,
    last_active_at   TEXT NOT NULL,
    total_messages   INTEGER NOT NULL DEFAULT 0,
    last_modified    INTEGER NOT NULL DEFAULT 0,
    deleted_at       TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
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
  )`,

  `CREATE TABLE IF NOT EXISTS job_status_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT    NOT NULL,
    workspace_id TEXT    NOT NULL,
    old_status   TEXT    NOT NULL,
    new_status   TEXT    NOT NULL,
    reason       TEXT,
    changed_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS_ID = 'ws-test-1';
const JOB_ID = 'job-test-1';
const CHAIN_ID = 'chain-test-1';
const SESSION_HASH = 'hash-abc123';
const COMMAND_ID = 'cmd_1700000000000_abc123';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed a workspace row required by FK constraints. */
async function seedWorkspace(db: DbAdapter, wsId = WS_ID): Promise<void> {
  await db.execute(
    `INSERT INTO workspaces (id, output_dir, sessions_dir) VALUES (?, ?, ?)`,
    [wsId, '/out', '/sessions'],
  );
}

/** Seed a job row in the given workspace with the given status. */
async function seedJob(
  db: DbAdapter,
  opts: { jobId?: string; wsId?: string; status?: 'running' | 'done' | 'reported' | 'error' } = {},
): Promise<void> {
  const { jobId = JOB_ID, wsId = WS_ID, status = 'running' } = opts;
  await db.execute(
    `INSERT INTO jobs
       (id, workspace_id, name, timestamp, status)
     VALUES (?, ?, ?, ?, ?)`,
    [jobId, wsId, 'test-job', new Date().toISOString(), status],
  );
}

/** Seed a session row in the given workspace with the given status. */
async function seedSession(
  db: DbAdapter,
  opts: { chainId?: string; wsId?: string; sessionHash?: string; status?: string } = {},
): Promise<void> {
  const {
    chainId = CHAIN_ID,
    wsId = WS_ID,
    sessionHash = SESSION_HASH,
    status = 'running',
  } = opts;
  await db.execute(
    `INSERT INTO sessions
       (chain_id, workspace_id, workflow_hash, last_message_at, status)
     VALUES (?, ?, ?, ?, ?)`,
    [chainId, wsId, sessionHash, new Date().toISOString(), status],
  );
}

/** Query the current status of a job row. */
async function queryJobStatus(db: DbAdapter, jobId = JOB_ID): Promise<string> {
  const result = await db.query<{ status: string }>(
    'SELECT status FROM jobs WHERE id = ?',
    [jobId],
  );
  return result.rows[0]?.status ?? '';
}

/** Query the current status of a session row. */
async function querySessionStatus(
  db: DbAdapter,
  sessionHash = SESSION_HASH,
  wsId = WS_ID,
): Promise<string> {
  const result = await db.query<{ status: string }>(
    'SELECT status FROM sessions WHERE workflow_hash = ? AND workspace_id = ?',
    [sessionHash, wsId],
  );
  return result.rows[0]?.status ?? '';
}

/** Query all job_status_history rows for a given job. */
async function queryStatusHistory(
  db: DbAdapter,
  jobId = JOB_ID,
): Promise<Array<{ old_status: string; new_status: string; reason: string | null }>> {
  const result = await db.query<{ old_status: string; new_status: string; reason: string | null }>(
    `SELECT old_status, new_status, reason
       FROM job_status_history
      WHERE job_id = ?
      ORDER BY id ASC`,
    [jobId],
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Test suite setup
// ---------------------------------------------------------------------------

describe('CommandHandler', () => {
  let db: SQLiteAdapter;
  let handler: CommandHandler;

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    // Apply each DDL statement individually — db.execute() uses db.prepare()
    // which does not accept multi-statement strings.
    for (const stmt of DDL_STATEMENTS) {
      await db.execute(stmt);
    }
    handler = new CommandHandler(db);
    await seedWorkspace(db);
  });

  afterEach(async () => {
    await db.close();
  });

  // -------------------------------------------------------------------------
  // cancel-job — success path
  // -------------------------------------------------------------------------

  describe('handle() — cancel-job', () => {
    it('should return success: true when job exists and workspace matches', async () => {
      await seedJob(db, { status: 'running' });

      const result = await handler.handle({
        type: 'cancel-job',
        jobId: JOB_ID,
        workspaceId: WS_ID,
        commandId: COMMAND_ID,
      });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should set the job status to "error" after a successful cancel', async () => {
      await seedJob(db, { status: 'running' });

      await handler.handle({
        type: 'cancel-job',
        jobId: JOB_ID,
        workspaceId: WS_ID,
        commandId: COMMAND_ID,
      });

      const status = await queryJobStatus(db, JOB_ID);
      expect(status).toBe('error');
    });

    it('should insert exactly one job_status_history row with reason "cancelled by user"', async () => {
      await seedJob(db, { status: 'running' });

      await handler.handle({
        type: 'cancel-job',
        jobId: JOB_ID,
        workspaceId: WS_ID,
        commandId: COMMAND_ID,
      });

      const history = await queryStatusHistory(db, JOB_ID);
      expect(history).toHaveLength(1);
      expect(history[0].reason).toBe('cancelled by user');
      expect(history[0].new_status).toBe('error');
    });

    it('should record the original job status as old_status in job_status_history', async () => {
      await seedJob(db, { status: 'running' });

      await handler.handle({
        type: 'cancel-job',
        jobId: JOB_ID,
        workspaceId: WS_ID,
        commandId: COMMAND_ID,
      });

      const history = await queryStatusHistory(db, JOB_ID);
      expect(history[0].old_status).toBe('running');
    });

    // -----------------------------------------------------------------------
    // cancel-job — failure paths
    // -----------------------------------------------------------------------

    it('should return { success: false, error: "not found" } for a non-existent jobId', async () => {
      const result = await handler.handle({
        type: 'cancel-job',
        jobId: 'no-such-job',
        workspaceId: WS_ID,
        commandId: COMMAND_ID,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('not found');
    });

    it('should return { success: false, error: "workspace mismatch" } when workspaceId does not match', async () => {
      await seedJob(db, { status: 'running' });

      const result = await handler.handle({
        type: 'cancel-job',
        jobId: JOB_ID,
        workspaceId: 'wrong-workspace',
        commandId: COMMAND_ID,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('workspace mismatch');
    });

    it('should not modify the job row when workspace mismatch occurs', async () => {
      await seedJob(db, { status: 'running' });

      await handler.handle({
        type: 'cancel-job',
        jobId: JOB_ID,
        workspaceId: 'wrong-workspace',
        commandId: COMMAND_ID,
      });

      const status = await queryJobStatus(db, JOB_ID);
      expect(status).toBe('running');
    });
  });

  // -------------------------------------------------------------------------
  // pause-agent
  // -------------------------------------------------------------------------

  describe('handle() — pause-agent', () => {
    it('should return success: true when session is in running state', async () => {
      await seedSession(db, { status: 'running' });

      const result = await handler.handle({
        type: 'pause-agent',
        sessionHash: SESSION_HASH,
        workspaceId: WS_ID,
        commandId: COMMAND_ID,
      });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should set the session status to "paused" after a successful pause', async () => {
      await seedSession(db, { status: 'running' });

      await handler.handle({
        type: 'pause-agent',
        sessionHash: SESSION_HASH,
        workspaceId: WS_ID,
        commandId: COMMAND_ID,
      });

      const status = await querySessionStatus(db, SESSION_HASH, WS_ID);
      expect(status).toBe('paused');
    });

    it('should return { success: false } with an invalid state transition error when session is not running', async () => {
      await seedSession(db, { status: 'done' });

      const result = await handler.handle({
        type: 'pause-agent',
        sessionHash: SESSION_HASH,
        workspaceId: WS_ID,
        commandId: COMMAND_ID,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('invalid state transition: cannot pause from done');
    });

    it('should not modify the session row when the state transition is invalid', async () => {
      await seedSession(db, { status: 'done' });

      await handler.handle({
        type: 'pause-agent',
        sessionHash: SESSION_HASH,
        workspaceId: WS_ID,
        commandId: COMMAND_ID,
      });

      const status = await querySessionStatus(db, SESSION_HASH, WS_ID);
      expect(status).toBe('done');
    });

    it('should return { success: false, error: "not found" } when session does not exist', async () => {
      const result = await handler.handle({
        type: 'pause-agent',
        sessionHash: 'no-such-hash',
        workspaceId: WS_ID,
        commandId: COMMAND_ID,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('not found');
    });
  });

  // -------------------------------------------------------------------------
  // resume-agent
  // -------------------------------------------------------------------------

  describe('handle() — resume-agent', () => {
    it('should return success: true when session is in paused state', async () => {
      await seedSession(db, { status: 'paused' });

      const result = await handler.handle({
        type: 'resume-agent',
        sessionHash: SESSION_HASH,
        workspaceId: WS_ID,
        commandId: COMMAND_ID,
      });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should set the session status to "running" after a successful resume', async () => {
      await seedSession(db, { status: 'paused' });

      await handler.handle({
        type: 'resume-agent',
        sessionHash: SESSION_HASH,
        workspaceId: WS_ID,
        commandId: COMMAND_ID,
      });

      const status = await querySessionStatus(db, SESSION_HASH, WS_ID);
      expect(status).toBe('running');
    });

    it('should return { success: false } with an invalid state transition error when session is not paused', async () => {
      await seedSession(db, { status: 'running' });

      const result = await handler.handle({
        type: 'resume-agent',
        sessionHash: SESSION_HASH,
        workspaceId: WS_ID,
        commandId: COMMAND_ID,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('invalid state transition: cannot resume from running');
    });

    it('should not modify the session row when resume is called on a non-paused session', async () => {
      await seedSession(db, { status: 'running' });

      await handler.handle({
        type: 'resume-agent',
        sessionHash: SESSION_HASH,
        workspaceId: WS_ID,
        commandId: COMMAND_ID,
      });

      const status = await querySessionStatus(db, SESSION_HASH, WS_ID);
      expect(status).toBe('running');
    });

    it('should return { success: false, error: "not found" } when session does not exist', async () => {
      const result = await handler.handle({
        type: 'resume-agent',
        sessionHash: 'no-such-hash',
        workspaceId: WS_ID,
        commandId: COMMAND_ID,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('not found');
    });
  });

  // -------------------------------------------------------------------------
  // handle() — non-command message types
  // -------------------------------------------------------------------------

  describe('handle() — non-command message types', () => {
    it('should return { success: false, error: "Unknown command type" } for a ping message', async () => {
      const result = await handler.handle({
        type: 'ping',
        commandId: COMMAND_ID,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown command type');
    });

    it('should return { success: false, error: "Unknown command type" } for a subscribe message', async () => {
      const result = await handler.handle({
        type: 'subscribe',
        commandId: COMMAND_ID,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown command type');
    });
  });

  // -------------------------------------------------------------------------
  // handle() — DB error propagation (Requirement 9.2)
  // -------------------------------------------------------------------------

  describe('handle() — database error propagation', () => {
    it('should propagate an error thrown by db.query() to the caller', async () => {
      // Construct a stub DbAdapter whose query() always throws.
      const throwingDb: DbAdapter = {
        query: async () => {
          throw new Error('DB connection lost');
        },
        execute: async () => ({ rowsAffected: 0 }),
        transaction: async () => {},
        close: async () => {},
      };

      const throwingHandler = new CommandHandler(throwingDb);

      await expect(
        throwingHandler.handle({
          type: 'cancel-job',
          jobId: JOB_ID,
          workspaceId: WS_ID,
          commandId: COMMAND_ID,
        }),
      ).rejects.toThrow('DB connection lost');
    });

    it('should propagate an error thrown by db.transaction() to the caller', async () => {
      // Use real db so query() succeeds, but override transaction() to throw.
      await seedJob(db, { status: 'running' });

      const partialThrowingDb: DbAdapter = {
        query: (sql, params) => db.query(sql, params),
        execute: (sql, params) => db.execute(sql, params),
        transaction: async () => {
          throw new Error('transaction failed');
        },
        close: async () => {},
      };

      const partialThrowingHandler = new CommandHandler(partialThrowingDb);

      await expect(
        partialThrowingHandler.handle({
          type: 'cancel-job',
          jobId: JOB_ID,
          workspaceId: WS_ID,
          commandId: COMMAND_ID,
        }),
      ).rejects.toThrow('transaction failed');
    });
  });
});
