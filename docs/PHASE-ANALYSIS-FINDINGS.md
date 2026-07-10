# AgentHQ Phases 5–8: Analysis and Findings

**Analysis Date**: July 3, 2026  
**Skills Applied**: `context-map`, `architecture-patterns`, `api-design-principles`, `bun`, `typescript-advanced-types`, `ts-best-practices`, `ts-performance`, `agentic-eval`, `rag-implementation`, `memory-merger`

---

## Executive Summary

The 4-phase roadmap (Phases 5–8) forms a well-structured progression where each phase builds on the last. The architecture decisions are fundamentally sound, but there are **11 high-severity issues** and **22 medium-severity gaps** that must be addressed before implementation.

**Key Findings**:
- ✅ Database-first redesign (Phase 5) solves the current performance bottleneck
- ✅ Mem0 integration (Phase 6) is the right choice over custom implementation
- ✅ Library management (Phase 7) architecture follows proven package manager patterns
- ⚠️ Several SQL incompatibilities and TypeScript architectural gaps identified
- ⚠️ Cross-phase dependencies must be explicitly sequenced
- ⚠️ Token budget and security patterns need strengthening

---

## Phase 5 — Observability Platform

### What It Adds
- SQLite persistence replacing file-scan-every-5s pattern
- WebSocket bidirectional communication
- Analytics dashboard with Chart.js visualization

### Strengths ✅

1. **Database-first is correct** — Current file scanning every 5s is the biggest performance problem; replacing with `bun:sqlite` + file watchers is the right architectural shift
2. **Hybrid approach is safe** — Files remain source of truth, DB is derived index with fallback to file scanning if DB unavailable
3. **Schema is well-indexed** — `idx_workspace_status`, `idx_workspace_timestamp` match actual query patterns
4. **Native WebSocket** — Using `Bun.serve` upgrade is correct; no extra library needed

### Critical Issues 🔴


| Issue | Impact | Mitigation |
|-------|--------|------------|
| **SQLite doesn't support `PERCENTILE_CONT`** | Bottleneck detection SQL will fail at runtime | Use window function alternative: `SELECT duration FROM (SELECT duration, ROW_NUMBER() OVER (ORDER BY duration) as rn, COUNT(*) OVER () as cnt FROM metrics) WHERE rn = CAST(cnt * 0.5 AS INTEGER)` |
| **WebSocket upgrade requires `undefined` return** | Upgrade handshake fails silently if `fetch` returns Response | Spec must document: `server.upgrade(req)` returns boolean; handler must `return undefined` on true |
| **Phase 5 DB tables not specified for Phase 6** | Phase 6.2 memory extraction status has nowhere to write | Add `memory_extraction` table in Phase 5 schema: `(job_id, extracted_at, memory_count, status)` |

### Medium-Severity Gaps 🟡

| Issue | Recommendation |
|-------|----------------|
| **File watchers unreliable on Windows** | Design polling fallback explicitly; use 10s interval when `Bun.watch` event count < expected |
| **Chart.js bundle size** | Document explicit `bun build` minification; consider lazy-loading chart page |
| **SSE + WebSocket coexistence** | Choose primary (WebSocket for dashboard, SSE for legacy clients); deprecation timeline |
| **DB migration strategy missing** | Version schema (v1, v2, ...); `bun:sqlite` PRAGMA user_version for tracking |
| **Concurrent writes to SQLite** | Use WAL mode (`PRAGMA journal_mode=WAL`); single writer queue pattern |

### Skills Required for Phase 5 Implementation
- `bun` — WebSocket upgrade, `bun:sqlite` API, file watching
- `ts-best-practices` — DB query builder type safety, discriminated unions for messages
- `ts-performance` — Audit `src/scan/jobs.ts` before adding DB layer
- `ts-testing` — In-memory SQLite (`:memory:`) for test isolation
- `agenthq-dashboard` — Analytics page, Chart.js components, WebSocket client

---

## Phase 6 — Agent Memory Management

### What It Adds
- Mem0/Hindsight MCP integration
- 5-scope memory model (user/workspace/agent/run/chain)
- Memory extraction pipeline with quality gating
- Memory browser UI

### Strengths ✅


1. **Mem0 over custom is correct** — Benchmarks (92.5 LoCoMo, 6,900 tokens vs 26,000) are validated; production-proven
2. **5-scope model aligns with Mem0 API** — No translation layer needed; direct passthrough
3. **Karpathy wiki pattern is sound** — `mini-context-graph` for extraction pipeline matches research
4. **Quality gating from day one** — `agentic-eval` prevents noisy memory accumulation

### Critical Issues 🔴

| Issue | Impact | Mitigation |
|-------|--------|------------|
| **`src/memory/client.ts` must be a port** | Hardcoding to Mem0 makes switching to Hindsight a full rewrite | Define `IMemoryClient` interface first; both Mem0 and Hindsight implementations satisfy it |
| **Phase 6 depends on Phase 5 DB** | Memory extraction status per job needs Phase 5 `memory_extraction` table | Must sequence: Phase 5 DB complete → Phase 6 starts |
| **No MCP server failure handling** | Mem0 API down → entire memory layer fails | Circuit breaker pattern: 3 consecutive failures → fallback to read-only mode (server-memory cache) |

### Medium-Severity Gaps 🟡

| Issue | Recommendation |
|-------|----------------|
| **Token budget enforcement naive** | "Top-10 memories" can exceed budget if memories are long | Count tokens first; inject descending by relevance until budget reached |
| **Memory browser pagination missing** | Loading 1000+ memories in UI will crash browser | Server-side pagination: 50 items per page, cursor-based |
| **Extraction quality rubric weights not validated** | Accuracy 0.4, relevance 0.3, specificity 0.3 are guesses | Run 100-job backfill test; measure F1 score; adjust weights |
| **No memory deletion policy** | Stale/wrong memories accumulate forever | Implement supersession pattern: new fact marks old as `[SUPERSEDED]` |
| **Auto Dream consolidation timing unclear** | "Every 24h + 5 sessions" — which fires first? | Use OR condition: consolidate if (last_consolidation > 24h) OR (session_count_since > 5) |
| **Voyage-3-large embeddings cost not estimated** | 1M tokens = $0.12; 10K jobs × 500 tokens avg = $0.60/backfill | Budget $5-10/month for steady-state; one-time $1-2 for backfill |

### Skills Required for Phase 6 Implementation
- `memory-merger` — Episodic → steering graduation logic
- `agentic-eval` — Extraction quality rubric implementation
- `rag-implementation` — Hybrid retrieval (semantic + BM25 + MMR)
- `mini-context-graph` — Wiki pattern for job completion → ingest
- `context-map` — Mandatory pre-phase context gathering
- `api-design-principles` — 8 new `/memory/*` routes

---

## Phase 7 — Library Management System

### What It Adds
- Central hub for Powers, Skills, Reference libraries
- Discovery, installation, version control via Git
- Usage analytics and recommendations

### Strengths ✅

1. **"npm for AI agents" is the right vision** — Proven package manager patterns apply
2. **Git-based versioning is correct** — No custom VCS; leverage `git fetch --tags`, checkout by tag
3. **SQLite registry separation** — Powers/Skills/Reference as separate tables with shared columns is normalized
4. **Background scanner pattern** — Non-blocking; doesn't slow down main monitor loop

### Critical Issues 🔴

| Issue | Impact | Mitigation |
|-------|--------|------------|
| **No conflict resolution for duplicate names** | `awesome-copilot/skills/memory-merger` vs `wshobson/skills/memory-merger` | Use namespaced names: `{org}/{repo}/{type}/{name}` as primary key |
| **Installation path strategy unspecified** | User-level vs workspace-level install unclear | Follow npm: `--global` → `~/.kiro/{skills,powers}/`, workspace-level → `.kiro/{skills,powers}/` |
| **Git credential handling missing** | Private repos fail silently | Detect auth failure; prompt for PAT; store in system keychain (Windows Credential Manager) |

### Medium-Severity Gaps 🟡

| Issue | Recommendation |
|-------|--------|
| **Semantic versioning not enforced** | Tags like `v1`, `latest`, `2024-06-01` mixed | Parse semver; fallback to date-based for non-semver tags; warn on `latest` |
| **Dependency resolution missing** | Skill A requires Skill B → manual install | Add `dependencies` field to skill/power metadata; recursive install |
| **Usage analytics privacy concern** | Tracking which skills are used may leak sensitive project info | Make opt-in; anonymize workspace paths; aggregate counts only |
| **No rollback mechanism** | Bad install breaks workspace; no undo | Keep previous version in `.kiro/backups/{type}/{name}/{version}/`; `/library/rollback` route |
| **Search UX unspecified** | Full-text search on descriptions can return 100+ results | Faceted search: filter by type, org, keyword tags; rank by usage count |
| **README rendering security** | Malicious markdown could inject script tags | Use sanitized markdown renderer (no HTML passthrough) |

### Skills Required for Phase 7 Implementation
- `nodejs-backend-patterns` — Background scanner worker pattern
- `api-design-principles` — REST semantics for `/library/*` routes
- `ts-best-practices` — Git subprocess error handling (Bun.spawn)
- `agenthq-dashboard` — Library browser UI, search, install buttons
- `security-best-practices` — Git URL validation, credential storage

---

## Phase 8 — Repository Management

### What It Adds
- Multi-repo dashboard (status, commits, branches across all monitored repos)
- Git operations from UI (commit, push, branch management)
- Repository-scoped memory integration

### Strengths ✅

1. **Repository memory scoping is architecturally sound** — Extends Phase 6 memory model with `repo_id` dimension
2. **Reusing Phase 5 git-commit-worker.ps1 pattern** — Proven worker script pattern; just generalize from single workspace
3. **Real-time status monitoring** — `git status --porcelain` parsing already works in current codebase

### Critical Issues 🔴

| Issue | Impact | Mitigation |
|-------|--------|------------|
| **No handling of detached HEAD state** | `git status` when HEAD detached → UI breaks | Detect detached: `git symbolic-ref -q HEAD` fails → show "(detached at {sha})" in UI |
| **Concurrent git operations across repos** | User commits to repo A while repo B push is in progress → lock contention | Per-repo lock files: `.kiro/locks/{workspace_id}.lock`; queue operations per repo |
| **Phase 8 depends on Phase 5 DB + Phase 6 memory** | Repository table, memory scoping both required | Must sequence: Phase 5 complete → Phase 6 complete → Phase 8 starts |

### Medium-Severity Gaps 🟡

| Issue | Recommendation |
|-------|----------------|
| **Branch switching from UI is risky** | Uncommitted changes → `git checkout` fails or loses work | Check `git status` first; block if working tree dirty; offer stash |
| **Merge conflict handling missing** | `git pull` with conflicts → worker script fails silently | Detect merge markers in `git status`; surface in UI; offer manual resolution prompt |
| **Submodule support unspecified** | Repos with submodules → `git status` output changes | Parse `git submodule status`; show submodule state in UI |
| **Git LFS large file handling** | LFS repos → slow `git status`, large clones | Detect `.gitattributes` with `filter=lfs`; warn user; use `GIT_LFS_SKIP_SMUDGE=1` for status checks |
| **No rate limiting on git operations** | User spam-clicks Commit → 10 worker scripts spawned | Debounce: 500ms; disable button while operation in progress |
| **Repository memory search scope unclear** | Search "database schema" → results from all repos or current repo only? | Add scope toggle: "Current repo" vs "All repos"; default current |

### Skills Required for Phase 8 Implementation
- `nodejs-backend-patterns` — Per-repo worker queue pattern
- `ts-best-practices` — Git subprocess error handling, lock file coordination
- `agenthq-dashboard` — Multi-repo status cards, branch dropdowns
- `memory-merger` — Repository-scoped memory graduation logic
- `rag-implementation` — Repo-scoped memory retrieval

---

## Cross-Cutting Concerns

### Dependency Sequencing (Critical Path)

```
Phase 5 (DB + WebSocket)
    ↓
Phase 6 (Memory) — requires Phase 5 `memory_extraction` table
    ↓
Phase 7 (Library Mgmt) — can run parallel to Phase 6
    ↓
Phase 8 (Repo Mgmt) — requires Phase 5 DB + Phase 6 memory scoping
```

**Recommendation**: Implement in strict sequence 5 → 6 → 8. Phase 7 can overlap with Phase 6 if needed.

---

### Security Issues Across All Phases

| Issue | Affected Phases | Mitigation |
|-------|----------------|------------|
| **MCP API keys in plaintext** | 6 | Store `MEM0_API_KEY` in system keychain; read at runtime |
| **Git credential storage** | 7, 8 | Use Windows Credential Manager; never log credentials |
| **WebSocket origin validation missing** | 5 | Check `Origin` header; reject if not `localhost:3333` or configured domain |
| **SQL injection in search** | 5, 6, 7 | Use parameterized queries; never string concatenation |
| **Path traversal in file operations** | 7 | Validate install paths; reject `..` in skill/power names |

---

### Performance Hotspots

| Location | Current State | Phase Impact | Recommendation |
|----------|---------------|--------------|----------------|
| `src/scan/jobs.ts` | Scans 1000+ files every 5s | Phase 5 replaces with DB | ✅ Correct direction |
| Memory search | N/A | Phase 6 adds embedding search | Use Voyage-3-large batch API (50 queries/request) |
| Git status polling | Every 10s per workspace | Phase 8 multiplies by repo count | Move to on-demand + file watcher |
| Chart rendering | N/A | Phase 5 adds Chart.js | Lazy-load chart page; debounce updates |

---

### Testing Strategy Gaps

| Gap | Impact | Recommendation |
|-----|--------|----------------|
| **No integration tests for MCP clients** | Phase 6 Mem0 failures discovered in production | Mock MCP server with `bun test`; test circuit breaker |
| **No property-based tests for memory extraction** | Edge cases (empty jobs, malformed markdown) untested | Use `fast-check` to generate 1000 synthetic job files |
| **No load testing for WebSocket** | Unknown max concurrent connections | Benchmark with `ws` library: 100, 500, 1000 clients |
| **No DB migration testing** | Schema changes break existing data | Test migration path: v1 DB → apply migration → verify data intact |

---

## TypeScript Architecture Recommendations

### Port/Adapter Boundaries

Each phase adds a new external dependency. Use ports to keep core logic testable:

```typescript
// Phase 5: Database port
interface IDatabase {
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
  execute(sql: string, params: unknown[]): Promise<void>;
}

// Phase 6: Memory port
interface IMemoryClient {
  add(memory: Memory, scope: MemoryScope): Promise<string>;
  search(query: string, scope: MemoryScope): Promise<Memory[]>;
  delete(id: string): Promise<void>;
}

// Phase 7: Git port
interface IGitClient {
  status(repoPath: string): Promise<GitStatus>;
  commit(repoPath: string, message: string): Promise<void>;
  fetch(repoPath: string, remote: string): Promise<void>;
}
```

**Benefit**: Test with in-memory implementations; swap Mem0 ↔ Hindsight without touching business logic.

---

### Type Safety for Discriminated Unions

Phase 5 WebSocket messages, Phase 6 memory scopes, Phase 7 library types all need discriminated unions:

```typescript
// Phase 5: WebSocket messages
type ClientMessage = 
  | { type: 'subscribe'; workspaceId: string }
  | { type: 'unsubscribe'; workspaceId: string }
  | { type: 'ping' };

type ServerMessage =
  | { type: 'job_update'; job: Job }
  | { type: 'chain_update'; chain: Chain }
  | { type: 'pong' };

// Phase 6: Memory scopes
type MemoryScope = 
  | { level: 'user'; userId: string }
  | { level: 'workspace'; workspaceId: string }
  | { level: 'chain'; workspaceId: string; chainId: string };
```

**Benefit**: Exhaustiveness checking in `switch` statements; impossible states ruled out at compile time.

---

### Async Error Handling

All phases add async operations (DB, MCP, Git subprocess). Use Result type pattern:

```typescript
type Result<T, E = Error> = 
  | { ok: true; value: T }
  | { ok: false; error: E };

async function searchMemory(query: string): Promise<Result<Memory[]>> {
  try {
    const memories = await memoryClient.search(query);
    return { ok: true, value: memories };
  } catch (error) {
    return { ok: false, error: error as Error };
  }
}

// Usage
const result = await searchMemory('database schema');
if (!result.ok) {
  logger.error('Memory search failed', result.error);
  return [];
}
return result.value;
```

**Benefit**: Errors are values; forces explicit handling; no unhandled promise rejections.

---

## Observability & Monitoring Recommendations

### Distributed Tracing

Phases 5-8 add multiple async operations. Add trace IDs to correlate logs:

```typescript
// Add to src/types.ts
interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

// Generate at request entry
import { randomUUID } from 'crypto';
const traceId = randomUUID();

// Pass through async call chain
await extractMemory(job, { traceId, spanId: randomUUID(), parentSpanId: traceId });

// Log with context
logger.info('Memory extracted', { traceId, spanId, jobId, memoryCount: 5 });
```

**Benefit**: Debug cross-phase issues; see full request flow in logs.

---

### Metrics to Track

| Metric | Phase | Type | Why |
|--------|-------|------|-----|
| `db_query_duration_ms` | 5 | Histogram | Detect slow queries |
| `websocket_connection_count` | 5 | Gauge | Capacity planning |
| `memory_search_latency_ms` | 6 | Histogram | Mem0 API performance |
| `memory_extraction_success_rate` | 6 | Counter | Quality gate effectiveness |
| `library_install_duration_ms` | 7 | Histogram | Git clone performance |
| `git_operation_queue_depth` | 8 | Gauge | Detect backlog |

Store in Phase 5 DB `metrics` table; expose via `/metrics` endpoint for Prometheus scraping.

---

### SLO Recommendations

| Service | SLO | Measurement |
|---------|-----|-------------|
| Memory search | p95 < 500ms | Phase 6 `/memory/search` |
| DB query | p99 < 100ms | Phase 5 all queries |
| WebSocket message delivery | p50 < 50ms | Phase 5 server → client |
| Library install | p95 < 30s | Phase 7 `/library/install` |
| Git status refresh | p95 < 2s | Phase 8 `/git-status` |

Track in Phase 5 analytics dashboard; alert if violated.

---

## Implementation Readiness Checklist

### Phase 5 Prerequisites
- [ ] Install `bun` skill from SkillsLib
- [ ] Design `PERCENTILE_CONT` alternative SQL
- [ ] Specify Phase 5 DB schema with `memory_extraction` table for Phase 6
- [ ] Document WebSocket upgrade `undefined` return requirement
- [ ] Design Windows file watcher fallback pattern

### Phase 6 Prerequisites
- [ ] Phase 5 DB complete and tested
- [ ] Install all 6 memory skills: `memory-merger`, `agentic-eval`, `rag-implementation`, `mini-context-graph`, `context-map`, `memory-server`
- [ ] Design `IMemoryClient` port interface
- [ ] Estimate Voyage-3-large embedding costs
- [ ] Implement circuit breaker for MCP failures

### Phase 7 Prerequisites
- [ ] Design namespaced naming: `{org}/{repo}/{type}/{name}`
- [ ] Specify user-level vs workspace-level install paths
- [ ] Research Windows Credential Manager API for Git credentials
- [ ] Design dependency resolution algorithm

### Phase 8 Prerequisites
- [ ] Phase 5 DB complete
- [ ] Phase 6 memory scoping complete
- [ ] Design per-repo lock file pattern
- [ ] Test git subprocess error handling (detached HEAD, merge conflicts, dirty working tree)

---

## Recommended Implementation Order

### Wave 1: Foundation (Phase 5 Core)
**Duration**: 5-7 days  
**Goal**: SQLite persistence + WebSocket working

1. Design and implement `IDatabase` port
2. Create Phase 5 DB schema (including `memory_extraction` table)
3. Implement `bun:sqlite` adapter with WAL mode
4. Replace `src/scan/jobs.ts` file scanning with DB queries
5. Add WebSocket upgrade to `src/monitor.ts`
6. Test with 1000+ jobs; verify performance improvement

**Success Criteria**:
- [ ] DB query p99 < 100ms
- [ ] WebSocket connection established and message roundtrip working
- [ ] Zero file scans during normal operation

---

### Wave 2: Memory Integration (Phase 6 Core)
**Duration**: 7-10 days  
**Goal**: Mem0 extraction pipeline + basic search working

1. Design and implement `IMemoryClient` port
2. Implement Mem0 adapter with circuit breaker
3. Build extraction pipeline with `mini-context-graph` pattern
4. Implement `agentic-eval` quality gate
5. Add memory search endpoint with token budget enforcement
6. Backfill last 100 completed jobs

**Success Criteria**:
- [ ] Memory extraction quality F1 > 0.85
- [ ] Search latency p95 < 500ms
- [ ] Circuit breaker trips on 3 consecutive Mem0 failures
- [ ] Token budget never exceeded

---

### Wave 3: Analytics & Memory Browser (Phase 5 + 6 UI)
**Duration**: 5-7 days  
**Goal**: Dashboards visible and useful

1. Build Phase 5 analytics page with Chart.js
2. Implement bottleneck detection (fix `PERCENTILE_CONT` issue first)
3. Build Phase 6 memory browser UI with pagination
4. Add memory search with scope toggle (current workspace vs all)
5. Implement Auto Dream consolidation button

**Success Criteria**:
- [ ] Analytics page loads in < 1s with 1000 jobs
- [ ] Memory browser paginates at 50 items/page
- [ ] Auto Dream reduces memory count by 30-50%

---

### Wave 4: Library Management (Phase 7)
**Duration**: 10-14 days  
**Goal**: Skill/Power discovery and installation working

1. Implement namespaced naming system
2. Build Git-based library scanner
3. Implement install/uninstall with rollback
4. Add dependency resolution
5. Build library browser UI with search
6. Implement usage analytics (opt-in)

**Success Criteria**:
- [ ] Can install skill from GitHub with dependencies
- [ ] Rollback works after bad install
- [ ] Search returns relevant results ranked by usage

---

### Wave 5: Repository Management (Phase 8)
**Duration**: 7-10 days  
**Goal**: Multi-repo git operations from UI

1. Generalize `git-commit-worker.ps1` to accept repo path
2. Implement per-repo lock file pattern
3. Add detached HEAD and merge conflict detection
4. Build multi-repo status dashboard
5. Integrate repo-scoped memory search
6. Test with 5+ repos simultaneously

**Success Criteria**:
- [ ] Can commit to any monitored repo from UI
- [ ] No lock contention across concurrent operations
- [ ] Merge conflicts surfaced clearly in UI
- [ ] Memory search scoped correctly per repo

---

## Risk Mitigation Summary

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SQLite performance inadequate at 10K+ jobs | Medium | High | Benchmark early; migrate to PostgreSQL if needed |
| Mem0 API rate limits hit during backfill | High | Medium | Batch requests; add exponential backoff |
| Windows file watchers miss events | High | Low | Polling fallback already designed |
| WebSocket connection drops on network blip | Medium | Medium | Auto-reconnect with exponential backoff |
| Git credential handling fails on CI/CD | Low | Medium | Document PAT setup; test in CI early |

---

### Organizational Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Scope creep adding features mid-phase | High | High | Strict phase boundaries; "defer to Phase 9" discipline |
| Skills not installed before phase starts | Medium | High | Checklist verification before each wave |
| Cross-phase dependencies break sequencing | Medium | High | Enforce: Phase 5 → 6 → 8; test integration points |
| Memory extraction quality too noisy | Medium | High | `agentic-eval` gates from day one; F1 > 0.85 threshold |

---

## Open Questions Requiring Decisions

### Phase 5 Decisions

1. **Database choice final?** — SQLite is correct for single-user, but if AgentHQ becomes multi-user, PostgreSQL migration needed. Decide threshold now (e.g., "migrate if >3 concurrent users").

2. **SSE deprecation timeline?** — WebSocket replaces SSE for dashboard, but legacy clients may exist. Deprecate immediately or support both for 6 months?

3. **Chart.js bundle cost acceptable?** — 200KB addition; alternative is custom SVG charts (lighter but more work). Approve Chart.js or defer analytics visualization?

---

### Phase 6 Decisions

4. **Mem0 vs Hindsight final?** — Spec recommends Mem0 for production maturity. Hindsight is MIT-licensed and free but less proven. Decide now or implement `IMemoryClient` port and decide later?

5. **Memory retention policy?** — Stale memories: delete after 90 days, mark as `[SUPERSEDED]`, or keep forever? Affects storage costs and search quality.

6. **Backfill strategy?** — Full backfill of all historical jobs (expensive), last 100 jobs only (cheap), or on-demand as user opens old jobs? Affects initial Mem0 costs.

7. **Auto Dream triggers?** — "24h OR 5 sessions" — acceptable, or should it be more/less aggressive? Related: should consolidation block user actions or run in background?

---

### Phase 7 Decisions

8. **Approval workflow for installs?** — Should installing a skill require confirmation dialog, or trust the user? Related: should installs be reversible with one click?

9. **Private repo support priority?** — Phase 7.1 supports public GitHub only; private repos require credential handling (Phase 7.3). Can defer or must-have?

10. **Dependency auto-install?** — If Skill A requires Skill B, auto-install B or prompt user? Auto-install is npm-like but could surprise users.

---

### Phase 8 Decisions

11. **Repository memory scope default?** — When searching memory, default to current repo or all repos? UX tradeoff: current repo is focused, all repos is comprehensive.

12. **Git operations audit log?** — Should every commit/push be logged to DB for audit trail? Adds safety but increases DB size.

13. **Submodule support?** — Defer to Phase 9 or implement in Phase 8.2? Affects timeline and complexity.

---

## Skills Installation Priority

### P0: Must Install Before Phase 5
- `bun` — Core Bun.serve, bun:sqlite, Bun.spawn APIs
- `ts-best-practices` — Foundation for all TypeScript work
- `agenthq-dashboard` — Dashboard changes every phase

### P1: Must Install Before Phase 6
- `memory-merger` — Episodic → steering graduation
- `agentic-eval` — Extraction quality gating
- `rag-implementation` — Hybrid retrieval
- `mini-context-graph` — Wiki pattern
- `context-map` — Mandatory pre-phase context

### P2: Recommended Before Phase 7
- `nodejs-backend-patterns` — Background workers
- `api-design-principles` — REST semantics
- `security-best-practices` — Git credential handling

---

## Conclusion

The 4-phase roadmap is **architecturally sound** but has **33 identified issues** (11 critical, 22 medium) that must be addressed before implementation.

**Key Recommendations**:
1. **Strict sequencing**: Phase 5 → 6 → 8 (Phase 7 can overlap with 6)
2. **Port/adapter architecture**: Define interfaces first for all external dependencies
3. **Install P0 skills immediately**: `bun`, `ts-best-practices`, `agenthq-dashboard`
4. **Fix SQL incompatibilities**: `PERCENTILE_CONT` alternative, parameterized queries
5. **Security first**: Keychain for secrets, input validation, origin checks
6. **Test early**: Property-based tests for memory extraction, load tests for WebSocket

**Timeline Estimate**: 34-48 days total (7-10 weeks) if executed sequentially with proper skill activation and issue mitigation.

---

## Related Documents

- **Phase Specifications**:
  - `docs/prompts/phase-5-observability-platform.md`
  - `docs/prompts/phase-6-agent-memory-management.md`
  - `docs/prompts/phase-7-library-management.md`
  - `docs/prompts/phase-8-repository-management.md`

- **Skills Research**:
  - `docs/DEV-SKILLS-RECOMMENDATIONS.md`

- **Steering Files**:
  - `.kiro/steering/tech-core.md` — Architecture and skills activation rules
  - `.kiro/steering/memory-management.md` — Memory patterns and Auto Dream
  - `.kiro/steering/agent-batching.md` — Turn minimization rules
  - `.kiro/steering/task-concurrency.md` — Sequential subagent constraint

- **Memory Research Foundation**:
  - `ReferenceLib/claude/anthropic.com/memory-architecture-full-writeup.md`

---

**Document Version**: 1.0  
**Last Updated**: July 3, 2026  
**Next Review**: After Phase 5 Wave 1 completion
