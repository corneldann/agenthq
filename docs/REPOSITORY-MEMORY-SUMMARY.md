# AgentHQ Repository & Memory Management - Implementation Summary

## Executive Summary

Phase 8 transforms AgentHQ into a comprehensive **Repository + Memory Hub** with:
1. **Repository Management** - Track, monitor, and manage all agent-related repos from dashboard
2. **Advanced Memory Architecture** - 4-tier memory system based on 2026 research (CoALA framework)
3. **Auto Dream Consolidation** - Autonomous memory maintenance (no manual "update memory" commands)
4. **Temporal Reasoning** - Optional Zep integration for "what was true when" queries

---

## The Core Problems Solved

### Problem 1: Fragmented Repository Management
**Before:**
- PowersLib, SkillsLib, ReferenceLib managed separately
- Must switch directories manually
- No unified view of git status
- No cross-repo operations

**After:**
- Single dashboard for all repos
- Multi-repo operations (pull all, status all)
- Real-time status monitoring
- Commit/branch operations from UI

### Problem 2: Stateless Agents
**Before:**
- Agents forget everything between sessions
- No memory of repo structure, patterns, learnings
- Manual context re-explanation every session

**After:**
- 4-tier memory system remembers across sessions
- Agents recall effective patterns
- Context automatically assembled

### Problem 3: Memory Rot from Manual Maintenance
**Research Finding (2026 Study):**
> Agents with unbounded memory: **13% accuracy**  
> Agents with active memory management: **39% accuracy**  
> **3x improvement from storing less, not more**

**Before:**
- Manual "update all relevant memory files" commands
- Stale facts accumulate
- Contradictions persist
- Memory files bloat indefinitely

**After:**
- **Auto Dream consolidation** (autonomous)
- Supersession semantics (new replaces old)
- Pruning keeps memory lean (<50 entities)
- No manual maintenance required

---

## Memory Architecture (Based on 2026 Research)

### The CoALA Framework (4 Memory Types)

| Type | What | Persistence | Decay | AgentHQ Use |
|------|------|-------------|-------|-------------|
| **Working** | Active context | Session only | Immediate | Current job execution |
| **Episodic** | Past events | Hours-days | Ebbinghaus | Job history, debug patterns |
| **Semantic** | Facts, relationships | Weeks-months | Supersession | Repo structure, dependencies |
| **Procedural** | Skills, workflows | Indefinite | Rarely | Effective patterns |

### The Critical Gap: Knowledge vs Memory

**Problem:** Most systems treat Knowledge and Memory identically.

**Solution:** 4-layer decomposition with different persistence semantics:

| Layer | Persistence | Example |
|-------|-------------|---------|
| **Knowledge** | Supersession (new replaces old) | "PowersLib has 60 powers" → updated when count changes |
| **Memory** | Ebbinghaus decay (fades without use) | "Last used aws-mcp 3 days ago" |
| **Wisdom** | Evidence-gated revision | "Always test MCP config before activating" |
| **Intelligence** | Ephemeral inference (not stored) | "This error pattern suggests..." |

---

## Auto Dream Pattern (Claude Code, March 2026)

### Autonomous Consolidation Without Manual Triggers

**Automatic Triggers:**
- 24 hours elapsed since last consolidation
- AND 5+ sessions since last consolidation

**Manual Trigger:**
- Say "dream" or "consolidate" or "clean memory"

**Four-Phase Cycle:**
```
Phase 1: Orientation
- Scan memory directory
- Build map of entities

Phase 2: Signal Gathering
- Find corrections in session transcripts
- Identify contradictions
- Detect recurring themes

Phase 3: Consolidation
- Convert relative → absolute dates
- Remove contradictions (newer wins)
- Deduplicate entities
- Merge related facts

Phase 4: Pruning
- Keep memory under threshold (50 entities)
- Remove stale facts (>30 days, no confirmation)
- Log what was changed
```

**Production Results:**
- Consolidated 913 sessions in 8-9 minutes
- Keeps memory lean and accurate autonomously
- No workflow interruption

---

## Proposed Architecture

### Repository + Memory Integration

```
┌─────────────────────────────────────────┐
│        AgentHQ Dashboard                │
│  ┌─────────┐ ┌─────────┐ ┌───────────┐ │
│  │ Repo    │ │ Memory  │ │ Knowledge │ │
│  │ Browser │ │ Browser │ │ Graph     │ │
│  └─────────┘ └─────────┘ └───────────┘ │
└───────┬─────────────────────────────────┘
        │
   ┌────┴────┐
   │         │
┌──▼──────┐ ┌▼──────────────────┐
│ Repo    │ │ Memory            │
│ Registry│ │ Architecture      │
│ (SQLite)│ │ (4-Tier)          │
└──┬──────┘ └┬──────────────────┘
   │         │
   │         ├─► MCP Server Memory (JSON KG)
   │         ├─► Mem0 (from Phase 6)
   │         ├─► Hindsight [Optional]
   │         └─► Zep Temporal KG [Optional]
   │
   ├─► PowersLib
   ├─► SkillsLib
   ├─► ReferenceLib
   └─► Workspace Repos
```

### 4-Tier Memory System

```typescript
// Tier 1: Working Memory (Context Window)
contextWindow: {
  currentJob, activeResources, scratchpad
}

// Tier 2: Episodic Memory (Session History)
episodic: {
  recentJobs, sessionTranscripts,
  decay: 'ebbinghaus'  // Fades without use
}

// Tier 3: Semantic Memory (Facts & Relationships)
semantic: {
  knowledgeGraph: MCPServerMemory,
  entities, relations,
  decay: 'supersession'  // New replaces old
}

// Tier 4: Procedural Memory (Skills & Patterns)
procedural: {
  effectivePatterns, skills, workflows,
  decay: 'none'  // Reinforced by use
}
```

---

## Key Features

### Repository Management

**Multi-Repo Dashboard:**
```
┌─────────────────────────────────────┐
│ Repository Status                   │
├─────────────────────────────────────┤
│ ✓ PowersLib    main  Clean  ↑0 ↓2  │
│   [Pull] [Browse]                   │
│                                     │
│ ⚠ SkillsLib    main  Dirty  ↑1 ↓0 │
│   3 modified files                  │
│   [Commit] [Discard] [Browse]      │
│                                     │
│ ✓ ReferenceLib main  Clean  ↑0 ↓1 │
│   [Pull] [Browse]                  │
└─────────────────────────────────────┘

[Pull All] [Status All]
```

**Operations:**
- Commit with message
- Create/switch/delete branches
- Pull/push across repos
- View commit history
- Diff viewer for changes

### Memory Features

**Semantic Memory (MCP Server Memory):**
```typescript
// Example facts
{
  entity: "PowersLib",
  relation: "contains",
  value: "60 powers",
  valid_from: "2026-07-03",
  source: "registry-scan-12"
}

{
  entity: "aws-mcp",
  relation: "depends_on",
  value: "uvx package manager",
  source: "installation-5"
}
```

**Auto Dream Consolidation:**
```
Trigger: "dream" (or automatic 24h + 5 sessions)

Actions:
✓ Merged 3 duplicate entities
✓ Resolved 2 contradictions (newer facts win)
✓ Removed 5 stale facts (>30 days old)
✓ Converted 4 relative dates to absolute
✓ Pruned: 65 → 48 entities

Memory health: ✓ Under threshold
Next consolidation: 2026-07-04 09:00
```

**Temporal Reasoning (Optional - Zep):**
```typescript
// Query: "Does PROJECT_ITEM have index on PROJECT_SECTION_ID?"
// Answer: Yes (as of now)

// Query: "Did PROJECT_ITEM have index on June 18?"
// Answer: No (index added June 20)

// Validity windows track supersession automatically
{
  entity: "PROJECT_ITEM",
  relation: "has_index_on",
  target: "PROJECT_SECTION_ID",
  valid_from: "2026-06-20T14:30:00Z",
  valid_until: null  // currently true
}
```

---

## Memory System Benchmarks (2026)

| Memory Server | LongMemEval | BEAM (10M) | Staleness Handling |
|--------------|-------------|------------|-------------------|
| **MemPalace** | 96.6% | N/A | Poor (vector blind) |
| **Hindsight** | 91.4% | 64.1% | Good (8-stage consolidation) |
| **Zep** | 94.7% | N/A | Excellent (temporal KG) |
| **Mem0** | 92.5% (LoCoMo) | 64.1% (BEAM) | Good (conflict detection) |
| **MCP server-memory** | Baseline | Baseline | None (manual only) |

---

## Implementation Phases

### Phase 8.1: Repository Registry & Git Integration (3-4 days)
- Discover all configured repos
- Track git status in real-time
- Background monitoring (60s refresh)

### Phase 8.2: Repository Operations UI (4-5 days)
- Multi-repo status dashboard
- Commit/branch operations
- Diff viewer
- Real-time updates via WebSocket

### Phase 8.3: Memory Architecture Foundation (5-6 days)
- Set up @mcp/server-memory
- Define semantic memory schema
- Extract facts from jobs
- Memory browser UI
- Integrate with Phase 6 Mem0

### Phase 8.4: Auto Dream Consolidation (3-4 days)
- Implement 4-phase consolidation
- Automatic triggers (24h + 5 sessions)
- Manual "dream" command
- Supersession logic
- Consolidation reporting

### Phase 8.5: Hindsight Integration [Optional] (4-5 days)
- Deploy Hindsight (Docker)
- Configure 4-network architecture
- Experience tracking
- Belief evolution

### Phase 8.6: Zep Temporal KG [Optional] (3-4 days)
- Deploy Zep (managed or self-hosted)
- Validity window tracking
- Temporal queries
- Automatic supersession

**Total Duration:** 22-30 days (core), 30-38 days (with optional)

---

## Decision Matrix

### Which Memory System to Use?

**MCP Server Memory + Auto Dream** ✅ **RECOMMENDED**
- ✅ Zero dependencies (local JSON)
- ✅ Auto Dream works great
- ✅ Fast and simple
- ✅ Good for <6 month engagements
- ❌ No advanced temporal queries
- ❌ Limited to ~50 entities

**Mem0 (from Phase 6)**
- ✅ Cross-tool memory (Cursor, Claude Code)
- ✅ Token efficient (6,900 vs 26,000)
- ✅ Multi-scope (user, workspace, agent)
- ✅ Managed service option
- ❌ Requires external service or deployment

**Hindsight**
- ✅ 4-network architecture
- ✅ 8-stage consolidation pipeline
- ✅ Episodic memory tracking
- ❌ Docker deployment required
- ❌ More complex setup

**Zep Temporal KG**
- ✅ Automatic supersession
- ✅ "What was true when" queries
- ✅ Validity windows
- ✅ Production-grade
- ❌ Managed service or complex self-host
- ❌ Cost for managed version

**Recommended Hybrid:**
```
MCP Server Memory (semantic facts) + Auto Dream
         +
Mem0 (user/workspace memory) from Phase 6
         +
[Optional] Zep for long-running engagements
```

---

## Integration with Existing Phases

### Phase 4 (Multi-Workspace) ✅
- Repository links scoped per workspace
- Workspace profiles include repo configs

### Phase 5 (Database + Analytics) ✅
- Repository operations logged
- Analytics include repo activity

### Phase 6 (Memory - Mem0) ✅
- Mem0 provides user/workspace memory layer
- MCP provides semantic facts layer
- Complementary, not conflicting

### Phase 7 (Library Management) ✅
- Repository monitoring enables update detection
- Power/skill versions tracked via git
- Resource discovery feeds from repo registry

### Agent Execution ✅
```typescript
// Before execution: Assemble context
const context = {
  // Phase 6: Mem0 user memory
  userMemories: await mem0.search({ user_id, workspace_id }),
  
  // Phase 8: Semantic facts
  semanticFacts: await mcpMemory.queryGraph({ entities: ['repo'] }),
  
  // Phase 8: Procedural patterns
  effectivePatterns: await procedural.getPatterns({ workspace_id }),
  
  // Phase 8: Repo status
  repoStatus: await repos.getWorkspaceRepos({ workspace_id })
};

// After execution: Store learnings
await mcpMemory.addFacts(extractedFacts);
await checkConsolidationTrigger();  // Auto Dream
```

---

## Configuration

```bash
# Repository monitoring
REPO_MONITORING_ENABLED=true
REPO_SCAN_INTERVAL=60000  # 60 seconds

# Memory architecture
MEMORY_ARCH=mcp  # 'mcp', 'hindsight', 'zep', 'mem0', 'hybrid'
MEMORY_CONSOLIDATION_AUTO=true
MEMORY_CONSOLIDATION_INTERVAL=86400000  # 24 hours
MEMORY_CONSOLIDATION_SESSION_THRESHOLD=5

# MCP Memory Server
MCP_MEMORY_PATH=./data/memory.json
MCP_MEMORY_MAX_ENTITIES=50

# Optional: Hindsight
HINDSIGHT_ENABLED=false
HINDSIGHT_URL=http://localhost:3100

# Optional: Zep
ZEP_ENABLED=false
ZEP_API_KEY=
ZEP_URL=https://api.getzep.com

# Repository paths
POWERSLIB_PATH=c:\repos\PowersLib
SKILLSLIB_PATH=c:\repos\SkillsLib
REFERENCELIB_PATH=c:\repos\ReferenceLib
```

### Dependencies

```json
{
  "dependencies": {
    "simple-git": "^3.20.0",
    "@modelcontextprotocol/server-memory": "latest",
    "@getzep/zep-js": "latest"  // Optional
  }
}
```

---

## Success Metrics

### Quantitative
- **Repo Discovery:** 100% of configured repos found
- **Status Accuracy:** <5s lag from git operation
- **Memory Retrieval:** <200ms for semantic queries
- **Consolidation:** <10 min for 1000 entities
- **Memory Accuracy:** >80% fact relevance
- **Temporal Queries:** <500ms (if Zep)

### Qualitative
- Agents remember across sessions
- No manual "update memory" needed
- Consolidation removes stale facts automatically
- Temporal reasoning prevents outdated facts
- Repository management centralized

---

## The Transform

**Before Phase 8:**
```
Agent Session 1: "What repos are installed?"
Developer: "PowersLib, SkillsLib, ReferenceLib"

Agent Session 2 (next day): "What repos are installed?"
Developer: "PowersLib, SkillsLib, ReferenceLib" (again!)

Agent: Never remembers. Context resets every session.
```

**After Phase 8:**
```
Agent Session 1: "What repos are installed?"
(Queries semantic memory)
Agent: "PowersLib (60 powers), SkillsLib (50 skills), ReferenceLib (1000+ pages)"

Agent Session 2 (next day): "What's the status?"
(Queries memory + live repo status)
Agent: "PowersLib has 2 updates available. SkillsLib clean. ReferenceLib has 1 uncommitted change."

Auto Dream runs overnight:
✓ Consolidated 5 sessions
✓ Updated "PowersLib has 58 powers" → "PowersLib has 60 powers"
✓ Removed stale fact from 30 days ago
```

---

## Risk Mitigation

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Git operation failures | High | Medium | Robust error handling, validation, rollback |
| Memory consolidation errors | High | Low | Backup before consolidation, dry-run mode, rollback |
| Memory bloat | Medium | Medium | Hard entity limit (50), aggressive pruning |
| Supersession logic bugs | High | Medium | Extensive testing, source tracking, replay capability |
| Performance with large repos | Medium | Low | Incremental checks, background scanning, caching |

---

## Key Innovation

### No More Manual Memory Maintenance

**Old Pattern (Failed):**
```
Developer: "Update all relevant memory files"
Agent: Appends to files (bloat)
      Adds contradictions (confusion)
      Never removes stale facts (rot)
Result: 13% accuracy after accumulation
```

**New Pattern (Auto Dream):**
```
Auto Dream triggers every 24h + 5 sessions
Agent: Scans memory autonomously
      Merges duplicates
      Supersedes contradictions (newer wins)
      Prunes stale facts (>30 days)
      Keeps memory under 50 entities
Result: 39% accuracy (3x improvement)
```

**Key Insight:**
> Better memory comes from storing **less**, not more.  
> Active management > passive accumulation.

---

## Next Steps

### This Week
1. ✅ Review Phase 8 specification
2. ⚡ Create Phase 8 Kiro spec
3. ⚡ Design repository registry schema
4. ⚡ Set up MCP server-memory locally
5. ⚡ Build Auto Dream skill prototype

### Next 2 Weeks
- Implement repository registry & git integration
- Build repository operations UI
- Basic repo management working

### Next Month
- Complete memory architecture foundation
- Implement Auto Dream consolidation
- Full repo + memory system operational

---

## References

### Memory Research
- `ReferenceLib/claude/anthropic.com/memory-architecture-full-writeup.md`
- CoALA Framework (Sumers et al., 2023)
- arxiv 2604.23878 - 7-layer neuroscience architecture
- arxiv 2604.11364 - Missing Knowledge Layer
- arxiv 2512.12818 - Hindsight 4-network
- arxiv 2601.03236 - MAGMA multi-graph
- arxiv 2501.13956 - Zep temporal KG

### Production Patterns
- Claude Code Auto Dream (March 2026)
- Unblocked Memory Server Comparison (May 2026)
- Mem0 State of AI Agent Memory 2026

### Documents
- Spec: `docs/prompts/phase-8-repository-management.md`
- Summary: `docs/REPOSITORY-MEMORY-SUMMARY.md` (this file)

---

**Status:** ✅ Phase 8 fully specified and ready for implementation

**Prerequisites:** Phases 4 (Multi-Workspace), 5 (Database), 6 (Memory - Mem0), 7 (Library Management)

**Recommended Approach:** MCP Server Memory + Auto Dream + Phase 6 Mem0 (hybrid)

**Optional Enhancements:** Hindsight (episodic), Zep (temporal KG) for long-running engagements
