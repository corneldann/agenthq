# AgentHQ — Development Skills Recommendations

> Research date: July 2026  
> Scope: All active and planned development on AgentHQ (Phases 5–8)  
> Stack: Bun · TypeScript · Vanilla TS SPA · Bun.serve HTTP/SSE · bun:sqlite · bun test + fast-check

---

## How to Read This Document

Skills are grouped by concern. Each entry includes:
- **What it covers** — the specific capabilities relevant to AgentHQ
- **Why it matters here** — concrete AgentHQ code paths where it applies
- **Source** — where to copy from in SkillsLib (all local, no download needed)
- **Status** — ✅ already installed | ❌ needs copying to `workspace/.kiro/skills/`

Install priority: **P0** = needed now, **P1** = before Phase 6 implementation, **P2** = before Phase 7+

---

## 1. Runtime & Server

### `bun` — P0 ❌
**Source:** `SkillsLib/hoodini/ai-agents-skills/skills/bun/`

The single most important missing skill. AgentHQ is Bun-native — no Node.js, no Express, no Vite. Every server, file I/O, build, and test operation goes through Bun APIs that differ from Node equivalents.

What it covers that matters directly:

| Bun API | Where AgentHQ uses it |
|---------|----------------------|
| `Bun.serve({ fetch, websocket })` | `src/monitor.ts` — HTTP server + WebSocket upgrade |
| `Bun.file().text()` / `Bun.write()` | `src/scan/*.ts` — all file scanning, job log reads |
| `bun:sqlite` (built-in) | Phase 5 DB — no external driver needed |
| `Bun.spawn()` / `Bun.spawnSync()` | `src/workers/` — spawning git-commit-worker.ps1, MCP server processes |
| `bun build` API | `src/routes/build.ts` — dashboard SPA bundling |
| `bun test` + `mock.module()` | `test/` — native test runner, module mocking |
| `.env` auto-load | `src/constants.ts` — no dotenv package required |
| `Bun.Glob` | `src/scan/jobs.ts` — scanning output directories |

**Key insight:** Bun's `Bun.serve` WebSocket pub/sub (`ws.subscribe()` / `ws.publish()`) is the correct pattern for Phase 5 WebSocket — not a separate `ws` library.

---

### `nodejs-backend-patterns` — P0 ❌
**Source:** `SkillsLib/wshobson/agents/plugins/javascript-typescript/skills/nodejs-backend-patterns/`

Production server patterns that apply directly to `src/routes/` and `src/workers/`:

- **Graceful shutdown** — when MCP server subprocess or DB connection is open, `src/monitor.ts` needs `SIGTERM` handling
- **Middleware chains** — Phase 6 memory routes need auth + validation middleware without a framework
- **Health check patterns** — `/system-status` exists; extend to report memory subsystem, DB, MCP server health
- **Structured logging** — replace scattered `console.log` with leveled structured output (critical for Phase 5 observability)
- **Rate limiting** — `src/routes/sse.ts` clients need backpressure; extraction pipeline needs throttling
- **CORS** — dashboard SPA (port 3333) calling API routes needs explicit header handling

---

## 2. TypeScript Quality

### `accelint-ts-best-practices` — P0 ✅ (installed as `ts-best-practices`)
Covers naming conventions, `any` avoidance, error messages, return values, control flow. Already active.

### `accelint-ts-testing` — P0 ✅ (installed as `ts-testing`)
Covers vitest/bun:test AAA pattern, fast-check property tests, test doubles hierarchy, async testing. Already active.

### `accelint-ts-performance` — P1 ✅ (installed as `ts-performance`)
Covers the 4-phase audit workflow: profile → analyze → optimize → verify. Hot-path relevant for:
- `src/scan/jobs.ts` — scanning 1000+ files on 2s interval (the known CPU spike issue)
- `src/memory/extraction.ts` (Phase 6) — LLM fact extraction pipeline
- `src/dashboard/state.ts` — SSE event diffing and state reconciliation

Already installed. **Activate explicitly** with `disclose_context` when working on scan or SSE broadcast code.

### `accelint-ts-documentation` — P2 ✅ (installed as `ts-documentation`)
JSDoc for public module interfaces. Needed when writing `src/memory/client.ts` and `src/memory/extraction.ts` API surface.

### `typescript-advanced-types` — P1 ❌
**Source:** `SkillsLib/wshobson/agents/plugins/javascript-typescript/skills/typescript-advanced-types/`

Currently installed as `ts-advanced-types` (from wshobson). Confirm it's the same as the accelint version or install the wshobson one if coverage differs.

Directly needed for:
- `src/types.ts` — the central domain types file used everywhere; conditional types for `Job | undefined` patterns
- Memory scope types (Phase 6) — generic `MemoryQuery<T extends MemoryScope>` design
- Route handler return types — `Response | undefined` pattern in Bun.serve
- Discriminated unions for SSE event payloads

---

## 3. Architecture & Design

### `architecture-patterns` — P1 ❌
**Source:** `SkillsLib/wshobson/agents/plugins/backend-development/skills/architecture-patterns/`

Covers Clean Architecture (ports/adapters), Hexagonal Architecture, DDD tactical patterns.

Why it matters for AgentHQ:
- `src/scan/` is supposed to be pure (no HTTP dependency) — this is the hexagonal port pattern; the skill explains how to enforce it and test it with in-memory adapters
- `src/memory/client.ts` (Phase 6) must be an abstract port over MCP — concrete Mem0 vs Hindsight vs server-memory implementations swap without touching routes
- Phase 7 library registry will have the same pattern: `ILibraryRepository` port, SQLite adapter, in-memory test adapter
- Prevents the recurring problem of route handlers reaching into scan internals

### `improve-codebase-architecture` — P0 ✅ (installed)
Already active. Use when reducing coupling between scan, routes, and workers.

### `api-design-principles` — P1 ❌
**Source:** `SkillsLib/wshobson/agents/plugins/backend-development/skills/api-design-principles/`

Phase 6.4 adds 8+ new `/memory/*` endpoints. Phase 7 adds library registry endpoints. Without this skill, endpoint naming drifts from the existing `/jobs`, `/chains`, `/sessions` pattern.

Specific rules that apply:
- Plural resource names: `/memories` not `/getMemories`
- HTTP method semantics: `PATCH /memories/:id` for update, not `POST /memories/update`  
- Consistent error response shape matching `src/types.ts`
- Cursor-based pagination for memory search results (unbounded result sets)
- `Accept` header support for export endpoints (JSON vs Markdown vs CSV)

---

## 4. Testing

### `javascript-testing-patterns` — P0 ❌
**Source:** `SkillsLib/wshobson/agents/plugins/javascript-typescript/skills/javascript-testing-patterns/`

`accelint-ts-testing` covers bun:test patterns and fast-check. This skill adds the missing pieces:

- **Dependency injection for testability** — `src/memory/client.ts` must accept an injected MCP transport, not instantiate one internally; this skill shows the pattern
- **Module mocking** — mock `bun:sqlite` or the MCP subprocess in unit tests without touching the real file system
- **Integration test patterns** — test full extraction → store → retrieve cycle against a real MCP server process
- **Fixture factories** — `createJobFixture(overrides?)` for generating realistic job log test data; currently tests use ad-hoc objects

**Note:** Together with `accelint-ts-testing`, these two skills cover the full AgentHQ test stack. Neither replaces the other.

### `e2e-testing-patterns` — P2 ❌
**Source:** `SkillsLib/wshobson/agents/plugins/developer-essentials/skills/e2e-testing-patterns/`

For Phase 6.4 memory browser UI and the Phase 5 dashboard: end-to-end tests that launch the Bun server and test HTTP endpoints + SSE streams as a black box. Needed before Phase 7 when the feature set stabilises.

---

## 5. Error Handling & Resilience

### `error-handling-patterns` — P0 ✅ (installed)
Already active. Critical for the MCP client wrapper — remote call boundary, subprocess crashes, token budget exceeded.

The Result type pattern (not just try/catch) is the right approach for `src/memory/extraction.ts` where extraction failures should not propagate up to job execution.

---

## 6. Observability & Monitoring

### `distributed-tracing` — P1 ❌
**Source:** `SkillsLib/wshobson/agents/plugins/observability-monitoring/skills/distributed-tracing/`

Phase 5 adds analytics. Phase 6 adds memory operations. Both need trace correlation:
- `job.id` as the trace root — every operation (scan, extraction, MCP call, SSE broadcast) should carry it
- Memory search latency needs measurement against the <200ms SLO
- Correlated logs: `logger.info("extraction complete", { trace_id, job_id, facts_count })`

This skill covers OpenTelemetry instrumentation patterns, span creation, and log correlation. Adapt the Python examples to TypeScript.

### `analytics-metrics` — P2 ❌
**Source:** `SkillsLib/hoodini/ai-agents-skills/skills/analytics-metrics/`

For Phase 5 analytics layer and Phase 6 memory metrics. Covers metric naming conventions, counter vs gauge vs histogram, and dashboard query patterns. Prevents the common mistake of instrumenting everything as a counter when histograms are needed for latency distributions.

### `slo-implementation` — P2 ❌
**Source:** `SkillsLib/wshobson/agents/plugins/observability-monitoring/skills/slo-implementation/`

Phase 6 defines these SLOs:
- Memory search: <200ms p95
- Memory extraction: >90% of jobs generate memories
- Agent effectiveness: 30% reduction in repeated errors

This skill covers how to define, measure, and alert on SLOs without instrumenting every endpoint manually.

---

## 7. Security

### `security-best-practices` — P1 ❌
**Source:** `SkillsLib/tech-leads-club/agent-skills/packages/skills-catalog/skills/(security)/security-best-practices/`

The dashboard serves at `localhost:3333` but the memory routes will contain sensitive agent learnings. The skill covers:
- Input validation on all API endpoints (Zod schema enforcement)
- `MEMORY_FILE_PATH` and `MEM0_API_KEY` secret handling — never log, never echo in responses
- Rate limiting on memory write endpoints (extraction pipeline abuse)
- CORS policy for the SPA — currently wide open, needs tightening for production

### `accelint-security-best-practices` — P1 ❌
**Source:** `SkillsLib/gohypergiant/agent-skills/skills/accelint-security-best-practices/`

More TypeScript-specific than the above. Covers injection prevention, input validation patterns, authentication for API routes, and secrets management in TypeScript. Complementary to the TLC version.

---

## 8. Frontend / Dashboard

### `agenthq-dashboard` — P0 ✅ (installed)
Already active. Use for all dashboard component work.

### `frontend-design` — P1 ✅ (installed)
Already active. Use for memory browser UI layout and component design.

### `web-accessibility` — P2 ✅ (installed)
Already active. Apply when building memory browser search and CRUD UI.

### `premium-frontend-ui` — P2 ❌
**Source:** `SkillsLib/github/awesome-copilot/skills/premium-frontend-ui/`

The memory browser (Phase 6.4) needs a polished timeline, graph, and search UI. This skill covers high-quality vanilla TypeScript UI patterns without a framework — directly applicable to AgentHQ's no-framework constraint.

---

## 9. Development Workflow

### `context-map` — P0 ❌
**Source:** `SkillsLib/github/awesome-copilot/skills/context-map/`

**Mandatory before starting any phase.** Produces a dependency map (files to modify, test files, reference patterns) before touching code. Prevents discovering missed dependencies mid-implementation. Saves 3–5 turns per task.

### `diagnose` — P0 ✅ (installed)
Already active. Use when a bug is reported or something breaks.

### `debugging-strategies` — P0 ✅ (installed)
Already active. Complements `diagnose`.

### `refactor-plan` — P1 ❌
**Source:** `SkillsLib/github/awesome-copilot/skills/refactor-plan/`

When Phase 6 `src/memory/` needs to integrate with the existing `src/scan/` and `src/routes/` modules, a refactor plan prevents scope creep and ensures the new module stays decoupled. Produces a structured refactor plan before any file is touched.

---

## Summary Install Table

| Skill | Source (relative to `c:\repos\SkillsLib\`) | Priority | Status |
|-------|-------------------------------------------|----------|--------|
| `bun` | `hoodini/ai-agents-skills/skills/bun/` | P0 | ❌ |
| `nodejs-backend-patterns` | `wshobson/agents/plugins/javascript-typescript/skills/nodejs-backend-patterns/` | P0 | ❌ |
| `javascript-testing-patterns` | `wshobson/agents/plugins/javascript-typescript/skills/javascript-testing-patterns/` | P0 | ❌ |
| `context-map` | `github/awesome-copilot/skills/context-map/` | P0 | ❌ |
| `architecture-patterns` | `wshobson/agents/plugins/backend-development/skills/architecture-patterns/` | P1 | ❌ |
| `api-design-principles` | `wshobson/agents/plugins/backend-development/skills/api-design-principles/` | P1 | ❌ |
| `typescript-advanced-types` | `wshobson/agents/plugins/javascript-typescript/skills/typescript-advanced-types/` | P1 | ❌ |
| `distributed-tracing` | `wshobson/agents/plugins/observability-monitoring/skills/distributed-tracing/` | P1 | ❌ |
| `security-best-practices` | `tech-leads-club/agent-skills/packages/skills-catalog/skills/(security)/security-best-practices/` | P1 | ❌ |
| `accelint-security-best-practices` | `gohypergiant/agent-skills/skills/accelint-security-best-practices/` | P1 | ❌ |
| `refactor-plan` | `github/awesome-copilot/skills/refactor-plan/` | P1 | ❌ |
| `analytics-metrics` | `hoodini/ai-agents-skills/skills/analytics-metrics/` | P2 | ❌ |
| `slo-implementation` | `wshobson/agents/plugins/observability-monitoring/skills/slo-implementation/` | P2 | ❌ |
| `e2e-testing-patterns` | `wshobson/agents/plugins/developer-essentials/skills/e2e-testing-patterns/` | P2 | ❌ |
| `premium-frontend-ui` | `github/awesome-copilot/skills/premium-frontend-ui/` | P2 | ❌ |
| **Already installed** | | | |
| `ts-best-practices` | — | — | ✅ |
| `ts-testing` | — | — | ✅ |
| `ts-performance` | — | — | ✅ |
| `ts-documentation` | — | — | ✅ |
| `ts-advanced-types` | — | — | ✅ |
| `agenthq-dashboard` | — | — | ✅ |
| `debugging-strategies` | — | — | ✅ |
| `diagnose` | — | — | ✅ |
| `error-handling-patterns` | — | — | ✅ |
| `improve-codebase-architecture` | — | — | ✅ |
| `frontend-design` | — | — | ✅ |
| `web-accessibility` | — | — | ✅ |
| `memory-consolidation` | — | — | ✅ |

---

## Skills Activation Rules (add to `tech-core.md`)

```
| `bun`                         | Any Bun API usage: Bun.serve, Bun.file, bun:sqlite, Bun.spawn, bun build, bun test |
| `nodejs-backend-patterns`     | Adding routes, middleware, graceful shutdown, health checks, new src/routes/*.ts |
| `javascript-testing-patterns` | Writing tests with mocks, DI, fixture factories, integration tests |
| `architecture-patterns`       | Designing new modules (src/memory/, src/library/), enforcing layer boundaries |
| `api-design-principles`       | New API endpoints, pagination, error shapes, HTTP method semantics |
| `typescript-advanced-types`   | Generics, conditional types, mapped types, src/types.ts changes |
| `distributed-tracing`         | Adding trace IDs, span correlation, latency measurement |
| `analytics-metrics`           | New metric dimensions, counter vs histogram decisions |
| `slo-implementation`          | Defining or measuring memory/scan/API latency SLOs |
| `security-best-practices`     | New endpoints, secret handling, input validation, CORS |
| `context-map`                 | Before starting any implementation sub-phase |
| `refactor-plan`               | Before touching existing modules to add new features |
| `premium-frontend-ui`         | Memory browser, new dashboard pages, complex UI components |
```
