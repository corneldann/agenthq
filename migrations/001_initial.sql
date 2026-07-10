-- migrations/001_initial.sql
-- Creates core tables and indexes. Safe to re-run (IF NOT EXISTS).
-- Requirements: 1.3, 1.4, 1.5, 3.1, 3.2, 3.3, 3.4, 3.5

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version        INTEGER PRIMARY KEY,
  applied_at     TEXT    NOT NULL,
  migration_name TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id             TEXT PRIMARY KEY,
  output_dir     TEXT NOT NULL,
  sessions_dir   TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  job_chain        TEXT NOT NULL DEFAULT '',
  session_chain_id TEXT NOT NULL DEFAULT '',
  timestamp        TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT '',
  agent            TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL CHECK(status IN ('running','done','reported','error')),
  lines            INTEGER NOT NULL DEFAULT 0,
  last_line        TEXT NOT NULL DEFAULT '',
  has_log          INTEGER NOT NULL DEFAULT 0,
  log_error        INTEGER NOT NULL DEFAULT 0,
  md_file          TEXT NOT NULL DEFAULT '',
  log_file         TEXT NOT NULL DEFAULT '',
  agent_done       TEXT NOT NULL DEFAULT '',
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  last_modified    INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT
);

CREATE TABLE IF NOT EXISTS chains (
  chain_id         TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  display_name     TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  last_active_at   TEXT NOT NULL,
  total_messages   INTEGER NOT NULL DEFAULT 0,
  last_modified    INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  chain_id          TEXT NOT NULL,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_hash     TEXT NOT NULL DEFAULT '',
  chain_index       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'idle',
  message_count     INTEGER NOT NULL DEFAULT 0,
  context_usage_pct REAL NOT NULL DEFAULT 0,
  last_message_at   TEXT NOT NULL,
  last_modified     INTEGER NOT NULL DEFAULT 0,
  deleted_at        TEXT,
  PRIMARY KEY (chain_id, workflow_hash)
);

-- Indexes for query performance (Requirement 3)

-- Requirement 3.1: filter jobs by workspace and status
CREATE INDEX IF NOT EXISTS idx_jobs_workspace_status
  ON jobs(workspace_id, status) WHERE deleted_at IS NULL;

-- Requirement 3.2: order jobs by recency within a workspace
CREATE INDEX IF NOT EXISTS idx_workspace_timestamp
  ON jobs(workspace_id, timestamp DESC) WHERE deleted_at IS NULL;

-- Requirement 3.3: filter jobs by type and status
CREATE INDEX IF NOT EXISTS idx_jobs_type_status
  ON jobs(type, status) WHERE deleted_at IS NULL;

-- Requirement 3.4: time-range queries on jobs by timestamp
CREATE INDEX IF NOT EXISTS idx_jobs_timestamp
  ON jobs(timestamp) WHERE deleted_at IS NULL;

-- Requirement 3.5: filter chains by workspace ordered by activity
CREATE INDEX IF NOT EXISTS idx_chains_workspace_active
  ON chains(workspace_id, last_active_at DESC) WHERE deleted_at IS NULL;
