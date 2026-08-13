// Property-based tests for estimateETA (src/analytics/predictions.ts)
//
// Covers:
//   Property 9:  Cold-Start Nulls      — if sample_count < 5, all prediction fields are NULL
//   Property 10: Confidence Score Bounds — confidence_score ? [0, 1] when non-null
//   Property 11: Anomaly Consistency   — is_anomalous === true IFF elapsed_ms > 2 * mean
//
// **Validates: Requirements 5.2, 5.3, 5.7, 12.1**
//
// Strategy:
//   estimateETA() issues exactly 2 sequential queries via db.query():
//     call 0 ? jobRow:     { type, timestamp }[]   (= 1 row; empty = job not found/not running)
//     call 1 ? historyRows: { duration_ms, status }[]
//
//   We use an index-based fake DbAdapter that serves each call's rows from a
//   pre-supplied sequence, making all tests deterministic without an SQL engine.
//   This is the same pattern as metrics.property.test.ts and bottleneck.property.test.ts.

import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import type { DbAdapter, QueryResult, ExecResult } from '../../src/db/adapter.js';
import { estimateETA } from '../../src/analytics/predictions.js';

// ---------------------------------------------------------------------------
// Internal row shapes (matching the private types in predictions.ts)
// ---------------------------------------------------------------------------

type JobRow     = { type: string; timestamp: string };
type HistoryRow = { duration_ms: number; status: string };

type QuerySequence = [
  JobRow[],      // call 0 — the running job (1 row for found, 0 for not found)
  HistoryRow[],  // call 1 — historical completed jobs
];

// ---------------------------------------------------------------------------
// Fake DbAdapter
//
// Returns rows from queries[callIndex] on each successive query() call.
// Throws for any unexpected extra call so tests surface accidental extra queries.
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
// Helper: build a QuerySequence for a running job with given history rows.
//
// The job's `timestamp` is set to `startedMsAgo` milliseconds before now so
// that elapsed_ms ˜ startedMsAgo.  We use a rounded value to avoid timing
// jitter in assertions.
// ---------------------------------------------------------------------------

function makeQueries(
  jobType: string,
  startedMsAgo: number,
  historyRows: HistoryRow[],
): QuerySequence {
  const timestamp = new Date(Date.now() - startedMsAgo).toISOString();
  return [
    [{ type: jobType, timestamp }],
    historyRows,
  ];
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Valid job type string (non-empty, no leading/trailing whitespace). */
const jobTypeArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => s.trim() === s && s.length > 0);

/** Non-negative finite duration in milliseconds (1 ms – 10 000 000 ms). */
const posDurationArb = fc.integer({ min: 1, max: 10_000_000 });

/** Elapsed time for the running job (0 ms – 10 000 000 ms). */
const elapsedArb = fc.integer({ min: 0, max: 10_000_000 });

/** A single HistoryRow with positive duration and a terminal status. */
const historyRowArb: fc.Arbitrary<HistoryRow> = fc.record({
  duration_ms: posDurationArb,
  status: fc.constantFrom('done', 'error'),
});

/** Fewer than MIN_SAMPLES (5) history rows ? cold-start. */
const coldStartHistoryArb = fc.array(historyRowArb, { minLength: 0, maxLength: 4 });

/** At least MIN_SAMPLES (5) history rows ? predictions are computed. */
const warmHistoryArb = fc.array(historyRowArb, { minLength: 5, maxLength: 200 });

// ---------------------------------------------------------------------------
// Property 9: Cold-Start Nulls
//
// When sample_count < 5, all prediction fields must be null:
//   estimated_remaining_ms, estimated_completion_at, confidence_score,
//   success_probability, anomaly_score
// AND cold_start must be true.
//
// **Validates: Requirement 5.7**
// ---------------------------------------------------------------------------

describe('Property 9: Cold-Start Nulls — sample_count < 5 ? all predictions null', () => {
  it('property: all prediction fields are null when history has 0–4 rows', async () => {
    await fc.assert(
      fc.asyncProperty(
        jobTypeArb,
        elapsedArb,
        coldStartHistoryArb,
        async (jobType, elapsed, history) => {
          // Arrange
          const db = makeFakeDb(makeQueries(jobType, elapsed, history));

          // Act
          const metrics = await estimateETA(db, 'job-cold-start');

          // Assert
          expect(metrics.cold_start).toBe(true);
          expect(metrics.sample_count).toBe(history.length);
          expect(metrics.sample_count).toBeLessThan(5);

          expect(metrics.estimated_remaining_ms).toBeNull();
          expect(metrics.estimated_completion_at).toBeNull();
          expect(metrics.confidence_score).toBeNull();
          expect(metrics.success_probability).toBeNull();
          expect(metrics.anomaly_score).toBeNull();
        },
      ),
      { numRuns: 300 },
    );
  });

  it('property: cold_start is false when history has = 5 rows', async () => {
    await fc.assert(
      fc.asyncProperty(
        jobTypeArb,
        elapsedArb,
        warmHistoryArb,
        async (jobType, elapsed, history) => {
          // Arrange
          const db = makeFakeDb(makeQueries(jobType, elapsed, history));

          // Act
          const metrics = await estimateETA(db, 'job-warm');

          // Assert
          expect(metrics.cold_start).toBe(false);
          expect(metrics.sample_count).toBeGreaterThanOrEqual(5);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('property: prediction fields are non-null when history has exactly 5 rows', async () => {
    await fc.assert(
      fc.asyncProperty(
        jobTypeArb,
        elapsedArb,
        fc.array(historyRowArb, { minLength: 5, maxLength: 5 }),
        async (jobType, elapsed, history) => {
          // Arrange
          const db = makeFakeDb(makeQueries(jobType, elapsed, history));

          // Act
          const metrics = await estimateETA(db, 'job-exactly-five');

          // Assert
          expect(metrics.cold_start).toBe(false);
          expect(metrics.confidence_score).not.toBeNull();
          expect(metrics.success_probability).not.toBeNull();
          // anomaly_score is 0 (a number) when not anomalous, not null
          expect(metrics.anomaly_score).not.toBeNull();
        },
      ),
      { numRuns: 150 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10: Confidence Score Bounds
//
// When non-null (sample_count = 5), confidence_score must be in [0, 1].
// Derived from max(0, 1 - CV) so it is naturally = 0 (AC 5.2) and = 1
// (CV = 0 always).
//
// **Validates: Requirements 5.2, 12.1**
// ---------------------------------------------------------------------------

describe('Property 10: Confidence Score Bounds — confidence_score ? [0, 1] when non-null', () => {
  it('property: confidence_score is = 0 for any warm dataset', async () => {
    await fc.assert(
      fc.asyncProperty(
        jobTypeArb,
        elapsedArb,
        warmHistoryArb,
        async (jobType, elapsed, history) => {
          // Arrange
          const db = makeFakeDb(makeQueries(jobType, elapsed, history));

          // Act
          const metrics = await estimateETA(db, 'job-warm');

          // Assert
          expect(metrics.confidence_score).not.toBeNull();
          expect(metrics.confidence_score as number).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('property: confidence_score is = 1 for any warm dataset', async () => {
    await fc.assert(
      fc.asyncProperty(
        jobTypeArb,
        elapsedArb,
        warmHistoryArb,
        async (jobType, elapsed, history) => {
          // Arrange
          const db = makeFakeDb(makeQueries(jobType, elapsed, history));

          // Act
          const metrics = await estimateETA(db, 'job-warm');

          // Assert
          expect(metrics.confidence_score).not.toBeNull();
          expect(metrics.confidence_score as number).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('property: confidence_score is 0 for extremely high-variance datasets (CV = 1)', async () => {
    // A dataset with one tiny and one enormous value has CV >> 1; score is capped at 0.
    await fc.assert(
      fc.asyncProperty(
        jobTypeArb,
        elapsedArb,
        // Generate 5+ rows whose stddev / mean will be = 1
        fc
          .array(
            fc.record({
              duration_ms: fc.integer({ min: 1, max: 10 }),
              status: fc.constant('done' as const),
            }),
            { minLength: 4, maxLength: 49 },
          )
          .chain((smallRows) =>
            fc
              .integer({ min: 1_000_000, max: 10_000_000 })
              .map((bigDuration) => [
                ...smallRows,
                { duration_ms: bigDuration, status: 'done' as const },
              ]),
          ),
        async (jobType, elapsed, history) => {
          // Arrange
          const db = makeFakeDb(makeQueries(jobType, elapsed, history));

          // Act
          const metrics = await estimateETA(db, 'job-highvar');

          // Assert — confidence is capped at 0 (never negative) for high CV
          if (metrics.confidence_score !== null) {
            expect(metrics.confidence_score).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('concrete: constant-duration dataset has confidence_score of 1 (CV = 0)', async () => {
    // When all durations are equal, stddev = 0, CV = 0, confidence = 1.
    const constantHistory: HistoryRow[] = Array.from({ length: 10 }, () => ({
      duration_ms: 5000,
      status: 'done' as const,
    }));
    const db = makeFakeDb(makeQueries('test-type', 1000, constantHistory));

    const metrics = await estimateETA(db, 'job-constant');

    expect(metrics.cold_start).toBe(false);
    expect(metrics.confidence_score).toBe(1);
  });

  it('concrete: confidence_score is in [0, 1] even when CV > 1 (high-variance history)', async () => {
    // CV will be >> 1 ? confidence = max(0, 1 - CV) = 0
    const highVarHistory: HistoryRow[] = [
      { duration_ms: 1,         status: 'done'  },
      { duration_ms: 1,         status: 'done'  },
      { duration_ms: 1,         status: 'done'  },
      { duration_ms: 1,         status: 'done'  },
      { duration_ms: 10_000_000, status: 'done' },
    ];
    const db = makeFakeDb(makeQueries('test-type', 500, highVarHistory));

    const metrics = await estimateETA(db, 'job-highvar-concrete');

    expect(metrics.confidence_score).not.toBeNull();
    expect(metrics.confidence_score as number).toBeGreaterThanOrEqual(0);
    expect(metrics.confidence_score as number).toBeLessThanOrEqual(1);
    // With extremely high CV the score should be 0
    expect(metrics.confidence_score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Property 11: Anomaly Consistency
//
// is_anomalous === true IFF elapsed_ms > 2 * mean(historical durations).
// This is a biconditional: the IFF must hold in both directions.
//
// **Validates: Requirement 5.5, 12.1**
// ---------------------------------------------------------------------------

describe('Property 11: Anomaly Consistency — is_anomalous IFF elapsed_ms > 2 * mean', () => {
  it('property: is_anomalous is true when elapsed_ms > 2 * mean (forward direction)', async () => {
    await fc.assert(
      fc.asyncProperty(
        jobTypeArb,
        warmHistoryArb,
        async (jobType, history) => {
          // Arrange: compute mean from history and pick an elapsed > 2 * mean
          const avg =
            history.reduce((sum, r) => sum + r.duration_ms, 0) / history.length;
          const elapsedMsAgo = Math.ceil(avg * 2) + 1; // strictly > 2 * mean

          const db = makeFakeDb(makeQueries(jobType, elapsedMsAgo, history));

          // Act
          const metrics = await estimateETA(db, 'job-anomalous');

          // Assert — must be flagged anomalous
          expect(metrics.is_anomalous).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('property: is_anomalous is false when elapsed_ms = mean (clearly not anomalous)', async () => {
    await fc.assert(
      fc.asyncProperty(
        jobTypeArb,
        warmHistoryArb,
        async (jobType, history) => {
          // Arrange: elapsed is at most the mean (well within normal range)
          const avg =
            history.reduce((sum, r) => sum + r.duration_ms, 0) / history.length;
          const elapsedMsAgo = Math.max(0, Math.floor(avg * 0.5)); // half the mean

          const db = makeFakeDb(makeQueries(jobType, elapsedMsAgo, history));

          // Act
          const metrics = await estimateETA(db, 'job-normal');

          // Assert — elapsed = mean, so not anomalous
          expect(metrics.is_anomalous).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('property: is_anomalous is false when elapsed_ms equals exactly 2 * mean (boundary)', async () => {
    await fc.assert(
      fc.asyncProperty(
        jobTypeArb,
        warmHistoryArb,
        async (jobType, history) => {
          // Arrange: elapsed = exactly 2 * mean ? NOT anomalous (strict >)
          const avg =
            history.reduce((sum, r) => sum + r.duration_ms, 0) / history.length;
          const elapsedMsAgo = Math.round(avg * 2); // floor rounding keeps = 2*mean

          const db = makeFakeDb(makeQueries(jobType, elapsedMsAgo, history));

          // Act
          const metrics = await estimateETA(db, 'job-boundary');

          // Assert — elapsed === 2 * mean ? is_anomalous must be false (strict >)
          // Due to integer rounding elapsed_ms may differ from elapsedMsAgo by = 1ms;
          // we only assert the boundary case when the elapsed truly equals 2*avg.
          const actualElapsed = metrics.elapsed_ms;
          if (actualElapsed <= avg * 2) {
            expect(metrics.is_anomalous).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('concrete: job elapsed 3× the mean is anomalous', async () => {
    // All 5 history durations = 1000ms ? mean = 1000ms.
    // Elapsed = 3001ms ? 3001 > 2 * 1000 ? anomalous.
    const history: HistoryRow[] = Array.from({ length: 5 }, () => ({
      duration_ms: 1000,
      status: 'done' as const,
    }));
    const db = makeFakeDb(makeQueries('scan', 3001, history));

    const metrics = await estimateETA(db, 'job-3x');

    expect(metrics.is_anomalous).toBe(true);
    expect(metrics.anomaly_score).not.toBeNull();
    expect(metrics.anomaly_score as number).toBeGreaterThanOrEqual(0);
    expect(metrics.anomaly_score as number).toBeLessThanOrEqual(100);
  });

  it('concrete: job elapsed equal to mean is not anomalous', async () => {
    // All 5 history durations = 1000ms ? mean = 1000ms.
    // Elapsed = 1000ms ? 1000 = 2 * 1000 ? not anomalous.
    const history: HistoryRow[] = Array.from({ length: 5 }, () => ({
      duration_ms: 1000,
      status: 'done' as const,
    }));
    const db = makeFakeDb(makeQueries('scan', 1000, history));

    const metrics = await estimateETA(db, 'job-at-mean');

    expect(metrics.is_anomalous).toBe(false);
    expect(metrics.anomaly_score).toBe(0);
  });

  it('concrete: job elapsed just above 2× mean is anomalous', async () => {
    // 5 history durations = 2000ms ? mean = 2000ms.
    // Elapsed = 4001ms ? 4001 > 2 * 2000 ? anomalous.
    const history: HistoryRow[] = Array.from({ length: 5 }, () => ({
      duration_ms: 2000,
      status: 'done' as const,
    }));
    const db = makeFakeDb(makeQueries('build', 4001, history));

    const metrics = await estimateETA(db, 'job-just-over-2x');

    expect(metrics.is_anomalous).toBe(true);
  });

  it('concrete: job not found throws error', async () => {
    // Empty job row ? estimateETA should throw 'Job not found or not running'
    const queries: QuerySequence = [
      [],                         // call 0: job not found
      [],                         // call 1: (won't be reached)
    ];
    const db = makeFakeDb(queries);

    await expect(estimateETA(db, 'missing-job')).rejects.toThrow(
      'Job not found or not running',
    );
  });
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

describe('structural invariants', () => {
  it('should reflect the correct job_id in the returned metrics', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }),
        jobTypeArb,
        elapsedArb,
        warmHistoryArb,
        async (jobId, jobType, elapsed, history) => {
          // Arrange
          const db = makeFakeDb(makeQueries(jobType, elapsed, history));

          // Act
          const metrics = await estimateETA(db, jobId);

          // Assert
          expect(metrics.job_id).toBe(jobId);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should reflect the correct job_type in the returned metrics', async () => {
    await fc.assert(
      fc.asyncProperty(
        jobTypeArb,
        elapsedArb,
        warmHistoryArb,
        async (jobType, elapsed, history) => {
          // Arrange
          const db = makeFakeDb(makeQueries(jobType, elapsed, history));

          // Act
          const metrics = await estimateETA(db, 'job-test');

          // Assert
          expect(metrics.job_type).toBe(jobType);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return estimated_remaining_ms = 0 (never negative, clamped at 0)', async () => {
    await fc.assert(
      fc.asyncProperty(
        jobTypeArb,
        elapsedArb,
        warmHistoryArb,
        async (jobType, elapsed, history) => {
          // Arrange
          const db = makeFakeDb(makeQueries(jobType, elapsed, history));

          // Act
          const metrics = await estimateETA(db, 'job-remaining');

          // Assert
          if (metrics.estimated_remaining_ms !== null) {
            expect(metrics.estimated_remaining_ms).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('should return success_probability in [0, 1] when non-null', async () => {
    await fc.assert(
      fc.asyncProperty(
        jobTypeArb,
        elapsedArb,
        warmHistoryArb,
        async (jobType, elapsed, history) => {
          // Arrange
          const db = makeFakeDb(makeQueries(jobType, elapsed, history));

          // Act
          const metrics = await estimateETA(db, 'job-prob');

          // Assert
          if (metrics.success_probability !== null) {
            expect(metrics.success_probability).toBeGreaterThanOrEqual(0);
            expect(metrics.success_probability).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('should return anomaly_score in [0, 100] when non-null', async () => {
    await fc.assert(
      fc.asyncProperty(
        jobTypeArb,
        elapsedArb,
        warmHistoryArb,
        async (jobType, elapsed, history) => {
          // Arrange
          const db = makeFakeDb(makeQueries(jobType, elapsed, history));

          // Act
          const metrics = await estimateETA(db, 'job-anomaly');

          // Assert
          if (metrics.anomaly_score !== null) {
            expect(metrics.anomaly_score).toBeGreaterThanOrEqual(0);
            expect(metrics.anomaly_score).toBeLessThanOrEqual(100);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('should return low_confidence true when CV > 0.5 and warm dataset', async () => {
    // high-variance history: 5 values with very different magnitudes ? CV > 0.5
    const highVarHistory: HistoryRow[] = [
      { duration_ms: 100,    status: 'done' },
      { duration_ms: 200,    status: 'done' },
      { duration_ms: 50_000, status: 'done' },
      { duration_ms: 100,    status: 'done' },
      { duration_ms: 100,    status: 'done' },
    ];
    const db = makeFakeDb(makeQueries('build', 1000, highVarHistory));
    const metrics = await estimateETA(db, 'job-lc');

    expect(metrics.cold_start).toBe(false);
    expect(metrics.low_confidence).toBe(true);
  });

  it('should return low_confidence false when all durations are equal (CV = 0)', async () => {
    const constantHistory: HistoryRow[] = Array.from({ length: 10 }, () => ({
      duration_ms: 3000,
      status: 'done' as const,
    }));
    const db = makeFakeDb(makeQueries('build', 500, constantHistory));
    const metrics = await estimateETA(db, 'job-lc-false');

    expect(metrics.cold_start).toBe(false);
    expect(metrics.low_confidence).toBe(false);
    expect(metrics.confidence_score).toBe(1);
  });
});
