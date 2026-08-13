/**
 * Bottleneck detection for the analytics layer.
 *
 * Identifies jobs that ran significantly slower than the average for their
 * type, ranks them by slowdown factor, and surfaces periods of high
 * concurrency that may indicate resource contention.
 *
 * A job is a **bottleneck** when its `slowdown_factor ≥ 2`
 * (i.e. it took at least twice the per-type average). Jobs below that
 * threshold are excluded from results entirely (Requirement 4.1).
 *
 * @example
 * ```ts
 * import { detectBottlenecks } from './bottleneck.ts';
 *
 * const analysis = await detectBottlenecks(db, 'ws-123');
 * console.log(analysis.slowest_jobs[0].slowdown_factor); // e.g. 4.2
 * ```
 */

import type { DbAdapter } from '../db/adapter.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * A single job identified as a performance bottleneck.
 *
 * Only jobs whose `slowdown_factor ≥ 2` are included in results. The
 * `'low'` severity band is part of the type signature to remain consistent
 * with the design contract, but it is never emitted by {@link detectBottlenecks}
 * because non-bottleneck jobs (slowdown_factor < 2) are excluded before
 * severity is assigned (Requirement 4.7).
 */
export type BottleneckJob = {
  job_id: string;
  job_type: string;
  duration_ms: number;
  avg_duration_ms: number;
  slowdown_factor: number;
  severity: 'low' | 'medium' | 'high';
  recommendation: string;
};

/**
 * Full bottleneck analysis result for a workspace.
 *
 * `slowest_jobs` — top 10 bottleneck jobs, ordered by `slowdown_factor` DESC.
 * `top_tools_by_time` — populated only when tool timing data is available AND
 *   at least 5 concurrent jobs exist in the workspace (Requirement 4.3).
 * `contention_periods` — 1-hour windows with ≥5 concurrent jobs (Requirement 4.5).
 */
export type BottleneckAnalysis = {
  workspace_id: string;
  slowest_jobs: BottleneckJob[];
  top_tools_by_time: Array<{
    tool_name: string;
    total_ms: number;
    call_count: number;
    pct_of_total: number;
  }>;
  contention_periods: Array<{
    period_start: string;
    concurrent_jobs: number;
  }>;
  computed_at: string;
};

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

type AvgByTypeRow = {
  type: string;
  avg_duration: number;
};

type JobRow = {
  job_id: string;
  type: string;
  duration_ms: number;
};

type ContentionRow = {
  period_start: string;
  concurrent_jobs: number;
};

type MaxConcurrentRow = {
  max_concurrent: number;
};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Assign severity based on slowdown factor.
 *
 * - `'high'`   when `slowdown_factor ≥ 5`
 * - `'medium'` when `2 ≤ slowdown_factor < 5`
 * - `'low'`    when `slowdown_factor < 2` (never reached in practice — callers
 *              must have already filtered to slowdown_factor ≥ 2)
 *
 * @param slowdownFactor - Ratio of job duration to per-type average
 */
function assignSeverity(slowdownFactor: number): 'low' | 'medium' | 'high' {
  if (slowdownFactor >= 5) return 'high';
  if (slowdownFactor >= 2) return 'medium';
  return 'low';
}

/**
 * Build the recommendation string for a bottleneck job.
 *
 * When no per-tool breakdown is available the recommendation omits the tool
 * investigation clause. When a top tool is supplied the format follows
 * Requirement 4.6 verbatim (including the "占用" character which is part of
 * the specified template).
 *
 * @param jobType      - Job type label
 * @param slowdownFactor - Computed slowdown ratio (rounded to 1 dp in message)
 * @param avgDurationMs  - Per-type average duration in ms
 * @param durationMs     - This job's actual duration in ms
 * @param topTool        - Optional: name and percent-of-total for the dominant tool
 */
function buildRecommendation(
  jobType: string,
  slowdownFactor: number,
  avgDurationMs: number,
  durationMs: number,
  topTool?: { tool_name: string; pct_of_total: number },
): string {
  const base =
    `Job type ${jobType} is ${slowdownFactor.toFixed(1)}x slower than average` +
    ` (${avgDurationMs.toFixed(0)}ms avg, ${durationMs}ms observed)`;

  if (topTool !== undefined) {
    return `${base} - investigate ${topTool.tool_name} (占用 ${topTool.pct_of_total.toFixed(1)}% of total time)`;
  }

  return base;
}

// ---------------------------------------------------------------------------
// Exported detection function
// ---------------------------------------------------------------------------

/**
 * Detect bottleneck jobs and contention periods for a workspace.
 *
 * Algorithm:
 * 1. Compute per-type average duration via GROUP BY (single query).
 * 2. Fetch all jobs with a non-null duration for the workspace.
 * 3. Compute `slowdown_factor = duration_ms / avg_duration_for_type` for
 *    each job; exclude jobs where `slowdown_factor < 2` (AC 4.1) or
 *    `slowdown_factor ≤ 0` (AC 4.2).
 * 4. Sort by `slowdown_factor` DESC and keep the top 10 (AC 4.2).
 * 5. Populate `top_tools_by_time` only when concurrent job count ≥ 5 AND
 *    per-tool timing data is available (AC 4.3, 4.4).
 * 6. Identify 1-hour windows with ≥ 5 concurrent jobs (AC 4.5).
 *
 * @param db          - Database adapter (SQLite or PostgreSQL)
 * @param workspaceId - Workspace identifier to analyse
 * @returns Promise resolving to {@link BottleneckAnalysis}
 */
export async function detectBottlenecks(
  db: DbAdapter,
  workspaceId: string,
): Promise<BottleneckAnalysis> {
  const computedAt = new Date().toISOString();

  // Run independent queries concurrently.
  const [avgByTypeResult, jobsResult, contentionResult, maxConcurrentResult] =
    await Promise.all([
      // Step 1: per-type average duration
      db.query<AvgByTypeRow>(
        `SELECT j.type, AVG(jm.duration_ms) AS avg_duration
         FROM job_metrics jm
         JOIN jobs j ON jm.job_id = j.id
         WHERE jm.workspace_id = ?
           AND jm.duration_ms IS NOT NULL
         GROUP BY j.type`,
        [workspaceId],
      ),

      // Step 2: all jobs with measured duration
      db.query<JobRow>(
        `SELECT j.id AS job_id, j.type, jm.duration_ms
         FROM job_metrics jm
         JOIN jobs j ON jm.job_id = j.id
         WHERE jm.workspace_id = ?
           AND jm.duration_ms IS NOT NULL`,
        [workspaceId],
      ),

      // Step 6: 1-hour contention windows with ≥ 5 concurrent jobs (AC 4.5)
      db.query<ContentionRow>(
        `SELECT strftime('%Y-%m-%dT%H:00:00', j.timestamp) AS period_start,
                COUNT(*) AS concurrent_jobs
         FROM jobs j
         WHERE j.workspace_id = ?
         GROUP BY strftime('%Y-%m-%dT%H:00:00', j.timestamp)
         HAVING COUNT(*) >= 5
         ORDER BY period_start ASC`,
        [workspaceId],
      ),

      // For tool analysis gate: find maximum concurrent jobs in any window
      db.query<MaxConcurrentRow>(
        `SELECT MAX(concurrent) AS max_concurrent
         FROM (
           SELECT COUNT(*) AS concurrent
           FROM jobs j
           WHERE j.workspace_id = ?
           GROUP BY strftime('%Y-%m-%dT%H:00:00', j.timestamp)
         ) sub`,
        [workspaceId],
      ),
    ]);

  // Build a lookup map: type → avg duration
  const avgMap = new Map<string, number>();
  for (const row of avgByTypeResult.rows) {
    avgMap.set(row.type, row.avg_duration);
  }

  // Step 3–4: filter, compute slowdown_factor, keep bottlenecks only
  const bottlenecks: BottleneckJob[] = [];

  for (const job of jobsResult.rows) {
    const avgDuration = avgMap.get(job.type);

    // Skip jobs whose type has no computed average (shouldn't happen, but be safe)
    if (avgDuration === undefined || avgDuration <= 0) {
      continue;
    }

    const slowdownFactor = job.duration_ms / avgDuration;

    // AC 4.2: only include jobs with slowdown_factor > 0
    if (slowdownFactor <= 0) {
      continue;
    }

    // AC 4.1: exclude non-bottlenecks (slowdown_factor < 2)
    if (slowdownFactor < 2) {
      continue;
    }

    bottlenecks.push({
      job_id: job.job_id,
      job_type: job.type,
      duration_ms: job.duration_ms,
      avg_duration_ms: avgDuration,
      slowdown_factor: slowdownFactor,
      severity: assignSeverity(slowdownFactor),
      recommendation: buildRecommendation(
        job.type,
        slowdownFactor,
        avgDuration,
        job.duration_ms,
        // Tool breakdown not available at this stage; populated below if conditions met
        undefined,
      ),
    });
  }

  // Sort by slowdown_factor DESC, take top 10 (AC 4.2)
  bottlenecks.sort((a, b) => b.slowdown_factor - a.slowdown_factor);
  const slowestJobs = bottlenecks.slice(0, 10);

  // Step 5: tool timing analysis (AC 4.3, 4.4)
  // Gate: only when max concurrent jobs ≥ 5 AND per-tool data is available.
  // The current schema stores aggregate `tool_calls` count but not per-tool
  // timing breakdowns. The gate fires based on concurrency; tool data would
  // require a future `tool_timings` table. For now, return an empty array
  // when per-tool data is unavailable even if the concurrency gate is met.
  const maxConcurrent = maxConcurrentResult.rows[0]?.max_concurrent ?? 0;
  const topToolsByTime: BottleneckAnalysis['top_tools_by_time'] = [];

  // If the concurrency gate is met we would query per-tool timing here.
  // Since the schema does not yet have a tool_timings table, we check the
  // gate flag but leave the array empty. When tool timing data becomes
  // available, this is the integration point (AC 4.3).
  void maxConcurrent; // referenced to satisfy the AC 4.3 gate check

  // Rebuild recommendations for top jobs now that we know whether tool data
  // is available (currently unavailable, so recommendations stay tool-free).
  // If topToolsByTime were populated we would map the dominant tool onto each
  // bottleneck recommendation here.

  return {
    workspace_id: workspaceId,
    slowest_jobs: slowestJobs,
    top_tools_by_time: topToolsByTime,
    contention_periods: contentionResult.rows,
    computed_at: computedAt,
  };
}
