# Implementation Plan: Phase 6.2 — Memory Extraction

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

## Task 1: Database Migration 004

Add the `memory_extraction` table and indexes to the database schema.

### Sub-tasks

- [ ] 1.1 Create `migrations/004_memory_extraction.sql` with the full `CREATE TABLE IF NOT EXISTS memory_extraction` statement as specified in `design.md` — columns: `id`, `job_id`, `workspace_id`, `extracted_at`, `raw_text`, `memory_count`, `quality_score`, `embedding_status` (CHECK), `embed_attempts`, `tier` (CHECK), `last_modified`, `deleted_at`
- [ ] 1.2 Add `idx_memext_workspace` partial index on `(workspace_id) WHERE deleted_at IS NULL`
- [ ] 1.3 Add `idx_memext_pending` partial index on `(embedding_status, extracted_at) WHERE embedding_status = 'pending' AND deleted_at IS NULL`
- [ ] 1.4 Add `REFERENCES jobs(id)` FK on `job_id`
- [ ] 1.5 Add `DbMemoryExtraction` row type to `src/db/adapter.ts` (all columns, matching SQLite storage types for booleans/integers)
- [ ] 1.6 Start the monitor and verify migration 004 applies cleanly; confirm the table and indexes appear in the SQLite schema
- [ ] 1.7 Write a migration test: apply 004 to an in-memory SQLite DB and assert all columns and indexes exist via `PRAGMA table_info` and `PRAGMA index_list`

**Acceptance check:** `tsc --noEmit` clean. Migration test passes. Monitor starts without errors.

---

## Task 2: Constants and Configuration

Add the two new env vars required by Phase 6.2.

### Sub-tasks

- [ ] 2.1 Add `VOYAGE_API_KEY` to `src/constants.ts` — read from `process.env.VOYAGE_API_KEY`, default empty string
- [ ] 2.2 Add `MEMORY_HOT_TIER_COUNT` to `src/constants.ts` — parse as integer from `process.env.MEMORY_HOT_TIER_COUNT`, default `100`
- [ ] 2.3 Update `.env.example` with both vars, each with a comment explaining purpose and default
- [ ] 2.4 Add startup warning in `src/monitor.ts`: if `MEMORY_ENABLED=true` and `VOYAGE_API_KEY` is empty, log `WARNING: VOYAGE_API_KEY not set — hot-tier Voyage embedding disabled`
- [ ] 2.5 Write unit tests for constants parsing: verify `MEMORY_HOT_TIER_COUNT` falls back to 100 when env var is absent, and that non-integer values produce the default

**Acceptance check:** `tsc --noEmit` clean. Constants tests pass.

---

## Task 3: Extraction Pipeline (`src/memory/extraction.ts`)

Implement the core extraction function with in-flight guard, LLM calls, quality gate, pattern filter, dedup, and DB upsert.

### Sub-tasks

- [ ] 3.1 Create `src/memory/extraction.ts` — export `extractAndStore(job, db, client)` with module-level `_inFlight = new Set<string>()`
- [ ] 3.2 Implement in-flight guard: if `_inFlight.has(job.id)` return immediately; add to set in try block, remove in finally
- [ ] 3.3 Implement file read: use `Bun.file(job.mdFile)` — if absent or empty, call `_writeFailedRow` and return
- [ ] 3.4 Implement `_callExtractor(text, critiques?)` — LLM call returning `CandidateFact[]`; on JSON parse failure or wrong shape, throw
- [ ] 3.5 Implement `_callScorer(facts)` — second LLM call returning `ScoredFact[]`; validate returned array length matches input; on mismatch treat as scorer error
- [ ] 3.6 Implement refinement pass: if mean score < `QUALITY_THRESHOLD` (0.75), call `_callExtractor` again with scorer critiques appended; re-score; one pass only; store results regardless of post-refinement scores
- [ ] 3.7 Implement generic pattern rejection: `GENERIC_REJECT_PATTERNS`, `MIN_FACT_LENGTH`, `MAX_FACT_LENGTH` — reject matching facts before dedup
- [ ] 3.8 Implement dedup: for each remaining fact, call `client.recall(text, scope, 1)`; if first result `similarityScore > DEDUP_SIMILARITY_THRESHOLD` (0.92) discard; if `recall` throws, reject fact and log WARN; if `similarityScore` absent, skip check and proceed
- [ ] 3.9 Implement `client.retain` loop — collect returned IDs in `retainedIds` array for rollback
- [ ] 3.10 Implement `_writeFailedRow` helper with `ON CONFLICT(job_id) DO UPDATE` upsert
- [ ] 3.11 Implement success upsert in `_doExtract`: `INSERT INTO memory_extraction ... ON CONFLICT(job_id) DO UPDATE`; on DB upsert failure: call `client.delete` for each `retainedId`, then call `_writeFailedRow`
- [ ] 3.12 Wire `classifyTier` (Task 4) into the extraction flow to set `tier` on the upsert row
- [ ] 3.13 Write unit tests:
  - [ ] In-flight guard: concurrent calls with same job.id — second returns immediately
  - [ ] Missing file → `_writeFailedRow` called, no LLM calls made
  - [ ] Empty file → same as missing
  - [ ] LLM extractor throws → `_writeFailedRow` called
  - [ ] All facts fail quality gate → actual metrics row written (not error row)
  - [ ] Generic pattern rejection fires before dedup
  - [ ] `client.recall` throws → fact rejected, extraction continues for other facts
  - [ ] DB upsert fails → retained facts rolled back via `client.delete`
- [ ] 3.14 Write property-based tests (fast-check):
  - [ ] Any fact text matching a reject pattern is always rejected regardless of quality score
  - [ ] `memory_count` on success row always equals the number of retained IDs
  - [ ] Mean quality score stored is always ∈ [0, 1]

**Acceptance check:** `tsc --noEmit` clean. All unit and property tests pass.

---

## Task 4: Embedding Tier Classification (`src/memory/embedding.ts`)

Implement hot/cold tier classification and the Voyage real-time API call.

### Sub-tasks

- [ ] 4.1 Create `src/memory/embedding.ts` — export `classifyTier(db, workspaceId)`
- [ ] 4.2 Implement `classifyTier` query: `SELECT COUNT(*) AS cnt FROM jobs WHERE workspace_id = ? AND status IN ('done','reported','error') AND deleted_at IS NULL ORDER BY timestamp DESC LIMIT ?` — return `'hot'` if `cnt < MEMORY_HOT_TIER_COUNT`, else `'cold'`
- [ ] 4.3 Implement `embedHot(text)` — `fetch` to `https://api.voyageai.com/v1/embeddings` with `voyage-3-large`; `AbortSignal.timeout(10_000)`; return `number[] | null`; return `null` on any error (non-fatal fallback)
- [ ] 4.4 Export `VoyageBatchClient` class with `submit(texts)` and `poll(batchId, timeoutMs)` methods
- [ ] 4.5 Write unit tests for `classifyTier`:
  - [ ] 0 completed jobs → `'hot'`
  - [ ] Exactly `MEMORY_HOT_TIER_COUNT - 1` completed jobs → `'hot'`
  - [ ] Exactly `MEMORY_HOT_TIER_COUNT` completed jobs → `'cold'`
  - [ ] Deleted jobs are excluded from count
- [ ] 4.6 Write unit tests for `embedHot`:
  - [ ] Empty `VOYAGE_API_KEY` → returns `null` without making fetch
  - [ ] Voyage API returns non-200 → returns `null`
  - [ ] Voyage API times out → returns `null`
- [ ] 4.7 Write unit tests for `VoyageBatchClient.poll`:
  - [ ] Polling timeout exceeded → rejects
  - [ ] Successful completion → returns `BatchResult` with `failed` indices

**Acceptance check:** `tsc --noEmit` clean. All tests pass.

---

## Task 5: Batch Embedding Worker (`src/workers/memoryBatchEmbed.ts`)

Implement the 6-hour cold-tier embedding worker.

### Sub-tasks

- [ ] 5.1 Create `src/workers/memoryBatchEmbed.ts` — export `startBatchEmbedWorker(db, client)`
- [ ] 5.2 Implement worker loop with `setInterval` at 6 hours, initial fire delayed 60 seconds after startup
- [ ] 5.3 Implement DB query: `SELECT * FROM memory_extraction WHERE embedding_status = 'pending' AND embed_attempts < 3 AND deleted_at IS NULL ORDER BY extracted_at ASC LIMIT 1000`
- [ ] 5.4 Implement Voyage Batch API submission via `VoyageBatchClient.submit` — on throw: log ERROR, return without modifying `embed_attempts`
- [ ] 5.5 Implement `embed_attempts` increment transaction — runs after successful submit, before poll
- [ ] 5.6 Implement polling with 4-hour timeout via `VoyageBatchClient.poll`
- [ ] 5.7 Implement status update transaction: set `embedding_status` to `'embedded'` or `'failed'` per Voyage result; only update rows with `embed_attempts < 3`
- [ ] 5.8 Implement `_markExhaustedAsFailed`: `UPDATE ... SET embedding_status = 'failed' WHERE embed_attempts >= 3 AND embedding_status = 'pending'`
- [ ] 5.9 Wire `startBatchEmbedWorker` into `src/monitor.ts` — start when `MEMORY_ENABLED=true` and `dbReady=true`
- [ ] 5.10 Write unit tests:
  - [ ] Empty pending rows → worker exits without calling Voyage API
  - [ ] Voyage submit throws → `embed_attempts` not incremented for any row
  - [ ] Polling timeout → exhausted rows (`embed_attempts >= 3`) marked `failed`; others stay `pending`
  - [ ] Successful batch → `embedding_status` set to `embedded` for successful indices, `failed` for failed indices
  - [ ] Row with `embed_attempts = 3` is excluded from query (not submitted again)
- [ ] 5.11 Write property test: after any batch run, no row has `embed_attempts > 3`

**Acceptance check:** `tsc --noEmit` clean. All tests pass. Monitor starts worker without errors.

---

## Task 6: Extraction Routes (`src/routes/memory-extraction.ts`)

Implement the manual re-trigger and backfill HTTP endpoints.

### Sub-tasks

- [ ] 6.1 Create `src/routes/memory-extraction.ts` — export `register(router, db, client)`
- [ ] 6.2 Implement `POST /api/memory/extract/:jobId`:
  - [ ] Check `MEMORY_EXTRACTION_ENABLED` first — return 503 before any DB query
  - [ ] Query `jobs` by ID — return 404 if not found
  - [ ] Call `extractAndStore(job, db, client)` — await completion
  - [ ] Query `memory_extraction` for the result row
  - [ ] Return `{ jobId, memoryCount, qualityScore }` with status 200
- [ ] 6.3 Implement `POST /api/memory/backfill`:
  - [ ] Parse and validate `workspaceId` (non-empty string) — return 400
  - [ ] Validate `limit`: default 100; reject < 1 or non-integer with 400; silently cap > 100 at 100
  - [ ] Query jobs with no `memory_extraction` row, ordered by `timestamp DESC`, limited to `appliedLimit`
  - [ ] Run extractions sequentially with 500ms delay between each
  - [ ] Return `{ queued, appliedLimit }` immediately after enqueueing (do not await all completions)
- [ ] 6.4 Register routes in `src/monitor.ts` (alongside other route registrations, only when `dbReady=true`)
- [ ] 6.5 Write unit tests for `POST /api/memory/extract/:jobId`:
  - [ ] `MEMORY_EXTRACTION_ENABLED=false` → 503 returned before DB query
  - [ ] Non-existent job ID → 404
  - [ ] Valid job → `extractAndStore` called, result row queried, response shape correct
- [ ] 6.6 Write unit tests for `POST /api/memory/backfill`:
  - [ ] Missing `workspaceId` → 400
  - [ ] `limit = 0` → 400
  - [ ] `limit = -1` → 400
  - [ ] `limit = 0.5` (non-integer) → 400
  - [ ] `limit = 150` → silently capped, `appliedLimit = 100` in response
  - [ ] Valid request → correct number of jobs queued, `appliedLimit` matches

**Acceptance check:** `tsc --noEmit` clean. All route tests pass.

---

## Task 7: FileWatcher Integration

Wire the extraction trigger into the file watcher's sync callback.

### Sub-tasks

- [ ] 7.1 Update `startFileWatcher` signature in `src/workers/fileWatcher.ts` to accept optional `memoryClient: IMemoryClient | null` parameter
- [ ] 7.2 After `syncTool.syncFile` succeeds, query jobs by `md_file` or `log_file` matching the resolved path
- [ ] 7.3 For each matched job with `status = 'done'`: call `extractAndStore(job, db, memoryClient)` fire-and-forget; catch and log errors
- [ ] 7.4 Guard the entire block with `if (MEMORY_EXTRACTION_ENABLED && memoryClient !== null)` — no-op when disabled
- [ ] 7.5 Update `src/monitor.ts` to pass `memoryClient` to `startFileWatcher` when `MEMORY_ENABLED=true`
- [ ] 7.6 Implement `jobFromDbRow(row: DbJob): Job` helper — maps snake_case DB columns to camelCase `Job` interface fields
- [ ] 7.7 Write integration test: mock fileWatcher with a `done` job transition → assert `extractAndStore` was called with correct job and client
- [ ] 7.8 Write test: `MEMORY_EXTRACTION_ENABLED=false` → `extractAndStore` never called even when a `done` job is synced

**Acceptance check:** `tsc --noEmit` clean. Integration test passes. End-to-end: save a `.md` file to OUTPUT_DIR with a matching job in the DB → extraction fires within 500ms.

---

## Task 8: Phase 6.2 Checkpoint

Verify the complete extraction pipeline end-to-end.

### Sub-tasks

- [ ] 8.1 Run the full test suite: `bun test test/` — all tests pass
- [ ] 8.2 Run `tsc --noEmit` — zero errors
- [ ] 8.3 Start the monitor with `MEMORY_ENABLED=true`, `MEMORY_EXTRACTION_ENABLED=true`, and a running Hindsight instance
- [ ] 8.4 Trigger a job completion (or use `POST /api/memory/extract/:jobId` on an existing done job)
- [ ] 8.5 Verify a `memory_extraction` row appears in the DB with correct `quality_score`, `memory_count`, and `tier`
- [ ] 8.6 Verify memories appear in Hindsight via `GET /api/memory/search?q=<topic>&workspaceId=<id>` (Phase 6.1 route)
- [ ] 8.7 Call `POST /api/memory/backfill` with `{ workspaceId, limit: 5 }` and verify `{ queued: N, appliedLimit: 5 }` response
- [ ] 8.8 Verify the batch embed worker starts (log line: `[batch-embed]`) and processes cold-tier rows on the next tick
- [ ] 8.9 Confirm circuit breaker metrics (`GET /api/memory/circuit-breaker`) show `state: 'closed'` with no failures during the test run

**Acceptance check:** All sub-tasks verified. Phase 6.2 complete — ready for Phase 6.3 (Context Assembly).
