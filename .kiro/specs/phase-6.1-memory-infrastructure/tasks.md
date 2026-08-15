# Implementation Plan: Phase 6.1 — Memory Infrastructure

## Skill Activation — REQUIRED before every task

**Call `disclose_context` for these skills before writing any code or tests:**

| Always | `accelint-ts-best-practices`, `accelint-ts-testing` |
|--------|------------------------------------------------------|
| + DB / backend / routes | `error-handling-patterns` |
| + dashboard / UI | `agenthq-dashboard` |
| + performance / query timing | `accelint-ts-performance` |
| + security / validation / SQL | `best-practices` |
| + JSDoc / comments | `accelint-ts-documentation` |
| + refactoring / coupling | `improve-codebase-architecture` |

These skills do NOT activate automatically during spec task execution.
`disclose_context` must be called explicitly at the start of each task.

---

## Overview

Implements the Phase 6.1 memory infrastructure plumbing: the `IMemoryClient` port
interface, typed error hierarchy, `HindsightAdapter` HTTP client, `MemoryCircuitBreaker`
3-state FSM, `RetryQueue` JSONL-backed bounded queue, `createMemoryClient` factory,
scope helpers, an HTTP route for circuit breaker metrics, and a background retry worker.
All behaviour is gated behind `MEMORY_ENABLED`. No extraction or injection is included.

## Tasks

- [ ] 1. Memory types, errors, and configuration
  - [ ] 1.1 Create `src/memory/types.ts` with all type and interface declarations
    - Export `IMemoryClient` interface with exactly four methods: `retain`, `recall`, `reflect`, `delete`
    - Export `MemoryScope` (only `workspaceId` required; `userId`, `agentId`, `runId`, `chainId` optional)
    - Export `Memory` type with all nine fields: `id`, `text`, `scope`, `qualityScore`, `createdAt`, `lastRetrievedAt`, `retrievalCount`, `tier`, `embeddingStatus`
    - Export `CircuitState` as a `const` object (NOT a TypeScript enum) with values `'closed'`, `'open'`, `'half_open'` — follow project convention in `references/enums.md`
    - Export `CircuitBreakerMetrics` type with `state: CircuitState | 'disabled'` and timestamp fields as `string | null`
    - Export `RetryQueueEntry` type with `id`, `text`, `scope`, `queuedAt`, `attempts`
    - File must contain ONLY type/interface/const declarations — no runtime logic, no imports with side effects (mirror the convention in `src/types.ts`)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

  - [ ] 1.2 Create `src/memory/errors.ts` with the four-class typed error hierarchy
    - `MemoryBaseError extends Error`
    - `MemoryTimeoutError extends MemoryBaseError` (no extra fields)
    - `MemoryClientError extends MemoryBaseError` with `readonly statusCode: number` and `readonly body: string`
    - `MemoryServiceError extends MemoryBaseError` with `readonly statusCode: number`
    - All classes call `super(message)` and set `this.name` to the class name for clean stack traces
    - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.7_

  - [ ] 1.3 Extend `src/constants.ts` with seven memory constants inside `resolveConstants()`, plus `MEMORY_RETRY_PATH`
    - `MEMORY_ENABLED`: parsed as `env.MEMORY_ENABLED === 'true'` (strict equality, not truthy)
    - `HINDSIGHT_URL`: `env.HINDSIGHT_URL ?? 'http://localhost:3100'`
    - `MEMORY_EXTRACTION_ENABLED`: parsed as `env.MEMORY_EXTRACTION_ENABLED === 'true'`
    - `MEMORY_AUTO_INJECT`: parsed as `env.MEMORY_AUTO_INJECT === 'true'`
    - `MEMORY_MAX_CONTEXT_MEMORIES`: `Number(env.MEMORY_MAX_CONTEXT_MEMORIES) || 10`
    - `MEMORY_CONTEXT_TOKEN_BUDGET`: `Number(env.MEMORY_CONTEXT_TOKEN_BUDGET) || 2000`
    - `MEMORY_DECAY_DAYS`: `Number(env.MEMORY_DECAY_DAYS) || 90`
    - `MEMORY_RETRY_PATH`: `env.MEMORY_RETRY_PATH ?? 'data/memory-retry-queue.jsonl'`
    - Add all eight to the `resolveConstants` return object and add flat named exports following the existing pattern
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

  - [ ] 1.4 Update `.env.example` with all eight new variables and inline comments
    - Each line: `# <purpose and default value explanation>` followed by `VARNAME=defaultValue`
    - Variables: `MEMORY_ENABLED`, `HINDSIGHT_URL`, `MEMORY_EXTRACTION_ENABLED`, `MEMORY_AUTO_INJECT`, `MEMORY_MAX_CONTEXT_MEMORIES`, `MEMORY_CONTEXT_TOKEN_BUDGET`, `MEMORY_DECAY_DAYS`, `MEMORY_RETRY_PATH`
    - _Requirements: 1.9_

  - [ ] 1.5 Add startup memory status log line to `src/monitor.ts`
    - Import `MEMORY_ENABLED` and `HINDSIGHT_URL` from `./constants.ts`
    - After the validation block (after `process.exit(1)` guard) and before the worker imports, add:
      `console.log(MEMORY_ENABLED ? \`Memory: enabled (hindsight @ ${HINDSIGHT_URL})\` : 'Memory: disabled');`
    - _Requirements: 1.10_

  - [ ]* 1.6 Write property test for Property 2 (resolveConstants defaults) in `test/constants.test.ts`
    - Create `test/constants.test.ts` — new file, no existing file to extend
    - Use `fc.record({})` arbitrary to generate env objects that omit all eight memory keys
    - Assert all eight defaults match the specification: `MEMORY_ENABLED=false`, `HINDSIGHT_URL='http://localhost:3100'`, etc.
    - Tag comment: `// Feature: phase-6.1-memory-infrastructure, Property 2: resolveConstants produces correct defaults for any env without memory keys`
    - `numRuns: 100`
    - **Property 2: resolveConstants defaults**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7**

  - Verify: `node_modules/.bin/tsc.exe --noEmit` passes with zero errors
  - _Requirements: 1.1–1.10, 2.1–2.9_

- [ ] 2. HindsightAdapter
  - [ ] 2.1 Create `src/memory/hindsight.ts` implementing `HindsightAdapter`
    - Constructor accepts `baseUrl: string` — never reads from `process.env` directly
    - All four methods POST to `{baseUrl}/mcp` with MCP payload: `{ method: 'tools/call', params: { name: '<tool>', arguments: { ... } } }`
    - Use `AbortController` + `AbortSignal.timeout(5000)` for the 5-second timeout; catch `AbortError` and throw `MemoryTimeoutError`
    - Network errors (fetch throws before response) are caught and re-thrown as `MemoryServiceError` with `statusCode: 0`
    - HTTP 1xx responses → throw `MemoryServiceError` with the status code (protocol violation)
    - HTTP 4xx responses → throw `MemoryClientError` with `statusCode` and response body string
    - HTTP 5xx responses → throw `MemoryServiceError` with the status code
    - No scope mapping, quality gating, or retry logic belongs here
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

  - [ ]* 2.2 Write unit tests and property tests in `test/memory/hindsight.test.ts`
    - Unit tests: correct URL construction; correct MCP payload shape for all four methods; `MemoryTimeoutError` on hang; one example each for 4xx/5xx/1xx
    - Mock `fetch` using Bun's built-in `mock()` — never hit the network
    - **Property 3:** For any HTTP status in `[400..499]`, throws `MemoryClientError` with matching `statusCode`
      - `fc.integer({ min: 400, max: 499 })`
      - Tag: `// Feature: phase-6.1-memory-infrastructure, Property 3: HindsightAdapter maps HTTP 4xx to MemoryClientError with correct statusCode`
    - **Property 4:** For any HTTP status in `[500..599]`, throws `MemoryServiceError` with matching `statusCode`
      - `fc.integer({ min: 500, max: 599 })`
      - Tag: `// Feature: phase-6.1-memory-infrastructure, Property 4: HindsightAdapter maps HTTP 5xx to MemoryServiceError with correct statusCode`
    - **Property 5:** For any HTTP status in `[100..199]`, throws `MemoryServiceError` with matching `statusCode`
      - `fc.integer({ min: 100, max: 199 })`
      - Tag: `// Feature: phase-6.1-memory-infrastructure, Property 5: HindsightAdapter maps HTTP 1xx to MemoryServiceError with correct statusCode`
    - `numRuns: 100` for all property tests; no `as any` in test files
    - **Validates: Requirements 3.4, 3.5, 3.6**

  - Verify: `bun test test/memory/hindsight.test.ts` passes; `node_modules/.bin/tsc.exe --noEmit` passes
  - _Requirements: 3.1–3.9_

- [ ] 3. RetryQueue
  - [ ] 3.1 Create `src/memory/retry-queue.ts` implementing `RetryQueue`
    - Constructor accepts `path: string` and `inner: IMemoryClient`
    - `enqueue(entry: RetryQueueEntry): void` — synchronous append using Bun file API in append mode; after appending, if entry count ≥ 1000, read all lines, drop the first line (oldest), and rewrite the file (FIFO eviction)
    - `drain(): Promise<number>` — read entire file, process sequentially; for each entry: skip and discard if `attempts >= 5` or `queuedAt` older than 24 hours; otherwise call `inner.retain()`; on success remove from in-memory list; on failure increment `attempts`; rewrite entire file with surviving entries at end; return count of successful retries
    - `size(): number` — read file, count non-empty lines
    - I/O failures in `enqueue()`: log at WARN and swallow (must not crash); in `drain()`: log at WARN and skip the drain pass
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [ ]* 3.2 Write unit tests and property tests in `test/memory/retry-queue.test.ts`
    - Unit tests: `enqueue` appends a line; `drain` calls retain and empties queue on success; `drain` increments attempts on failure; `drain` discards `attempts >= 5`; `drain` discards entries older than 24h
    - Use a temp file path per test (avoid cross-test state); clean up in `afterEach`
    - **Property 10:** For any enqueue sequence of any length, queue size never exceeds 1000; oldest entry is evicted when full
      - `fc.array(fc.record({ ... }), { minLength: 0, maxLength: 2000 })`
      - Tag: `// Feature: phase-6.1-memory-infrastructure, Property 10: RetryQueue never exceeds 1000 entries after any enqueue sequence`
    - **Property 11:** For any queue with N entries where `retain` succeeds for all, `drain()` returns N and queue is empty
      - `fc.array(fc.record({ ... }), { minLength: 1, maxLength: 50 })`
      - Tag: `// Feature: phase-6.1-memory-infrastructure, Property 11: drain() removes successfully retried entries and returns their count`
    - **Property 12:** For any entry with `attempts >= 5` or `queuedAt` older than 24h, `drain()` discards it without calling `retain()`
      - Tag: `// Feature: phase-6.1-memory-infrastructure, Property 12: drain() discards stale entries without calling retain`
    - `numRuns: 100`; no `as any`
    - **Validates: Requirements 5.2, 5.3, 5.4**

  - Verify: `bun test test/memory/retry-queue.test.ts` passes; `node_modules/.bin/tsc.exe --noEmit` passes
  - _Requirements: 5.1–5.4_

- [ ] 4. MemoryCircuitBreaker
  - [ ] 4.1 Create `src/memory/circuit-breaker.ts` implementing `MemoryCircuitBreaker`
    - Constructor: `{ inner: IMemoryClient, retryQueue: RetryQueue, failureThreshold: number, openTimeoutMs: number }` — all injected, nothing from env
    - Initial state: `closed`; private field tracks `consecutiveFailures`
    - Count toward failure threshold: only `MemoryServiceError` and raw network errors (fetch-level throws)
    - Do NOT count: `MemoryClientError` (4xx) and `MemoryTimeoutError`
    - After `failureThreshold` consecutive failures: transition to `open`, log `'Circuit breaker → open'` at INFO
    - In `open` state after `openTimeoutMs` ms: transition to `half_open`, log `'Circuit breaker → half_open'` at INFO
    - Use an `inProbe: boolean` private flag; in `half_open`, exactly one probe is allowed through; while probe in-flight, all other calls get safe fallbacks
    - On probe success: transition to `closed`, reset `consecutiveFailures` to 0, log `'Circuit breaker → closed'` at INFO
    - On probe failure (only `MemoryServiceError` / network): transition back to `open`, restart timer
    - Open-state fallbacks: `retain` → enqueues to `RetryQueue` and returns `'__queued__'`; `recall` → `[]`; `reflect` → `null`; `delete` → no-op
    - `getMetrics(): CircuitBreakerMetrics` — returns a snapshot with no references to mutable internal state
    - `CircuitState` imported from `src/memory/types.ts` — do not redefine
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9_

  - [ ]* 4.2 Write unit tests and property tests in `test/memory/circuit-breaker.test.ts`
    - Use a `FakeMemoryClient` test double (never hits network); use an in-memory fake `RetryQueue`
    - Mock timers for `openTimeoutMs` using Bun timer mocks / fake clock
    - Unit tests: initial state `closed`; `open → half_open` timer transition; `half_open → closed` on probe success; `half_open → open` on probe failure; `getMetrics()` shape; INFO log on each transition
    - **Property 6:** For any `failureThreshold` N ≥ 1, breaker stays `closed` after N-1 failures; transitions to `open` after exactly the Nth
      - `fc.integer({ min: 1, max: 10 })`
      - Tag: `// Feature: phase-6.1-memory-infrastructure, Property 6: Circuit breaker transitions closed→open after exactly failureThreshold consecutive MemoryServiceErrors`
    - **Property 7:** For any count of `MemoryClientError` or `MemoryTimeoutError`, breaker stays `closed` and counter stays 0
      - `fc.integer({ min: 1, max: 50 })`
      - Tag: `// Feature: phase-6.1-memory-infrastructure, Property 7: MemoryClientError and MemoryTimeoutError never trip the circuit breaker`
    - **Property 8:** In `open` state, all four methods return safe fallbacks; inner client is never called
      - `fc.string()`, `fc.record({ workspaceId: fc.string() })`
      - Tag: `// Feature: phase-6.1-memory-infrastructure, Property 8: Open-state calls return safe fallbacks and never reach the inner client`
    - **Property 9:** In `half_open` state, exactly one call reaches the inner client; all others get fallbacks
      - `fc.integer({ min: 1, max: 20 })`
      - Tag: `// Feature: phase-6.1-memory-infrastructure, Property 9: In half_open state, exactly one probe call reaches the inner client`
    - `numRuns: 100`; no `as any`
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.6**

  - Verify: `bun test test/memory/circuit-breaker.test.ts` passes; `node_modules/.bin/tsc.exe --noEmit` passes
  - _Requirements: 4.1–4.9_

- [ ] 5. Factory, scopes, route, and worker
  - [ ] 5.1 Create `src/memory/client.ts` with `createMemoryClient` and `NoOpMemoryClient`
    - `NoOpMemoryClient implements IMemoryClient`: `retain()` returns `''`; `recall()` returns `[]`; `reflect()` returns `null`; `delete()` returns `undefined`
    - `MemoryClientConfig` type: `{ enabled: boolean; baseUrl: string; retryPath: string; failureThreshold?: number; openTimeoutMs?: number }`
    - `createMemoryClient(config: MemoryClientConfig): IMemoryClient`: when `!config.enabled` return `new NoOpMemoryClient()`; otherwise compose `HindsightAdapter → MemoryCircuitBreaker` and return the breaker
    - _Requirements: 5.5_

  - [ ] 5.2 Create `src/memory/scopes.ts` with scope helper functions
    - `scopeFromJob(job: Job): MemoryScope` — sets `workspaceId: job.workspaceId`, `agentId: job.agent`, `runId: job.id`
    - `scopeFromChain(chain: Chain): MemoryScope` — sets `workspaceId: chain.workspaceId`, `chainId: chain.chainId`
    - Import `Job` and `Chain` from `../types.ts`; import `MemoryScope` from `./types.ts`
    - _Requirements: 5.6_

  - [ ] 5.3 Create `src/routes/memory.ts` exporting `register(router: Router): void`
    - `GET /api/memory/circuit-breaker` handler
    - Import `MEMORY_ENABLED` from `../constants.ts` (never re-read from `process.env`)
    - When `MEMORY_ENABLED=false`: return `200` with `{ state: 'disabled' }`
    - When `MEMORY_ENABLED=true`: call `circuitBreaker.getMetrics()` and return `200` with `CircuitBreakerMetrics` JSON
    - The `MemoryCircuitBreaker` instance must be passed in (or held in module scope) — do not construct it inside the handler
    - Follow the `register(router)` pattern from existing routes
    - _Requirements: 5.7_

  - [ ] 5.4 Create `src/workers/memoryRetry.ts` following the start/stop interval pattern from `ssebroadcaster.ts`
    - Export `startMemoryRetryWorker(retryQueue: RetryQueue): void` and `stopMemoryRetryWorker(): void`
    - Interval: every 5 minutes (`5 * 60 * 1000` ms)
    - On each tick: call `retryQueue.drain()`, log result at DEBUG level: `[memory-retry] drained N entries`
    - Errors from `drain()` are caught and logged at WARN; must not crash the worker
    - _Requirements: 5.8_

  - [ ] 5.5 Register the memory route and start the retry worker in `src/monitor.ts`
    - Import `register as registerMemory` from `./routes/memory.ts`
    - Call `registerMemory(router)` alongside the other route registrations
    - Import and call `startMemoryRetryWorker` after the other worker starts
    - _Requirements: 5.7, 5.8_

  - [ ]* 5.6 Write unit tests in `test/memory/client.test.ts`
    - Test: `createMemoryClient({ enabled: false, ... })` returns a `NoOpMemoryClient` (all methods return safe zero-values)
    - Test: `createMemoryClient({ enabled: true, ... })` returns a `MemoryCircuitBreaker` instance
    - **Property 1:** For any inputs, `NoOpMemoryClient` methods return safe zero-values and never throw
      - Arbitraries: `fc.string()`, `fc.record({ workspaceId: fc.string() })`, `fc.integer({ min: 0, max: 100 })`
      - Tag: `// Feature: phase-6.1-memory-infrastructure, Property 1: NoOp client returns safe zero-values for any input`
    - `numRuns: 100`
    - **Validates: Requirements 1.1, 5.5**

  - [ ]* 5.7 Write unit tests in `test/memory/scopes.test.ts`
    - Test `scopeFromJob`: `workspaceId`, `agentId`, `runId` map from correct `Job` fields
    - Test `scopeFromChain`: `workspaceId`, `chainId` map from correct `Chain` fields
    - Use minimal typed stubs for `Job` and `Chain` — no `as any`

  - [ ]* 5.8 Write unit tests in `test/routes/memory.test.ts`
    - Test: `GET /api/memory/circuit-breaker` returns `200` with `{ state: 'disabled' }` when `MEMORY_ENABLED=false`
    - Test: `GET /api/memory/circuit-breaker` returns `200` with `CircuitBreakerMetrics` when `MEMORY_ENABLED=true`
    - Mock the circuit breaker instance; do not start a real Bun server

  - Verify: all new tests pass; `node_modules/.bin/tsc.exe --noEmit` passes
  - _Requirements: 5.5–5.8_

- [ ] 6. Integration verification and checkpoint
  - [ ] 6.1 Run full test suite: `bun test test/`
    - All tests must pass with zero failures
  - [ ] 6.2 Run type checker: `node_modules/.bin/tsc.exe --noEmit`
    - Zero type errors required
  - [ ] 6.3 Confirm all 12 correctness properties have corresponding property-based tests
    - Properties 1–5: `test/memory/client.test.ts`, `test/constants.test.ts`, `test/memory/hindsight.test.ts`
    - Properties 6–9: `test/memory/circuit-breaker.test.ts`
    - Properties 10–12: `test/memory/retry-queue.test.ts`
    - Each test file contains the correct `// Feature: phase-6.1-memory-infrastructure, Property N: ...` tag comment
  - [ ] 6.4 Confirm `MEMORY_ENABLED=false` path: `createMemoryClient({ enabled: false, ... })` returns `NoOpMemoryClient`; all four methods return safe zero-values without errors
  - [ ] 6.5 Confirm startup log line is present in `src/monitor.ts` and outputs the correct format
  - Ensure all tests pass; ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP delivery
- Properties 1–12 from the design document are mapped to specific test sub-tasks for full traceability
- `CircuitState` is implemented as an `as const` object — never a TypeScript `enum` (project convention)
- `NoOpMemoryClient.retain()` returns `''` (empty string), not `null` or `undefined`
- `MEMORY_RETRY_PATH` is an 8th constant not listed in requirements but required by `RetryQueue` — add it alongside the seven documented ones
- All new `src/memory/` files are net-new; the directory does not exist yet
- Type checker command: `node_modules/.bin/tsc.exe --noEmit` — never run `bun --check src/monitor.ts` (starts the server as a side effect)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4", "1.5"] },
    { "id": 1, "tasks": ["1.6", "2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2", "3.2"] },
    { "id": 3, "tasks": ["4.1"] },
    { "id": 4, "tasks": ["4.2", "5.1", "5.2", "5.3", "5.4", "5.5"] },
    { "id": 5, "tasks": ["5.6", "5.7", "5.8"] },
    { "id": 6, "tasks": ["6.1", "6.2", "6.3", "6.4", "6.5"] }
  ]
}
```
