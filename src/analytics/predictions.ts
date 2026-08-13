/**
 * Predictive analytics computation for the analytics layer.
 *
 * Estimates remaining time, confidence, success probability, and anomaly
 * detection for a currently-running job, based on historical durations of
 * completed jobs of the same type.
 *
 * Cold-start behaviour: when fewer than 5 completed jobs of the same type
 * exist, all prediction fields are returned as `null` with `cold_start: true`
 * (AC 5.7).
 *
 * @example
 * ```ts
 * import { estimateETA } from './predictions.ts';
 *
 * const metrics = await estimateETA(db, 'job-abc-123');
 * if (!metrics.cold_start) {
 *   console.log(metrics.estimated_completion_at); // e.g. '2025-01-01T10:30:00.000Z'
 * }
 * ```
 */

import type { DbAdapter } from '../db/adapter.js';

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

/**
 * Predictive metrics for a currently-running job.
 *
 * All prediction fields (`estimated_remaining_ms`, `estimated_completion_at`,
 * `confidence_score`, `success_probability`, `anomaly_score`) are `null` when
 * `cold_start` is `true` (fewer than 5 historical samples).
 *
 * - `confidence_score` is in range [0, 1] when non-null (AC 5.2).
 * - `anomaly_score` is in range [0, 100] when non-null (AC 5.6).
 * - `success_probability` is in range [0, 1] when non-null (AC 5.4).
 */
export type PredictiveMetrics = {
  job_id: string;
  job_type: string;
  elapsed_ms: number;
  /** Estimated milliseconds remaining until job completion; null on cold-start. */
  estimated_remaining_ms: number | null;
  /** ISO 8601 UTC timestamp of estimated completion; null on cold-start. */
  estimated_completion_at: string | null;
  /**
   * Reliability of the estimate in range [0, 1]; null on cold-start.
   * Derived from `max(0, 1 - CV)` where CV = stddev / mean. Capped at 0
   * for high-variance job types (CV ≥ 1.0) — never negative (AC 5.2).
   */
  confidence_score: number | null;
  /** True when CV > 0.5, indicating the estimate may be unreliable (AC 5.3). */
  low_confidence: boolean;
  /**
   * Historical success rate for this job type in range [0, 1]; null on
   * cold-start (AC 5.4).
   */
  success_probability: number | null;
  /** True when elapsed time exceeds twice the historical mean (AC 5.5). */
  is_anomalous: boolean;
  /**
   * Deviation score in range [0, 100]; 0 when not anomalous, null on
   * cold-start (AC 5.6).
   */
  anomaly_score: number | null;
  /** Number of historical completed jobs used for computation. */
  sample_count: number;
  /** True when sample_count < 5 (insufficient data for predictions). */
  cold_start: boolean;
};

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

type JobRow = {
  type: string;
  timestamp: string;
};

type HistoryRow = {
  duration_ms: number;
  status: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum number of completed historical jobs required for predictions (AC 5.7). */
const MIN_SAMPLES = 5;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Compute the arithmetic mean of a non-empty array.
 *
 * @param values - Non-empty array of finite numbers
 */
function mean(values: number[]): number {
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

/**
 * Compute the population standard deviation of a non-empty array.
 *
 * Uses population variance (divide by N, not N-1) for consistency with the
 * design spec's anomaly score formula.
 *
 * @param values  - Non-empty array of finite numbers
 * @param average - Pre-computed arithmetic mean
 */
function stddev(values: number[], average: number): number {
  let sumOfSquares = 0;
  for (const v of values) {
    const diff = v - average;
    sumOfSquares += diff * diff;
  }
  return Math.sqrt(sumOfSquares / values.length);
}

// ---------------------------------------------------------------------------
// Exported function
// ---------------------------------------------------------------------------

/**
 * Estimate the remaining completion time for a currently-running job.
 *
 * Fetches the job from the database, validates it is in `running` status, then
 * queries historical completed jobs of the same type to derive statistical
 * predictions.
 *
 * Throws with message `"Job not found or not running"` when the job does not
 * exist or is not in running state. This error should be caught by the route
 * handler and converted to HTTP 404.
 *
 * @param db    - Database adapter (SQLite or PostgreSQL)
 * @param jobId - Identifier of the running job to predict for
 * @returns Promise resolving to {@link PredictiveMetrics}
 * @throws {Error} If job is not found or not in `running` status
 */
export async function estimateETA(
  db: DbAdapter,
  jobId: string,
): Promise<PredictiveMetrics> {
  // Fetch the running job to confirm it exists and is active.
  const jobResult = await db.query<JobRow>(
    `SELECT type, timestamp FROM jobs WHERE id = ? AND status = 'running'`,
    [jobId],
  );

  if (jobResult.rows.length === 0) {
    throw new Error('Job not found or not running');
  }

  const job = jobResult.rows[0];
  const elapsed_ms = Date.now() - new Date(job.timestamp).getTime();

  // Fetch historical completed jobs of the same type (done or error).
  const historyResult = await db.query<HistoryRow>(
    `SELECT jm.duration_ms, j.status
     FROM job_metrics jm
     JOIN jobs j ON jm.job_id = j.id
     WHERE j.type = ?
       AND j.status IN ('done', 'error')
       AND jm.duration_ms IS NOT NULL`,
    [job.type],
  );

  const sample_count = historyResult.rows.length;

  // Cold-start: insufficient historical data (AC 5.7).
  if (sample_count < MIN_SAMPLES) {
    return {
      job_id: jobId,
      job_type: job.type,
      elapsed_ms,
      estimated_remaining_ms: null,
      estimated_completion_at: null,
      confidence_score: null,
      low_confidence: true,
      success_probability: null,
      is_anomalous: false,
      anomaly_score: null,
      sample_count,
      cold_start: true,
    };
  }

  // Extract durations for statistical computation.
  const durations = historyResult.rows.map((r) => r.duration_ms);

  // Statistical derivation (AC 5.1–5.6).
  const avg = mean(durations);
  const sd = stddev(durations, avg);

  // CV = stddev / mean; guard against mean === 0 to avoid division by zero.
  const cv = avg === 0 ? 0 : sd / avg;

  // AC 5.2: confidence_score = max(0, 1 - CV) — never negative.
  const confidence_score = Math.max(0, 1 - cv);

  // AC 5.3: flag as low confidence when CV > 0.5.
  const low_confidence = cv > 0.5;

  // AC 5.1: estimated remaining time — clamped to 0 so it is never negative.
  const estimated_remaining_ms = Math.max(0, avg - elapsed_ms);
  const estimated_completion_at = new Date(
    Date.now() + estimated_remaining_ms,
  ).toISOString();

  // AC 5.4: success probability from historical success rate.
  const successCount = historyResult.rows.filter(
    (r) => r.status === 'done',
  ).length;
  const success_probability = successCount / sample_count;

  // AC 5.5: anomaly detection — job is anomalous when elapsed exceeds 2× mean.
  const is_anomalous = elapsed_ms > avg * 2;

  // AC 5.6: anomaly score 0–100, scaled on standard deviation.
  // 0 when not anomalous; otherwise capped at 100.
  const anomaly_score: number =
    is_anomalous && sd > 0
      ? Math.min(100, Math.round(((elapsed_ms - avg) / sd) * 10))
      : 0;

  return {
    job_id: jobId,
    job_type: job.type,
    elapsed_ms,
    estimated_remaining_ms,
    estimated_completion_at,
    confidence_score,
    low_confidence,
    success_probability,
    is_anomalous,
    anomaly_score,
    sample_count,
    cold_start: false,
  };
}
