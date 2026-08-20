# Requirements Document

## Introduction

Phase 6.3 connects the memory store to the agent execution path. Before a job runs, relevant
memories are recalled and injected into the agent's system prompt within a configurable token
budget. After the job completes, any facts the agent explicitly marks with a `MEMORY:` prefix
in its output are stored as new memories. This is the phase where accumulated knowledge
becomes observable agent improvement.

**Prerequisite:** Phase 6.2 complete. `extractAndStore`, `EmbeddingRouter`, and
`memory_extraction` table are available.

---

## Glossary

| Term | Definition |
|------|-----------|
| **Context assembly** | The process of recalling relevant memories and formatting them for injection into an agent system prompt. |
| **Token budget** | `MEMORY_CONTEXT_TOKEN_BUDGET` — the maximum number of tokens the injected memory block may consume. |
| **MEMORY: marker** | A line in agent output beginning with `MEMORY:` followed by a fact string. The system stores these as new memories automatically. |
| **assembleContext** | The main function in `src/memory/assembly.ts` that orchestrates recall, token counting, and prompt building. |

---

## Requirements

### Requirement 1: Context Assembly Function

**User Story:** As a developer, I want the agent to receive the most relevant past memories
before it starts working so that it avoids repeating known mistakes and applies proven patterns.

#### Acceptance Criteria

1. `src/memory/assembly.ts` exports `assembleContext(job: Job, client: IMemoryClient,
   config: MemoryAssemblyConfig): Promise<string>` which returns a formatted memory block
   or an empty string when no memories are available.
2. The recall query is constructed as `"{job.name} {job.type}"` with the scope set to
   `scopeFromJob(job)`.
3. `client.recall` is called with `limit = MEMORY_MAX_CONTEXT_MEMORIES * 2` to get a
   larger candidate set before token-budget trimming.
4. Memories are added to the output block in descending relevance order until adding the
   next memory would exceed `MEMORY_CONTEXT_TOKEN_BUDGET`. Trimmed memories are dropped
   silently; a DEBUG log records how many were dropped.
5. The returned string has the exact format:
   ```
   ## Relevant Past Context
   - {memory.text}
   - {memory.text}
   ```
   with no trailing newline.
6. If no memories pass the budget filter, an empty string is returned (not the heading alone).
7. Token counting uses a simple approximation: `Math.ceil(text.length / 4)` characters per
   token. This avoids a tokenizer dependency while remaining conservative.
8. WHILE processing memories, the function SHALL continue iterating through all candidates
   even when the elapsed time exceeds the 500 ms p95 target, completing the full token-budget
   pass before returning.

### Requirement 2: Agent Integration

**User Story:** As a developer, I want memory context injected automatically before every
agent job so that I do not need to manually manage context between sessions.

#### Acceptance Criteria

1. `src/agent.ts` SHALL call `assembleContext` before constructing the final system prompt,
   and the system prompt construction SHALL NOT proceed unless `assembleContext` has been
   called and its result is available (empty string or memory block).
2. The memory block is appended after the base system prompt content and before any
   job-specific instructions.
3. When `MEMORY_AUTO_INJECT=false`, `assembleContext` is still called and its result logged
   at DEBUG level, but it is not appended to the prompt.
4. The system SHALL always call `assembleContext` regardless of circuit breaker state. IF the
   circuit breaker is Open, `assembleContext` SHALL catch the fallback empty result, log
   `WARN: memory circuit open — skipping injection`, and continue without memory.
5. WHEN `MEMORY_ENABLED=false`, the system SHALL skip `assembleContext` entirely — no call, no log, and no stub execution. WHEN `MEMORY_ENABLED=true` AND `MEMORY_AUTO_INJECT=false`, `assembleContext` SHALL still be called and its result logged at DEBUG level, but it SHALL NOT be appended to the prompt (covered in AC3). `assembleContext` SHALL only be invoked when both `MEMORY_ENABLED=true` AND `MEMORY_AUTO_INJECT=true`.
6. The total time added to agent startup by memory operations must not exceed 500 ms at p95.
   This is enforced by a 450 ms timeout on the `assembleContext` call; if exceeded, the call
   is abandoned and the agent runs without memory context.

### Requirement 3: MEMORY Marker Extraction

**User Story:** As a developer, I want the agent to be able to explicitly flag new learnings
in its output so that high-confidence agent-generated insights are persisted for future sessions.

#### Acceptance Criteria

1. After a job completes, `src/routes/jobs.ts` scans the job's output for lines matching
   `/^MEMORY:\s*(.+)$/m` (case-insensitive).
2. Each matched fact string is trimmed and validated: minimum 20 characters, maximum 500
   characters, must not match the generic rejection patterns from Phase 6.2 Requirement 2.6.
3. Valid facts are stored via `client.retain(fact, scopeFromJob(job))` with `runId` scope.
4. Stored marker-facts are recorded in the `memory_extraction` table with `tier = 'hot'`
   and `quality_score = 1.0` (agent-explicit facts are assumed high quality).
5. If `client.retain` fails for a marker fact, the error is logged and the retry queue is
   used — the failure does not affect the job's own completion flow.
6. The scan is skipped entirely when `MEMORY_EXTRACTION_ENABLED=false`.
7. IF a fact passes the pre-storage validation in criterion 2 but arrives at the storage
   layer in an invalid state, the storage layer SHALL re-validate and reject the fact,
   logging the rejection at WARN level without propagating an error to the caller.

### Requirement 4: Diagnostic Route

**User Story:** As a developer, I want a diagnostic endpoint that shows what memories would
be injected for a given job so that I can understand and debug the context assembly without
running a full agent execution.

#### Acceptance Criteria

1. `POST /api/memory/inject-test` accepts `{ jobId: string }` and returns
   `{ memoryCount, tokenCount, memories: Memory[], dropped: number, circuitState: string }`.
2. WHERE the job exists and is in a valid state, the endpoint SHALL perform the same `assembleContext` recall and token-budget pass as the real agent path. The endpoint SHALL actively prevent any storage operations by passing a read-only memory client that throws on any write method call, ensuring no state is modified during diagnostic execution.
3. IF the job does not exist, the endpoint SHALL return 404 immediately without invoking `assembleContext`. IF the job exists but is in an invalid state for memory assembly (e.g., job is still running or has a failed status), the endpoint SHALL return 400 without invoking `assembleContext`.
4. Returns 503 if `MEMORY_ENABLED=false`.
5. The response includes `assemblyMs` — the wall-clock time taken for the recall and
   token-budget pass.
