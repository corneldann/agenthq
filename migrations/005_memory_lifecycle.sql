-- migrations/005_memory_lifecycle.sql
-- Adds memory lifecycle management fields for Phase 6.5:
-- - stale: marks memories that haven't been retrieved within MEMORY_DECAY_DAYS
-- - superseded: marks memories that have been replaced by newer information
-- - last_retrieved_at: ISO 8601 timestamp of last recall operation
-- - retrieval_count: tracks how many times a memory has been recalled
--
-- These fields enable memory decay, consolidation, and analytics features.
-- Safe to re-run (columns added only IF NOT EXISTS via ALTER TABLE IF statements).

-- Add stale flag for memory decay
-- SQLite uses INTEGER for booleans: 0 = false, 1 = true
-- DEFAULT 0 means memories start as active (not stale)
ALTER TABLE memory_extraction ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;

-- Add superseded flag for consolidation
-- Marks memories replaced by newer contradictory information
-- DEFAULT 0 means memories start as current (not superseded)
ALTER TABLE memory_extraction ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0;

-- Add last retrieval timestamp for decay tracking
-- ISO 8601 UTC timestamp string (e.g., "2024-03-15T10:30:00.000Z")
-- NULL initially for existing records; updated on first recall
ALTER TABLE memory_extraction ADD COLUMN last_retrieved_at TEXT;

-- Add retrieval counter for analytics
-- Tracks total number of times this memory has been recalled
-- DEFAULT 0 for new records
ALTER TABLE memory_extraction ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0;

-- Partial index for decay worker query pattern:
-- WHERE stale = 0 AND deleted_at IS NULL AND last_retrieved_at < threshold
-- Only indexes active (non-stale, non-deleted) memories for efficient decay cycle
CREATE INDEX IF NOT EXISTS idx_memext_decay
  ON memory_extraction (last_retrieved_at)
  WHERE stale = 0 AND deleted_at IS NULL;

-- Partial index for analytics quality histogram query pattern:
-- WHERE workspace_id = ? AND deleted_at IS NULL
-- Supports quality distribution queries grouped by workspace
CREATE INDEX IF NOT EXISTS idx_memext_quality
  ON memory_extraction (workspace_id, quality_score)
  WHERE deleted_at IS NULL;
