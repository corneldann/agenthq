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
