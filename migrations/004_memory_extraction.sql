-- migrations/004_memory_extraction.sql
-- Adds the memory_extraction table for Phase 6.2 Memory Extraction pipeline.
-- Records extraction runs per job: quality scores, embedding status, and tier.
-- Safe to re-run (IF NOT EXISTS).

-- extracted_at  : ISO 8601 UTC timestamp set at extraction time
-- last_modified : Unix epoch milliseconds
-- embedding_status CHECK constrains values to 'pending', 'embedded', or 'failed'
-- tier CHECK constrains values to 'hot' or 'cold'
-- embed_attempts is incremented only on successful Voyage batch submission,
--   never on pre-submission errors; rows with embed_attempts >= 3 are marked 'failed'

CREATE TABLE IF NOT EXISTS memory_extraction (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           TEXT    NOT NULL REFERENCES jobs(id),
  workspace_id     TEXT    NOT NULL,
  extracted_at     TEXT    NOT NULL,
  raw_text         TEXT    NOT NULL,
  memory_count     INTEGER NOT NULL DEFAULT 0,
  quality_score    REAL    NOT NULL DEFAULT 0.0,
  embedding_status TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (embedding_status IN ('pending','embedded','failed')),
  embed_attempts   INTEGER NOT NULL DEFAULT 0,
  tier             TEXT    NOT NULL DEFAULT 'cold'
                           CHECK (tier IN ('hot','cold')),
  last_modified    INTEGER NOT NULL,
  deleted_at       TEXT    DEFAULT NULL
);

-- Partial index for workspace-scoped queries on non-deleted rows
CREATE INDEX IF NOT EXISTS idx_memext_workspace
  ON memory_extraction (workspace_id)
  WHERE deleted_at IS NULL;

-- Partial index for the batch worker's primary query pattern:
-- WHERE embedding_status = 'pending' AND deleted_at IS NULL ORDER BY extracted_at ASC LIMIT 1000
CREATE INDEX IF NOT EXISTS idx_memext_pending
  ON memory_extraction (embedding_status, extracted_at)
  WHERE embedding_status = 'pending' AND deleted_at IS NULL;
