/**
 * Unit tests for `extractAndStore` — file-read step (sub-task 3.3).
 *
 * Covers:
 *   - Absent output file → writes a failed `memory_extraction` row and returns
 *   - Empty output file (whitespace-only) → writes a failed row and returns
 *   - Valid file content → does NOT write a failed row for the file-read reason
 *     (the function proceeds past the file-read step; subsequent steps are not
 *     yet fully implemented so we only assert the row absence at this stage)
 *
 * Requirements: Phase 6.2, Requirement 2 AC 3 — absent or empty file writes a
 * failed row with quality_score=0, memory_count=0, embedding_status='failed'.
 *
 * Test isolation: each test uses an in-memory SQLite DB with all migrations
 * applied via `runMigrations`. A fake `IMemoryClient` (no-op) is used so
 * tests do not depend on a running Hindsight instance.
 *
 * `Bun.file` is stubbed per-test using `jest.spyOn` so no real disk I/O occurs.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import * as path from 'path';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { extractAndStore } from '../../src/memory/extraction.ts';
import type { Job } from '../../src/types.ts';
import type { IMemoryClient, Memory, MemoryScope } from '../../src/memory/types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, '../../migrations');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid Job fixture. `mdFile` is intentionally set per test. */
function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-test-001',
    name: 'test-job',
    jobChain: 'test-job',
    sessionChainId: 'chain-001',
    timestamp: new Date().toISOString(),
    type: 'agent',
    agent: 'kiro',
    status: 'done',
    lines: 10,
    lastLine: '',
    hasLog: false,
    logError: false,
    mdFile: '/nonexistent/output.md',
    logFile: '/nonexistent/output.log',
    agentDone: '',
    sizeBytes: 0,
    workspaceId: 'ws-001',
    ...overrides,
  };
}

/** No-op IMemoryClient — does nothing; won't be reached for file-read failures. */
const noopClient: IMemoryClient = {
  retain: async (_text: string, _scope: MemoryScope): Promise<string> => '',
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

/** Query the memory_extraction row for a given job_id. Returns null if absent. */
async function getExtractionRow(
  db: SQLiteAdapter,
  jobId: string,
): Promise<Record<string, unknown> | null> {
  const result = await db.query<Record<string, unknown>>(
    'SELECT * FROM memory_extraction WHERE job_id = ?',
    [jobId],
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Fake BunFile — returns controllable `exists()` and `text()` values
// ---------------------------------------------------------------------------

type FakeBunFileConfig = {
  exists: boolean;
  text?: string;
};

function makeFakeBunFile(config: FakeBunFileConfig): ReturnType<typeof Bun.file> {
  return {
    exists: async () => config.exists,
    text: async () => {
      if (!config.exists) throw new Error('ENOENT: no such file');
      return config.text ?? '';
    },
  } as unknown as ReturnType<typeof Bun.file>;
}

// ---------------------------------------------------------------------------
// DB seed helpers — insert workspace + job rows so FK constraints are satisfied
// ---------------------------------------------------------------------------

const SEED_WORKSPACE_ID = 'ws-001';

async function seedWorkspace(db: SQLiteAdapter, workspaceId = SEED_WORKSPACE_ID): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO workspaces (id, output_dir, sessions_dir, created_at)
     VALUES (?, ?, ?, ?)`,
    [workspaceId, '/tmp/output', '/tmp/sessions', new Date().toISOString()],
  );
}

async function seedJob(db: SQLiteAdapter, job: Job): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO jobs
       (id, workspace_id, name, job_chain, session_chain_id, timestamp, type, agent,
        status, lines, last_line, has_log, log_error, md_file, log_file, agent_done,
        size_bytes, last_modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      job.id, job.workspaceId, job.name, job.jobChain, job.sessionChainId,
      job.timestamp, job.type, job.agent, job.status, job.lines, job.lastLine,
      job.hasLog ? 1 : 0, job.logError ? 1 : 0, job.mdFile, job.logFile,
      job.agentDone, job.sizeBytes, Date.now(),
    ],
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('extractAndStore — file read step (sub-task 3.3)', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);
    await seedWorkspace(db);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.close();
  });

  // -------------------------------------------------------------------------
  // Absent file
  // -------------------------------------------------------------------------

  it('should write a failed row when the output file does not exist', async () => {
    // Arrange
    const job = makeJob({ mdFile: '/absent/output.md' });
    await seedJob(db, job);
    jest.spyOn(Bun, 'file').mockReturnValue(makeFakeBunFile({ exists: false }));

    // Act
    await extractAndStore(job, db, noopClient);

    // Assert
    const row = await getExtractionRow(db, job.id);
    expect(row).not.toBeNull();
    expect(row!['job_id']).toBe(job.id);
    expect(row!['quality_score']).toBe(0);
    expect(row!['memory_count']).toBe(0);
    expect(row!['embedding_status']).toBe('failed');
    expect(row!['raw_text']).toBe('');
  });

  // -------------------------------------------------------------------------
  // Empty file
  // -------------------------------------------------------------------------

  it('should write a failed row when the output file is empty', async () => {
    // Arrange
    const job = makeJob({ mdFile: '/empty/output.md' });
    await seedJob(db, job);
    jest.spyOn(Bun, 'file').mockReturnValue(makeFakeBunFile({ exists: true, text: '' }));

    // Act
    await extractAndStore(job, db, noopClient);

    // Assert
    const row = await getExtractionRow(db, job.id);
    expect(row).not.toBeNull();
    expect(row!['quality_score']).toBe(0);
    expect(row!['memory_count']).toBe(0);
    expect(row!['embedding_status']).toBe('failed');
  });

  it('should write a failed row when the output file contains only whitespace', async () => {
    // Arrange
    const job = makeJob({ mdFile: '/whitespace/output.md' });
    await seedJob(db, job);
    jest.spyOn(Bun, 'file').mockReturnValue(
      makeFakeBunFile({ exists: true, text: '   \n\t  \n  ' }),
    );

    // Act
    await extractAndStore(job, db, noopClient);

    // Assert
    const row = await getExtractionRow(db, job.id);
    expect(row).not.toBeNull();
    expect(row!['embedding_status']).toBe('failed');
    expect(row!['memory_count']).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Valid file — passes the file-read gate
  // -------------------------------------------------------------------------

  it('should not write a failed row for an empty-file reason when file has content', async () => {
    // Arrange — subsequent steps (LLM calls) are not implemented yet so the
    // function may proceed and do nothing, or may fail gracefully; either way
    // the row should NOT be a failed row caused by the file-read step.
    //
    // We verify the row was either written with non-zero raw_text (extraction
    // proceeded) or is absent (function returned cleanly without error path).
    const job = makeJob({ mdFile: '/valid/output.md' });
    await seedJob(db, job);
    jest.spyOn(Bun, 'file').mockReturnValue(
      makeFakeBunFile({
        exists: true,
        text: '# Agent Output\n\nThe system uses SQLite for persistence. Connection pooling is not used.',
      }),
    );

    // Act — should not throw
    await extractAndStore(job, db, noopClient).catch(() => {
      // Subsequent steps may throw; that is acceptable at this sub-task stage.
    });

    // Assert: if a row exists it must have non-empty raw_text (file was read)
    const row = await getExtractionRow(db, job.id);
    if (row !== null) {
      // The row exists — check raw_text is not the empty-string sentinel used
      // for absent-file failures, which would indicate a false file-read failure.
      const rawText = row['raw_text'] as string;
      expect(rawText.length).toBeGreaterThan(0);
    }
    // If row is null the function returned early (no LLM impl yet) — that's fine.
  });

  // -------------------------------------------------------------------------
  // In-flight guard — separate concern but verified here for completeness
  // -------------------------------------------------------------------------

  it('should not write a row when called concurrently for the same job (in-flight guard)', async () => {
    // Arrange — slow file so the first call is still in-flight when the second starts
    const job = makeJob({ id: 'job-inflight-001', mdFile: '/slow/output.md' });
    await seedJob(db, job);
    let resolveFile: ((v: string) => void) | undefined;
    const filePromise = new Promise<string>(resolve => {
      resolveFile = resolve;
    });

    jest.spyOn(Bun, 'file').mockReturnValue({
      exists: async () => true,
      text: () => filePromise,
    } as unknown as ReturnType<typeof Bun.file>);

    // Act — fire two concurrent calls; the second should be a no-op
    const first = extractAndStore(job, db, noopClient);
    const second = extractAndStore(job, db, noopClient); // should return immediately

    // Resolve the file read so the first call can complete
    resolveFile!('');
    await Promise.all([first, second]);

    // Assert — the second call was silently dropped (at most one row exists)
    const result = await db.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM memory_extraction WHERE job_id = ?',
      [job.id],
    );
    expect(result.rows[0]!.cnt).toBeLessThanOrEqual(1);
  });
});
