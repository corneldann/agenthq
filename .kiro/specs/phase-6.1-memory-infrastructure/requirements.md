# Requirements Document

## Introduction

Phase 6.1 lays the foundation for all memory features. It introduces the `IMemoryClient` port
interface, the `HindsightAdapter` that implements it, the 3-state circuit breaker that protects
agent execution when the memory service is unavailable, and the retry queue for failed writes.
No extraction or injection happens in this sub-phase — this is purely the plumbing layer.

**Prerequisite:** Phase 5 (DB layer, WebSocket, analytics) complete. `DbAdapter` available.

---

## Glossary

| Term | Definition |
|------|-----------|
| **IMemoryClient** | TypeScript port interface: `retain`, `recall`, `reflect`, `delete`. |
| **HindsightAdapter** | HTTP client to Hindsight MCP server implementing `IMemoryClient`. |
| **MemoryCircuitBreaker** | Wraps any `IMemoryClient`; 3-state FSM protecting against service failures. |
| **RetryQueue** | JSONL file-backed queue for `retain` calls that failed while the circuit was Open. |
| **MemoryScope** | `{ workspaceId, userId?, agentId?, runId?, chainId? }` — scoping metadata on every memory. |
| **MEMORY_ENABLED** | Feature flag; all memory code is a no-op when false. |

---

## Requirements

### Requirement 1: Feature Flag and Configuration

**User Story:** As a developer, I want to enable or disable the memory layer via environment
variables so that existing AgentHQ deployments continue working without any changes.

#### Acceptance Criteria

1. A new `MEMORY_ENABLED` env var (default `false`) controls whether the memory layer is active.
   When `false`, all imports from `src/memory/` resolve to no-op stubs that return immediately.
2. `HINDSIGHT_URL` (default `http://localhost:3100`) sets the Hindsight base URL.
3. `MEMORY_EXTRACTION_ENABLED` (default `false`) guards extraction specifically; can be disabled
   independently of `MEMORY_ENABLED`.
4. `MEMORY_AUTO_INJECT` (default `false`) guards context assembly injection.
5. `MEMORY_MAX_CONTEXT_MEMORIES` (default `10`) sets the injection cap, parsed as an integer.
6. `MEMORY_CONTEXT_TOKEN_BUDGET` (default `2000`) sets the token injection budget.
7. `MEMORY_DECAY_DAYS` (default `90`) sets the staleness window for memory decay.
8. All new constants are exported from `src/constants.ts` alongside existing constants.
9. `.env.example` is updated with all seven new variables, each with a comment explaining
   its purpose and the default value.
10. Monitor startup prints a single line: `Memory: enabled (hindsight @ http://localhost:3100)`
    or `Memory: disabled` depending on `MEMORY_ENABLED`.

### Requirement 2: IMemoryClient Port Interface

**User Story:** As a developer, I want a stable TypeScript interface for memory operations so
that the Hindsight backend can be swapped for Mem0, Zep, or a test double without changing any
call sites.

#### Acceptance Criteria

1. `src/memory/types.ts` exports `IMemoryClient`, `Memory`, `MemoryScope`,
   `CircuitState`, `CircuitBreakerMetrics`, and `RetryQueueEntry`.
2. `IMemoryClient` has exactly four methods: `retain`, `recall`, `reflect`, `delete` —
   matching the Hindsight MCP operations.
3. `retain(text: string, scope: MemoryScope): Promise<string>` returns the stored memory ID.
4. `recall(query: string, scope: MemoryScope, limit: number): Promise<Memory[]>` returns
   memories ordered by descending relevance.
5. `reflect(topic: string, scope: MemoryScope): Promise<string | null>` returns a synthesised
   reflection string or `null` if none available.
6. `delete(id: string): Promise<void>` removes a memory by ID.
7. `MemoryScope` has `workspaceId: string` as the only required field; all other scope
   dimensions are optional.
8. `Memory` includes `id`, `text`, `scope`, `qualityScore`, `createdAt`,
   `lastRetrievedAt`, `retrievalCount`, `tier`, and `embeddingStatus`.
9. The file contains only type/interface declarations — no runtime logic, no imports with
   side effects.

### Requirement 3: HindsightAdapter

**User Story:** As a developer, I want an implementation of `IMemoryClient` that communicates
with the Hindsight MCP server so that memory operations are persisted durably.

#### Acceptance Criteria

1. `src/memory/hindsight.ts` exports `HindsightAdapter implements IMemoryClient`.
2. Each method sends an HTTP POST to `{HINDSIGHT_URL}/mcp` with the appropriate MCP tool
   call payload and parses the response.
3. All HTTP calls use a 5-second timeout; a timeout throws a `MemoryTimeoutError`.
4. HTTP 4xx responses throw a `MemoryClientError` with the status code and body included.
5. WHERE the adapter receives an HTTP response with a 1xx informational status code, THE
   HindsightAdapter SHALL throw a `MemoryServiceError` with the status code included, treating
   it as a server-side protocol violation.
6. HTTP 5xx responses throw a `MemoryServiceError` to allow the circuit breaker to distinguish
   service failures from client errors.
7. All thrown errors are typed (not `Error` base class) so the circuit breaker can inspect
   the type when counting failures.
8. The adapter accepts `baseUrl` as a constructor argument (not read from `process.env`
   directly) so it can be instantiated with a test URL in tests.
9. No logic beyond HTTP serialisation/deserialisation lives in this file — scope mapping,
   quality gating, and retry logic belong in other modules.

### Requirement 4: MemoryCircuitBreaker

**User Story:** As a developer, I want a circuit breaker wrapping every memory operation so
that a Hindsight outage never crashes or stalls an agent job.

#### Acceptance Criteria

1. `src/memory/circuit-breaker.ts` exports `MemoryCircuitBreaker` which implements
   `IMemoryClient` and wraps another `IMemoryClient`.
2. Initial state is `closed`. The breaker counts consecutive failures (HTTP 5xx,
   `MemoryServiceError`, network errors). After 3 consecutive failures, state transitions
   to `open`.
3. HTTP 4xx (`MemoryClientError`) and `MemoryTimeoutError` do not increment the failure
   counter — those are caller errors, not service failures.
4. In `open` state all calls return safe fallbacks instantly without touching the inner client:
   `retain` queues to the `RetryQueue` and returns a placeholder ID; `recall` returns `[]`;
   `reflect` returns `null`; `delete` is a no-op.
5. After `openTimeoutMs` (default 30 000 ms), state transitions to `half_open`.
6. In `half_open`, exactly one probe call is allowed through per window. A success resets the
   failure counter and increments a success counter. After 2 consecutive successes, state
   transitions back to `closed`. Any failure transitions back to `open`.
7. `getMetrics(): CircuitBreakerMetrics` returns the current state, counts, and timestamps
   without mutating state.
8. The breaker is constructed with `{ failureThreshold, successThreshold, openTimeoutMs,
   inner: IMemoryClient, retryQueue: RetryQueue }` — all injected, none read from env.
9. All state transitions are logged at INFO level: `Circuit breaker → open`, `→ half_open`,
   `→ closed`.

### Requirement 5: RetryQueue and createMemoryClient Factory

**User Story:** As a developer, I want failed memory writes to be queued on disk and retried
automatically so that no learnings are permanently lost during brief service outages.

#### Acceptance Criteria

1. `src/memory/retry-queue.ts` exports `RetryQueue` backed by a JSONL file at
   `{MEMORY_RETRY_PATH}` (default `data/memory-retry-queue.jsonl`).
2. `RetryQueue.enqueue(entry: RetryQueueEntry): void` appends a line to the file synchronously
   using `Bun.write` in append mode. If the queue has reached 1 000 entries, the oldest entry
   is silently discarded to make room.
3. `RetryQueue.drain(): Promise<number>` reads all entries, attempts `retain` on each via the
   inner `IMemoryClient`, removes successfully retried entries from the file, and returns the
   count of successful retries.
4. Entries with `attempts >= 5` or `queuedAt` older than 24 hours are discarded (not retried)
   during a drain pass.
5. `src/memory/client.ts` exports `createMemoryClient(config)` which composes:
   `HindsightAdapter` → wrapped in `MemoryCircuitBreaker` → returned as `IMemoryClient`.
   When `MEMORY_ENABLED=false` it returns a no-op implementation.
6. `src/memory/scopes.ts` exports `scopeFromJob(job: Job): MemoryScope` and
   `scopeFromChain(chain: Chain): MemoryScope`.
7. `GET /api/memory/circuit-breaker` returns `CircuitBreakerMetrics` as JSON with status 200.
   When `MEMORY_ENABLED=false` it returns `{ state: 'disabled' }` with status 200.
8. The retry drain worker (`src/workers/memoryRetry.ts`) calls `drain()` every 5 minutes
   and logs the result at DEBUG level.
