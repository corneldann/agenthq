/**
 * Performance metrics computation for the analytics layer.
 *
 * Queries `job_metrics JOIN jobs` for a given workspace and time range, then
 * derives aggregate statistics (avg, median, p95, p99 duration; throughput;
 * success rate). All timestamps are UTC ISO 8601 strings.
 *
 * @example
 * ```ts
 * import { computePerformanceMetrics } from './metrics.ts';
 *
 * const metrics = await computePerformanceMetrics(db, 'ws-123', '7d');
 * console.log(metrics.avg_duration_ms); // e.g. 1234
 * ```
 */

import type { DbAdapter } from '../db/adapter.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Performance metrics for a workspace over a specific time range.
 *
 * All numeric fields are `null` when there are zero jobs in the range (cold
 * state). `total_jobs` is always non-null (0 when no data).
 */
export type PerformanceMetrics = {
  workspace_id: string;
  range: '24h' | '7d' | '30d';
  /** Arithmetic mean of `duration_ms` across all jobs; null when no jobs. */
  avg_duration_ms: number | null;
  /** 50th-percentile (median) duration; null when no jobs. */
  median_duration_ms: number | null;
  /** 95th-percentile duration; null when no jobs. */
  p95_duration_ms: number | null;
  /** 99th-percentile duration; null when no jobs. */
  p99_duration_ms: number | null;
  /** Jobs completed per hour over the range; null when no jobs. */
  throughput_per_hour: number | null;
  /** Jobs completed per calendar day over the range; null when no jobs. */
  throughput_per_day: number | null;
  /**
   * Percentage of jobs with status `done`; null when no jobs.
   * Range [0, 100].
   */
  success_rate_percent: number | null;
  /** Total jobs in the range (always present, 0 when empty). */
  total_jobs: number;
  /** ISO 8601 UTC timestamp of when this result was computed. */
  computed_at: string;
};

// ---------------------------------------------------------------------------
// Internal row shape returned by the DB query
// ---------------------------------------------------------------------------

type MetricsRow = {
  duration_ms: number;
  status: string;
};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Compute the arithmetic mean of a non-empty array of numbers.
 *
 * @param values - Non-empty array of finite numbers
 */
function average(values: number[]): number {
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

/**
 * Compute the p-th percentile of a **pre-sorted** array.
 *
 * Uses the "ceiling index" method: `index = ceil((p / 100) * n) - 1`,
 * clamped to [0, n-1]. The caller is responsible for sorting the array
 * in ascending order before calling this function.
 *
 * @param sorted - Ascending-sorted, non-empty array of numbers
 * @param p      - Percentile in range (0, 100]
 */
function percentile(sorted: number[], p: number): number {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

// ---------------------------------------------------------------------------
// Exported computation function
// ---------------------------------------------------------------------------

/** Mapping from range token to number of calendar days. */
const RANGE_DAYS: Record<'24h' | '7d' | '30d', number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
};

/**
 * Compute performance metrics for a workspace over the given time range.
 *
 * Returns all numeric fields as `null` when the workspace has zero jobs in
 * the selected range (Requirement 2.5). Throughput and percentiles are
 * computed once per call — use the analytics cache layer above this function
 * to avoid redundant database queries.
 *
 * @param db          - Database adapter (SQLite or PostgreSQL)
 * @param workspaceId - Workspace identifier to filter metrics by
 * @param range       - Time range: `'24h'`, `'7d'`, or `'30d'`
 * @returns Promise resolving to {@link PerformanceMetrics}
 */
export async function computePerformanceMetrics(
  db: DbAdapter,
  workspaceId: string,
  range: '24h' | '7d' | '30d',
): Promise<PerformanceMetrics> {
  const days = RANGE_DAYS[range];

  const result = await db.query<MetricsRow>(
    `SELECT jm.duration_ms, j.status
     FROM job_metrics jm
     JOIN jobs j ON jm.job_id = j.id
     WHERE jm.workspace_id = ?
       AND j.timestamp >= datetime('now', '-${days} days')
       AND jm.duration_ms IS NOT NULL`,
    [workspaceId],
  );

  const computedAt = new Date().toISOString();

  // Requirements 2.5: return all-null metrics when there are zero jobs.
  if (result.rows.length === 0) {
    return {
      workspace_id: workspaceId,
      range,
      avg_duration_ms: null,
      median_duration_ms: null,
      p95_duration_ms: null,
      p99_duration_ms: null,
      throughput_per_hour: null,
      throughput_per_day: null,
      success_rate_percent: null,
      total_jobs: 0,
      computed_at: computedAt,
    };
  }

  // Sort durations once; used for all percentile calculations (Req 2.1).
  const durations = result.rows
    .map((row) => row.duration_ms)
    .sort((a, b) => a - b);

  const totalJobs = result.rows.length;
  const doneCount = result.rows.filter((row) => row.status === 'done').length;

  return {
    workspace_id: workspaceId,
    range,
    avg_duration_ms: average(durations),
    median_duration_ms: percentile(durations, 50),
    p95_duration_ms: percentile(durations, 95),
    p99_duration_ms: percentile(durations, 99),
    // Requirement 2.4: throughput derived from job count over range span.
    throughput_per_hour: totalJobs / (days * 24),
    throughput_per_day: totalJobs / days,
    // Requirement 2.5: success_rate_percent is null only when totalJobs === 0
    // (handled in the early-return branch above).
    success_rate_percent: (doneCount / totalJobs) * 100,
    total_jobs: totalJobs,
    computed_at: computedAt,
  };
}
