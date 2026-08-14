# Requirements Document

## Introduction

Phase 6.2 builds the extraction pipeline: when an agent job reaches `done` status, its output
file is read, structured memory facts are derived via an LLM call, scored by a quality gate,
deduplicated, and stored via the `IMemoryClient` introduced in Phase 6.1. A hybrid 3-tier
embedding strategy classifies jobs as hot (embed immediately) or cold (batch every 6 hours)
to balance search latency against embedding cost.

**Prerequisite:** Phase 6.1 complete. `IMemoryClient`, `MemoryCircuitBreaker`, and
`RetryQueue` are available.

---

## Glossary

| Term | Definition |
|------|-----------|
| **Quality gate** | Evaluator-optimizer loop from `agentic-eval` skill. Scores each extracted fact on accuracy (0.4), relevance (0.3), specificity (0.3). Rejects facts below 0.75. |
| **Hot tier** | The most-recent 100 completed jobs — embedded immediately for sub-second recall. |
| **Cold tier** | All jobs beyond the hot window — raw text stored with `embedding_status = 'pending'`; embedded in 6-hour batch. |
| **memory_extraction** | DB table tracking extraction status per job (migration 004). |
| **Voyage Batch API** | Voyage AI's batch embedding endpoint — 33% cheaper than real-time, 12-hour completion window. |
| **Deduplication** | Rejecting a new fact when cosine similarity against an existing memory in the same scope exceeds 0.92. |

---

## Requirements

### Requirement 1: Database Migration 004

**User Story:** As a developer, I want a `memory_extraction` table in the database so that the
system can track which jobs have been processed, their quality scores, and embedding status.

#### Acceptance Criteria

1. `migrations/004_memory_extraction.sql` creates the `memory_extraction` table with columns:
   `id` (INTEGER PK AUTOINCREMENT), `job_id` (TEXT NOT NULL), `workspace_id` (TEXT NOT NULL),
   `extracted_at` (TEXT NOT NULL), `raw_text` (TEXT NOT NULL), `memory_count` (INTEGER),
   `quality_score` (REAL), `embedding_status` (TEXT CHECK in `pending|embedded|failed`),
   `embed_attempts` (INTEGER NOT NULL DEFAULT 0), `tier` (TEXT CHECK in `hot|cold`),
   `last_modified` (INTEGER NOT NULL), `deleted_at` (TEXT DEFAULT NULL).
2. Two partial indexes are created: `idx_memext_workspace` on `(workspace_id)` and
   `idx_memext_pending` on `(embedding_status, extracted_at)`, both `WHERE deleted_at IS NULL`.
3. The migration runs automatically via the existing `runMigrations()` mechanism on next
   monitor startup.
4. Migration is idempotent — uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`.

### Requirement 2: Extraction Pipeline

**User Story:** As a developer, I want completed jobs to automatically generate memory facts
without any manual steps so that the memory store fills up passively as I work.

#### Acceptance Criteria

1. `src/memory/extraction.ts` exports `extractAndStore(job: Job, db: DbAdapter,
   client: IMemoryClient): Promise<void>`.
2. The function reads the job's `.md` output file. If the file is absent or empty, the
   function logs a warning and returns without writing anything to the DB.
3. An LLM call (via `src/agent.ts`'s configured model) extracts candidate facts from the
   file text. The prompt instructs the model to return a JSON array of `{ text, category }`
   objects where `category` is one of `architecture`, `error`, `resolution`, `procedure`,
   `constraint`.
4. The quality gate scores each fact: accuracy (weight 0.4) + relevance (0.3) +
   specificity (0.3). Facts with `score < 0.75` are dropped.
5. If the mean score of all candidate facts is below 0.75, a single refinement pass is
   triggered: the evaluator's critique is appended to the extraction prompt and the LLM is
   called again. Only one refinement pass is attempted.
6. Generic fact patterns are explicitly rejected regardless of score:
   - Text matching `/the system has \w+/i`
   - Text matching `/build (is )?currently failing/i`
   - Text shorter than 20 characters
   - Text longer than 500 characters
7. Before calling `client.retain`, a deduplication check queries Hindsight for semantically
   similar memories in the same scope. Facts with cosine similarity > 0.92 against an existing
   memory are discarded.
8. Each accepted fact is stored via `client.retain(text, scopeFromJob(job))`.
9. A `memory_extraction` row is upserted for the job with `extracted_at`, `raw_text`,
   `memory_count`, `quality_score`, `embedding_status`, and `tier` fields populated.
10. If the LLM call throws, the row is written with `quality_score = 0`, `memory_count = 0`,
    `embedding_status = 'failed'`, and the exception is logged but not re-thrown.

### Requirement 3: Hybrid Embedding Tiers

**User Story:** As a developer, I want recent jobs to be searchable immediately while older
jobs are embedded cheaply in batches so that I get fast recall without paying real-time
embedding costs for everything.

#### Acceptance Criteria

1. `src/memory/embedding.ts` exports `classifyTier(db: DbAdapter, workspaceId: string):
   Promise<'hot' | 'cold'>` which counts jobs completed in the last 7 days; if that count
   is ≤ 100 the current job is `hot`, otherwise `cold`.
2. Hot jobs: `embedding_status` is set to `embedded` immediately and the real-time Voyage
   API (`voyage-3-large`) is called with the raw text. The returned vector is stored in
   Hindsight alongside the memory record.
3. Cold jobs: `embedding_status` is set to `pending` and no Voyage API call is made
   immediately.
4. `src/workers/memoryBatchEmbed.ts` exports `startBatchEmbedWorker(db, client)` which
   runs every 6 hours via `setInterval`.
5. Each batch run: queries up to 1 000 `pending` rows ordered by `extracted_at ASC`, sends
   them to the Voyage Batch API, polls for completion (up to 4 hours), then updates
   `embedding_status` to `embedded` for successes or `failed` for errors.
6. Rows with `embed_attempts >= 3` are marked `failed` and skipped in future batch runs.
7. `embed_attempts` is incremented on each batch attempt regardless of outcome.
8. If the Voyage Batch API call itself throws, the worker logs the error and exits the current
   run cleanly — it will retry on the next 6-hour tick.

### Requirement 4: Manual Re-trigger and Backfill

**User Story:** As a developer, I want to manually re-trigger extraction for a specific job
and run a bulk backfill over historical jobs so that I can recover from failures and seed the
memory store from existing work.

#### Acceptance Criteria

1. `POST /api/memory/extract/:jobId` re-runs `extractAndStore` for the given job, overwriting
   any existing `memory_extraction` row. Returns `{ jobId, memoryCount, qualityScore }`.
2. The route returns 404 if the job ID does not exist in the DB.
3. The route returns 503 if `MEMORY_EXTRACTION_ENABLED=false`.
4. `POST /api/memory/backfill` accepts `{ workspaceId, limit?: number }` (default limit 100)
   and enqueues extraction for the most-recent `limit` completed jobs that have no
   `memory_extraction` row. Returns `{ queued: number }`.
5. Backfill runs extractions sequentially (not concurrently) to avoid LLM rate-limit bursts,
   with a 500 ms delay between each job.
6. Extraction is triggered automatically from `src/routes/jobs.ts` whenever a job status
   transitions to `done` and `MEMORY_EXTRACTION_ENABLED=true`.
