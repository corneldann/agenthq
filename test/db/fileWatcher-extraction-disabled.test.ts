/**
 * Task 7.8 — fileWatcher guard test: MEMORY_EXTRACTION_ENABLED=false
 *
 * Verifies that when MEMORY_EXTRACTION_ENABLED is false, the file-watcher sync
 * callback never calls `extractAndStore` even for jobs with `status='done'`.
 *
 * Architecture note:
 * ──────────────────
 * `constants.ts` resolves all constants at module-load time from `process.env`.
 * `fileWatcher.ts` reads `MEMORY_EXTRACTION_ENABLED` from that binding when it
 * is imported.  Because Bun caches ES modules, the only reliable way to control
 * the constant across test files is to use `mock.module()` to replace the
 * constants module entirely.  `mock.module` calls are hoisted by Bun before any
 * imports, so modules that depend on constants will see the mocked value.
 *
 * Strategy:
 *  - `mock.module('../../src/constants.ts', ...)` supplies MEMORY_EXTRACTION_ENABLED=false.
 *  - `mock.module('../../src/memory/extraction.ts', ...)` replaces extractAndStore with
 *    a tracked mock so we can assert it was never called.
 *  - `jest.spyOn(nodeFs, 'watch')` captures the watch callback without opening
 *    a real filesystem watcher.
 *  - `jest.useFakeTimers()` controls the 500ms debounce without wall-clock delay.
 *  - After the debounce fires and syncFile resolves, we assert extractAndStore
 *    was never called — confirming the MEMORY_EXTRACTION_ENABLED guard works.
 *
 * Requirements: Phase 6.2, Requirement 4 AC 3 — automatic trigger skipped when
 * MEMORY_EXTRACTION_ENABLED=false.
 */

import { describe, it, expect, mock, jest, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import * as nodeFs from 'node:fs';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import type { DbJob } from '../../src/db/adapter.ts';
import type { IMemoryClient, Memory, MemoryScope } from '../../src/memory/types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, '../../migrations');
const OUTPUT_DIR = '/fake/output-disabled';

// ---------------------------------------------------------------------------
// Mock the constants module so MEMORY_EXTRACTION_ENABLED=false.
// mock.module calls are hoisted before imports by Bun.
// ---------------------------------------------------------------------------

mock.module('../../src/constants.ts', () => ({
  resolveConstants: () => ({}),
  PORT: 3333,
  POLL_LOG_MAX: 200,
  SCAN_CACHE_TTL: 5_000,
  SHUTDOWN_TIMEOUT_MS: 5_000,
  OUTPUT_DIR: '',
  SESSIONS_DIR: '',
  CHAINS_DIR: '',
  WORKFLOW_DIR: '',
  WORKSPACE_ROOT: '',
  SPECS_DIR: '',
  PROMPT_OUTPUT_DIR: '',
  CRAWL_JOBS_FILE: 'docs/reference/.crawl-queue.json',
  CLONE_JOBS_FILE: 'docs/reference/.clone-queue.json',
  BUILD_QUEUE_FILE: 'docs/reference/.build-queue.json',
  KIRO_TOOLS_DIR: '',
  MEMORY_ENABLED: false,
  HINDSIGHT_URL: 'http://localhost:3100',
  MEMORY_EXTRACTION_ENABLED: false,   // ← the flag under test
  MEMORY_AUTO_INJECT: false,
  MEMORY_MAX_CONTEXT_MEMORIES: 10,
  MEMORY_CONTEXT_TOKEN_BUDGET: 2_000,
  MEMORY_DECAY_DAYS: 90,
  MEMORY_RETRY_PATH: 'data/memory-retry-queue.jsonl',
  VOYAGE_API_KEY: '',
  MEMORY_HOT_TIER_COUNT: 100,
}));

// Track calls to extractAndStore — it must never be invoked.
const extractAndStoreMock = mock(async (): Promise<void> => {});

mock.module('../../src/memory/extraction.ts', () => ({
  extractAndStore: extractAndStoreMock,
}));

// ---------------------------------------------------------------------------
// Imports that depend on the mocked constants — must appear after mock.module
// ---------------------------------------------------------------------------

import { DbSyncTool } from '../../src/db/sync.ts';
import { startFileWatcher } from '../../src/workers/fileWatcher.ts';

// ---------------------------------------------------------------------------
// Fake IMemoryClient — records nothing
// ---------------------------------------------------------------------------

function makeNoopClient(): IMemoryClient {
  return {
    retain: async (_text: string, _scope: MemoryScope): Promise<string> => 'mem-id',
    recall: async (_query: string, _scope: MemoryScope, _limit: number): Promise<Memory[]> => [],
    reflect: async (_topic: string, _scope: MemoryScope): Promise<string | null> => null,
    delete: async (_id: string): Promise<void> => {},
    list: async (_scope: MemoryScope, _pageSize: number, _cursor: string | null) => ({
      memories: [],
      nextCursor: null,
      total: 0,
    }),
    get: async (_id: string) => null,
  };
}

// ---------------------------------------------------------------------------
// DB seed helpers
// ---------------------------------------------------------------------------

const SEED_WORKSPACE_ID = 'ws-disabled-001';

async function seedWorkspace(db: SQLiteAdapter): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO workspaces (id, output_dir, sessions_dir, created_at)
     VALUES (?, ?, ?, ?)`,
    [SEED_WORKSPACE_ID, '/tmp/output', '/tmp/sessions', new Date().toISOString()],
  );
}

function makeDbJob(overrides: Partial<DbJob> = {}): DbJob {
  return {
    id: 'job-disabled-001',
    workspace_id: SEED_WORKSPACE_ID,
    name: 'test-disabled-job',
    job_chain: 'test-disabled-job',
    session_chain_id: 'chain-disabled-001',
    timestamp: '2025-01-01T00:00:00.000Z',
    type: 'agent',
    agent: 'kiro',
    status: 'done',
    lines: 10,
    last_line: 'done.',
    has_log: 0,
    log_error: 0,
    md_file: `${OUTPUT_DIR}/job-disabled-001.md`,
    log_file: `${OUTPUT_DIR}/job-disabled-001.log`,
    agent_done: '',
    size_bytes: 256,
    last_modified: Date.now(),
    deleted_at: null,
    ...overrides,
  };
}

async function seedDbJob(db: SQLiteAdapter, row: DbJob): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO jobs
       (id, workspace_id, name, job_chain, session_chain_id, timestamp, type, agent,
        status, lines, last_line, has_log, log_error, md_file, log_file, agent_done,
        size_bytes, last_modified, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id, row.workspace_id, row.name, row.job_chain, row.session_chain_id,
      row.timestamp, row.type, row.agent, row.status, row.lines, row.last_line,
      row.has_log, row.log_error, row.md_file, row.log_file, row.agent_done,
      row.size_bytes, row.last_modified, row.deleted_at,
    ],
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('fileWatcher — MEMORY_EXTRACTION_ENABLED=false (Task 7.8)', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);
    await seedWorkspace(db);
    extractAndStoreMock.mockClear();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    await db.close();
  });

  // ── Test 1: done job → extractAndStore never called when flag is false ───

  it('should never call extractAndStore for a done job when MEMORY_EXTRACTION_ENABLED is false', async () => {
    // Arrange — seed a done job whose md_file will be the synced path
    const row = makeDbJob({
      id: 'job-flag-off-done',
      status: 'done',
      md_file: `${OUTPUT_DIR}/flag-off-done.md`,
    });
    await seedDbJob(db, row);

    const client = makeNoopClient();

    // Capture the fs.watch callback without opening a real watcher
    let capturedWatchCb: ((event: string, filename: string | null) => void) | undefined;
    jest.spyOn(nodeFs, 'watch').mockImplementation(
      ((...args: unknown[]) => {
        capturedWatchCb = args[2] as (event: string, filename: string | null) => void;
        return { close: () => {} } as unknown as ReturnType<typeof nodeFs.watch>;
      }) as typeof nodeFs.watch,
    );

    // syncFile resolves immediately so the post-sync block runs synchronously
    jest
      .spyOn(DbSyncTool.prototype, 'syncFile')
      .mockResolvedValue(undefined);
    jest
      .spyOn(DbSyncTool.prototype, 'runFullSync')
      .mockResolvedValue(undefined);

    jest.useFakeTimers();

    // Act — start the watcher with a non-null client
    startFileWatcher(db, OUTPUT_DIR, client);
    expect(capturedWatchCb).toBeDefined();

    // Fire a change event for the done job's md_file
    capturedWatchCb!('change', 'flag-off-done.md');

    // Advance past the 500ms debounce so the dispatch callback runs
    jest.advanceTimersByTime(600);

    // Switch back to real timers and flush any pending microtasks
    jest.useRealTimers();
    await new Promise<void>(resolve => setTimeout(resolve, 50));

    // Assert — the MEMORY_EXTRACTION_ENABLED guard must have blocked the call
    expect(extractAndStoreMock).not.toHaveBeenCalled();
  });

  // ── Test 2: null memoryClient + flag false → still no extraction call ────

  it('should never call extractAndStore when memoryClient is null and flag is false', async () => {
    // Arrange
    const row = makeDbJob({
      id: 'job-null-client-disabled',
      status: 'done',
      md_file: `${OUTPUT_DIR}/null-client-disabled.md`,
    });
    await seedDbJob(db, row);

    let capturedWatchCb: ((event: string, filename: string | null) => void) | undefined;
    jest.spyOn(nodeFs, 'watch').mockImplementation(
      ((...args: unknown[]) => {
        capturedWatchCb = args[2] as (event: string, filename: string | null) => void;
        return { close: () => {} } as unknown as ReturnType<typeof nodeFs.watch>;
      }) as typeof nodeFs.watch,
    );

    jest
      .spyOn(DbSyncTool.prototype, 'syncFile')
      .mockResolvedValue(undefined);
    jest
      .spyOn(DbSyncTool.prototype, 'runFullSync')
      .mockResolvedValue(undefined);

    jest.useFakeTimers();

    // Act — default null memoryClient (double guard: both flag and client are off)
    startFileWatcher(db, OUTPUT_DIR, null);
    expect(capturedWatchCb).toBeDefined();

    capturedWatchCb!('change', 'null-client-disabled.md');
    jest.advanceTimersByTime(600);

    jest.useRealTimers();
    await new Promise<void>(resolve => setTimeout(resolve, 50));

    // Assert
    expect(extractAndStoreMock).not.toHaveBeenCalled();
  });
});
