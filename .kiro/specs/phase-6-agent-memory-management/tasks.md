# Implementation Plan: Phase 6 — Agent Memory Management

## Skill Activation — REQUIRED before every task

**Call `disclose_context` for these skills before writing any code or tests:**

| Always | `accelint-ts-best-practices`, `accelint-ts-testing` |
|--------|------------------------------------------------------|
| + DB / backend / routes | `error-handling-patterns` |
| + dashboard / UI | `agenthq-dashboard` |
| + performance / query timing | `accelint-ts-performance` |
| + security / validation | `best-practices` |
| + JSDoc / comments | `accelint-ts-documentation` |
| + refactoring / coupling | `improve-codebase-architecture` |

These skills do NOT activate automatically during spec task execution.
`disclose_context` must be called explicitly at the start of each task.

---

## Overview

This umbrella spec tracks Phase 6 at the sub-phase level. Each sub-phase has its own spec with
full requirements, design, and granular tasks. Execute sub-phases strictly in order — each
depends on the schema and interfaces introduced by the prior one.

| Sub-phase | Spec directory | Estimated duration |
|-----------|----------------|--------------------|
| 6.1 Memory Infrastructure | `.kiro/specs/phase-6.1-memory-infrastructure/` | 2–3 days |
| 6.2 Memory Extraction | `.kiro/specs/phase-6.2-memory-extraction/` | 3–4 days |
| 6.3 Context Assembly | `.kiro/specs/phase-6.3-context-assembly/` | 2–3 days |
| 6.4 Memory Browser | `.kiro/specs/phase-6.4-memory-browser/` | 3–4 days |
| 6.5 Export & Advanced | `.kiro/specs/phase-6.5-export-advanced/` | 2–3 days |

**Total estimate:** 12–17 days

---

## Task 1: Phase 6.1 — Memory Infrastructure

Complete all tasks in `.kiro/specs/phase-6.1-memory-infrastructure/tasks.md`.

- [ ] 1.1 Add memory env vars to `src/constants.ts` and `.env.example`
- [ ] 1.2 Define `IMemoryClient`, `Memory`, `MemoryScope` in `src/memory/types.ts`
- [ ] 1.3 Implement `HindsightAdapter` in `src/memory/hindsight.ts`
- [ ] 1.4 Implement `MemoryCircuitBreaker` in `src/memory/circuit-breaker.ts`
- [ ] 1.5 Implement `RetryQueue` in `src/memory/retry-queue.ts`
- [ ] 1.6 Implement `createMemoryClient()` factory in `src/memory/client.ts`
- [ ] 1.7 Implement scope resolver in `src/memory/scopes.ts`
- [ ] 1.8 Register `GET /api/memory/circuit-breaker` route
- [ ] 1.9 Wire workers into `src/monitor.ts`
- [ ] 1.10 Write unit and property tests for circuit breaker
- [ ] 1.11 Checkpoint — `tsc --noEmit` clean, all Phase 6.1 tests pass

## Task 2: Phase 6.2 — Memory Extraction

Complete all tasks in `.kiro/specs/phase-6.2-memory-extraction/tasks.md`.

- [ ] 2.1 Create `migrations/004_memory_extraction.sql`
- [ ] 2.2 Implement `extractFacts()` with quality gate in `src/memory/extraction.ts`
- [ ] 2.3 Implement `EmbeddingRouter` (hot/cold tier) in `src/memory/embedding.ts`
- [ ] 2.4 Create `src/workers/memoryBatchEmbed.ts` (6-hour cold-tier worker)
- [ ] 2.5 Trigger extraction pipeline from `src/routes/jobs.ts` on job `done`
- [ ] 2.6 Add `POST /api/memory/extract/:jobId` manual re-trigger route
- [ ] 2.7 Write property tests for extraction quality gate
- [ ] 2.8 Write unit tests for hot/cold tier routing
- [ ] 2.9 Checkpoint — extraction fires end-to-end for a completed test job

## Task 3: Phase 6.3 — Context Assembly

Complete all tasks in `.kiro/specs/phase-6.3-context-assembly/tasks.md`.

- [ ] 3.1 Implement `assembleContext()` with token budget in `src/memory/assembly.ts`
- [ ] 3.2 Integrate `assembleContext()` into `src/agent.ts` pre-execution hook
- [ ] 3.3 Parse `MEMORY:` markers from agent output and store as memories
- [ ] 3.4 Add `POST /api/memory/inject-test` diagnostic route
- [ ] 3.5 Write unit tests for token budget enforcement
- [ ] 3.6 Write integration tests for agent memory injection
- [ ] 3.7 Checkpoint — agent receives injected memories, latency p95 < 500 ms

## Task 4: Phase 6.4 — Memory Browser Dashboard

Complete all tasks in `.kiro/specs/phase-6.4-memory-browser/tasks.md`.

- [ ] 4.1 Create `src/routes/memory.ts` with search, CRUD, reflect endpoints
- [ ] 4.2 Create `src/dashboard/pages/memory.ts` — main memory page
- [ ] 4.3 Create `src/dashboard/components/memoryTimeline.ts`
- [ ] 4.4 Create `src/dashboard/components/memoryGraph.ts` with a11y
- [ ] 4.5 Create `src/dashboard/components/memorySearch.ts`
- [ ] 4.6 Register Memory page in `src/dashboard/main.ts` (`G → M`)
- [ ] 4.7 Wire WebSocket `memory-update` event for real-time refresh
- [ ] 4.8 Write unit tests for memory page components
- [ ] 4.9 Validate WCAG AA contrast and keyboard navigation
- [ ] 4.10 Checkpoint — memory browser loads, search and CRUD work end-to-end

## Task 5: Phase 6.5 — Export, Import, and Advanced Features

Complete all tasks in `.kiro/specs/phase-6.5-export-advanced/tasks.md`.

- [ ] 5.1 Create `src/memory/export.ts` (JSON, Markdown, CSV formatters)
- [ ] 5.2 Create `src/routes/memory-export.ts` (export + import routes)
- [ ] 5.3 Implement memory decay marking in `src/memory/analytics.ts`
- [ ] 5.4 Implement `POST /api/memory/graduate` for steering-file graduation
- [ ] 5.5 Implement `GET /api/memory/analytics` endpoint
- [ ] 5.6 Implement `POST /api/memory/consolidate` (Auto Dream trigger)
- [ ] 5.7 Write unit tests for export formatters
- [ ] 5.8 Write integration tests for import validation and dedup
- [ ] 5.9 Checkpoint — full Phase 6 end-to-end: extract → search → export → import
- [ ] 5.10 Final checkpoint — `tsc --noEmit` clean, full test suite passes
