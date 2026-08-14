/**
 * Performance tests for analytics REST API endpoints.
 *
 * Verifies that each endpoint responds within the documented latency bounds
 * under a "typical dataset" of ~75 jobs with associated metrics rows.
 *
 * Bounds:
 *   - GET /api/analytics/performance  ≤ 200ms  (Req 7.1, 12.2)
 *   - GET /api/analytics/cost         ≤ 200ms  (Req 12.2)
 *   - GET /api/analytics/bottlenecks  ≤ 500ms  (Req 12.2)
 *
 * Design choices:
 *   - Real in-memory SQLite (`:memory:`) + real computation functions —
 *     no mocks.  This exercises the actual query path end-to-end.
 *   - Real Router so HTTP routing is included in the measured time.
 *   - Cache is bypassed by using a unique workspace ID per test run so
 *     the module-level `analyticsCache` singleton never returns a hit.
 *   - Timing uses `performance.now()` (sub-millisecond resolution).
 *   - Each test runs the request once and asserts the wall-clock duration.
 *     A single-shot assertion is appropriate here: the in-memory DB is
 *     fast, the dataset is small (~75 rows), and p99 tests would require
 *     many warm-up iterations that slow down the suite.
 *
 * Validates: Requirements 7.1, 12.2
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { SQLiteAdapter } from '../src/db/sqlite-adapter.ts';
import { createRouter } from '../src/router.ts';
import { register } from '../src/routes/analytics.ts';
import type { DbAdapter } from '../src/db/adapter.ts';

// ---------------------------------------------------------------------------
// Schema setup — mirrors migrations 001 + 003 exactly
// ---------------------------------------------------------------------------

/**
 * Apply the full production schema to a freshly opened adapter.
 *
 * Replicates the tables and indexes from migrations/001_initial.sql and
 * migrations/003_job_metrics.sql so we exercise the real query plan.
 */
async function applySchema(db: DbAdapter): Promise<void> {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS workspaces (
       id           TEXT PRIMARY KEY,
       output_dir   TEXT NOT NULL,
       sessions_dir TEXT NOT NULL,
       created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     )`,

    `CREATE TABLE IF NOT EXISTS jobs (
       id               TEXT PRIMARY KEY,
       workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
       name             TEXT NOT NULL,
       job_chain        TEXT NOT NULL DEFAULT '',
       session_chain_id TEXT NOT NULL DEFAULT '',
       timestamp        TEXT NOT NULL,
       type             TEXT NOT NULL DEFAULT '',
       agent            TEXT NOT NULL DEFAULT '',
       status           TEXT NOT NULL CHECK(status IN ('running','done','reported','error')),
       lines            INTEGER NOT NULL DEFAULT 0,
       last_line        TEXT NOT NULL DEFAULT '',
       has_log          INTEGER NOT NULL DEFAULT 0,
       log_error        INTEGER NOT NULL DEFAULT 0,
       md_file          TEXT NOT NULL DEFAULT '',
       log_file         TEXT NOT NULL DEFAULT '',
       agent_done       TEXT NOT NULL DEFAULT '',
       size_bytes       INTEGER NOT NULL DEFAULT 0,
       last_modified    INTEGER NOT NULL DEFAULT 0,
       deleted_at       TEXT
     )`,

    `CREATE TABLE IF NOT EXISTS job_metrics (
       job_id        TEXT    PRIMARY KEY,
       workspace_id  TEXT    NOT NULL,
       duration_ms   REAL,
       input_tokens  INTEGER,
       output_tokens INTEGER,
       total_tokens  INTEGER,
       cost_usd      REAL,
       tool_calls    INTEGER,
       retry_count   INTEGER,
       error_count   INTEGER,
       collected_at  TEXT    NOT NULL
     )`,

    // Indexes from migration 001
    `CREATE INDEX IF NOT EXISTS idx_jobs_workspace_status
       ON jobs(workspace_id, status) WHERE deleted_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_workspace_timestamp
       ON jobs(workspace_id, timestamp DESC) WHERE deleted_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_type_status
       ON jobs(type, status) WHERE deleted_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_timestamp
       ON jobs(timestamp) WHERE deleted_at IS NULL`,

    // Indexes from migration 003
    `CREATE INDEX IF NOT EXISTS idx_metrics_workspace
       ON job_metrics(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_metrics_cost
       ON job_metrics(workspace_id, cost_usd) WHERE cost_usd IS NOT NULL`,
  ];

  for (const stmt of ddl) {
    await db.execute(stmt);
  }
}

// ---------------------------------------------------------------------------
// Dataset seeding — "typical" ~75 jobs spread across the last 7 days
// ---------------------------------------------------------------------------

const JOB_TYPES = ['prompt', 'build', 'test', 'review'] as const;
const JOB_AGENTS = ['gpt-4o', 'claude-3-5-sonnet', 'kiro'] as const;
const JOB_STATUSES = ['done', 'done', 'done', 'error'] as const; // 75% success rate
const DATASET_SIZE = 75;
const WORKSPACE_ID = `ws-perf-analytics-${Date.now()}`;

/**
 * Seed the jobs and job_metrics tables with DATASET_SIZE rows spanning
 * the last 7 days.  All timestamps are within the '30d' range so every
 * analytics query returns a non-trivial result set.
 */
async function seedDataset(db: DbAdapter): Promise<void> {
  // Insert workspace row (foreign-key constraint on jobs.workspace_id)
  await db.execute(
    `INSERT INTO workspaces (id, output_dir, sessions_dir) VALUES (?, ?, ?)`,
    [WORKSPACE_ID, '/out', '/sessions'],
  );

  // Stagger timestamps evenly across the last 7 days (ms per slot)
  const nowMs = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const stepMs = sevenDaysMs / DATASET_SIZE;

  // Batch-insert jobs
  await db.transaction(async (tx) => {
    for (let i = 0; i < DATASET_SIZE; i++) {
      const jobId = `perf-job-${i}`;
      const type = JOB_TYPES[i % JOB_TYPES.length];
      const agent = JOB_AGENTS[i % JOB_AGENTS.length];
      const status = JOB_STATUSES[i % JOB_STATUSES.length];
      // Spread timestamps backwards from now
      const ts = new Date(nowMs - (DATASET_SIZE - i) * stepMs).toISOString();

      await tx.execute(
        `INSERT INTO jobs
           (id, workspace_id, name, timestamp, type, agent, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [jobId, WORKSPACE_ID, `job-name-${i}`, ts, type, agent, status],
      );

      // Corresponding metrics row: realistic values with some variation
      const durationMs = 500 + (i % 10) * 100;          // 500–1400 ms
      const inputTokens = 1000 + (i % 5) * 200;          // 1000–1800
      const outputTokens = 500 + (i % 3) * 150;          // 500–800
      const totalTokens = inputTokens + outputTokens;
      const costUsd = totalTokens * 0.000002;              // $0.002 per 1k tokens
      const toolCalls = 3 + (i % 4);                      // 3–6 tool calls

      await tx.execute(
        `INSERT INTO job_metrics
           (job_id, workspace_id, duration_ms, input_tokens, output_tokens,
            total_tokens, cost_usd, tool_calls, retry_count, error_count,
            collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          jobId,
          WORKSPACE_ID,
          durationMs,
          inputTokens,
          outputTokens,
          totalTokens,
          costUsd,
          toolCalls,
          0,
          status === 'error' ? 1 : 0,
        ],
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Test fixture — shared across all performance tests
// ---------------------------------------------------------------------------

let db: SQLiteAdapter;
let router: ReturnType<typeof createRouter>;

/**
 * Dispatch a request through the router and return the Response.
 */
async function dispatch(url: string): Promise<Response> {
  const req = new Request(`http://localhost${url}`);
  const match = router.match(req);
  if (!match) {
    return new Response(JSON.stringify({ error: 'no route matched' }), {
      status: 404,
    });
  }
  return match.handler(req, match.params);
}

beforeAll(async () => {
  // Open in-memory SQLite (no disk I/O)
  db = new SQLiteAdapter(':memory:');
  await applySchema(db);
  await seedDataset(db);

  // Register analytics routes on a fresh router
  router = createRouter();
  register(router, db);

  // Warm-up pass: fire one request per endpoint so bun's JIT can compile
  // the hot path before the timed assertions.  The cache is seeded by
  // this pass — each timed assertion therefore measures a cache-hit path,
  // which is the steady-state behaviour that matters most for the bound.
  //
  // Note: the spec bounds apply to the overall endpoint response time
  // (Req 7.1 says "≤200ms response time"), not specifically to cold or
  // warm paths.  Measuring a cache-hit is correct and representative of
  // real-world steady-state traffic.
  await dispatch(`/api/analytics/performance?workspace=${WORKSPACE_ID}&range=7d`);
  await dispatch(`/api/analytics/cost?workspace=${WORKSPACE_ID}&range=7d`);
  await dispatch(`/api/analytics/bottlenecks?workspace=${WORKSPACE_ID}`);
});

afterAll(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------
// Performance tests — wall-clock response time assertions
// ---------------------------------------------------------------------------

describe('analytics API performance bounds (Req 7.1, 12.2)', () => {
  // -------------------------------------------------------------------------
  // Req 7.1 / 12.2 — performance endpoint ≤ 200ms
  // -------------------------------------------------------------------------

  it('should respond from GET /api/analytics/performance in ≤ 200ms for a typical dataset', async () => {
    // Arrange — use a unique workspace key that bypasses the module-level cache,
    // so this test measures actual computation time, not cache-hit time.
    const freshDb = new SQLiteAdapter(':memory:');
    await applySchema(freshDb);
    await seedDataset(freshDb);
    const freshRouter = createRouter();
    register(freshRouter, freshDb);

    const freshWs = `ws-perf-fresh-${Date.now()}-perf`;

    // Re-seed for the fresh workspace
    await freshDb.execute(
      `INSERT OR IGNORE INTO workspaces (id, output_dir, sessions_dir) VALUES (?, ?, ?)`,
      [freshWs, '/out', '/sessions'],
    );
    await freshDb.transaction(async (tx) => {
      const nowMs = Date.now();
      const stepMs = (7 * 24 * 60 * 60 * 1000) / DATASET_SIZE;
      for (let i = 0; i < DATASET_SIZE; i++) {
        const jobId = `fp-${i}`;
        const ts = new Date(nowMs - (DATASET_SIZE - i) * stepMs).toISOString();
        await tx.execute(
          `INSERT INTO jobs (id, workspace_id, name, timestamp, type, agent, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [jobId, freshWs, `n-${i}`, ts, 'prompt', 'gpt-4o', 'done'],
        );
        await tx.execute(
          `INSERT INTO job_metrics
             (job_id, workspace_id, duration_ms, input_tokens, output_tokens,
              total_tokens, cost_usd, tool_calls, retry_count, error_count, collected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          [jobId, freshWs, 500 + i * 5, 1000, 500, 1500, 0.003, 3, 0, 0],
        );
      }
    });

    // Act
    const start = performance.now();
    const res = await (async () => {
      const req = new Request(`http://localhost/api/analytics/performance?workspace=${freshWs}&range=7d`);
      const match = freshRouter.match(req);
      if (!match) throw new Error('route not found');
      return match.handler(req, match.params);
    })();
    const elapsed = performance.now() - start;

    // Assert — HTTP 200 response within bound
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(200);

    await freshDb.close();
  });

  // -------------------------------------------------------------------------
  // Req 12.2 — cost endpoint ≤ 200ms
  // -------------------------------------------------------------------------

  it('should respond from GET /api/analytics/cost in ≤ 200ms for a typical dataset', async () => {
    // Arrange — fresh DB + workspace to bypass cache and measure real computation
    const freshDb = new SQLiteAdapter(':memory:');
    await applySchema(freshDb);

    const freshWs = `ws-cost-fresh-${Date.now()}`;
    await freshDb.execute(
      `INSERT INTO workspaces (id, output_dir, sessions_dir) VALUES (?, ?, ?)`,
      [freshWs, '/out', '/sessions'],
    );

    await freshDb.transaction(async (tx) => {
      const nowMs = Date.now();
      const stepMs = (7 * 24 * 60 * 60 * 1000) / DATASET_SIZE;
      for (let i = 0; i < DATASET_SIZE; i++) {
        const jobId = `cost-${i}`;
        const agent = JOB_AGENTS[i % JOB_AGENTS.length];
        const ts = new Date(nowMs - (DATASET_SIZE - i) * stepMs).toISOString();
        await tx.execute(
          `INSERT INTO jobs (id, workspace_id, name, timestamp, type, agent, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [jobId, freshWs, `n-${i}`, ts, 'prompt', agent, 'done'],
        );
        await tx.execute(
          `INSERT INTO job_metrics
             (job_id, workspace_id, duration_ms, input_tokens, output_tokens,
              total_tokens, cost_usd, tool_calls, retry_count, error_count, collected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          [jobId, freshWs, 600, 1200, 600, 1800, 0.0036, 4, 0, 0],
        );
      }
    });

    const freshRouter = createRouter();
    register(freshRouter, freshDb);

    // Act
    const start = performance.now();
    const req = new Request(`http://localhost/api/analytics/cost?workspace=${freshWs}&range=7d`);
    const match = freshRouter.match(req);
    if (!match) throw new Error('route not found');
    const res = await match.handler(req, match.params);
    const elapsed = performance.now() - start;

    // Assert — HTTP 200 response within bound
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(200);

    await freshDb.close();
  });

  // -------------------------------------------------------------------------
  // Req 12.2 — bottlenecks endpoint ≤ 500ms
  // -------------------------------------------------------------------------

  it('should respond from GET /api/analytics/bottlenecks in ≤ 500ms for a typical dataset', async () => {
    // Arrange — fresh DB to bypass cache
    const freshDb = new SQLiteAdapter(':memory:');
    await applySchema(freshDb);

    const freshWs = `ws-bn-fresh-${Date.now()}`;
    await freshDb.execute(
      `INSERT INTO workspaces (id, output_dir, sessions_dir) VALUES (?, ?, ?)`,
      [freshWs, '/out', '/sessions'],
    );

    await freshDb.transaction(async (tx) => {
      const nowMs = Date.now();
      const stepMs = (7 * 24 * 60 * 60 * 1000) / DATASET_SIZE;
      for (let i = 0; i < DATASET_SIZE; i++) {
        const jobId = `bn-${i}`;
        const type = JOB_TYPES[i % JOB_TYPES.length];
        const ts = new Date(nowMs - (DATASET_SIZE - i) * stepMs).toISOString();
        // Some jobs are significantly slower (bottlenecks)
        const durationMs = i % 10 === 0 ? 5000 : 500;
        await tx.execute(
          `INSERT INTO jobs (id, workspace_id, name, timestamp, type, agent, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [jobId, freshWs, `n-${i}`, ts, type, 'kiro', 'done'],
        );
        await tx.execute(
          `INSERT INTO job_metrics
             (job_id, workspace_id, duration_ms, input_tokens, output_tokens,
              total_tokens, cost_usd, tool_calls, retry_count, error_count, collected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          [jobId, freshWs, durationMs, 800, 400, 1200, 0.0024, 3, 0, 0],
        );
      }
    });

    const freshRouter = createRouter();
    register(freshRouter, freshDb);

    // Act
    const start = performance.now();
    const req = new Request(`http://localhost/api/analytics/bottlenecks?workspace=${freshWs}`);
    const match = freshRouter.match(req);
    if (!match) throw new Error('route not found');
    const res = await match.handler(req, match.params);
    const elapsed = performance.now() - start;

    // Assert — HTTP 200 response within bound
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(500);

    await freshDb.close();
  });
});

// ---------------------------------------------------------------------------
// Sanity checks — verify response shape is correct (not just fast)
// ---------------------------------------------------------------------------

describe('analytics API response shape (warm-cache path)', () => {
  it('should return valid PerformanceMetrics JSON with non-null values for a seeded workspace', async () => {
    // The beforeAll seeded WORKSPACE_ID — this reads from cache (second hit)
    const res = await dispatch(
      `/api/analytics/performance?workspace=${WORKSPACE_ID}&range=7d`,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    // Required fields per PerformanceMetrics interface
    expect(body.workspace_id).toBe(WORKSPACE_ID);
    expect(body.range).toBe('7d');
    expect(typeof body.total_jobs).toBe('number');
    expect(body.total_jobs as number).toBeGreaterThan(0);

    // With seeded data, numeric fields must be non-null
    expect(body.avg_duration_ms).not.toBeNull();
    expect(typeof body.avg_duration_ms).toBe('number');
    expect(body.success_rate_percent).not.toBeNull();
    const successRate = body.success_rate_percent as number;
    expect(successRate).toBeGreaterThanOrEqual(0);
    expect(successRate).toBeLessThanOrEqual(100);
  });

  it('should return valid CostMetrics JSON with non-null values for a seeded workspace', async () => {
    const res = await dispatch(
      `/api/analytics/cost?workspace=${WORKSPACE_ID}&range=7d`,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    expect(body.workspace_id).toBe(WORKSPACE_ID);
    expect(body.range).toBe('7d');
    expect(typeof body.jobs_count).toBe('number');
    expect(body.jobs_count as number).toBeGreaterThan(0);
    expect(body.total_cost_usd).not.toBeNull();
    expect(typeof body.total_cost_usd).toBe('number');
    expect(body.total_cost_usd as number).toBeGreaterThan(0);
  });

  it('should return valid BottleneckAnalysis JSON for a seeded workspace', async () => {
    const res = await dispatch(
      `/api/analytics/bottlenecks?workspace=${WORKSPACE_ID}`,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    expect(body.workspace_id).toBe(WORKSPACE_ID);
    expect(Array.isArray(body.slowest_jobs)).toBe(true);
    expect(Array.isArray(body.top_tools_by_time)).toBe(true);
    expect(Array.isArray(body.contention_periods)).toBe(true);
    expect(typeof body.computed_at).toBe('string');
  });
});
