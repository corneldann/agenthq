# Requirements Document

## Introduction

Phase 6.2 builds the extraction pipeline: when an agent job reaches `done` status, its output
file is read, structured memory facts are derived via an LLM call, scored by a quality gate,
deduplicated, and stored via the `IMemoryClient` introduced in Phase 6.1. A hybrid 2-tier
embedding strategy classifies jobs as hot (embed immediately) or cold (batch every 6 hours)
to balance search latency against embedding cost.

**Prerequisite:** Phase 6.1 complete. `IMemoryClient`, `MemoryCircuitBreaker`, and
`RetryQueue` are available. `VOYAGE_API_KEY` must be configured for hot-tier embedding.

---

## Glossary

| Term | Definition |
|------|-----------|
| **Quality gate** | A second LLM call that scores each candidate fact on three dimensions and rejects facts below the threshold. |
| **Scoring rubric** | accuracy (weight 0.4) + relevance (weight 0.3) + specificity (weight 0.3) = weighted score ∈ [0, 1]. |
| **Hot tier** | The N most-recently-completed jobs where N is configurable via `MEMORY_HOT_TIER_COUNT` (default 100). Embedded immediately for sub-second recall. |
| **Cold tier** | All jobs beyond the hot window — raw text stored with `embedding_status = 'pending'`; embedded in 6-hour batch. |
| **memory_extraction** | DB table tracking extraction status per job (migration 004). |
| **Voyage Batch API** | Voyage AI's batch embedding endpoint — 33% cheaper than real-time, 12-hour completion window. |
| **Deduplication** | Rejecting a new fact when the top `recall` result for the same scope has `similarityScore > 0.92`. |
| **In-flight guard** | A `Set<string>` of job IDs currently undergoing extraction, preventing duplicate concurrent runs for the same job. |

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
2. An in-flight guard (`Set<string>` keyed by `job.id`) prevents concurrent duplicate
   extractions for the same job. If an extraction for that job ID is already running, the
   new call returns immediately without doing any work or logging an error.
3. The function reads the job's `.md` output file. If the file is absent or empty, the
   function logs a warning and returns without writing anything to the DB.
4. A first LLM call (the **extractor**) reads the file text and returns a JSON array of
   `{ text: string, category: string }` objects where `category` is one of `architecture`,
   `error`, `resolution`, `procedure`, `constraint`.
5. A second LLM call (the **quality gate scorer**) evaluates each candidate fact against the
   scoring rubric — accuracy (0.4) + relevance (0.3) + specificity (0.3) — and returns
   a `{ score: number, critique: string }` for each fact. Facts with `score < 0.75` are
   dropped before any storage occurs.
6. If the mean score of all scored facts is below 0.75, a single refinement pass is triggered:
   the scorer's critique for each low-scoring fact is appended to the extractor prompt and the
   extractor LLM is called again. Only one refinement pass is attempted per job.
7. Generic fact patterns are explicitly rejected regardless of score:
   - Text matching `/the system has \w+/i`
   - Text matching `/build (is )?currently failing/i`
   - Text shorter than 20 characters
   - Text longer than 500 characters
8. Before calling `client.retain`, a deduplication check calls `client.recall(text, scope, 1)`.
   If the returned `Memory` array is non-empty and the first result's `similarityScore > 0.92`,
   the fact is discarded as a duplicate. If `Memory.similarityScore` is absent (Hindsight does
   not return scores), the deduplication check is skipped with a debug log.
9. Each accepted fact is stored via `client.retain(text, scopeFromJob(job))`.
10. When all accepted facts have been stored, a `memory_extraction` row shall be upserted
    for the job with `extracted_at`, `raw_text`, `memory_count`, `quality_score`,
    `embedding_status`, and `tier` fields populated. If this DB upsert fails, the system
    shall treat the failure as an extraction failure: any facts already stored via
    `client.retain` shall be rolled back (deleted by their returned IDs), the row shall be
    written with `quality_score = 0`, `memory_count = 0`, `embedding_status = 'failed'`,
    and the error logged without re-throwing.
11. When an extraction failure occurs — whether from a thrown LLM exception, a missing output
    file, or any other non-LLM error — the system shall write a `memory_extraction` row with
    `quality_score = 0`, `memory_count = 0`, `embedding_status = 'failed'`, and log the
    failure without re-throwing. When an LLM call succeeds but produces no valid facts after
    quality-gating, the system shall record the actual metrics (e.g. `memory_count = 0`,
    actual `quality_score`) rather than an error row.

### Requirement 3: Hybrid Embedding Tiers

**User Story:** As a developer, I want recent jobs to be searchable immediately while older
jobs are embedded cheaply in batches so that I get fast recall without paying real-time
embedding costs for everything.

#### Acceptance Criteria

1. `VOYAGE_API_KEY` is added to `src/constants.ts` and `.env.example`. It is required when
   `MEMORY_ENABLED=true`; the monitor logs a warning at startup if it is absent.
2. `MEMORY_HOT_TIER_COUNT` (default `100`) is added to `src/constants.ts`. It defines the
   maximum number of recently-completed jobs that qualify for the hot tier.
3. `src/memory/embedding.ts` exports `classifyTier(db: DbAdapter, workspaceId: string):
   Promise<'hot' | 'cold'>` which queries the count of non-deleted completed jobs for the
   workspace ordered by `timestamp DESC`. Returns `'hot'` if the current job would fall within
   the most-recent `MEMORY_HOT_TIER_COUNT` rows, `'cold'` otherwise.
4. Hot jobs: `embedding_status` is set to `embedded` and the Voyage real-time API
   (`voyage-3-large`) is called with the raw extracted text. Hindsight handles its own
   embedding internally — the Voyage call here pre-warms the embedding via a `retain` request
   that includes the pre-computed vector. If the Hindsight version in use does not accept
   pre-computed vectors, the Voyage call is skipped and Hindsight embeds the text itself on
   first recall; `embedding_status` is still set to `embedded` in the local DB.
5. Cold jobs: `embedding_status` is set to `pending` and no Voyage API call is made immediately.
   The system shall strictly prevent any Voyage API call for cold-tier jobs at classification
   time — embedding is exclusively handled by the batch worker on its next scheduled run.
6. `src/workers/memoryBatchEmbed.ts` exports `startBatchEmbedWorker(db, client)` which
   runs every 6 hours via `setInterval`.
7. Each batch run: queries up to 1 000 `pending` rows ordered by `extracted_at ASC`, sends
   them to the Voyage Batch API, polls for completion (up to 4 hours), then updates
   `embedding_status` to `embedded` for successes or `failed` for errors.
8. `embed_attempts` is incremented only for rows that were included in a batch submitted to
   the Voyage Batch API. Rows in a batch that fails before submission (i.e. the API call
   throws before any job is processed) shall not have their `embed_attempts` incremented.
9. Rows with `embed_attempts >= 3` are marked `embedding_status = 'failed'` and skipped in
   all future batch runs. A row only reaches this threshold after three actual Voyage batch
   submission attempts, not from API-level failures that occur before submission.
10. If the Voyage Batch API call itself throws before submitting any rows, the worker logs
    the error and exits the current run cleanly without modifying any row's `embed_attempts`.
    It will retry on the next 6-hour tick.

### Requirement 4: Manual Re-trigger and Backfill

**User Story:** As a developer, I want to manually re-trigger extraction for a specific job
and run a bulk backfill over historical jobs so that I can recover from failures and seed the
memory store from existing work.

#### Acceptance Criteria

1. `POST /api/memory/extract/:jobId` re-runs `extractAndStore` for the given job, overwriting
   any existing `memory_extraction` row. Returns `{ jobId, memoryCount, qualityScore }`.
2. The route returns 404 if the job ID does not exist in the DB, regardless of whether the
   ID format is syntactically valid. No format pre-validation is performed.
3. The route returns 503 if `MEMORY_EXTRACTION_ENABLED=false` — this applies only when the
   endpoint is explicitly called via HTTP. The automatic background trigger (AC 6 below)
   silently skips when the flag is off and does not produce any HTTP response.
4. `POST /api/memory/backfill` accepts `{ workspaceId, limit?: number }` (default limit 100,
   maximum limit 100) and enqueues extraction for the most-recent `limit` completed jobs that
   have no `memory_extraction` row. When the client supplies a `limit` greater than 100, the
   system shall silently cap it at 100 without returning an error. Negative or zero values
   for `limit` shall return 400 with `{ error: 'limit must be a positive integer' }`.
   Returns `{ queued: number, appliedLimit: number }` so the caller can observe any capping.
5. Backfill runs extractions sequentially (not concurrently) to avoid LLM rate-limit bursts,
   with a 500 ms delay between each job.
6. Extraction is triggered automatically from `src/routes/jobs.ts` whenever a job status
   transitions to `done` and `MEMORY_EXTRACTION_ENABLED=true`. When the flag is `false`, the
   trigger is silently skipped — no error thrown, no warning logged beyond a single DEBUG line.
