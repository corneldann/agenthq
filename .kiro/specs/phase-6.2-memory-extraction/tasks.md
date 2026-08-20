# Implementation Plan: Phase 6.2 — Memory Extraction

## Overview

Implements the automatic memory extraction pipeline for AgentHQ. When an agent job reaches
`done` status, its `.md` output file is read, structured facts are extracted via two LLM calls
(extractor + quality gate scorer), deduplicated against existing Hindsight memories, and stored
via `IMemoryClient`. A hybrid hot/cold embedding tier strategy controls whether Voyage real-time
or batch embedding is used. A 6-hour batch worker processes cold-tier rows. Manual re-trigger
and backfill HTTP routes allow recovery from failures.

**Prerequisite:** Phase 6.1 complete (`IMemoryClient`, `MemoryCircuitBreaker`, `RetryQueue`,
`createMemoryClient` all in place).

**Delivers:** First end-to-end flow — job completes → facts extracted → quality-scored →
deduplicated → stored in Hindsight → indexed for recall.

---

## Task Dependency Graph

```json
{
  "waves": [
    {
      "wave": 1,
      "tasks": ["Task 1"],
      "description": "Database migration — must land before any code that references the memory_extraction table"
    },
    {
      "wave": 2,
      "tasks": ["Task 2"],
      "description": "Constants and configuration — env vars consumed by all subsequent tasks"
    },
    {
      "wave": 3,
      "tasks": ["Task 4"],
      "description": "Embedding tier classification — Task 3 sub-task 3.12 calls classifyTier, so Task 4 must be implemented first"
    },
    {
      "wave": 4,
      "tasks": ["Task 3", "Task 5"],
      "description": "Extraction pipeline and batch worker — both depend on Task 4; can be developed in parallel"
    },
    {
      "wave": 5,
      "tasks": ["Task 6", "Task 7"],
      "description": "HTTP routes and fileWatcher integration — both depend on the extraction pipeline from Task 3"
    },
    {
      "wave": 6,
      "tasks": ["Task 8"],
      "description": "End-to-end checkpoint — verifies the complete pipeline after all prior tasks complete"
    }
  ]
}
```

Tasks 3 and 4 have a mutual dependency at sub-task level (3.12 calls `classifyTier` from Task 4).
Implement Task 4 first, then complete Task 3.

---

## Skill Activation — REQUIRED before every task

**Call `disclose_context` for these skills before writing any code or tests:**

| Always | `accelint-ts-best-practices`, `accelint-ts-testing` |
|--------|------------------------------------------------------|
| + DB / backend / routes | `error-handling-patterns` |
| + performance / query timing | `accelint-ts-performance` |
| + security / validation | `best-practices` |
| + JSDoc / comments | `accelint-ts-documentation` |

These skills do NOT activate automatically during spec task execution.
`disclose_context` must be called explicitly at the start of each task.

---

## Tasks

- [x] 1. Database Migration 004 — Add the `memory_extraction` table and indexes to the database schema
  - [x] 1.1 Create `migrations/004_memory_extraction.sql` with the full `CREATE TABLE IF NOT EXISTS memory_extraction` statement as specified in `design.md` — columns: `id`, `job_id`, `workspace_id`, `extracted_at`, `raw_text`, `memory_count`, `quality_score`, `embedding_status` (CHECK), `embed_attempts`, `tier` (CHECK), `last_modified`, `deleted_at`
  - [x] 1.2 Add `idx_memext_workspace` partial index on `(workspace_id) WHERE deleted_at IS NULL`
  - [x] 1.3 Add `idx_memext_pending` partial index on `(embedding_status, extracted_at) WHERE embedding_status = 'pending' AND deleted_at IS NULL`
  - [x] 1.4 Add `REFERENCES jobs(id)` FK on `job_id`
  - [x] 1.5 Add `DbMemoryExtraction` row type to `src/db/adapter.ts` (all columns, matching SQLite storage types for booleans/integers)
  - [x] 1.6 Start the monitor and verify migration 004 applies cleanly; confirm the table and indexes appear in the SQLite schema
  - [x] 1.7 Write a migration test: apply 004 to an in-memory SQLite DB and assert all columns and indexes exist via `PRAGMA table_info` and `PRAGMA index_list`

- [x] 2. Constants and Configuration — Add the two new env vars required by Phase 6.2
  - [x] 2.1 Add `VOYAGE_API_KEY` to `src/constants.ts` — read from `process.env.VOYAGE_API_KEY`, default empty string
  - [x] 2.2 Add `MEMORY_HOT_TIER_COUNT` to `src/constants.ts` — parse as integer from `process.env.MEMORY_HOT_TIER_COUNT`, default `100`
  - [x] 2.3 Update `.env.example` with both vars, each with a comment explaining purpose and default
  - [x] 2.4 Add startup warning in `src/monitor.ts`: if `MEMORY_ENABLED=true` and `VOYAGE_API_KEY` is empty, log `WARNING: VOYAGE_API_KEY not set — hot-tier Voyage embedding disabled`
  - [x] 2.5 Write unit tests for constants parsing: verify `MEMORY_HOT_TIER_COUNT` falls back to 100 when env var is absent, and that non-integer values produce the default

- [x] 3. Extraction Pipeline — Implement `src/memory/extraction.ts` with in-flight guard, LLM calls, quality gate, pattern filter, dedup, and DB upsert
  - [x] 3.1 Create `src/memory/extraction.ts` — export `extractAndStore(job, db, client)` with module-level `_inFlight = new Set<string>()`
  - [x] 3.2 Implement in-flight guard: if `_inFlight.has(job.id)` return immediately; add to set in try block, remove in finally
  - [x] 3.3 Implement file read: use `Bun.file(job.mdFile)` — if absent or empty, call `_writeFailedRow` and return
  - [x] 3.4 Implement `_callExtractor(text, critiques?)` — LLM call returning `CandidateFact[]`; on JSON parse failure or wrong shape, throw
  - [x] 3.5 Implement `_callScorer(facts)` — second LLM call returning `ScoredFact[]`; validate returned array length matches input; on mismatch treat as scorer error
  - [x] 3.6 Implement refinement pass: if mean score < `QUALITY_THRESHOLD` (0.75), call `_callExtractor` again with scorer critiques appended; re-score; one pass only; store results regardless of post-refinement scores
  - [x] 3.7 Implement generic pattern rejection: `GENERIC_REJECT_PATTERNS`, `MIN_FACT_LENGTH`, `MAX_FACT_LENGTH` — reject matching facts before dedup
  - [x] 3.8 Implement dedup: for each remaining fact, call `client.recall(text, scope, 1)`; if first result `similarityScore > DEDUP_SIMILARITY_THRESHOLD` (0.92) discard; if `recall` throws, reject fact and log WARN; if `similarityScore` absent, skip check and proceed
  - [x] 3.9 Implement `client.retain` loop — collect returned IDs in `retainedIds` array for rollback
  - [x] 3.10 Implement `_writeFailedRow` helper with `ON CONFLICT(job_id) DO UPDATE` upsert
  - [x] 3.11 Implement success upsert in `_doExtract`: `INSERT INTO memory_extraction ... ON CONFLICT(job_id) DO UPDATE`; on DB upsert failure: call `client.delete` for each `retainedId`, then call `_writeFailedRow`
  - [x] 3.12 Wire `classifyTier` (Task 4) into the extraction flow to set `tier` on the upsert row
  - [x] 3.13 Write unit tests: in-flight guard; missing/empty file writes failed row; LLM throw writes failed row; quality gate pass writes actual metrics; generic patterns reject before dedup; `client.recall` throw rejects fact and continues; DB upsert fail rolls back retained facts
  - [x] 3.14 Write property-based tests (fast-check): reject-pattern facts always rejected regardless of score; `memory_count` equals retained ID count; mean quality score ∈ [0, 1]

- [x] 4. Embedding Tier Classification — Implement `src/memory/embedding.ts` with hot/cold tier classification and Voyage API wrapper
  - [x] 4.1 Create `src/memory/embedding.ts` — export `classifyTier(db, workspaceId)`
  - [x] 4.2 Implement `classifyTier` query: count non-deleted completed jobs with `ORDER BY timestamp DESC LIMIT MEMORY_HOT_TIER_COUNT`; return `'hot'` if `cnt < MEMORY_HOT_TIER_COUNT`, else `'cold'`
  - [x] 4.3 Implement `embedHot(text)` — `fetch` to Voyage `voyage-3-large`; `AbortSignal.timeout(10_000)`; return `number[] | null`; return `null` on any error
  - [x] 4.4 Export `VoyageBatchClient` class with `submit(texts): Promise<string>` and `poll(batchId, timeoutMs): Promise<BatchResult>` methods
  - [x] 4.5 Write unit tests for `classifyTier`: 0 jobs → hot; count − 1 → hot; count → cold; deleted jobs excluded
  - [x] 4.6 Write unit tests for `embedHot`: empty key → null without fetch; non-200 → null; timeout → null
  - [x] 4.7 Write unit tests for `VoyageBatchClient.poll`: timeout exceeded → rejects; success → returns `BatchResult` with `failed` indices

- [x] 5. Batch Embedding Worker — Implement `src/workers/memoryBatchEmbed.ts` for 6-hour cold-tier embedding
  - [x] 5.1 Create `src/workers/memoryBatchEmbed.ts` — export `startBatchEmbedWorker(db, client)`
  - [x] 5.2 Implement worker loop: `setInterval` at 6 hours; initial fire delayed 60 seconds after startup
  - [x] 5.3 Implement DB query: `SELECT ... WHERE embedding_status = 'pending' AND embed_attempts < 3 AND deleted_at IS NULL ORDER BY extracted_at ASC LIMIT 1000`
  - [x] 5.4 Implement Voyage Batch API submission via `VoyageBatchClient.submit` — on throw: log ERROR, return without modifying `embed_attempts`
  - [x] 5.5 Implement `embed_attempts` increment transaction — runs after successful submit, before poll
  - [x] 5.6 Implement polling with 4-hour timeout via `VoyageBatchClient.poll`
  - [x] 5.7 Implement status update transaction: set `embedding_status` to `'embedded'` or `'failed'` per Voyage result; only update rows with `embed_attempts < 3`
  - [x] 5.8 Implement `_markExhaustedAsFailed`: mark rows with `embed_attempts >= 3` as `embedding_status = 'failed'`
  - [x] 5.9 Wire `startBatchEmbedWorker` into `src/monitor.ts` when `MEMORY_ENABLED=true` and `dbReady=true`
  - [x] 5.10 Write unit tests: empty rows → no Voyage call; submit throws → no `embed_attempts` increment; poll timeout → exhausted rows failed, others pending; success → correct status per index; `embed_attempts = 3` rows excluded from query
  - [x] 5.11 Write property test: after any batch run, no row has `embed_attempts > 3`

- [x] 6. Extraction Routes — Implement `src/routes/memory-extraction.ts` with re-trigger and backfill endpoints
  - [x] 6.1 Create `src/routes/memory-extraction.ts` — export `register(router, db, client)`
  - [x] 6.2 Implement `POST /api/memory/extract/:jobId`: check `MEMORY_EXTRACTION_ENABLED` first (503); then job existence (404); call `extractAndStore`; return `{ jobId, memoryCount, qualityScore }`
  - [x] 6.3 Implement `POST /api/memory/backfill`: validate `workspaceId` (400 if missing); validate `limit` (400 if < 1 or non-integer; silent cap at 100); query unprocessed jobs; run sequentially with 500ms delay; return `{ queued, appliedLimit }`
  - [x] 6.4 Register routes in `src/monitor.ts` only when `dbReady=true`
  - [x] 6.5 Write unit tests for `POST /api/memory/extract/:jobId`: disabled → 503 before DB query; missing job → 404; valid job → correct response shape
  - [x] 6.6 Write unit tests for `POST /api/memory/backfill`: missing `workspaceId` → 400; `limit = 0` → 400; `limit = -1` → 400; `limit = 0.5` → 400; `limit = 150` → capped at 100; valid → `appliedLimit` in response

- [x] 7. FileWatcher Integration — Wire extraction trigger into `src/workers/fileWatcher.ts` sync callback
  - [x] 7.1 Update `startFileWatcher` signature to accept optional `memoryClient: IMemoryClient | null` parameter
  - [x] 7.2 After `syncTool.syncFile` succeeds, query jobs by `md_file` or `log_file` matching the resolved path
  - [x] 7.3 For each matched job with `status = 'done'`: call `extractAndStore` fire-and-forget; catch and log errors
  - [x] 7.4 Guard block with `if (MEMORY_EXTRACTION_ENABLED && memoryClient !== null)` — no-op when disabled
  - [x] 7.5 Update `src/monitor.ts` to pass `memoryClient` to `startFileWatcher` when `MEMORY_ENABLED=true`
  - [x] 7.6 Implement `jobFromDbRow(row: DbJob): Job` helper mapping snake_case DB columns to camelCase `Job` fields
  - [x] 7.7 Write integration test: `done` job transition → `extractAndStore` called with correct job and client
  - [x] 7.8 Write test: `MEMORY_EXTRACTION_ENABLED=false` → `extractAndStore` never called even for `done` jobs

- [x] 8. Phase 6.2 Checkpoint — Verify the complete extraction pipeline end-to-end
  - [x] 8.1 Run `bun test test/` — all tests pass
  - [x] 8.2 Run `tsc --noEmit` — zero errors
  - [x] 8.3 Start the monitor with `MEMORY_ENABLED=true`, `MEMORY_EXTRACTION_ENABLED=true`, and a running Hindsight instance
  - [x] 8.4 Trigger a job completion (or use `POST /api/memory/extract/:jobId` on an existing done job)
  - [x] 8.5 Verify a `memory_extraction` row appears in the DB with correct `quality_score`, `memory_count`, and `tier`
  - [x] 8.6 Verify memories appear in Hindsight via `GET /api/memory/search?q=<topic>&workspaceId=<id>`
  - [x] 8.7 Call `POST /api/memory/backfill` with `{ workspaceId, limit: 5 }` — verify `{ queued: N, appliedLimit: 5 }` response
  - [x] 8.8 Verify the batch embed worker starts (log line `[batch-embed]`) and processes cold-tier rows
  - [x] 8.9 Confirm `GET /api/memory/circuit-breaker` returns `state: 'closed'` with no failures

---

## Notes

- **LLM call costs:** Each job extraction makes 2–3 LLM calls (extractor + scorer, plus one
  refinement pass if mean score < 0.75). Budget accordingly when enabling
  `MEMORY_EXTRACTION_ENABLED` on high-throughput workspaces.
- **Voyage API key:** `VOYAGE_API_KEY` is optional — if absent, hot-tier jobs fall back to
  Hindsight's internal embedding on first recall. Cold-tier batch embedding requires it.
- **SQLite WAL mode:** Already enabled by `SQLiteAdapter` from Phase 5.1. The batch worker's
  transactions are compatible with WAL — no additional configuration needed.
- **Re-trigger vs backfill:** `POST /api/memory/extract/:jobId` re-processes a specific job
  even if a row exists. `POST /api/memory/backfill` only enqueues jobs with *no* existing
  `memory_extraction` row — use the single-job route to force re-extraction of failed rows.
- **Task ordering:** Implement Task 4 (embedding tier) before completing Task 3 (extraction
  pipeline) because sub-task 3.12 calls `classifyTier` from Task 4.
- **Test isolation:** Use an in-memory SQLite DB (`:memory:`) for all DB-touching tests.
  Mock `IMemoryClient` with a fake that records calls for assertion.
