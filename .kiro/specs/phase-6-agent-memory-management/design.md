# Design Document

## Overview

Phase 6 — Agent Memory Management adds a persistent, cross-session memory layer to AgentHQ.
The system connects to a self-hosted **Hindsight** MCP server, extracts structured facts from
completed agent jobs, assembles relevant context before each execution, and exposes a memory
browser in the dashboard.

All memory operations flow through an `IMemoryClient` port interface, isolating business logic
from the Hindsight implementation. A 3-state circuit breaker prevents memory-service failures
from affecting agent execution. A hybrid 3-tier embedding strategy (query cache → hot real-time
→ cold batch) delivers 45% cost savings over all-real-time embedding.

The five sub-phases are strictly sequential — each builds on the DB schema additions and
interfaces introduced by the prior one.

---

## Architecture

### Layer Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     AgentHQ Dashboard SPA                        │
│  (Memory page: timeline · search · graph · CRUD · export)        │
└───────────────────────┬─────────────────────────────────────────┘
                        │ HTTP + WebSocket
┌───────────────────────▼─────────────────────────────────────────┐
│                     AgentHQ Monitor (Bun)                        │
│                                                                  │
│  routes/memory.ts          routes/memory-export.ts              │
│  (/api/memory/*)           (/api/memory/export, /import)         │
│                                                                  │
│  src/memory/                                                     │
│  ├── types.ts        IMemoryClient port + domain types           │
│  ├── client.ts       factory — returns circuit-wrapped adapter   │
│  ├── hindsight.ts    HindsightAdapter implements IMemoryClient   │
│  ├── circuit-breaker.ts  3-state breaker (Closed/Open/Half-Open) │
│  ├── retry-queue.ts  file-backed queue for failed writes         │
│  ├── scopes.ts       scope resolution (Job → MemoryScope)        │
│  ├── extraction.ts   extraction pipeline + quality gate          │
│  ├── embedding.ts    hot/cold tier routing + Voyage API wrapper  │
│  ├── assembly.ts     context assembly — recall + token budget     │
│  ├── export.ts       JSON/Markdown/CSV formatter                 │
│  └── analytics.ts    memory usage analytics                      │
│                                                                  │
│  workers/memoryBatchEmbed.ts   6-hour cold-tier batch worker     │
│  workers/memoryRetry.ts        retry-queue drain worker          │
└───────────────────────┬─────────────────────────────────────────┘
                        │ HTTP (MCP protocol)
┌───────────────────────▼─────────────────────────────────────────┐
│              Hindsight MCP Server  (Docker, port 3100)           │
│              retain · recall · reflect                           │
│              MIT licence · self-hosted · zero external deps      │
└─────────────────────────────────────────────────────────────────┘
```

### Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| `src/memory/types.ts` | `IMemoryClient`, `Memory`, `MemoryScope`, `CircuitState`, all domain types |
| `src/memory/hindsight.ts` | HTTP client to Hindsight MCP — implements `IMemoryClient` |
| `src/memory/circuit-breaker.ts` | Wraps `IMemoryClient`; 3-state FSM; exposes metrics |
| `src/memory/retry-queue.ts` | JSONL file on disk; drains on worker tick |
| `src/memory/scopes.ts` | Maps `Job` / `Chain` / `SessionState` → `MemoryScope` |
| `src/memory/extraction.ts` | LLM extract → quality-gate → dedup → `IMemoryClient.retain` |
| `src/memory/embedding.ts` | Tier classification; Voyage API calls; batch job polling |
| `src/memory/assembly.ts` | `recall` → token-count → inject into system prompt |
| `src/memory/export.ts` | JSON / Markdown / CSV serialisers |
| `src/memory/analytics.ts` | Aggregates `memory_extraction` rows into analytics shape |
| `src/workers/memoryBatchEmbed.ts` | `setInterval` every 6 h; processes `pending` cold rows |
| `src/workers/memoryRetry.ts` | Drains retry queue every 5 min; re-attempts failed writes |
| `src/routes/memory.ts` | REST routes: search, CRUD, reflect, circuit-breaker status |
| `src/routes/memory-export.ts` | Export and import routes |

### Integration Points with Existing Code

| Existing file | Change |
|--------------|--------|
| `src/monitor.ts` | Import and start `memoryBatchEmbed` and `memoryRetry` workers when `MEMORY_ENABLED` |
| `src/constants.ts` | Add `MEMORY_ENABLED`, `HINDSIGHT_URL`, `MEMORY_EXTRACTION_ENABLED`, `MEMORY_AUTO_INJECT`, `MEMORY_MAX_CONTEXT_MEMORIES`, `MEMORY_CONTEXT_TOKEN_BUDGET`, `MEMORY_DECAY_DAYS` |
| `src/types.ts` | No changes — memory types live in `src/memory/types.ts` |
| `src/agent.ts` | Call `assembly.ts` before execution; store `MEMORY:` markers after |
| `src/routes/jobs.ts` | Trigger extraction pipeline on job `done` transition |
| `src/db/migrations.ts` | Add `migrations/004_memory_extraction.sql` |
| `src/dashboard/main.ts` | Register Memory page; add `G → M` shortcut |

---

## Data Models

### `IMemoryClient` Port Interface

```typescript
// src/memory/types.ts

export interface MemoryScope {
  workspaceId: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  chainId?: string;
}

export interface Memory {
  id: string;
  text: string;
  scope: MemoryScope;
  qualityScore: number;
  createdAt: string;        // ISO 8601
  lastRetrievedAt: string | null;
  retrievalCount: number;
  tier: 'hot' | 'cold';
  embeddingStatus: 'pending' | 'embedded' | 'failed';
}

export interface IMemoryClient {
  retain(text: string, scope: MemoryScope): Promise<string>;  // returns memory id
  recall(query: string, scope: MemoryScope, limit: number): Promise<Memory[]>;
  reflect(topic: string, scope: MemoryScope): Promise<string | null>;
  delete(id: string): Promise<void>;
}
```

### `CircuitBreakerMetrics` Shape (for `GET /api/memory/circuit-breaker`)

```typescript
export interface CircuitBreakerMetrics {
  state: 'closed' | 'open' | 'half_open';
  failureCount: number;
  successCount: number;
  lastFailureTime: string | null;   // ISO 8601
  nextProbeTime: string | null;     // ISO 8601 — set when state=open
  totalCalls: number;
  totalFailures: number;
  totalFallbacks: number;
}
```

### Database — Migration 004

```sql
-- migrations/004_memory_extraction.sql

CREATE TABLE IF NOT EXISTS memory_extraction (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT    NOT NULL REFERENCES jobs(id),
  workspace_id    TEXT    NOT NULL,
  extracted_at    TEXT    NOT NULL,   -- ISO 8601
  raw_text        TEXT    NOT NULL,
  memory_count    INTEGER NOT NULL DEFAULT 0,
  quality_score   REAL    NOT NULL DEFAULT 0.0,
  embedding_status TEXT   NOT NULL DEFAULT 'pending'
                          CHECK (embedding_status IN ('pending','embedded','failed')),
  tier            TEXT    NOT NULL DEFAULT 'cold'
                          CHECK (tier IN ('hot','cold')),
  last_modified   INTEGER NOT NULL,
  deleted_at      TEXT    DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_memext_workspace
  ON memory_extraction (workspace_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memext_pending
  ON memory_extraction (embedding_status, extracted_at)
  WHERE embedding_status = 'pending' AND deleted_at IS NULL;
```

### Retry Queue (file-backed)

```
data/memory-retry-queue.jsonl   -- one JSON object per line
```

Each line:
```typescript
{ id: string; text: string; scope: MemoryScope; queuedAt: string; attempts: number }
```

Maximum 1 000 queued writes. Entries older than 24 hours or with `attempts >= 5` are discarded
on the next drain pass.

---

## Correctness Properties

### Invariants

1. **Circuit breaker state is monotonically safe** — A breaker in `open` state never makes calls
   to the memory service. Only the Half-Open probe path can call through, and only one probe at
   a time.
2. **Memory scope isolation** — `recall` results for workspace A never include memories stored
   with `workspaceId = B`. The Hindsight adapter passes `workspace_id` on every call.
3. **Extraction quality floor** — No fact with `qualityScore < 0.75` is passed to `retain`.
   The quality-gate is applied before any network call to Hindsight.
4. **Token budget respected** — The context assembly loop halts when adding the next memory
   would exceed `MEMORY_CONTEXT_TOKEN_BUDGET`. The assembled context is always within budget.
5. **Soft deletes only** — No DB row in `memory_extraction` is hard-deleted. `deleted_at` is
   set; queries always filter `WHERE deleted_at IS NULL`.

### Round-Trip Properties

1. **Export → Import identity** — `import(export(memories))` produces the same logical memory
   set (ignoring auto-generated IDs and timestamps). Duplicate detection ensures no double-insert.
2. **Scope round-trip** — `scopes.fromJob(job)` → `scopes.toMemoryScope()` → stored → retrieved
   by the same job's `workspaceId` and `chainId` produces the same scope.

### Bounded Operations

1. **Batch embedding size** — Cold-tier batch worker processes at most 1 000 rows per run to
   avoid Voyage API rate limits and excessive memory allocation.
2. **Retry queue size** — The retry queue is capped at 1 000 entries; new entries beyond the cap
   are logged and discarded rather than growing unboundedly.
3. **Context injection count** — At most `MEMORY_MAX_CONTEXT_MEMORIES` (default 10) memories are
   ever injected into a single agent prompt, regardless of recall result size.
4. **Export pagination** — Export streams in chunks of 500 memories to avoid loading the full
   corpus into memory at once.

---

## Error Handling

### Failure Modes and Recovery

**Hindsight service unreachable**
- **Detection:** HTTP request to `HINDSIGHT_URL` throws or times out (5 s timeout per call).
- **Response:** Circuit breaker records the failure. After 3 consecutive failures, state
  transitions to Open. All subsequent calls return fallbacks immediately without hitting the
  network.
- **Recovery:** After 30 seconds, circuit enters Half-Open and allows one probe request. Two
  consecutive probe successes close the circuit and restore normal operation.

**Extraction LLM call fails**
- **Detection:** The LLM API call in `extraction.ts` throws or returns malformed JSON.
- **Response:** The extraction for that job is skipped; a `memory_extraction` row is written
  with `quality_score = 0`, `memory_count = 0`, `embedding_status = 'failed'`.
- **Recovery:** No automatic retry. The developer can re-trigger extraction via
  `POST /api/memory/extract/:jobId`.

**Voyage Batch API timeout**
- **Detection:** The batch job polling loop exceeds a 4-hour wall-clock timeout.
- **Response:** All `pending` rows in the batch are marked `embedding_status = 'failed'`. A
  warning is logged with the Voyage batch job ID for manual inspection.
- **Recovery:** The next batch worker run (6 hours later) picks up `failed` rows and retries
  them as a new batch (up to 3 total attempts per row, tracked in a separate `embed_attempts`
  column).

**DB migration failure (004)**
- **Detection:** `runMigrations()` throws during monitor startup.
- **Response:** Monitor logs the error and exits with code 1, consistent with Phase 5.1
  migration-failure behaviour. Memory features do not degrade — the whole monitor refuses to
  start with a clear message.
- **Recovery:** Fix the migration SQL, restart the monitor.

**Token budget exceeded during assembly**
- **Detection:** Running token count exceeds `MEMORY_CONTEXT_TOKEN_BUDGET` before all top-N
  memories are appended.
- **Response:** Remaining memories are silently dropped. The assembled prompt is used as-is.
  No error is thrown; a debug-level log records how many memories were dropped and why.
- **Recovery:** Developer can raise `MEMORY_CONTEXT_TOKEN_BUDGET` in `.env`.
