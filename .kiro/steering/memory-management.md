---
inclusion: always
---

# AgentHQ Memory Management & Context Overflow Prevention

## Problem Statement

AI agents are stateless. Every session starts from zero. **Critical research finding (2026):**
- Agents with unbounded memory: **13% accuracy**  
- Agents with active memory management: **39% accuracy**  
- **3x improvement from storing LESS, not more**

Manual "update all memory files" commands produce **memory rot**: stale facts, contradictions, bloat.

---

## The Four-Tier Memory System

AgentHQ uses a 4-tier memory architecture adapted from 2026 research (CoALA framework):

| Tier | Storage | Persistence | Decay | Use Case |
|------|---------|-------------|-------|----------|
| **Working** | Context window | Session only | Immediate | Current job execution, active reasoning |
| **Episodic** | Session files (.md, .jsonl) | Hours-days | Ebbinghaus | Recent job history, debugging patterns |
| **Semantic** | @mcp/server-memory (JSON KG) | Weeks-months | Supersession | Facts about code, architecture, decisions |
| **Procedural** | Skills, steering files | Indefinite | Rarely | Effective patterns, workflows, standards |

---

## Tier 3: Semantic Memory (@mcp/server-memory)

### What Lives Here
- **Architectural decisions**: "Dashboard uses vanilla TypeScript SPA, no framework"
- **Module structure**: "scan/ contains pure async file readers, no HTTP dependencies"
- **Known issues**: "Windows filesystem locks cause occasional scan issues"
- **API contracts**: "GET /api/jobs returns Job[] filtered by workspaceId"
- **Performance facts**: "Scanning 1000+ files every 5s causes CPU spikes"

### When to Write
✅ **DO** write to memory:
- After validating an architectural fact (ran code, confirmed behavior)
- When discovering a non-obvious relationship ("sessions.ts depends on chains.ts")
- After resolving a bug (what caused it, how we fixed it)
- When learning a project convention ("git commits via dashboard, not CLI")

❌ **DON'T** write to memory:
- Raw file contents (use read_file to re-fetch)
- Temporary reasoning ("I think this might...")
- Obvious facts visible in code ("monitor.ts starts the server")
- Duplicates of existing entities

### How to Write (use @mcp/server-memory tools)
```typescript
// Good: specific, verifiable fact
{
  entity: "scan/jobs.ts",
  relation: "exports",
  target: "scanJobs() -> Job[]"
}

// Good: architectural decision with context
{
  entity: "Dashboard Build",
  relation: "triggered_by",
  target: "file save hook on src/dashboard/**"
}

// Bad: too vague
{
  entity: "system",
  relation: "has",
  target: "some caching"
}
```

---

## Auto Dream: Autonomous Memory Consolidation

### The Pattern (Claude Code, March 2026)

**NEVER** manually run "update all relevant memory files" — this causes bloat.  
**INSTEAD**: Say `"dream"`, `"consolidate"`, or `"clean memory"` to trigger autonomous consolidation.

### Four-Phase Cycle

**Phase 1 — Orientation**  
- Read entire knowledge graph (`read_graph`)
- Build map of entities, count duplicates
- Identify entities with most observations (likely contradictions)

**Phase 2 — Signal Gathering**  
- Find duplicates (same fact, different entity names)
- Find contradictions (conflicting observations on same entity)
- Find stale facts (>30 days old, no confirmation)

**Phase 3 — Consolidation**  
- **Merge duplicates**: move observations to canonical entity, delete duplicates
- **Supersede contradictions**: newer fact wins, mark with "[DATE] SUPERSEDES: [old]"
- **Flag stale**: add "[DATE] STALE — unconfirmed since [original]"

**Phase 4 — Pruning**  
- **Target**: ≤50 entities for fast startup
- Delete superseded facts
- Remove orphaned entities (zero relations, generic observations)
- Never delete: active backlog, confirmed issues, core modules

### Trigger Consolidation When
- After 5+ sessions since last consolidation
- Context feels bloated or contradictory
- Starting new analysis session
- See context size warning (>50% usage)

### Consolidation Skill
Use the `memory-consolidation` skill (already in `.kiro/skills/memory-consolidation/`):
- Trigger: `"dream"`, `"consolidate"`, `"clean memory"`
- Runs in single agent turn, no hooks needed
- Keeps graph under 50 entities
- Supersedes old facts automatically

---

## Context Overflow Prevention

### The Three Strategies

**1. Tool-Result Clearing** (for large, re-fetchable tool results)
- **What**: Replaces old tool_result blocks with placeholder "[cleared to save context]"
- **When**: File reads, API responses you can call again
- **Cost**: None (mechanical edit)
- **Trade-off**: Agent must re-call tool if it needs the data again

**2. Compaction** (for long dialogues and reasoning)
- **What**: Summarizes entire conversation into high-fidelity summary
- **When**: Context approaches window limit
- **Cost**: Inference (summarizer model runs)
- **Trade-off**: Obscure specifics may be lost, but substance preserved

**3. Memory Tool** (for cross-session persistence)
- **What**: Agent writes facts to `/memories`, reads them in next session
- **When**: Multi-session work, need to preserve learnings
- **Cost**: Tool-call overhead
- **Trade-off**: Only as good as what agent chose to save

### When to Use Each

| Problem | Use | Config |
|---------|-----|--------|
| Large file reads fill context | Clearing | `keep=3-6` tool results, `trigger=30K-100K` |
| Long dialogue accumulates | Compaction | `trigger=150K-200K`, custom instructions |
| Need cross-session memory | Memory tool | Implement handlers, guide what to save |

---

## AgentHQ-Specific Guidelines

### File Writing — Size Limits (MANDATORY from agent-batching.md)

**Problem**: Large edits overflow output and get truncated silently.

**Rules**:
- `fs_write` — **50 lines maximum** per call
- `fs_append` — **50 lines maximum** per call
- For files >50 lines: use `fs_write` (first 50) then chain `fs_append` calls
- **For files >100 lines**: delegate to `general-task-execution` sub-agent

**Example**:
```
BAD:  fs_write 200-line file → truncation error
GOOD: fs_write lines 1-50 → fs_append 51-100 → fs_append 101-150 → fs_append 151-200
BEST: delegate to sub-agent for 200-line file
```

### Prevent Context Loss in Large Edits

**Pattern from agent-batching.md**:
1. **Read phase** — Fire ALL reads in parallel (one turn)
2. **Edit phase** — Batch all changes in parallel `str_replace` calls (one turn)
3. **Verify phase** — Run `get_diagnostics` once after all edits (one turn)

**Target**: 2-3 turns for most tasks, not 10-20 incremental turns.

### Multi-File Tasks

**Plan the full changeset before starting**:
```
Turn 1: read all affected files (parallel)
Turn 2: write/edit all files (parallel str_replace calls)
Turn 3: verify (get_diagnostics or targeted read)
```

**Result**: 3 turns regardless of file count, not 2N turns.

---

## Memory Consolidation Best Practices

### Supersession Semantics (Knowledge Layer)

**Pattern**: New facts REPLACE old facts, not accumulate beside them.

```typescript
// OLD FACT (before index added)
{
  entity: "PROJECT_ITEM",
  relation: "missing_index_on",
  target: "PROJECT_SECTION_ID",
  valid_from: "2026-06-15"
}

// NEW FACT (after index added) — replaces old
{
  entity: "PROJECT_ITEM",
  relation: "has_index_on",
  target: "PROJECT_SECTION_ID",
  valid_from: "2026-06-20"
}

// Action: DELETE the old fact, or mark SUPERSEDED
{
  entity: "PROJECT_ITEM",
  observation: "[2026-06-20] SUPERSEDES: missing_index_on PROJECT_SECTION_ID — index added"
}
```

### Ebbinghaus Decay (Memory Layer)

**Pattern**: Facts fade without reinforcement.

- Session notes older than 30 days with no confirmation → flag STALE
- Observations about transient state ("build failed") → expire after resolution
- Last-used timestamps → decay influence on retrieval

### Evidence-Gated Revision (Wisdom Layer)

**Pattern**: Rare changes, requires strong evidence.

Examples:
- "Always test MCP config before activating" (learned from repeated failures)
- "Never run bun --check on monitor.ts" (starts server as side effect)
- "Git commits via dashboard only" (team convention)

These change only with strong contradictory evidence, not daily observation.

---

## Steering File Integration

### This File's Role

**Inclusion**: `always` (loaded every session automatically)

**Purpose**: 
- Prevent manual "update memory" commands (causes rot)
- Guide when/how to write to semantic memory
- Establish Auto Dream consolidation pattern
- Prevent context overflow in large edits

### Works With

- `tech-core.md` — Technical context, module structure
- `agent-batching.md` — Turn minimization, file size limits
- `task-concurrency.md` — Workspace constraints (sequential subagents)
- `memory-consolidation` skill — Actual consolidation implementation

---

## Quick Reference

### When Context Feels Large

1. Check `#Problems` in IDE — are there actual errors, or just warnings?
2. Say `"dream"` to consolidate memory (removes duplicates, supersedes old facts)
3. For large edits, **plan full changeset first**, then execute in parallel
4. For files >100 lines, **delegate to sub-agent**

### When Writing to Memory

✅ Validated facts about architecture, bugs, decisions  
✅ Non-obvious relationships between modules  
✅ Confirmed conventions and patterns  
❌ Raw file contents (use read_file)  
❌ Temporary reasoning  
❌ Duplicates of existing facts

### When Losing Context Mid-Session

❌ DON'T manually update memory files  
❌ DON'T write 200-line files in one `fs_write`  
✅ DO batch reads, edits, verifies into 3 turns  
✅ DO use sub-agents for large file writes  
✅ DO trigger consolidation with `"dream"`

---

## Research Sources

- Memory architecture: arxiv 2604.23878, 2604.11364, 2512.12818, 2501.13956
- Auto Dream: SFEIR / Claude Code (March 2026)
- Context engineering: [Claude Cookbook](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)
- Kiro steering: [kiro.dev/docs/steering](https://kiro.dev/docs/steering/)

**Key Insight**: Better memory comes from storing **less**, not more. Active management > passive accumulation.

