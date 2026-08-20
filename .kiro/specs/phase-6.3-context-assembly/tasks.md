# Implementation Plan: Phase 6.3 — Context Assembly

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

Connects the Phase 6.2 memory infrastructure to the live agent execution path.
Creates `src/memory/assembly.ts` with `assembleContext` and `ReadOnlyMemoryClient`,
wires `assembleContext` into `src/agent.ts` with a 450 ms timeout guard, adds
MEMORY marker extraction to `src/routes/jobs.ts`, and exposes a diagnostic endpoint
`POST /api/memory/inject-test` in `src/routes/memory.ts`.

## Tasks

- [ ] 1. Create `src/memory/assembly.ts` — types, token counting, and `assembleContext`
  - Define `MemoryAssemblyConfig`, `MemoryFate`, and `DiagnosticCollector` types
  - Implement module-private `countTokens(text: string): number` using `Math.ceil(text.length / 4)`
  - Implement `assembleContext(job, client, config, collector?)` following the token-budget algorithm:
    - Build query string `"${job.name} ${job.type}"` and scope via `scopeFromJob(job)`
    - Call `client.recall(query, scope, config.candidateLimit)`
    - Deduct heading tokens from budget before iterating candidates
    - Iterate memories in returned order (descending relevance); include if within budget, skip otherwise
    - Call `collector(memory, fate)` when collector is provided — no overhead when `undefined`
    - If zero lines included return `""`; otherwise return `"## Relevant Past Context\n" + lines.join("")` with no trailing newline on the final bullet
    - Log `console.debug` when any candidates are dropped
  - Implement `ReadOnlyMemoryClient` (class, private `#inner`) that forwards `recall` and `reflect`, rejects `retain` and `delete` with `MemoryClientError`
  - Export: `assembleContext`, `ReadOnlyMemoryClient`, `MemoryAssemblyConfig`, `MemoryFate`, `DiagnosticCollector`
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 4.2_

- [ ] 2. Wire `assembleContext` into `src/agent.ts`
  - [ ] 2.1 Add `assembleContext` call with `Promise.race` 450 ms timeout guard
    - Read the current `buildPrompt` / `runAgent` call site to understand where system prompt is constructed
    - When `MEMORY_ENABLED=false` skip entirely — no call, no log
    - When `MEMORY_ENABLED=true`: race `assembleContext` against a 450 ms timeout sentinel
    - On timeout or thrown error: log `WARN: assembleContext timed out after 450ms — running without memory context` and continue with base prompt
    - When `MEMORY_AUTO_INJECT=false`: call `assembleContext`, log result at DEBUG, do **not** append to prompt
    - When `MEMORY_AUTO_INJECT=true` and non-empty result: append `\n\n${memoryBlock}` after base system prompt
    - When circuit breaker returns empty string: log `WARN: memory circuit open — skipping injection`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

- [ ] 3. Add MEMORY marker extraction to `src/routes/jobs.ts`
  - [ ] 3.1 Implement `isValidFact` and `extractMarkersFromOutput`
    - Add module-level `MEMORY_MARKER_REGEX = /^MEMORY:\s*(.+)$/gim`
    - Implement `isValidFact(text: string): boolean`: length in [20, 500] and no match against `GENERIC_REJECT_PATTERNS` from Phase 6.2
    - Implement `extractMarkersFromOutput(output, job, client)`: guarded by `MEMORY_EXTRACTION_ENABLED`; iterate regex matches; validate each fact; call `client.retain(fact, scopeFromJob(job))` with `runId` scope; write `memory_extraction` record with `source='marker'`, `tier='hot'`, `quality_score=1.0`; catch retain failures, log at ERROR, rely on RetryQueue (do not rethrow)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_
  - [ ] 3.2 Call `extractMarkersFromOutput` after job completion event
    - Identify the post-job-completion hook/handler in `jobs.ts`
    - Fire `extractMarkersFromOutput` fire-and-forget (do not `await` on the hot path; errors are caught internally)
    - _Requirements: 3.1, 3.5_

- [ ] 4. Add `POST /api/memory/inject-test` to `src/routes/memory.ts`
  - [ ] 4.1 Implement the route handler
    - Guard: return 503 `{ error: "memory is not enabled" }` when `MEMORY_ENABLED=false`
    - Parse `{ jobId }` from JSON request body; return 400 on malformed body
    - Look up job from scan cache; return 404 `{ error: "job not found", jobId }` if absent
    - Return 400 `{ error: "job is not in a completed state", status: job.status }` if `job.status` is `running` or `error`
    - Wrap shared `memoryClient` in `ReadOnlyMemoryClient`
    - Record `startMs = Date.now()`; call `assembleContext` with a `DiagnosticCollector` that accumulates included and dropped memories
    - Compute `assemblyMs = Date.now() - startMs`
    - Return 200 `InjectTestResponse`: `{ memoryCount, tokenCount, memories, dropped, circuitState, assemblyMs }`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 5. Checkpoint — type-check before writing tests
  - Run `node_modules\.bin\tsc.exe --noEmit` (0 errors expected)
  - Ensure all exports align with their import sites; fix any type errors before proceeding.

- [ ] 6. Write tests for `src/memory/assembly.ts`
  - [ ] 6.1 Write unit tests in `test/memory/assembly.test.ts`
    - `assembleContext` returns `""` when `client.recall` returns `[]`
    - `assembleContext` returns `""` when the single candidate exceeds the token budget individually
    - `assembleContext` drops memories that push total over budget (not just first-over)
    - `assembleContext` includes memories in the order returned (descending relevance first)
    - `assembleContext` deducts heading tokens before iterating bullet candidates
    - `assembleContext` calls `console.debug` when memories are dropped
    - `assembleContext` returns no trailing newline on the final bullet
    - `assembleContext` calls `collector` once per candidate with correct `MemoryFate`
    - `ReadOnlyMemoryClient.recall` delegates to inner client
    - `ReadOnlyMemoryClient.retain` rejects with `MemoryClientError`
    - `ReadOnlyMemoryClient.delete` rejects with `MemoryClientError`
    - `isValidFact` rejects strings shorter than 20 characters
    - `isValidFact` rejects strings longer than 500 characters
    - `isValidFact` rejects strings matching `GENERIC_REJECT_PATTERNS`
    - MEMORY marker regex matches `memory:`, `MEMORY:`, `Memory:` (case-insensitive)
    - MEMORY marker regex does not match lines without leading `MEMORY:`
    - _Requirements: 1.1–1.7, 3.1, 3.2_
  - [ ]* 6.2 Write property test — Property 1: Token Budget Invariant
    - Tag: `// Feature: phase-6.3-context-assembly, Property 1: Token Budget Invariant`
    - Generate arbitrary `Memory[]` (text 1–600 chars) and `tokenBudget` (100–4000)
    - Assert `Math.ceil(result.length / 4) <= tokenBudget` for all inputs
    - **Property 1: Token Budget Invariant**
    - **Validates: Requirements 1.4, 1.7**
  - [ ]* 6.3 Write property test — Property 2: Empty-String Zero Value
    - Tag: `// Feature: phase-6.3-context-assembly, Property 2: Empty-String Zero Value`
    - Generate memories where each text individually exceeds budget (minLength > budget * 4)
    - Assert result is `""` OR starts with `"## Relevant Past Context\n- "`
    - **Property 2: Empty-String Zero Value**
    - **Validates: Requirements 1.5, 1.6**
  - [ ]* 6.4 Write property test — Property 3: Marker Validation Idempotence
    - Tag: `// Feature: phase-6.3-context-assembly, Property 3: Marker Validation Idempotence`
    - Generate strings in [20, 500] chars filtered to exclude reject-pattern matches
    - Assert `isValidFact(fact) === true` for all generated inputs
    - **Property 3: Marker Validation Idempotence**
    - **Validates: Requirements 3.2, 3.7**
  - [ ]* 6.5 Write property test — Property 5: Format Consistency
    - Tag: `// Feature: phase-6.3-context-assembly, Property 5: Format Consistency`
    - Generate non-empty `Memory[]` with short text (1–80 chars) within a large budget
    - Assert: first line is `"## Relevant Past Context"`, every subsequent line starts with `"- "`, result does not end with `"\n"`
    - **Property 5: Format Consistency**
    - **Validates: Requirements 1.5**

- [ ] 7. Write tests for the inject-test route in `test/routes/inject-test.test.ts`
  - [ ] 7.1 Write unit tests
    - Returns 503 when `MEMORY_ENABLED=false`
    - Returns 404 when job is not found
    - Returns 400 when job status is `running`
    - Returns 400 when job status is `error`
    - Returns 200 with correct `InjectTestResponse` shape when job is completed
    - `assemblyMs` is present and a non-negative integer
    - `dropped` matches the count of candidates that exceeded the budget
    - `ReadOnlyMemoryClient` prevents any write calls reaching the inner client during diagnostic execution
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [ ]* 7.2 Write property test — Property 4: Read-Only Diagnostic Isolation
    - Tag: `// Feature: phase-6.3-context-assembly, Property 4: Read-Only Diagnostic Isolation`
    - For any completed job, assert that calling the endpoint leaves the inner `IMemoryClient` retain/delete call counts at zero
    - **Property 4: Read-Only Diagnostic Isolation**
    - **Validates: Requirements 4.2**

- [ ] 8. Final checkpoint — run full test suite
  - Run `bun test test/memory/assembly.test.ts test/routes/inject-test.test.ts`
  - Run `node_modules\.bin\tsc.exe --noEmit` (0 errors)
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Property tests require `fast-check` (already a project dependency)
- Task 2.1 must read `src/agent.ts` before editing — exact integration point depends on current call site
- Task 3.2 must read `src/routes/jobs.ts` before editing — the post-completion hook location varies
- `assembleContext` timeout (450 ms) is enforced at the `agent.ts` call site via `Promise.race`, NOT inside `assembleContext` itself — keeps the function pure and testable
- `extractMarkersFromOutput` is fire-and-forget on the completion path; retain errors are isolated via catch and RetryQueue
- All four correctness properties target `assembleContext` directly — use a fake `IMemoryClient` (stub, not a spy or mock) in property tests

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "3.1"] },
    { "id": 2, "tasks": ["3.2", "4.1"] },
    { "id": 3, "tasks": ["6.1", "7.1"] },
    { "id": 4, "tasks": ["6.2", "6.3", "6.4", "6.5", "7.2"] }
  ]
}
```
