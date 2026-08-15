# Design Document

## Overview

Phase 6.1 introduces the memory infrastructure plumbing for AgentHQ. The goal is a
production-ready foundation that wraps any memory backend behind a stable TypeScript port
interface (`IMemoryClient`), protects agent execution from memory-service outages via a
3-state circuit breaker, and queues failed writes to disk for automatic retry — all behind
a single feature flag (`MEMORY_ENABLED`).

No extraction or injection is implemented here. This phase is purely the adapter, breaker,
and retry plumbing. Callers that need to store or retrieve memories will call
`createMemoryClient()` and get back an `IMemoryClient` regardless of whether the
Hindsight MCP backend is up.

**In-scope for Phase 6.1:**
- `IMemoryClient` port interface + supporting types
- Typed error hierarchy (`MemoryBaseError`, `MemoryTimeoutError`, `MemoryClientError`, `MemoryServiceError`)
- `HindsightAdapter` — HTTP client implementing `IMemoryClient`
- `MemoryCircuitBreaker` — 3-state FSM wrapping any `IMemoryClient`
- `RetryQueue` — JSONL-backed bounded queue for failed `retain` calls
- `createMemoryClient()` factory that composes the above, or returns `NoOpMemoryClient`
- `scopeFromJob()` / `scopeFromChain()` scope helpers
- `GET /api/memory/circuit-breaker` route
- `memoryRetry.ts` worker (5-minute drain interval)
- Seven new env-var constants + `.env.example` update
- Startup log line for memory status

**Out-of-scope for Phase 6.1:**
- Memory extraction from agent output
- Context injection into prompts
- Quality scoring and decay algorithms
- Any UI for memory browsing

---

## Architecture

### Module map

```
src/
├── constants.ts              +7 memory constants (MEMORY_ENABLED, HINDSIGHT_URL, etc.)
├── monitor.ts                +startup print: "Memory: enabled/disabled"
├── memory/
│   ├── types.ts              IMemoryClient, Memory, MemoryScope, CircuitState,
│   │                         CircuitBreakerMetrics, RetryQueueEntry
│   ├── errors.ts             MemoryBaseError, MemoryTimeoutError,
│   │                         MemoryClientError, MemoryServiceError
│   ├── hindsight.ts          HindsightAdapter implements IMemoryClient
│   ├── circuit-breaker.ts    MemoryCircuitBreaker implements IMemoryClient (FSM)
│   ├── retry-queue.ts        RetryQueue (JSONL-backed, bounded at 1000)
│   ├── client.ts             createMemoryClient(config), NoOpMemoryClient
│   └── scopes.ts             scopeFromJob(job), scopeFromChain(chain)
├── routes/
│   └── memory.ts             GET /api/memory/circuit-breaker
└── workers/
    └── memoryRetry.ts        drain worker (5-minute interval)
```

### Dependency flow

```
monitor.ts
  └── workers/memoryRetry.ts
        └── memory/client.ts ──► memory/circuit-breaker.ts
                                      └── memory/hindsight.ts
                                      └── memory/retry-queue.ts
routes/memory.ts
  └── memory/circuit-breaker.ts (getMetrics)
```

All `src/memory/*` imports are gated by `MEMORY_ENABLED`. When `false`, `createMemoryClient()`
returns `NoOpMemoryClient` without constructing any of the downstream objects.

### Feature flag guard pattern

```typescript
// src/memory/client.ts
export function createMemoryClient(config: MemoryClientConfig): IMemoryClient {
  if (!config.enabled) {
    return new NoOpMemoryClient();
  }
  const adapter = new HindsightAdapter(config.baseUrl);
  const retryQueue = new RetryQueue(config.retryPath);
  return new MemoryCircuitBreaker({
    inner: adapter,
    retryQueue,
    failureThreshold: config.failureThreshold ?? 3,
    openTimeoutMs: config.openTimeoutMs ?? 30_000,
  });
}
```

### Circuit breaker state machine

```
              3 consecutive MemoryServiceError
  [closed] ─────────────────────────────────────► [open]
     ▲                                               │
     │                                  openTimeoutMs elapsed
     │                                               │
     │                                               ▼
     │          probe succeeds               [half_open]
     └──────────────────────────────────────────────┘
                                probe fails ──► [open]
```

State transitions are logged at INFO level. Only `MemoryServiceError` and raw network
errors (fetch throws before response) trip the breaker. `MemoryClientError` (HTTP 4xx)
and `MemoryTimeoutError` are caller errors and do not increment the failure counter.

---

## Components and Interfaces

### IMemoryClient

The port interface. All callers depend only on this — never on `HindsightAdapter` directly.

```typescript
// src/memory/types.ts
interface IMemoryClient {
  retain(text: string, scope: MemoryScope): Promise<string>;
  recall(query: string, scope: MemoryScope, limit: number): Promise<Memory[]>;
  reflect(topic: string, scope: MemoryScope): Promise<string | null>;
  delete(id: string): Promise<void>;
}
```

### HindsightAdapter

Thin HTTP client. Sends MCP tool-call payloads to `{baseUrl}/mcp`. No logic beyond
serialisation/deserialisation. Throws typed errors:
- `MemoryTimeoutError` — fetch timed out after 5 s
- `MemoryClientError` — HTTP 4xx response
- `MemoryServiceError` — HTTP 5xx OR 1xx response (protocol violation)

Network errors (DNS failure, connection refused) are caught and re-thrown as
`MemoryServiceError` so the circuit breaker can count them correctly.

### MemoryCircuitBreaker

Wraps any `IMemoryClient`. Maintains state in private fields (never mutated from
outside). Counts consecutive failures in closed state. Fires a single probe in
half_open state — while the probe is in flight, all concurrent calls receive safe
fallbacks (no second probe is allowed through).

Open-state fallbacks:
- `retain` → enqueues to `RetryQueue`, returns `'__queued__'` placeholder ID
- `recall` → returns `[]`
- `reflect` → returns `null`
- `delete` → no-op (returns `undefined`)

### RetryQueue

JSONL file. Each line is one `RetryQueueEntry` JSON object. Operations:

| Method | Behaviour |
|--------|-----------|
| `enqueue(entry)` | Synchronous append. If size ≥ 1 000 after append, drop the oldest line. |
| `drain()` | Read all entries. For each: skip if `attempts >= 5` or `age > 24h`; else call `inner.retain()`; on success remove from file; on failure increment `attempts`, rewrite. Returns count of successes. |
| `size()` | Returns current entry count (reads file). |

### createMemoryClient

```typescript
type MemoryClientConfig = {
  enabled: boolean;
  baseUrl: string;
  retryPath: string;
  failureThreshold?: number;   // default 3
  openTimeoutMs?: number;      // default 30_000
};
```

### NoOpMemoryClient

Returned when `MEMORY_ENABLED=false`. All methods return safe zero-values synchronously:
- `retain` → returns `''`
- `recall` → returns `[]`
- `reflect` → returns `null`
- `delete` → returns `undefined`

### Scope helpers

```typescript
// src/memory/scopes.ts
function scopeFromJob(job: Job): MemoryScope
function scopeFromChain(chain: Chain): MemoryScope
```

Both set `workspaceId` from the input object's own `workspaceId` field. `scopeFromJob`
additionally sets `agentId` from `job.agent` and `runId` from `job.id`. `scopeFromChain`
sets `chainId` from `chain.chainId`.

---

## Data Models

### MemoryScope

```typescript
type MemoryScope = {
  workspaceId: string;        // required
  userId?: string;
  agentId?: string;
  runId?: string;
  chainId?: string;
};
```

### Memory

```typescript
type Memory = {
  id: string;
  text: string;
  scope: MemoryScope;
  qualityScore: number;
  createdAt: string;          // ISO 8601
  lastRetrievedAt: string;    // ISO 8601
  retrievalCount: number;
  tier: 'hot' | 'warm' | 'cold';
  embeddingStatus: 'pending' | 'ready' | 'failed';
};
```

### CircuitState

```typescript
const CircuitState = {
  closed: 'closed',
  open: 'open',
  half_open: 'half_open',
} as const;

type CircuitState = typeof CircuitState[keyof typeof CircuitState];
```

Using `as const` object rather than a TypeScript `enum` — consistent with the project
convention documented in `references/enums.md`.

### CircuitBreakerMetrics

```typescript
type CircuitBreakerMetrics = {
  state: CircuitState | 'disabled';
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureAt: string | null;   // ISO 8601
  lastSuccessAt: string | null;   // ISO 8601
  openedAt: string | null;        // ISO 8601; null when not open
};
```

### RetryQueueEntry

```typescript
type RetryQueueEntry = {
  id: string;               // UUID
  text: string;             // text passed to retain()
  scope: MemoryScope;
  queuedAt: string;         // ISO 8601
  attempts: number;         // incremented on each failed drain attempt
};
```

### Error types

```typescript
class MemoryBaseError extends Error {}

class MemoryTimeoutError extends MemoryBaseError {}

class MemoryClientError extends MemoryBaseError {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly body: string,
  ) { super(message); }
}

class MemoryServiceError extends MemoryBaseError {
  constructor(
    message: string,
    readonly statusCode: number,
  ) { super(message); }
}
```

### New constants (src/constants.ts additions)

| Constant | Type | Default |
|----------|------|---------|
| `MEMORY_ENABLED` | `boolean` | `false` |
| `HINDSIGHT_URL` | `string` | `'http://localhost:3100'` |
| `MEMORY_EXTRACTION_ENABLED` | `boolean` | `false` |
| `MEMORY_AUTO_INJECT` | `boolean` | `false` |
| `MEMORY_MAX_CONTEXT_MEMORIES` | `number` | `10` |
| `MEMORY_CONTEXT_TOKEN_BUDGET` | `number` | `2000` |
| `MEMORY_DECAY_DAYS` | `number` | `90` |

All added to `resolveConstants(env)` following the existing pattern:

```typescript
const MEMORY_ENABLED = env.MEMORY_ENABLED === 'true';
const HINDSIGHT_URL = env.HINDSIGHT_URL ?? 'http://localhost:3100';
const MEMORY_MAX_CONTEXT_MEMORIES = Number(env.MEMORY_MAX_CONTEXT_MEMORIES) || 10;
```

### HTTP route response

`GET /api/memory/circuit-breaker` returns:
- `200 OK` with `CircuitBreakerMetrics` JSON when `MEMORY_ENABLED=true`
- `200 OK` with `{ state: 'disabled' }` when `MEMORY_ENABLED=false`

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions
of a system — essentially, a formal statement about what the system should do. Properties
serve as the bridge between human-readable specifications and machine-verifiable correctness
guarantees.*

The property-based testing library for this project is **fast-check** (already in use in the
codebase via `bun test`). Each property test runs a minimum of 100 iterations.

---

### Property 1: NoOp client returns safe zero-values for any input

*For any* text, scope, query, topic, limit, or id passed to a `NoOpMemoryClient` (created when
`MEMORY_ENABLED=false`), every method returns its safe zero-value without throwing:
- `retain(text, scope)` returns a string (empty string `''`)
- `recall(query, scope, limit)` returns `[]`
- `reflect(topic, scope)` returns `null`
- `delete(id)` returns `undefined`

**Validates: Requirements 1.1**

---

### Property 2: resolveConstants produces correct defaults for any env without memory keys

*For any* `NodeJS.ProcessEnv` object that does not contain any of the seven memory-related keys,
`resolveConstants(env)` returns the following exact defaults:
- `MEMORY_ENABLED` = `false`
- `HINDSIGHT_URL` = `'http://localhost:3100'`
- `MEMORY_EXTRACTION_ENABLED` = `false`
- `MEMORY_AUTO_INJECT` = `false`
- `MEMORY_MAX_CONTEXT_MEMORIES` = `10`
- `MEMORY_CONTEXT_TOKEN_BUDGET` = `2000`
- `MEMORY_DECAY_DAYS` = `90`

**Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7**

---

### Property 3: HindsightAdapter maps HTTP 4xx to MemoryClientError with correct statusCode

*For any* HTTP status code in `[400..499]` returned by the Hindsight server, `HindsightAdapter`
throws `MemoryClientError` with a `statusCode` field equal to the received HTTP status code.

**Validates: Requirements 3.4**

---

### Property 4: HindsightAdapter maps HTTP 5xx to MemoryServiceError with correct statusCode

*For any* HTTP status code in `[500..599]` returned by the Hindsight server, `HindsightAdapter`
throws `MemoryServiceError` with a `statusCode` field equal to the received HTTP status code.

**Validates: Requirements 3.6**

---

### Property 5: HindsightAdapter maps HTTP 1xx to MemoryServiceError with correct statusCode

*For any* HTTP status code in `[100..199]` returned by the Hindsight server, `HindsightAdapter`
throws `MemoryServiceError` with a `statusCode` field equal to the received HTTP status code.

**Validates: Requirements 3.5**

---

### Property 6: Circuit breaker transitions closed→open after exactly failureThreshold consecutive MemoryServiceErrors

*For any* `failureThreshold` N ≥ 1, a `MemoryCircuitBreaker` constructed with that threshold:
- remains in `closed` state after exactly N-1 consecutive `MemoryServiceError`s
- transitions to `open` state after exactly the Nth consecutive `MemoryServiceError`

**Validates: Requirements 4.2**

---

### Property 7: MemoryClientError and MemoryTimeoutError never trip the circuit breaker

*For any* number of consecutive calls that throw `MemoryClientError` or `MemoryTimeoutError`,
the `MemoryCircuitBreaker` remains in `closed` state and the consecutive-failure counter
remains at zero.

**Validates: Requirements 4.3**

---

### Property 8: Open-state calls return safe fallbacks and never reach the inner client

*For any* inputs passed to a `MemoryCircuitBreaker` in `open` state, all four methods return
their safe fallbacks (`retain` returns a string, `recall` returns `[]`, `reflect` returns `null`,
`delete` returns `undefined`) and the inner `IMemoryClient` implementation is not called.

**Validates: Requirements 4.4**

---

### Property 9: In half_open state, exactly one probe call reaches the inner client

*For any* number of concurrent calls made while `MemoryCircuitBreaker` is in `half_open` state,
exactly one call is forwarded to the inner `IMemoryClient`; all remaining calls receive safe
fallbacks without reaching the inner client.

**Validates: Requirements 4.6**

---

### Property 10: RetryQueue never exceeds 1000 entries after any enqueue sequence

*For any* sequence of `enqueue()` calls on a `RetryQueue` — regardless of length — the queue's
entry count never exceeds 1 000. When the queue is full and a new entry is enqueued, the oldest
entry is discarded to make room (FIFO eviction).

**Validates: Requirements 5.2**

---

### Property 11: drain() removes successfully retried entries and returns their count

*For any* `RetryQueue` with N entries where the inner `IMemoryClient.retain()` succeeds for all
of them, `drain()` returns N and the queue is empty afterward.

**Validates: Requirements 5.3**

---

### Property 12: drain() discards stale entries without calling retain

*For any* `RetryQueue` entry with `attempts >= 5` or `queuedAt` older than 24 hours, `drain()`
discards that entry without calling `retain()` on the inner client, and the entry is absent from
the queue after drain completes.

**Validates: Requirements 5.4**

---
## Error Handling

### Failure Modes and Recovery

**Hindsight server unavailable (connection refused / DNS failure)**
- **Detection:** `fetch()` throws before receiving a response (network error)
- **Response:** `HindsightAdapter` catches the error and re-throws as `MemoryServiceError` with `statusCode: 0`
- **Recovery:** `MemoryCircuitBreaker` counts the failure toward `consecutiveFailures`; after `failureThreshold` failures the breaker opens. All subsequent calls get safe fallbacks. The `memoryRetry.ts` worker drains queued `retain` calls every 5 minutes.

**Hindsight server returns 5xx**
- **Detection:** HTTP response status in `[500..599]`
- **Response:** `HindsightAdapter` throws `MemoryServiceError`. Circuit breaker counts toward threshold.
- **Recovery:** Same as above.

**Hindsight server returns unexpected 1xx**
- **Detection:** HTTP response status in `[100..199]`
- **Response:** `HindsightAdapter` throws `MemoryServiceError` (protocol violation)
- **Recovery:** Treated the same as 5xx by the circuit breaker.

**HTTP 4xx (caller error)**
- **Detection:** HTTP response status in `[400..499]`
- **Response:** `HindsightAdapter` throws `MemoryClientError` with `statusCode` and `body`
- **Recovery:** Circuit breaker does NOT count this toward the failure threshold. The error propagates to the caller for handling (e.g. bad scope, invalid payload). Callers should log and treat as a non-retryable error — these entries are not queued for retry.

**5-second timeout**
- **Detection:** `AbortController` fires after 5 000 ms; `fetch()` throws `AbortError`
- **Response:** `HindsightAdapter` catches and re-throws as `MemoryTimeoutError`
- **Recovery:** Circuit breaker does NOT count timeouts toward the failure threshold. The timeout is treated as a transient caller-side condition, not a service failure.

**RetryQueue file I/O failure**
- **Detection:** `Bun.write` throws during `enqueue()`, or file read throws during `drain()`
- **Response:** `enqueue()` — error is logged at WARN level and silently swallowed (we cannot persist the retry, but we must not crash the agent job). `drain()` — if the file cannot be read, the drain pass is skipped and logged at WARN.
- **Recovery:** Next drain cycle will attempt again.

**RetryQueue entry permanently failing (attempts >= 5 or age > 24h)**
- **Detection:** Checked at the start of each `drain()` pass
- **Response:** Entry is removed from the queue and discarded. No `retain()` is called.
- **Recovery:** Lost memory write. Logged at WARN with the original text for manual inspection if needed.

**Circuit breaker opens while retain is already in-flight**
- **Detection:** Not applicable — the breaker transitions after a call completes with a failure, not while a call is in-flight.
- **Response:** The in-flight call resolves or rejects normally; the state transition happens after completion.

---

## Testing Strategy

### Dual testing approach

Both unit tests (example-based) and property-based tests (fast-check) are required.
Unit tests cover specific wiring, error messages, timer behavior, and integration points.
Property tests verify universal invariants that hold across all inputs.

### Unit tests (example-based)

Located in `test/memory/`. One test file per source module.

| File | What to cover |
|------|--------------|
| `test/memory/hindsight.test.ts` | Correct URL construction; correct MCP payload shape for each of the four methods; `MemoryTimeoutError` on hang; error types on 4xx/5xx/1xx (3 specific examples) |
| `test/memory/circuit-breaker.test.ts` | Initial state is `closed`; `open → half_open` timer transition (mocked); `half_open → closed` on probe success; `half_open → open` on probe failure; `getMetrics()` shape; INFO log on each transition |
| `test/memory/retry-queue.test.ts` | `enqueue` appends a line; `drain` calls retain and empties queue on success; `drain` increments attempts on failure; `drain` discards attempts>=5; `drain` discards age>24h |
| `test/memory/client.test.ts` | `createMemoryClient` with `enabled=false` returns `NoOpMemoryClient`; with `enabled=true` returns a `MemoryCircuitBreaker` |
| `test/memory/scopes.test.ts` | `scopeFromJob` maps fields correctly; `scopeFromChain` maps fields correctly |
| `test/routes/memory.test.ts` | `GET /api/memory/circuit-breaker` returns 200 + metrics when enabled; returns `{state:'disabled'}` when not |

### Property-based tests (fast-check)

Each property test runs **minimum 100 iterations** (`numRuns: 100` in fast-check config).
Each test includes a tag comment in the format:

```typescript
// Feature: phase-6.1-memory-infrastructure, Property N: <property text>
```

| Property | Test file | Arbitraries used |
|----------|-----------|-----------------|
| 1 — NoOp safe zero-values | `test/memory/client.test.ts` | `fc.string()`, `fc.record(memoryScope)`, `fc.integer()` |
| 2 — resolveConstants defaults | `test/constants.test.ts` | `fc.record({})` (env without memory keys) |
| 3 — 4xx → MemoryClientError | `test/memory/hindsight.test.ts` | `fc.integer({ min: 400, max: 499 })` |
| 4 — 5xx → MemoryServiceError | `test/memory/hindsight.test.ts` | `fc.integer({ min: 500, max: 599 })` |
| 5 — 1xx → MemoryServiceError | `test/memory/hindsight.test.ts` | `fc.integer({ min: 100, max: 199 })` |
| 6 — Failure threshold exactness | `test/memory/circuit-breaker.test.ts` | `fc.integer({ min: 1, max: 10 })` for threshold |
| 7 — Non-tripping errors | `test/memory/circuit-breaker.test.ts` | `fc.integer({ min: 1, max: 50 })` for error count |
| 8 — Open-state fallbacks | `test/memory/circuit-breaker.test.ts` | `fc.string()`, `fc.record(memoryScope)` |
| 9 — Half-open single probe | `test/memory/circuit-breaker.test.ts` | `fc.integer({ min: 1, max: 20 })` for call count |
| 10 — RetryQueue boundedness | `test/memory/retry-queue.test.ts` | `fc.array(fc.record(retryEntry), { minLength: 0, maxLength: 2000 })` |
| 11 — Drain success empties queue | `test/memory/retry-queue.test.ts` | `fc.array(fc.record(retryEntry), { minLength: 1 })` |
| 12 — Drain discard rule | `test/memory/retry-queue.test.ts` | `fc.record(retryEntry)` with `attempts>=5` or old `queuedAt` |

### Test doubles

- `HindsightAdapter` is replaced by a `FakeMemoryClient` in all circuit-breaker tests — never hits the network.
- HTTP layer in `hindsight.test.ts` uses `fetch` mock (Bun's built-in `mock()`).
- Timers in circuit-breaker tests use `vi.useFakeTimers()` / Bun timer mocks for `openTimeoutMs`.
- `RetryQueue` in circuit-breaker tests uses an in-memory fake queue (implements the `enqueue`/`drain` interface without touching disk).

### TypeScript type checking

Before marking any test as complete, run:
```
node_modules/.bin/tsc.exe --noEmit
```
All test files must compile with zero type errors. No `as any` in test files.

---
