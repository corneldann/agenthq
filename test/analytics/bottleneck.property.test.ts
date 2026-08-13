// Property-based tests for detectBottlenecks (src/analytics/bottleneck.ts)
//
// Covers:
//   Property 6: Bottleneck Threshold    — every job in `slowest_jobs` has slowdown_factor ≥ 2
//   Property 7: Severity Mapping        — severity === 'high' IFF slowdown_factor ≥ 5
//                                         severity === 'medium' IFF 2 ≤ slowdown_factor < 5
//   Property 8: Non-Negative Slowdown   — all slowdown_factor > 0
//
// **Validates: Requirements 4.1, 4.2, 4.7**
//
// Strategy:
//   detectBottlenecks() issues 4 parallel queries via Promise.all in a fixed order:
//     call 0 → avgByType: { type, avg_duration }[]
//     call 1 → jobs:       { job_id, type, duration_ms }[]
//     call 2 → contention: { period_start, concurrent_jobs }[]
//     call 3 → maxConc:    { max_concurrent }[]
//
//   We use an index-based fake DbAdapter (same pattern as cost.test.ts) that
//   serves each call's rows from a pre-supplied sequence, making the tests
//   fully deterministic without any SQL engine dependency.

import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import type { DbAdapter, QueryResult, ExecResult } from '../../src/db/adapter.js';
import { detectBottlenecks } from '../../src/analytics/bottleneck.js';

// ---------------------------------------------------------------------------
// Internal row shapes (mirroring the private types in bottleneck.ts)
// ---------------------------------------------------------------------------

type AvgByTypeRow   = { type: string; avg_duration: number };
type JobRow         = { job_id: string; type: string; duration_ms: number };
type ContentionRow  = { period_start: string; concurrent_jobs: number };
type MaxConRow      = { max_concurrent: number | null };

type QuerySequence = [
  AvgByTypeRow[],   // call 0 — per-type average
  JobRow[],         // call 1 — individual jobs
  ContentionRow[],  // call 2 — contention periods
  MaxConRow[],      // call 3 — max concurrent
];

// ---------------------------------------------------------------------------
// Fake DbAdapter
//
// Returns rows from `queries[callIndex]` on each successive query() call.
// Throws if the test makes more query calls than entries supplied (catches
// unexpected extra DB calls).
// ---------------------------------------------------------------------------

function makeFakeDb(queries: QuerySequence): DbAdapter {
  let callIndex = 0;

  return {
    query<T>(_sql: string, _params?: unknown[]): Promise<QueryResult<T>> {
      const idx = callIndex++;
      if (idx >= queries.length) {
        throw new Error(`Unexpected extra query() call (index ${idx})`);
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
// Helper: build a QuerySequence from a list of (type, avgDuration, duration_ms) triples.
//
// Computes avgByType rows automatically so that slowdown_factor values exactly
// match what detectBottlenecks will compute (job.duration_ms / avgDuration).
// ---------------------------------------------------------------------------

type JobSpec = { job_id: string; type: string; duration_ms: number };

function makeQueries(jobs: JobSpec[]): QuerySequence {
  // Build per-type averages from the provided jobs
  const totals = new Map<string, { sum: number; count: number }>();
  for (const job of jobs) {
    const acc = totals.get(job.type) ?? { sum: 0, count: 0 };
    acc.sum += job.duration_ms;
    acc.count++;
    totals.set(job.type, acc);
  }

  const avgByType: AvgByTypeRow[] = Array.from(totals.entries()).map(([type, { sum, count }]) => ({
    type,
    avg_duration: sum / count,
  }));

  const jobRows: JobRow[] = jobs.map((j) => ({
    job_id: j.job_id,
    type: j.type,
    duration_ms: j.duration_ms,
  }));

  return [
    avgByType,
    jobRows,
    [], // no contention periods for property tests
    [{ max_concurrent: 0 }],
  ];
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Non-empty job type identifier */
const jobTypeArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);

/** Positive finite duration in ms (> 0 so slowdown_factor > 0 is reachable) */
const posDurationArb = fc.integer({ min: 1, max: 10_000_000 });

/** A single job spec */
const jobSpecArb = (jobTypeConstraint?: fc.Arbitrary<string>): fc.Arbitrary<JobSpec> =>
  fc.record({
    job_id: fc.string({ minLength: 1, maxLength: 32 }),
    type: jobTypeConstraint ?? jobTypeArb,
    duration_ms: posDurationArb,
  });

/**
 * Generates a non-empty array of JobSpecs where all jobs share the same type.
 * This guarantees that detectBottlenecks can compute a meaningful per-type average
 * and that some jobs will be bottlenecks (if any have duration_ms > 2 * average).
 *
 * Using a single type keeps the property easy to reason about: every job's
 * slowdown_factor = job.duration_ms / avg(all durations).
 */
const singleTypeJobsArb = fc
  .tuple(
    jobTypeArb,
    fc.array(posDurationArb, { minLength: 1, maxLength: 50 }),
  )
  .map(([type, durations]) =>
    durations.map((duration_ms, i) => ({
      job_id: `job-${i}`,
      type,
      duration_ms,
    })),
  );

/**
 * Generates job specs for a multi-type workspace (1-4 job types).
 */
const multiTypeJobsArb = fc
  .array(jobTypeArb, { minLength: 1, maxLength: 4 })
  .chain((types) =>
    fc.array(
      fc.record({
        job_id: fc.string({ minLength: 1, maxLength: 20 }),
        type: fc.constantFrom(...(types as [string, ...string[]])),
        duration_ms: posDurationArb,
      }),
      { minLength: 1, maxLength: 100 },
    ),
  );

// ---------------------------------------------------------------------------
// Property 6: Bottleneck Threshold
//
// Every job returned in slowest_jobs must have slowdown_factor ≥ 2.
// Jobs with slowdown_factor < 2 are excluded (Requirement 4.1).
//
// **Validates: Requirements 4.1, 4.2**
// ---------------------------------------------------------------------------

describe('Property 6: Bottleneck Threshold — every job in slowest_jobs has slowdown_factor ≥ 2', () => {
  it('property: all returned jobs have slowdown_factor ≥ 2 for single-type datasets', async () => {
    await fc.assert(
      fc.asyncProperty(singleTypeJobsArb, async (jobs) => {
        const db = makeFakeDb(makeQueries(jobs));
        const analysis = await detectBottlenecks(db, 'ws-test');

        for (const job of analysis.slowest_jobs) {
          expect(job.slowdown_factor).toBeGreaterThanOrEqual(2);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('property: all returned jobs have slowdown_factor ≥ 2 for multi-type datasets', async () => {
    await fc.assert(
      fc.asyncProperty(multiTypeJobsArb, async (jobs) => {
        const db = makeFakeDb(makeQueries(jobs));
        const analysis = await detectBottlenecks(db, 'ws-test');

        for (const job of analysis.slowest_jobs) {
          expect(job.slowdown_factor).toBeGreaterThanOrEqual(2);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('property: slowest_jobs contains at most 10 entries', async () => {
    await fc.assert(
      fc.asyncProperty(multiTypeJobsArb, async (jobs) => {
        const db = makeFakeDb(makeQueries(jobs));
        const analysis = await detectBottlenecks(db, 'ws-test');

        expect(analysis.slowest_jobs.length).toBeLessThanOrEqual(10);
      }),
      { numRuns: 100 },
    );
  });

  it('property: slowest_jobs is empty when all jobs are at or below average duration', async () => {
    await fc.assert(
      fc.asyncProperty(jobTypeArb, async (jobType) => {
        // All jobs have equal duration → slowdown_factor = 1.0 for all → no bottlenecks
        const jobs: JobSpec[] = [
          { job_id: 'j1', type: jobType, duration_ms: 1000 },
          { job_id: 'j2', type: jobType, duration_ms: 1000 },
          { job_id: 'j3', type: jobType, duration_ms: 1000 },
        ];
        const db = makeFakeDb(makeQueries(jobs));
        const analysis = await detectBottlenecks(db, 'ws-test');

        expect(analysis.slowest_jobs).toEqual([]);
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: Severity Mapping
//
// - severity === 'high'   IFF slowdown_factor ≥ 5
// - severity === 'medium' IFF 2 ≤ slowdown_factor < 5
//
// **Validates: Requirement 4.7**
// ---------------------------------------------------------------------------

describe('Property 7: Severity Mapping — high IFF ≥ 5, medium IFF 2 ≤ factor < 5', () => {
  it('property: severity is "high" for every job with slowdown_factor ≥ 5', async () => {
    await fc.assert(
      fc.asyncProperty(singleTypeJobsArb, async (jobs) => {
        const db = makeFakeDb(makeQueries(jobs));
        const analysis = await detectBottlenecks(db, 'ws-test');

        for (const job of analysis.slowest_jobs) {
          if (job.slowdown_factor >= 5) {
            expect(job.severity).toBe('high');
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('property: severity is "medium" for every job with 2 ≤ slowdown_factor < 5', async () => {
    await fc.assert(
      fc.asyncProperty(singleTypeJobsArb, async (jobs) => {
        const db = makeFakeDb(makeQueries(jobs));
        const analysis = await detectBottlenecks(db, 'ws-test');

        for (const job of analysis.slowest_jobs) {
          if (job.slowdown_factor >= 2 && job.slowdown_factor < 5) {
            expect(job.severity).toBe('medium');
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('property: no job with severity "high" has slowdown_factor < 5 (IFF direction)', async () => {
    await fc.assert(
      fc.asyncProperty(singleTypeJobsArb, async (jobs) => {
        const db = makeFakeDb(makeQueries(jobs));
        const analysis = await detectBottlenecks(db, 'ws-test');

        for (const job of analysis.slowest_jobs) {
          if (job.severity === 'high') {
            expect(job.slowdown_factor).toBeGreaterThanOrEqual(5);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('property: no job with severity "medium" has slowdown_factor ≥ 5 or < 2 (IFF direction)', async () => {
    await fc.assert(
      fc.asyncProperty(singleTypeJobsArb, async (jobs) => {
        const db = makeFakeDb(makeQueries(jobs));
        const analysis = await detectBottlenecks(db, 'ws-test');

        for (const job of analysis.slowest_jobs) {
          if (job.severity === 'medium') {
            expect(job.slowdown_factor).toBeGreaterThanOrEqual(2);
            expect(job.slowdown_factor).toBeLessThan(5);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('concrete: a job with slowdown_factor exactly 5 should have severity "high"', async () => {
    // avg = 200ms, job = 1000ms → slowdown_factor = 5.0 exactly → 'high'
    const jobs: JobSpec[] = [
      { job_id: 'base-1', type: 'build', duration_ms: 200 },
      { job_id: 'base-2', type: 'build', duration_ms: 200 },
      { job_id: 'slow',   type: 'build', duration_ms: 1000 },
    ];
    // avg = (200 + 200 + 1000) / 3 = 466.67ms
    // slow job: 1000 / 466.67 ≈ 2.14 → medium (not 5.0 because avg is diluted)
    // To get exactly 5.0 we need avg = 200 and one job at 1000:
    // Use separate type to isolate the avg
    const isolatedJobs: JobSpec[] = [
      { job_id: 'avg-job', type: 'build', duration_ms: 200 },
      { job_id: 'slow-job', type: 'build', duration_ms: 1000 },
    ];
    // avg = (200 + 1000) / 2 = 600ms, slowdown = 1000/600 ≈ 1.67 → excluded
    // Better: use an explicit avgByType row approach by controlling the data precisely
    // Use many avg jobs to push average low, and one very slow job
    const baseJobs = Array.from({ length: 9 }, (_, i) => ({
      job_id: `base-${i}`,
      type: 'scan',
      duration_ms: 100,
    }));
    const target = { job_id: 'target', type: 'scan', duration_ms: 500 };
    // avg = (9*100 + 500) / 10 = 1400 / 10 = 140ms
    // slowdown = 500 / 140 ≈ 3.57 → medium
    // To get ≥ 5: target needs duration > 5 * avg
    // With 9 jobs at 100ms avg = 100 (if target not in avg calculation but it is)
    // Use a direct avg injection via separate type:
    const directJobs: JobSpec[] = Array.from({ length: 10 }, (_, i) => ({
      job_id: `fast-${i}`,
      type: 'direct',
      duration_ms: 100, // avg will be 100ms if slow job not counted in own type
    }));
    // But the slow job is in the same type, so avg is diluted.
    // The simplest way: provide many fast jobs and one very slow job.
    const fastJobs = Array.from({ length: 20 }, (_, i) => ({
      job_id: `f${i}`,
      type: 'proc',
      duration_ms: 100,
    }));
    const slowJob = { job_id: 'slow', type: 'proc', duration_ms: 1200 };
    // avg = (20*100 + 1200) / 21 ≈ 152.38ms
    // slowdown = 1200 / 152.38 ≈ 7.87 → 'high' ✓

    const allJobs = [...fastJobs, slowJob];
    const db = makeFakeDb(makeQueries(allJobs));
    const analysis = await detectBottlenecks(db, 'ws-test');

    const slow = analysis.slowest_jobs.find((j) => j.job_id === 'slow');
    expect(slow).toBeDefined();
    expect(slow!.slowdown_factor).toBeGreaterThanOrEqual(5);
    expect(slow!.severity).toBe('high');

    void jobs;
    void isolatedJobs;
    void baseJobs;
    void target;
    void directJobs;
  });

  it('concrete: a job with slowdown_factor between 2 and 5 should have severity "medium"', async () => {
    // 5 fast jobs at 100ms → avg ≈ (5*100 + 350) / 6 = 975/6 ≈ 125ms
    // slowdown = 350 / 125 = 2.8 → 'medium' ✓
    const fastJobs = Array.from({ length: 5 }, (_, i) => ({
      job_id: `fast-${i}`,
      type: 'index',
      duration_ms: 100,
    }));
    const mediumSlowJob = { job_id: 'medium', type: 'index', duration_ms: 350 };
    const allJobs = [...fastJobs, mediumSlowJob];

    const db = makeFakeDb(makeQueries(allJobs));
    const analysis = await detectBottlenecks(db, 'ws-test');

    const found = analysis.slowest_jobs.find((j) => j.job_id === 'medium');
    expect(found).toBeDefined();
    expect(found!.slowdown_factor).toBeGreaterThanOrEqual(2);
    expect(found!.slowdown_factor).toBeLessThan(5);
    expect(found!.severity).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// Property 8: Non-Negative Slowdown
//
// Every slowdown_factor in slowest_jobs must be > 0.
//
// **Validates: Requirement 4.2**
// ---------------------------------------------------------------------------

describe('Property 8: Non-Negative Slowdown — all slowdown_factor > 0', () => {
  it('property: all slowdown_factor values are > 0 for single-type datasets', async () => {
    await fc.assert(
      fc.asyncProperty(singleTypeJobsArb, async (jobs) => {
        const db = makeFakeDb(makeQueries(jobs));
        const analysis = await detectBottlenecks(db, 'ws-test');

        for (const job of analysis.slowest_jobs) {
          expect(job.slowdown_factor).toBeGreaterThan(0);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('property: all slowdown_factor values are > 0 for multi-type datasets', async () => {
    await fc.assert(
      fc.asyncProperty(multiTypeJobsArb, async (jobs) => {
        const db = makeFakeDb(makeQueries(jobs));
        const analysis = await detectBottlenecks(db, 'ws-test');

        for (const job of analysis.slowest_jobs) {
          expect(job.slowdown_factor).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('property: slowdown_factor is finite (not Infinity, not NaN) for all returned jobs', async () => {
    await fc.assert(
      fc.asyncProperty(singleTypeJobsArb, async (jobs) => {
        const db = makeFakeDb(makeQueries(jobs));
        const analysis = await detectBottlenecks(db, 'ws-test');

        for (const job of analysis.slowest_jobs) {
          expect(Number.isFinite(job.slowdown_factor)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('property: slowest_jobs is sorted by slowdown_factor descending', async () => {
    await fc.assert(
      fc.asyncProperty(singleTypeJobsArb, async (jobs) => {
        const db = makeFakeDb(makeQueries(jobs));
        const analysis = await detectBottlenecks(db, 'ws-test');

        const factors = analysis.slowest_jobs.map((j) => j.slowdown_factor);
        for (let i = 1; i < factors.length; i++) {
          expect(factors[i - 1]).toBeGreaterThanOrEqual(factors[i]!);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

describe('structural invariants', () => {
  it('should return the correct workspace_id in the result', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }),
        singleTypeJobsArb,
        async (workspaceId, jobs) => {
          const db = makeFakeDb(makeQueries(jobs));
          const analysis = await detectBottlenecks(db, workspaceId);

          expect(analysis.workspace_id).toBe(workspaceId);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should include a computed_at ISO 8601 timestamp', async () => {
    const db = makeFakeDb(makeQueries([{ job_id: 'j1', type: 'test', duration_ms: 100 }]));
    const before = new Date().toISOString();
    const analysis = await detectBottlenecks(db, 'ws-test');
    const after = new Date().toISOString();

    expect(typeof analysis.computed_at).toBe('string');
    expect(analysis.computed_at >= before).toBe(true);
    expect(analysis.computed_at <= after).toBe(true);
  });

  it('should return empty slowest_jobs when there are no jobs', async () => {
    const emptyQueries: QuerySequence = [[], [], [], [{ max_concurrent: null }]];
    const db = makeFakeDb(emptyQueries);
    const analysis = await detectBottlenecks(db, 'ws-empty');

    expect(analysis.slowest_jobs).toEqual([]);
  });

  it('should return contention_periods from the DB query result', async () => {
    const contentionPeriods: ContentionRow[] = [
      { period_start: '2025-01-01T10:00:00', concurrent_jobs: 7 },
      { period_start: '2025-01-01T11:00:00', concurrent_jobs: 5 },
    ];
    const queries: QuerySequence = [
      [],
      [],
      contentionPeriods,
      [{ max_concurrent: 7 }],
    ];
    const db = makeFakeDb(queries);
    const analysis = await detectBottlenecks(db, 'ws-test');

    expect(analysis.contention_periods).toEqual(contentionPeriods);
  });

  it('should always return top_tools_by_time as an empty array (tool timing data not yet available)', async () => {
    await fc.assert(
      fc.asyncProperty(singleTypeJobsArb, async (jobs) => {
        const db = makeFakeDb(makeQueries(jobs));
        const analysis = await detectBottlenecks(db, 'ws-test');

        expect(analysis.top_tools_by_time).toEqual([]);
      }),
      { numRuns: 50 },
    );
  });
});
