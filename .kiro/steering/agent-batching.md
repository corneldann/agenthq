---
inclusion: always
---

# Agent Batching — Rate Limit Reduction Rules

Every round-trip to Claude costs ITPM. These rules keep turns-per-task to a minimum.

**Research foundation**: Claude supports parallel tool calls by default ([Claude Parallel Tool Use docs](https://docs.claude.com/en/docs/agents-and-tools/tool-use/parallel-tool-use)). Real-world implementations show 2-5x speedups by batching independent tool calls in a single turn rather than sequential execution.

---

## Core Principle

**Batch everything that can be batched. One turn = one unit of useful work, not one file read or one line change.**

**Critical distinction**:
- **Tool execution** (Kiro's responsibility): Kiro handles multiple tool calls from a single turn efficiently
- **Edit planning** (YOUR responsibility): Plan the full changeset upfront and invoke ALL tools in one turn

**The sequential edit anti-pattern** (from production incident):
```
❌ WRONG: Agent made 9 separate str_replace calls across 9 turns
   Result: 18 API calls (9 to Kiro + 9 to Claude), 9 user approvals in supervised mode
   Time wasted: ~5-10 minutes for what should be 30 seconds

✅ RIGHT: Agent plans all 9 edits, invokes all 9 str_replace calls in parallel in turn 2
   Result: 2 API calls (1 read + 1 batch edit), 1 user approval
   Time saved: 89% reduction in API calls
```

---

## Supervised Mode — Batching is 10x More Critical

**In supervised mode, every turn requires user approval.** This amplifies the cost of sequential edits:

| Metric | Sequential (9 edits) | Batched (1 edit turn) | Difference |
|--------|---------------------|----------------------|------------|
| API calls | 18 (9 turns × 2) | 2-4 (read + edit + verify) | 89% reduction |
| User approvals | 9 clicks | 1-2 clicks | 88% reduction |
| Context growth | Exponential | Linear | Prevents overflow |
| Time to complete | 5-10 minutes | 30-60 seconds | 90% faster |
| User frustration | High (approval fatigue) | None | Qualitative win |

**The approval fatigue problem**: After approving edits 1-3, users start rubber-stamping approvals without reviewing. This defeats the purpose of supervised mode while still paying the latency penalty.

**The solution**: Plan upfront, batch in one turn, present for ONE meaningful approval of the full changeset.

**User experience**:
```
❌ WRONG (sequential):
   [Edit section 1] ← user clicks Approve
   [Edit section 2] ← user clicks Approve  
   [Edit section 3] ← user clicks Approve
   ... 6 more clicks ...
   User: "Just do them all at once!" (but it's too late)

✅ RIGHT (batched):
   [9 edits to phase-7-library-management.md] ← user reviews once, approves once
   User: "Perfect, exactly what I wanted."
```

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

**MANDATORY**: If you need to make N changes to the same file, ALL N changes MUST be made in a single turn via parallel `str_replace` calls.

```
BAD:  str_replace A → (turn) → str_replace B → (turn) → str_replace C
GOOD: str_replace A + str_replace B + str_replace C in parallel (one turn)
```

**Violation patterns** (all forbidden):
❌ Make edit 1, wait for user approval, make edit 2
❌ Make edit 1, verify with read_file, make edit 2  
❌ Make edit 1, check diagnostics, make edit 3
❌ Make "just one more edit" after user approved previous batch

**STOP RULE**: If you find yourself making a **second `str_replace` call to the same file in a different turn**, you have VIOLATED the batching rule.

**Required recovery action**:
1. STOP immediately — do not make the second edit
2. Read the file again to see current state (if needed)
3. Plan ALL remaining edits for this file
4. Execute them in ONE turn with parallel `str_replace` calls

**Compliance example** (9 edits to same file):
```
❌ VIOLATION: 9 separate turns, 9 str_replace calls, 18 API calls total
✅ CORRECT:   Turn 1: read file
              Turn 2: 9 parallel str_replace calls
              Total: 2 turns, 2 API calls (or 3 with verify)
```

### Verify phase — one turn after all edits
Run `get_diagnostics` once after completing ALL edits to a task, not after each individual change.

---

## Planning Checklist — Prevent Sequential Same-File Edits

**Root cause of sequential edits**: Incremental thinking. The agent reads a file, makes edit 1, re-evaluates, makes edit 2, etc. This is the most expensive anti-pattern in agent workflows.

**Research insight**: Per [Claude docs on parallel tool use](https://docs.claude.com/en/docs/agents-and-tools/tool-use/parallel-tool-use), Claude returns multiple `tool_use` blocks in a single response by default. The agent must PLAN for this upfront.

Before making ANY edit to a file, ask yourself these four questions:

1. **How many sections of this file need to change?**
   - If N > 1 → ALL N changes must be in one turn
   - Don't discover edits incrementally - map them upfront

2. **Do I have the full file context?**
   - If NO → read the file first (turn 1)
   - If YES → proceed to parallel edits (turn 2)

3. **Have I already edited this file in a previous turn?**
   - If YES → **STOP IMMEDIATELY** - you've violated the batching rule
   - Re-read the file, plan ALL remaining edits, batch them in one turn

4. **Is this a "just one more small edit" situation?**
   - If YES → **VIOLATION DETECTED** - see STOP RULE above
   - Even "small" edits cost a full API round-trip

**Supervised mode multiplier**: In supervised mode, each turn requires user approval. 9 sequential edits = 9 approval clicks + 9 API calls. Batching into 1 turn = 1 approval + 2 API calls total.

**Example mental models**:

```
❌ WRONG mental model (incremental discovery):
  "I'll fix section 1... [wait for approval] good. Now I notice section 2 needs fixing... 
   [wait for approval] good. Oh, section 3 too..."
  Result: N turns for N edits = 2N API calls

✅ CORRECT mental model (upfront planning):
  "This task affects this file. Let me read it fully and identify ALL sections 
   that need changes... I found 9 sections. I'll make all 9 str_replace calls 
   in parallel right now."
  Result: 2 turns (read + batch edit) = 2 API calls
```

**Real-world example** (phase document with 9 sections):
```
Task: "Add dependency resolution complexity to Phase 7"

❌ INCREMENTAL APPROACH:
   Turn 1:  Read phase-7-library-management.md
   Turn 2:  Add to "Overview" section
   Turn 3:  Add to "Requirements" section
   Turn 4:  Add to "Design Decisions" section
   ...
   Turn 10: Add to "Testing Strategy" section
   Total: 18 API calls (1 read + 9 edits = 10 turns × ~1.8 avg API calls/turn)

✅ BATCHING APPROACH:
   Turn 1:  Read phase-7-library-management.md
            → Identify all 9 sections that mention dependencies
            → Plan 9 str_replace operations
   Turn 2:  Execute all 9 str_replace calls in parallel
   Turn 3:  (optional) Verify with get_diagnostics if markdown validation needed
   Total: 2-3 API calls
   Savings: 83-89% reduction
```

---

## Kiro's Tool Execution Model — Trust the Platform

**Key insight**: You don't control HOW Kiro executes tool calls. You control WHEN and HOW MANY you send per turn.

When you invoke multiple tool calls in a single turn (the correct approach):
```xml
<function_calls>
  <invoke name="str_replace">
    <parameter name="path">file.ts</parameter>
    <parameter name="oldStr">section 1 old</parameter>
    <parameter name="newStr">section 1 new</parameter>
  </invoke>
  <invoke name="str_replace">
    <parameter name="path">file.ts</parameter>
    <parameter name="oldStr">section 2 old</parameter>
    <parameter name="newStr">section 2 new</parameter>
  </invoke>
  <invoke name="str_replace">
    <parameter name="path">file.ts</parameter>
    <parameter name="oldStr">section 3 old</parameter>
    <parameter name="newStr">section 3 new</parameter>
  </invoke>
</function_calls>
```

**What happens next**:
- Kiro receives all 3 tool calls as a batch
- Kiro handles execution efficiently (may run in parallel, may run sequentially with optimizations)
- You get back all 3 results in one turn
- User approves once (in supervised mode)
- Total cost: 1 API call to Claude, 1 API call to Kiro

**Versus the wrong approach** (sequential):
```xml
<!-- Turn 1 -->
<function_calls>
  <invoke name="str_replace">section 1</invoke>
</function_calls>
<!-- Wait for result, user approval -->

<!-- Turn 2 -->
<function_calls>
  <invoke name="str_replace">section 2</invoke>
</function_calls>
<!-- Wait for result, user approval -->

<!-- Turn 3 -->
<function_calls>
  <invoke name="str_replace">section 3</invoke>
</function_calls>
<!-- Wait for result, user approval -->
```

**What happens**:
- 3 separate API calls to Claude (context grows each time)
- 3 separate API calls to Kiro
- 3 user approvals in supervised mode
- Total cost: 6 API calls, ~3-5x slower

**The lesson**: Batch your tool calls in the response, and let Kiro handle the execution. Don't "help" by spreading them across turns.

---

## Multi-File Tasks

Plan the full changeset before starting. Identify all affected files in the read phase, make all edits in a single edit phase, verify once.

```
Turn 1: read all affected files (parallel)
Turn 2: write/edit all files (parallel str_replace calls)
Turn 3: verify (get_diagnostics, or targeted read to confirm)
```

3 turns total regardless of how many files are changed. Not 2N turns.

**Special case — Batch file creation** (e.g., splitting one spec into three specs):

When creating N similar files from a common source (splitting, templating, batch generation):

```
❌ WRONG: Sequential per-file approach
Turn 1: Read source
Turn 2: Create file 1 (fs_write + fs_append)
Turn 3: Create file 2 (fs_write + fs_append)
Turn 4: Create file 3 (fs_write + fs_append)
Result: 4 turns, 8 API calls

✅ CORRECT: Parallel batch approach
Turn 1: Read source
Turn 2: Create ALL files in parallel:
   - fs_write file1 (lines 1-200)
   - fs_append file1 (lines 201-400)
   - fs_append file1 (lines 401-600)
   - fs_write file2 (lines 1-200)
   - fs_append file2 (lines 201-400)
   - fs_write file3 (lines 1-200)
   - fs_append file3 (lines 201-400)
Result: 2 turns, 2 API calls
```

**Key insight**: fs_write and fs_append can be invoked in parallel across multiple files. Don't wait for file 1 to finish before starting file 2.

**Output overflow warning**: If writing many large files in one turn (e.g., 3 files × 600 lines each = ~9 fs_write/fs_append calls), watch for total output overflow. If you encounter overflow:
1. Split into 2 turns: write half the files in turn 1, half in turn 2
2. Or delegate the entire batch operation to a sub-agent
3. Never fall back to sequential per-file writing

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

`fs_write` and `fs_append` can overflow total output if the content is too large. The limit is based on **character count, not line count**, since lines vary in length.

**Safe limits per call:**
- **`fs_write` — ~3,000-4,000 characters maximum per call** (roughly 50-100 lines depending on line length)
- **`fs_append` — ~3,000-4,000 characters maximum per call** (roughly 50-100 lines depending on line length)
- **Rule of thumb**: If your lines are short (code with lots of whitespace), you can use ~100 lines. If your lines are long (prose, documentation, dense code), use ~50 lines.
- **Edits to existing files — use `str_replace` instead of `fs_write`.** Split large diffs into multiple parallel `str_replace` calls rather than rewriting the whole file.
- **⚠️ Total output limit per turn**: If writing multiple large files in one turn causes overflow, split into 2 turns of parallel writes.

```
BAD:  fs_write entire file in one call → truncation error
GOOD: Break into chunks by character/line count
      fs_write first ~4000 chars (~50-100 lines)
      fs_append next ~4000 chars (~50-100 lines)
      fs_append next ~4000 chars (~50-100 lines)
      ... continue until complete
```

**How to estimate**: 
- TypeScript/JavaScript with typical formatting: ~80-100 lines per chunk
- Dense prose/documentation paragraphs: ~50-60 lines per chunk
- JSON/config with deep nesting: ~60-80 lines per chunk
- Markdown with code blocks: ~70-90 lines per chunk

**⚠️ STOP RULE**: If you are writing a new file and reach the point where you need to call `fs_append` for the **fourth time** (roughly 400-500 lines or 16,000+ chars), you have **violated the mandatory sub-agent delegation rule** below. Stop immediately and delegate the remainder to a sub-agent.

**Exception for mechanical batch operations**: If you're creating multiple files from a template/extraction (e.g., splitting one spec into three), you MAY write all files in one turn with parallel fs_write/fs_append calls. The STOP RULE applies per-file, not per-turn.

### Large file rewrites — MANDATORY sub-agent delegation

**CRITICAL RULE**: When a task requires **writing or rewriting a file longer than 400 lines**, you **MUST** delegate to the `general-task-execution` sub-agent. This is not optional or a suggestion — it is a hard requirement.

**EXCEPTION — Sub-agent nesting is architecturally valid but rate-limited in this workspace:**

As of Claude Code v2.1.172, sub-agents CAN spawn further sub-agents (up to depth 5). This is an intended pattern for reviewer → verifier hierarchies where intermediate output stays buried. However, **this workspace has ITPM rate limits that make concurrent nested sub-agents fail**.

**Rule for this workspace**: Sub-agents MAY delegate further only if the work is strictly sequential (not concurrent). If you are a sub-agent and need to write a large file, write it directly with fs_write + fs_append — do NOT spawn another sub-agent just for file writing.

**When sub-agent nesting is acceptable here**:
- ✅ Sequential verification: sub-agent completes work, THEN spawns a single verifier
- ✅ Depth ≤ 2 from main context (main → sub → verifier)

**When sub-agent nesting causes throttle failure**:
- ❌ Spawning multiple sub-agents concurrently (violates MAX_CONCURRENT_SUBAGENTS=1)
- ❌ Spawning a sub-agent just to write a large file (use fs_write + fs_append directly)
- ❌ Depth > 2 (main → sub → sub → sub = too many concurrent ITPM consumers)

**How to identify yourself as a sub-agent**: Your prompt will begin with:
`CONTEXT: You are operating as a sub-agent invoked via invoke_sub_agent.`
When you see this line, write files directly. Only spawn further sub-agents for sequential verification tasks, never for file writing.

**When to use sub-agents** (main context only):
- ✅ Complex analysis + large file write (e.g., "analyze Phase 5 design and rewrite entire 800-line requirements doc")
- ✅ Research + synthesis + documentation (e.g., "research X, synthesize findings, write 600-line analysis")
- ✅ Code generation with complex logic (e.g., "generate 500-line TypeScript module based on spec")

**When NOT to use sub-agents** (do it yourself):
- ❌ Simple file extraction/splitting (read large file, extract sections, write 3 smaller files) — this is just fs_write + fs_append in parallel
- ❌ Template filling (read template, populate variables, write 500-line output) — direct write
- ❌ Batch operations (create N similar files from same pattern) — parallel fs_write calls
- ❌ You are already a sub-agent — NEVER delegate further

**Rule of thumb**: If the task is mechanical transformation of known content, write directly. If it requires substantial reasoning/analysis that would consume main context budget, delegate.

**Automatic triggers for MANDATORY delegation (main context only):**
- ✅ New files that will be > 400 lines when complete
- ✅ Full file rewrites (new layout, major restructure) of files > 400 lines
- ✅ Any task where the write would require 5+ `fs_write`/`fs_append` calls
- ✅ Documentation files (markdown, specs, analysis reports) > 400 lines
- ✅ Multi-section documents (executive summaries, phase specifications, findings reports) > 400 lines

**Pre-write estimation (main context only):**
Before starting any new file creation, estimate the final line count:
- TypeScript class with 25+ methods: ~500-600 lines → DELEGATE
- Analysis document with 8+ major sections: ~500-800 lines → DELEGATE  
- API specification with 20+ endpoints: ~600+ lines → DELEGATE
- Configuration file with extensive comments: ~400+ lines → DELEGATE

**How to delegate (MANDATORY PATTERN):**
1. ✅ **DO** read relevant context files in the main context first (understand the task)
2. ✅ **DO** analyze and plan the structure/content in main context
3. ✅ **DO** write a precise prompt to the sub-agent describing exactly what to produce
4. ✅ **DO** pass relevant files as `contextFiles` so sub-agent has needed context
5. ✅ **DO** instruct the sub-agent to run `get_diagnostics` or build after writing
6. ✅ **DO** trust the sub-agent's output — do not re-read files it already wrote
7. ✅ **DO** include this exact paragraph at the TOP of every sub-agent prompt:

```
CONTEXT: You are operating as a sub-agent invoked via invoke_sub_agent.
The mandatory >400 line delegation rule does NOT apply to you — write all files
directly using fs_write + fs_append regardless of size.
Do NOT invoke further sub-agents under any circumstances (prevents throttle cascade).
```

**Why this is required**: Sub-agents receive the same steering files as the main agent. Without an explicit override, a sub-agent that sees an 800-line file WILL try to delegate again — creating two concurrent ITPM consumers and triggering throttle errors on both.

**Compliance examples:**
```
❌ BAD:  write 800-line PHASE-ANALYSIS-FINDINGS.md across 4+ fs_write/fs_append turns
✅ GOOD: analyze phases → invoke_sub_agent(general-task-execution) → sub-agent writes → done

❌ BAD:  write 600-line TypeScript file across 3+ fs_append turns in main context  
✅ GOOD: read existing code → invoke_sub_agent with spec → sub-agent writes + builds → reports result

❌ BAD:  write 500-line skills recommendation doc with 3+ fs_append calls
✅ GOOD: research skills → invoke_sub_agent with findings → sub-agent writes doc → done
```

**Why this is MANDATORY:**
- Sub-agent turns are isolated and do not consume main-context ITPM
- Main-context ITPM is the rate-limiting resource in this workspace
- 4 `fs_write`/`fs_append` calls for one file = 4 wasted turns
- 1 `invoke_sub_agent` call = 1 turn, sub-agent handles all the writes internally

**Enforcement (main context only):**
If you are in main context and find yourself writing `fs_write` or `fs_append` for line 401+ of a new file, you have ALREADY VIOLATED this rule. Stop immediately, and delegate the remainder to a sub-agent with context of what you've written so far.

If you are already a sub-agent, write the file directly — do NOT delegate again (prevents infinite loops).

---

## Anti-Pattern Recognition — Early Warning Signs

**Learn to recognize when you're about to violate batching rules BEFORE you make the mistake.**

### Warning Sign 1: "I'll just do this one edit first..."

**Symptoms**:
- You read a file and identify one obvious edit
- You make that edit
- While looking at the result, you notice another section that needs editing
- You make another edit
- Repeat...

**What's happening**: Incremental discovery. You're finding edits reactively instead of planning proactively.

**Recovery**: STOP. Re-read the file with the explicit goal: "What are ALL the sections that need to change for this task?" Then batch all edits in one turn.

### Warning Sign 2: "Let me verify this edit before continuing..."

**Symptoms**:
- You make edit 1
- You want to verify it before making edit 2
- You read the file or run diagnostics
- Then you make edit 2

**What's happening**: Verification anxiety. You don't trust that multiple edits will all succeed.

**Fix**: `str_replace` is atomic per call. If one fails, you'll get an error for that specific call while others succeed. Trust the tool and batch them.

### Warning Sign 3: Thinking in file sections instead of task scope

**Symptoms**:
- "First I'll update the imports section... done."
- "Now I'll update the function signature... done."
- "Now I'll update the return type... done."

**What's happening**: You're organizing edits by file structure, not by task atomicity.

**Reframe**: "This task requires changing 3 parts of this file. I'll make all 3 changes in one turn."

### Warning Sign 4: User already approved one edit to this file

**Symptoms**:
- Turn N: You edited file X, user approved
- Turn N+1: You're about to edit file X again

**What's happening**: You've ALREADY violated the batching rule.

**Emergency fix**: 
1. Acknowledge the violation
2. Tell the user: "I should have batched these edits. Let me re-plan and do the remaining edits in one turn."
3. Read the file again, identify ALL remaining edits, batch them

**Don't**: Continue with sequential edits because "I'm already committed to this approach"

### Warning Sign 5: Thinking "the file is long, I'll work through it section by section"

**Symptoms**:
- File is 500+ lines
- You think: "I'll update the first section, then move to the next..."

**What's happening**: File length is intimidating you into sequential work.

**Correct approach**: File length is irrelevant. Read it, search for all locations matching your task pattern, batch all edits. Even a 2000-line file can be edited with 10-20 parallel `str_replace` calls in one turn.

---

## What NOT to Batch

- Do not batch independent tasks that the user hasn't asked for (scope creep)
- Do not skip `get_diagnostics` after edits to TypeScript/typed files — one verify turn is cheaper than a back-and-forth debugging session
- Do not batch destructive operations (deletes, production changes) — those still require confirmation

---

## Turn Budget Targets

| Task type | Target turns | Notes |
|-----------|-------------|-------|
| Single file edit | 2 | read + edit |
| Multi-file edit (same concern) | 3 | read-all + edit-all + verify |
| Bug fix with investigation | 3 | gather + read + edit+verify |
| New feature (familiar codebase) | 4–5 | If involves >400 line file: use sub-agent |
| New feature (unfamiliar) | 4–5 | context-gatherer counts as 1 turn |
| **Large file write (>400 lines)** | **2** | **read source (if needed) + fs_write + fs_append chunks** |
| **Batch file creation (N files)** | **2** | **read source + parallel fs_write/fs_append for all N files** |
| **Split large file into N smaller** | **2** | **read source + parallel writes (not 1+N turns!)** |
| Documentation/analysis report | 2 | read + write in chunks OR delegate if complex analysis |
| Research + save | 2 | search + respond with CRAWL_QUEUE |

**Critical enforcement**: If a task is taking more turns than the budget, stop, diagnose the root cause, and switch approach rather than continuing to iterate. **If you are on `fs_append` call #2 for a single new file, you have violated the mandatory sub-agent delegation rule.**

---

## Research & Sources

This guidance is based on production incidents, official documentation, and field research:

1. **Claude Parallel Tool Use** ([official docs](https://docs.claude.com/en/docs/agents-and-tools/tool-use/parallel-tool-use))
   - Claude returns multiple `tool_use` blocks in a single response by default
   - Agents should return all `tool_result` blocks together in one user message
   - Incorrect message formatting "teaches" Claude to avoid parallel calls

2. **Real-world performance impact** ([kindatechnical.com](https://kindatechnical.com/claude-ai/parallel-tool-calls-running-multiple-functions-concurrently.html))
   - 8-second agent → 2-second agent (4x speedup) by batching tool calls
   - "Claude was already returning all four tool calls in a single turn. The team had been executing them sequentially in their loop."
   - Key insight: 2-5x speedups are typical, 5-10x possible for workloads with many tool calls

3. **ITPM as the binding constraint** (field observations, 2026)
   - Rate limiting is based on Input Tokens Per Minute (ITPM), not Requests Per Minute
   - Every turn re-sends system prompt, tool definitions, and conversation history
   - Context grows exponentially with sequential turns
   - Turn minimization is the #1 cost optimization lever

4. **Production incident** (this workspace)
   - 9 sequential `str_replace` calls to same file = 18 API calls + 9 user approvals
   - Should have been 2-3 turns: read → batch edit → verify
   - 89% waste due to incremental thinking anti-pattern

**Key takeaway from research**: Batching is not an optimization — it's the default correct behavior. Sequential tool calls are the anti-pattern that must be actively prevented through planning discipline.
