---
name: agenthq-dashboard
description: Build, modify, and debug the AgentHQ Monitor dashboard — a 12-file TypeScript SPA served by Bun at localhost:3333. Use when editing any file under agenthq/src/dashboard/, adding new pages or components, wiring new API endpoints into the dashboard, fixing rendering bugs, or implementing new UX features (toast, palette, git section). Triggers on dashboard, monitor, chainCard, Work page, Activity page, agenthq/src/dashboard, toast, palette, git section, SSE, attentionRow.
---

# SW Monitor Dashboard — Build Skill

## Architecture overview

```
agenthq/
├── src/
│   ├── monitor.ts              Bun HTTP server — routes, SSE, queue poller
│   │                           GET /  → serves dist/dashboard.html
│   │                           NEW: GET /git-status, POST /git-commit
│   ├── dashboard-html.ts       DEPRECATED — replaced by dashboard/ SPA
│   └── dashboard/
│       ├── index.html          Entry point, links to main.ts + styles
│       ├── types.ts            All shared TypeScript interfaces (Chain, Job, etc.)
│       ├── state.ts            Typed observable state store (~60 lines)
│       ├── api.ts              All fetch calls with typed returns (~100 lines)
│       ├── main.ts             Bootstrap, SSE EventSource, routing, keyboard (~100 lines)
│       ├── toast.ts            Toast stack, bottom-right (~50 lines)
│       ├── palette.ts          Cmd+K command palette (~80 lines)
│       ├── utils.ts            esc(), icon(), fmtUptime(), status colours (~60 lines)
│       ├── pages/
│       │   ├── dashboard.ts    Dashboard page: stat cards, attention, git, sparkline
│       │   ├── work.ts         Work page: session chains + standalone jobs + stubs
│       │   └── activity.ts     Activity page: full sparkline, stat cards, dispatch log
│       └── components/
│           ├── chainCard.ts    Session chain card with inline linked jobs
│           ├── jobCard.ts      Standalone job card (existing JobChain format)
│           ├── drawer.ts       Timeline drawer (slide-in panel)
│           ├── gitSection.ts   Git status display + Commit & Push flow
│           └── attentionRow.ts Dashboard attention list row
└── dist/
    └── dashboard.html          Built by: bun build src/dashboard/index.html --outdir dist --minify
```

## Pages (3-page navigation)

| Nav label | Route key | What it shows |
|---|---|---|
| Dashboard | `dashboard` | Stat cards, system health, attention list, git section, mini sparkline |
| Work | `work` | SESSION CHAINS (with inline jobs) + STANDALONE JOBS + UNKNOWN stubs |
| Activity | `activity` | Full sparkline + queue stat cards + dispatch log table |

## State model (state.ts)

```typescript
interface AppState {
  chains: Chain[];
  jobChains: JobChain[];
  jobs: Job[];
  jobsByChain: Record<string, JobChain[]>;  // client-side join
  standaloneJobs: JobChain[];               // sessionChainId === ""
  pollLog: PollLogEntry[];
  systemStatus: SystemStatus | null;
  gitStatus: GitStatus | null;
  summariseStatus: Record<string, string>;
  hiddenChains: Record<string, boolean>;    // localStorage key: 'sw-hidden-chains'
  currentPage: 'dashboard' | 'work' | 'activity';
  drawerChainId: string | null;
  commitState: 'idle' | 'running' | 'done' | 'error';
  commitResult: { hash: string; branch: string } | null;
  toasts: Toast[];
}
```

`setState(patch)` merges and calls all subscribers. `subscribe(fn)` registers a re-render.
One subscriber in `main.ts` calls `renderCurrentPage()` on every state change.

## Data join (api.ts)

```typescript
// After fetching /chains and /job-chains, build the join:
const jobsByChain: Record<string, JobChain[]> = {};
const standaloneJobs: JobChain[] = [];
for (const jc of jobChains) {
  if (jc.sessionChainId) {
    (jobsByChain[jc.sessionChainId] ??= []).push(jc);
  } else {
    standaloneJobs.push(jc);
  }
}
setState({ chains, jobChains, jobs, jobsByChain, standaloneJobs, ... });
```

## Component contract

Every component is a pure function: `(data: TypedInput) => string` (HTML string).
No global state access inside components — all data passed as arguments.

```typescript
// chainCard.ts
export function renderChainCard(chain: Chain, linkedJobs: JobChain[], opts: ChainCardOpts): string

// jobCard.ts
export function renderJobCard(jobChain: JobChain): string

// attentionRow.ts
export function renderAttentionRow(chain: Chain, runningJob: JobChain | null): string

// gitSection.ts
export function renderGitSection(git: GitStatus | null, commitState: CommitState): string
```

## CSS tokens (carried forward from current design)

The dashboard uses the Material Design 3 dark theme tokens from the current `dashboard-html.ts`.
These are defined once in `index.html` inside a `<style>` block and used everywhere:

```css
--md-bg, --md-surf-lowest, --md-surf-low, --md-surf, --md-surf-high, --md-surf-highest
--md-outline, --md-outline-var
--md-on-surf, --md-on-surf-var
--md-primary, --md-primary-c, --md-on-primary-c
--md-tertiary, --md-tertiary-c
--md-error, --md-error-c
--cg (green), --cgb (green bg)
--cy (yellow), --cyb (yellow bg)
--cb (blue),  --cbb (blue bg)
--cp (purple), --cpb (purple bg)
--cr (red),   --crb (red bg)
```

Status border-left classes: `.sb-active`, `.sb-done`, `.sb-running`, `.sb-error`, `.sb-idle`

## SSE live update flow

```
EventSource('/events') → onmessage → prevJobs = getState().jobs
                                   → fetchAll() → setState(...)
                                   → checkJobCompletions(prevJobs, getState().jobs) → toasts
```

`checkForChanges()` in monitor.ts runs every 2s, broadcasts `"update"` when workflow dir mtime changes.

## Build commands

```bash
# Production build (run after any dashboard/ change)
cd agenthq bun build src/dashboard/index.html --outdir dist --minify

# Development (hot reload at localhost:3000, proxies API to localhost:3333)
bun src/dashboard/index.html
```

A `fileEdited` hook on `agenthq/src/dashboard/**` auto-runs the build command.

## New API endpoints (monitor.ts)

### GET /git-status
```typescript
// Returns:
interface GitStatus {
  branch: string;
  clean: boolean;
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
  ahead: number;
  behind: number;
}
// Implementation: Bun.spawn(['git', 'status', '--porcelain', '-b']), parse output
```

### POST /git-commit
```typescript
// Spawns: powershell.exe -File .kiro/tools/git-commit-worker.ps1
// Returns: { status: 'queued', jobStem: string }
// Dashboard polls /jobs until git-commit job appears as done/error
```

## UX features to implement

| Feature | File | ~Lines |
|---|---|---|
| Toast stack (bottom-right, auto-dismiss 4s success / persist error) | `toast.ts` | 50 |
| Cmd+K palette (chains: resume/summarise, git: commit, nav: G+D/W/A) | `palette.ts` | 80 |
| `?` shortcuts overlay | `main.ts` | 30 |
| Nav running-jobs dot (pulse when any job running) | `main.ts` | 8 |
| Inline log preview (expand toggle on job rows) | `components/` | 40 |
| Horizontal run timeline (dots per run, colour by status) | `jobCard.ts` | 30 |
| Context arc ring (28px, green/amber/red) | `chainCard.ts` | 25 |
| Git diff confirm modal before POST /git-commit | `gitSection.ts` | 40 |

## Key invariants

- `esc(s)` from `utils.ts` wraps ALL user-sourced strings before inserting into HTML
- No `innerHTML` without `esc()` on dynamic values — XSS prevention
- Component functions never throw — return empty string on null/undefined input
- `setState` is the only way to mutate state — no direct property writes
- localStorage keys: `sw-hidden-chains`, `sw-sort`, `sw-unknown-open`
- The build output `dist/dashboard.html` is gitignored — always rebuild from source
