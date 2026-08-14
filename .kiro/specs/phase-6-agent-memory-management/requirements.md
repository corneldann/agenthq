# Requirements Document

## Introduction

Phase 6 adds a persistent, cross-session memory layer to AgentHQ. Agents currently re-learn project
context on every session — there is no retention of architectural decisions, debugging patterns, or
error resolutions. This phase transforms AgentHQ from a monitoring dashboard into a cognitive
observability platform where agents accumulate and reuse knowledge over time.

The memory backend is **Hindsight** (MIT licence, self-hosted, 94.6% LongMemEval accuracy — 2×
better than Mem0 on independent benchmarks). All memory operations are accessed through an
`IMemoryClient` port interface so the backend can be swapped without touching business logic.

Phase 6 is broken into five sequential sub-phases:

| Sub-phase | Scope | Spec |
|-----------|-------|------|
| 6.1 | Memory infrastructure, `IMemoryClient` port, circuit breaker | `.kiro/specs/phase-6.1-memory-infrastructure/` |
| 6.2 | Automatic extraction pipeline, quality gating, hybrid embedding tiers | `.kiro/specs/phase-6.2-memory-extraction/` |
| 6.3 | Context assembly — inject memories into agent prompts | `.kiro/specs/phase-6.3-context-assembly/` |
| 6.4 | Memory browser dashboard — search, timeline, CRUD | `.kiro/specs/phase-6.4-memory-browser/` |
| 6.5 | Export/import, memory analytics, decay, graduation to steering | `.kiro/specs/phase-6.5-export-advanced/` |

**Prerequisite:** Phase 5 (DB layer, WebSocket layer, analytics layer) must be complete before
Phase 6 begins. The `memory_extraction` table added in Phase 6.2 requires the Phase 5 `DbAdapter`.

---

## Glossary

| Term | Definition |
|------|-----------|
| **Hindsight** | Open-source MCP memory server (MIT). Self-hosted via Docker. Three operations: `retain`, `recall`, `reflect`. |
| **IMemoryClient** | TypeScript port interface abstracting all memory backend operations. Enables Hindsight ↔ Mem0 ↔ Zep swap. |
| **Memory scope** | Metadata that scopes a memory to a specific context: `user_id`, `workspace_id`, `agent_id`, `run_id`, `chain_id`. |
| **Episodic memory** | What happened — execution history, errors, resolutions, per-job facts. |
| **Semantic memory** | What is known — architectural decisions, constraints, tech stack facts per workspace. |
| **Procedural memory** | How things are done — repeatable workflows, debugging patterns, fix sequences. |
| **Extraction pipeline** | The process of reading completed job `.md`/`.log` files and deriving structured memory facts. |
| **Quality gate** | The evaluator-optimizer loop (from `agentic-eval` skill) that scores extracted facts and rejects low-quality ones. |
| **Hot tier** | Most-recent 100 jobs — embedded immediately on completion for sub-second search. |
| **Cold tier** | Historical jobs beyond the hot window — stored as raw text and batch-embedded every 6 hours. |
| **Circuit breaker** | 3-state fault-tolerance mechanism (Closed → Open → Half-Open) that prevents cascading failures when the memory service is unavailable. |
| **Context assembly** | Retrieving and injecting the top-N relevant memories into an agent's system prompt before execution. |
| **Memory browser** | Dashboard UI page for searching, viewing, editing, and deleting memories. |
| **Memory graduation** | Promoting high-confidence, multi-session facts from episodic memory into steering files (procedural tier). |

---

## Requirements

### Requirement 1: Memory Infrastructure

**User Story:** As a developer using AgentHQ, I want the system to connect to a self-hosted
Hindsight memory service so that agent learnings can be stored and retrieved without sending data
to external services.

#### Acceptance Criteria

1. `MEMORY_ENABLED=true` in `.env` activates the memory layer; `false` (default) leaves all
   existing behaviour unchanged.
2. `HINDSIGHT_URL` env var configures the Hindsight base URL (default `http://localhost:3100`).
3. An `IMemoryClient` TypeScript interface is defined in `src/memory/types.ts` with at minimum:
   `retain(text, scope)`, `recall(query, scope, limit)`, `reflect(topic, scope)`, `delete(id)`.
4. A `HindsightAdapter` in `src/memory/hindsight.ts` implements `IMemoryClient` using HTTP calls
   to the Hindsight MCP endpoint.
5. A `MemoryCircuitBreaker` in `src/memory/circuit-breaker.ts` wraps any `IMemoryClient` with
   3-state logic (Closed, Open, Half-Open). It trips after 3 consecutive failures, enters Half-Open
   after a 30-second timeout, and closes again after 2 consecutive successes.
6. When the circuit is Open, all memory operations return safe fallbacks: `recall` returns `[]`,
   `retain` queues the write to a retry file, `reflect` returns `null`.
7. A `GET /api/memory/circuit-breaker` route returns the current circuit state, failure count,
   last-failure timestamp, and total-fallback count.
8. All memory operations are no-ops (pass-through) when `MEMORY_ENABLED=false`.
9. The monitor startup log includes a line confirming memory is enabled/disabled and the backend URL.

### Requirement 2: Automatic Memory Extraction

**User Story:** As a developer, I want agent job completions to automatically generate structured
memory facts so that future sessions benefit from past work without manual intervention.

#### Acceptance Criteria

1. When a job transitions to `done` status, the extraction pipeline reads its `.md` output file and
   extracts candidate facts via an LLM call.
2. Each extracted fact is scored by the quality gate using the rubric: accuracy (weight 0.4),
   relevance (0.3), specificity (0.3). Facts scoring below 0.75 are discarded.
3. If the overall extraction batch scores below 0.75, a refinement pass is triggered using the
   evaluator's critique before storing anything.
4. Rejected generic patterns (e.g. "the system has modules", "build currently failing") are never
   stored.
5. Accepted patterns (e.g. verified constraints, confirmed fix sequences, architecture facts) are
   stored with full scope metadata: `workspace_id`, `chain_id`, `run_id`.
6. Each extraction result is recorded in a `memory_extraction` DB table with columns: `job_id`,
   `workspace_id`, `extracted_at`, `raw_text`, `memory_count`, `quality_score`,
   `embedding_status` (`pending` | `embedded` | `failed`), `tier` (`hot` | `cold`).
7. The most-recent 100 jobs are classified as **hot**: their embeddings are generated immediately
   (real-time, Voyage-3-large). All older jobs are **cold**: raw text is stored with
   `embedding_status = 'pending'` and embedded in the next batch run.
8. A batch embedding worker runs every 6 hours, picks up all `pending` cold records in batches
   of 1 000, sends them to the Voyage Batch API, and updates `embedding_status` to `embedded`.
9. Duplicate memory detection: before storing a fact, a semantic similarity check against
   existing memories for the same scope rejects duplicates with cosine similarity > 0.92.
10. Extraction is skipped entirely when `MEMORY_EXTRACTION_ENABLED=false`.

### Requirement 3: Context Assembly and Agent Integration

**User Story:** As a developer, I want the agent to receive relevant past memories as context
before it executes a job so that it avoids repeating known mistakes and leverages prior solutions.

#### Acceptance Criteria

1. Before an agent job executes, the system calls `recall` with the job name and type as the
   query, scoped to the job's `workspace_id` and `chain_id`.
2. At most `MEMORY_MAX_CONTEXT_MEMORIES` memories (default 10, configurable) are injected.
3. The injection respects a token budget: memories are added in descending relevance order until
   the next memory would exceed the configured `MEMORY_CONTEXT_TOKEN_BUDGET` (default 2 000
   tokens). Memories that do not fit are silently dropped.
4. Injected memories are appended to the agent system prompt under a `## Relevant Past Context`
   heading with one bullet per memory.
5. When `MEMORY_AUTO_INJECT=false`, no memories are injected but the recall still happens (logged
   only).
6. After a job completes, any new insights the agent explicitly flags (via a structured `MEMORY:`
   marker in its output) are stored as memories with `run_id` scope.
7. Memory injection latency must not add more than 500 ms to agent startup time at p95.
8. When the circuit breaker is Open, context assembly is skipped gracefully — the agent runs
   without memory context and a warning is logged.

### Requirement 4: Memory Browser Dashboard

**User Story:** As a developer, I want a memory browser page in the AgentHQ dashboard so that I
can inspect, search, edit, and delete stored memories.

#### Acceptance Criteria

1. A new "Memory" page is accessible from the dashboard sidebar, navigable via `G → M` keyboard
   shortcut.
2. The page shows a paginated list of memories (50 per page, cursor-based) with: text excerpt,
   scope tags, timestamp, quality score.
3. A search input performs semantic search via `GET /api/memory/search?q=...&workspaceId=...`
   and renders results within 200 ms of the last keystroke (debounced 300 ms).
4. Scope filters allow narrowing by workspace, chain, agent, or run.
5. Each memory row has an Edit button (inline textarea) and Delete button with confirmation.
6. A "Reflect" panel shows Hindsight's synthesised reflection on a selected topic for the
   current workspace.
7. Real-time updates: when a new memory is stored (via WebSocket `memory-update` event), the
   list refreshes without a full page reload.
8. The memory graph view (entity relationships) is keyboard-navigable: `Arrow` keys move between
   nodes, `Enter` expands a node, `Escape` collapses.
9. A screen-reader fallback table is rendered alongside any canvas/SVG graph, listing all
   entities and their relations, hidden visually but exposed to assistive technology.
10. All colour choices in the memory browser meet WCAG 2.1 AA contrast ratios (minimum 4.5:1
    for text, 3:1 for UI components).

### Requirement 5: Memory Export, Import, and Advanced Features

**User Story:** As a developer, I want to export, import, and manage the lifecycle of stored
memories so that I can back up knowledge, onboard new workspaces, and keep the memory store clean.

#### Acceptance Criteria

1. `GET /api/memory/export?workspaceId=...&format=json|markdown|csv` streams the full memory
   set for the workspace in the requested format.
2. `POST /api/memory/import` accepts a JSON export file, validates its schema, deduplicates
   against existing memories, and bulk-inserts new ones.
3. Memory decay: a configurable `MEMORY_DECAY_DAYS` (default 90) marks memories as `stale` when
   they have not been retrieved in that period. Stale memories are excluded from recall by default
   but remain in storage.
4. Memory graduation: a `POST /api/memory/graduate` endpoint takes a memory `id` and writes it
   as a new entry in the workspace's steering file `memory-learnings.md`, formatted as a
   `## Learned` section with date and source chain.
5. Memory analytics endpoint `GET /api/memory/analytics?workspaceId=...` returns: total count,
   stale count, hot/cold breakdown, top-10 most-retrieved memories, extraction quality histogram.
6. Export files are validated before download — malformed memories are omitted with a warning
   count in the response headers.
7. Import rejects any record containing path-traversal sequences in its metadata fields.
8. A `POST /api/memory/consolidate` endpoint triggers the Auto Dream consolidation pattern:
   merges duplicates, supersedes contradictions, flags stale facts, targets ≤ 50 active entities.
