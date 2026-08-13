/**
 * Cost analytics computation for the analytics layer.
 *
 * Queries `job_metrics JOIN jobs` for a given workspace and time range, then
 * aggregates total cost, token usage, per-agent cost breakdown, wasted spend
 * on error jobs, projected monthly cost, and a daily cost trend series.
 * All timestamps are UTC ISO 8601 strings.
 *
 * @example
 * ```ts
 * import { computeCostMetrics } from './cost.ts';
 *
 * const metrics = await computeCostMetrics(db, 'ws-123', '7d');
 * console.log(metrics.total_cost_usd); // e.g. 1.42
 * ```
 */

import type { DbAdapter } from '../db/adapter.js';

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

/**
 * Cost metrics for a workspace over a specific time range.
 *
 * Numeric aggregate fields (`total_cost_usd`, `total_tokens`,
 * `cost_per_job_usd`, `wasted_cost_usd`, `projected_monthly_usd`) are
 * `null` when there are zero jobs in the range. `jobs_count` is always
 * present (0 when no data).
 */
export type CostMetrics = {
  workspace_id: string;
  range: '24h' | '7d' | '30d';
  /** Sum of `cost_usd` across all jobs in range; null when no jobs. */
  total_cost_usd: number | null;
  /** Sum of `total_tokens` across all jobs in range; null when no jobs. */
  total_tokens: number | null;
  /**
   * `total_cost_usd / jobs_count`; null when `jobs_count === 0`.
   * Satisfies Requirement 3.2.
   */
  cost_per_job_usd: number | null;
  /** Total number of jobs in the range (always present, 0 when empty). */
  jobs_count: number;
  /**
   * Per-agent cost map: `{ [agentName]: totalCostUsd }`.
   * Agents with a null name in the database are excluded.
   * Satisfies Requirement 3.3.
   */
  cost_by_agent: Record<string, number>;
  /**
   * Sum of `cost_usd` for jobs with `status = 'error'`; null when none.
   * Satisfies Requirement 3.5.
   */
  wasted_cost_usd: number | null;
  /**
   * `(total_cost_usd / days) * 30`; null when `total_cost_usd` is null.
   * Satisfies Requirement 3.4.
   */
  projected_monthly_usd: number | null;
  /**
   * Daily cost and token aggregates ordered by date ASC.
   * Satisfies Requirement 3.7.
   */
  daily_trend: Array<{ date: string; cost_usd: number; token_count: number }>;
  /** ISO 8601 UTC timestamp of when this result was computed. */
  computed_at: string;
};

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

type AggregateRow = {
  total_cost: number | null;
  total_tokens: number | null;
  job_count: number;
};

type AgentCostRow = {
  agent: string | null;
  total_cost: number | null;
};

type WastedCostRow = {
  wasted: number | null;
};

type DailyTrendRow = {
  date: string;
  cost_usd: number | null;
  token_count: number | null;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mapping from range token to number of calendar days. */
const RANGE_DAYS: Record<'24h' | '7d' | '30d', number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
};

// ---------------------------------------------------------------------------
// Exported computation function
// ---------------------------------------------------------------------------

/**
 * Compute cost metrics for a workspace over the given time range.
 *
 * Issues four database queries in parallel:
 * 1. Main aggregate — total cost, total tokens, job count (Req 3.1, 3.2, 3.6)
 * 2. Per-agent cost breakdown (Req 3.3)
 * 3. Wasted cost on error jobs (Req 3.5)
 * 4. Daily cost trend (Req 3.7)
 *
 * When `jobs_count` is 0, all aggregate numeric fields are returned as
 * `null`. `cost_by_agent` and `daily_trend` are empty collections.
 *
 * @param db          - Database adapter (SQLite or PostgreSQL)
 * @param workspaceId - Workspace identifier to filter metrics by
 * @param range       - Time range: `'24h'`, `'7d'`, or `'30d'`
 * @returns Promise resolving to {@link CostMetrics}
 */
export async function computeCostMetrics(
  db: DbAdapter,
  workspaceId: string,
  range: '24h' | '7d' | '30d',
): Promise<CostMetrics> {
  const days = RANGE_DAYS[range];

  // Run all four queries concurrently — they are independent reads.
  const [aggregateResult, agentResult, wastedResult, trendResult] =
    await Promise.all([
      db.query<AggregateRow>(
        `SELECT
           SUM(jm.cost_usd)      AS total_cost,
           SUM(jm.total_tokens)  AS total_tokens,
           COUNT(*)              AS job_count
         FROM job_metrics jm
         JOIN jobs j ON jm.job_id = j.id
         WHERE jm.workspace_id = ?
           AND j.timestamp >= datetime('now', '-${days} days')`,
        [workspaceId],
      ),

      db.query<AgentCostRow>(
        `SELECT j.agent, SUM(jm.cost_usd) AS total_cost
         FROM job_metrics jm
         JOIN jobs j ON jm.job_id = j.id
         WHERE jm.workspace_id = ?
           AND j.timestamp >= datetime('now', '-${days} days')
         GROUP BY j.agent`,
        [workspaceId],
      ),

      db.query<WastedCostRow>(
        `SELECT SUM(jm.cost_usd) AS wasted
         FROM job_metrics jm
         JOIN jobs j ON jm.job_id = j.id
         WHERE jm.workspace_id = ?
           AND j.timestamp >= datetime('now', '-${days} days')
           AND j.status = 'error'`,
        [workspaceId],
      ),

      db.query<DailyTrendRow>(
        `SELECT
           DATE(j.timestamp)    AS date,
           SUM(jm.cost_usd)     AS cost_usd,
           SUM(jm.total_tokens) AS token_count
         FROM job_metrics jm
         JOIN jobs j ON jm.job_id = j.id
         WHERE jm.workspace_id = ?
           AND j.timestamp >= datetime('now', '-${days} days')
         GROUP BY DATE(j.timestamp)
         ORDER BY date ASC`,
        [workspaceId],
      ),
    ]);

  const computedAt = new Date().toISOString();

  // Unpack the single aggregate row (COUNT(*) always returns a row).
  const agg = aggregateResult.rows[0];
  const jobsCount = agg?.job_count ?? 0;

  // SQLite SUM of an empty set returns NULL — preserve that as null.
  const totalCost = agg?.total_cost ?? null;
  const totalTokens = agg?.total_tokens ?? null;

  // Requirement 3.2: cost_per_job_usd is null when there are no jobs.
  const costPerJob =
    jobsCount > 0 && totalCost !== null ? totalCost / jobsCount : null;

  // Requirement 3.4: projected_monthly only when actual cost data exists.
  const projectedMonthly =
    totalCost !== null ? (totalCost / days) * 30 : null;

  // Requirement 3.3: build per-agent map, skipping null agent names.
  const costByAgent: Record<string, number> = {};
  for (const row of agentResult.rows) {
    if (row.agent !== null && row.total_cost !== null) {
      costByAgent[row.agent] = row.total_cost;
    }
  }

  // Requirement 3.5: wasted cost — null when no error jobs exist.
  const wastedCost = wastedResult.rows[0]?.wasted ?? null;

  // Requirement 3.7: daily trend — coerce null sums to 0 for a complete series.
  const dailyTrend = trendResult.rows.map((row) => ({
    date: row.date,
    cost_usd: row.cost_usd ?? 0,
    token_count: row.token_count ?? 0,
  }));

  return {
    workspace_id: workspaceId,
    range,
    total_cost_usd: totalCost,
    total_tokens: totalTokens,
    cost_per_job_usd: costPerJob,
    jobs_count: jobsCount,
    cost_by_agent: costByAgent,
    wasted_cost_usd: wastedCost,
    projected_monthly_usd: projectedMonthly,
    daily_trend: dailyTrend,
    computed_at: computedAt,
  };
}
