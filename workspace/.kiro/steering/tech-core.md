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

Skills are NOT activated automatically. Call `disclose_context` before starting any
matching task.

| Skill | Activate when… |
|-------|---------------|
| `agenthq-dashboard` | Any work on dashboard files, monitor.ts, routes, workers |
| `accelint-ts-best-practices` | Writing or reviewing any TypeScript code |
| `accelint-ts-testing` | Writing tests, fast-check property tests |
| `accelint-ts-performance` | Performance audit, hot-path optimisation |
| `accelint-ts-documentation` | JSDoc, comment audits |
| `typescript-advanced-types` | Generics, conditional types, mapped types |
| `javascript-testing-patterns` | Test infrastructure, mocking, TDD |
| `modern-javascript-patterns` | ES6+ refactoring, async/await, functional |
| `debugging-strategies` | Bug investigation, unexpected behaviour |
| `error-handling-patterns` | Error handling design, resilience |
| `frontend-design` | UI component or page work |
| `design-system-patterns` | Design tokens, theming |
| `interaction-design` | Microinteractions, transitions, polish |
| `responsive-design` | Adaptive layouts |
| `accessibility` | WCAG, screen reader, keyboard nav |
| `improve-codebase-architecture` | Refactoring, reducing coupling |
| `diagnose` | User reports bug, something is broken |
| `best-practices` | Security, code quality review |
| `memory-consolidation` | User says "dream", "consolidate", "clean memory" |


## Memory MCP — use proactively

The `memory` MCP server (in agenthq-memory power) is the persistent knowledge graph.

- **Read at session start**: call `read_graph` to check known facts before re-deriving
- **Write after validation**: persist architecture decisions, confirmed bugs, design choices
- **Key entities**: module structure decisions, API contracts, known issues, design tokens
- **Consolidate**: when user says "dream" or "consolidate", activate memory-consolidation skill

## Memory Server Default Path

Found during Phase 0.5 pre-flight (advisory, best-effort extraction): `if (process.env.MEMORY_FILE_PATH) {`. If this does not clearly show the default path logic, refer to the package source or rely on Phase 9 runtime verification.
