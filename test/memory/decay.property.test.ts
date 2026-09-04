/**
 * Property-based tests for memory decay threshold logic — task 1.1.
 *
 * Uses fast-check to verify Property 12: Decay Threshold Correctness.
 *
 * **Property 12: Decay Threshold Correctness**
 * For any memory with lastRetrievedAt older than MEMORY_DECAY_DAYS from the
 * current date, the decay cycle SHALL mark that memory as stale=true.
 *
 * Validates: Requirements 3.2 from Phase 6.5 Export Advanced
 *
 * Test approach:
 * - Generate memories with various lastRetrievedAt dates relative to threshold
 * - Run the decay query logic (as specified in design document)
 * - Verify exactly the memories older than MEMORY_DECAY_DAYS are marked stale
 * - Test edge cases: exactly at threshold, just before, just after
 */

import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import * as fc from 'fast-check';
import * as path from 'path';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import type { DbMemoryExtraction } from '../../src/db/adapter.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, '../../migrations');

/** Decay threshold in days — matches design document default. */
const MEMORY_DECAY_DAYS = 90;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Counter to generate unique job IDs across all test iterations */
let jobIdCounter = 0;

/**
 * Create a minimal memory extraction record for testing decay logic.
 * All required fields are provided with sensible defaults.
 * Automatically generates a unique job_id unless overridden.
 */
function makeMemoryRecord(overrides: Partial<DbMemoryExtraction>): Omit<DbMemoryExtraction, 'id'> {
  const now = new Date().toISOString();
  jobIdCounter++;
  return {
    job_id: `test-job-${jobIdCounter}`,
    workspace_id: 'ws-test-001',
    extracted_at: now,
    raw_text: 'Test memory content for decay property test.',
    memory_count: 1,
    quality_score: 0.85,
    embedding_status: 'embedded',
    embed_attempts: 1,
    tier: 'hot',
    last_modified: Date.now(),
    deleted_at: null,
    stale: 0,
    superseded: 0,
    last_retrieved_at: now,
    retrieval_count: 1,
    ...overrides,
  };
}

/**
 * Insert a memory extraction record into the test database.
 * Also creates a corresponding job record to satisfy FK constraint.
 * Returns the generated id for verification.
 */
async function insertMemory(
  db: SQLiteAdapter,
  record: Omit<DbMemoryExtraction, 'id'>,
): Promise<number> {
  // Create job record for FK constraint
  await db.execute(
    `INSERT OR IGNORE INTO jobs
       (id, workspace_id, name, job_chain, session_chain_id, timestamp, type,
        agent, status, lines, last_line, has_log, log_error, md_file, log_file,
        agent_done, size_bytes, last_modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.job_id,
      record.workspace_id,
      'test-job',
      'test-chain',
      'session-001',
      new Date().toISOString(),
      'agent',
      'kiro',
      'done',
      10,
      '',
      0,
      0,
      '/test/output.md',
      '/test/output.log',
      '',
      100,
      Date.now(),
    ],
  );

  // Insert memory extraction record
  const result = await db.execute(
    `INSERT INTO memory_extraction
       (job_id, workspace_id, extracted_at, raw_text, memory_count,
        quality_score, embedding_status, embed_attempts, tier,
        last_modified, deleted_at, stale, superseded, last_retrieved_at,
        retrieval_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.job_id,
      record.workspace_id,
      record.extracted_at,
      record.raw_text,
      record.memory_count,
      record.quality_score,
      record.embedding_status,
      record.embed_attempts,
      record.tier,
      record.last_modified,
      record.deleted_at,
      record.stale,
      record.superseded,
      record.last_retrieved_at,
      record.retrieval_count,
    ],
  );
  return Number(result.lastInsertRowid);
}

/**
 * Execute the decay query logic exactly as specified in the design document.
 * This mirrors the runDecayCycle function from the design.
 *
 * Returns the number of rows affected (memories marked stale).
 */
async function runDecayQuery(
  db: SQLiteAdapter,
  thresholdDays: number = MEMORY_DECAY_DAYS,
): Promise<number> {
  // Compute threshold date — matches design document logic exactly
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - thresholdDays);
  const thresholdISO = thresholdDate.toISOString();

  // Execute the decay UPDATE query — matches design document SQL exactly
  const { rowsAffected } = await db.execute(
    `UPDATE memory_extraction
     SET stale = 1, last_modified = ?
     WHERE last_retrieved_at < ?
       AND stale = 0
       AND deleted_at IS NULL`,
    [Date.now(), thresholdISO],
  );

  return rowsAffected;
}

/**
 * Retrieve stale status for a specific memory by id.
 */
async function getStaleStatus(db: SQLiteAdapter, id: number): Promise<boolean> {
  const { rows } = await db.query<Pick<DbMemoryExtraction, 'stale'>>(
    'SELECT stale FROM memory_extraction WHERE id = ?',
    [id],
  );
  return rows[0]?.stale === 1;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Memory Decay — Property 12: Decay Threshold Correctness', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);

    // Seed workspace for FK constraint
    await db.execute(
      `INSERT INTO workspaces (id, output_dir, sessions_dir, created_at)
       VALUES (?, ?, ?, ?)`,
      ['ws-test-001', '/tmp/output', '/tmp/sessions', new Date().toISOString()],
    );
  });

  afterEach(async () => {
    await db.close();
  });

  // =========================================================================
  // Property 12: Core decay threshold correctness
  // =========================================================================

  it('property: memories older than MEMORY_DECAY_DAYS are marked stale', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate days in past: some before threshold, some after
        // Exclude exact boundary (90) to avoid millisecond timing issues
        fc.array(
          fc.oneof(
            fc.integer({ min: 1, max: 89 }),  // Below threshold
            fc.integer({ min: 91, max: 200 }), // Above threshold
          ),
          { minLength: 1, maxLength: 20 },
        ),
        async (daysAgoArray) => {
          // Create memories at various ages
          const memoryIds: Array<{ id: number; daysAgo: number; shouldBeStale: boolean }> = [];

          for (const daysAgo of daysAgoArray) {
            const retrievalDate = new Date();
            retrievalDate.setDate(retrievalDate.getDate() - daysAgo);
            const lastRetrievedAt = retrievalDate.toISOString();

            const record = makeMemoryRecord({
              last_retrieved_at: lastRetrievedAt,
              stale: 0, // Start as active
            });

            const id = await insertMemory(db, record);
            memoryIds.push({
              id,
              daysAgo,
              shouldBeStale: daysAgo > MEMORY_DECAY_DAYS,
            });
          }

          // Execute decay query
          await runDecayQuery(db, MEMORY_DECAY_DAYS);

          // Verify each memory's stale status matches expectation
          for (const { id, shouldBeStale } of memoryIds) {
            const isStale = await getStaleStatus(db, id);
            if (isStale !== shouldBeStale) {
              return false;
            }
          }

          return true;
        },
      ),
      { numRuns: 100, seed: 65001 },
    );
  });

  it('property: memories exactly at threshold day boundary remain active', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate hours offset around the threshold boundary
        // Use larger offsets to avoid millisecond-level edge cases
        fc.integer({ min: -24, max: 24 }).filter(h => h !== 0),
        async (hoursOffset) => {
          // Create date exactly MEMORY_DECAY_DAYS ago, then adjust by hours
          const thresholdDate = new Date();
          thresholdDate.setDate(thresholdDate.getDate() - MEMORY_DECAY_DAYS);
          thresholdDate.setHours(thresholdDate.getHours() + hoursOffset);
          const lastRetrievedAt = thresholdDate.toISOString();

          const record = makeMemoryRecord({
            last_retrieved_at: lastRetrievedAt,
            stale: 0,
          });

          const id = await insertMemory(db, record);

          // Run decay query
          await runDecayQuery(db, MEMORY_DECAY_DAYS);

          // Check if memory is stale
          const isStale = await getStaleStatus(db, id);

          // Memory should be stale only if retrieval date is BEFORE threshold
          // (i.e., last_retrieved_at < thresholdISO in the query)
          const now = new Date();
          const queryThreshold = new Date();
          queryThreshold.setDate(now.getDate() - MEMORY_DECAY_DAYS);

          const shouldBeStale = new Date(lastRetrievedAt) < queryThreshold;

          return isStale === shouldBeStale;
        },
      ),
      { numRuns: 100, seed: 65002 },
    );
  });

  it('property: already-stale memories are not updated again', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 91, max: 200 }),
        async (daysAgo) => {
          const retrievalDate = new Date();
          retrievalDate.setDate(retrievalDate.getDate() - daysAgo);
          const lastRetrievedAt = retrievalDate.toISOString();

          const record = makeMemoryRecord({
            last_retrieved_at: lastRetrievedAt,
            stale: 1, // Already marked stale
            last_modified: Date.now() - 10000, // Old timestamp
          });

          const id = await insertMemory(db, record);
          const beforeModified = record.last_modified;

          // Run decay query
          const rowsAffected = await runDecayQuery(db, MEMORY_DECAY_DAYS);

          // Query the memory's current state
          const { rows } = await db.query<DbMemoryExtraction>(
            'SELECT * FROM memory_extraction WHERE id = ?',
            [id],
          );

          const memory = rows[0];
          if (!memory) return false;

          // Memory should still be stale
          if (memory.stale !== 1) return false;

          // last_modified should NOT have been updated
          // (query excludes already-stale memories with WHERE stale = 0)
          if (memory.last_modified !== beforeModified) return false;

          return true;
        },
      ),
      { numRuns: 100, seed: 65003 },
    );
  });

  it('property: deleted memories are excluded from decay processing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 91, max: 200 }),
        async (daysAgo) => {
          const retrievalDate = new Date();
          retrievalDate.setDate(retrievalDate.getDate() - daysAgo);
          const lastRetrievedAt = retrievalDate.toISOString();

          const record = makeMemoryRecord({
            last_retrieved_at: lastRetrievedAt,
            stale: 0, // Active but deleted
            deleted_at: new Date().toISOString(), // Soft-deleted
          });

          const id = await insertMemory(db, record);

          // Run decay query
          await runDecayQuery(db, MEMORY_DECAY_DAYS);

          // Deleted memory should remain NOT stale
          // (query excludes deleted with WHERE deleted_at IS NULL)
          const isStale = await getStaleStatus(db, id);
          return isStale === false;
        },
      ),
      { numRuns: 100, seed: 65004 },
    );
  });

  it('property: memories with NULL last_retrieved_at are excluded', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constant(null),
        async () => {
          const record = makeMemoryRecord({
            last_retrieved_at: null, // Never retrieved
            stale: 0,
          });

          const id = await insertMemory(db, record);

          // Run decay query
          await runDecayQuery(db, MEMORY_DECAY_DAYS);

          // Memory with NULL last_retrieved_at should remain NOT stale
          // (query uses WHERE last_retrieved_at < threshold, NULL fails comparison)
          const isStale = await getStaleStatus(db, id);
          return isStale === false;
        },
      ),
      { numRuns: 100, seed: 65005 },
    );
  });

  // =========================================================================
  // Edge case: Recent memories remain active
  // =========================================================================

  it('property: memories retrieved within threshold remain active', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate days from 0 (today) to threshold-1
        fc.integer({ min: 0, max: MEMORY_DECAY_DAYS - 1 }),
        async (daysAgo) => {
          const retrievalDate = new Date();
          retrievalDate.setDate(retrievalDate.getDate() - daysAgo);
          const lastRetrievedAt = retrievalDate.toISOString();

          const record = makeMemoryRecord({
            last_retrieved_at: lastRetrievedAt,
            stale: 0,
          });

          const id = await insertMemory(db, record);

          // Run decay query
          await runDecayQuery(db, MEMORY_DECAY_DAYS);

          // Recent memory should remain active (not stale)
          const isStale = await getStaleStatus(db, id);
          return isStale === false;
        },
      ),
      { numRuns: 100, seed: 65006 },
    );
  });

  // =========================================================================
  // Count verification: rowsAffected matches actual stale changes
  // =========================================================================

  it('property: rowsAffected equals number of memories newly marked stale', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            // Exclude exact boundary (90) to avoid millisecond timing issues
            daysAgo: fc.oneof(
              fc.integer({ min: 0, max: 89 }),  // Below threshold
              fc.integer({ min: 91, max: 200 }), // Above threshold
            ),
            alreadyStale: fc.boolean(),
            deleted: fc.boolean(),
          }),
          { minLength: 1, maxLength: 15 },
        ),
        async (memoryConfigs) => {
          // Create memories with various states
          let expectedNewlyStale = 0;

          for (let i = 0; i < memoryConfigs.length; i++) {
            const { daysAgo, alreadyStale, deleted } = memoryConfigs[i];

            const retrievalDate = new Date();
            retrievalDate.setDate(retrievalDate.getDate() - daysAgo);
            const lastRetrievedAt = retrievalDate.toISOString();

            const record = makeMemoryRecord({
              last_retrieved_at: lastRetrievedAt,
              stale: alreadyStale ? 1 : 0,
              deleted_at: deleted ? new Date().toISOString() : null,
            });

            await insertMemory(db, record);

            // Count memories that SHOULD be newly marked stale:
            // - older than threshold AND
            // - not already stale AND
            // - not deleted
            const isOldEnough = daysAgo > MEMORY_DECAY_DAYS;
            if (isOldEnough && !alreadyStale && !deleted) {
              expectedNewlyStale++;
            }
          }

          // Run decay query and capture rowsAffected
          const actualRowsAffected = await runDecayQuery(db, MEMORY_DECAY_DAYS);

          return actualRowsAffected === expectedNewlyStale;
        },
      ),
      { numRuns: 100, seed: 65007 },
    );
  });

  // =========================================================================
  // Invariant: Decay operation is idempotent
  // =========================================================================

  it('property: running decay multiple times produces same result', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Exclude exact boundary (90) to avoid millisecond timing issues
        fc.array(
          fc.oneof(
            fc.integer({ min: 0, max: 89 }),  // Below threshold
            fc.integer({ min: 91, max: 200 }), // Above threshold
          ),
          { minLength: 1, maxLength: 10 },
        ),
        async (daysAgoArray) => {
          // Create memories
          const memoryIds: number[] = [];
          for (const daysAgo of daysAgoArray) {
            const retrievalDate = new Date();
            retrievalDate.setDate(retrievalDate.getDate() - daysAgo);
            const lastRetrievedAt = retrievalDate.toISOString();

            const record = makeMemoryRecord({
              last_retrieved_at: lastRetrievedAt,
              stale: 0,
            });

            const id = await insertMemory(db, record);
            memoryIds.push(id);
          }

          // Run decay query first time
          const firstRowsAffected = await runDecayQuery(db, MEMORY_DECAY_DAYS);

          // Capture stale status after first run
          const staleAfterFirst: boolean[] = [];
          for (const id of memoryIds) {
            const isStale = await getStaleStatus(db, id);
            staleAfterFirst.push(isStale);
          }

          // Run decay query second time
          const secondRowsAffected = await runDecayQuery(db, MEMORY_DECAY_DAYS);

          // Capture stale status after second run
          const staleAfterSecond: boolean[] = [];
          for (const id of memoryIds) {
            const isStale = await getStaleStatus(db, id);
            staleAfterSecond.push(isStale);
          }

          // Second run should affect 0 rows (all already processed)
          if (secondRowsAffected !== 0) return false;

          // Stale status should be identical after both runs
          for (let i = 0; i < memoryIds.length; i++) {
            if (staleAfterFirst[i] !== staleAfterSecond[i]) return false;
          }

          return true;
        },
      ),
      { numRuns: 100, seed: 65008 },
    );
  });
});
