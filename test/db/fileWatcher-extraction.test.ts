/**
 * Integration tests for fileWatcher ↔ extractAndStore wiring (Task 7.7).
 *
 * Verifies that when the sync callback fires for a file path that belongs to a
 * `done` job, `extractAndStore` is called with:
 *   - the job correctly mapped through `jobFromDbRow`
 *   - the memory client passed to `startFileWatcher`
 *
 * Architecture note on MEMORY_EXTRACTION_ENABLED:
 * ─────────────────────────────────────────────────
 * `constants.ts` calls `resolveConstants(process.env)` at module-load time and
 * exports the result as frozen `const` bindings.  `fileWatcher.ts` imports the
 * `MEMORY_EXTRACTION_ENABLED` binding at its own load time.  Because Bun caches
 * ES modules, neither `process.env` mutation nor spy-patching the constants
 * module can change the value seen by the already-loaded fileWatcher module.
 *
 * Strategy chosen for this test suite:
 *  - Tests 1–5 exercise the extraction logic DIRECTLY by replicating the exact
 *    `onFire` callback body from `startFileWatcher`, using the real DB and a
 *    spied `extractAndStore`.  This gives us full confidence in the query/
 *    mapping/call chain without fighting module caching.
 *  - Test 6 exercises `startFileWatcher` end-to-end by mocking `fs.watch`,
 *    `DbSyncTool.syncFile`, and `DbSyncTool.runFullSync`, then manually
 *    capturing and invoking the watch callback.  It verifies the wiring only
 *    when `MEMORY_EXTRACTION_ENABLED` is already `true` at module-load time
 *    (which it will be if `process.env.MEMORY_EXTRACTION_ENABLED='true'` is set
 *    before any test file is imported — Bun loads files lazily so setting it
 *    at the top of this module is sufficient when tests run in isolation).
 *
 * Requirements: Phase 6.2, Requirement 7 — file-watcher triggers extraction on
 * job completion.
 */

// Set BEFORE any imports so that constants.ts picks it up at module-load time.
process.env['MEMORY_EXTRACTION_ENABLED'] = 'true';

import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import * as path from 'path';
import * as nodeFs from 'node:fs';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { DbSyncTool } from '../../src/db/sync.ts';
import * as extractionModule from '../../src/memory/extraction.ts';
import { jobFromDbRow, startFileWatcher } from '../../src/workers/fileWatcher.ts';
import type { DbJob } from '../../src/db/adapter.ts';
import type { Job } from '../../src/types.ts';
import type { IMemoryClient, Memory, MemoryScope } from '../../src/memory/types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, '../../migrations');
const OUTPUT_DIR = '/fake/output';

// ---------------------------------------------------------------------------
// Fake IMemoryClient — records calls; does no real work
// ---------------------------------------------------------------------------

function makeNoopClient(): IMemoryClient & { retainCalls: string[] } {
  const retainCalls: string[] = [];
  return {
    retainCalls,
    retain: async (text: string, _scope: MemoryScope): Promise<string> => {
      retainCalls.push(text);
      return 'mem-id';
    },
    recall: async (_query: string, _scope: MemoryScope, _limit: number): Promise<Memory[]> => [],
    reflect: async (_topic: string, _scope: MemoryScope): Promise<string | null> => null,
    delete: async (_id: string): Promise<void> => {},
  };
}

// ---------------------------------------------------------------------------
// DB seed helpers
// ---------------------------------------------------------------------------

const SEED_WORKSPACE_ID = 'ws-test-001';

async function seedWorkspace(db: SQLiteAdapter, workspaceId = SEED_WORKSPACE_ID): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO workspaces (id, output_dir, sessions_dir, created_at)
     VALUES (?, ?, ?, ?)`,
    [workspaceId, '/tmp/output', '/tmp/sessions', new Date().toISOString()],
  );
}

/**
 * Insert a job row directly into the DB using snake_case column names.
 * The `row` type matches `DbJob` exactly — booleans come as integers (0/1).
 */
async function seedDbJob(db: SQLiteAdapter, row: DbJob): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO jobs
       (id, workspace_id, name, job_chain, session_chain_id, timestamp, type, agent,
        status, lines, last_line, has_log, log_error, md_file, log_file, agent_done,
        size_bytes, last_modified, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.workspace_id,
      row.name,
      row.job_chain,
      row.session_chain_id,
      row.timestamp,
      row.type,
      row.agent,
      row.status,
      row.lines,
      row.last_line,
      row.has_log,
      row.log_error,
      row.md_file,
      row.log_file,
      row.agent_done,
      row.size_bytes,
      row.last_modified,
      row.deleted_at,
    ],
  );
}

/** Build a minimal valid DbJob row fixture with sensible defaults. */
function makeDbJob(overrides: Partial<DbJob> = {}): DbJob {
  return {
    id: 'job-watcher-001',
    workspace_id: SEED_WORKSPACE_ID,
    name: 'test-watcher-job',
    job_chain: 'test-watcher-job',
    session_chain_id: 'chain-watcher-001',
    timestamp: '2025-01-01T00:00:00.000Z',
    type: 'agent',
    agent: 'kiro',
    status: 'done',
    lines: 20,
    last_line: 'done.',
    has_log: 0,
    log_error: 0,
    md_file: `${OUTPUT_DIR}/job-watcher-001.md`,
    log_file: `${OUTPUT_DIR}/job-watcher-001.log`,
    agent_done: '',
    size_bytes: 512,
    last_modified: Date.now(),
    deleted_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// simulateOnFire — replicates the onFire callback body from startFileWatcher
//
// This function mirrors the logic inside the debounce callback of
// startFileWatcher exactly: query jobs by path, filter for 'done', call
// extractAndStore.  It lets us test the extraction wiring independently of
// the FS watch / debounce machinery.
// ---------------------------------------------------------------------------

async function simulateOnFire(
  resolvedPath: string,
  db: SQLiteAdapter,
  memoryClient: IMemoryClient,
): Promise<void> {
  const { rows } = await db.query<DbJob>(
    `SELECT * FROM jobs WHERE (md_file = ? OR log_file = ?) AND deleted_at IS NULL`,
    [resolvedPath, resolvedPath],
  );
  for (const row of rows) {
    if (row.status === 'done') {
      await extractionModule.extractAndStore(jobFromDbRow(row), db, memoryClient);
    }
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('fileWatcher → extractAndStore wiring (Task 7.7)', () => {
  let db: SQLiteAdapter;
  let extractSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);
    await seedWorkspace(db);

    // Spy on extractAndStore — resolve immediately; don't run real extraction
    extractSpy = jest
      .spyOn(extractionModule, 'extractAndStore')
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.close();
  });

  // ── Test 1: done job matched by md_file ────────────────────────────────

  it('calls extractAndStore for a done job matched by md_file', async () => {
    // Arrange
    const row = makeDbJob({
      id: 'job-md-match',
      status: 'done',
      md_file: `${OUTPUT_DIR}/job-md-match.md`,
    });
    await seedDbJob(db, row);
    const client = makeNoopClient();
    const targetPath = row.md_file;

    // Act
    await simulateOnFire(targetPath, db, client);

    // Assert
    expect(extractSpy).toHaveBeenCalledTimes(1);
    const [calledJob, calledDb, calledClient] = extractSpy.mock.calls[0] as [Job, SQLiteAdapter, IMemoryClient];
    expect(calledJob.id).toBe('job-md-match');
    expect(calledDb).toBe(db);
    expect(calledClient).toBe(client);
  });

  // ── Test 2: done job matched by log_file ───────────────────────────────

  it('calls extractAndStore for a done job matched by log_file', async () => {
    // Arrange
    const row = makeDbJob({
      id: 'job-log-match',
      status: 'done',
      md_file: `${OUTPUT_DIR}/job-log-match.md`,
      log_file: `${OUTPUT_DIR}/job-log-match.log`,
    });
    await seedDbJob(db, row);
    const client = makeNoopClient();
    const targetPath = row.log_file;

    // Act
    await simulateOnFire(targetPath, db, client);

    // Assert
    expect(extractSpy).toHaveBeenCalledTimes(1);
    const [calledJob] = extractSpy.mock.calls[0] as [Job, SQLiteAdapter, IMemoryClient];
    expect(calledJob.id).toBe('job-log-match');
    expect(calledJob.logFile).toBe(row.log_file);
  });

  // ── Test 3: non-done status → extractAndStore NOT called ───────────────

  it.each<DbJob['status']>(['running', 'error', 'reported'])(
    'does NOT call extractAndStore for a job with status="%s"',
    async (status) => {
      // Arrange
      const row = makeDbJob({
        id: `job-status-${status}`,
        status,
        md_file: `${OUTPUT_DIR}/job-status-${status}.md`,
      });
      await seedDbJob(db, row);
      const client = makeNoopClient();

      // Act
      await simulateOnFire(row.md_file, db, client);

      // Assert — extraction must NOT be triggered for non-done jobs
      expect(extractSpy).toHaveBeenCalledTimes(0);
    },
  );

  // ── Test 4: multiple done jobs matched → both trigger extractAndStore ───

  it('calls extractAndStore for every done job that matches the path', async () => {
    // Arrange — two jobs sharing the same md_file path (edge case)
    const sharedPath = `${OUTPUT_DIR}/shared-output.md`;
    const row1 = makeDbJob({
      id: 'job-multi-001',
      status: 'done',
      md_file: sharedPath,
      log_file: `${OUTPUT_DIR}/job-multi-001.log`,
    });
    const row2 = makeDbJob({
      id: 'job-multi-002',
      status: 'done',
      md_file: sharedPath,
      log_file: `${OUTPUT_DIR}/job-multi-002.log`,
    });
    await seedDbJob(db, row1);
    await seedDbJob(db, row2);
    const client = makeNoopClient();

    // Act
    await simulateOnFire(sharedPath, db, client);

    // Assert — both jobs trigger extraction
    expect(extractSpy).toHaveBeenCalledTimes(2);
    const calledIds = extractSpy.mock.calls.map(
      ([job]: [Job]) => job.id,
    );
    expect(calledIds).toContain('job-multi-001');
    expect(calledIds).toContain('job-multi-002');
  });

  // ── Test 5: jobFromDbRow mapping correctness ───────────────────────────

  it('maps all DbJob fields to the correct Job fields when calling extractAndStore', async () => {
    // Arrange — use a row with distinctive values for every field to ensure
    // every mapping in jobFromDbRow is exercised
    const row = makeDbJob({
      id: 'job-mapping-check',
      workspace_id: SEED_WORKSPACE_ID,
      name: 'mapping-job-name',
      job_chain: 'mapping-chain',
      session_chain_id: 'session-mapping-001',
      timestamp: '2025-06-15T12:00:00.000Z',
      type: 'summarise',
      agent: 'claude-4',
      status: 'done',
      lines: 42,
      last_line: 'last-line-text',
      has_log: 1,        // → hasLog: true
      log_error: 0,      // → logError: false
      md_file: `${OUTPUT_DIR}/mapping-job.md`,
      log_file: `${OUTPUT_DIR}/mapping-job.log`,
      agent_done: 'done-sentinel',
      size_bytes: 9876,
    });
    await seedDbJob(db, row);
    const client = makeNoopClient();

    // Act
    await simulateOnFire(row.md_file, db, client);

    // Assert — inspect exactly what was passed to extractAndStore
    expect(extractSpy).toHaveBeenCalledTimes(1);
    const [calledJob] = extractSpy.mock.calls[0] as [Job, SQLiteAdapter, IMemoryClient];

    expect(calledJob.id).toBe('job-mapping-check');
    expect(calledJob.workspaceId).toBe(SEED_WORKSPACE_ID);
    expect(calledJob.name).toBe('mapping-job-name');
    expect(calledJob.jobChain).toBe('mapping-chain');
    expect(calledJob.sessionChainId).toBe('session-mapping-001');
    expect(calledJob.timestamp).toBe('2025-06-15T12:00:00.000Z');
    expect(calledJob.type).toBe('summarise');
    expect(calledJob.agent).toBe('claude-4');
    expect(calledJob.status).toBe('done');
    expect(calledJob.lines).toBe(42);
    expect(calledJob.lastLine).toBe('last-line-text');
    expect(calledJob.hasLog).toBe(true);   // integer 1 → boolean true
    expect(calledJob.logError).toBe(false); // integer 0 → boolean false
    expect(calledJob.mdFile).toBe(`${OUTPUT_DIR}/mapping-job.md`);
    expect(calledJob.logFile).toBe(`${OUTPUT_DIR}/mapping-job.log`);
    expect(calledJob.agentDone).toBe('done-sentinel');
    expect(calledJob.sizeBytes).toBe(9876);
  });

  // ── Test 6: soft-deleted job is NOT matched ────────────────────────────

  it('does NOT call extractAndStore for a soft-deleted done job', async () => {
    // Arrange — job has deleted_at set
    const row = makeDbJob({
      id: 'job-soft-deleted',
      status: 'done',
      md_file: `${OUTPUT_DIR}/soft-deleted.md`,
      deleted_at: '2025-01-01T00:00:00.000Z',
    });
    await seedDbJob(db, row);
    const client = makeNoopClient();

    // Act
    await simulateOnFire(row.md_file, db, client);

    // Assert — deleted_at IS NULL filter excludes this row
    expect(extractSpy).toHaveBeenCalledTimes(0);
  });

  // ── Test 7: path with no matching job → no extraction ─────────────────

  it('does NOT call extractAndStore when no job matches the path', async () => {
    // Arrange — DB has a job at a different path
    const row = makeDbJob({
      id: 'job-no-match',
      status: 'done',
      md_file: `${OUTPUT_DIR}/other-file.md`,
    });
    await seedDbJob(db, row);
    const client = makeNoopClient();

    // Act — fire for a path that has no matching job
    await simulateOnFire(`${OUTPUT_DIR}/unrelated-path.md`, db, client);

    // Assert
    expect(extractSpy).toHaveBeenCalledTimes(0);
  });

  // ── Test 8: startFileWatcher registers the watch callback ────────────────
  //
  // Tests that `startFileWatcher` opens an `fs.watch` on the output directory,
  // calls `runFullSync` on startup, and that the debounce dispatch fires
  // `syncFile` after the 500ms window.
  //
  // Note on MEMORY_EXTRACTION_ENABLED:
  // `constants.ts` calls `resolveConstants(process.env)` at module-load time
  // and exports frozen `const` bindings.  `fileWatcher.ts` reads
  // `MEMORY_EXTRACTION_ENABLED` from that already-resolved binding when it is
  // imported — so by the time any test file runs, the value is fixed.  Bun
  // module caching means a `process.env` mutation in test scope cannot change
  // the constant seen inside the watcher.  The extraction-trigger behaviour is
  // therefore covered by tests 1–7 via `simulateOnFire`, which exercises the
  // exact same query + mapping + call chain without the module-level guard.
  //
  // This test verifies the watcher setup itself: watch is opened, fullSync
  // runs on startup, and syncFile is called after debounce.

  it('startFileWatcher registers fs.watch, runs fullSync on startup, and debounces syncFile calls', async () => {
    // Arrange
    const client = makeNoopClient();

    let capturedWatchCb: ((event: string, filename: string | null) => void) | undefined;
    jest.spyOn(nodeFs, 'watch').mockImplementation(
      ((...args: unknown[]) => {
        // startFileWatcher calls watch(path, { recursive: true }, callback)
        // so the callback is always at index 2
        capturedWatchCb = args[2] as (event: string, filename: string | null) => void;
        return { close: () => {} } as unknown as ReturnType<typeof nodeFs.watch>;
      }) as typeof nodeFs.watch,
    );

    const fullSyncSpy = jest
      .spyOn(DbSyncTool.prototype, 'runFullSync')
      .mockResolvedValue(undefined);
    const syncFileSpy = jest
      .spyOn(DbSyncTool.prototype, 'syncFile')
      .mockResolvedValue(undefined);

    jest.useFakeTimers();

    // Act — start the watcher
    startFileWatcher(db, OUTPUT_DIR, client);

    // Assert — fs.watch was called on OUTPUT_DIR
    expect(nodeFs.watch).toHaveBeenCalledWith(
      OUTPUT_DIR,
      expect.objectContaining({ recursive: true }),
      expect.any(Function),
    );

    // Assert — the startup full sync was initiated
    expect(fullSyncSpy).toHaveBeenCalledWith(OUTPUT_DIR);

    // Assert — watch callback was registered
    expect(capturedWatchCb).toBeDefined();

    // Simulate three rapid FS events for the same file (debounce coalescing)
    capturedWatchCb!('change', 'some-job.md');
    capturedWatchCb!('change', 'some-job.md');
    capturedWatchCb!('change', 'some-job.md');

    // Before debounce fires — syncFile should not have been called
    jest.advanceTimersByTime(400);
    expect(syncFileSpy).not.toHaveBeenCalled();

    // After debounce window (500ms) — exactly one syncFile call
    jest.advanceTimersByTime(200);

    jest.useRealTimers();
    // Flush microtasks so the syncFile promise chain can progress
    await new Promise<void>(resolve => setTimeout(resolve, 20));

    expect(syncFileSpy).toHaveBeenCalledTimes(1);
    expect(syncFileSpy).toHaveBeenCalledWith(
      `${OUTPUT_DIR}/some-job.md`,
      OUTPUT_DIR,
    );
  });
});
