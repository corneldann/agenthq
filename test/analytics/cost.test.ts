// Unit tests for computeCostMetrics (src/analytics/cost.ts)
//
// Covers:
//   Requirement 3.1  — total cost and token aggregation
//   Requirement 3.2  — cost_per_job_usd is null when job_count === 0
//   Requirement 3.4  — projected_monthly_usd = (total_cost / days) * 30
//   Requirement 3.5  — wasted_cost_usd sums only jobs with status = 'error'
//   Zero-job case    — all aggregate fields null, jobs_count = 0
//
// **Validates: Requirements 3.2, 3.4, 3.5**

import { describe, it, expect } from 'bun:test';
import type { DbAdapter, QueryResult, ExecResult } from '../../src/db/adapter.js';
import { computeCostMetrics } from '../../src/analytics/cost.js';

// ---------------------------------------------------------------------------
// Fake DbAdapter
//
// computeCostMetrics issues exactly 4 db.query() calls via Promise.all, in
// this fixed order:
//   1. aggregate   → { total_cost, total_tokens, job_count }
//   2. by-agent    → { agent, total_cost }[]
//   3. wasted cost → { wasted }
//   4. daily trend → { date, cost_usd, token_count }[]
//
// We use a call-index counter so each call returns the correct rows without
// having to inspect SQL text.
// ---------------------------------------------------------------------------

type AggregateRow   = { total_cost: number | null; total_tokens: number | null; job_count: number };
type AgentCostRow   = { agent: string | null; total_cost: number | null };
type WastedCostRow  = { wasted: number | null };
type DailyTrendRow  = { date: string; cost_usd: number | null; token_count: number | null };

type QuerySequence = [
  AggregateRow[],   // call 0 — aggregate
  AgentCostRow[],   // call 1 — by-agent
  WastedCostRow[],  // call 2 — wasted cost
  DailyTrendRow[],  // call 3 — daily trend
];

/**
 * Build a fake DbAdapter that returns each element of `queries` on successive
 * calls to `query()`. Throws if more calls are made than entries provided.
 *
 * execute(), transaction(), and close() are no-ops.
 */
function makeFakeDb(queries: QuerySequence): DbAdapter {
  let callIndex = 0;

  return {
    query<T>(_sql: string, _params?: unknown[]): Promise<QueryResult<T>> {
      const idx = callIndex++;
      if (idx >= queries.length) {
        throw new Error(`Unexpected extra query() call (call index ${idx})`);
      }
      const rows = queries[idx] as unknown as T[];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
    execute(_sql: string, _params?: unknown[]): Promise<ExecResult> {
      return Promise.resolve({ rowsAffected: 0 });
    },
    transaction(fn: (adapter: DbAdapter) => Promise<void>): Promise<void> {
      return fn(makeFakeDb(queries));
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: build the default empty-query sequence (all nulls / zero counts)
// ---------------------------------------------------------------------------

function emptyQueries(): QuerySequence {
  return [
    // aggregate — COUNT(*) always returns a row even for zero results
    [{ total_cost: null, total_tokens: null, job_count: 0 }],
    // by-agent — no rows
    [],
    // wasted cost — one row with null wasted (no error jobs)
    [{ wasted: null }],
    // daily trend — no rows
    [],
  ];
}

// ---------------------------------------------------------------------------
// 1. Zero-job edge case
// ---------------------------------------------------------------------------

describe('zero-job edge case', () => {
  it('should return null for all aggregate numeric fields when there are no jobs', async () => {
    // Arrange
    const db = makeFakeDb(emptyQueries());

    // Act
    const metrics = await computeCostMetrics(db, 'ws-empty', '7d');

    // Assert
    expect(metrics.total_cost_usd).toBeNull();
    expect(metrics.total_tokens).toBeNull();
    expect(metrics.wasted_cost_usd).toBeNull();
    expect(metrics.projected_monthly_usd).toBeNull();
  });

  it('should return jobs_count as 0 when there are no jobs', async () => {
    // Arrange
    const db = makeFakeDb(emptyQueries());

    // Act
    const metrics = await computeCostMetrics(db, 'ws-empty', '7d');

    // Assert — always-present field must be 0, not null
    expect(metrics.jobs_count).toBe(0);
  });

  it('should return empty cost_by_agent map when there are no jobs', async () => {
    // Arrange
    const db = makeFakeDb(emptyQueries());

    // Act
    const metrics = await computeCostMetrics(db, 'ws-empty', '7d');

    // Assert
    expect(metrics.cost_by_agent).toEqual({});
  });

  it('should return empty daily_trend array when there are no jobs', async () => {
    // Arrange
    const db = makeFakeDb(emptyQueries());

    // Act
    const metrics = await computeCostMetrics(db, 'ws-empty', '7d');

    // Assert
    expect(metrics.daily_trend).toEqual([]);
  });

  it('should preserve workspace_id and range in the returned metrics', async () => {
    // Arrange
    const db = makeFakeDb(emptyQueries());

    // Act
    const metrics = await computeCostMetrics(db, 'ws-test-123', '30d');

    // Assert
    expect(metrics.workspace_id).toBe('ws-test-123');
    expect(metrics.range).toBe('30d');
  });
});

// ---------------------------------------------------------------------------
// 2. Requirement 3.2 — cost_per_job_usd is null when job_count === 0
// ---------------------------------------------------------------------------

describe('Requirement 3.2: cost_per_job_usd null when job_count === 0', () => {
  it('should return cost_per_job_usd as null (not NaN, not 0) when there are no jobs', async () => {
    // Arrange — zero jobs, cost is also null (SQLite SUM returns NULL for empty set)
    const db = makeFakeDb(emptyQueries());

    // Act
    const metrics = await computeCostMetrics(db, 'ws-empty', '24h');

    // Assert — must be exactly null, not 0 or NaN
    expect(metrics.cost_per_job_usd).toBeNull();
  });

  it('should return cost_per_job_usd as null even when cost sum is 0 and job_count is 0', async () => {
    // Arrange — aggregate returns 0-cost with job_count = 0 (edge case)
    const queries: QuerySequence = [
      [{ total_cost: 0, total_tokens: 0, job_count: 0 }],
      [],
      [{ wasted: null }],
      [],
    ];
    const db = makeFakeDb(queries);

    // Act
    const metrics = await computeCostMetrics(db, 'ws-empty', '7d');

    // Assert — division-by-zero protection: null, not Infinity, not NaN
    expect(metrics.cost_per_job_usd).toBeNull();
  });

  it('should compute cost_per_job_usd correctly when job_count > 0', async () => {
    // Arrange — 4 jobs with total cost $2.00 → $0.50 per job
    const queries: QuerySequence = [
      [{ total_cost: 2.0, total_tokens: 10000, job_count: 4 }],
      [],
      [{ wasted: null }],
      [],
    ];
    const db = makeFakeDb(queries);

    // Act
    const metrics = await computeCostMetrics(db, 'ws-test', '7d');

    // Assert
    expect(metrics.cost_per_job_usd).toBeCloseTo(0.5, 10);
  });
});

// ---------------------------------------------------------------------------
// 3. Requirement 3.5 — wasted_cost_usd sums only error jobs
// ---------------------------------------------------------------------------

describe('Requirement 3.5: wasted_cost_usd from error jobs only', () => {
  it('should return wasted_cost_usd from the wasted query result (error jobs only)', async () => {
    // Arrange — $0.75 wasted on error jobs
    const queries: QuerySequence = [
      [{ total_cost: 5.0, total_tokens: 50000, job_count: 10 }],
      [],
      [{ wasted: 0.75 }],
      [],
    ];
    const db = makeFakeDb(queries);

    // Act
    const metrics = await computeCostMetrics(db, 'ws-test', '7d');

    // Assert
    expect(metrics.wasted_cost_usd).toBeCloseTo(0.75, 10);
  });

  it('should return wasted_cost_usd as null when there are no error jobs', async () => {
    // Arrange — no error jobs; wasted query returns a row with null (SQLite SUM of empty)
    const queries: QuerySequence = [
      [{ total_cost: 3.0, total_tokens: 30000, job_count: 6 }],
      [],
      [{ wasted: null }],
      [],
    ];
    const db = makeFakeDb(queries);

    // Act
    const metrics = await computeCostMetrics(db, 'ws-test', '30d');

    // Assert — no error jobs → null, not 0
    expect(metrics.wasted_cost_usd).toBeNull();
  });

  it('should not conflate wasted cost with total cost (done jobs should not contribute)', async () => {
    // Arrange — total $10 across 5 jobs, but only $1.50 from the error job
    const queries: QuerySequence = [
      [{ total_cost: 10.0, total_tokens: 100000, job_count: 5 }],
      [],
      [{ wasted: 1.5 }],
      [],
    ];
    const db = makeFakeDb(queries);

    // Act
    const metrics = await computeCostMetrics(db, 'ws-test', '7d');

    // Assert — total and wasted are distinct values
    expect(metrics.total_cost_usd).toBeCloseTo(10.0, 10);
    expect(metrics.wasted_cost_usd).toBeCloseTo(1.5, 10);
    // wasted must be strictly less than total (error jobs are a subset)
    expect(metrics.wasted_cost_usd as number).toBeLessThan(metrics.total_cost_usd as number);
  });

  it('should return wasted_cost_usd as null when total cost is null (no jobs at all)', async () => {
    // Arrange — zero jobs scenario; wasted query will also return null
    const db = makeFakeDb(emptyQueries());

    // Act
    const metrics = await computeCostMetrics(db, 'ws-empty', '24h');

    // Assert
    expect(metrics.wasted_cost_usd).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Requirement 3.4 — projected_monthly_usd = (total_cost / days) * 30
// ---------------------------------------------------------------------------

describe('Requirement 3.4: projected_monthly_usd formula', () => {
  it('should compute projected_monthly_usd as (total_cost / 1) * 30 for 24h range', async () => {
    // Arrange — $3.00 total over 1 day → $90.00/month
    const queries: QuerySequence = [
      [{ total_cost: 3.0, total_tokens: 30000, job_count: 3 }],
      [],
      [{ wasted: null }],
      [],
    ];
    const db = makeFakeDb(queries);

    // Act
    const metrics = await computeCostMetrics(db, 'ws-test', '24h');

    // Assert — (3.00 / 1) * 30 = 90.00
    expect(metrics.projected_monthly_usd).toBeCloseTo(90.0, 10);
  });

  it('should compute projected_monthly_usd as (total_cost / 7) * 30 for 7d range', async () => {
    // Arrange — $7.00 total over 7 days → $30.00/month
    const queries: QuerySequence = [
      [{ total_cost: 7.0, total_tokens: 70000, job_count: 7 }],
      [],
      [{ wasted: null }],
      [],
    ];
    const db = makeFakeDb(queries);

    // Act
    const metrics = await computeCostMetrics(db, 'ws-test', '7d');

    // Assert — (7.00 / 7) * 30 = 30.00
    expect(metrics.projected_monthly_usd).toBeCloseTo(30.0, 10);
  });

  it('should compute projected_monthly_usd as (total_cost / 30) * 30 for 30d range', async () => {
    // Arrange — $15.00 total over 30 days → $15.00/month (identity)
    const queries: QuerySequence = [
      [{ total_cost: 15.0, total_tokens: 150000, job_count: 30 }],
      [],
      [{ wasted: null }],
      [],
    ];
    const db = makeFakeDb(queries);

    // Act
    const metrics = await computeCostMetrics(db, 'ws-test', '30d');

    // Assert — (15.00 / 30) * 30 = 15.00
    expect(metrics.projected_monthly_usd).toBeCloseTo(15.0, 10);
  });

  it('should return projected_monthly_usd as null when total_cost_usd is null', async () => {
    // Arrange — zero jobs, no cost data
    const db = makeFakeDb(emptyQueries());

    // Act
    const metrics = await computeCostMetrics(db, 'ws-empty', '7d');

    // Assert — cannot project without data
    expect(metrics.projected_monthly_usd).toBeNull();
  });

  it('should return projected_monthly_usd as 0 when total_cost is 0', async () => {
    // Arrange — jobs exist but all have zero cost
    const queries: QuerySequence = [
      [{ total_cost: 0, total_tokens: 5000, job_count: 5 }],
      [],
      [{ wasted: null }],
      [],
    ];
    const db = makeFakeDb(queries);

    // Act
    const metrics = await computeCostMetrics(db, 'ws-test', '7d');

    // Assert — (0 / 7) * 30 = 0
    expect(metrics.projected_monthly_usd).toBeCloseTo(0, 10);
  });
});

// ---------------------------------------------------------------------------
// 5. Aggregate field correctness
// ---------------------------------------------------------------------------

describe('aggregate field correctness', () => {
  it('should return total_cost_usd and total_tokens from aggregate query', async () => {
    // Arrange
    const queries: QuerySequence = [
      [{ total_cost: 4.2, total_tokens: 42000, job_count: 8 }],
      [],
      [{ wasted: null }],
      [],
    ];
    const db = makeFakeDb(queries);

    // Act
    const metrics = await computeCostMetrics(db, 'ws-test', '7d');

    // Assert
    expect(metrics.total_cost_usd).toBeCloseTo(4.2, 10);
    expect(metrics.total_tokens).toBe(42000);
    expect(metrics.jobs_count).toBe(8);
  });

  it('should build cost_by_agent from agent rows, skipping null agent names', async () => {
    // Arrange — one named agent, one null-named entry (should be skipped)
    const queries: QuerySequence = [
      [{ total_cost: 3.0, total_tokens: 30000, job_count: 3 }],
      [
        { agent: 'kiro',  total_cost: 2.0 },
        { agent: null,    total_cost: 0.5 },  // must be excluded
        { agent: 'claude', total_cost: 1.0 },
      ],
      [{ wasted: null }],
      [],
    ];
    const db = makeFakeDb(queries);

    // Act
    const metrics = await computeCostMetrics(db, 'ws-test', '7d');

    // Assert — null agent excluded, named agents present
    expect(metrics.cost_by_agent).toEqual({ kiro: 2.0, claude: 1.0 });
  });

  it('should exclude agent entries where total_cost is null', async () => {
    // Arrange — agent with null cost (no cost data for that agent)
    const queries: QuerySequence = [
      [{ total_cost: 1.0, total_tokens: 10000, job_count: 2 }],
      [
        { agent: 'kiro', total_cost: null },
        { agent: 'other', total_cost: 1.0 },
      ],
      [{ wasted: null }],
      [],
    ];
    const db = makeFakeDb(queries);

    // Act
    const metrics = await computeCostMetrics(db, 'ws-test', '7d');

    // Assert — null-cost agent excluded
    expect(Object.keys(metrics.cost_by_agent)).not.toContain('kiro');
    expect(metrics.cost_by_agent).toEqual({ other: 1.0 });
  });

  it('should coerce null daily trend cost/token values to 0', async () => {
    // Arrange — a trend row where SQLite SUM returned null (no matching rows that day)
    const queries: QuerySequence = [
      [{ total_cost: 1.0, total_tokens: 1000, job_count: 1 }],
      [],
      [{ wasted: null }],
      [
        { date: '2025-01-01', cost_usd: null, token_count: null },
        { date: '2025-01-02', cost_usd: 0.5,  token_count: 500 },
      ],
    ];
    const db = makeFakeDb(queries);

    // Act
    const metrics = await computeCostMetrics(db, 'ws-test', '7d');

    // Assert — null values coerced to 0 in the trend series
    expect(metrics.daily_trend[0]).toEqual({ date: '2025-01-01', cost_usd: 0, token_count: 0 });
    expect(metrics.daily_trend[1]).toEqual({ date: '2025-01-02', cost_usd: 0.5, token_count: 500 });
  });

  it('should include a computed_at ISO 8601 timestamp', async () => {
    // Arrange
    const db = makeFakeDb(emptyQueries());

    // Act
    const before = new Date().toISOString();
    const metrics = await computeCostMetrics(db, 'ws-test', '7d');
    const after = new Date().toISOString();

    // Assert — timestamp is a valid ISO 8601 string within the test window
    expect(typeof metrics.computed_at).toBe('string');
    expect(metrics.computed_at >= before).toBe(true);
    expect(metrics.computed_at <= after).toBe(true);
  });
});
