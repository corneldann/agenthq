/**
 * Unit tests for `classifyTier` in `src/memory/embedding.ts`.
 *
 * Covers:
 *   - 0 completed jobs → 'hot' (cnt=0 < MEMORY_HOT_TIER_COUNT)
 *   - MEMORY_HOT_TIER_COUNT − 1 jobs → 'hot' (cnt=99 < 100)
 *   - MEMORY_HOT_TIER_COUNT jobs → 'cold' (cnt=100 is not < 100)
 *   - Deleted jobs (deleted_at IS NOT NULL) are excluded from count
 *   - Only statuses 'done', 'reported', 'error' are counted; 'running' is excluded
 *
 * Test isolation: each test gets a fresh in-memory SQLite DB with all
 * migrations applied via `runMigrations`. No mocking of the DB layer —
 * real SQL queries run against real SQLite.
 *
 * Requirements: Phase 6.2, Requirement 3 AC 2–3
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { classifyTier } from '../../src/memory/embedding.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, '../../migrations');
const WORKSPACE_ID = 'ws-classify-tier';

// The default MEMORY_HOT_TIER_COUNT is 100.
// Tests rely on this default — they do not mutate process.env.
const HOT_TIER_COUNT = 100;

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedWorkspace(db: SQLiteAdapter, workspaceId = WORKSPACE_ID): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO workspaces (id, output_dir, sessions_dir, created_at)
     VALUES (?, ?, ?, ?)`,
    [workspaceId, '/tmp/output', '/tmp/sessions', new Date().toISOString()],
  );
}

/**
 * Insert N jobs with the given status into the DB.
 *
 * Each job gets a unique ID derived from `idPrefix` + index.
 * `deletedAt` controls whether the job is soft-deleted.
 */
async function seedJobs(
  db: SQLiteAdapter,
  count: number,
  opts: {
    workspaceId?: string;
    status?: 'done' | 'reported' | 'error' | 'running';
    deletedAt?: string | null;
    idPrefix?: string;
  } = {},
): Promise<void> {
  const {
    workspaceId = WORKSPACE_ID,
    status = 'done',
    deletedAt = null,
    idPrefix = 'job',
  } = opts;

  for (let i = 0; i < count; i++) {
    const id = `${idPrefix}-${i.toString().padStart(6, '0')}`;
    // Offset timestamps so ORDER BY timestamp DESC is deterministic
    const ts = new Date(Date.now() - i * 1000).toISOString();
    await db.execute(
      `INSERT OR IGNORE INTO jobs
         (id, workspace_id, name, job_chain, session_chain_id, timestamp, type, agent,
          status, lines, last_line, has_log, log_error, md_file, log_file, agent_done,
          size_bytes, last_modified, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, workspaceId, `job-${i}`, 'chain', 'sess', ts,
        'agent', 'kiro', status,
        0, '', 0, 0, '', '', '', 0, Date.now(), deletedAt,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('classifyTier', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);
    await seedWorkspace(db);
  });

  afterEach(async () => {
    await db.close();
  });

  // -------------------------------------------------------------------------
  // 0 jobs → hot
  // -------------------------------------------------------------------------

  it('should return "hot" when there are 0 completed jobs in the workspace', async () => {
    // Arrange — no jobs seeded

    // Act
    const tier = await classifyTier(db, WORKSPACE_ID);

    // Assert
    expect(tier).toBe('hot');
  });

  // -------------------------------------------------------------------------
  // MEMORY_HOT_TIER_COUNT − 1 jobs → hot
  // -------------------------------------------------------------------------

  it(`should return "hot" when there are ${HOT_TIER_COUNT - 1} completed jobs (count − 1 < threshold)`, async () => {
    // Arrange
    await seedJobs(db, HOT_TIER_COUNT - 1, { status: 'done' });

    // Act
    const tier = await classifyTier(db, WORKSPACE_ID);

    // Assert — cnt = 99, 99 < 100 → hot
    expect(tier).toBe('hot');
  });

  // -------------------------------------------------------------------------
  // MEMORY_HOT_TIER_COUNT jobs → cold
  // -------------------------------------------------------------------------

  it(`should return "cold" when there are ${HOT_TIER_COUNT} completed jobs (count = threshold, not < threshold)`, async () => {
    // Arrange
    await seedJobs(db, HOT_TIER_COUNT, { status: 'done' });

    // Act
    const tier = await classifyTier(db, WORKSPACE_ID);

    // Assert — cnt = 100, 100 is NOT < 100 → cold
    expect(tier).toBe('cold');
  });

  it(`should return "cold" when there are more than ${HOT_TIER_COUNT} completed jobs`, async () => {
    // Arrange
    await seedJobs(db, HOT_TIER_COUNT + 10, { status: 'done' });

    // Act
    const tier = await classifyTier(db, WORKSPACE_ID);

    // Assert — query is bounded by LIMIT so cnt = 100 = threshold → cold
    expect(tier).toBe('cold');
  });

  // -------------------------------------------------------------------------
  // Deleted jobs are excluded
  // -------------------------------------------------------------------------

  it('should exclude soft-deleted jobs from the count', async () => {
    // Arrange — seed HOT_TIER_COUNT jobs but mark all as deleted
    await seedJobs(db, HOT_TIER_COUNT, {
      status: 'done',
      deletedAt: new Date().toISOString(),
      idPrefix: 'del',
    });

    // Act — deleted jobs are excluded → effective count = 0 → hot
    const tier = await classifyTier(db, WORKSPACE_ID);

    // Assert
    expect(tier).toBe('hot');
  });

  it('should count only non-deleted jobs when a mix of deleted and active jobs exists', async () => {
    // Arrange — 50 active jobs (below threshold) + 60 deleted jobs
    await seedJobs(db, 50, { status: 'done', idPrefix: 'active' });
    await seedJobs(db, 60, {
      status: 'done',
      deletedAt: new Date().toISOString(),
      idPrefix: 'deleted',
    });

    // Act — only 50 non-deleted jobs counted; 50 < 100 → hot
    const tier = await classifyTier(db, WORKSPACE_ID);

    // Assert
    expect(tier).toBe('hot');
  });

  // -------------------------------------------------------------------------
  // Only terminal statuses are counted
  // -------------------------------------------------------------------------

  it('should count jobs with status "reported" and "error" in addition to "done"', async () => {
    // Arrange — mix of terminal statuses totalling HOT_TIER_COUNT
    const third = Math.floor(HOT_TIER_COUNT / 3);
    await seedJobs(db, third, { status: 'done',     idPrefix: 'done'     });
    await seedJobs(db, third, { status: 'reported', idPrefix: 'reported' });
    await seedJobs(db, third, { status: 'error',    idPrefix: 'error'    });
    // Remaining to hit exactly HOT_TIER_COUNT
    await seedJobs(db, HOT_TIER_COUNT - third * 3, {
      status: 'done',
      idPrefix: 'extra',
    });

    // Act
    const tier = await classifyTier(db, WORKSPACE_ID);

    // Assert — all three statuses contribute to reaching the threshold → cold
    expect(tier).toBe('cold');
  });

  it('should not count "running" jobs toward the hot-tier threshold', async () => {
    // Arrange — HOT_TIER_COUNT running jobs (should be ignored) + 0 terminal
    await seedJobs(db, HOT_TIER_COUNT, { status: 'running', idPrefix: 'running' });

    // Act
    const tier = await classifyTier(db, WORKSPACE_ID);

    // Assert — running jobs are excluded → cnt = 0 → hot
    expect(tier).toBe('hot');
  });

  // -------------------------------------------------------------------------
  // Workspace isolation
  // -------------------------------------------------------------------------

  it('should only count jobs belonging to the given workspaceId', async () => {
    // Arrange — HOT_TIER_COUNT jobs in a different workspace
    const otherWorkspaceId = 'ws-other';
    await db.execute(
      `INSERT OR IGNORE INTO workspaces (id, output_dir, sessions_dir, created_at)
       VALUES (?, ?, ?, ?)`,
      [otherWorkspaceId, '/tmp/other', '/tmp/other-sess', new Date().toISOString()],
    );
    await seedJobs(db, HOT_TIER_COUNT, {
      workspaceId: otherWorkspaceId,
      status: 'done',
      idPrefix: 'other',
    });

    // Act — query scoped to WORKSPACE_ID which has 0 jobs
    const tier = await classifyTier(db, WORKSPACE_ID);

    // Assert
    expect(tier).toBe('hot');
  });

  it('should return "cold" for the workspace that has reached the threshold while the other stays "hot"', async () => {
    // Arrange — full threshold in WORKSPACE_ID; none in another workspace
    await seedJobs(db, HOT_TIER_COUNT, { status: 'done', idPrefix: 'ws1' });

    const otherWorkspaceId = 'ws-empty';
    await db.execute(
      `INSERT OR IGNORE INTO workspaces (id, output_dir, sessions_dir, created_at)
       VALUES (?, ?, ?, ?)`,
      [otherWorkspaceId, '/tmp/empty', '/tmp/empty-sess', new Date().toISOString()],
    );

    // Act
    const tierFull  = await classifyTier(db, WORKSPACE_ID);
    const tierEmpty = await classifyTier(db, otherWorkspaceId);

    // Assert
    expect(tierFull).toBe('cold');
    expect(tierEmpty).toBe('hot');
  });
});
