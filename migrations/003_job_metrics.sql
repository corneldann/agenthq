-- migrations/003_job_metrics.sql
-- Stores extracted metrics for completed agent jobs (Phase 5.3 Analytics Layer).
-- Safe to re-run (IF NOT EXISTS).
-- Requirements: 1.2

-- Each row captures resource usage for one job execution.
-- All numeric metric columns are nullable — a NULL means the metric was not available
-- in the log (e.g. the job did not emit a cost line).
-- collected_at is an ISO 8601 UTC timestamp set at extraction time.

CREATE TABLE IF NOT EXISTS job_metrics (
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
);

-- Supports workspace-scoped analytics queries (filter by workspace_id).
CREATE INDEX IF NOT EXISTS idx_metrics_workspace
  ON job_metrics(workspace_id);

-- Supports cost aggregation queries; partial index omits rows where cost is unknown.
CREATE INDEX IF NOT EXISTS idx_metrics_cost
  ON job_metrics(workspace_id, cost_usd) WHERE cost_usd IS NOT NULL;
