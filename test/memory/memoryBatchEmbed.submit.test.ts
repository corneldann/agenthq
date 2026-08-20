/**
 * Unit tests for `runBatch` — task 5.4 (Voyage Batch API submission).
 *
 * Covers the two behaviours specified in task 5.4:
 *   1. No pending rows → `submit` is never called; no DB side-effects.
 *   2. `submit` throws → error is logged, `embed_attempts` is NOT incremented,
 *      function returns cleanly without re-throwing.
 *
 * Strategy:
 *   - In-memory SQLite database with all migrations applied.
 *   - `runBatch` is exported from `memoryBatchEmbed.ts` specifically for
 *     testability (Option A from the task description).
 *   - A minimal stub object that satisfies the `VoyageBatchClient` shape is
 *     used in place of the real client — only `submit` and `poll` need to be
 *     present because the test is limited to the submission step.
 *   - No real Voyage API calls are made; no timer manipulation is required.
 *
 * Requirements: Phase 6.2, Requirement 3 AC 4–5 (batch submission / error
 * handling for submit failures).
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
// Stub factory — minimal VoyageBatchClient shape for submit-only tests
// ---------------------------------------------------------------------------

type SubmitResult = 'throw' | string; // 'throw' | batchId

/**
 * Build a stub that satisfies the `VoyageBatchClient` shape.
 *
 * @param submitResult  `'throw'` to simulate a submission failure, or a
 *                      string to return as the batch ID on success.
 * @param submitCalls   Mutable array that records each call's text array.
 */
function makeVoyageStub(
  submitResult: SubmitResult,
  submitCalls: string[][] = [],
): VoyageBatchClient {
  return {
    submit: async (texts: string[]): Promise<string> => {
      submitCalls.push(texts);
      if (submitResult === 'throw') {
        throw new Error('[stub] Voyage submit failed — simulated network error');
      }
      return submitResult;
    },
    poll: async (_batchId: string, _timeoutMs: number) => {
      // Should never be called in submit-path tests
      throw new Error('[stub] poll should not be called in submit tests');
    },
  } as unknown as VoyageBatchClient;
}

// ---------------------------------------------------------------------------
// DB seed helpers
// ---------------------------------------------------------------------------

/**
 * Insert a workspace row (required for FK constraints in some migrations).
 */
async function seedWorkspace(db: SQLiteAdapter, workspaceId: string): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO workspaces (id, output_dir, sessions_dir, created_at)
     VALUES (?, ?, ?, ?)`,
    [workspaceId, '/tmp/output', '/tmp/sessions', new Date().toISOString()],
  );
}

/**
 * Insert a job row (required for FK constraints on memory_extraction).
 */
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

/**
 * Insert a `memory_extraction` row with `embedding_status = 'pending'` and
 * the given `embed_attempts` count.
 */
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
      'Sample raw text for embedding batch test.',
      1, 0.85, 'pending', embedAttempts, 'cold', Date.now(),
    ],
  );
}

/**
 * Read back the `embed_attempts` value for a given job ID.
 * Returns `null` when no row exists.
 */
async function readEmbedAttempts(
  db: SQLiteAdapter,
  jobId: string,
): Promise<number | null> {
  const result = await db.query<{ embed_attempts: number }>(
    'SELECT embed_attempts FROM memory_extraction WHERE job_id = ?',
    [jobId],
  );
  return result.rows[0]?.embed_attempts ?? null;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('runBatch — task 5.4: Voyage batch submission behaviour', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await db.close();
  });

  // -------------------------------------------------------------------------
  // 1. No pending rows
  // -------------------------------------------------------------------------

  describe('no pending rows → submit never called', () => {
    it('should not call submit when there are no pending memory_extraction rows', async () => {
      // Arrange — empty DB (no pending rows)
      const submitCalls: string[][] = [];
      const stub = makeVoyageStub('batch-id-never-used', submitCalls);

      // Act
      await runBatch(db, stub);

      // Assert — submit was never called
      expect(submitCalls).toHaveLength(0);
    });

    it('should resolve cleanly when there are no pending rows', async () => {
      // Arrange — empty DB
      const stub = makeVoyageStub('batch-id-never-used');

      // Act + Assert — must not throw
      await expect(runBatch(db, stub)).resolves.toBeUndefined();
    });

    it('should not modify any rows when there are no pending rows', async () => {
      // Arrange — seed one 'embedded' row; it must remain untouched
      const workspaceId = 'ws-no-pending-001';
      const jobId = 'job-no-pending-001';
      await seedWorkspace(db, workspaceId);
      await seedJob(db, jobId, workspaceId);
      await db.execute(
        `INSERT INTO memory_extraction
           (job_id, workspace_id, extracted_at, raw_text, memory_count,
            quality_score, embedding_status, embed_attempts, tier, last_modified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [jobId, workspaceId, new Date().toISOString(), 'already embedded text',
         1, 0.9, 'embedded', 1, 'cold', Date.now()],
      );

      const stub = makeVoyageStub('batch-id-never-used');

      // Act
      await runBatch(db, stub);

      // Assert — embed_attempts stays at 1 (was not incremented)
      const attempts = await readEmbedAttempts(db, jobId);
      expect(attempts).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 2. submit throws → embed_attempts unchanged
  // -------------------------------------------------------------------------

  describe('submit throws → embed_attempts NOT incremented', () => {
    it('should not increment embed_attempts when submit throws', async () => {
      // Arrange — one pending row with embed_attempts = 0
      const workspaceId = 'ws-submit-fail-001';
      const jobId = 'job-submit-fail-001';
      await seedWorkspace(db, workspaceId);
      await seedJob(db, jobId, workspaceId);
      await seedPendingRow(db, jobId, workspaceId, 0);

      const stub = makeVoyageStub('throw');

      // Act
      await runBatch(db, stub);

      // Assert — embed_attempts remains 0 (spec: "do NOT increment embed_attempts")
      const attempts = await readEmbedAttempts(db, jobId);
      expect(attempts).toBe(0);
    });

    it('should return cleanly (not rethrow) when submit throws', async () => {
      // Arrange
      const workspaceId = 'ws-submit-fail-002';
      const jobId = 'job-submit-fail-002';
      await seedWorkspace(db, workspaceId);
      await seedJob(db, jobId, workspaceId);
      await seedPendingRow(db, jobId, workspaceId, 0);

      const stub = makeVoyageStub('throw');

      // Act + Assert — must resolve (not reject) even though submit threw
      await expect(runBatch(db, stub)).resolves.toBeUndefined();
    });

    it('should keep embedding_status as pending when submit throws', async () => {
      // Arrange
      const workspaceId = 'ws-submit-fail-003';
      const jobId = 'job-submit-fail-003';
      await seedWorkspace(db, workspaceId);
      await seedJob(db, jobId, workspaceId);
      await seedPendingRow(db, jobId, workspaceId, 0);

      const stub = makeVoyageStub('throw');

      // Act
      await runBatch(db, stub);

      // Assert — row still pending (not failed, not embedded)
      const result = await db.query<{ embedding_status: string }>(
        'SELECT embedding_status FROM memory_extraction WHERE job_id = ?',
        [jobId],
      );
      expect(result.rows[0]?.embedding_status).toBe('pending');
    });

    it('should not increment embed_attempts for any of multiple pending rows when submit throws', async () => {
      // Arrange — three pending rows, all with embed_attempts = 0
      const workspaceId = 'ws-submit-fail-multi';
      const jobs = ['job-multi-001', 'job-multi-002', 'job-multi-003'];
      await seedWorkspace(db, workspaceId);
      for (const jobId of jobs) {
        await seedJob(db, jobId, workspaceId);
        await seedPendingRow(db, jobId, workspaceId, 0);
      }

      const stub = makeVoyageStub('throw');

      // Act
      await runBatch(db, stub);

      // Assert — all three rows remain at embed_attempts = 0
      for (const jobId of jobs) {
        const attempts = await readEmbedAttempts(db, jobId);
        expect(attempts).toBe(0);
      }
    });

    it('should call submit with the raw_text values from pending rows', async () => {
      // Arrange — verify what submit receives (confirms query is correct even
      // though submit will throw; the call itself must have been made)
      const workspaceId = 'ws-submit-call-check';
      const jobId = 'job-submit-call-check';
      await seedWorkspace(db, workspaceId);
      await seedJob(db, jobId, workspaceId);

      const expectedText = 'Specific raw text for call-check test.';
      await db.execute(
        `INSERT INTO memory_extraction
           (job_id, workspace_id, extracted_at, raw_text, memory_count,
            quality_score, embedding_status, embed_attempts, tier, last_modified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [jobId, workspaceId, new Date().toISOString(), expectedText,
         1, 0.9, 'pending', 0, 'cold', Date.now()],
      );

      const submitCalls: string[][] = [];
      const stub = makeVoyageStub('throw', submitCalls);

      // Act
      await runBatch(db, stub);

      // Assert — submit was called once, with the expected text
      expect(submitCalls).toHaveLength(1);
      expect(submitCalls[0]).toEqual([expectedText]);
    });
  });
});
