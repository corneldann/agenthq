# Design Document

## Overview

Phase 6.2 — Memory Extraction builds the automatic pipeline that transforms completed agent
job output files into structured, stored memories. It introduces the `memory_extraction` DB
table (migration 004), the `extractAndStore` extraction pipeline with quality gate, and a
hybrid hot/cold embedding tier strategy backed by a 6-hour batch worker.

This sub-phase depends on Phase 6.1 (`IMemoryClient`, `MemoryCircuitBreaker`, `RetryQueue`,
`createMemoryClient`) being in place. It delivers the first end-to-end flow: job completes →
facts extracted → quality-scored → deduplicated → stored in Hindsight → indexed for recall.

---

## Architecture

### Data Flow

```
src/routes/jobs.ts
  └─ job status → 'done'
       │
       ▼  (when MEMORY_EXTRACTION_ENABLED=true)
src/memory/extraction.ts  extractAndStore(job, db, client)
       │
       ├─ 1. In-flight guard (Set<string>)
       ├─ 2. Read job.mdFile → raw text
       ├─ 3. LLM extractor call → CandidateFact[]
       ├─ 4. LLM scorer call  → ScoredFact[]
       ├─ 5. Refinement pass (if mean score < 0.75)
       ├─ 6. Generic pattern rejection
       ├─ 7. Deduplication via client.recall
       ├─ 8. client.retain per accepted fact
       └─ 9. DB upsert → memory_extraction row
              │
              ▼  (failure path: rollback retained facts, write failed row)

src/memory/embedding.ts  classifyTier(db, workspaceId)
       │
       ├─ hot  → Voyage real-time API (voyage-3-large) → embedding_status='embedded'
       └─ cold → embedding_status='pending'
                      │
                      ▼  (every 6 hours)
              src/workers/memoryBatchEmbed.ts
                      │
                      ├─ SELECT LIMIT 1000 pending rows
                      ├─ Voyage Batch API submit
                      ├─ Poll up to 4 hours
                      └─ UPDATE embedding_status='embedded'|'failed'
                         INCREMENT embed_attempts
```

### New Files Introduced

| File | Role |
|------|------|
| `migrations/004_memory_extraction.sql` | Adds `memory_extraction` table + indexes |
| `src/memory/extraction.ts` | Main extraction pipeline + in-flight guard |
| `src/memory/embedding.ts` | Tier classification + Voyage API wrapper |
| `src/workers/memoryBatchEmbed.ts` | 6-hour cold-tier batch embedding worker |
| `src/routes/memory-extraction.ts` | `POST /api/memory/extract/:jobId`, `POST /api/memory/backfill` |

### Changes to Existing Files

| File | Change |
|------|--------|
| `src/constants.ts` | Add `VOYAGE_API_KEY`, `MEMORY_HOT_TIER_COUNT` |
| `src/routes/jobs.ts` | Fire `extractAndStore` on `done` transition |
| `src/monitor.ts` | Start `memoryBatchEmbed` worker when `MEMORY_ENABLED` |

---

## Data Models

### `memory_extraction` Table (migration 004)

```sql
CREATE TABLE IF NOT EXISTS memory_extraction (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           TEXT    NOT NULL REFERENCES jobs(id),
  workspace_id     TEXT    NOT NULL,
  extracted_at     TEXT    NOT NULL,         -- ISO 8601
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

CREATE INDEX IF NOT EXISTS idx_memext_workspace
  ON memory_extraction (workspace_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memext_pending
  ON memory_extraction (embedding_status, extracted_at)
  WHERE embedding_status = 'pending' AND deleted_at IS NULL;
```

**Design notes:**
- `embed_attempts` is separate from `embedding_status` — a row can be `failed` after exactly
  3 real submission attempts, not from pre-submission API errors.
- The `REFERENCES jobs(id)` FK ensures referential integrity; FK enforcement is already
  enabled by the SQLite adapter's WAL setup.
- The `idx_memext_pending` partial index covers the batch worker's primary query pattern
  exactly: `WHERE embedding_status = 'pending' AND deleted_at IS NULL ORDER BY extracted_at ASC LIMIT 1000`.

### `DbMemoryExtraction` Row Type (to add to `src/db/adapter.ts`)

```typescript
export type DbMemoryExtraction = {
  id: number;
  job_id: string;
  workspace_id: string;
  extracted_at: string;      // ISO 8601
  raw_text: string;
  memory_count: number;
  quality_score: number;
  embedding_status: 'pending' | 'embedded' | 'failed';
  embed_attempts: number;
  tier: 'hot' | 'cold';
  last_modified: number;     // Unix epoch ms
  deleted_at: string | null;
};
```

### Extraction Type Vocabulary

```typescript
// src/memory/extraction.ts (internal types)

type FactCategory = 'architecture' | 'error' | 'resolution' | 'procedure' | 'constraint';

type CandidateFact = {
  text: string;
  category: FactCategory;
};

type ScoredFact = CandidateFact & {
  score: number;      // weighted sum ∈ [0, 1]
  critique: string;   // scorer's explanation, used in refinement pass
};

type ExtractionResult = {
  acceptedFacts: Array<{ text: string; category: FactCategory; retainedId: string }>;
  meanQualityScore: number;
  tier: 'hot' | 'cold';
};
```

---

## Module Design

### `src/memory/extraction.ts`

**Exports:** `extractAndStore(job, db, client)`

**Internal structure:**

```typescript
// Module-level in-flight guard — shared across all calls in the process
const _inFlight = new Set<string>();

export async function extractAndStore(
  job: Job,
  db: DbAdapter,
  client: IMemoryClient,
): Promise<void> {
  // 1. In-flight guard
  if (_inFlight.has(job.id)) return;
  _inFlight.add(job.id);

  try {
    await _doExtract(job, db, client);
  } finally {
    _inFlight.delete(job.id);
  }
}
```

**`_doExtract` flow:**

1. **Read file** — `Bun.file(job.mdFile).text()`. If absent or empty: write failed row, return.
2. **Extract** — call `_callExtractor(text)` → `CandidateFact[]`. On throw: write failed row, return.
3. **Score** — call `_callScorer(facts)` → `ScoredFact[]`. On throw: write failed row, return.
4. **Refinement** — if mean score < 0.75, call `_callExtractor(text, critiques)` → new facts, re-score. One pass only.
5. **Pattern filter** — apply `GENERIC_REJECT_PATTERNS` regardless of score.
6. **Classify tier** — call `classifyTier(db, job.workspaceId)`.
7. **Dedup + retain** — for each accepted fact: `client.recall(text, scope, 1)`, check similarity, `client.retain` if not duplicate.
8. **DB upsert** — write `memory_extraction` row. On DB failure: rollback retained facts via `client.delete`, write failed row.

**Generic reject patterns (module constants):**

```typescript
const GENERIC_REJECT_PATTERNS: RegExp[] = [
  /the system has \w+/i,
  /build (is )?currently failing/i,
];
const MIN_FACT_LENGTH = 20;
const MAX_FACT_LENGTH = 500;
const QUALITY_THRESHOLD = 0.75;
const DEDUP_SIMILARITY_THRESHOLD = 0.92;
```

**LLM call strategy:**

Both the extractor and scorer calls go through `src/agent.ts`'s configured LLM client. Each
call uses a structured JSON output mode. The extractor prompt is a system+user pair; the scorer
receives the same facts array and returns a parallel array of `{ score, critique }` objects. The
caller validates that the returned array length matches the input length; a mismatch is treated
as a scorer error and triggers the fallback of accepting all facts at score 0.

**Failure row helper:**

```typescript
async function _writeFailedRow(
  db: DbAdapter,
  job: Job,
  rawText: string,
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT INTO memory_extraction
       (job_id, workspace_id, extracted_at, raw_text, memory_count,
        quality_score, embedding_status, tier, last_modified)
     VALUES (?, ?, ?, ?, 0, 0.0, 'failed', 'cold', ?)
     ON CONFLICT(job_id) DO UPDATE SET
       extracted_at     = excluded.extracted_at,
       raw_text         = excluded.raw_text,
       memory_count     = 0,
       quality_score    = 0.0,
       embedding_status = 'failed',
       last_modified    = excluded.last_modified`,
    [job.id, job.workspaceId, new Date().toISOString(), rawText, now],
  );
}
```

---

### `src/memory/embedding.ts`

**Exports:** `classifyTier(db, workspaceId)`, `embedHot(text, client)`, `VoyageBatchClient`

**`classifyTier` query:**

```sql
SELECT COUNT(*) AS cnt
FROM jobs
WHERE workspace_id = ?
  AND status IN ('done', 'reported', 'error')
  AND deleted_at IS NULL
ORDER BY timestamp DESC
LIMIT ?
```

If `cnt < MEMORY_HOT_TIER_COUNT`, the current job is hot. The query uses a `LIMIT` on the
ordering scan rather than counting all rows to keep it O(MEMORY_HOT_TIER_COUNT).

**Hot-tier Voyage call:**

```typescript
async function embedHot(text: string): Promise<number[] | null> {
  const apiKey = VOYAGE_API_KEY;
  if (!apiKey) return null;  // graceful fallback — Hindsight embeds itself

  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'voyage-3-large', input: [text] }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) return null;  // non-fatal — Hindsight will embed on recall
  const json = await res.json() as { data: Array<{ embedding: number[] }> };
  return json.data[0]?.embedding ?? null;
}
```

The returned vector is passed to `client.retain` in the extended payload if Hindsight supports
it. If Hindsight doesn't accept pre-computed vectors, the `retain` call omits the vector field
and Hindsight embeds on first recall. The local `embedding_status` is set to `embedded` in
both cases.

**`VoyageBatchClient`:**

Thin wrapper around the Voyage Batch API:
- `submit(texts: string[]): Promise<string>` — returns Voyage batch job ID
- `poll(batchId: string, timeoutMs: number): Promise<BatchResult>` — polls until done or timeout
- `BatchResult = { embeddings: number[][], failed: number[] }` — `failed` is list of indices

---

### `src/workers/memoryBatchEmbed.ts`

**Exports:** `startBatchEmbedWorker(db, client)`

**Worker loop:**

```typescript
export function startBatchEmbedWorker(db: DbAdapter, client: IMemoryClient): void {
  const INTERVAL_MS = 6 * 60 * 60 * 1_000;  // 6 hours

  async function runBatch(): Promise<void> {
    // 1. Query up to 1000 pending rows with embed_attempts < 3
    const { rows } = await db.query<DbMemoryExtraction>(
      `SELECT * FROM memory_extraction
       WHERE embedding_status = 'pending'
         AND embed_attempts < 3
         AND deleted_at IS NULL
       ORDER BY extracted_at ASC
       LIMIT 1000`,
    );

    if (rows.length === 0) {
      console.debug('[batch-embed] no pending rows');
      return;
    }

    // 2. Submit to Voyage Batch API — if this throws, exit without touching embed_attempts
    let batchId: string;
    try {
      batchId = await voyageClient.submit(rows.map(r => r.raw_text));
    } catch (err) {
      console.error('[batch-embed] Voyage batch submission failed:', err);
      return;  // do NOT increment embed_attempts
    }

    // 3. Increment embed_attempts for all submitted rows (inside transaction)
    const ids = rows.map(r => r.id);
    await db.transaction(async (tx) => {
      for (const id of ids) {
        await tx.execute(
          `UPDATE memory_extraction SET embed_attempts = embed_attempts + 1 WHERE id = ?`,
          [id],
        );
      }
    });

    // 4. Poll for completion (up to 4 hours)
    let result: BatchResult;
    try {
      result = await voyageClient.poll(batchId, 4 * 60 * 60 * 1_000);
    } catch (err) {
      console.error('[batch-embed] Voyage batch polling timed out or failed:', err);
      // Mark rows with embed_attempts >= 3 as failed; rest stay pending for next run
      await _markExhaustedAsFailed(db);
      return;
    }

    // 5. Update embedding_status based on Voyage result
    await db.transaction(async (tx) => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const status = result.failed.includes(i) ? 'failed' : 'embedded';
        await tx.execute(
          `UPDATE memory_extraction
           SET embedding_status = ?,
               last_modified = ?
           WHERE id = ?
             AND embed_attempts < 3`,
          [status, Date.now(), row.id],
        );
      }
    });

    // 6. Mark any rows that have now reached embed_attempts >= 3 as failed
    await _markExhaustedAsFailed(db);

    console.log(`[batch-embed] processed ${rows.length} rows, ${result.failed.length} failed`);
  }

  // Fire once at startup (after a short delay), then every 6 hours
  setTimeout(() => {
    runBatch().catch(err => console.error('[batch-embed] unexpected error:', err));
    setInterval(() => {
      runBatch().catch(err => console.error('[batch-embed] unexpected error:', err));
    }, INTERVAL_MS);
  }, 60_000);  // 1-minute delay to let other workers start first
}

async function _markExhaustedAsFailed(db: DbAdapter): Promise<void> {
  await db.execute(
    `UPDATE memory_extraction
     SET embedding_status = 'failed',
         last_modified = ?
     WHERE embed_attempts >= 3
       AND embedding_status = 'pending'
       AND deleted_at IS NULL`,
    [Date.now()],
  );
}
```

---

### `src/routes/memory-extraction.ts`

**Exports:** `register(router, db, client)`

**Routes:**

```
POST /api/memory/extract/:jobId    Re-trigger extraction for a single job
POST /api/memory/backfill          Queue extraction for N unprocessed jobs
```

**Request validation order for `POST /api/memory/extract/:jobId`:**

```typescript
// 1. Feature flag check first (before any DB query)
if (!MEMORY_EXTRACTION_ENABLED) {
  return new Response(
    JSON.stringify({ error: 'memory extraction disabled' }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  );
}

// 2. Job existence check
const { rows } = await db.query<DbJob>(
  'SELECT * FROM jobs WHERE id = ? AND deleted_at IS NULL',
  [jobId],
);
if (rows.length === 0) {
  return new Response(JSON.stringify({ error: 'not found' }), { status: 404, ... });
}

// 3. Run extraction (re-triggers even if a row already exists)
await extractAndStore(rows[0] as Job, db, client);

// 4. Read back the result row for the response
const { rows: resultRows } = await db.query<DbMemoryExtraction>(
  'SELECT * FROM memory_extraction WHERE job_id = ? AND deleted_at IS NULL',
  [jobId],
);
const row = resultRows[0];
return new Response(
  JSON.stringify({
    jobId,
    memoryCount: row?.memory_count ?? 0,
    qualityScore: row?.quality_score ?? 0,
  }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);
```

**`POST /api/memory/backfill` validation:**

```typescript
const body = await req.json() as { workspaceId?: unknown; limit?: unknown };

if (typeof body.workspaceId !== 'string' || body.workspaceId.trim() === '') {
  return new Response(JSON.stringify({ error: 'workspaceId required' }), { status: 400, ... });
}

// Limit validation: default 100, max 100, min 1
let limit = 100;
if (body.limit !== undefined) {
  if (!Number.isInteger(body.limit) || (body.limit as number) < 1) {
    return new Response(
      JSON.stringify({ error: 'limit must be a positive integer' }),
      { status: 400, ... },
    );
  }
  limit = Math.min(body.limit as number, 100);  // silent cap
}
```

---

### Integration: `src/routes/jobs.ts`

The existing `jobs.ts` route handler currently has no status-change awareness — it reads
files on demand. The `done` trigger needs to fire from wherever a job's status transitions to
`done`. In the current architecture, status changes are detected by the `fileWatcher` via
`DbSyncTool.syncFile` (which calls `upsertJob`).

**Design decision:** Rather than modifying `upsertJob` (which would couple DB sync to memory),
the extraction trigger is placed in `fileWatcher.ts`'s sync callback, after a successful sync,
by comparing old vs. new status. This keeps the extraction call co-located with where status
transitions are authoritatively detected.

The alternative (polling the DB for new `done` rows) is rejected because it adds latency and
complexity. The watcher fires within 500ms of a file change — this is the natural integration
point.

**Concrete change to `src/workers/fileWatcher.ts`:**

```typescript
// After syncTool.syncFile(resolvedPath, outputDir) succeeds:
if (MEMORY_EXTRACTION_ENABLED && memoryClient !== null) {
  // Query the synced job to check if it transitioned to 'done'
  const { rows } = await db.query<DbJob>(
    `SELECT * FROM jobs WHERE (md_file = ? OR log_file = ?) AND deleted_at IS NULL`,
    [resolvedPath, resolvedPath],
  );
  for (const row of rows) {
    if (row.status === 'done') {
      // Fire and forget — extraction errors are logged inside extractAndStore
      extractAndStore(jobFromDbRow(row), db, memoryClient).catch(err => {
        console.error('[file-watcher] extraction error:', err);
      });
    }
  }
}
```

`fileWatcher.ts` is updated to accept `db` and `memoryClient` as optional parameters
(matching how `startMetricsCollector` receives `db`). When `MEMORY_EXTRACTION_ENABLED=false`
or `memoryClient` is null, the block is skipped entirely.

---

## Correctness Properties

### Invariants

1. **In-flight guard is process-global** — The `_inFlight` Set in `extraction.ts` is a
   module-level singleton. Concurrent calls to `extractAndStore` with the same `job.id` always
   return early after the first. The finally block guarantees the ID is removed even on error.

2. **Quality floor enforced before network calls** — Facts failing the quality gate (score < 0.75
   after refinement) are dropped before any `client.retain` call. No low-quality fact ever
   reaches Hindsight.

3. **Batch size is hard-capped** — The SQL query in `memoryBatchEmbed.ts` uses `LIMIT 1000`
   at the database level, not in application code. The application cannot submit more than
   1 000 rows per batch regardless of how many pending rows exist.

4. **embed_attempts only increments on submission** — `embed_attempts` is incremented inside
   a transaction that runs *after* the Voyage submit call returns successfully. A pre-submission
   throw exits before the transaction, leaving all counters unchanged.

5. **Soft deletes preserved** — All queries filter `WHERE deleted_at IS NULL`. The upsert
   helper uses `ON CONFLICT(job_id) DO UPDATE` which updates the non-deleted row in place;
   it never undeletes a soft-deleted row.

6. **Rollback on DB upsert failure** — When the `memory_extraction` upsert fails after facts
   have already been retained, all retained fact IDs are deleted via `client.delete` before
   the failure row is written. The Hindsight store and the local DB are kept consistent.

### Round-Trip Properties

1. **Extraction idempotence** — Calling `extractAndStore` twice for the same job produces the
   same `memory_extraction` row (via `ON CONFLICT(job_id) DO UPDATE`) and the same set of
   memories in Hindsight (via the cosine-similarity dedup gate that rejects duplicates > 0.92).

2. **Tier classification stability** — Once a job is classified `hot` and its row is written,
   re-triggering extraction does not re-classify it. The `ON CONFLICT` upsert preserves the
   original `tier` value unless the re-trigger explicitly sets a new one.

### Bounded Operations

1. **Batch embedding: max 1 000 rows/run** — enforced by `LIMIT 1000` in SQL.
2. **Batch polling: max 4-hour wall clock** — `VoyageBatchClient.poll` uses `AbortSignal.timeout`.
3. **Backfill: max 100 jobs/request** — enforced by `Math.min(limit, 100)` with floor at 1.
4. **Dedup recall: limit 1** — Each dedup check calls `client.recall(text, scope, 1)` — a
   single result is all that's needed to determine similarity.

---

## Error Handling

### Failure Modes and Recovery

**Missing or empty `.md` output file**
- **Detection:** `Bun.file(job.mdFile).exists()` returns false, or text length is 0.
- **Response:** Log WARN. Write `memory_extraction` row with `embedding_status='failed'`,
  `quality_score=0`, `memory_count=0`. Return without LLM calls.
- **Recovery:** Developer re-triggers via `POST /api/memory/extract/:jobId` after the file
  appears. The backfill endpoint skips jobs with an existing (even failed) row — to re-run
  those specifically, use the single-job re-trigger route.

**LLM extractor or scorer call throws**
- **Detection:** Either `_callExtractor` or `_callScorer` throws.
- **Response:** Log ERROR with job ID and error message. Write failed row. Do not re-throw.
- **Recovery:** Manual re-trigger via `POST /api/memory/extract/:jobId`.

**`client.recall` throws during deduplication**
- **Detection:** The dedup check's `client.recall` call throws.
- **Response:** Log WARN. Reject that individual fact (do not store). Continue with remaining
  facts. The circuit breaker in Phase 6.1 may already be handling the underlying connection
  failure.
- **Recovery:** Automatic — if the circuit closes, subsequent facts in later extractions will
  dedup normally.

**`client.retain` throws for an individual fact**
- **Detection:** `client.retain(text, scope)` throws.
- **Response:** Log WARN with fact text excerpt. Continue with remaining facts. The circuit
  breaker handles Hindsight-level failures; a single retain failure is not treated as a
  full extraction failure unless all facts fail.
- **Recovery:** The retry queue (Phase 6.1) catches retain failures when the circuit is open.
  When the circuit closes, queued retains are drained.

**DB upsert failure after facts retained**
- **Detection:** `db.execute(INSERT INTO memory_extraction ...)` throws.
- **Response:** Rollback all retained facts via `client.delete(id)` for each `retainedId`.
  Then write a failed row. Log ERROR.
- **Recovery:** Manual re-trigger. The failed row's `memory_count=0` signals the state.

**Voyage Batch API submission throws**
- **Detection:** `voyageClient.submit(texts)` throws.
- **Response:** Log ERROR. Exit the batch run. Do NOT increment `embed_attempts` for any row.
- **Recovery:** Automatic — next 6-hour tick retries the same rows.

**Voyage Batch API polling timeout (> 4 hours)**
- **Detection:** `voyageClient.poll` rejects after `AbortSignal.timeout(4h)`.
- **Response:** Log WARN with Voyage batch ID. Call `_markExhaustedAsFailed` to mark rows
  with `embed_attempts >= 3` as `failed`. Rows with fewer attempts remain `pending` for next
  run.
- **Recovery:** Next batch run retries remaining `pending` rows. Rows with `embed_attempts=3`
  are permanently `failed` — manual intervention required.
