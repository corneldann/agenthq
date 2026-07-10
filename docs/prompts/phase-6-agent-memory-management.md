# Phase 6: Agent Memory Management for AgentHQ

## Executive Summary

Add comprehensive memory management capabilities to AgentHQ to enable agents to remember context across sessions, workspaces, and executions. This phase builds on the Phase 5 foundation (Database, WebSocket, Analytics) to create an intelligent memory layer that transforms AgentHQ from a monitoring dashboard into an cognitive observability platform.

## Current State Analysis

### What AgentHQ Currently Tracks
- **Job Outputs:** Markdown files with execution logs (ephemeral)
- **Session State:** JSONL files with conversation snapshots (file-based, no semantic search)
- **Chain History:** JSON files grouping related sessions (structural only)
- **Git Status:** Current workspace state (point-in-time)

### Critical Gap: No Cross-Session Intelligence
- Agents re-learn project constraints every session
- No memory of past debugging patterns or solutions
- No retention of architectural decisions across chains
- No shared learning between workspace agents
- Context resets on every workspace change or tool switch

---

## Memory Architecture Research Summary

### Cognitive Science Foundation (from mem0.ai research)

**Three Memory Types:**
1. **Sensory Memory** → Context Window (immediate, finite, expensive)
2. **Short-Term Memory (STM)** → Current session history (transient, session-scoped)
3. **Long-Term Memory (LTM)** → Persistent cross-session knowledge (durable, queryable)

**Memory Scoping Model:**
```typescript
// Multi-scope memory design (adopted from Mem0)
interface MemoryScope {
  user_id?: string;      // Developer/team member using AgentHQ
  agent_id?: string;     // Specific agent instance (e.g., OpenRouter agent)
  run_id?: string;       // Single job execution or session
  app_id?: string;       // AgentHQ itself or workspace-level
  workspace_id: string;  // Already implemented in Phase 4
}
```

**Key Insight:** Memory is not a single bucket—it's a hierarchical, multi-scoped retrieval system where context is assembled based on relevance, recency, and scope.

### State-of-the-Art Memory Systems (2026)

Based on research from ReferenceLib and online sources:

**⭐ Hindsight (RECOMMENDED - Open-Source MCP Memory Server)**
- **Benchmark: 94.6% on LongMemEval** (independently reproduced by Virginia Tech)
- **2x better than Mem0** (94.6% vs 49.0% on independent evaluation)
- Docker-based, fully local deployment (MIT license)
- Three core operations: retain (store), recall (search), reflect (reason)
- Mental models that auto-update as memories grow
- MCP-compatible for Claude Desktop, Cursor, Windsurf, VSCode
- Self-hostable with zero external dependencies

**Mem0 (Alternative - Managed Service)**
- Claimed benchmarks: 92.5 on LoCoMo (proprietary variant)
- Independent evaluation: 49.0% on standard benchmarks
- Token efficiency: ~6,900 tokens/query vs ~26,000 for full-context
- Multi-signal retrieval: Semantic similarity + BM25 keyword + Entity matching
- 21 framework integrations, 20 vector stores
- MCP-compatible via `@mem0ai/mem0-mcp` package
- Requires managed service subscription or complex self-hosting

**Agentic Memory MCP (Knowledge Graph Approach)**
- PyPI package: `agentic-memory-mcp`
- Structured, queryable memory via Knowledge Graph
- Designed for embedding in agentic frameworks
- Can be served as standalone MCP tool server

**Oracle AI Agent Memory (Enterprise Option)**
- Python API for threads, durable memory records, scoped retrieval
- Persistent storage via Oracle AI Database with vector search
- Context assembly layer on top of Oracle Vector DB
- Best for enterprise deployments with existing Oracle infrastructure

---

## Crawl Queue Configuration Status

**FINDING: No Updates Required** ✅

**Current Configuration (from constants.ts):**
```typescript
const CRAWL_JOBS_FILE = env.CRAWL_JOBS_FILE ?? "docs/reference/.crawl-queue.json";
const CLONE_JOBS_FILE = env.CLONE_JOBS_FILE ?? "docs/reference/.clone-queue.json";
const BUILD_QUEUE_FILE = env.BUILD_QUEUE_FILE ?? "docs/reference/.build-queue.json";
```

**Migration Status:**
- Crawl files migrated from ScottishWater to ReferenceLib: ✅
- ReferenceLib contains: `.crawl-queue.json`, `.clone-queue.json`, and related job logs
- AgentHQ references are **relative paths**, not absolute
- Default path `docs/reference/.crawl-queue.json` is workspace-relative
- **No hardcoded ScottishWater references found** in AgentHQ codebase

**Verification:**
- Searched AgentHQ codebase for `ScottishWater.*reference` patterns: **0 matches**
- Searched for `docs/reference/\.crawl` absolute paths: **0 matches**
- Constants use environment variable fallbacks with sensible defaults
- Multi-workspace setup (Phase 4) allows per-workspace queue file configuration

**Recommendation:** No configuration changes needed. The existing relative path system works correctly.

---

## Skills and Powers Assessment

### Memory-Specific Skills Found in SkillsLib

A full scan of SkillsLib identified the following skills directly applicable to AgentHQ memory management. These should be installed into `workspace/.kiro/skills/` before starting Phase 6 implementation.

---

**1. `@modelcontextprotocol/server-memory` — Knowledge Graph MCP Backend**
Location: `SkillsLib/modelcontextprotocol/servers/src/memory/`

This is the reference implementation of the MCP memory server already running in the `agenthq-memory` power. Key capabilities:
- Entities, Relations, Observations as first-class primitives
- Tools: `create_entities`, `create_relations`, `add_observations`, `delete_entities`, `delete_observations`, `delete_relations`, `read_graph`, `search_nodes`, `open_nodes`
- Resource subscription: `memory://knowledge-graph` emits `notifications/resources/updated` on mutation — directly usable for SSE broadcast
- Configured via `MEMORY_FILE_PATH` env var (JSONL backing file)
- Already installed globally at `C:\Users\Admin\AppData\Roaming\npm\node_modules\@modelcontextprotocol\server-memory\dist\index.js`

**Implication for Phase 6:** This is the Tier 3 semantic memory backend. Do NOT re-implement — connect to it via MCP. The `agenthq-memory` power already wires it up; Phase 6 adds the extraction pipeline that writes to it and the dashboard UI that reads from it.

---

**2. `mini-context-graph` — Persistent Compounding Knowledge Base**
Location: `SkillsLib/github/awesome-copilot/skills/mini-context-graph/`

Implements the Karpathy LLM Wiki pattern: three-layer architecture (Raw Sources → Wiki → Graph) where knowledge compounds rather than being re-derived from scratch on every query.

Key architectural insight for AgentHQ:
- **Wiki layer** — LLM writes persistent markdown pages per job/chain; pages cross-reference each other and grow richer over time
- **Graph layer** — Entities/relations extracted once, stored with BFS traversal support; provenance links every node back to source text
- **Ingestion constraints** — No hallucinated entities; confidence threshold ≥ 0.6; `supporting_text` required on every entity and relation

**Application to Phase 6:**
- Job completion → `ingest_with_content()` with extracted entities (errors, components, resolutions)
- Chain completion → write wiki summary page
- Memory search → `query_with_evidence()` returns subgraph + source chunks with citations
- Periodic health-check → `lint_wiki()` to detect orphan pages and broken cross-references

The TypeScript equivalent replaces the Python API: `src/memory/extraction.ts` implements the ingest pipeline, `src/memory/wiki.ts` manages the markdown wiki layer.

---

**3. `memory-merger` — Consolidates Memory Into Instruction Files**
Location: `SkillsLib/github/awesome-copilot/skills/memory-merger/`

Merges mature learnings from domain memory files into permanent instruction files. This is the procedural tier of the memory system — once a pattern is confirmed across multiple sessions it graduates from episodic memory into a steering file or skill.

**Application to Phase 6:**
- Auto Dream consolidation (`"dream"` command) uses this pattern
- Phase 6.5 memory export generates `{domain}-memory.instructions.md` files
- Manual trigger: developer says `"merge memories for agenthq"` → Agent runs memory-merger on accumulated episodic memories

---

**4. `agentic-eval` — Evaluator-Optimizer for Memory Extraction Quality**
Location: `SkillsLib/github/awesome-copilot/skills/agentic-eval/`

Provides Generate → Evaluate → Critique → Refine loops. Directly applicable to Phase 6 extraction quality:
- Memory extraction generates facts from job logs
- Evaluator scores each extracted fact (accuracy, relevance, specificity)
- Optimizer refines extraction prompt when quality score falls below threshold
- Rubric dimensions: `accuracy` (0.4 weight), `relevance` (0.3), `specificity` (0.3)

**Application to Phase 6.2 (Automatic Extraction):**
```typescript
// src/memory/extraction.ts — quality-gated extraction
const extracted = await extractFacts(jobLog);
const score = await evaluateFacts(extracted, rubric);
if (score < EXTRACTION_THRESHOLD) {
  return await refinedExtract(jobLog, score.feedback);
}
```

---

**5. `context-map` — Pre-implementation Codebase Mapping**
Location: `SkillsLib/github/awesome-copilot/skills/context-map/`

Before modifying any file in Phase 6 implementation, run context-map to identify:
- Files to modify (with purpose and change needed)
- Dependencies that may need updating
- Existing test coverage
- Reference patterns to follow

**Mandatory use:** Run context-map before starting each Phase 6 sub-phase (6.1 through 6.5). This prevents the pattern of discovering missed dependencies mid-implementation.

---

**6. `rag-implementation` — RAG Patterns for Session Memory Retrieval**
Location: `SkillsLib/wshobson/agents/plugins/llm-application-dev/skills/rag-implementation/`

Covers hybrid search (dense + sparse), reranking strategies, HyDE (Hypothetical Document Embedding), and embedding model selection for 2026. Directly applicable to Phase 6.3 context assembly:
- Recommended embedding: `voyage-3-large` (1024 dims, Anthropic-recommended)
- Hybrid retrieval: semantic similarity + BM25 keyword for memory search
- Reranking: MMR (Maximal Marginal Relevance) for diversity in top-10 memories
- Token budget enforcement: count before injection, fallback if exceeded

---

### Skills to Install Before Phase 6 Development

Memory-specific skills (all local in SkillsLib, no download needed):

| Skill | Source Path | When Needed |
|-------|------------|-------------|
| `mini-context-graph` | `SkillsLib/github/awesome-copilot/skills/mini-context-graph/` | Phase 6.1 — core knowledge graph pattern |
| `agentic-eval` | `SkillsLib/github/awesome-copilot/skills/agentic-eval/` | Phase 6.2 — extraction quality gating |
| `context-map` | `SkillsLib/github/awesome-copilot/skills/context-map/` | All phases — pre-implementation planning |
| `memory-merger` | `SkillsLib/github/awesome-copilot/skills/memory-merger/` | Phase 6.5 — memory graduation to steering |
| `rag-implementation` | `SkillsLib/wshobson/agents/plugins/llm-application-dev/skills/rag-implementation/` | Phase 6.3 — context assembly retrieval |

`memory-consolidation` is already installed — it handles the Auto Dream pattern (Tier 3 consolidation).

For the TypeScript/Bun/HTTP/testing skills needed to actually build Phase 6, see **`docs/DEV-SKILLS-RECOMMENDATIONS.md`**.

---

### Required Powers (from PowersLib)

**No Direct Memory Powers Found** ❌

**Available in PowersLib:**
- AWS-focused powers (observability, infrastructure, DevOps)
- No pre-built Mem0, Hindsight, or memory management powers
- **Gap identified:** Need to create custom memory power (Phase 7 Library Management will handle this)

**Powers to Reference:**
- `aws-observability` - Patterns for monitoring and state tracking
- `aws-mcp` - MCP server integration patterns

### External Powers/Libraries (Not in PowersLib)

**Mem0 MCP Server**
- NPM: `@mem0ai/mem0-mcp`
- Hosted MCP endpoint: `https://mcp.mem0.ai/mcp`
- Self-hosted option: OpenMemory MCP (Docker-based)
- **Status:** Production-ready, recommended for Phase 6

**Hindsight MCP Server**
- GitHub: https://github.com/vectorize-io/hindsight
- Docker-based deployment
- Fully local/self-hosted
- **Status:** Open-source alternative to Mem0

**Agentic Memory MCP**
- PyPI: `agentic-memory-mcp`
- Knowledge Graph approach
- **Status:** Python-based, may require wrapper for Bun/TypeScript AgentHQ

**`@modelcontextprotocol/server-memory`**
- Already installed globally on this machine
- Running as `power-oracle-carbon-analysis-memory` (now relocated to Scottish Water workspace)
- **For AgentHQ:** Add a dedicated instance with AgentHQ-scoped `MEMORY_FILE_PATH`

---

## Proposed Memory Architecture for AgentHQ

### Option A: Hindsight Integration (Recommended)

**Why Hindsight:**
1. **2x Better Accuracy:** 94.6% vs 49.0% for Mem0 on independent benchmarks
2. **MIT License:** Truly open-source, no proprietary restrictions
3. **Self-Hosted:** Complete data sovereignty, zero ongoing costs
4. **Docker-Based:** Single command deployment, no complex setup
5. **MCP-Native:** Works with all MCP-compatible tools
6. **Simpler Integration:** 7-10 days vs 10-14 for Mem0 (fewer abstractions)

**Architecture:**
```
┌──────────────────────────────────────────────────────┐
│                   AgentHQ Dashboard                   │
│  (Memory Browser, Analytics, Workspace Selector)      │
└───────────────────┬──────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
┌───────▼────────┐    ┌─────────▼────────┐
│  Phase 5 DB    │    │  Mem0 MCP Server │
│  (SQLite)      │    │  (Memory Layer)  │
└────────────────┘    └──────────────────┘
        │                       │
        │                       │
     Jobs,                   Memories:
     Chains,                 - Architecture decisions
     Sessions                - Debug patterns
                             - Tool preferences
                             - Error resolutions
                             - Cross-session learnings
```

**Memory Scopes for AgentHQ:**
- `workspace_id` - Already implemented (Phase 4)
- `user_id` - Developer using AgentHQ (e.g., "cornel", "team-member-1")
- `agent_id` - Specific agent instance (e.g., "openrouter-owl-alpha")
- `run_id` - Single job execution (maps to Job.id)
- `chain_id` - Session chain (maps to Chain.chainId)

**Integration Points:**
1. **Agent Execution (`src/agent.ts`)** - Store learnings after each job
2. **Session Management (`src/session.ts`)** - Retain cross-session context
3. **Job Completion (`src/routes/jobs.ts`)** - Extract and store patterns
4. **Dashboard (`src/dashboard/`)** - Memory browser UI for inspecting stored memories
5. **WebSocket** - Real-time memory updates broadcast to connected clients

### Option B: Mem0 Integration (Alternative)

**Why Consider Mem0:**
1. **Managed service:** Zero infrastructure overhead (but costs $/month)
2. **Multi-tool ecosystem:** 21 framework integrations
3. **Token efficiency:** ~6,900 tokens/query optimization

**Trade-offs vs Hindsight:**
- ❌ 2x worse accuracy (49.0% vs 94.6% on independent benchmarks)
- ❌ Proprietary benchmarks (92.5% LoCoMo not independently validated)
- ❌ Requires managed service subscription or complex self-hosting
- ❌ More complex API (more abstractions to learn)
- ✅ Managed service option available (if you prefer not to self-host)

### Option C: Custom Memory Layer (Not Recommended)

**Why NOT to build custom:**
1. Reinventing battle-tested solutions (Hindsight has peer-reviewed benchmarks)
2. Token efficiency optimization is non-trivial (6,900 vs 26,000 tokens)
3. Multi-signal retrieval (semantic + keyword + entity) requires expertise
4. Benchmark validation (LoCoMo, LongMemEval, BEAM) takes months
5. Ongoing maintenance burden as LLM context windows evolve

**When to Consider:**
- Highly specialized domain requirements
- Regulatory constraints preventing Docker deployment
- Existing vector DB infrastructure to leverage

**Decision: Use Hindsight** - 2x better accuracy, MIT license, simpler integration, zero ongoing costs

---

## Memory Feature Requirements

### FR-1: Episodic Memory (What Happened)
Store and retrieve execution history across sessions.

**Examples:**
- "Show me all jobs where we encountered a 'Connection refused' error"
- "What was the resolution for the auth timeout issue last week?"
- "Retrieve the debugging steps from the failed deployment yesterday"

**Implementation:**
- Automatically extract facts from job logs (`.md` files)
- Store with metadata: `workspace_id`, `chain_id`, `run_id`, `timestamp`
- Tag with categories: error type, resolution, affected components

### FR-2: Semantic Memory (What Is Known)
Maintain persistent knowledge about workspaces, projects, architectures.

**Examples:**
- "This project uses JWT + Redis for authentication"
- "The database schema changed in PR #145 - migration added user_roles table"
- "TypeScript `any()` is banned in this workspace per team convention"

**Implementation:**
- Extract architectural decisions from spec chains
- Store constraint violations and their resolutions
- Maintain tech stack inventory per workspace

### FR-3: Procedural Memory (How Things Are Done)
Remember workflows, patterns, and debugging procedures that work.

**Examples:**
- "When build fails with EACCES, run `chmod +x scripts/build.sh` first"
- "Before deploying, always run full test suite and check git status"
- "For database migration issues, check `docs/db/migration-guide.md`"

**Implementation:**
- Learn from successful job chains (multi-step workflows)
- Store debugging decision trees
- Pattern-match recurring issue → resolution pairs

### FR-3.5: Circuit Breaker for Memory Service Failures

**Problem:** If Hindsight/memory service goes down, entire memory layer fails and blocks agent execution.

**Solution:** 3-State Circuit Breaker with Graceful Degradation

**Circuit Breaker States:**

```typescript
enum CircuitState {
  CLOSED = 'closed',     // Normal operation, count failures
  OPEN = 'open',         // Fail fast, no calls to service
  HALF_OPEN = 'half_open' // Probe: try one request to check if recovered
}

interface CircuitBreakerConfig {
  failureThreshold: number;      // 3 consecutive failures → OPEN
  successThreshold: number;      // 2 consecutive successes in HALF_OPEN → CLOSED
  timeout: number;               // 30s in OPEN before trying HALF_OPEN
  halfOpenRequests: number;      // Allow 1 probe request in HALF_OPEN
}

class MemoryCircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  
  async call<T>(operation: () => Promise<T>, fallback: () => T): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      // Check if timeout elapsed
      if (Date.now() - this.lastFailureTime > this.config.timeout) {
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
      } else {
        // Still open, use fallback immediately
        return fallback();
      }
    }
    
    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      return fallback();
    }
  }
  
  private onSuccess() {
    this.failureCount = 0;
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.state = CircuitState.CLOSED;
        logger.info('Circuit breaker CLOSED - memory service recovered');
      }
    }
  }
  
  private onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = CircuitState.OPEN;
      logger.error('Circuit breaker OPEN - memory service failing');
    }
  }
}
```

**Fallback Strategy When Circuit is OPEN:**
```typescript
// Memory search fallback
const circuitBreaker = new MemoryCircuitBreaker({
  failureThreshold: 3,
  successThreshold: 2,
  timeout: 30000,
  halfOpenRequests: 1
});

async function searchMemoriesWithFallback(query: string): Promise<Memory[]> {
  return await circuitBreaker.call(
    // Primary: Call Hindsight
    async () => await hindsight.recall({ query, limit: 10 }),
    
    // Fallback: Return empty (agent works without memory context)
    () => {
      logger.warn('Memory service unavailable, proceeding without memory context');
      return [];
    }
  );
}

// Memory storage fallback
async function storeMemoryWithFallback(memory: Memory): Promise<void> {
  return await circuitBreaker.call(
    // Primary: Store in Hindsight
    async () => await hindsight.retain(memory),
    
    // Fallback: Queue for retry (write to local cache file)
    () => {
      logger.warn('Memory service unavailable, queueing memory for retry');
      await retryQueue.add(memory);
    }
  );
}
```

**Observability Hooks:**
```typescript
// Expose circuit breaker state as metric
interface CircuitBreakerMetrics {
  state: CircuitState;
  failure_count: number;
  success_count: number;
  last_failure_time: number;
  total_calls: number;
  total_failures: number;
  total_fallbacks: number;
}

// Dashboard displays circuit breaker status
GET /api/memory/circuit-breaker
{
  "state": "open",
  "failure_count": 3,
  "last_failure_time": "2026-07-03T10:30:00Z",
  "next_probe_attempt": "2026-07-03T10:30:30Z",
  "total_fallbacks": 15
}
```

**Success Criteria:**
- Circuit breaker trips after 3 consecutive failures
- Agent continues executing without memory when circuit is OPEN
- Automatic recovery when service comes back (HALF_OPEN → CLOSED)
- Dashboard shows circuit breaker state
- No agent crashes due to memory service failures

### FR-4: Cross-Session Context Assembly
Automatically inject relevant memories into agent context.

**Workflow:**
```typescript
// Before agent execution
const relevantMemories = await hindsight.recall({
  query: job.name + " " + job.type,
  user_id: developer_id,
  workspace_id: workspace_id,
  limit: 10
});

// Inject into agent system prompt
const contextualizedPrompt = `
${baseSystemPrompt}

## Relevant Past Context
${relevantMemories.map(m => `- ${m.memory}`).join('\n')}
`;
```

### FR-4.5: Hybrid Embedding Strategy (45% Cost Savings)

**Problem:** Real-time embedding for all memories costs 3-5x more than batch embedding and creates operational complexity.

**Solution:** 3-Tier Hybrid Architecture

**Tier 1: Query Embeddings (Real-Time + Cache)**
- User searches trigger real-time embedding (~200ms)
- Cache query embedding (5min TTL, cosine > 0.95 similarity)
- 60% cache hit rate reduces API calls by 60%
- Cost: ~$0.001/month for 100 searches/day

**Tier 2: Hot Documents (Last 100 Jobs - Immediate)**
- Embed immediately on job completion
- Write to vector DB (searchable in <1s)
- Cost: $0.12/M tokens (Voyage-3-large standard API)
- Use case: "What did I just work on?"

**Tier 3: Cold Documents (Historical Jobs - Batch Every 6 Hours)**
- Extract memory text on completion (store in DB)
- Mark `embedding_status = 'pending'`
- Batch embed every 6 hours (Voyage Batch API)
- Cost: $0.08/M tokens (33% discount, 12-hour window)
- Use case: "Find similar work from last month"

**Cost Comparison (10K historical jobs, 500 tokens each, 10 new jobs/day):**

| Strategy | Backfill | Daily Hot | Daily Cold | Year 1 Total | Savings |
|----------|----------|-----------|------------|--------------|---------|
| All Real-Time | $0.60 | $0.22/yr | - | **$0.82** | Baseline |
| Hybrid (Tier 2+3) | $0.40 | $0.04/yr | $0.01/yr | **$0.45** | **45%** |
| All Batch | $0.40 | - | $0.15/yr | **$0.55** | 33% |

**Recommendation:** Hybrid (Tier 2+3) — recent jobs searchable immediately, historical jobs cheap.

**Implementation (Phase 6.2):**
```typescript
interface MemoryExtractionRecord {
  job_id: string;
  extracted_at: timestamp;
  raw_text: string;           // Always stored immediately
  embedding: vector | null;   // null = pending batch
  embedding_status: 'pending' | 'embedded' | 'failed';
  embedding_model: string;    // voyage-3-large
  tier: 'hot' | 'cold';
}

// On job completion
async function extractAndTierMemories(job: Job) {
  const memories = await extractMemories(job);
  const qualityScore = await evaluateQuality(memories); // agentic-eval
  
  if (qualityScore < 0.85) {
    logger.warn('Memory extraction quality below threshold', { job_id: job.id });
    return; // Reject noisy memories
  }
  
  const recentJobCount = await db.count('SELECT COUNT(*) FROM jobs WHERE completed_at > NOW() - INTERVAL 7 days');
  const isHot = recentJobCount <= 100; // Last 100 jobs are "hot"
  
  if (isHot) {
    // Tier 2: Embed immediately
    const embedding = await voyageAPI.embed(memories, { model: 'voyage-3-large' });
    await vectorDB.upsert(job.id, embedding);
    await db.insert('memory_extraction', {
      job_id: job.id,
      raw_text: memories,
      embedding: embedding,
      embedding_status: 'embedded',
      tier: 'hot'
    });
  } else {
    // Tier 3: Queue for batch
    await db.insert('memory_extraction', {
      job_id: job.id,
      raw_text: memories,
      embedding: null,
      embedding_status: 'pending',
      tier: 'cold'
    });
  }
}

// Batch worker (runs every 6 hours via cron)
async function batchEmbedWorker() {
  const pending = await db.query(`
    SELECT job_id, raw_text 
    FROM memory_extraction 
    WHERE embedding_status = 'pending' 
    ORDER BY extracted_at 
    LIMIT 1000
  `);
  
  if (pending.length === 0) return;
  
  // Voyage Batch API (33% discount, 12-hour completion)
  const batchJob = await voyageAPI.createBatchJob({
    input_file: pending.map(p => ({ text: p.raw_text })),
    model: 'voyage-3-large',
    endpoint: '/v1/embeddings'
  });
  
  // Poll for completion (2-4 hours average)
  const results = await voyageAPI.waitForCompletion(batchJob.id);
  
  // Update vector DB and status
  for (const result of results) {
    await vectorDB.upsert(result.job_id, result.embedding);
    await db.update('memory_extraction', {
      embedding: result.embedding,
      embedding_status: 'embedded'
    }, { job_id: result.job_id });
  }
}
```

**Semantic Query Caching (Tier 1):**
```typescript
interface QueryCache {
  query_embedding: vector;
  result_ids: string[];
  cached_at: timestamp;
  hit_count: number;
}

async function searchMemories(query: string): Promise<Memory[]> {
  const queryEmbedding = await embedQuery(query); // Real-time, ~200ms
  
  // Check cache (cosine similarity > 0.95 = semantically identical)
  const cached = await cacheDB.findSimilar(queryEmbedding, threshold: 0.95);
  if (cached && !isCacheStale(cached.cached_at, ttl: 300)) { // 5min TTL
    return vectorDB.getByIds(cached.result_ids);
  }
  
  // Cache miss: search and cache
  const results = await vectorDB.search(queryEmbedding, limit: 10);
  await cacheDB.insert({
    query_embedding: queryEmbedding,
    result_ids: results.map(r => r.id),
    cached_at: Date.now(),
    hit_count: 1
  });
  
  return results;
}
```

### FR-5: Memory Browser Dashboard
Visual interface for inspecting, editing, deleting memories.

**UI Components:**
- Memory timeline (chronological view)
- Memory graph (entity relationships)
- Search interface (semantic + filters)
- Memory editor (update/delete individual memories)
- Scope filter (by user, workspace, agent, run, chain)

**Tech Stack:**
- Build on Phase 5 Analytics foundation
- Reuse Chart.js for memory trend visualization
- Material Design 3 components (from SkillsLib)

### FR-6: Memory Export/Import
Backup, transfer, and share memories across teams.

**Formats:**
- JSON export (all memories with metadata)
- Markdown export (human-readable memory dump)
- CSV export (for spreadsheet analysis)

**Use Cases:**
- Team onboarding (import veteran developer's memories)
- Workspace templates (pre-populated architectural knowledge)
- Audit trails (compliance documentation)

---

## Implementation Roadmap

### Phase 6.1: Memory Infrastructure Setup
**Duration:** 2-3 days

**Tasks:**
1. ~~Evaluate Mem0 vs Hindsight~~ **DECIDED: Use Hindsight** (94.6% vs 49.0% accuracy)
2. Deploy Hindsight MCP server (Docker: `docker run vectorize/hindsight`)
3. Create memory configuration in AgentHQ
4. Implement memory scopes (user_id, workspace_id mapping)
5. Add memory operations to `src/types.ts`
6. Create `src/memory/` module structure
7. Write memory client wrapper for MCP communication
8. Implement `IMemoryClient` port interface (supports Hindsight ↔ Mem0 ↔ Zep swapping)
9. **Implement 3-state circuit breaker** (Closed/Open/Half-Open)
10. **Add fallback strategy** (empty memories when circuit OPEN, queue writes for retry)

**Files to Create:**
- `src/memory/client.ts` - MCP client for memory operations
- `src/memory/hindsight.ts` - Hindsight adapter implementing IMemoryClient
- `src/memory/circuit-breaker.ts` - 3-state circuit breaker implementation
- `src/memory/retry-queue.ts` - Retry queue for failed memory writes
- `src/memory/scopes.ts` - Scope resolution logic
- `src/memory/extraction.ts` - Fact extraction from jobs/sessions
- `src/memory/types.ts` - Memory-specific TypeScript types
- `.env` additions for `HINDSIGHT_URL` (default: `http://localhost:3100`)
- `docker-compose.yml` - Hindsight deployment config

**Success Criteria:**
- Hindsight container running and accessible
- Memory client can retain, recall, reflect via MCP
- **Circuit breaker trips on 3 consecutive failures**
- **Agent continues executing without memory when circuit OPEN**
- **Automatic recovery via HALF_OPEN state**
- Scope resolution correctly maps AgentHQ entities to memory scopes
- Basic extraction pipeline processes one job successfully
- `IMemoryClient` interface allows swapping memory backends

### Phase 6.2: Automatic Memory Extraction
**Duration:** 3-4 days

**CRITICAL: Quality-Gated Extraction (MANDATORY from agentic-eval skill)**

Memory extraction without quality gates produces memory rot. Apply the evaluator-optimizer pattern from `agentic-eval` skill before storing ANY extracted fact:

```typescript
// src/memory/extraction.ts — DO NOT merge without this pattern
const rubric = {
  accuracy: { weight: 0.4, criteria: "Fact is verifiable from source" },
  relevance: { weight: 0.3, criteria: "Fact will improve future agent decisions" },
  specificity: { weight: 0.3, criteria: "Fact is concrete, not generic" }
};

const EXTRACTION_THRESHOLD = 0.75;  // 75/100 minimum score

async function extractFacts(jobLog: string): Promise<Fact[]> {
  const candidateFacts = await llmExtract(jobLog);
  const scored = await evaluateFacts(candidateFacts, rubric);
  
  if (scored.overall < EXTRACTION_THRESHOLD) {
    console.warn(`Extraction quality ${scored.overall} below threshold ${EXTRACTION_THRESHOLD}`);
    return await refinedExtract(jobLog, scored.feedback);  // Retry with critique
  }
  
  return scored.facts.filter(f => f.score >= EXTRACTION_THRESHOLD);
}
```

**Reject these patterns:**
- ❌ Generic observations: "The system has modules" (no actionable specificity)
- ❌ Transient state: "Build currently failing" (expires immediately)
- ❌ Unverifiable claims: "This approach might work" (speculative, not confirmed)

**Accept these patterns:**
- ✅ Verified constraints: "PROJECT_ITEM requires index on PROJECT_SECTION_ID — added 2026-06-20"
- ✅ Resolution patterns: "EACCES on build.sh → chmod +x fixes it (confirmed 3x)"
- ✅ Architecture facts: "Dashboard uses Bun.serve on port 3333, no framework"

**Tasks:**
1. Extract facts from completed jobs (`.md` files)
2. Extract architectural decisions from spec chains
3. Extract error patterns and resolutions from logs
4. **Implement quality-gated extraction with evaluator-optimizer loop (agentic-eval)**
5. Implement memory deduplication (avoid storing same fact twice)
6. Add memory tagging (categories, entities, timestamps)
7. Integrate with Phase 5 database (store memory references)
8. Add memory extraction to job completion flow

**Files to Modify:**
- `src/routes/jobs.ts` - Trigger extraction on job completion
- `src/scan/chains.ts` - Extract from spec chain events
- `src/workers/backfill.ts` - Backfill historical memories

**Success Criteria:**
- Jobs automatically generate memories without manual intervention
- Memories tagged with correct categories and entities
- No duplicate memories stored
- Database tracks memory extraction status per job

### Phase 6.3: Context Assembly & Agent Integration
**Duration:** 2-3 days

**Tasks:**
1. Implement memory retrieval before agent execution
2. Inject relevant memories into agent system prompt
3. Add memory search to agent tool set (optional)
4. Store agent-generated insights as new memories
5. Implement memory-augmented agent configuration
6. Add memory statistics to job metadata

**Files to Modify:**
- `src/agent.ts` - Memory-augmented agent execution
- `src/config.ts` - Memory-enabled agent config
- `src/tools/index.ts` - Add memory search tool (optional)

**Success Criteria:**
- Agent receives top-10 relevant memories before execution
- Agent can store new learnings as memories
- Memory injection doesn't exceed token budget
- Measurable improvement in agent effectiveness (fewer errors, faster resolutions)

### Phase 6.4: Memory Browser Dashboard
**Duration:** 4-5 days

**CRITICAL: Accessibility Compliance (MANDATORY from accessibility skill)**

The memory browser will render a force-directed graph via D3.js or similar. **Canvas-based graphs are invisible to screen readers.** Apply these mandatory patterns:

**1. Keyboard Navigation**
```typescript
// src/dashboard/components/memory-graph.ts
function renderMemoryGraph(container: HTMLElement, data: Graph) {
  // MANDATORY: Focus management for node selection
  container.setAttribute('tabindex', '0');
  container.setAttribute('role', 'application');
  container.setAttribute('aria-label', 'Memory knowledge graph with ' + data.nodes.length + ' entities');
  
  container.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') selectNextNode();
    if (e.key === 'Enter') expandNode(selectedNode);
  });
}
```

**2. Screen Reader Fallback**
```html
<!-- Invisible to sighted users, exposed to screen readers -->
<table class="visually-hidden" aria-describedby="memory-graph-desc">
  <caption id="memory-graph-desc">Memory graph showing 45 entities and their relationships</caption>
  <tr><th>Entity</th><th>Relations</th></tr>
  <tr><td>PowersLib</td><td>contains aws-mcp, stripe, terraform</td></tr>
  <!-- ... generated from graph data ... -->
</table>
```

**3. Color Contrast (WCAG AA)**
- Entity nodes: Use `--md-primary` with sufficient contrast against `--md-surf` background
- Relation edges: Minimum 3:1 contrast ratio
- Selected nodes: Do NOT rely on color alone — add border + aria-selected attribute

**Tasks:**
1. Design memory browser UI (timeline + graph + search)
2. Implement memory search interface
3. Add memory timeline visualization
4. Add memory graph (entity relationships)
5. **Implement keyboard navigation for graph (MANDATORY)**
6. **Add screen reader fallback table (MANDATORY)**
7. **Validate WCAG AA color contrast (MANDATORY)**
8. Implement memory CRUD operations (create, read, update, delete)
9. Add scope filtering (user, workspace, agent, run, chain)
10. Integrate with existing dashboard navigation
11. Real-time memory updates via WebSocket

**Files to Create:**
- `src/dashboard/pages/memory.ts` - Memory browser page
- `src/dashboard/components/memory-timeline.ts` - Timeline view
- `src/dashboard/components/memory-graph.ts` - Graph view with a11y
- `src/dashboard/components/memory-search.ts` - Search interface
- `src/routes/memory.ts` - Memory API endpoints

**Success Criteria:**
- Memory browser loads within 500ms
- Search returns relevant results with <200ms latency
- CRUD operations work correctly
- Real-time updates visible in dashboard
- Scope filters correctly isolate memories

### Phase 6.5: Memory Export/Import & Advanced Features
**Duration:** 2-3 days

**Tasks:**
1. Implement memory export (JSON, Markdown, CSV)
2. Implement memory import with validation
3. Add memory templates (workspace archetypes)
4. Implement memory decay (reduce relevance over time)
5. Add memory analytics (most accessed, most useful, staleness detection)
6. Create memory management API
7. Write memory feature documentation

**Files to Create:**
- `src/routes/memory-export.ts` - Export endpoints
- `src/routes/memory-import.ts` - Import endpoints
- `src/memory/templates.ts` - Pre-built memory templates
- `src/memory/analytics.ts` - Memory usage analytics
- `docs/memory-guide.md` - User documentation

**Success Criteria:**
- Export generates valid files (JSON, MD, CSV)
- Import validates and loads memories correctly
- Templates accelerate new workspace setup
- Analytics identify useful vs stale memories
- Documentation covers all memory features

---

## Configuration

### Hindsight Configuration (Recommended)
```bash
# Docker deployment (recommended for production)
docker run -d \
  --name hindsight-memory \
  -p 3100:3100 \
  -v $(pwd)/hindsight-data:/data \
  vectorize/hindsight:latest

# Alternative: docker-compose.yml
version: '3.8'
services:
  hindsight:
    image: vectorize/hindsight:latest
    ports:
      - "3100:3100"
    volumes:
      - ./data/hindsight:/data
    environment:
      - LOG_LEVEL=info
    restart: unless-stopped
```

```typescript
// .env additions
MEMORY_ENABLED=true
MEMORY_BACKEND=hindsight
MEMORY_EXTRACTION_ENABLED=true
MEMORY_AUTO_INJECT=true
MEMORY_MAX_CONTEXT_MEMORIES=10
HINDSIGHT_URL=http://localhost:3100
HINDSIGHT_MCP_URL=http://localhost:3100/mcp
MEMORY_STORAGE_PATH=./data/hindsight

// src/constants.ts additions
export const MEMORY_ENABLED = process.env.MEMORY_ENABLED === 'true';
export const MEMORY_BACKEND = process.env.MEMORY_BACKEND ?? 'hindsight';
export const MEMORY_EXTRACTION_ENABLED = process.env.MEMORY_EXTRACTION_ENABLED === 'true';
export const MEMORY_AUTO_INJECT = process.env.MEMORY_AUTO_INJECT === 'true';
export const MEMORY_MAX_CONTEXT_MEMORIES = Number(process.env.MEMORY_MAX_CONTEXT_MEMORIES) || 10;
export const HINDSIGHT_URL = process.env.HINDSIGHT_URL ?? 'http://localhost:3100';
export const HINDSIGHT_MCP_URL = process.env.HINDSIGHT_MCP_URL ?? 'http://localhost:3100/mcp';
export const MEMORY_STORAGE_PATH = process.env.MEMORY_STORAGE_PATH ?? './data/hindsight';
```

### Mem0 Configuration (Alternative - Managed Service)
```typescript
// .env additions
MEM0_API_KEY=your-mem0-api-key-here
MEMORY_BACKEND=mem0
MEMORY_ENABLED=true
MEMORY_EXTRACTION_ENABLED=true
MEMORY_AUTO_INJECT=true
MEMORY_MAX_CONTEXT_MEMORIES=10

// src/constants.ts additions
export const MEM0_API_KEY = process.env.MEM0_API_KEY ?? '';
export const MEM0_MCP_URL = process.env.MEM0_MCP_URL ?? 'https://mcp.mem0.ai/mcp';
```
  vectorize/hindsight:latest

# .env additions
MEMORY_MCP_URL=http://localhost:3100/mcp
MEMORY_STORAGE_PATH=./hindsight-data
```

---

## Memory Scoping Strategy

### Scope Hierarchy (Most Specific to Most General)
```
run_id (single job execution)
  ↓
chain_id (session chain)
  ↓
workspace_id (project/engagement)
  ↓
user_id (developer)
  ↓
app_id (AgentHQ installation)
```

### Scope Resolution Examples
```typescript
// Job-specific memory
await mem0.add({
  text: "Build failed with EACCES error on scripts/build.sh",
  user_id: "cornel",
  workspace_id: "scottish-water",
  run_id: "2026-07-03-1530-analyze",
  metadata: { category: "error", component: "build" }
});

// Workspace-level knowledge
await mem0.add({
  text: "Project uses JWT access tokens with Redis refresh tokens for auth",
  user_id: "cornel",
  workspace_id: "scottish-water",
  agent_id: "openrouter-owl-alpha",
  metadata: { category: "architecture", component: "auth" }
});

// Cross-workspace pattern
await mem0.add({
  text: "For Oracle performance issues, always check execution plan first",
  user_id: "cornel",
  metadata: { category: "procedure", domain: "database" }
});
```

### Retrieval Priority
1. **Exact match** (run_id) - 100% relevance
2. **Chain match** (chain_id) - 90% relevance
3. **Workspace match** (workspace_id) - 70% relevance
4. **User match** (user_id) - 50% relevance
5. **Semantic similarity** - Variable based on vector distance

---

## Success Metrics

### Quantitative Metrics
- **Memory Retrieval Latency:** <200ms per search
- **Context Token Efficiency:** <7,000 tokens per agent invocation (matching Mem0 benchmarks)
- **Memory Extraction Rate:** >90% of completed jobs generate memories
- **Memory Relevance Score:** >80% of retrieved memories rated useful by developers
- **Agent Effectiveness:** 30% reduction in repeated errors after memory implementation

### Qualitative Metrics
- Agents remember architectural decisions across sessions
- Debugging patterns persist and accelerate future troubleshooting
- Team members benefit from each other's agent learnings
- Onboarding faster with pre-populated workspace memories
- Reduced context explanation overhead (agents "just know")

---

## Risk Assessment

### Risk 1: Memory Noise (Low Relevance Memories)
**Impact:** Medium | **Probability:** High

**Mitigation:**
- Implement memory relevance scoring
- Decay low-accessed memories over time
- User feedback loop (thumbs up/down on memories)
- Regular memory cleanup via analytics

### Risk 2: Token Budget Exceeded
**Impact:** High | **Probability:** Medium

**Mitigation:**
- Hard cap on memories per context (10 default, configurable)
- Token counting before injection
- Summarization of long memories
- Fallback to no-memory execution if budget exceeded

### Risk 3: Privacy & Data Leakage
**Impact:** High | **Probability:** Low

**Mitigation:**
- Mem0 is SOC 2 compliant (if using managed service)
- Self-hosted option (Hindsight) for sensitive workspaces
- Memory scoping prevents cross-workspace leakage
- Explicit PII detection and redaction in extraction pipeline

### Risk 4: Memory Staleness
**Impact:** Medium | **Probability:** Medium

**Mitigation:**
- Timestamp-based relevance decay
- Memory update mechanism (not just create)
- Conflict detection (e.g., "user moved from NY to SF")
- Periodic memory review prompts for developers

### Risk 5: Extraction Quality
**Impact:** Medium | **Probability:** Medium

**Mitigation:**
- LLM-based fact extraction (not regex)
- Human-in-the-loop for critical memories
- Memory validation before storage
- Continuous improvement via feedback

---

## Dependencies

### New Dependencies (package.json)
```json
{
  "dependencies": {
    "@openrouter/agent": "latest",
    "dotenv": "^17.4.2",
    "zod": "latest",
    "chart.js": "^4.4.0",
    "@mem0ai/mem0-mcp": "latest"  // NEW: Mem0 MCP client
  }
}
```

### External Services
- **Mem0 Managed Service:** Free tier available, paid tiers for production scale
- **OR Hindsight Self-Hosted:** Docker deployment, zero external costs
- **Vector Database:** (included in Mem0/Hindsight, or leverage Phase 5 DB)

---

## Documentation Deliverables

### User Documentation
- `docs/memory-guide.md` - Complete memory feature guide
- `docs/memory-best-practices.md` - Tips for effective memory usage
- `docs/memory-api.md` - Memory API reference
- Update `README.md` with memory feature overview

### Developer Documentation
- `src/memory/README.md` - Memory module architecture
- `docs/memory-architecture.md` - Technical design document
- `docs/memory-benchmarks.md` - Performance benchmarks
- Memory scope design patterns

### Migration Guide
- `docs/memory-migration.md` - Adding memory to existing deployments
- Backfill scripts for historical jobs
- Configuration examples for different deployment scenarios

---

## Future Enhancements (Out of Scope for Phase 6)

### Multi-Agent Memory Sharing
- Agents learn from each other's executions
- Collective intelligence across workspace
- Memory federat
ion across AgentHQ instances

### Memory Reasoning Engine
- Causal inference over memory graph
- Contradiction detection and resolution
- Temporal reasoning improvements
- Multi-hop memory queries

### Active Learning
- Agent requests clarification when memories conflict
- Proactive memory updates based on changed context
- Confidence scoring on extracted facts

### Memory Visualization
- 3D memory graph explorer
- Concept clustering visualization
- Memory evolution timeline

---

## Recommended Action Plan

### Immediate Actions (This Week)
1. ✅ **Review this document** - Validate memory approach and scope
2. ⚡ **Evaluate Mem0 vs Hindsight** - Run quick local test with both
3. ⚡ **Set up Mem0 trial account** - Get API key, test MCP integration
4. ⚡ **Create Phase 6 spec** - Convert this prompt into formal requirements/design/tasks

### Short-Term (Next 2 Weeks)
1. Implement Phase 6.1 (Memory Infrastructure)
2. Implement Phase 6.2 (Automatic Extraction)
3. Basic memory integration working end-to-end

### Medium-Term (Next Month)
1. Complete Phase 6.3 (Context Assembly & Agent Integration)
2. Complete Phase 6.4 (Memory Browser Dashboard)
3. Memory-augmented agents running in production

### Long-Term (Next Quarter)
1. Complete Phase 6.5 (Export/Import & Advanced Features)
2. Measure success metrics and iterate
3. Explore future enhancements based on usage patterns

---

## Key Decisions Required

### Decision 1: Mem0 vs Hindsight vs Custom
**Recommendation:** **Mem0 (Managed Service)**
**Rationale:** 
- Production-proven benchmarks
- Zero infrastructure overhead
- Cross-tool compatibility (Cursor, Claude Code)
- Can switch to self-hosted OpenMemory MCP later if needed

**Alternative:** Hindsight for air-gapped or highly sensitive deployments

### Decision 2: Memory Extraction - Automatic vs Manual
**Recommendation:** **Automatic with Manual Override**
**Rationale:**
- Automatic ensures comprehensive coverage
- Manual allows correction of extraction errors
- Hybrid approach balances automation with quality

### Decision 3: Memory Storage - Separate Service vs Phase 5 DB
**Recommendation:** **Separate Service (Mem0/Hindsight)**
**Rationale:**
- Specialized vector search optimized for semantic retrieval
- Offloads complexity from Phase 5 SQLite/PostgreSQL
- Leverages battle-tested memory infrastructure
- Can co-exist with Phase 5 DB (metadata in DB, content in memory service)

### Decision 4: Scope Granularity
**Recommendation:** **Full 5-Scope Model (user, workspace, agent, run, chain)**
**Rationale:**
- Maximum flexibility for retrieval filtering
- Aligns with Mem0 best practices
- Supports future multi-tenant and team features
- Minimal overhead (just metadata tags)

---

## References

### Research Documents (ReferenceLib)
- `ReferenceLib/claude/mem0.ai/memory-what-is-agent-memory.md`
- `ReferenceLib/claude/mem0.ai/mem0-state-of-memory-2026.md`
- `ReferenceLib/claude/mem0.ai/mem0-coding-agent-memory.md`
- `ReferenceLib/claude/mem0.ai/memory-agent-benchmarks-2026.md`

### Online Resources
- Mem0 Documentation: https://docs.mem0.ai/
- Hindsight GitHub: https://github.com/vectorize-io/hindsight
- Mem0 MCP Package: https://www.npmjs.com/package/@mem0ai/mem0-mcp
- Agentic Memory MCP: https://pypi.org/project/agentic-memory-mcp/
- MCP Memory Best Practices: https://fast.io/resources/mcp-server-memory-management/

### Skills and Powers — Library Paths (verified July 2026)
- `SkillsLib/modelcontextprotocol/servers/src/memory/README.md` — MCP server-memory API reference
- `SkillsLib/github/awesome-copilot/skills/mini-context-graph/SKILL.md` — Karpathy wiki + knowledge graph pattern
- `SkillsLib/github/awesome-copilot/skills/memory-merger/SKILL.md` — memory graduation to instruction files
- `SkillsLib/github/awesome-copilot/skills/agentic-eval/SKILL.md` — evaluator-optimizer for extraction quality
- `SkillsLib/github/awesome-copilot/skills/context-map/SKILL.md` — pre-implementation dependency mapping
- `SkillsLib/wshobson/agents/plugins/llm-application-dev/skills/rag-implementation/SKILL.md` — RAG + hybrid search patterns
- `SkillsLib/anthropics/skills/skills/claude-api/shared/managed-agents-memory.md` — Anthropic managed agents memory patterns
- `PowersLib/kirodotdev/powers/aws-mcp/` — MCP server integration patterns

---

## Appendix: Mem0 Quick Start

### 1. Get API Key
```bash
# Sign up at https://app.mem0.ai/
# Copy API key from dashboard
```

### 2. Install MCP Client
```bash
bun add @mem0ai/mem0-mcp
```

### 3. Basic Integration
```typescript
import { MemoryClient } from '@mem0ai/mem0-mcp';

const client = new MemoryClient({
  apiKey: process.env.MEM0_API_KEY!,
  mcpUrl: 'https://mcp.mem0.ai/mcp'
});

// Add memory
await client.add({
  text: "Project uses Postgres as primary database",
  user_id: "cornel",
  workspace_id: "scottish-water",
  metadata: { category: "architecture" }
});

// Search memories
const memories = await client.search({
  query: "What database are we using?",
  user_id: "cornel",
  workspace_id: "scottish-water",
  limit: 5
});

console.log(memories);
```

### 4. Verify Setup
```bash
bun run test/memory-integration.test.ts
```

---

**END OF PHASE 6 PROMPT**

---

## Instructions for Spec Session Agent

This prompt contains complete context for creating a Kiro spec with:
1. **Requirements document** - Extract memory feature requirements (FR-1 through FR-6)
2. **Design document** - Extract architecture decisions, scope model, integration points
3. **Tasks document** - Extract from implementation roadmap (Phases 6.1 through 6.5)

Create the spec in `.kiro/specs/phase-6-agent-memory-management/` with:
- Comprehensive requirements for all memory types (episodic, semantic, procedural)
- Detailed design covering Mem0/Hindsight integration options
- Actionable tasks for each sub-phase with success criteria
- Configuration examples and migration guidance
- Risk mitigation strategies and success metrics

**Critical Context:**
- Memory research from ReferenceLib (Mem0 benchmarks, state-of-the-art 2026)
- No crawl queue path updates needed (already workspace-relative)
- Phase 5 (Database, WebSocket, Analytics) is prerequisite
- Mem0 is recommended over custom implementation
- Multi-scope memory model (user, workspace, agent, run, chain) is core to design
