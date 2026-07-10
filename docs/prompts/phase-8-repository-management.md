# Phase 8: Repository Management & Memory Architecture for AgentHQ

## Executive Summary

Transform AgentHQ into a comprehensive repository management system that tracks, manages, and provides intelligent insights across all agent-related repositories: PowersLib, SkillsLib, ReferenceLib, and any workspace repositories. Integrate advanced memory architecture (based on CoALA framework and 2026 research) to enable agents to remember across sessions, consolidate knowledge, and maintain context without manual intervention.

## Vision

AgentHQ becomes the **"Git + Memory Hub"** for AI agents:
- **Track** all repositories (workspace repos, PowersLib, SkillsLib, ReferenceLib)
- **Monitor** git status, branches, commits across repos
- **Manage** operations (clone, pull, push, branch, commit) from dashboard
- **Remember** context with advanced memory architecture (CoALA + Auto Dream)
- **Consolidate** knowledge autonomously (no manual "update memory" commands)
- **Reason** about temporal facts (what was true when)

---

## Memory Architecture Research Summary

### The Foundational Problem

**From 2026 Memory Research:**
> AI agents are stateless. Manual memory maintenance produces memory rot — stale facts, contradictions, bloat. Study: agents with unbounded memory hit 13% accuracy. Same agents with active memory management: 39% accuracy (3x improvement from storing less).

### The Four Memory Types (CoALA Framework)

| Type | What it stores | Persistence | Decay | AgentHQ Use Case |
|------|---------------|-------------|-------|------------------|
| **Working** | Active context | Session only | Immediate | Current job execution |
| **Episodic** | Past sessions/events | Hours-days | Ebbinghaus | Job history, debugging patterns |
| **Semantic** | Facts, relationships | Weeks-months | Supersession | Repo structure, dependencies |
| **Procedural** | Skills, workflows | Indefinite | Rarely | Effective job chains, patterns |

### The Critical Gap Identified

**Problem:** Most memory systems treat Knowledge and Memory identically (same update, same decay).


**Solution:** Four-layer decomposition with different persistence semantics:

| Layer | Persistence Semantic | Example in AgentHQ |
|-------|---------------------|-------------------|
| **Knowledge** | Supersession - new replaces old | "PowerLib has 60 powers" → updated when count changes |
| **Memory** | Ebbinghaus decay - fades without use | "Last used aws-mcp 3 days ago" |
| **Wisdom** | Evidence-gated revision | "Always test MCP config before activating" |
| **Intelligence** | Ephemeral inference | "This error pattern suggests..." (not stored) |

### Auto Dream Pattern (Claude Code, March 2026)

**Autonomous consolidation without manual triggers:**

```
Trigger: 24h elapsed AND 5+ sessions since last consolidation
OR manual: say "dream" or "consolidate"

Phase 1 - Orientation: Scan memory, build map
Phase 2 - Signal Gathering: Find corrections, contradictions
Phase 3 - Consolidation: Merge duplicates, supersede old facts
Phase 4 - Pruning: Keep memory lean (<200 lines)

Result: Consolidated 913 sessions in 8-9 minutes
```

### Benchmark Comparison (May 2026)

| Memory Server | LongMemEval | BEAM (10M) | Staleness Handling |
|--------------|-------------|------------|-------------------|
| **MemPalace** | 96.6% | N/A | Poor (vector blind) |
| **Hindsight** | 91.4% | 64.1% | Good (consolidation) |
| **Zep** | 94.7% | N/A | Excellent (temporal KG) |
| **Mem0** | See Phase 6 | See Phase 6 | Good (conflict detection) |
| **@mcp/server-memory** | Baseline | Baseline | None (manual only) |

---

## Current State Analysis

### Existing Repository Structure

**PowersLib** (`c:\repos\PowersLib`)
- 20+ organizations
- ~60+ powers
- Git repo, regularly updated

**SkillsLib** (`c:\repos\SkillsLib`)
- 14+ skill collections
- Git repo, regularly updated

**ReferenceLib** (`c:\repos\ReferenceLib`)
- Crawled documentation (claude, mcp, oracle, powerbi, kiro)
- ~1,000+ pages
- Git repo with crawl queues

**AgentHQ** (`c:\repos\corneldann\agenthq`)
- Main application repo
- Workspace configurations

### Current Gaps ❌

1. **No Unified View** - Can't see status of all repos at once
2. **No Cross-Repo Operations** - Must switch directories manually
3. **No Memory System** - Agents forget everything between sessions
4. **No Consolidation** - Manual "update memory" commands create bloat
5. **No Temporal Reasoning** - Can't answer "what was true when"
6. **No Auto Dream** - No autonomous memory maintenance

---

## Proposed Architecture

### Repository Management Layer

```
┌─────────────────────────────────────────────────┐
│          AgentHQ Dashboard                      │
│  ┌──────────┐ ┌──────────┐ ┌────────────────┐ │
│  │  Repo    │ │  Memory  │ │  Knowledge     │ │
│  │ Browser  │ │ Browser  │ │  Graph         │ │
│  └──────────┘ └──────────┘ └────────────────┘ │
└───────────┬─────────────────────────────────────┘
            │
    ┌───────┴───────┐
    │               │
┌───▼──────────┐  ┌▼──────────────────┐
│ Repository   │  │ Memory            │
│ Registry DB  │  │ Architecture      │
│ (SQLite)     │  │ (Multi-Layer)     │
└───┬──────────┘  └┬──────────────────┘
    │              │
    │              ├─► @mcp/server-memory (JSON KG)
    │              ├─► Hindsight (4-network)
    │              ├─► Zep (Temporal KG) [Optional]
    │              └─► Mem0 (from Phase 6)
    │
    ├─► PowersLib
    ├─► SkillsLib  
    ├─► ReferenceLib
    └─► Workspace Repos
```

### Integrated Memory Architecture

**4-Tier Memory System:**

```typescript
interface MemorySystem {
  // Tier 1: Working Memory (Context Window)
  contextWindow: {
    currentJob: Job;
    activeResources: Resource[];
    scratchpad: string;
  };
  
  // Tier 2: Episodic Memory (Session History)
  episodic: {
    recentJobs: Job[];
    sessionTranscripts: SessionState[];
    decay: 'ebbinghaus';  // Fades without reinforcement
  };
  
  // Tier 3: Semantic Memory (Facts & Relationships)
  semantic: {
    knowledgeGraph: MCPServerMemory;  // JSON graph
    entities: Entity[];
    relations: Relation[];
    decay: 'supersession';  // New replaces old
  };
  
  // Tier 4: Procedural Memory (Skills & Patterns)
  procedural: {
    effectivePatterns: Pattern[];
    skills: Skill[];
    workflows: Workflow[];
    decay: 'none';  // Reinforced by use
  };
}
```

---

## Feature Requirements

### FR-1: Repository Registry & Monitoring

**User Stories:**
- As a developer, I want to see git status of all repos at once
- As a developer, I want to pull updates across all repos with one click
- As a developer, I want notifications when repos have uncommitted changes

**Features:**
- Auto-discover repos (PowersLib, SkillsLib, ReferenceLib, workspaces)
- Track: branch, status (clean/dirty), ahead/behind, last commit
- Multi-repo operations (pull all, status all, push all)
- Change notifications in dashboard

**UI Component:**
```
┌─────────────────────────────────────────────┐
│ Repository Status                           │
├─────────────────────────────────────────────┤
│ ✓ PowersLib      main   Clean   ↑0 ↓2      │
│   [Pull] [Browse]                           │
│                                             │
│ ⚠ SkillsLib      main   Dirty   ↑1 ↓0     │
│   3 modified files                          │
│   [Commit] [Discard] [Browse]              │
│                                             │
│ ✓ ReferenceLib   main   Clean   ↑0 ↓1     │
│   [Pull] [Browse]                          │
│                                             │
│ ⚠ agenthq        main   Dirty   ↑5 ↓0     │
│   12 modified, 3 new files                  │
│   [Commit] [Push] [Browse]                 │
└─────────────────────────────────────────────┘

[Pull All] [Status All]
```

### FR-2: Repository Operations from Dashboard

**User Stories:**
- As a developer, I want to commit changes without leaving AgentHQ
- As a developer, I want to create branches for feature work
- As a developer, I want to view commit history

**Features:**
- Commit with message
- Create/switch/delete branches
- Pull/push operations
- View commit log
- Diff viewer for changes
- Conflict resolution UI (basic)

**Commit Flow:**
```
User clicks "Commit" on SkillsLib
  ↓
Show staged/unstaged files
  ↓
User writes commit message
  ↓
Execute git commit
  ↓
Update repository status
  ↓
Broadcast via WebSocket
  ↓
Show success notification
```

### FR-3: Memory Architecture Integration

**User Stories:**
- As an agent, I want to remember repo structure across sessions
- As an agent, I want to recall effective patterns from past jobs
- As an agent, I want to know when facts become outdated

**Memory Layers:**

**Layer 1: MCP Server Memory (Semantic Facts)**
- Store: Repo structure, dependencies, effective resource combinations
- Update: Supersession semantics (new replaces old)
- Consolidation: Auto Dream pattern (autonomous)

```typescript
// Example semantic facts
{
  entity: "PowersLib",
  relation: "contains",
  value: "60 powers across 20 organizations",
  valid_from: "2026-07-03",
  source: "registry-scan-12"
}

{
  entity: "aws-mcp",
  relation: "depends_on",
  value: "uvx package manager",
  valid_from: "2026-06-15",
  source: "installation-attempt-5"
}
```

**Layer 2: Hindsight (Episodic + Experience)**
- Store: Job execution history, what worked, what failed
- Update: Append-only with decay
- 4-network architecture: World facts, Agent experiences, Entity summaries, Evolving beliefs

**Layer 3: Procedural (Skills + Patterns)**
- Store: Effective job chains, debugging procedures
- Update: Reinforced by successful use
- Source: Phase 7 usage analytics + manual curation

### FR-4: Auto Dream Consolidation

**User Stories:**
- As an agent, I want memory to self-maintain without manual commands
- As a developer, I want to trigger consolidation with one word: "dream"
- As a developer, I want to see what was consolidated

**Auto Dream Implementation:**

```typescript
interface DreamConfig {
  // Automatic triggers
  timeSinceLastDream: number;  // 24 hours
  sessionsSinceLastDream: number;  // 5 sessions
  
  // Manual trigger
  keywords: string[];  // ["dream", "consolidate", "clean memory"]
  
  // Consolidation phases
  phases: [
    'orientation',      // Scan memory, build map
    'signal_gathering', // Find corrections, contradictions
    'consolidation',    // Merge, supersede, deduplicate
    'pruning'          // Remove stale, keep <200 lines
  ];
  
  // Thresholds
  maxEntities: number;  // 50 for fast startup
  staleDays: number;    // 30 days with no confirmation
}
```

**Dream Skill Design:**
```markdown
# memory-consolidation SKILL

Trigger: "dream", "consolidate", or auto (24h + 5 sessions)

Phase 1: Read all entities from @mcp/server-memory
Phase 2: Identify:
  - Duplicate entities (same name, similar relations)
  - Contradicting observations (PowersLib has 60 vs 65 powers)
  - Stale dates (>30 days old, no subsequent confirmation)
Phase 3: Actions:
  - Merge duplicates (keep most recent)
  - Supersede contradictions (newer fact wins)
  - Convert relative → absolute dates
Phase 4: Prune:
  - Delete superseded facts
  - Keep graph under 50 entities
  - Log consolidation report

Output: Summary of what was merged/removed/updated
```

### FR-5: Temporal Knowledge Graph (Optional - Zep Integration)

**User Stories:**
- As an agent, I want to know "what was true when"
- As an agent, I want to handle supersession automatically
- As an agent, I want to query history without manual consolidation

**Zep Temporal KG:**
```typescript
interface TemporalFact {
  entity: string;
  relation: string;
  target: string;
  valid_from: string;    // ISO timestamp
  valid_until: string | null;  // null = still true
  source: string;
  confidence: number;
}

// Example: Index lifecycle
[
  {
    entity: "PROJECT_ITEM",
    relation: "missing_index_on",
    target: "PROJECT_SECTION_ID",
    valid_from: "2026-06-15T10:00:00Z",
    valid_until: "2026-06-20T14:30:00Z",
    source: "oracle-analysis-session-7"
  },
  {
    entity: "PROJECT_ITEM",
    relation: "has_index_on",
    target: "PROJECT_SECTION_ID",
    valid_from: "2026-06-20T14:30:00Z",
    valid_until: null,  // currently true
    source: "ddl-execution-session-12"
  }
]

// Query: "Does PROJECT_ITEM have index on PROJECT_SECTION_ID?"
// Answer: Yes (as of now)
// Query: "Did PROJECT_ITEM have index on June 18?"
// Answer: No
```

**When to Use Zep:**
- Long-running engagements (>6 months)
- Critical supersession requirements
- Need to query historical states

**When to Use MCP + Auto Dream:**
- Bounded engagements (<6 months)
- Consolidation skill approximates temporal KG well enough
- Prefer zero-dependency local deployment

### FR-6: Repository-Workspace Linking

**User Stories:**
- As a developer, I want to see which repos are used by which workspaces
- As a developer, I want workspace-specific git branches
- As a developer, I want to track workspace-repo dependencies

**Linking Model:**
```typescript
interface WorkspaceRepoLink {
  workspaceId: string;
  repoPath: string;
  repoType: 'powerslib' | 'skillslib' | 'referencelib' | 'workspace';
  activeBranch: string;
  installedResources: string[];  // From Phase 7
  lastPull: string;
  autoSync: boolean;  // Auto-pull on workspace activation
}

// Example: scottish-water workspace
{
  workspaceId: "scottish-water",
  links: [
    {
      repoPath: "c:\\repos\\PowersLib",
      repoType: "powerslib",
      activeBranch: "main",
      installedResources: ["oracle-carbon-analysis", "powerbi-modeling-mcp"],
      lastPull: "2026-07-03T09:00:00Z",
      autoSync: true
    },
    {
      repoPath: "c:\\repos\\SkillsLib",
      repoType: "skillslib",
      activeBranch: "main",
      installedResources: ["db-oracle", "web-best-practices"],
      autoSync: true
    }
  ]
}
```

---

## Implementation Phases

### Phase 8.1: Repository Registry & Git Integration (3-4 days)

**CRITICAL: Dual Locking Pattern for Windows SSH Key Serialization**

**Problem Discovered:** Windows SSH agent doesn't handle concurrent key access well. Two simultaneous `git push` operations reading `~/.ssh/id_rsa` cause conflicts.

**Solution:** Per-repo lock + global credential lock

**Tasks:**
1. Design repository registry schema
2. Implement repo discovery (scan configured paths)
3. Build git status tracker (libgit2 or git CLI)
4. **Implement dual locking pattern:**
   - Per-repo locks: `.kiro/locks/{workspace_id}.lock`
   - Global credential lock: `.kiro/locks/git-credentials.lock`
5. Create repository API endpoints
6. Implement periodic status refresh (every 60s)
7. Add webhook support for git events (optional)

**Dual Locking Implementation:**
```typescript
// Phase 8: Git operation queue with dual locking
async function queueGitOperation(workspaceId: string, operation: GitOperation) {
  const repoLockPath = `.kiro/locks/${workspaceId}.lock`;
  const credentialLockPath = `.kiro/locks/git-credentials.lock`;
  
  // Acquire per-repo lock (prevents concurrent ops in same repo)
  await acquireLock(repoLockPath, timeout: 30000);
  
  try {
    // If operation needs credentials (push, pull, fetch), acquire global lock
    if (operation.needsCredentials) {
      await acquireLock(credentialLockPath, timeout: 10000);
      try {
        await executeGitOperation(operation);
      } finally {
        await releaseLock(credentialLockPath);
      }
    } else {
      // Local operations (status, add, commit) don't need credential lock
      await executeGitOperation(operation);
    }
  } finally {
    await releaseLock(repoLockPath);
  }
}
```

**Operations That Need Credential Lock:**
- `git push` (SSH key or PAT)
- `git pull` (SSH key or PAT)
- `git fetch` (SSH key or PAT)
- `git clone` (SSH key or PAT)

**Operations That Don't Need Credential Lock:**
- `git status` (local only)
- `git add` (local only)
- `git commit` (local only)
- `git log` (local only)

**Result:** Multiple repos can commit simultaneously, but only one can push at a time (Windows SSH key serialization).

**Files to Create:**
- `src/repos/schema.sql` - Repository registry schema
- `src/repos/scanner.ts` - Repo discovery and scanning
- `src/repos/git.ts` - Git operations wrapper with dual locking
- `src/repos/locks.ts` - Lock acquisition/release utilities
- `src/repos/status.ts` - Git status tracking
- `src/routes/repos.ts` - Repository API endpoints
- `src/workers/repo-monitor.ts` - Background status monitor

**Success Criteria:**
- All configured repos discovered
- Git status accurate and real-time
- Status updates within 60s of git operations
- API returns correct repo information
- **Dual locking prevents SSH key conflicts**
- **Concurrent commits work, pushes serialized**

### Phase 8.2: Repository Operations UI (4-5 days)

**Tasks:**
1. Design repository browser layout
2. Implement multi-repo status view
3. Build commit dialog with file staging
4. Add branch management UI
5. Implement pull/push operations
6. Create diff viewer for changes
7. Add commit history viewer
8. Real-time updates via WebSocket

**Files to Create:**
- `src/dashboard/pages/repos.ts` - Repository browser page
- `src/dashboard/components/repo-card.ts` - Repo status card
- `src/dashboard/components/commit-dialog.ts` - Commit UI
- `src/dashboard/components/branch-selector.ts` - Branch management
- `src/dashboard/components/diff-viewer.ts` - Change diff display

**Success Criteria:**
- All repos visible with correct status
- Commit operations work end-to-end
- Branch operations work correctly
- Diff viewer displays changes accurately
- Real-time updates via WebSocket

### Phase 8.3: Memory Architecture Foundation (5-6 days)

**CRITICAL: This Phase Depends on Phase 6 Completion**

Phase 8.3 extends the memory system from Phase 6 — it does NOT replace it. Before starting Phase 8.3:

**Pre-requisites:**
1. Phase 6.1 (Memory Infrastructure Setup) MUST be complete — MCP memory client operational
2. Phase 6.2 (Automatic Memory Extraction) MUST be complete — extraction pipeline working
3. Phase 6.4 (Memory Browser Dashboard) MUST be complete — memory UI exists to extend

**Phase 8.3 builds on Phase 6 by adding:**
- Auto Dream autonomous consolidation (24h + 5 session triggers)
- Supersession semantics (new facts replace old, not accumulate)
- Ebbinghaus decay (episodic memories fade without reinforcement)
- Procedural memory tier (skills and effective patterns)

**Do NOT re-implement Phase 6 work.** Phase 8.3 extends existing memory modules:
- `src/memory/client.ts` → add Auto Dream triggers
- `src/memory/extraction.ts` → add supersession logic
- `src/dashboard/pages/memory.ts` → add consolidation UI

**Tasks:**
1. **MANDATORY FIRST: Verify Phase 6.1, 6.2, 6.4 completion status**
2. Extend @mcp/server-memory with Auto Dream consolidation
3. Implement supersession semantics (new replaces old)
4. Add Ebbinghaus decay for episodic memories
5. Build procedural memory tier (skills + patterns)
6. Implement Auto Dream triggers (24h + 5 sessions)
7. Add manual dream trigger ("dream" command)
8. Extend memory browser UI with consolidation report view

**Files to Create:**
- `src/memory/mcp-memory.ts` - MCP memory server wrapper
- `src/memory/extraction.ts` - Extract facts from jobs/sessions
- `src/memory/schema.ts` - Memory entity/relation definitions
- `src/memory/query.ts` - Memory query interface
- `src/dashboard/pages/memory-graph.ts` - Memory graph viewer

**Success Criteria:**
- MCP memory server running
- Facts extracted from completed jobs
- Memory queryable via API
- Agent receives memory context before execution
- Memory browser displays knowledge graph

### Phase 8.4: Auto Dream Consolidation (3-4 days)

**Tasks:**
1. Implement Auto Dream skill
2. Build consolidation pipeline (4 phases)
3. Add automatic triggers (24h + 5 sessions)
4. Create manual trigger ("dream" command)
5. Implement supersession logic
6. Add consolidation reporting
7. Integrate with memory browser

**Files to Create:**
- `src/memory/consolidation.ts` - Consolidation engine
- `src/memory/dream.ts` - Auto Dream implementation
- `src/memory/supersession.ts` - Supersession logic
- `.kiro/skills/memory-consolidation/SKILL.md` - Dream skill
- `src/routes/dream.ts` - Manual dream trigger endpoint

**Success Criteria:**
- Auto Dream triggers automatically (24h + 5 sessions)
- Manual "dream" command works
- Consolidation removes duplicates and contradictions
- Supersession replaces old facts with new
- Memory stays under 50 entities (pruning works)
- Consolidation report shows what changed

### Phase 8.5: Hindsight Integration (Optional, 4-5 days)

**Tasks:**
1. Deploy Hindsight MCP server (Docker)
2. Configure 4-network architecture
3. Integrate with AgentHQ agent execution
4. Build experience tracking
5. Implement belief evolution
6. Create Hindsight browser UI

**Files to Create:**
- `docker-compose.yml` - Hindsight deployment
- `src/memory/hindsight.ts` - Hindsight client wrapper
- `src/memory/networks/` - 4-network implementations
- `src/dashboard/pages/hindsight.ts` - Hindsight UI

**Success Criteria:**
- Hindsight deployed and accessible
- 4 networks populated with correct data
- Agent experiences tracked
- Beliefs evolve based on evidence
- Hindsight UI displays all networks

### Phase 8.6: Zep Temporal KG Integration (Optional, 3-4 days)

**Tasks:**
1. Deploy Zep (managed or self-hosted)
2. Configure temporal knowledge graph
3. Implement validity window tracking
4. Build temporal query interface
5. Migrate critical facts from MCP to Zep
6. Add temporal reasoning to agent

**Files to Create:**
- `src/memory/zep.ts` - Zep client wrapper
- `src/memory/temporal.ts` - Temporal fact management
- `src/memory/migration.ts` - MCP → Zep migration
- `src/routes/temporal.ts` - Temporal query API

**Success Criteria:**
- Zep deployed and accessible
- Facts tracked with validity windows
- Temporal queries work ("what was true when")
- Supersession automatic (no manual consolidation)
- Migration from MCP successful

**Total Duration:** 22-30 days (excluding optional Hindsight/Zep)

---

## Database Schema

### Repository Registry

```sql
-- Repositories table
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,  -- 'powerslib', 'skillslib', 'referencelib', 'workspace'
  name TEXT NOT NULL,
  description TEXT,
  
  -- Git status
  current_branch TEXT,
  is_clean BOOLEAN,
  ahead_count INTEGER DEFAULT 0,
  behind_count INTEGER DEFAULT 0,
  modified_files INTEGER DEFAULT 0,
  untracked_files INTEGER DEFAULT 0,
  
  -- Metadata
  last_commit_hash TEXT,
  last_commit_message TEXT,
  last_commit_date TIMESTAMP,
  last_pull TIMESTAMP,
  last_push TIMESTAMP,
  
  -- Monitoring
  auto_sync BOOLEAN DEFAULT FALSE,
  last_scan TIMESTAMP,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_type (type),
  INDEX idx_status (is_clean)
);

-- Workspace-repository links
CREATE TABLE workspace_repo_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  active_branch TEXT,
  installed_resources TEXT,  -- JSON array
  auto_sync BOOLEAN DEFAULT TRUE,
  
  UNIQUE (workspace_id, repository_id),
  INDEX idx_workspace (workspace_id)
);

-- Repository operations log
CREATE TABLE repo_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  operation TEXT NOT NULL,  -- 'pull', 'push', 'commit', 'branch', etc.
  user_id TEXT,
  details TEXT,  -- JSON
  success BOOLEAN,
  error_message TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_repo_time (repository_id, timestamp DESC)
);
```

### Memory Architecture

```sql
-- Memory consolidation history
CREATE TABLE memory_consolidations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type TEXT NOT NULL,  -- 'auto', 'manual'
  entities_before INTEGER,
  entities_after INTEGER,
  duplicates_merged INTEGER,
  contradictions_resolved INTEGER,
  stale_facts_removed INTEGER,
  duration_ms INTEGER,
  report TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_timestamp (timestamp DESC)
);

-- Temporal facts (if not using Zep)
CREATE TABLE temporal_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  relation TEXT NOT NULL,
  target TEXT NOT NULL,
  valid_from TIMESTAMP NOT NULL,
  valid_until TIMESTAMP,  -- NULL = still valid
  source TEXT,
  confidence REAL DEFAULT 1.0,
  
  INDEX idx_entity (entity),
  INDEX idx_validity (entity, valid_from, valid_until)
);
```

---

## Configuration

```bash
# .env additions
REPO_MONITORING_ENABLED=true
REPO_SCAN_INTERVAL=60000  # 60 seconds
REPO_AUTO_SYNC=false      # Auto-pull on changes

# Memory architecture
MEMORY_ARCH=mcp  # 'mcp', 'hindsight', 'zep', 'mem0'
MEMORY_CONSOLIDATION_AUTO=true
MEMORY_CONSOLIDATION_INTERVAL=86400000  # 24 hours
MEMORY_CONSOLIDATION_SESSION_THRESHOLD=5

# MCP Memory Server
MCP_MEMORY_PATH=./data/memory.json
MCP_MEMORY_MAX_ENTITIES=50

# Hindsight (optional)
HINDSIGHT_ENABLED=false
HINDSIGHT_URL=http://localhost:3100

# Zep (optional)
ZEP_ENABLED=false
ZEP_API_KEY=
ZEP_URL=https://api.getzep.com

# Repository paths (already have from Phase 7)
POWERSLIB_PATH=c:\repos\PowersLib
SKILLSLIB_PATH=c:\repos\SkillsLib
REFERENCELIB_PATH=c:\repos\ReferenceLib
```

### Dependencies

```json
{
  "dependencies": {
    "simple-git": "^3.20.0",     // Git operations
    "isomorphic-git": "^1.24.5", // Alternative git lib
    "@modelcontextprotocol/server-memory": "latest",  // MCP memory
    "@getzep/zep-js": "latest"   // Zep client (optional)
  }
}
```

---

## Integration with Existing Features

### Phase 4 (Multi-Workspace)
- Repository links scoped per workspace
- Workspace profiles include repo configurations
- Workspace switching updates active repo view

### Phase 5 (Database + Analytics)
- Repository operations logged in database
- Analytics include repo activity metrics
- Job metadata includes repo state at execution time

### Phase 6 (Memory - Mem0)
- Mem0 provides one memory layer option
- Can coexist with MCP memory (different scopes)
- Mem0 for user/workspace memory, MCP for semantic facts

### Phase 7 (Library Management)
- Repository registry feeds resource discovery
- Power/skill versions tracked via git commits
- Updates detected from repo monitoring

### Agent Execution Integration

```typescript
// Before agent execution
const context = await assembleContext({
  workspace_id,
  job_id,
  
  // From Phase 6: Mem0 memory
  userMemories: await mem0.search({ user_id, workspace_id }),
  
  // From Phase 8: Semantic memory
  semanticFacts: await mcpMemory.queryGraph({ entities: ['repo', 'power', 'skill'] }),
  
  // From Phase 8: Procedural memory
  effectivePatterns: await procedural.getPatterns({ workspace_id }),
  
  // From Phase 8: Repo context
  repoStatus: await repos.getWorkspaceRepos({ workspace_id })
});

// After execution
await mcpMemory.addFacts(extractedFacts);
await checkConsolidationTrigger();  // Auto Dream
```

---

## Success Metrics

### Quantitative
- **Repo Discovery:** 100% of configured repos found
- **Status Accuracy:** <5s lag between git operation and status update
- **Memory Retrieval:** <200ms for semantic fact queries
- **Consolidation Time:** <10 minutes for 1000 entities
- **Memory Accuracy:** >80% fact relevance (measured via user feedback)
- **Temporal Queries:** <500ms for "what was true when" (if Zep)

### Qualitative
- Agents remember context across sessions
- No manual "update memory" commands needed
- Consolidation removes stale facts automatically
- Temporal reasoning prevents outdated fact hallucination
- Repository management centralized and efficient

---

## Risk Assessment

### Risk 1: Git Operation Failures
**Impact:** High | **Probability:** Medium

**Mitigation:**
- Robust error handling for all git operations
- Validation before operations (check clean state)
- Rollback mechanism for failed operations
- Clear error messages with resolution steps
- **Dual locking prevents credential conflicts**

### Risk 2: SSH Key Conflicts (Windows-Specific)
**Impact:** High | **Probability:** High (without dual locking)

**Mitigation:**
- **Global credential lock serializes push/pull operations**
- Per-repo locks still allow concurrent local operations (commit, add, status)
- Lock timeout (10s for credential, 30s for repo)
- Clear error messages if lock acquisition fails

### Risk 3: Memory Consolidation Errors
**Impact:** High | **Probability:** Low

**Mitigation:**
- Backup before consolidation
- Dry-run mode to preview changes
- Rollback capability
- Consolidation report for audit trail

### Risk 4: Memory Bloat
**Impact:** Medium | **Probability:** Medium

**Mitigation:**
- Hard entity limit (50 entities in MCP)
- Aggressive pruning in Auto Dream
- Staleness detection (30 days)
- Manual pruning trigger

### Risk 5: Supersession Logic Bugs
**Impact:** High | **Probability:** Medium

**Mitigation:**
- Extensive testing with contradicting facts
- Temporal ordering validation
- Source tracking for all facts
- Ability to replay consolidation

### Risk 6: Performance with Large Repos
**Impact:** Medium | **Probability:** Low

**Mitigation:**
- Incremental git status checks
- Background scanning (non-blocking)
- Caching of repo metadata
- Pagination for large commit logs

---

## Documentation Deliverables

### User Documentation
- `docs/repository-management-guide.md` - Complete repo features
- `docs/memory-architecture-guide.md` - Memory system overview
- `docs/auto-dream-guide.md` - Consolidation and triggers
- `docs/temporal-reasoning-guide.md` - Using Zep (if implemented)

### Developer Documentation
- `src/repos/README.md` - Repository module architecture
- `src/memory/README.md` - Memory architecture design
- `docs/memory-consolidation-algorithm.md` - Auto Dream internals
- `docs/supersession-semantics.md` - Knowledge vs Memory distinction

### Migration Documentation
- `docs/repo-migration.md` - Adding repo management to existing deployment
- `docs/memory-migration.md` - Migrating from manual to Auto Dream
- Scripts for backfilling memory from historical jobs

---

## Future Enhancements (Out of Scope for Phase 8)

### Advanced Git Features
- Pull request management
- Merge conflict resolution (advanced)
- Git LFS support
- Submodule management

### Advanced Memory Features
- MAGMA multi-graph architecture (4 orthogonal graphs)
- Episodic replay (review past sessions)
- Meta
cognitive tracking (beliefs about own knowledge)
- Cross-agent memory sharing
- Distributed memory synchronization

### Team Collaboration
- Multi-user repository operations
- Repository access control
- Change approvals and workflows
- Team memory spaces

---

## Timeline & Effort

**Core Implementation:** 22-30 days (~4-6 weeks)
**With Optional Features (Hindsight + Zep):** 30-38 days (~6-7 weeks)

### Week 1-2: Foundation
- Phase 8.1: Repository Registry & Git Integration (3-4 days)
- Phase 8.2: Repository Operations UI (4-5 days)
- Start Phase 8.3: Memory Architecture Foundation

### Week 3-4: Memory System
- Complete Phase 8.3: Memory Architecture Foundation (5-6 days)
- Phase 8.4: Auto Dream Consolidation (3-4 days)

### Week 5-6: Advanced Features (Optional)
- Phase 8.5: Hindsight Integration (4-5 days) [Optional]
- Phase 8.6: Zep Temporal KG (3-4 days) [Optional]

---

## Memory Architecture Decision Tree

### When to Use Each Memory System

**MCP Server Memory (@modelcontextprotocol/server-memory)**
✅ Use when:
- Bounded engagements (<6 months)
- Want zero dependencies (local JSON file)
- Auto Dream consolidation sufficient
- Simple supersession needs

❌ Don't use when:
- Need advanced temporal queries
- Large-scale memory (>1000 entities)
- Distributed/multi-agent scenarios

**Hindsight**
✅ Use when:
- Need 4-network architecture (world/experience/summary/beliefs)
- Want consolidation pipeline (8 stages)
- Docker deployment acceptable
- Episodic memory important

❌ Don't use when:
- Need managed service
- Want zero infrastructure
- Simple memory sufficient

**Zep Temporal KG**
✅ Use when:
- Long-running engagements (>6 months)
- Critical temporal reasoning ("what was true when")
- Automatic supersession required
- Can use managed service

❌ Don't use when:
- Bounded engagement
- Auto Dream consolidation sufficient
- Want zero-dependency local

**Mem0 (from Phase 6)**
✅ Use when:
- Need cross-tool memory (Cursor, Claude Code)
- Want managed service
- Token efficiency critical (6,900 vs 26,000 tokens)
- Multi-scope memory (user, workspace, agent, run)

❌ Don't use when:
- Need graph-based reasoning
- Want full local control
- Simple fact storage sufficient

**Recommended Hybrid Approach:**
```typescript
// Layer 1: MCP Server Memory (Semantic Facts - Fast, Local)
@modelcontextprotocol/server-memory
↓
Auto Dream consolidation every 24h + 5 sessions

// Layer 2: Mem0 (User/Workspace Memory - Cross-Tool)
Mem0 from Phase 6
↓
User preferences, workspace patterns, cross-session context

// Layer 3 (Optional): Hindsight (Episodic + Experience)
Hindsight 4-network
↓
Detailed session history, belief evolution

// Layer 4 (Optional): Zep (Temporal Knowledge - Production)
Zep Temporal KG
↓
Long-running engagements, critical supersession
```

---

## Implementation Priority

### Must-Have (Core Phase 8)
1. ✅ Repository Registry & Git Integration
2. ✅ Repository Operations UI
3. ✅ MCP Server Memory Foundation
4. ✅ Auto Dream Consolidation

### Should-Have (High Value)
5. ⚠️ Hindsight Integration (if episodic memory critical)
6. ⚠️ Temporal fact tracking (even without full Zep)

### Nice-to-Have (Future)
7. 🔵 Zep Temporal KG (for long-running engagements)
8. 🔵 MAGMA multi-graph
9. 🔵 Metacognitive tracking

---

## Key Decisions Required

### Decision 1: Which Memory Architecture?
**Recommendation:** **MCP + Auto Dream + Mem0 Hybrid**

**Rationale:**
- MCP: Zero-dependency, fast, Auto Dream works
- Mem0: Already implementing in Phase 6, cross-tool benefit
- Hybrid: Different scopes, complementary strengths

**Alternative:** Add Hindsight if episodic memory critical

### Decision 2: Temporal KG Now or Later?
**Recommendation:** **Later (Phase 9 or as needed)**

**Rationale:**
- MCP + Auto Dream sufficient for most cases
- Zep adds complexity and cost
- Can migrate later if temporal queries needed
- Track validity windows in temporal_facts table (SQLite) as interim

### Decision 3: Repository Operations Scope
**Recommendation:** **Basic Operations Only (Commit, Pull, Push, Branch)**

**Rationale:**
- Cover 80% of use cases
- Advanced features (PR management, merge resolution) later
- Keep UI simple and reliable

### Decision 4: Auto Dream Triggers
**Recommendation:** **24h + 5 sessions (automatic) + Manual "dream"**

**Rationale:**
- Matches Claude Code proven pattern
- Balances freshness with overhead
- Manual trigger for ad-hoc cleanup

---

## References & Research

### Memory Architecture Research
- `ReferenceLib/claude/anthropic.com/memory-architecture-full-writeup.md` - Complete research
- CoALA Framework (Sumers et al., 2023) - 4 memory types
- arxiv 2604.23878 - 7-layer neuroscience architecture
- arxiv 2604.11364 - Missing Knowledge Layer (4-layer semantics)
- arxiv 2512.12818 - Hindsight 4-network architecture
- arxiv 2601.03236 - MAGMA multi-graph
- arxiv 2501.13956 - Zep temporal knowledge graph

### Production Patterns
- Claude Code Auto Dream (March 2026)
- Unblocked Memory Server Comparison (May 2026)
- Mem0 State of AI Agent Memory 2026
- tianpan.co production memory series
- hidekazu-konishi.com memory design guide

### MCP Memory Servers
- @modelcontextprotocol/server-memory - Official JSON KG
- Hindsight - 4-network, 8-stage consolidation
- Zep - Temporal KG with validity windows
- MemPalace - ChromaDB vector (96.6% LongMemEval)
- Mem0 - Dual vector+KG (from Phase 6)

---

## Next Steps

### This Week
1. ✅ Review Phase 8 specification
2. ⚡ Create Phase 8 Kiro spec (requirements/design/tasks)
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

**END OF PHASE 8 PROMPT**

---

## Instructions for Spec Session Agent

This prompt contains complete context for creating a Kiro spec with:
1. **Requirements document** - Extract from feature requirements (FR-1 through FR-6)
2. **Design document** - Extract from architecture, memory layers, Auto Dream algorithm
3. **Tasks document** - Extract from implementation phases (8.1 through 8.6)

Create the spec in `.kiro/specs/phase-8-repository-management/` with:
- Comprehensive requirements for repository operations and memory architecture
- Detailed design covering 4-tier memory system, Auto Dream pattern, supersession semantics
- Actionable tasks for each phase with clear success criteria
- Integration with Phases 4-7
- Memory architecture research summary and decision tree
- Configuration examples and database schemas

**Critical Context:**
- Memory research from ReferenceLib (CoALA, Auto Dream, 2026 benchmarks)
- 4-layer memory semantics: Knowledge (supersession), Memory (decay), Wisdom (evidence-gated), Intelligence (ephemeral)
- Auto Dream pattern: 24h + 5 sessions OR manual "dream" trigger
- MCP + Mem0 hybrid recommended over single solution
- Repository management enables Phase 7 (library management) effectiveness
- Zep temporal KG optional (for long-running engagements)

**Key Innovation:**
No more manual "update memory" commands. Autonomous consolidation via Auto Dream prevents memory rot while maintaining accuracy. 3x improvement in agent accuracy from active memory management (13% → 39% per 2026 study).
