# Implementation Plan: Phase 5.3 — Analytics Layer

## Skill Activation — REQUIRED before every task

**Call `disclose_context` for these skills before writing any code or tests:**

| Always | `accelint-ts-best-practices`, `accelint-ts-testing` |
|--------|------------------------------------------------------|
| + DB / backend / routes | `error-handling-patterns` |
| + dashboard / UI | `agenthq-dashboard` |
| + performance / query timing | `accelint-ts-performance` |
| + security / validation / SQL | `best-practices` |
| + JSDoc / comments | `accelint-ts-documentation` |
| + refactoring / coupling | `improve-codebase-architecture` |

These skills do NOT activate automatically during spec task execution.
`disclose_context` must be called explicitly at the start of each task.

---

## Overview

Implement the Phase 5.3 Analytics Layer for AgentHQ. The implementation covers:

1. Database schema migration for job_metrics
2. Configuration loader for analytics env vars
3. Metrics collector worker (file watcher → DB)
4. Core analytics computation modules (performance, cost, bottleneck, predictions)
5. Analytics cache with 5-minute TTL
6. REST API routes (`/api/analytics/*`)
7. Analytics export endpoint (CSV + JSON)
8. Dashboard analytics page with inline SVG charts (bar + line)
9. Property-based and unit tests throughout

Dependencies: Phase 5.1 (DbAdapter, migrations) and Phase 5.2 (WebSocket broadcaster) must be available.

---

## Tasks

- [x] 1. Database migration and analytics configuration
  - [x] 1.1 Create `migrations/003_job_metrics.sql` with the `job_metrics` table
    - Columns: `job_id TEXT PRIMARY KEY`, `workspace_id TEXT NOT NULL`, `duration_ms REAL`, `input_tokens INTEGER`, `output_tokens INTEGER`, `total_tokens INTEGER`, `cost_usd REAL`, `tool_calls INTEGER`, `retry_count INTEGER`, `error_count INTEGER`, `collected_at TEXT NOT NULL`
    - Add index `idx_metrics_workspace ON job_metrics(workspace_id)`
    - Add partial index `idx_metrics_cost ON job_metrics(workspace_id, cost_usd) WHERE cost_usd IS NOT NULL`
    - _Requirements: 1.2_

  - [x] 1.2 Create `src/config/analytics-config.ts` with `loadAnalyticsConfig()`
    - Read `ANALYTICS_ENABLED` (default `true`), `ANALYTICS_CACHE_TTL` (default `300`, clamp to [1, 86400])
    - Log warning `"ANALYTICS_CACHE_TTL <value> adjusted to <clamped_value>"` when clamped
    - Log error format `"Configuration error: <variable_name>: <specific_issue>"` for any invalid values on startup
    - Export `AnalyticsConfig` interface and `loadAnalyticsConfig(env)`
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 1.3 Write unit tests for `loadAnalyticsConfig`
    - Test TTL clamping at lower bound (value < 1), upper bound (value > 86400), and in-range
    - Test `ANALYTICS_ENABLED` false/true/missing
    - Test warning/error log output
    - _Requirements: 9.2, 9.3_

- [x] 2. Analytics cache
  - [x] 2.1 Create `src/analytics/cache.ts` with `AnalyticsCache` class
    - Generic `get<T>(key): T | null` and `set<T>(key, data): void` with TTL from config (default 5 min)
    - `invalidateWorkspace(workspaceId)` deletes all keys containing `workspaceId`
    - Export singleton `analyticsCache` and `AnalyticsCache` class
    - _Requirements: 2.7_

  - [x] 2.2 Write property tests for `AnalyticsCache`
    - **Property 1: Cache Consistency** — value retrieved within TTL equals stored value
    - **Property 2: Expiry** — value retrieved after TTL elapses returns null
    - **Validates: Requirements 2.7**

- [x] 3. Metrics collector worker
  - [x] 3.1 Create `src/workers/metricsCollector.ts` with `startMetricsCollector(db, outputDir)`
    - Use `fs.watch` (recursive) to detect `.log` file changes in `outputDir`
    - Extract `duration_ms`, `input_tokens`, `output_tokens`, `cost_usd`, `tool_calls`, `retry_count`, `error_count` via regex
    - Compute `total_tokens = input_tokens + output_tokens` when both present, else NULL
    - Upsert into `job_metrics` using `ON CONFLICT(job_id) DO UPDATE SET …`
    - Per AC 1.5: on structural JSON parse failure abort the entire job; on individual field failure store NULL and log `"metric extraction failed for <jobId>: <field>: <reason>"`
    - Enforce numeric bounds (AC 1.6): reject and store NULL for any value < 0
    - On catch, log error and continue processing other jobs (AC 10.2)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 10.2_

  - [x] 3.2 Write unit tests for metrics extraction
    - Test each regex match (present, absent, malformed)
    - Test NULL storage on field-level failure with warning log
    - Test non-negative bound enforcement
    - Test upsert path (conflict → update)
    - _Requirements: 1.5, 1.6_

- [x] 4. Performance metrics computation
  - [x] 4.1 Create `src/analytics/metrics.ts` with `computePerformanceMetrics(db, workspaceId, range)`
    - Export `PerformanceMetrics` interface (all fields from design)
    - Query `job_metrics JOIN jobs` filtered by `workspace_id` and time range
    - Return all-null result when zero jobs (AC 2.5)
    - Compute `avg`, `median` (p50), `p95`, `p99` using `percentile()` helper; sorted array required
    - Compute `throughput_per_hour` and `throughput_per_day` from job count / range
    - Compute `success_rate_percent = (done_count / total) * 100`; NULL when total is 0
    - All timestamps in UTC (AC 2.7)
    - _Requirements: 2.1, 2.4, 2.5, 2.7_

  - [x] 4.2 Write property tests for performance computation
    - **Property 3: Non-Negative Metrics** — avg, median, p95, p99 are ≥ 0 when non-null
    - **Property 4: Percentile Ordering** — p50 ≤ p95 ≤ p99 for any non-empty dataset
    - **Property 5: Success Rate Bounds** — success_rate_percent ∈ [0, 100] or NULL
    - **Validates: Requirements 2.1, 2.5, 12.1**

- [x] 5. Cost analytics computation
  - [x] 5.1 Create `src/analytics/cost.ts` with `computeCostMetrics(db, workspaceId, range)`
    - Export `CostMetrics` interface
    - Aggregate `SUM(cost_usd)`, `SUM(total_tokens)`, `COUNT(*)` for the range
    - `cost_per_job_usd = total_cost / job_count`; NULL if job_count is 0 (AC 3.2)
    - Aggregate `cost_by_agent` as `Record<string, number>` via GROUP BY `j.agent`
    - Wasted cost: sum `cost_usd` for jobs with `status = 'error'` (AC 3.5)
    - `projected_monthly_usd = (total_cost / days) * 30` (AC 3.4)
    - Include `daily_trend` array grouped by `DATE(j.timestamp)` ASC (AC 3.7)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x] 5.2 Write unit tests for cost computation
    - Test zero-job edge case (all fields null / zero)
    - Test `cost_per_job_usd` NULL when job_count = 0
    - Test wasted cost sums only error jobs
    - Test `projected_monthly_usd` formula
    - _Requirements: 3.2, 3.4, 3.5_

- [x] 6. Bottleneck detection
  - [x] 6.1 Create `src/analytics/bottleneck.ts` with `detectBottlenecks(db, workspaceId)`
    - Export `BottleneckJob` and `BottleneckAnalysis` interfaces
    - Compute `avg_duration` per `j.type` using GROUP BY
    - `slowdown_factor = job_duration / avg_duration_for_type`; only include jobs where `slowdown_factor > 0`
    - Mark bottlenecks: `slowdown_factor ≥ 2`; non-bottlenecks excluded from results (AC 4.1)
    - Severity: `'high'` if ≥ 5, `'medium'` if ≥ 2 and < 5 (AC 4.7)
    - `recommendation` format per AC 4.6
    - Return top 10 by `slowdown_factor` DESC (AC 4.2)
    - Tool timing analysis: implement `top_tools_by_time` when tool call data available AND concurrent jobs ≥ 5 (AC 4.3, 4.4); exclude tools with zero/negative call counts
    - Contention: identify periods where concurrent job count ≥ 5 (AC 4.5)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [x] 6.2 Write property tests for bottleneck detection
    - **Property 6: Bottleneck Threshold** — every job in `slowest_jobs` has `slowdown_factor ≥ 2`
    - **Property 7: Severity Mapping** — `severity === 'high'` IFF `slowdown_factor ≥ 5`
    - **Property 8: Non-Negative Slowdown** — all `slowdown_factor > 0`
    - **Validates: Requirements 4.1, 4.2, 4.7**

- [x] 7. Predictive analytics computation
  - [x] 7.1 Create `src/analytics/predictions.ts` with `estimateETA(db, jobId)`
    - Export `PredictiveMetrics` interface
    - Throw (or return 404-friendly error) if job not found or not running
    - Cold-start: return all-null predictions with `cold_start: true` when `sample_count < 5` (AC 5.7)
    - Compute `mean`, `stddev`, `CV = stddev / mean`
    - `confidence_score = Math.max(0, 1 - CV)` — never negative intermediate values (AC 5.2)
    - `low_confidence = CV > 0.5` (AC 5.3)
    - `estimated_remaining_ms = Math.max(0, mean - elapsed_ms)`
    - `success_probability = successCount / sample_count` (AC 5.4)
    - `is_anomalous = elapsed_ms > mean * 2` (AC 5.5)
    - `anomaly_score` 0–100 scaled on stddev deviation (AC 5.6)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [x] 7.2 Write property tests for predictive analytics
    - **Property 9: Cold-Start Nulls** — if `sample_count < 5` then all prediction fields are NULL
    - **Property 10: Confidence Score Bounds** — `confidence_score ∈ [0, 1]` when non-null
    - **Property 11: Anomaly Consistency** — `is_anomalous === true` IFF `elapsed_ms > 2 * mean`
    - **Validates: Requirements 5.2, 5.3, 5.7, 12.1**

- [x] 8. Analytics REST routes
  - [x] 8.1 Create `src/routes/analytics.ts` with `register(router, db)`
    - `GET /api/analytics/performance` — validate `workspace` (400/404) and `range` (400), cache-then-compute
    - `GET /api/analytics/cost` — same validation pattern, cache-then-compute
    - `GET /api/analytics/bottlenecks` — validate `workspace`, cache-then-compute
    - `GET /api/analytics/predictions` — validate `jobId` (400 if missing, 404 if not found)
    - All endpoints: return HTTP 400 `"invalid range: must be one of [24h, 7d, 30d]"` for bad range (AC 7.5)
    - Return HTTP 404 `"workspace not found"` / HTTP 403 `"access denied"` as appropriate (AC 7.6)
    - Return HTTP 404 `"job not found"` for unknown jobId (AC 7.7)
    - Wrap all computations with 30-second timeout; return HTTP 503 `"computation timed out after 30 seconds"` (AC 10.1)
    - Return HTTP 500 `"analytics computation failed: <reason>"` on DB error
    - Register routes in `src/monitor.ts`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 10.1_

  - [x] 8.2 Write integration tests for analytics routes
    - Test 400 for missing/invalid `range` and `workspace` params
    - Test 404 for non-existent workspace and job
    - Test 503 response shape on timeout
    - Test cache hit reduces DB calls
    - _Requirements: 7.5, 7.6, 7.7, 10.1_

- [x] 9. Analytics export endpoint
  - [x] 9.1 Implement `GET /api/analytics/export` in `src/routes/analytics.ts`
    - Validate `type` parameter: 400 `"invalid or missing type parameter: must be 'csv' or 'json'"` if absent or not in `['csv', 'json']` (AC 8.1)
    - Validate `metrics` query param: 400 `"unrecognized metric type: <type>"` for unknown types (AC 8.4)
    - Validate `from`/`to` ISO 8601 params: 400 `"invalid date range: from must be <= to"` if `from > to` (AC 8.6)
    - For CSV: generate valid CSV with headers and quoted string fields; `Content-Type: text/csv`; only runs when format is `"csv"` (AC 8.2)
    - For JSON: serialise per metric schemas defined in AC 8.7; `Content-Type: application/json`
    - Add `Content-Disposition: attachment; filename="analytics-export.<type>"` header (AC 8.5)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [x] 9.2 Write unit tests for export formatter
    - Test CSV output includes correct headers and quoted strings
    - Test JSON output matches PerformanceMetrics / CostMetrics / BottleneckAnalysis schemas
    - Test `from > to` returns 400
    - Test unknown metric type returns 400
    - _Requirements: 8.2, 8.3, 8.6, 8.7_

- [x] 10. Checkpoint — backend complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Dashboard SVG chart components
  - [x] 11.1 Create `src/dashboard/components/barChart.ts`
    - Pure function `renderBarChart(data: Array<{label: string; value: number}>, opts): string`
    - Inline SVG output; scale bars to max value; label each bar; render empty/placeholder when data is empty (AC 6.7)
    - Returns valid HTML string (no XSS — use `esc()` for labels)
    - _Requirements: 6.2, 6.7_

  - [x] 11.2 Create `src/dashboard/components/lineChart.ts`
    - Pure function `renderLineChart(data: Array<{x: string; y: number}>, opts): string`
    - Inline SVG output; connect points with polyline; axis labels; placeholder when empty (AC 6.7)
    - Returns valid HTML string (use `esc()` for dynamic content)
    - _Requirements: 6.3, 6.7_

  - [x] 11.3 Write unit tests for chart components
    - Test `renderBarChart` returns non-empty SVG for valid data
    - Test both renderers return placeholder/empty SVG when data is `[]`
    - Test rendered output does not contain un-escaped `<`, `>`, `"` from label inputs
    - _Requirements: 6.7_

- [x] 12. Analytics dashboard page
  - [x] 12.1 Create `src/dashboard/api.ts` additions — add typed fetch wrappers
    - `getPerformanceMetrics(workspace, range)` → `PerformanceMetrics`
    - `getCostMetrics(workspace, range)` → `CostMetrics`
    - `getBottlenecks(workspace)` → `BottleneckAnalysis`
    - `getPredictions(jobId)` → `PredictiveMetrics`
    - Reuse existing `api.ts` patterns (typed fetch, error handling)
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 12.2 Create `src/dashboard/pages/analytics.ts`
    - Pure `renderAnalyticsPage(): string` returns shell HTML with time-range picker and grid slots (AC 6.1)
    - `loadAnalytics(range)` fetches all three endpoints in parallel (`Promise.all`), updates metric cards and charts
    - Time-range selector updates all charts within 500ms; show loading indicators while pending (AC 6.4)
    - Drill-down: clicking a chart data point opens job list filtered by `workspace_id`, `time_range`, `status` (AC 6.5)
    - Wire WebSocket `metric-update` events to re-fetch and re-render (AC 6.6)
    - Use `esc()` for all dynamic text to prevent XSS
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [x] 12.3 Register analytics page in `src/dashboard/main.ts`
    - Add `analytics` route to the client-side router
    - Add "Analytics" nav link to the sidebar/header
    - _Requirements: 6.1_

- [x] 13. Observability — cache logging
  - [x] 13.1 Add cache hit/miss counters to `AnalyticsCache`
    - Track hits and misses per key prefix
    - When `cache_logging_enabled` is true AND log level ≥ INFO, emit hit/miss rate every 5 minutes via `setInterval` (AC 11.1)
    - _Requirements: 11.1_

  - [x] 13.2 Ensure all unexpected errors include stack traces in logs
    - Update `Metrics_Collector` and route error handlers to log `err.stack` with severity levels (AC 11.2)
    - Severity levels: DEBUG < INFO < WARN < ERROR < FATAL
    - _Requirements: 11.2_

- [ ] 14. Checkpoint — wire everything together
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 15. Property-based and performance tests
  - [ ] 15.1 Write cross-module property tests for numeric invariants
    - **Property 12: All Duration/Cost Metrics ≥ 0** — generate random job_metrics rows; assert no output metric is negative
    - **Property 13: Retry/Error Count ≥ 0** — `retry_count` and `error_count` are always ≥ 0 when non-null
    - **Validates: Requirements 12.1**

  - [ ] 15.2 Write performance tests for API response times
    - Verify `GET /api/analytics/performance` responds in ≤ 200ms under typical dataset
    - Verify `GET /api/analytics/cost` responds in ≤ 200ms
    - Verify `GET /api/analytics/bottlenecks` responds in ≤ 500ms
    - **Validates: Requirements 7.1, 12.2**

- [ ] 16. Final checkpoint — full test suite
  - Ensure all tests pass, ask the user if questions arise.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- All timestamps are UTC (ISO 8601 strings)
- `esc()` from `src/dashboard/utils.ts` MUST be used for any dynamic content rendered into HTML
- The `analyticsCache` singleton is initialized with TTL from `AnalyticsConfig`; pass config at startup
- Route registration: `src/routes/analytics.ts` must be imported and called in `src/monitor.ts` alongside existing route registrations
- Dashboard build: after editing `src/dashboard/**`, click the Build button in the Monitor Dashboard to rebuild, then hard refresh (Ctrl+Shift+R)

---

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2", "3.1"] },
    { "id": 3, "tasks": ["3.2", "4.1", "5.1"] },
    { "id": 4, "tasks": ["4.2", "5.2", "6.1"] },
    { "id": 5, "tasks": ["6.2", "7.1"] },
    { "id": 6, "tasks": ["7.2", "8.1"] },
    { "id": 7, "tasks": ["8.2", "9.1"] },
    { "id": 8, "tasks": ["9.2", "11.1", "11.2"] },
    { "id": 9, "tasks": ["11.3", "12.1"] },
    { "id": 10, "tasks": ["12.2"] },
    { "id": 11, "tasks": ["12.3", "13.1", "13.2"] },
    { "id": 12, "tasks": ["15.1", "15.2"] }
  ]
}
```
