-- migrations/002_status_history.sql
-- Historical status tracking (Requirement 4)
-- Requirements: 1.3, 4.1, 4.3, 4.4

-- Tracks every status transition for a job, enabling audit trails and analytics.
-- reason is nullable — not all transitions have an explicit reason.
-- changed_at defaults to current UTC timestamp in ISO 8601 format.

CREATE TABLE IF NOT EXISTS job_status_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT    NOT NULL,
  workspace_id TEXT    NOT NULL,
  old_status   TEXT    NOT NULL,
  new_status   TEXT    NOT NULL,
  reason       TEXT,
  changed_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Supports efficient lookup of all transitions for a given job, ordered by recency.
-- Used by GET /api/status-history/:jobId (Requirement 4.4).
CREATE INDEX IF NOT EXISTS idx_status_history_job
  ON job_status_history(job_id, changed_at DESC);
