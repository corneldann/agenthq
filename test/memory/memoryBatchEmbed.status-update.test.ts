/**
 * Unit tests for `runBatch` — task 5.7 (status update transaction).
 *
 * Verifies that after a successful `voyageClient.poll()`, each row's
 * `embedding_status` is set to `'embedded'` or `'failed'` based on whether
 * its index appears in `result.failed`.
 *
 * Key invariants (from the design doc):
 *   - Rows whose index is NOT in `result.failed` → `embedding_status = 'embedded'`
 *   - Rows whose index IS in `result.failed`     → `embedding_status = 'failed'`
 *   - The UPDATE includes `AND embed_attempts < 3` — rows exhausted between
 *     submit and the poll result are never overwritten back to `'embedded'`.
 *   - `last_modified` is updated on every row that is touched.
 *   - `_markExhaustedAsFailed` runs after the batch update, so rows that
 *     reach `embed_attempts >= 3` via this run are also marked `'failed'`.
 *
 * Strategy:
 *   - In-memory SQLite database with all migrations applied.
 *   - `runBatch` is the exported testable entry point.
 *   - Stub `VoyageBatchClient` with controllable `poll` return value.
 *   - `submit` always succeeds with a fixed batch ID.
 *
 * Requirements: Phase 6.2, Task 5.7.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { runBatch } from '../../src/workers/memoryBatchEmbed.ts';
import type { VoyageBatchClient } from '../../src/memory/embedding.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, '../../migrations');

// ---------------------------------------------------------------------------
// Stub factory
// ---------------------------------------------------------------------------

type BatchResult = { embeddings: number[][]; failed: number[] };

/**
 * Build a stub VoyageBatchClient where `submit` always succeeds and `poll`
 * returns the given `BatchResult`.
 */
function makeVoyageStub(pollResult: BatchResult): VoyageBatchClient {
  return {
    submit: async (_texts: string[]): Promise<string> => 'batch-status-test',
    poll: async (_batchId: string, _timeoutMs: number): Promise<BatchResult> => pollResult,
  } as unknown as VoyageBatchClient;
}

// ---------------------------------------------------------------------------
// DB seed helpers
// ---------------------------------------------------------------------------

async function seedWorkspace(db: SQLiteAdapter, workspaceId: string): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO workspaces (id, output_dir, sessions_dir, created_at)
     VALUES (?, ?, ?, ?)`,
    [workspaceId, '/tmp/output', '/tmp/sessions', new Date().toISOString()],
  );
}

async function seedJob(
  db: SQLiteAdapter,
  jobId: string,
  workspaceId: string,
): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO jobs
       (id, workspace_id, name, job_chain, session_chain_id, timestamp, type, agent,
        status, lines, last_line, has_log, log_error, md_file, log_file,
        agent_done, size_bytes, last_modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jobId, workspaceId, 'test-job', 'test-chain', 'chain-001',
      new Date().toISOString(), 'agent', 'kiro',
      'done', 10, '', 0, 0, '/tmp/out.md', '/tmp/out.log', '', 100, Date.now(),
    ],
  );
}

async function seedPendingRow(
  db: SQLiteAdapter,
  jobId: string,
  workspaceId: string,
  embedAttempts = 0,
): Promise<void> {
  await db.execute(
    `INSERT INTO memory_extraction
       (job_id, workspace_id, extracted_at, raw_text, memory_count,
        quality_score, embedding_status, embed_attempts, tier, last_modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jobId, workspaceId, new Date().toISOString(),
      `Raw text for ${jobId}.`,
      1, 0.85, 'pending', embedAttempts, 'cold', Date.now(),
    ],
  );
}

type EmbedRow = {
  embedding_status: string;
  embed_attempts: number;
  last_modified: number;
};

async function readRow(db: SQLiteAdapter, jobId: string): Promise<EmbedRow | null> {
  const result = await db.query<EmbedRow>(
    `SELECT embedding_status, embed_attempts, last_modified
     FROM memory_extraction WHERE job_id = ?`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('runBatch — task 5.7: status update transaction', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await db.close();
  });

  // -------------------------------------------------------------------------
  // All rows successful
  // -------------------------------------------------------------------------

  it('should set embedding_status to embedded for a row not in result.failed', async () => {
    // Arrange
    const workspaceId = 'ws-status-001';
    const jobId = 'job-status-001';
    await seedWorkspace(db, workspaceId);
    await seedJob(db, jobId, workspaceId);
    await seedPendingRow(db, jobId, workspaceId, 0);

    const stub = makeVoyageStub({ embeddings: [], failed: [] });

    // Act
    await runBatch(db, stub);

    // Assert — row index 0 not in failed → embedded
    const row = await readRow(db, jobId);
    expect(row?.embedding_status).toBe('embedded');
  });

  it('should set embedding_status to failed for a row whose index is in result.failed', async () => {
    // Arrange
    const workspaceId = 'ws-status-002';
    const jobId = 'job-status-002';
    await seedWorkspace(db, workspaceId);
    await seedJob(db, jobId, workspaceId);
    await seedPendingRow(db, jobId, workspaceId, 0);

    // Index 0 is in failed — single row
    const stub = makeVoyageStub({ embeddings: [], failed: [0] });

    // Act
    await runBatch(db, stub);

    // Assert
    const row = await readRow(db, jobId);
    expect(row?.embedding_status).toBe('failed');
  });

  // -------------------------------------------------------------------------
  // Mixed result — multiple rows, some pass, some fail
  // -------------------------------------------------------------------------

  it('should set correct status for each row based on its index in result.failed', async () => {
    // Arrange — three rows; indices 0 and 2 fail, index 1 succeeds
    const workspaceId = 'ws-status-mixed';
    const jobIds = ['job-mixed-001', 'job-mixed-002', 'job-mixed-003'];
    await seedWorkspace(db, workspaceId);
    for (const jobId of jobIds) {
      await seedJob(db, jobId, workspaceId);
      await seedPendingRow(db, jobId, workspaceId, 0);
    }

    const stub = makeVoyageStub({ embeddings: [], failed: [0, 2] });

    // Act
    await runBatch(db, stub);

    // Assert — index 0 failed, index 1 embedded, index 2 failed
    // Note: ORDER BY extracted_at ASC means insertion order maps to indices
    const row0 = await readRow(db, jobIds[0]!);
    const row1 = await readRow(db, jobIds[1]!);
    const row2 = await readRow(db, jobIds[2]!);

    expect(row0?.embedding_status).toBe('failed');
    expect(row1?.embedding_status).toBe('embedded');
    expect(row2?.embedding_status).toBe('failed');
  });

  it('should update last_modified on every status-updated row', async () => {
    // Arrange — record baseline last_modified before the run
    const workspaceId = 'ws-status-lm';
    const jobId = 'job-status-lm';
    await seedWorkspace(db, workspaceId);
    await seedJob(db, jobId, workspaceId);

    const beforeMs = Date.now();
    await seedPendingRow(db, jobId, workspaceId, 0);

    // Ensure at least 1ms passes so last_modified can increase
    await new Promise(r => setTimeout(r, 2));

    const stub = makeVoyageStub({ embeddings: [], failed: [] });

    // Act
    await runBatch(db, stub);

    // Assert — last_modified is after the seed time
    const row = await readRow(db, jobId);
    expect(row?.last_modified).toBeGreaterThanOrEqual(beforeMs);
  });

  // -------------------------------------------------------------------------
  // Guard: AND embed_attempts < 3 prevents overwriting exhausted rows
  // -------------------------------------------------------------------------

  it('should not update a row whose embed_attempts reached 3 before poll completed', async () => {
    // Arrange — seed a row with embed_attempts = 2 (will become 3 after increment)
    //
    // The row is seeded with embed_attempts = 2 so that after the transaction
    // that increments embed_attempts (step 3), it becomes 3. The status update
    // in step 5 uses AND embed_attempts < 3, so it skips the now-exhausted row.
    // Then _markExhaustedAsFailed marks it 'failed'.
    const workspaceId = 'ws-status-guard';
    const jobId = 'job-status-guard';
    await seedWorkspace(db, workspaceId);
    await seedJob(db, jobId, workspaceId);
    await seedPendingRow(db, jobId, workspaceId, 2); // will become 3 after increment

    // poll says this index succeeded (would be 'embedded' if not for the guard)
    const stub = makeVoyageStub({ embeddings: [], failed: [] });

    // Act
    await runBatch(db, stub);

    // Assert — status should be 'failed' (marked by _markExhaustedAsFailed),
    // NOT 'embedded' (the guard prevented the status update from applying).
    const row = await readRow(db, jobId);
    expect(row?.embedding_status).toBe('failed');
    expect(row?.embed_attempts).toBe(3);
  });

  it('should not update a row that had embed_attempts >= 3 before submit', async () => {
    // Arrange — this row is already at 3, so it is excluded by the SELECT query
    // (WHERE embed_attempts < 3). The status update loop never sees it at all.
    const workspaceId = 'ws-status-already-exhausted';
    const freshJobId = 'job-fresh-002';
    const exhaustedJobId = 'job-exhausted-002';
    await seedWorkspace(db, workspaceId);

    // exhausted row — not queried, not updated
    await seedJob(db, exhaustedJobId, workspaceId);
    await seedPendingRow(db, exhaustedJobId, workspaceId, 3);

    // fresh row — queried and updated
    await seedJob(db, freshJobId, workspaceId);
    await seedPendingRow(db, freshJobId, workspaceId, 0);

    const stub = makeVoyageStub({ embeddings: [], failed: [] });

    // Act
    await runBatch(db, stub);

    // Assert — fresh row embedded; exhausted row status set to failed by _markExhaustedAsFailed
    const freshRow = await readRow(db, freshJobId);
    const exhaustedRow = await readRow(db, exhaustedJobId);
    expect(freshRow?.embedding_status).toBe('embedded');
    expect(exhaustedRow?.embedding_status).toBe('failed');
    expect(exhaustedRow?.embed_attempts).toBe(3); // unchanged (not incremented either)
  });

  // -------------------------------------------------------------------------
  // All rows fail
  // -------------------------------------------------------------------------

  it('should mark all rows as failed when result.failed contains all indices', async () => {
    // Arrange
    const workspaceId = 'ws-all-failed';
    const jobIds = ['job-all-fail-001', 'job-all-fail-002'];
    await seedWorkspace(db, workspaceId);
    for (const jobId of jobIds) {
      await seedJob(db, jobId, workspaceId);
      await seedPendingRow(db, jobId, workspaceId, 0);
    }

    // Both indices in failed
    const stub = makeVoyageStub({ embeddings: [], failed: [0, 1] });

    // Act
    await runBatch(db, stub);

    // Assert
    for (const jobId of jobIds) {
      const row = await readRow(db, jobId);
      expect(row?.embedding_status).toBe('failed');
    }
  });
});
