/**
 * Unit tests for `runBatch` — task 5.5 (embed_attempts increment transaction).
 *
 * Verifies that `embed_attempts` is incremented exactly once, inside a DB
 * transaction, AFTER a successful `submit()` call and BEFORE `poll()` is called.
 *
 * Key invariants (from Requirement 3 AC 8):
 *   - `embed_attempts` is incremented only for rows that were actually included
 *     in a batch submitted to the Voyage Batch API.
 *   - Rows in a batch that fails before submission (submit throws) shall NOT
 *     have their `embed_attempts` incremented.
 *   - The increment runs after `submit` succeeds and before `poll` runs.
 *
 * Strategy:
 *   - In-memory SQLite database with all migrations applied.
 *   - `runBatch` is the exported testable entry point.
 *   - Stub `VoyageBatchClient` with controllable `submit` and `poll` behaviour.
 *   - `poll` is stubbed to resolve immediately so tests don't block.
 *
 * Requirements: Phase 6.2, Requirement 3 AC 8.
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

type PollBehaviour = 'resolve' | 'reject';

/**
 * Build a stub VoyageBatchClient.
 *
 * @param batchId       The batch ID to return from `submit`.
 * @param pollBehaviour Whether `poll` resolves (success) or rejects (timeout).
 * @param onAfterSubmit Optional callback invoked after `submit` resolves, before
 *                      the test continues — used to observe state between submit
 *                      and poll.
 */
function makeVoyageStub(
  batchId: string,
  pollBehaviour: PollBehaviour,
  onAfterSubmit?: () => Promise<void>,
): VoyageBatchClient {
  return {
    submit: async (_texts: string[]): Promise<string> => {
      const id = batchId;
      if (onAfterSubmit) {
        await onAfterSubmit();
      }
      return id;
    },
    poll: async (_batchId: string, _timeoutMs: number) => {
      if (pollBehaviour === 'reject') {
        throw new Error('[stub] poll timed out');
      }
      return { embeddings: [], failed: [] };
    },
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
      'Sample raw text for embed_attempts test.',
      1, 0.85, 'pending', embedAttempts, 'cold', Date.now(),
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
// Suite
// ---------------------------------------------------------------------------

describe('runBatch — task 5.5: embed_attempts increment transaction', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await db.close();
  });

  // -------------------------------------------------------------------------
  // Core: increment on successful submit
  // -------------------------------------------------------------------------

  it('should increment embed_attempts by 1 after a successful submit', async () => {
    // Arrange
    const workspaceId = 'ws-inc-001';
    const jobId = 'job-inc-001';
    await seedWorkspace(db, workspaceId);
    await seedJob(db, jobId, workspaceId);
    await seedPendingRow(db, jobId, workspaceId, 0);

    const stub = makeVoyageStub('batch-001', 'resolve');

    // Act
    await runBatch(db, stub);

    // Assert — embed_attempts is now 1
    const row = await readRow(db, jobId);
    expect(row?.embed_attempts).toBe(1);
  });

  it('should increment embed_attempts for all rows in the submitted batch', async () => {
    // Arrange — three pending rows
    const workspaceId = 'ws-inc-multi';
    const jobs = ['job-multi-inc-001', 'job-multi-inc-002', 'job-multi-inc-003'];
    await seedWorkspace(db, workspaceId);
    for (const jobId of jobs) {
      await seedJob(db, jobId, workspaceId);
      await seedPendingRow(db, jobId, workspaceId, 0);
    }

    const stub = makeVoyageStub('batch-multi', 'resolve');

    // Act
    await runBatch(db, stub);

    // Assert — all three rows have embed_attempts = 1
    for (const jobId of jobs) {
      const row = await readRow(db, jobId);
      expect(row?.embed_attempts).toBe(1);
    }
  });

  it('should accumulate embed_attempts across runs (each run adds 1)', async () => {
    // Arrange — row starting at embed_attempts = 1 (already had one submission)
    const workspaceId = 'ws-inc-accum';
    const jobId = 'job-inc-accum';
    await seedWorkspace(db, workspaceId);
    await seedJob(db, jobId, workspaceId);
    await seedPendingRow(db, jobId, workspaceId, 1);

    const stub = makeVoyageStub('batch-accum', 'resolve');

    // Act
    await runBatch(db, stub);

    // Assert — embed_attempts is now 2 (was 1, incremented by 1)
    const row = await readRow(db, jobId);
    expect(row?.embed_attempts).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Ordering: increment happens before poll
  // -------------------------------------------------------------------------

  it('should have already incremented embed_attempts when poll is called', async () => {
    // Arrange — we'll read embed_attempts inside poll to confirm ordering
    const workspaceId = 'ws-order-001';
    const jobId = 'job-order-001';
    await seedWorkspace(db, workspaceId);
    await seedJob(db, jobId, workspaceId);
    await seedPendingRow(db, jobId, workspaceId, 0);

    let attemptsAtPollTime: number | undefined;

    const stub: VoyageBatchClient = {
      submit: async (_texts: string[]): Promise<string> => 'batch-order',
      poll: async (_batchId: string, _timeoutMs: number) => {
        // Read embed_attempts while poll is executing — it must already be 1
        const result = await db.query<{ embed_attempts: number }>(
          'SELECT embed_attempts FROM memory_extraction WHERE job_id = ?',
          [jobId],
        );
        attemptsAtPollTime = result.rows[0]?.embed_attempts;
        return { embeddings: [], failed: [] };
      },
    } as unknown as VoyageBatchClient;

    // Act
    await runBatch(db, stub);

    // Assert — at poll time, embed_attempts was already 1 (not still 0)
    expect(attemptsAtPollTime).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Exclusion: rows with embed_attempts >= 3 are not queried
  // -------------------------------------------------------------------------

  it('should not include rows with embed_attempts >= 3 in the batch', async () => {
    // Arrange — one exhausted row (attempts = 3) and one fresh row (attempts = 0)
    const workspaceId = 'ws-excl-001';
    const exhaustedJobId = 'job-exhausted-001';
    const freshJobId = 'job-fresh-001';
    await seedWorkspace(db, workspaceId);
    await seedJob(db, exhaustedJobId, workspaceId);
    await seedJob(db, freshJobId, workspaceId);
    await seedPendingRow(db, exhaustedJobId, workspaceId, 3);
    await seedPendingRow(db, freshJobId, workspaceId, 0);

    const submittedTexts: string[] = [];
    const stub: VoyageBatchClient = {
      submit: async (texts: string[]): Promise<string> => {
        submittedTexts.push(...texts);
        return 'batch-excl';
      },
      poll: async () => ({ embeddings: [], failed: [] }),
    } as unknown as VoyageBatchClient;

    // Act
    await runBatch(db, stub);

    // Assert — only one text submitted (the fresh row); exhausted row excluded
    expect(submittedTexts).toHaveLength(1);

    // Exhausted row embed_attempts stays at 3 (not incremented further)
    const exhaustedRow = await readRow(db, exhaustedJobId);
    expect(exhaustedRow?.embed_attempts).toBe(3);

    // Fresh row embed_attempts goes to 1
    const freshRow = await readRow(db, freshJobId);
    expect(freshRow?.embed_attempts).toBe(1);
  });

  // -------------------------------------------------------------------------
  // No increment on submit failure (cross-check with task 5.4)
  // -------------------------------------------------------------------------

  it('should NOT increment embed_attempts when submit throws', async () => {
    // Arrange
    const workspaceId = 'ws-no-inc-001';
    const jobId = 'job-no-inc-001';
    await seedWorkspace(db, workspaceId);
    await seedJob(db, jobId, workspaceId);
    await seedPendingRow(db, jobId, workspaceId, 0);

    const stub: VoyageBatchClient = {
      submit: async (_texts: string[]): Promise<string> => {
        throw new Error('[stub] submit failed');
      },
      poll: async () => ({ embeddings: [], failed: [] }),
    } as unknown as VoyageBatchClient;

    // Act
    await runBatch(db, stub);

    // Assert — embed_attempts remains 0
    const row = await readRow(db, jobId);
    expect(row?.embed_attempts).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Poll failure: embed_attempts still incremented (increment was before poll)
  // -------------------------------------------------------------------------

  it('should retain incremented embed_attempts even when poll fails', async () => {
    // Arrange
    const workspaceId = 'ws-poll-fail-001';
    const jobId = 'job-poll-fail-001';
    await seedWorkspace(db, workspaceId);
    await seedJob(db, jobId, workspaceId);
    await seedPendingRow(db, jobId, workspaceId, 0);

    const stub = makeVoyageStub('batch-poll-fail', 'reject');

    // Act — poll throws but runBatch should not re-throw
    await runBatch(db, stub);

    // Assert — embed_attempts was incremented (submit succeeded before poll failed)
    const row = await readRow(db, jobId);
    expect(row?.embed_attempts).toBe(1);
  });
});
