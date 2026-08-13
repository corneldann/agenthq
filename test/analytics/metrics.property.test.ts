// Property-based tests for computePerformanceMetrics (src/analytics/metrics.ts)
//
// Covers:
//   Property 3: Non-Negative Metrics — avg, median, p95, p99 are ≥ 0 when non-null
//   Property 4: Percentile Ordering  — p50 ≤ p95 ≤ p99 for any non-empty dataset
//   Property 5: Success Rate Bounds  — success_rate_percent ∈ [0, 100] or NULL
//   Zero-job case (Req 2.5)          — all metric fields are null when total_jobs === 0
//
// **Validates: Requirements 2.1, 2.5, 12.1**

import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import type { DbAdapter, QueryResult, ExecResult } from '../../src/db/adapter.js';
import { computePerformanceMetrics } from '../../src/analytics/metrics.js';

// ---------------------------------------------------------------------------
// Lightweight in-memory fake DbAdapter
//
// Rather than mocking, we build a minimal real implementation that ignores SQL
// and simply returns pre-supplied rows. This tests the computation logic in
// computePerformanceMetrics without any SQL engine dependency.
// ---------------------------------------------------------------------------

type MetricsRow = { duration_ms: number; status: string };

/**
 * Create a fake DbAdapter whose query() always returns the provided rows.
 * execute() and transaction() are no-ops; close() resolves immediately.
 */
function makeFakeDb(rows: MetricsRow[]): DbAdapter {
  return {
    query<T>(_sql: string, _params?: unknown[]): Promise<QueryResult<T>> {
      return Promise.resolve({
        rows: rows as unknown as T[],
        rowCount: rows.length,
      });
    },
    execute(_sql: string, _params?: unknown[]): Promise<ExecResult> {
      return Promise.resolve({ rowsAffected: 0 });
    },
    transaction(fn: (adapter: DbAdapter) => Promise<void>): Promise<void> {
      return fn(makeFakeDb(rows));
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Valid range tokens accepted by computePerformanceMetrics. */
const rangeArb = fc.constantFrom('24h' as const, '7d' as const, '30d' as const);

/** Non-negative finite integer duration in milliseconds. */
const durationArb = fc.integer({ min: 0, max: 10_000_000 });

/** Job status values the implementation recognises. */
const statusArb = fc.constantFrom('done', 'error', 'running', 'reported');

/** A single MetricsRow with non-negative duration and a valid status. */
const metricsRowArb: fc.Arbitrary<MetricsRow> = fc.record({
  duration_ms: durationArb,
  status: statusArb,
});

/** A non-empty array of MetricsRows (at least one row). */
const nonEmptyRowsArb = fc.array(metricsRowArb, { minLength: 1, maxLength: 200 });

// ---------------------------------------------------------------------------
// Property 3: Non-Negative Metrics
//
// For any non-empty array of non-negative durations, avg, median, p95, and
// p99 must all be ≥ 0 when present (i.e., non-null).
//
// Validates: Requirement 2.1, 12.1
// ---------------------------------------------------------------------------

describe('Property 3: Non-Negative Metrics', () => {
  it('property: avg_duration_ms is ≥ 0 for any non-empty dataset', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyRowsArb, rangeArb, async (rows, range) => {
        const db = makeFakeDb(rows);
        const metrics = await computePerformanceMetrics(db, 'ws-test', range);

        // Non-empty dataset → avg must be a number, not null
        expect(metrics.avg_duration_ms).not.toBeNull();
        expect(metrics.avg_duration_ms as number).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });

  it('property: median_duration_ms is ≥ 0 for any non-empty dataset', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyRowsArb, rangeArb, async (rows, range) => {
        const db = makeFakeDb(rows);
        const metrics = await computePerformanceMetrics(db, 'ws-test', range);

        expect(metrics.median_duration_ms).not.toBeNull();
        expect(metrics.median_duration_ms as number).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });

  it('property: p95_duration_ms is ≥ 0 for any non-empty dataset', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyRowsArb, rangeArb, async (rows, range) => {
        const db = makeFakeDb(rows);
        const metrics = await computePerformanceMetrics(db, 'ws-test', range);

        expect(metrics.p95_duration_ms).not.toBeNull();
        expect(metrics.p95_duration_ms as number).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });

  it('property: p99_duration_ms is ≥ 0 for any non-empty dataset', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyRowsArb, rangeArb, async (rows, range) => {
        const db = makeFakeDb(rows);
        const metrics = await computePerformanceMetrics(db, 'ws-test', range);

        expect(metrics.p99_duration_ms).not.toBeNull();
        expect(metrics.p99_duration_ms as number).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: Percentile Ordering
//
// For any non-empty dataset, the statistical invariant p50 ≤ p95 ≤ p99 must
// hold. Violations would indicate a broken percentile computation.
//
// Validates: Requirement 2.1, correctness property "Percentile Ordering"
// ---------------------------------------------------------------------------

describe('Property 4: Percentile Ordering — p50 ≤ p95 ≤ p99', () => {
  it('property: median_duration_ms ≤ p95_duration_ms for any non-empty dataset', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyRowsArb, rangeArb, async (rows, range) => {
        const db = makeFakeDb(rows);
        const metrics = await computePerformanceMetrics(db, 'ws-test', range);

        const { median_duration_ms, p95_duration_ms } = metrics;

        // Both must be non-null for a non-empty dataset
        expect(median_duration_ms).not.toBeNull();
        expect(p95_duration_ms).not.toBeNull();

        expect(median_duration_ms as number).toBeLessThanOrEqual(p95_duration_ms as number);
      }),
      { numRuns: 300 },
    );
  });

  it('property: p95_duration_ms ≤ p99_duration_ms for any non-empty dataset', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyRowsArb, rangeArb, async (rows, range) => {
        const db = makeFakeDb(rows);
        const metrics = await computePerformanceMetrics(db, 'ws-test', range);

        const { p95_duration_ms, p99_duration_ms } = metrics;

        expect(p95_duration_ms).not.toBeNull();
        expect(p99_duration_ms).not.toBeNull();

        expect(p95_duration_ms as number).toBeLessThanOrEqual(p99_duration_ms as number);
      }),
      { numRuns: 300 },
    );
  });

  it('property: median_duration_ms ≤ p99_duration_ms (transitive ordering) for any non-empty dataset', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyRowsArb, rangeArb, async (rows, range) => {
        const db = makeFakeDb(rows);
        const metrics = await computePerformanceMetrics(db, 'ws-test', range);

        const { median_duration_ms, p99_duration_ms } = metrics;

        expect(median_duration_ms).not.toBeNull();
        expect(p99_duration_ms).not.toBeNull();

        expect(median_duration_ms as number).toBeLessThanOrEqual(p99_duration_ms as number);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Success Rate Bounds
//
// success_rate_percent must be either null (zero-job case) or in [0, 100].
// This holds regardless of the mix of 'done' vs other-status jobs.
//
// Validates: Requirement 2.5, 12.1
// ---------------------------------------------------------------------------

describe('Property 5: Success Rate Bounds — null or in [0, 100]', () => {
  it('property: success_rate_percent is null when there are zero jobs', async () => {
    await fc.assert(
      fc.asyncProperty(rangeArb, async (range) => {
        const db = makeFakeDb([]);
        const metrics = await computePerformanceMetrics(db, 'ws-test', range);

        expect(metrics.success_rate_percent).toBeNull();
      }),
      { numRuns: 50 },
    );
  });

  it('property: success_rate_percent is in [0, 100] for any non-empty dataset', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyRowsArb, rangeArb, async (rows, range) => {
        const db = makeFakeDb(rows);
        const metrics = await computePerformanceMetrics(db, 'ws-test', range);

        // Non-empty dataset → success_rate must be a number, not null
        expect(metrics.success_rate_percent).not.toBeNull();

        const rate = metrics.success_rate_percent as number;
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThanOrEqual(100);
      }),
      { numRuns: 300 },
    );
  });

  it('property: success_rate_percent is 100 when all jobs have status "done"', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ duration_ms: durationArb, status: fc.constant('done') }),
          { minLength: 1, maxLength: 100 },
        ),
        rangeArb,
        async (rows, range) => {
          const db = makeFakeDb(rows);
          const metrics = await computePerformanceMetrics(db, 'ws-test', range);

          expect(metrics.success_rate_percent).toBe(100);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: success_rate_percent is 0 when no jobs have status "done"', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            duration_ms: durationArb,
            status: fc.constantFrom('error', 'running', 'reported'),
          }),
          { minLength: 1, maxLength: 100 },
        ),
        rangeArb,
        async (rows, range) => {
          const db = makeFakeDb(rows);
          const metrics = await computePerformanceMetrics(db, 'ws-test', range);

          expect(metrics.success_rate_percent).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Requirement 2.5: Zero-job case — all metric fields are null
//
// When the workspace has zero jobs in the selected range, ALL nullable metric
// fields must be null and total_jobs must be 0.
// ---------------------------------------------------------------------------

describe('Requirement 2.5: Zero-job case — all metric fields are null', () => {
  it('should return all metric fields as null when there are zero jobs', async () => {
    await fc.assert(
      fc.asyncProperty(rangeArb, async (range) => {
        const db = makeFakeDb([]);
        const metrics = await computePerformanceMetrics(db, 'ws-empty', range);

        expect(metrics.total_jobs).toBe(0);
        expect(metrics.avg_duration_ms).toBeNull();
        expect(metrics.median_duration_ms).toBeNull();
        expect(metrics.p95_duration_ms).toBeNull();
        expect(metrics.p99_duration_ms).toBeNull();
        expect(metrics.throughput_per_hour).toBeNull();
        expect(metrics.throughput_per_day).toBeNull();
        expect(metrics.success_rate_percent).toBeNull();
      }),
      { numRuns: 50 },
    );
  });

  it('should return actual computed values (not null) when there is at least one job', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(metricsRowArb, { minLength: 1, maxLength: 50 }),
        rangeArb,
        async (rows, range) => {
          const db = makeFakeDb(rows);
          const metrics = await computePerformanceMetrics(db, 'ws-test', range);

          // total_jobs must reflect the row count
          expect(metrics.total_jobs).toBe(rows.length);

          // All duration percentiles and throughput must be non-null
          expect(metrics.avg_duration_ms).not.toBeNull();
          expect(metrics.median_duration_ms).not.toBeNull();
          expect(metrics.p95_duration_ms).not.toBeNull();
          expect(metrics.p99_duration_ms).not.toBeNull();
          expect(metrics.throughput_per_hour).not.toBeNull();
          expect(metrics.throughput_per_day).not.toBeNull();
          expect(metrics.success_rate_percent).not.toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('should preserve workspace_id and range in the returned metrics', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }),
        rangeArb,
        fc.array(metricsRowArb, { minLength: 0, maxLength: 20 }),
        async (workspaceId, range, rows) => {
          const db = makeFakeDb(rows);
          const metrics = await computePerformanceMetrics(db, workspaceId, range);

          expect(metrics.workspace_id).toBe(workspaceId);
          expect(metrics.range).toBe(range);
        },
      ),
      { numRuns: 100 },
    );
  });
});
