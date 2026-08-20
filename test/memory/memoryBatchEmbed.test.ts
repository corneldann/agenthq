/**
 * Consolidated unit tests for `runBatch` — task 5.10.
 *
 * Covers all five behavioural requirements in a single focused suite:
 *   1. Empty rows → submit never called
 *   2. submit throws → no embed_attempts increment
 *   3. Poll timeout → exhausted rows (attempts=3) marked failed, others stay pending
 *   4. Success → correct embedding_status per Voyage result index
 *   5. embed_attempts=3 rows excluded from the batch query
 *
 * Strategy:
 *   - In-memory SQLite database with all migrations applied.
 *   - `runBatch` exported from `memoryBatchEmbed.ts` for direct invocation.
 *   - Stub VoyageBatchClient — only `submit` and `poll` need to be present.
 *   - No real Voyage API calls; no timer manipulation required.
 *
 * Requirements: Phase 6.2, Requirement 3 AC 4–5, AC 8.
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
  rawText = 'Sample raw text.',
  extractedAtOffset = 0,
): Promise<void> {
  await db.execute(
    `INSERT INTO memory_extraction
       (job_id, workspace_id, extracted_at, raw_text, memory_count,
        quality_score, embedding_status, embed_attempts, tier, last_modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jobId, workspaceId,
      new Date(Date.now() + extractedAtOffset).toISOString(),
      rawText, 1, 0.85, 'pending', embedAttempts, 'cold', Date.now(),
    ],
  );
}

async function readRow(
  db: SQLiteAdapter,
  jobId: string,
): Promise<{ embed_attempts: number; embedding_status: string } | null> {
  const result = await db.query<{ embed_attempts: number; embedding_status: string }>(
    'SELECT embed_attempts, embedding_status FROM memory_extraction WHERE job_id = ?',
    [jobId],
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

/** Build a stub that tracks submit call arguments and controls poll behaviour. */
function makeStub(opts: {
  submitResult: 'throw' | string;
  pollResult: 'throw' | { embeddings: number[][]; failed: number[] };
  submittedTexts?: string[];
}): VoyageBatchClient {
  return {
    submit: async (texts: string[]): Promise<string> => {
      if (opts.submittedTexts) {
        opts.submittedTexts.push(...texts);
      }
      if (opts.submitResult === 'throw') {
        throw new Error('[stub] submit failed');
      }
      return opts.submitResult;
    },
    poll: async (_batchId: string, _timeoutMs: number) => {
      if (opts.pollResult === 'throw') {
        throw new Error('[stub] poll timed out');
      }
      return opts.pollResult;
    },
  } as unknown as VoyageBatchClient;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('runBatch — task 5.10: consolidated behavioural tests', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await db.close();
  });

  // -------------------------------------------------------------------------
  // 1. Empty rows → no Voyage call
  // -------------------------------------------------------------------------

  describe('empty rows → submit never called', () => {
    it('should not call submit when there are no pending rows', async () => {
      // Arrange — DB with no pending rows
      const submittedTexts: string[] = [];
      const stub = makeStub({
        submitResult: 'batch-never',
        pollResult: { embeddings: [], failed: [] },
        submittedTexts,
      });

      // Act
      await runBatch(db, stub);

      // Assert
      expect(submittedTexts).toHaveLength(0);
    });

    it('should resolve cleanly when there are no pending rows', async () => {
      // Arrange — DB with one already-embedded row (must not be selected)
      const workspaceId = 'ws-empty-001';
      const jobId = 'job-empty-001';
      await seedWorkspace(db, workspaceId);
      await seedJob(db, jobId, workspaceId);
      await db.execute(
        `INSERT INTO memory_extraction
           (job_id, workspace_id, extracted_at, raw_text, memory_count,
            quality_score, embedding_status, embed_attempts, tier, last_modified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [jobId, workspaceId, new Date().toISOString(), 'already embedded',
         1, 0.9, 'embedded', 1, 'cold', Date.now()],
      );

      const stub = makeStub({
        submitResult: 'batch-never',
        pollResult: { embeddings: [], failed: [] },
      });

      // Act + Assert — must not throw
      await expect(runBatch(db, stub)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 2. submit throws → no embed_attempts increment
  // -------------------------------------------------------------------------

  describe('submit throws → embed_attempts not incremented', () => {
    it('should keep embed_attempts at 0 and status as pending when submit throws', async () => {
      // Arrange
      const workspaceId = 'ws-throw-001';
      const jobId = 'job-throw-001';
      await seedWorkspace(db, workspaceId);
      await seedJob(db, jobId, workspaceId);
      await seedPendingRow(db, jobId, workspaceId, 0);

      const stub = makeStub({ submitResult: 'throw', pollResult: { embeddings: [], failed: [] } });

      // Act
      await runBatch(db, stub);

      // Assert
      const row = await readRow(db, jobId);
      expect(row?.embed_attempts).toBe(0);
      expect(row?.embedding_status).toBe('pending');
    });

    it('should resolve without throwing when submit throws', async () => {
      // Arrange
      const workspaceId = 'ws-throw-002';
      const jobId = 'job-throw-002';
      await seedWorkspace(db, workspaceId);
      await seedJob(db, jobId, workspaceId);
      await seedPendingRow(db, jobId, workspaceId, 0);

      const stub = makeStub({ submitResult: 'throw', pollResult: { embeddings: [], failed: [] } });

      // Act + Assert — must not rethrow
      await expect(runBatch(db, stub)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Poll timeout → exhausted rows failed, others pending
  // -------------------------------------------------------------------------

  describe('poll timeout → exhausted rows failed, others stay pending', () => {
    it('should mark embed_attempts=2 row as failed and leave embed_attempts=0 row pending after poll timeout', async () => {
      // Arrange
      //   Row A — embed_attempts=2: submit increments to 3 → exhausted → _markExhaustedAsFailed sets 'failed'
      //   Row B — embed_attempts=0: submit increments to 1 → not exhausted → stays 'pending'
      const workspaceId = 'ws-poll-timeout';
      const jobIdA = 'job-timeout-exhausted';
      const jobIdB = 'job-timeout-fresh';
      await seedWorkspace(db, workspaceId);
      await seedJob(db, jobIdA, workspaceId);
      await seedJob(db, jobIdB, workspaceId);
      await seedPendingRow(db, jobIdA, workspaceId, 2, 'exhausted row text', 0);
      await seedPendingRow(db, jobIdB, workspaceId, 0, 'fresh row text', 10);

      const stub = makeStub({ submitResult: 'batch-timeout', pollResult: 'throw' });

      // Act
      await runBatch(db, stub);

      // Assert — Row A: incremented to 3, marked failed
      const rowA = await readRow(db, jobIdA);
      expect(rowA?.embed_attempts).toBe(3);
      expect(rowA?.embedding_status).toBe('failed');

      // Assert — Row B: incremented to 1, stays pending
      const rowB = await readRow(db, jobIdB);
      expect(rowB?.embed_attempts).toBe(1);
      expect(rowB?.embedding_status).toBe('pending');
    });

    it('should resolve without throwing when poll times out', async () => {
      // Arrange
      const workspaceId = 'ws-poll-resolve';
      const jobId = 'job-poll-resolve';
      await seedWorkspace(db, workspaceId);
      await seedJob(db, jobId, workspaceId);
      await seedPendingRow(db, jobId, workspaceId, 0);

      const stub = makeStub({ submitResult: 'batch-resolve', pollResult: 'throw' });

      // Act + Assert — must not rethrow
      await expect(runBatch(db, stub)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Success → correct embedding_status per Voyage result index
  // -------------------------------------------------------------------------

  describe('success → correct status per index', () => {
    it('should set embedded/failed status per Voyage result index', async () => {
      // Arrange — three rows in deterministic extracted_at order (indices 0, 1, 2)
      const workspaceId = 'ws-success-status';
      const jobs = [
        { id: 'job-status-0', text: 'row text 0', offset: 0 },
        { id: 'job-status-1', text: 'row text 1', offset: 10 },
        { id: 'job-status-2', text: 'row text 2', offset: 20 },
      ];
      await seedWorkspace(db, workspaceId);
      for (const j of jobs) {
        await seedJob(db, j.id, workspaceId);
        await seedPendingRow(db, j.id, workspaceId, 0, j.text, j.offset);
      }

      // Index 1 fails in Voyage response; indices 0 and 2 succeed.
      const stub = makeStub({
        submitResult: 'batch-success',
        pollResult: { embeddings: [[], []], failed: [1] },
      });

      // Act
      await runBatch(db, stub);

      // Assert — rows ordered by extracted_at ASC map 1:1 to job insertion order
      const row0 = await readRow(db, 'job-status-0');
      const row1 = await readRow(db, 'job-status-1');
      const row2 = await readRow(db, 'job-status-2');

      expect(row0?.embedding_status).toBe('embedded');
      expect(row1?.embedding_status).toBe('failed');
      expect(row2?.embedding_status).toBe('embedded');
    });
  });

  // -------------------------------------------------------------------------
  // 5. embed_attempts=3 rows excluded from query
  // -------------------------------------------------------------------------

  describe('embed_attempts=3 rows excluded from batch query', () => {
    it('should only submit the fresh row and leave the exhausted row unchanged', async () => {
      // Arrange
      const workspaceId = 'ws-excl-001';
      const exhaustedId = 'job-excl-exhausted';
      const freshId = 'job-excl-fresh';
      await seedWorkspace(db, workspaceId);
      await seedJob(db, exhaustedId, workspaceId);
      await seedJob(db, freshId, workspaceId);

      const freshText = 'Only this text should be submitted.';
      await seedPendingRow(db, exhaustedId, workspaceId, 3, 'exhausted row — must not be submitted', 0);
      await seedPendingRow(db, freshId, workspaceId, 0, freshText, 10);

      const submittedTexts: string[] = [];
      const stub = makeStub({
        submitResult: 'batch-excl',
        pollResult: { embeddings: [], failed: [] },
        submittedTexts,
      });

      // Act
      await runBatch(db, stub);

      // Assert — only the fresh row's text was submitted
      expect(submittedTexts).toHaveLength(1);
      expect(submittedTexts[0]).toBe(freshText);

      // Exhausted row embed_attempts must remain 3 (not incremented further)
      const exhaustedRow = await readRow(db, exhaustedId);
      expect(exhaustedRow?.embed_attempts).toBe(3);

      // Fresh row embed_attempts incremented to 1
      const freshRow = await readRow(db, freshId);
      expect(freshRow?.embed_attempts).toBe(1);
    });
  });
});
