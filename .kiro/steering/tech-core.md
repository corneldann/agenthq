---
inclusion: always
---

# AgentHQ — Tech Core Reference

## What AgentHQ is

A general-purpose developer agent monitor and dashboard. Watches Kiro agent session
output directories and provides:
- Live dashboard (Bun HTTP server at localhost:3333)
- Session chain and job tracking
- Queue poller (CRAWL, CLONE, PROMPT, BUILD queues)
- Git integration (status + commit/push via worker script)
- SSE live updates

## Key paths (all from .env)

| Env var | Purpose |
|---------|---------|
| `OUTPUT_DIR` | Agent job output files (.md, .log, .chain) |
| `SESSIONS_DIR` | Kiro session state JSON files |
| `WORKSPACE_ROOT` | Root of monitored workspace (for git ops) |
| `PORT` | Server port (default 3333) |

## Tech stack

- Runtime: **Bun** (TypeScript native, no build step for server)
- Dashboard: **TypeScript SPA** built with `bun build`
- Tests: **bun test** + **fast-check** for property-based tests
- No framework — vanilla TypeScript throughout

## Key commands

```powershell
# Start server
bun src/monitor.ts

# Build dashboard
bun build src/dashboard/index.html --outdir dist --minify

# Run tests
bun test test/

# Type check
node_modules\.bin\tsc.exe --noEmit
```


## Module structure

```
src/
├── monitor.ts          Entry point — Bun.serve, route registration, worker startup
├── types.ts            Domain interfaces
├── constants.ts        Path constants (all from process.env)
├── router.ts           Router interface and createRouter()
├── scan/               Pure async file-reading functions (no HTTP dependency)
│   ├── helpers.ts      String-parsing utilities
│   ├── jobs.ts         scanJobs()
│   ├── sessions.ts     scanSessions()
│   ├── chains.ts       scanChains()
│   └── cache.ts        invalidateScanCache()
├── workers/            Background processes started once at startup
│   ├── ssebroadcaster.ts   2s SSE broadcast interval
│   ├── queuePoller.ts      10s queue polling interval
│   ├── backfill.ts         One-shot startup backfill
│   └── summariseState.ts   Summarise map + auto-mark loop
├── routes/             HTTP route handlers (each exports register(router))
│   ├── chains.ts       /chains, /sessions, /job-chains, /timeline/:id
│   ├── jobs.ts         /jobs, /log/:id, /build-queue
│   ├── summarise.ts    /summarise/:id, /summarise-chain/:id etc.
│   ├── resume.ts       /resume/:id, /handoff, /view-chain/:id
│   ├── git.ts          /git-status, /git-commit
│   ├── build.ts        /build-status, /build-stream
│   ├── chain-management.ts  /hide-chain, /unhide-chain, /update-chain-name
│   ├── system.ts       /system-status, /stop, /shutdown, /restart
│   ├── sse.ts          /events (SSE endpoint)
│   └── static.ts       / (dashboard), /poll-log, static files
└── dashboard/          TypeScript SPA (compiled to dist/)
    ├── index.html      Entry point
    ├── types.ts        Shared interfaces
    ├── state.ts        Observable state store
    ├── api.ts          Typed fetch calls
    ├── main.ts         Bootstrap, routing, SSE
    ├── toast.ts        Toast notifications
    ├── palette.ts      Cmd+K command palette
    ├── utils.ts        Helpers (esc, icon, fmtUptime)
    ├── styles.css      Global styles
    ├── pages/          Page components (dashboard, work, activity)
    └── components/     Reusable components (chainCard, gitSection etc.)
```


## Skills Index — MANDATORY ACTIVATION RULES

Skills are NOT activated automatically by Kiro during spec task execution. The skill
activation mechanism matches against *conversational requests* — not against internal
task runner invocations. You must call `disclose_context` explicitly.

### SPEC TASK EXECUTION — Always activate these first

**Before executing ANY spec task**, call `disclose_context` for these two — they apply
to every task in this TypeScript/Bun workspace without exception:

```
MANDATORY for every spec task:
1. accelint-ts-best-practices   ← type safety, defensive programming, naming, control flow,
                                   zero-value pattern, avoid any/enum/null, return values
2. accelint-ts-testing          ← bun test + fast-check, AAA pattern, avoid loose assertions
                                   (toBeTruthy), avoid over-mocking, property-based tests
```

**Additionally, activate based on what the specific task touches:**

| Task touches | Activate | Key coverage |
|---|---|---|
| `src/routes/**`, new HTTP endpoints, API error shapes | `error-handling-patterns` | Exceptions vs Result types, fail fast, don't swallow errors, async error propagation |
| `src/dashboard/**`, `.html`, `.css`, SSE, UI components | `agenthq-dashboard` | Component contract (pure fn → string), state model, XSS via `esc()`, build command |
| Performance, O(n²) complexity, query timing, allocations | `accelint-ts-performance` | V8 profiling, Map/Set for O(1) lookups, avoid array method chaining, try/catch in loops |
| JSDoc, `@param`/`@returns`, comment quality, TODO/FIXME | `accelint-ts-documentation` | Two-tier rule (exported vs internal), @example code fences, dot notation for object params |
| Generics, conditional types, mapped types, `src/types.ts` | `typescript-advanced-types` | infer, template literals, utility types, discriminated unions |
| Refactoring, module coupling, testability, seam finding | `improve-codebase-architecture` | Depth vs shallow modules, deletion test, seam/adapter/leverage vocabulary |
| Bug investigation, something broken/throwing/failing | `diagnose` | Reproduce → minimise → hypothesise → instrument → fix → regression-test loop |
| Security, input validation, SQL injection, XSS | `best-practices` | CSP, parameterized queries, input sanitization, no vulnerable deps |
| ES6+ refactoring, async/await patterns, functional style | `modern-javascript-patterns` | Destructuring, optional chaining, nullish coalescing, promise patterns |
| Test infrastructure, mocking, DI patterns, fixtures | `javascript-testing-patterns` | Jest/Vitest setup, dependency injection, fixture factories, `supertest` integration tests |
| User says "diagnose this", performance regression | `debugging-strategies` | Scientific method loop, binary search, differential debugging, memory leak detection |
| Systematic bug with unclear root cause | `diagnose` | Phase-based diagnosis, feedback loop construction, instrumentation tagging |
| User says "dream", "consolidate", "clean memory" | `memory-consolidation` | Four-phase consolidation, supersession semantics, ≤50 entity target |

**UI/design skills — activate only for dashboard or frontend work:**

| Task touches | Activate | Key coverage |
|---|---|---|
| New UI components, visual identity, typography choices | `frontend-design` | Distinctive design, typography pairing, avoiding templated defaults |
| Design tokens, theme switching, component library architecture | `design-system-patterns` | Primitive → semantic → component token hierarchy, CSS custom properties |
| CSS Grid, container queries, mobile-first breakpoints | `responsive-design` | Fluid typography, container queries, breakpoint strategy |
| Microinteractions, loading states, transitions | `interaction-design` | Motion timing (100-500ms), spring animations, `prefers-reduced-motion` |
| Design tokens + theming + component variants (full system) | `ux-design-systems` | CVA variant system, ThemeProvider, dark mode with `data-theme` |
| Typography scale, 8-point grid, colour contrast | `visual-design-foundations` | WCAG contrast ratios, spacing system, semantic colour tokens |
| WCAG compliance, screen readers, keyboard nav | `accessibility` | POUR principles, focus management, ARIA roles, skip links |

### Why skills don't auto-activate during spec tasks

Kiro's skill activation matches skill `description` fields against **user chat messages**.
During spec task execution there is no user message — Kiro runs tasks autonomously via
the task runner. The result: all skill descriptions like "Use when writing TypeScript code"
never match anything. The fix is explicit `disclose_context` calls before writing code.

**Each skill uses progressive disclosure internally** — activating it loads only the SKILL.md
overview. The skill then directs the agent to load specific `references/*.md` files only
when a matching pattern is encountered. This keeps context lean while providing deep guidance
on demand.

### Activation call pattern

```
// Every spec task (minimum):
disclose_context("accelint-ts-best-practices")
disclose_context("accelint-ts-testing")

// Backend/DB task (most Phase 5.x tasks):
disclose_context("accelint-ts-best-practices")
disclose_context("accelint-ts-testing")
disclose_context("error-handling-patterns")

// Dashboard task:
disclose_context("accelint-ts-best-practices")
disclose_context("accelint-ts-testing")
disclose_context("agenthq-dashboard")

// Security-sensitive task (input validation, SQL, auth):
disclose_context("accelint-ts-best-practices")
disclose_context("accelint-ts-testing")
disclose_context("error-handling-patterns")
disclose_context("best-practices")
```

### Full skill registry — registered names and folder names

Use the registered `name` (from SKILL.md frontmatter) with `disclose_context`, not the folder name:

| Folder | Registered name (`disclose_context` argument) |
|--------|----------------------------------------------|
| `ts-best-practices` | `accelint-ts-best-practices` |
| `ts-testing` | `accelint-ts-testing` |
| `ts-performance` | `accelint-ts-performance` |
| `ts-documentation` | `accelint-ts-documentation` |
| `ts-advanced-types` | `typescript-advanced-types` |
| `js-testing-patterns` | `javascript-testing-patterns` |
| `modern-js-patterns` | `modern-javascript-patterns` |
| `agenthq-dashboard` | `agenthq-dashboard` |
| `error-handling-patterns` | `error-handling-patterns` |
| `debugging-strategies` | `debugging-strategies` |
| `diagnose` | `diagnose` |
| `improve-codebase-architecture` | `improve-codebase-architecture` |
| `web-best-practices` | `best-practices` |
| `web-accessibility` | `accessibility` |
| `memory-consolidation` | `memory-consolidation` |
| `frontend-design` | `frontend-design` |
| `design-system-patterns` | `design-system-patterns` |
| `responsive-design` | `responsive-design` |
| `interaction-design` | `interaction-design` |
| `ux-design-systems` | `ux-design-systems` |
| `visual-design-foundations` | `visual-design-foundations` |

### SPEC GENERATION — Preamble template for tasks.md

Every generated `tasks.md` must include this section immediately after the H1:

```markdown
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
```

Do NOT add skill hints to `requirements.md` or `design.md` — those documents describe
what to build, not how to build it. Skill activation belongs in `tasks.md` only.


## Memory MCP — use proactively

The `memory` MCP server (in agenthq-memory power) is the persistent knowledge graph.

- **Read at session start**: call `read_graph` to check known facts before re-deriving
- **Write after validation**: persist architecture decisions, confirmed bugs, design choices
- **Key entities**: module structure decisions, API contracts, known issues, design tokens
- **Consolidate**: when user says "dream" or "consolidate", activate memory-consolidation skill

## Dev Skills Reference

Full research and install instructions: `docs/DEV-SKILLS-RECOMMENDATIONS.md`

P0 skills to install before any Phase 5+ work: `bun`, `nodejs-backend-patterns`, `javascript-testing-patterns`, `context-map`

## Memory Server Default Path

Found during Phase 0.5 pre-flight (advisory, best-effort extraction): `if (process.env.MEMORY_FILE_PATH) {`. If this does not clearly show the default path logic, refer to the package source or rely on Phase 9 runtime verification.

## Spec Format

Spec documents under `.kiro/specs/` must pass Kiro Spec Format validation.
Full rules in `spec-format-rules.md`. Key constraints:

| File | H1 must be exactly | Required sections |
|------|--------------------|-------------------|
| `requirements.md` | `# Requirements Document` | Introduction, Glossary, Requirements |
| `design.md` | `# Design Document` | Overview, Architecture, Data Models |
| `tasks.md` | `# Tasks` | At least one Task section |

`design.md` should also include `## Correctness Properties` and `## Error Handling` (warnings if absent).

**Never append a phase name or subtitle to the H1.** Put the descriptive name in the first section body instead.
