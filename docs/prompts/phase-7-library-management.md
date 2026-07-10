# Phase 7: Library, Power, and Skill Management for AgentHQ

## Executive Summary

Transform AgentHQ into a centralized management hub for all agent resources: Powers, Skills, Reference Libraries, and MCP Servers. This phase enables discovery, installation, version tracking, dependency management, and usage analytics across all agent capabilities.

## Vision

AgentHQ becomes the "npm for AI agents" - a single interface to:
- **Discover** available powers, skills, and libraries
- **Install** and configure resources across workspaces
- **Version** and update agent capabilities
- **Monitor** usage and effectiveness
- **Share** resources across team members
- **Analyze** which capabilities drive the most value

---

## Current State Analysis

### Existing Library Structure

**PowersLib** (c:\repos\PowersLib)
- 20+ organizations contributing powers
- ~60+ individual powers (AWS, Stripe, Terraform, etc.)
- Each power has: POWER.md, mcp.json, steering files
- No central registry or discovery mechanism

**SkillsLib** (c:\repos\SkillsLib)
- 14+ skill repositories
- Anthropic official skills, agent skills, material design skills
- No version tracking or dependency management

**ReferenceLib** (c:\repos\ReferenceLib)
- Crawled documentation (Claude, MCP, Oracle, PowerBI, Kiro)
- ~1,000+ crawled pages organized by domain
- Queue files for crawl/clone operations
- No searchable index or metadata

### Current Gaps ❌

1. **No Discovery UI** - Must browse file system manually
2. **No Installation Flow** - Manual copy/paste of configurations
3. **No Version Control** - Can't track updates or rollback
4. **No Dependency Management** - No way to know power prerequisites
5. **No Usage Tracking** - Don't know which powers are actually used
6. **No Search** - Can't find "authentication power" or "database skill"
7. **No Sharing** - Can't recommend effective powers to teammates

---

## Proposed Architecture

### Domain Model

```typescript
// Library Resource Types
type ResourceType = 'power' | 'skill' | 'reference' | 'mcp-server' | 'steering';

interface Resource {
  id: string;                    // Unique identifier
  type: ResourceType;
  name: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  organization: string;
  keywords: string[];
  category: string;              // e.g., "aws", "database", "web"
  
  // File locations
  path: string;                  // Absolute path to resource
  configPath?: string;           // mcp.json, package.json, etc.
  documentationPath?: string;    // POWER.md, SKILL.md, README.md
  
  // Dependencies
  dependencies: ResourceDependency[];
  mcpServers: MCPServerConfig[];
  
  // Metadata
  installDate?: string;
  lastUsed?: string;
  usageCount: number;
  effectiveness?: number;        // 0-100 score
  
  // Installation status
  status: 'available' | 'installed' | 'active' | 'outdated' | 'error';
  installedWorkspaces: string[]; // Which workspaces use this resource
}

interface ResourceDependency {
  resourceId: string;
  version: string;
  required: boolean;
}

interface MCPServerConfig {
  serverName: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}
```

### Registry Architecture

```
┌─────────────────────────────────────────────────────┐
│              AgentHQ Dashboard                      │
│  ┌──────────┐ ┌──────────┐ ┌────────────────────┐ │
│  │ Library  │ │  Power   │ │  Resource          │ │
│  │ Browser  │ │ Installer│ │  Analytics         │ │
│  └──────────┘ └──────────┘ └────────────────────┘ │
└───────────────────┬─────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
┌───────▼────────┐    ┌────────▼─────────┐
│  Resource      │    │  Usage           │
│  Registry DB   │    │  Analytics DB    │
│  (SQLite)      │    │  (from Phase 5)  │
└────────────────┘    └──────────────────┘
        │
        ├─► PowersLib     (c:\repos\PowersLib)
        ├─► SkillsLib     (c:\repos\SkillsLib)
        └─► ReferenceLib  (c:\repos\ReferenceLib)
```

---

## Feature Requirements

### FR-1: Resource Discovery & Search

**User Stories:**
- As a developer, I want to search for "AWS authentication" and find relevant powers
- As a developer, I want to browse all available database-related skills
- As a developer, I want to see which powers are most popular across my team

**Features:**
- Full-text search across power/skill descriptions
- Keyword-based filtering (e.g., "aws", "database", "api")
- Category browsing (AWS, Database, Web, DevOps, etc.)
- Sort by: popularity, effectiveness, recent, alphabetical
- Filter by: type (power/skill/reference), status (installed/available)
- Preview: View POWER.md/SKILL.md without installing

**UI Components:**
```
┌─────────────────────────────────────────────┐
│ Library Browser                             │
├─────────────────────────────────────────────┤
│ Search: [AWS authentication          ] 🔍  │
│                                             │
│ Filters:                                    │
│ ☑ Powers  ☑ Skills  ☐ References          │
│ Category: [All ▾]   Status: [All ▾]       │
│                                             │
│ ┌─────────────────────────────────────┐   │
│ │ 🔌 AWS MCP                          │   │
│ │ Connect to AWS services via MCP     │   │
│ │ ★★★★☆ 127 installs • Updated 2d ago │   │
│ │ [View Details] [Install]            │   │
│ └─────────────────────────────────────┘   │
│ ┌─────────────────────────────────────┐   │
│ │ 🔌 AWS Transform                    │   │
│ │ Migrate applications to AWS         │   │
│ │ ★★★★★ 89 installs • Updated 1w ago  │   │
│ │ [View Details] [Installed ✓]        │   │
│ └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

### FR-2: Resource Installation & Configuration

**User Stories:**
- As a developer, I want to install a power with one click
- As a developer, I want AgentHQ to auto-configure MCP servers for installed powers
- As a developer, I want to enable a power for specific workspaces only

**Features:**
- One-click installation from library browser
- Automatic MCP server configuration in `mcp.json`
- Workspace-scoped installation (per-workspace or global)
- **Dependency resolution with backtracking solver** (Phase 7.3 requirement - see below)
- Environment variable setup wizard
- Configuration validation before activation
- Rollback on installation failure

**CRITICAL: Dependency Resolution Complexity**

**Problem:** Package dependency resolution is **NP-complete** (requires SAT solver or backtracking algorithm).

**Real-World Example:**
- Skill A requires Skill B v1.x
- Skill C requires Skill B v2.x
- User wants both Skill A and Skill C

**Three Approaches:**

| Approach | Complexity | User Experience | When to Use |
|----------|------------|-----------------|-------------|
| **Fail on conflict** | Simple | ❌ Poor - forces manual resolution | Phase 7.1 MVP only |
| **Multi-version install** | Medium | ✅ Good - like npm (multiple copies) | Phase 7.2 |
| **Backtracking solver** | Complex | ✅✅ Best - optimal version selection | Phase 7.3 (required for release) |

**Decision: Block Phase 7.1 deployment until Phase 7.3 backtracking solver is ready.**

**Rationale:**
- "Fail on conflict" creates terrible UX ("Skill A and C conflict, figure it out yourself")
- Half-implementing creates technical debt
- Users expect npm-like dependency management (it just works)
- Multi-version + solver together = 8-12 days vs 10-14 total (acceptable timeline)

**Installation Flow:**
```
User clicks "Install" on aws-mcp power
  ↓
Check dependencies (none required)
  ↓
Copy power files to workspace .kiro/powers/aws-mcp/
  ↓
Parse mcp.json from power
  ↓
Merge into workspace .kiro/settings/mcp.json
  ↓
Prompt for environment variables (AWS_REGION, etc.)
  ↓
Validate configuration (test MCP connection)
  ↓
Mark power as "installed" in registry
  ↓
Show success notification + usage guide
```

### FR-3: Version Management & Updates

**User Stories:**
- As a developer, I want to see when powers have updates available
- As a developer, I want to update all outdated powers at once
- As a developer, I want to rollback a power to a previous version

**Features:**
- Version detection from git commits (PowersLib/SkillsLib are git repos)
- Update notifications in dashboard
- Bulk update operations
- Version history viewer
- Rollback capability
- Change log display (what's new in this version)

**Version Tracking:**
```typescript
interface PowerVersion {
  resourceId: string;
  version: string;           // semver or git commit hash
  releaseDate: string;
  changelog: string;
  breaking: boolean;         // Breaking changes?
  deprecated: boolean;
}

// Example: Track aws-mcp versions
{
  resourceId: "aws-mcp",
  currentVersion: "1.2.0",
  latestVersion: "1.3.0",
  updateAvailable: true,
  installedDate: "2026-06-15",
  lastChecked: "2026-07-03"
}
```

### FR-4: Usage Analytics & Effectiveness Tracking

**User Stories:**
- As a developer, I want to see which powers I use most frequently
- As a team lead, I want to know which skills provide the best results
- As a developer, I want recommendations based on my usage patterns

**Metrics to Track:**
```typescript
interface ResourceUsageMetrics {
  resourceId: string;
  
  // Usage counts
  totalInvocations: number;      // How many times power was used
  successfulRuns: number;         // Successful completions
  failedRuns: number;             // Errors/failures
  
  // Timing
  avgExecutionTime: number;       // Average job duration with this power
  firstUsed: string;
  lastUsed: string;
  
  // Effectiveness
  effectivenessScore: number;     // 0-100 (calculated)
  userRating?: number;            // 1-5 stars (manual)
  
  // Context
  workspaces: string[];           // Which workspaces use this
  users: string[];                // Which users use this
  relatedJobs: string[];          // Sample job IDs
}
```

**Analytics Dashboard:**
```
┌─────────────────────────────────────────────┐
│ Resource Analytics                          │
├─────────────────────────────────────────────┤
│ Most Used Powers (Last 30 Days)             │
│ ┌─────────────────────────────────────┐    │
│ │ 1. aws-mcp        347 invocations   │    │
│ │ 2. terraform       89 invocations   │    │
│ │ 3. stripe          56 invocations   │    │
│ └─────────────────────────────────────┘    │
│                                             │
│ Top Performers (Effectiveness Score)        │
│ ┌─────────────────────────────────────┐    │
│ │ 1. aws-mcp        ★★★★★ (98/100)    │    │
│ │ 2. datadog        ★★★★☆ (87/100)    │    │
│ │ 3. neon           ★★★★☆ (85/100)    │    │
│ └─────────────────────────────────────┘    │
│                                             │
│ Recommendations for You                     │
│ Based on your workspace patterns:           │
│ • Try "aws-observability" (93% match)      │
│ • Try "postman" (88% match)                │
└─────────────────────────────────────────────┘
```

### FR-5: Reference Library Management

**User Stories:**
- As a developer, I want to search crawled documentation
- As a developer, I want to trigger crawls for new documentation sites
- As a developer, I want to see which references are most accessed

**Features:**
- Browse ReferenceLib by domain (claude, mcp, oracle, etc.)
- Full-text search across crawled content
- Crawl queue management (view, edit, trigger)
- Reference freshness indicators (last crawled date)
- Most-accessed references tracking
- Quick links to frequently used docs

**Crawl Management UI:**
```
┌─────────────────────────────────────────────┐
│ Reference Library                           │
├─────────────────────────────────────────────┤
│ Domains: [All ▾]  Freshness: [All ▾]       │
│                                             │
│ ┌─────────────────────────────────────┐    │
│ │ 📚 Mem0.ai Documentation            │    │
│ │ 5 pages • Last crawled: 2d ago      │    │
│ │ 147 accesses                        │    │
│ │ [Browse] [Refresh Crawl]            │    │
│ └─────────────────────────────────────┘    │
│                                             │
│ Crawl Queue (3 pending)                    │
│ • anthropic.com/docs/agent-memory          │
│ • fastmcp.com/advanced-patterns            │
│ • oracle.com/database/vectordb             │
│ [Manage Queue]                             │
└─────────────────────────────────────────────┘
```

### FR-6: Workspace Resource Profiles

**User Stories:**
- As a developer, I want to see all resources active in a workspace
- As a developer, I want to export my workspace config to share with team
- As a developer, I want to clone a workspace's resource setup

**Features:**
- Per-workspace resource inventory
- Export workspace profile (JSON/YAML)
- Import/apply profile to new workspace
- Resource conflict detection
- Resource recommendations based on workspace type

**Workspace Profile:**
```yaml
# workspace-profile.yaml
workspaceId: scottish-water
workspaceName: Scottish Water BE Carbon Tool
profile: database-analytics

installedPowers:
  - id: oracle-carbon-analysis
    version: 1.0.0
    config:
      ORACLE_CONNECTION: "${ORACLE_CONN_STRING}"
  
  - id: powerbi-modeling-mcp
    version: 0.2.0

installedSkills:
  - id: db-oracle
    version: latest
  
  - id: web-best-practices
    version: latest

activeReferences:
  - oracle/docs.oracle.com
  - powerbi/learn.microsoft.com
  - mem0.ai/documentation

mcpServers:
  oracle-sqlcl:
    command: uvx
    args: ["oracle-sqlcl-mcp"]
  
  pbixray:
    command: npx
    args: ["-y", "pbixray-server"]
```

---

## Implementation Phases

### Phase 7.1: Resource Registry & Scanner
**Duration:** 4-5 days (increased from 3-4 to include discovery foundation)

**CRITICAL: Pre-Implementation Mapping (MANDATORY from context-map skill)**

**DO NOT write ANY code in Phase 7.1 until context-map completes.** Before touching scanner, parser, or database code:

```
Step 1: Activate context-map skill
Step 2: Run context-map with goal: "Implement resource registry scanner for PowersLib/SkillsLib/ReferenceLib"
Step 3: Receive:
  - Files to modify (with purpose and change needed)
  - Dependencies that need updating
  - Existing patterns to follow (from src/scan/*)
  - Test coverage requirements
```

**Why this is mandatory:**
- AgentHQ already has `src/scan/` module (jobs.ts, sessions.ts, chains.ts, helpers.ts)
- Phase 7.1 scanner MUST follow existing scan module patterns (pure async functions, no HTTP deps)
- Duplication risk: scanner may already exist partially in `src/scan/` or `src/workers/backfill.ts`
- Integration risk: new registry must not conflict with Phase 5 database schema

**Expected context-map output:**
- Reuse `src/scan/helpers.ts` for file reading and parsing
- Follow async/await pattern from `scanJobs()` in `src/scan/jobs.ts`
- Database schema integrates with existing Phase 5 schema (no conflicts)
- Worker pattern from `src/workers/queuePoller.ts` for periodic scanning

**Tasks:**
1. **MANDATORY FIRST: Run context-map skill before any implementation**
2. Design resource registry database schema (integrate with Phase 5 schema)
3. Implement namespaced naming: `{org}/{repo}/{type}/{name}`
4. Implement library scanners (PowersLib, SkillsLib, ReferenceLib)
5. Extract metadata from POWER.md, SKILL.md, README.md
6. Parse mcp.json and **dependency declarations** (prepare for Phase 7.3)
7. Build resource index with search capability
8. Create registry API endpoints
9. Implement background scanner (periodic refresh)
10. **Design (but don't implement) dependency resolution interface** for Phase 7.3

**Files to Create:**
- `src/registry/schema.sql` - Registry database schema
- `src/registry/scanner.ts` - Library scanning engine
- `src/registry/parsers/power.ts` - POWER.md parser
- `src/registry/parsers/skill.ts` - SKILL.md parser
- `src/registry/parsers/reference.ts` - Reference indexer
- `src/registry/index.ts` - Search index builder
- `src/routes/registry.ts` - Registry API endpoints

**Success Criteria:**
- All PowersLib resources indexed (60+ powers)
- All SkillsLib resources indexed (50+ skills)
- ReferenceLib domains cataloged with page counts
- Search returns relevant results in <100ms
- Registry refreshes every 5 minutes

### Phase 7.2: Library Browser UI
**Duration:** 4-5 days

**Tasks:**
1. Design library browser layout
2. Implement search interface with filters
3. Build resource card components
4. Add resource detail view (POWER.md viewer)
5. Implement category navigation
6. Add sort/filter controls
7. Integrate with registry API
8. Real-time search (debounced)

**Files to Create:**
- `src/dashboard/pages/library.ts` - Library browser page
- `src/dashboard/components/resource-card.ts` - Resource card component
- `src/dashboard/components/resource-detail.ts` - Detail modal
- `src/dashboard/components/search-bar.ts` - Search component
- `src/dashboard/components/filter-panel.ts` - Filter sidebar

**Success Criteria:**
- Library page loads in <500ms
- Search results update in <200ms
- All resources browsable and searchable
- Resource details display correctly
- Filters work correctly

### Phase 7.2: Library Browser UI
**Duration:** 4-5 days

**Tasks:**
1. Design library browser layout
2. Implement search interface with filters
3. Build resource card components
4. Add resource detail view (POWER.md viewer)
5. Implement category navigation
6. Add sort/filter controls
7. Integrate with registry API
8. Real-time search (debounced)

**Files to Create:**
- `src/dashboard/pages/library.ts` - Library browser page
- `src/dashboard/components/resource-card.ts` - Resource card component
- `src/dashboard/components/resource-detail.ts` - Detail modal
- `src/dashboard/components/search-bar.ts` - Search component
- `src/dashboard/components/filter-panel.ts` - Filter sidebar

**Success Criteria:**
- Library page loads in <500ms
- Search results update in <200ms
- All resources browsable and searchable
- Resource details display correctly
- Filters work correctly

### Phase 7.3: Multi-Version Install + Backtracking Solver
**Duration:** 8-10 days (combines old 7.3 + new dependency resolution)

**MANDATORY: This phase MUST be complete before Phase 7 is considered deployable.**

**Phase 7.3a: Multi-Version Installation (3-4 days)**

**Tasks:**
1. Implement path namespacing: `.kiro/skills/memory-merger@v1/`, `.kiro/skills/memory-merger@v2/`
2. Build load path resolution (Skill A loads B@v1, Skill C loads B@v2)
3. Implement disk space tracking (warn if duplicates exceed 1GB)
4. Add version isolation (ensure no cross-version conflicts)

**Phase 7.3b: Backtracking Dependency Solver (5-6 days)**

**Tasks:**
1. Integrate SAT solver library ([Z3](https://github.com/Z3Prover/z3) or [PicoSAT](https://github.com/BooleanCat/picosat))
2. Parse semver constraints from skill/power metadata
3. Implement backtracking algorithm:
   - Try latest compatible version
   - Check all constraints
   - Backtrack on conflict
   - Find optimal solution
4. Implement "latest compatible" heuristic (prefer newer versions)
5. Handle transitive dependencies (A → B → C chains)
6. Add solver timeout (fail gracefully if no solution in 30s)
7. Build conflict resolution UI (if no solution, suggest alternatives)

**Solver Algorithm (Pseudocode):**
```typescript
interface Constraint {
  resource: string;
  versionRange: string; // semver range like "^1.2.0" or ">=2.0.0 <3.0.0"
}

async function resolveDependencies(
  requested: Resource[],
  constraints: Constraint[]
): Promise<Resolution | ConflictError> {
  // Build constraint graph
  const graph = buildConstraintGraph(requested, constraints);
  
  // Convert to SAT problem
  const satProblem = toSAT(graph);
  
  // Solve with timeout
  const solution = await solver.solve(satProblem, { timeout: 30000 });
  
  if (!solution) {
    // No solution exists
    return new ConflictError({
      conflicts: findConflicts(graph),
      suggestions: suggestAlternatives(graph)
    });
  }
  
  // Convert solution back to version assignments
  return {
    installs: solution.map(s => ({
      resource: s.resource,
      version: s.version,
      path: `.kiro/${s.type}/${s.resource}@${s.version}/`
    }))
  };
}
```

**Files to Create:**
- `src/registry/solver.ts` - Dependency solver engine
- `src/registry/constraints.ts` - Constraint parsing and validation
- `src/registry/sat.ts` - SAT problem conversion
- `src/registry/multi-version.ts` - Multi-version path management
- `src/dashboard/components/conflict-resolver.ts` - Conflict resolution UI

**Success Criteria:**
- ✅ Can install Skill A (needs B@v1) + Skill C (needs B@v2) without conflict
- ✅ Solver finds optimal version set in <5 seconds for typical cases
- ✅ Handles transitive dependencies (A → B → C)
- ✅ Gracefully fails with helpful message when no solution exists
- ✅ Multi-version isolation works (no cross-version interference)

### Phase 7.4: Installation & Configuration Flow
**Duration:** 3-4 days (reduced from 5-6, dependency solver moved to 7.3)

**Tasks:**
1. Implement resource installer (uses solver from Phase 7.3)
2. Build MCP configuration merger
3. Create environment variable setup wizard
4. Implement configuration validation
5. Add rollback mechanism
6. Build installation status tracker
7. Add workspace-scoped installation

**Files to Create:**
- `src/registry/installer.ts` - Resource installation engine (calls solver)
- `src/registry/mcp-merger.ts` - MCP config merging
- `src/registry/env-wizard.ts` - Environment setup wizard
- `src/registry/validator.ts` - Config validation
- `src/routes/install.ts` - Installation API endpoints

**Success Criteria:**
- One-click installation works end-to-end
- MCP servers auto-configured correctly
- Dependencies resolved and installed automatically (via Phase 7.3 solver)
- Environment variables prompted correctly
- Installation errors handled gracefully
- Rollback works on failure

### Phase 7.5: Version Management & Updates
**Duration:** 3-4 days (renumbered from 7.4)

**Tasks:**
1. Implement version detection (git-based)
2. Build update checker (periodic scan)
3. Create version history viewer
4. Implement bulk update operations
5. Add rollback capability
6. Build changelog viewer
7. Add update notifications

**Files to Create:**
- `src/registry/versions.ts` - Version tracking
- `src/registry/updater.ts` - Update engine
- `src/registry/changelog.ts` - Changelog parser
- `src/routes/updates.ts` - Update API endpoints
- `src/dashboard/components/update-notifier.ts` - Update badge

**Success Criteria:**
- Updates detected within 5 minutes of git pull
- Bulk updates work correctly (respects dependency constraints from Phase 7.3)
- Rollback restores previous version
- Changelogs display correctly
- Update notifications visible in dashboard

### Phase 7.6: Usage Analytics & Recommendations
**Duration:** 4-5 days (renumbered from 7.5)

**Tasks:**
1. Track resource usage in job execution
2. Build effectiveness scoring algorithm
3. Create analytics dashboard
4. Implement recommendation engine
5. Add user rating system
6. Build usage reports
7. Add team analytics (if multi-user)

**Files to Create:**
- `src/registry/analytics.ts` - Usage analytics engine
- `src/registry/effectiveness.ts` - Effectiveness scoring
- `src/registry/recommender.ts` - Recommendation engine
- `src/routes/analytics.ts` - Analytics API endpoints
- `src/dashboard/pages/resource-analytics.ts` - Analytics page

**Success Criteria:**
- Usage tracked for all resource invocations
- Effectiveness scores computed correctly
- Recommendations relevant and useful
- Analytics dashboard loads in <500ms
- Reports exportable (CSV/JSON)

### Phase 7.7: Reference Library & Crawl Management
**Duration:** 3-4 days (renumbered from 7.6)

**Tasks:**
1. Index ReferenceLib content
2. Build full-text search over references
3. Create reference browser UI
4. Implement crawl queue management
5. Add trigger crawl functionality
6. Track reference access analytics
7. Add freshness indicators

**Files to Create:**
- `src/registry/reference-index.ts` - Reference indexer
- `src/registry/crawl-manager.ts` - Crawl queue manager
- `src/routes/references.ts` - Reference API endpoints
- `src/dashboard/pages/references.ts` - Reference browser page
- `src/dashboard/components/crawl-queue.ts` - Queue management UI

**Success Criteria:**
- All ReferenceLib content indexed
- Full-text search returns relevant docs
- Crawl queue viewable and editable
- Manual crawls trigger correctly
- Access tracking works

---

## Configuration

### Registry Configuration
```typescript
// .env additions
LIBRARY_SCAN_ENABLED=true
LIBRARY_SCAN_INTERVAL=300000  # 5 minutes
POWERSLIB_PATH=c:\repos\PowersLib
SKILLSLIB_PATH=c:\repos\SkillsLib
REFERENCELIB_PATH=c:\repos\ReferenceLib

# src/constants.ts additions
export const LIBRARY_SCAN_ENABLED = process.env.LIBRARY_SCAN_ENABLED === 'true';
export const LIBRARY_SCAN_INTERVAL = Number(process.env.LIBRARY_SCAN_INTERVAL) || 300000;
export const POWERSLIB_PATH = process.env.POWERSLIB_PATH ?? 'c:\\repos\\PowersLib';
export const SKILLSLIB_PATH = process.env.SKILLSLIB_PATH ?? 'c:\\repos\\SkillsLib';
export const REFERENCELIB_PATH = process.env.REFERENCELIB_PATH ?? 'c:\\repos\\ReferenceLib';
```

### Database Schema
```sql
-- Resource registry
CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT,
  description TEXT,
  version TEXT,
  author TEXT,
  organization TEXT,
  keywords TEXT,  -- JSON array
  category TEXT,
  path TEXT NOT NULL,
  config_path TEXT,
  documentation_path TEXT,
  dependencies TEXT,  -- JSON array
  mcp_servers TEXT,  -- JSON array
  status TEXT NOT NULL,
  installed_workspaces TEXT,  -- JSON array
  install_date TIMESTAMP,
  last_used TIMESTAMP,
  usage_count INTEGER DEFAULT 0,
  effectiveness REAL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_type (type),
  INDEX idx_category (category),
  INDEX idx_status (status),
  INDEX idx_keywords (keywords)
);

-- Resource versions
CREATE TABLE resource_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  version TEXT NOT NULL,
  release_date TIMESTAMP,
  changelog TEXT,
  breaking BOOLEAN DEFAULT FALSE,
  deprecated BOOLEAN DEFAULT FALSE,
  
  INDEX idx_resource (resource_id),
  UNIQUE (resource_id, version)
);

-- Resource usage tracking
CREATE TABLE resource_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  workspace_id TEXT NOT NULL,
  user_id TEXT,
  job_id TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  execution_time_ms INTEGER,
  success BOOLEAN,
  error_message TEXT,
  
  INDEX idx_resource_workspace (resource_id, workspace_id),
  INDEX idx_timestamp (timestamp DESC)
);

-- Resource ratings
CREATE TABLE resource_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  user_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE (resource_id, user_id)
);
```

---

## Integration with Existing Features

### Integration with Phase 4 (Multi-Workspace)
- Resource installations scoped per workspace
- Workspace profiles include resource inventory
- Workspace filter applies to resource analytics

### Integration with Phase 5 (Database + Analytics)
- Resource usage stored in Phase 5 database
- Analytics dashboard includes resource metrics
- Job metadata includes active resources

### Integration with Phase 6 (Memory)
- Memory layer remembers effective resource combinations
- Agent learns which powers work best for which tasks
- Resource recommendations based on memory patterns

### Integration with Agent Execution
```typescript
// Before agent execution, inject active resources
const activeResources = await registry.getActiveResources(workspaceId);

const systemPrompt = `
${baseSystemPrompt}

## Available Powers
${activeResources.powers.map(p => `- ${p.name}: ${p.description}`).join('\n')}

## Available Skills
${activeResources.skills.map(s => `- ${s.name}: ${s.description}`).join('\n')}
`;

// After execution, track resource usage
await registry.trackUsage({
  resourceId: 'aws-mcp',
  workspaceId,
  jobId,
  executionTime: duration,
  success: status === 'done'
});
```

---

## Success Metrics

### Quantitative
- **Discovery Time:** <30 seconds to find relevant resource
- **Installation Time:** <2 minutes from discovery to active
- **Search Latency:** <100ms for search results
- **Registry Completeness:** 100% of PowersLib/SkillsLib indexed
- **Update Detection:** Within 5 minutes of git pull
- **Usage Tracking:** 100% of resource invocations logged

### Qualitative
- Developers discover new powers without asking teammates
- Installation "just works" without manual config editing
- Teams share effective resource combinations
- Recommendations accelerate workflow optimization
- Resource analytics inform procurement decisions

---

## Risk Assessment

### Risk 1: Library Path Changes
**Impact:** High | **Probability:** Low

**Mitigation:**
- Configuration supports custom paths
- Path validation on startup
- Graceful degradation if library missing
- Clear error messages for path issues

### Risk 2: Version Conflicts
**Impact:** Medium | **Probability:** Medium

**Mitigation:**
- Dependency resolver checks conflicts before install
- Clear conflict messages with resolution suggestions
- Ability to install multiple versions side-by-side
- Rollback mechanism for failed upgrades

### Risk 3: Performance with Large Libraries
**Impact:** Medium | **Probability:** Medium

**Mitigation:**
- Incremental indexing (only scan changed files)
- Background scanning (non-blocking)
- Search index optimization
- Pagination for large result sets

### Risk 4: MCP Configuration Conflicts
**Impact:** High | **Probability:** Medium

**Mitigation:**
- Validation before merging mcp.json
- Conflict detection and resolution UI
- Backup before configuration changes
- Rollback on validation failure

---

## Documentation Deliverables

### User Documentation
- `docs/library-management-guide.md` - Complete library features guide
- `docs/power-installation.md` - How to install and configure powers
- `docs/resource-analytics.md` - Understanding resource metrics

### Developer Documentation
- `src/registry/README.md` - Registry architecture
- `docs/registry-api.md` - Registry API reference
- `docs/adding-custom-resources.md` - How to add custom powers/skills

### Migration Documentation
- `docs/registry-migration.md` - Migrating existing power configs
- Scripts for bulk resource import
- Workspace profile templates

---

## Future Enhancements (Out of Scope for Phase 7)

### Marketplace & Sharing
- Publish/share custom powers with community
- Power ratings and reviews
- Download stats and popularity rankings
- Verified/certified power badges

### AI-Powered Discovery
- Natural language search ("find me a power for deploying to AWS Lambda")
- Semantic similarity matching
- Use-case-based recommendations

### Advanced Dependency Management
- Automatic prerequisite installation
- Version constraint resolution (semver)
- Dependency graphs visualization
- Circular dependency detection

### Team Collaboration
- Team resource libraries
- Shared workspace profiles
- Resource approval workflows
- Usage quotas and billing

---

## Timeline & Effort

**Total Duration:** 30-38 days (~6-8 weeks)** — Increased from 22-28 days due to mandatory dependency solver

**CRITICAL NOTE:** Phase 7 is not deployable until Phase 7.3 (Multi-Version + Solver) is complete.

### Week 1-2: Foundation & Discovery
- Phase 7.1: Resource Registry & Scanner (4-5 days)
- Phase 7.2: Library Browser UI (4-5 days)

### Week 3-4: Dependency Resolution (MANDATORY - BLOCKING)
- Phase 7.3a: Multi-Version Install (3-4 days)
- Phase 7.3b: Backtracking Solver (5-6 days)

### Week 5: Installation & Updates
- Phase 7.4: Installation & Configuration (3-4 days)
- Phase 7.5: Version Management (3-4 days)

### Week 6-7: Analytics & References
- Phase 7.6: Usage Analytics (4-5 days)
- Phase 7.7: Reference Library (3-4 days)

**Why the Timeline Increased:**
- Original estimate assumed "fail on conflict" was acceptable for MVP
- Research revealed this creates unacceptable UX (forces manual conflict resolution)
- Dependency resolution is NP-complete; can't be half-implemented
- Multi-version + solver together is 8-10 days (acceptable for production-ready release)
- Alternative was to ship Phase 7.1-7.2 only, then 7.3-7.7 later (worse: users experience breaking change)

---

## Dependencies

### New Dependencies
```json
{
  "dependencies": {
    "fast-glob": "^3.3.2",      // Fast file system scanning
    "gray-matter": "^4.0.3",     // Parse frontmatter from .md files
    "js-yaml": "^4.1.0",         // YAML parsing for configs
    "semver": "^7.6.0"           // Version comparison
  }
}
```

### External Tools
- Git (for version detection via `git log`)
- PowersLib, SkillsLib, ReferenceLib repositories

---

## Next Steps

### This Week
1. Review Phase 7 scope and approach
2. Design registry database schema
3. Build proof-of-concept scanner for PowersLib
4. Create library browser mockups

### Next 2 Weeks
- Implement Phase 7.1 (Registry & Scanner)
- Implement Phase 7.2 (Library Browser UI)
- Basic resource discovery working

### Next Month
- Complete installation and version management
- Complete analytics and reference library
- Full library management system operational

---

**END OF PHASE 7 PROMPT**

## Instructions for Spec Session Agent

This prompt contains complete context for creating a Kiro spec with:
1. **Requirements document** - Extract from feature requirements (FR-1 through FR-6)
2. **Design document** - Extract from architecture, domain model, and integration sections
3. **Tasks document** - Extract from implementation phases (7.1 through 7.6)

Create the spec in `.kiro/specs/phase-7-library-management/` with:
- Comprehensive requirements for discovery, installation, versions, analytics, references
- Detailed design for registry architecture, database schema, UI components
- Actionable tasks for each phase with clear success criteria
- Integration patterns with Phases 4, 5, and 6
- Configuration examples and database schemas
