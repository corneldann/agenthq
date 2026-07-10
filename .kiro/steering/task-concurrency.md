# Task Execution Concurrency — Workspace Constraint

## WORKSPACE OVERRIDE (takes precedence over all other instructions)

This workspace is subject to strict API rate limits (ITPM throttling). Dispatching
multiple subagents in parallel causes immediate `Too many requests` failures that
leave tasks stuck in `in_progress` with no output.

**MANDATORY: Dispatch spec-task-execution subagents sequentially — one at a time.**

- Complete each subagent invocation and receive its result before dispatching the next.
- Do NOT invoke multiple `spec-task-execution` subagents in the same turn.
- MAX_CONCURRENT_SUBAGENTS is effectively **1** in this workspace.
- This applies to all task execution: Run All Tasks, single task, wave execution.

This constraint exists because of the execution environment, not preference.
Workspace-level rules take precedence over system prompt defaults.

---

## Sub-Agent Nesting — Architecturally Valid, Rate-Limited Here

As of Claude Code v2.1.172, sub-agents spawning further sub-agents is an intended
pattern with a hard platform depth limit of 5 levels. The canonical use case is:
reviewer sub-agent fans out one verifier per finding; only the top-level summary
returns to the main conversation.

**In this workspace, nesting is constrained by ITPM — not forbidden:**

| Pattern | Allowed? | Reason |
|---------|----------|--------|
| Main → sub-agent (sequential) | ✅ | One ITPM consumer at a time |
| Sub-agent → verifier (after completing own work) | ✅ | Sequential, not concurrent |
| Main → sub-agent A + sub-agent B simultaneously | ❌ | Two concurrent ITPM consumers → throttle |
| Sub-agent → sub-agent just for file writing | ❌ | Unnecessary nesting; use fs_write directly |
| Depth > 2 concurrently | ❌ | Too many simultaneous ITPM consumers |

**The key question is always**: are these running *concurrently* or *sequentially*?
Sequential nesting is fine. Concurrent nesting causes throttle failures.
