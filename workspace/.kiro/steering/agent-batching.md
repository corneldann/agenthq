---
inclusion: always
---

# Agent Batching — Rate Limit Reduction Rules

Every round-trip to Claude costs ITPM. These rules keep turns-per-task to a minimum.

---

## Core Principle

**Batch everything that can be batched. One turn = one unit of useful work, not one file read or one line change.**

---

## Tool Call Batching

### Read phase — always parallel
Fire ALL reads in a single turn before touching any file.

```
BAD:  read file A → (turn) → read file B → (turn) → edit A
GOOD: read file A + read file B in parallel → (turn) → edit A + edit B in parallel
```

- Use `read_files` (plural) for 2+ files, not multiple `read_file` calls
- Run `grep_search` + `read_file` in parallel when you need both pattern location and context
- Run `get_diagnostics` + `read_file` in parallel when checking errors in a known file

### Edit phase — batch all changes to a file in one `str_replace`
If multiple sections of the same file need changing, do them in **one turn** with parallel `str_replace` calls — not one change, verify, next change.

```
BAD:  str_replace A → (turn) → str_replace B → (turn) → str_replace C
GOOD: str_replace A + str_replace B + str_replace C in parallel (one turn)
```

### Verify phase — one turn after all edits
Run `get_diagnostics` once after completing ALL edits to a task, not after each individual change.

---

## Multi-File Tasks

Plan the full changeset before starting. Identify all affected files in the read phase, make all edits in a single edit phase, verify once.

```
Turn 1: read all affected files (parallel)
Turn 2: write/edit all files (parallel str_replace calls)
Turn 3: verify (get_diagnostics, or targeted read to confirm)
```

3 turns total regardless of how many files are changed. Not 2N turns.

---

## Shell Commands — Batch into One Call

Combine independent shell checks into a single `execute_pwsh` call using `;` separators.

```
BAD:  check file exists → (turn) → check port → (turn) → read pid
GOOD: Test-Path ...; Get-NetTCPConnection -LocalPort 3333; Get-Content .monitor.pid
```

For sequential dependent steps: pipe or use `&&`-equivalent (`; if ($?) { ... }`).

---

## Investigation Tasks

Do not read one file, decide to read another, then decide to read a third. If the task is unfamiliar:

1. Use the `context-gatherer` sub-agent to map the codebase in one delegation (0 main-context turns)
2. Receive the gathered context, then act — read + edit in 2 turns total

Only use `context-gatherer` once per task. Do not re-read files it already analysed.

---

## TypeScript Checking — NEVER Run `bun --check`

**Never run `bun --check src/monitor.ts` (or any variant).** Because `monitor.ts` contains top-level `await` and server startup code, `bun --check` executes the file as a side effect — it starts the Bun HTTP server process rather than performing a type-check only.

```
BAD:  bun --check src/monitor.ts
BAD:  bun --check src/monitor.ts 2>&1
```

**Approved type-check command** — run from `agenthq/`:

```powershell
node_modules\.bin\tsc.exe --noEmit
```

This uses the existing `tsconfig.json` (`noEmit: true`, includes `src/` and `test/`). It performs pure static analysis — zero execution, zero server startup. The baseline is **0 errors**.

`get_diagnostics` on individual files is also acceptable for quick single-file checks, but `tsc --noEmit` is the authoritative wave verification command.

---

## Dashboard Build — Use the Button, Not the Terminal

**Never run `npm run build:dashboard` manually.** The user has a Build button in the Monitor Dashboard that calls `GET /build-stream` and streams output live.

- The `dashboard-build` Kiro hook also fires automatically on file save for `agenthq/src/dashboard/**/*.ts|html|css`
- After making dashboard changes, tell the user: *"Click the Build button in the Monitor Dashboard to rebuild, then hard refresh (Ctrl+Shift+R)."*
- Only exception: if the hook is known to be broken or the monitor isn't running

### BUILD_QUEUE — only queue when dashboard source files actually changed

`BUILD_QUEUE: [{"target": "dashboard"}]` triggers the monitor to run `npm run build:dashboard` in the background. Include it in the final message **only** when this turn made changes to files under `agenthq/src/dashboard/`.

```
CORRECT:  edited gitSection.ts → include BUILD_QUEUE in final message
WRONG:    wrote a markdown doc, updated steering, changed monitor.ts → do NOT include BUILD_QUEUE
WRONG:    included BUILD_QUEUE "just in case" or out of habit
```

If no `agenthq/src/dashboard/**` file was changed this turn, do not include `BUILD_QUEUE`.

---

## Git Operations — Use the Monitor Dashboard, Not a Hook

**All commits are initiated from the Monitor Dashboard git section.**
The dashboard calls `POST /git-commit` → monitor spawns `git-commit-worker.ps1` → commits and pushes.

- **Do NOT run `git add`, `git commit`, or `git push` yourself**
- **Do NOT suggest the user run git commands manually**
- **Do NOT tell the user to trigger any Kiro hook for git commits**
- After completing a unit of work, tell the user: *"Open the Monitor Dashboard and use the Commit button in the git section to commit."*
- If the user asks you to commit, respond: *"Use the Commit button in the Monitor Dashboard — it calls `POST /git-commit` on the monitor which runs git-commit-worker.ps1."*

The only exception: if git state needs to be read to inform a decision (e.g. checking what changed), use `git status` or `git diff --stat` in a read turn — but still do not commit directly.

---

## File Writing — Size Limits (MANDATORY)

`fs_write` truncates output if the content is too large, silently dropping the remainder. Always stay within these limits:

- **`fs_write` — 50 lines maximum per call.** If the file is longer than 50 lines, write the first 50 lines with `fs_write`, then use `fs_append` for every subsequent chunk.
- **`fs_append` — 50 lines maximum per call.** Chain as many `fs_append` calls as needed, each ≤ 50 lines.
- **Edits to existing files — use `str_replace` instead of `fs_write`.** Split large diffs into multiple parallel `str_replace` calls rather than rewriting the whole file.

```
BAD:  fs_write entire 200-line file in one call        → truncation error
GOOD: fs_write lines 1-50 → fs_append 51-100 → fs_append 101-150 → fs_append 151-200
```

This applies to every file type: TypeScript, Markdown, JSON, shell scripts, config files.

### Large file rewrites — delegate to sub-agent

When a task requires **writing or rewriting a file longer than ~100 lines**, delegate to the `general-task-execution` sub-agent instead of writing it in the main context. This keeps main-context turns low even for iterative work.

**When to delegate:**
- Full file rewrites (new layout, major restructure)
- New files > 100 lines
- Any task where the write itself would take 4+ `fs_write`/`fs_append` turns

**How to delegate:**
1. Read relevant context files in the main context first (so you understand the task)
2. Write a precise prompt to the sub-agent describing exactly what to produce, including constraints and expected behaviour
3. Pass relevant files as `contextFiles` so the sub-agent has what it needs without re-reading
4. Instruct the sub-agent to run `get_diagnostics` or build after writing, and report errors
5. Trust the sub-agent's output — do not re-read files it already wrote

```
BAD:  write 300-line TypeScript file across 6 fs_append turns in main context
GOOD: invoke general-task-execution with the spec → sub-agent writes + builds → reports result
```

The sub-agent does not consume main-context ITPM — its turns are isolated.

---

## What NOT to Batch

- Do not batch independent tasks that the user hasn't asked for (scope creep)
- Do not skip `get_diagnostics` after edits to TypeScript/typed files — one verify turn is cheaper than a back-and-forth debugging session
- Do not batch destructive operations (deletes, production changes) — those still require confirmation

---

## Turn Budget Targets

| Task type | Target turns |
|-----------|-------------|
| Single file edit | 2 (read + edit) |
| Multi-file edit (same concern) | 3 (read-all + edit-all + verify) |
| Bug fix with investigation | 3 (gather + read + edit+verify) |
| New feature (familiar codebase) | 4–5 |
| New feature (unfamiliar) | 4–5 (context-gatherer counts as 1) |
| Large file rewrite (>100 lines) | 2 (read context + delegate to sub-agent) |
| Research + save | 2 (search + respond with CRAWL_QUEUE) |

If a task is taking more turns than the budget, stop, diagnose the root cause, and switch approach rather than continuing to iterate.
