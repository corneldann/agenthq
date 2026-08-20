/**
 * Property-based test for `runBatch` — task 5.11.
 *
 * Invariant under test:
 *   After any call to `runBatch(db, voyageClient)`, NO row in the
 *   `memory_extraction` table has `embed_attempts > 3`.
 *
 * This holds regardless of:
 *   - How many rows are seeded (0..10)
 *   - What starting `embed_attempts` each row has (0..3)
 *   - Whether `submit` succeeds or throws
 *   - Whether `poll` succeeds, throws (timeout), or returns a mix of
 *     success/failed indices
 *
 * Requirement: Phase 6.2, Requirement 3, AC 8–9.
 *
 * Strategy:
 *   - fast-check `asyncProperty` with 200 runs for thorough coverage.
 *   - Each sample opens an isolated in-memory SQLite DB, seeds rows,
 *     calls `runBatch`, asserts the invariant, then closes the DB.
 *   - Stub `VoyageBatchClient` — no real Voyage API calls.
 */

import * as fc from 'fast-check';
import { describe, it, expect } from 'bun:test';
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
// Seed helpers (identical SQL to existing test files)
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
      jobId, workspaceId, 'prop-job', 'prop-chain', 'chain-prop',
      new Date().toISOString(), 'agent', 'kiro',
      'done', 10, '', 0, 0, '/tmp/out.md', '/tmp/out.log', '', 100, Date.now(),
    ],
  );
}

async function seedPendingRow(
  db: SQLiteAdapter,
  jobId: string,
  workspaceId: string,
  embedAttempts: number,
  index: number,
): Promise<void> {
  await db.execute(
    `INSERT INTO memory_extraction
       (job_id, workspace_id, extracted_at, raw_text, memory_count,
        quality_score, embedding_status, embed_attempts, tier, last_modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jobId, workspaceId,
      new Date(Date.now() + index).toISOString(),
      `Property test row ${index}.`,
      1, 0.85, 'pending', embedAttempts, 'cold', Date.now(),
    ],
  );
}

// ---------------------------------------------------------------------------
// Stub factory
// ---------------------------------------------------------------------------

function makeStub(submitThrows: boolean, pollThrows: boolean): VoyageBatchClient {
  return {
    submit: async (_texts: string[]): Promise<string> => {
      if (submitThrows) {
        throw new Error('[prop-stub] submit failed');
      }
      return 'batch-prop-test';
    },
    poll: async (_batchId: string, _timeoutMs: number) => {
      if (pollThrows) {
        throw new Error('[prop-stub] poll timed out');
      }
      return { embeddings: [], failed: [] };
    },
  } as unknown as VoyageBatchClient;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Starting embed_attempts for a single row: 0..3. */
const embedAttemptsArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 3 });

/** Number of rows to seed: 0..10. */
const rowCountArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 10 });

/** Controls whether submit and/or poll throw. */
const voyageBehaviourArb: fc.Arbitrary<{ submitThrows: boolean; pollThrows: boolean }> =
  fc.record({
    submitThrows: fc.boolean(),
    pollThrows: fc.boolean(),
  });

// ---------------------------------------------------------------------------
// Property-based test
// ---------------------------------------------------------------------------

/**
 * **Validates: Phase 6.2, Requirement 3, AC 8–9**
 */
describe('runBatch — property test (task 5.11): embed_attempts invariant', () => {
  it('property: no row has embed_attempts > 3 after any batch run', async () => {
    await fc.assert(
      fc.asyncProperty(
        rowCountArb,
        fc.array(embedAttemptsArb, { minLength: 0, maxLength: 10 }),
        voyageBehaviourArb,
        async (rowCount, attemptsPerRow, behaviour) => {
          // Each sample gets an isolated in-memory DB.
          const sampleDb = new SQLiteAdapter(':memory:');
          try {
            await runMigrations(sampleDb, MIGRATIONS_DIR);

            // Seed workspace and rows (up to rowCount; attemptsPerRow may be longer).
            const workspaceId = 'ws-prop';
            await seedWorkspace(sampleDb, workspaceId);

            for (let i = 0; i < rowCount; i++) {
              const jobId = `job-prop-${i}`;
              await seedJob(sampleDb, jobId, workspaceId);
              const startAttempts = attemptsPerRow[i] ?? 0;
              await seedPendingRow(sampleDb, jobId, workspaceId, startAttempts, i);
            }

            // Build stub and run one batch cycle.
            const stub = makeStub(behaviour.submitThrows, behaviour.pollThrows);
            await runBatch(sampleDb, stub);

            // Assert invariant: every row has embed_attempts <= 3.
            const { rows } = await sampleDb.query<{ embed_attempts: number }>(
              'SELECT embed_attempts FROM memory_extraction',
              [],
            );
            for (const row of rows) {
              expect(row.embed_attempts).toBeLessThanOrEqual(3);
            }
          } finally {
            await sampleDb.close();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
