# AgentHQ Memory Management - Implementation Summary

## Executive Summary

This document summarizes the research, skills/powers assessment, and configuration status for implementing agent memory management in AgentHQ (Phase 6).

---

## Key Findings

### ✅ Crawl Queue Configuration Status: NO UPDATES NEEDED

**Current State:**
- AgentHQ uses **relative paths** for crawl/clone/build queue files
- Default: `docs/reference/.crawl-queue.json` (workspace-relative)
- No hardcoded ScottishWater paths found in codebase
- Multi-workspace support (Phase 4) allows per-workspace queue configuration

**Migration Verification:**
- ✅ Crawl files migrated from ScottishWater to ReferenceLib
- ✅ ReferenceLib contains all queue files (`.crawl-queue.json`, `.clone-queue.json`, etc.)
- ✅ Zero references to ScottishWater paths in AgentHQ codebase
- ✅ Environment variable fallbacks work correctly

**Conclusion:** No configuration changes required.

---

## Memory Research Summary

### Memory Types (Based on Cognitive Science + AI Research)

1. **Sensory Memory** = Context Window (immediate, finite, expensive)
2. **Short-Term Memory (STM)** = Current session (transient, session-scoped)
3. **Long-Term Memory (LTM)** = Persistent cross-session knowledge (durable, queryable)

### State-of-the-Art: Mem0 (Production-Ready, 2026)

**Benchmarks:**
- LoCoMo: 92.5 score
- LongMemEval: 94.4 score
- BEAM (1M tokens): 64.1 score
- Token efficiency: ~6,900 tokens/query (vs ~26,000 for full-context)

**Key Features:**
- Multi-signal retrieval: Semantic similarity + BM25 keyword + Entity matching
- 21 framework integrations, 20 vector stores
- MCP-compatible (`@mem0ai/mem0-mcp` package)
- Multi-scope model: user_id, agent_id, run_id, app_id, workspace_id

**Integration Options:**
1. **Mem0 Managed Service** - API key, zero infrastructure, free tier available
2. **OpenMemory MCP** - Self-hosted Docker, fully local
3. **Agentic Memory MCP** - Knowledge graph approach (Python-based)

---

## Skills & Powers Assessment

### From SkillsLib ✅

**Available:**
- `SkillsLib/wshobson/agents/` - Agent memory patterns, external memory integration (Pensyve)
- `SkillsLib/material-components/material-web/` - Material Design 3 for memory UI
- System programming patterns with memory lifecycle management

**Recommendation:** Extract memory management patterns from wshobson/agents

### From PowersLib ❌

**NOT FOUND:**
- No pre-built Mem0, Hindsight, or memory management powers in PowersLib
- **Gap identified:** Need to create custom memory power

**Available for Reference:**
- `PowersLib/kirodotdev/powers/aws-observability/` - Monitoring patterns
- `PowersLib/kirodotdev/powers/aws-mcp/` - MCP server integration examples
- `PowersLib/kirodotdev/powers/strands/` - Multi-workspace coordination

### External Powers (Not in Libraries) ✅

**Production-Ready:**
1. **Mem0 MCP Server**
   - NPM: `@mem0ai/mem0-mcp`
   - Hosted: `https://mcp.mem0.ai/mcp`
   - Self-hosted: OpenMemory MCP (Docker)
   - **Status:** Recommended for Phase 6

2. **Hindsight MCP Server**
   - GitHub: vectorize-io/hindsight
   - Docker-based, fully local
   - **Status:** Open-source alternative

3. **Agentic Memory MCP**
   - PyPI: `agentic-memory-mcp`
   - Knowledge graph approach
   - **Status:** Python-based, may need TypeScript wrapper

---

## Recommended Implementation: Mem0

### Why Mem0?

✅ **Production-proven:** Best-in-class benchmarks (92.5/94.4)  
✅ **Token-efficient:** ~6,900 tokens vs ~26,000 for full-context  
✅ **MCP-native:** `@mem0ai/mem0-mcp` package ready  
✅ **Cross-tool:** Works with Cursor, Claude Code, Windsurf  
✅ **Zero infrastructure:** Managed service option  
✅ **Self-host option:** OpenMemory MCP for on-prem  

### Architecture

```
AgentHQ Dashboard (Memory Browser + Analytics)
        │
        ├─────► Phase 5 Database (SQLite/PostgreSQL)
        │        └─ Jobs, Chains, Sessions metadata
        │
        └─────► Mem0 MCP Server (Memory Layer)
                 └─ Episodic, Semantic, Procedural memories
                    with multi-scope retrieval
```

### Memory Scopes

```typescript
interface MemoryScope {
  user_id: string;       // "cornel" - developer using AgentHQ
  workspace_id: string;  // "scottish-water" - already in Phase 4
  agent_id: string;      // "openrouter-owl-alpha" - agent instance
  run_id: string;        // "2026-07-03-1530-analyze" - single job
  chain_id: string;      // spec or session chain
}
```

### Integration Points

1. **Agent Execution** (`src/agent.ts`) - Inject memories before execution, store learnings after
2. **Job Completion** (`src/routes/jobs.ts`) - Extract facts from completed jobs
3. **Session Management** (`src/session.ts`) - Maintain cross-session context
4. **Dashboard** (`src/dashboard/pages/memory.ts`) - Memory browser UI
5. **WebSocket** - Real-time memory updates

---

## Implementation Phases

### Phase 6.1: Memory Infrastructure (2-3 days)
- Set up Mem0 MCP server
- Create memory client wrapper
- Implement scope resolution
- Basic add/search/retrieve operations

### Phase 6.2: Automatic Extraction (3-4 days)
- Extract from job logs (episodic)
- Extract from spec chains (semantic)
- Extract from error patterns (procedural)
- Deduplication and tagging

### Phase 6.3: Context Assembly (2-3 days)
- Retrieve memories before agent execution
- Inject into system prompt
- Store agent-generated insights
- Memory-augmented agent config

### Phase 6.4: Memory Browser Dashboard (4-5 days)
- Timeline view
- Graph view
- Search interface
- CRUD operations
- Real-time updates via WebSocket

### Phase 6.5: Advanced Features (2-3 days)
- Export/import (JSON, Markdown, CSV)
- Memory templates
- Memory decay and analytics
- Documentation

**Total Duration:** 13-18 days

---

## Configuration

### Mem0 Setup

```bash
# .env additions
MEM0_API_KEY=your-api-key-here
MEMORY_ENABLED=true
MEMORY_EXTRACTION_ENABLED=true
MEMORY_AUTO_INJECT=true
MEMORY_MAX_CONTEXT_MEMORIES=10
```

### Dependencies

```json
{
  "dependencies": {
    "@mem0ai/mem0-mcp": "latest"
  }
}
```

### Quick Start

```typescript
import { MemoryClient } from '@mem0ai/mem0-mcp';

const client = new MemoryClient({
  apiKey: process.env.MEM0_API_KEY,
  mcpUrl: 'https://mcp.mem0.ai/mcp'
});

// Store memory
await client.add({
  text: "Project uses JWT + Redis for auth",
  user_id: "cornel",
  workspace_id: "scottish-water",
  metadata: { category: "architecture" }
});

// Search memories
const memories = await client.search({
  query: "authentication approach",
  user_id: "cornel",
  workspace_id: "scottish-water",
  limit: 10
});
```

---

## Success Metrics

### Quantitative
- Memory retrieval latency: <200ms
- Token efficiency: <7,000 tokens per agent invocation
- Memory extraction rate: >90% of jobs
- Memory relevance: >80% rated useful
- Agent effectiveness: 30% reduction in repeated errors

### Qualitative
- Agents remember architectural decisions
- Debugging patterns persist
- Team members benefit from shared learnings
- Faster onboarding with workspace memories
- Reduced context explanation overhead

---

## Key Decisions

### ✅ Decision 1: Mem0 vs Hindsight vs Custom
**Choice:** Mem0 (Managed Service)
**Rationale:** Production-proven, zero infrastructure, can switch to self-hosted later

### ✅ Decision 2: Memory Extraction
**Choice:** Automatic with Manual Override
**Rationale:** Comprehensive coverage + quality control

### ✅ Decision 3: Storage Architecture
**Choice:** Separate Memory Service (Mem0/Hindsight)
**Rationale:** Specialized vector search, offloads complexity from Phase 5 DB

### ✅ Decision 4: Scope Granularity
**Choice:** Full 5-Scope Model
**Rationale:** Maximum flexibility, aligns with Mem0 best practices

---

## Risk Mitigation

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Memory Noise | Medium | High | Relevance scoring, decay, feedback loop |
| Token Budget Exceeded | High | Medium | Hard cap (10 memories), token counting, summarization |
| Privacy & Data Leakage | High | Low | SOC 2 compliance, self-hosted option, scoping |
| Memory Staleness | Medium | Medium | Timestamp decay, update mechanism, conflict detection |
| Extraction Quality | Medium | Medium | LLM-based extraction, validation, human-in-loop for critical |

---

## Documentation Deliverables

### User Docs
- `docs/memory-guide.md` - Complete feature guide
- `docs/memory-best-practices.md` - Usage tips
- `docs/memory-api.md` - API reference

### Developer Docs
- `src/memory/README.md` - Module architecture
- `docs/memory-architecture.md` - Technical design
- `docs/memory-benchmarks.md` - Performance benchmarks

### Migration
- `docs/memory-migration.md` - Deployment guide
- Backfill scripts for historical data
- Configuration examples

---

## Next Steps

### This Week
1. ✅ Review memory implementation plan
2. ⚡ Test Mem0 vs Hindsight locally
3. ⚡ Set up Mem0 trial account
4. ⚡ Create Phase 6 spec (requirements/design/tasks)

### Next 2 Weeks
- Implement Phase 6.1 (Infrastructure)
- Implement Phase 6.2 (Extraction)
- Basic memory integration working

### Next Month
- Complete Phase 6.3 (Context Assembly)
- Complete Phase 6.4 (Memory Browser)
- Memory-augmented agents in production

---

## Resources

### Research Documents (ReferenceLib)
- `ReferenceLib/claude/mem0.ai/memory-what-is-agent-memory.md`
- `ReferenceLib/claude/mem0.ai/mem0-state-of-memory-2026.md`
- `ReferenceLib/claude/mem0.ai/mem0-coding-agent-memory.md`

### External Links
- Mem0 Docs: https://docs.mem0.ai/
- Mem0 MCP: https://www.npmjs.com/package/@mem0ai/mem0-mcp
- Hindsight: https://github.com/vectorize-io/hindsight
- Mem0 Benchmarks: https://mem0.ai/research

### Prompt Files
- `docs/prompts/phase-5-observability-platform.md` - Database, WebSocket, Analytics
- `docs/prompts/phase-6-agent-memory-management.md` - Complete memory implementation spec

---

**Status:** Ready for Phase 6 implementation. All prerequisites validated.
