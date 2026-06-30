---
name: memory-consolidation
description: Use when consolidating agent memory, removing stale facts, or cleaning the knowledge graph. Trigger with 'dream', 'consolidate', or 'clean memory'. Implements the Auto Dream pattern for the @modelcontextprotocol/server-memory JSON knowledge graph.
---

# Memory Consolidation Skill

## Description

Use when consolidating agent memory, removing stale facts, or cleaning the knowledge graph. Trigger with "dream", "consolidate", or "clean memory".

Implements the Auto Dream pattern (SFEIR / Claude Code, March 2026) adapted for the `@modelcontextprotocol/server-memory` JSON knowledge graph used by the oracle-carbon-analysis power. Runs in a single agent turn with no hooks needed.

## Trigger Phrases

- `dream`
- `consolidate`
- `consolidate memory`
- `clean memory`

## When to Use

- After 5+ sessions have elapsed since the last consolidation
- When the knowledge graph feels bloated or contradictory
- At the start of a new analysis session when context feels stale
- When prompted by a context size warning (>50% usage)

---

## Four-Phase Consolidation Cycle

### Phase 1 — Orientation

Read the entire knowledge graph to build a map of what exists:

1. Call `read_graph` — retrieve all entities and relations
2. Build a working inventory:
   - Count total entities
   - Group entities by type (Oracle findings, DAX findings, model findings, session notes)
   - Identify entities with the most observations (likely to have contradictions)
   - Note creation/modification dates on observations

### Phase 2 — Signal Gathering

Identify what needs action:

**Duplicates** — two or more entities describing the same subject:
- Same table name referenced under slightly different entity names
- Same index finding recorded in two separate sessions
- Same DAX measure noted multiple times

**Contradictions** — two observations on the same entity that conflict:
- "TABLE X has no index on COLUMN Y" vs "TABLE X has index IDX_Z on COLUMN Y"
- "Measure M uses CALCULATE" vs "Measure M does not use CALCULATE"
- Any observation that negates a prior one on the same subject

**Stale facts** — absolute dates older than 30 days with no subsequent confirmation:
- Schema findings from the initial analysis that have not been validated recently
- Session notes that are now superseded by later sessions
- Any observation with a date timestamp > 30 days ago and no follow-up

**Orphaned entities** — entities with zero relations and only one observation (likely noise)

### Phase 3 — Consolidation

For each issue found in Phase 2:

**Merging duplicates:**
1. Identify the canonical entity (most observations, most recent, clearest name)
2. Move all unique observations from duplicates onto the canonical entity using `add_observations`
3. Delete the duplicate entities using `delete_entities`

**Resolving contradictions:**
1. Identify which observation is newer (check dates in observation text, or infer from session sequence)
2. Add a supersession observation to the entity: `"[DATE] SUPERSEDES: [old fact] — confirmed [new fact]"`
3. Delete the older contradicting observation using `delete_observations`
4. The newer fact is now authoritative

**Removing stale facts:**
1. For facts older than 30 days with no confirmation: add a `"[DATE] STALE — unconfirmed since [original date]"` flag
2. If the fact is about a schema element that has since been modified (index added, query changed): delete outright
3. If uncertain whether it is still valid: keep with the STALE flag for the next session to confirm

**Orphaned entities:**
1. Delete entities with zero relations and one generic observation
2. Keep entities even with zero relations if they carry specific, useful observations

### Phase 4 — Pruning

Enforce the graph size limit to keep startup context lean:

1. Re-run `read_graph` to get post-consolidation count
2. **Target: ≤ 50 entities**
3. If over 50:
   - Identify the lowest-value entities (oldest, least observations, no relations, generic)
   - Delete the bottom tier using `delete_entities` until under 50
   - Never delete entities related to: active backlog items, confirmed index gaps, or the primary tables (`PROJECT_ITEM`, `PROJECT_RESOURCE`, `RISK_REGISTER`)
4. Report final entity count and a brief summary of what was changed

---

## Output Format

After completing the four phases, report:

```
Memory consolidation complete.

Graph before: X entities, Y relations
Graph after:  X entities, Y relations

Changes:
- Merged: [list of merged duplicates]
- Resolved: [list of contradictions resolved, with which fact won]
- Removed stale: [list of deleted stale facts]
- Pruned: [count of low-value entities removed]

Oldest validated fact: [date]
Next consolidation recommended: [date + 30 days]
```

---

## Key Tools

| Tool | Purpose | Auto-approved |
|------|---------|---------------|
| `read_graph` | Read all entities and relations | Yes |
| `search_nodes` | Find entities by name or type | Yes |
| `open_nodes` | Read specific entities by name | Yes |
| `create_entities` | Create new entities | No — requires approval |
| `create_relations` | Link entities | No — requires approval |
| `add_observations` | Add facts to an entity | No — requires approval |
| `delete_entities` | Remove entities | No — requires approval |
| `delete_observations` | Remove individual observations | No — requires approval |
| `delete_relations` | Remove links between entities | No — requires approval |

---

## Notes

- The `@modelcontextprotocol/server-memory` server stores its graph at the default path configured in the power's mcp.json. It persists across sessions.
- Consolidation does **not** read session JSON files or Kiro steering — it operates solely on the live knowledge graph.
- For temporal knowledge (facts that change over time like index presence), always use supersession notation in observations rather than silent deletion, so the graph retains an audit trail.
- If the graph is empty (fresh install), Phase 1 will report 0 entities — skip to a brief confirmation and exit.
