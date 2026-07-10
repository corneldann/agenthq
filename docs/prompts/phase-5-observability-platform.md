# Phase 5: AgentHQ Observability Platform Enhancement

## Executive Summary

Transform AgentHQ from a monitoring dashboard into a full observability platform by adding:
1. **WebSocket Support** - Bidirectional real-time communication for interactive agent control
2. **Database Persistence** - SQLite/PostgreSQL backend for fast queries and historical tracking
3. **Advanced Analytics** - Performance metrics, cost analysis, bottleneck detection, and predictive insights

## Current Architecture Context

### Tech Stack
- **Runtime:** Bun (JavaScript/TypeScript)
- **Backend:** Native Bun HTTP server with SSE (Server-Sent Events)
- **Frontend:** Vanilla TypeScript SPA
- **Data Storage:** File-based (markdown, JSON, JSONL)
- **Caching:** In-memory TTL-based per-workspace caches
- **Real-time:** SSE for server→client updates only

### Current Data Flow
```
Filesystem (*.md, *.json, *.jsonl)
  ↓ (scan every ~5-10s)
Scanners (scan/jobs.ts, scan/chains.ts, scan/sessions.ts)
  ↓
In-Memory Cache (workspace-cache.ts)
  ↓
HTTP API (/api/jobs, /api/chains, /api/sessions)
  ↓
SSE Broadcast (/sse)
  ↓
Dashboard (vanilla TS SPA)
```

### Core Domain Types (from src/types.ts)
```typescript
interface Job {
  id: string;
  name: string;
  jobChain: string;
  sessionChainId: string;
  timestamp: string;
  type: string;
  agent: string;
  status: "running" | "done" | "reported" | "error";
  lines: number;
  lastLine: string;
  hasLog: boolean;
  logError: boolean;
  mdFile: string;
  logFile: string;
  agentDone: string;
  sizeBytes: number;
  workspaceId: string;
}

interface SessionState {
  workflowHash: string;
  sessionJsonl: string;
  chainId: string;
  chainIndex: number;
  topic: string;
  messageCount: number;
  lastMessageAt: string;
  status: "active" | "idle" | "complete" | "rate-limited";
  chatSessionId?: string;
  workspaceId: string;
}

interface Chain {
  chainId: string;
  displayName: string;
  sessions: Array<{ index: number; workflowHash: string; date: string; messageCount: number; status: string }>;
  totalMessages: number;
  createdAt: string;
  lastActiveAt: string;
  workspaceId: string;
}
```

### Key Files Reference
- `src/monitor.ts` - Main server entry point
- `src/router.ts` - HTTP routing (GET/POST/PUT/DELETE)
- `src/types.ts` - Domain type definitions
- `src/config/workspace-config.ts` - Multi-workspace configuration
- `src/scan/*.ts` - File system scanners (jobs, chains, sessions)
- `src/scan/workspace-cache.ts` - Per-workspace TTL-based caching
- `src/workers/ssebroadcaster.ts` - SSE event broadcasting
- `src/routes/*.ts` - API route handlers
- `src/dashboard/*.ts` - Frontend SPA

### Current Limitations
1. **SSE is unidirectional** - Client cannot send commands back through the connection
2. **File scanning is slow** - Thousands of files scanned repeatedly
3. **No query optimization** - Cannot efficiently filter "last 24h" or aggregate data
4. **No historical tracking** - Cannot track status changes or trends over time
5. **Cache expires frequently** - Data re-scanned every 5-10s
6. **No advanced metrics** - Only basic counts and statuses shown

---

## Feature 1: WebSocket Support for Bidirectional Communication

### Problem Statement
Current SSE implementation only supports server→client updates. Clients must make separate HTTP requests for every action (cancel job, change filter, commit git). This creates:
- Higher latency for interactive operations
- No real-time collaboration between multiple dashboard users
- Inefficient subscription model (all events sent to all clients)

### Proposed Solution
Replace SSE with WebSocket for bidirectional real-time communication while maintaining backward compatibility.

### Key Requirements
1. **Bidirectional messaging** - Client can send commands, server responds and broadcasts
2. **Selective subscriptions** - Clients subscribe to specific workspaces/chains/jobs
3. **Agent control** - Pause, resume, cancel running agents from dashboard
4. **Acknowledgements** - Server confirms receipt and processing of client commands
5. **Multi-user collaboration** - Multiple users see each other's actions in real-time
6. **Fallback support** - SSE endpoint remains available for read-only clients
7. **Authentication ready** - Design allows future auth/authorization layer
8. **Connection management** - Handle reconnects, heartbeats, connection drops

### WebSocket Message Protocol
```typescript
// Client → Server commands
type ClientMessage =
  | { type: 'subscribe', workspaceId?: string, chainId?: string, jobId?: string }
  | { type: 'unsubscribe', workspaceId?: string, chainId?: string, jobId?: string }
  | { type: 'cancel-job', jobId: string, workspaceId: string }
  | { type: 'pause-agent', sessionHash: string, workspaceId: string }
  | { type: 'resume-agent', sessionHash: string, workspaceId: string }
  | { type: 'commit-git', workspaceId: string, message: string, jobStem?: string }
  | { type: 'ping' };

// Server → Client responses
type ServerMessage =
  | { type: 'connected', workspaces: string[], clientId: string }
  | { type: 'ack', commandId: string, success: boolean, error?: string }
  | { type: 'job-update', workspaceId: string, data: Job }
  | { type: 'chain-update', workspaceId: string, data: Chain }
  | { type: 'session-update', workspaceId: string, data: SessionState }
  | { type: 'git-update', workspaceId: string, data: GitStatus }
  | { type: 'user-action', userId: string, action: string, target: string }
  | { type: 'pong' };
```

### Technical Approach
- Use Bun's native WebSocket support (already integrated in Bun.serve)
- Create `src/websocket/` module with connection manager
- Maintain subscription registry (Map<clientId, Set<subscriptions>>)
- Broadcast only to subscribed clients
- Implement command handlers with validation
- Add client-side reconnection logic
- Preserve existing SSE for backward compatibility

### Files to Create/Modify
- `src/websocket/server.ts` - WebSocket upgrade handler
- `src/websocket/connection-manager.ts` - Client connection tracking
- `src/websocket/subscription-manager.ts` - Subscription registry
- `src/websocket/command-handlers.ts` - Process client commands
- `src/websocket/broadcaster.ts` - Selective event broadcasting
- `src/dashboard/websocket-client.ts` - Frontend WebSocket client
- `src/monitor.ts` - Add WebSocket upgrade logic
- `src/types.ts` - Add WebSocket message types

---

## Feature 2: Database Persistence Layer

### Problem Statement
Current file-based scanning is inefficient:
- Scanning 1000+ markdown files on every request (even with 10s cache)
- Cannot efficiently query "jobs from last 24 hours with status=error"
- No historical tracking of status changes
- Cannot perform aggregations like "jobs per day" or "average duration"
- Filesystem locks on Windows cause occasional issues
- Deduplication logic runs on every scan

### Proposed Solution
**Updated (2026 Deep Research):** Start with SQLite + WAL mode with single-writer queue pattern. Conditionally migrate to PostgreSQL only if metrics show it's necessary (writes > 50/sec sustained OR queue depth > 100 OR corruption events > 0).

**Rationale:** AgentHQ is single-user with burst write patterns. SQLite in WAL mode handles this well. PostgreSQL migration adds unnecessary complexity unless triggered by actual performance issues.

### Key Requirements
1. **SQLite by default** - Zero-config, single file, cross-platform
2. **PostgreSQL support** - Optional for production deployments
3. **Hybrid architecture** - Files remain source of truth, DB is derived
4. **Incremental updates** - File watchers update DB on change, not full scans
5. **Fast queries** - Indexed queries for filtering, sorting, aggregations
6. **Historical tracking** - Track all status transitions with timestamps
7. **Atomic operations** - Transaction support for multi-entity updates
8. **Migration system** - Schema versioning for future changes
9. **Zero downtime** - Initial DB population from files on first run
10. **Backward compatible** - File-based scanning still works if DB unavailable

### Database Schema (SQLite)
```sql
-- Workspaces
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  output_dir TEXT NOT NULL,
  sessions_dir TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Jobs with indexed fields
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  job_chain TEXT NOT NULL,
  session_chain_id TEXT,
  timestamp TIMESTAMP NOT NULL,
  type TEXT,
  agent TEXT,
  status TEXT NOT NULL,
  lines INTEGER DEFAULT 0,
  last_line TEXT,
  has_log BOOLEAN DEFAULT FALSE,
  log_error BOOLEAN DEFAULT FALSE,
  md_file TEXT,
  log_file TEXT,
  agent_done TEXT,
  size_bytes INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_workspace_status (workspace_id, status),
  INDEX idx_workspace_timestamp (workspace_id, timestamp DESC),
  INDEX idx_job_chain (job_chain),
  INDEX idx_session_chain (session_chain_id)
);

-- Chains
CREATE TABLE chains (
  chain_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  display_name TEXT NOT NULL,
  next_index INTEGER DEFAULT 0,
  total_messages INTEGER DEFAULT 0,
  created_at TIMESTAMP NOT NULL,
  last_active_at TIMESTAMP NOT NULL,
  overall_status TEXT,
  spec_chain_id TEXT,
  
  INDEX idx_workspace_active (workspace_id, last_active_at DESC)
);

-- Sessions
CREATE TABLE sessions (
  workflow_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  session_jsonl TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  chain_index INTEGER NOT NULL,
  previous_session TEXT,
  topic TEXT,
  message_count INTEGER DEFAULT 0,
  user_message_count INTEGER DEFAULT 0,
  context_usage_pct REAL DEFAULT 0,
  last_message_at TIMESTAMP,
  last_summarised_message_count INTEGER DEFAULT 0,
  last_summarised_at TIMESTAMP,
  summary_file TEXT,
  status TEXT NOT NULL,
  first_user_message TEXT,
  last_user_message TEXT,
  last_agent_message TEXT,
  start_time TIMESTAMP,
  chat_session_id TEXT,
  
  INDEX idx_workspace_chain (workspace_id, chain_id),
  INDEX idx_chat_session (chat_session_id)
);

-- Job status history (for analytics)
CREATE TABLE job_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_job_changes (job_id, changed_at DESC)
);

-- Job execution metrics (for performance analytics)
CREATE TABLE job_metrics (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd REAL,
  tool_calls INTEGER,
  error_count INTEGER,
  retry_count INTEGER
);

-- Schema version tracking
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO schema_version (version) VALUES (1);
```

### Technical Approach
1. **Database Abstraction Layer**
   - Create `src/db/` module with interface + implementations
   - `src/db/interface.ts` - Define DB operations (insert, update, query)
   - `src/db/sqlite.ts` - SQLite implementation using `bun:sqlite`
   - `src/db/postgres.ts` - PostgreSQL implementation (optional)
   - `src/db/migrations.ts` - Schema versioning system

2. **File System Watchers**
   - `src/db/watchers/` - Watch job, chain, session directories
   - On file create/modify: parse and upsert to DB
   - On file delete: mark as deleted (soft delete)

3. **Initial Population**
   - On first run: full file scan to populate DB
   - Track last sync timestamp per workspace
   - Incremental sync on subsequent runs

4. **Query Migration**
   - Update `src/routes/*.ts` to query DB instead of file scans
   - Fallback to file scanning if DB query fails
   - Keep file-based scanners for backup/testing

### Files to Create/Modify
- `src/db/interface.ts` - Database operations interface
- `src/db/sqlite.ts` - SQLite implementation
- `src/db/migrations.ts` - Schema versioning
- `src/db/query-builder.ts` - Type-safe query builder
- `src/db/watchers/job-watcher.ts` - Watch job output files
- `src/db/watchers/session-watcher.ts` - Watch session files
- `src/db/watchers/chain-watcher.ts` - Watch chain files
- `src/db/sync.ts` - Initial population + incremental sync
- `src/config.ts` - Add DB configuration options
- `src/routes/*.ts` - Update to query DB instead of file scans
- `src/constants.ts` - Add DB_PATH constant

### Configuration
```typescript
// .env additions
DB_ENABLED=true
DB_TYPE=sqlite  # or 'postgres'
DB_PATH=.agenthq.db  # SQLite file path
# DB_URL=postgres://...  # PostgreSQL connection string
```

---

## Feature 3: Advanced Analytics & Metrics

### Problem Statement
Current dashboard shows only basic metrics:
- Job counts and statuses
- Session message counts
- No performance trends, cost analysis, or bottleneck identification
- No predictive insights or anomaly detection
- Difficult to optimize agent workflows without visibility into what's slow/expensive

### Proposed Solution
Build comprehensive analytics system leveraging database persistence to track:
1. **Performance metrics** - Duration trends, throughput, percentiles
2. **Cost analysis** - Token usage, API costs, efficiency metrics
3. **Bottleneck detection** - Identify slow tools, resource contention
4. **Predictive analytics** - Estimate completion times, success probability
5. **Anomaly detection** - Alert on unusual patterns

### Key Requirements
1. **Real-time computation** - Metrics update as jobs complete
2. **Historical trends** - 24h, 7d, 30d views
3. **Per-workspace analytics** - Filter metrics by workspace
4. **Drill-down capability** - Click metric to see underlying data
5. **Export functionality** - CSV/JSON export for external analysis
6. **Alert system** - Configurable thresholds for anomalies
7. **Visual dashboard** - Charts, graphs, heatmaps
8. **Comparison views** - Compare workspaces, time periods

### Analytics Types & Interfaces

#### 1. Performance Analytics
```typescript
interface PerformanceMetrics {
  timeRange: '24h' | '7d' | '30d';
  workspaceId?: string;
  
  // Execution times
  avgDurationMs: number;
  medianDurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  
  // Throughput
  jobsPerHour: number;
  jobsPerDay: number;
  messagesPerSession: number;
  
  // Success rates
  totalJobs: number;
  successfulJobs: number;
  failedJobs: number;
  successRate: number; // 0-1
  
  // Trends
  durationTrend: Array<{ date: string; avgMs: number }>;
  throughputTrend: Array<{ date: string; jobCount: number }>;
  
  // Comparison
  vsLastPeriod: {
    durationChange: number; // -10 means 10% faster
    throughputChange: number;
    successRateChange: number;
  };
}
```

#### 2. Cost Analytics
```typescript
interface CostMetrics {
  timeRange: '24h' | '7d' | '30d';
  workspaceId?: string;
  
  // Token usage
  totalInputTokens: number;
  totalOutputTokens: number;
  avgTokensPerJob: number;
  
  // Costs
  totalCostUsd: number;
  costPerJob: number;
  costPerSuccessfulJob: number;
  projectedMonthlyCost: number;
  
  // Model breakdown
  modelUsage: Array<{
    model: string;
    jobCount: number;
    totalCost: number;
    avgCostPerJob: number;
  }>;
  
  // Efficiency
  wastedCostOnErrors: number;
  costByWorkspace: Array<{ workspaceId: string; cost: number }>;
  
  // Trends
  dailyCosts: Array<{ date: string; cost: number }>;
}
```

#### 3. Bottleneck Detection
```typescript
interface BottleneckAnalysis {
  workspaceId?: string;
  
  // Slow operations
  slowestJobs: Array<{
    jobId: string;
    name: string;
    durationMs: number;
    avgForType: number;
    slowdownFactor: number; // how many times slower than avg
  }>;
  
  slowestTools: Array<{
    toolName: string;
    callCount: number;
    totalTimeMs: number;
    avgTimeMs: number;
    percentOfTotalTime: number;
  }>;
  
  // Resource contention
  concurrentJobsPeak: number;
  avgQueueWaitTime: number;
  filesystemLatencyMs: number;
  
  // Recommendations
  recommendations: Array<{
    severity: 'high' | 'medium' | 'low';
    issue: string;
    impact: string;
    suggestion: string;
  }>;
}
```

#### 4. Predictive Analytics
```typescript
interface PredictiveMetrics {
  // For running jobs
  jobId?: string;
  
  estimatedCompletionTime?: string; // ISO timestamp
  estimatedRemainingSeconds?: number;
  confidenceScore: number; // 0-1
  
  // Success prediction
  probabilityOfSuccess: number; // 0-1
  riskFactors: string[];
  
  // Anomaly detection
  isAnomalous: boolean;
  anomalyScore: number; // 0-100
  anomalyReasons: string[];
  
  // Capacity planning
  recommendedMaxConcurrentJobs: number;
  estimatedDailyCapacity: number;
  currentUtilization: number; // 0-1
}
```

### SQL Queries for Analytics

#### Performance Metrics Query
```sql
-- Job duration statistics
SELECT 
  DATE(timestamp) as date,
  COUNT(*) as total_jobs,
  AVG(jm.duration_ms) as avg_duration_ms,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY jm.duration_ms) as p50,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY jm.duration_ms) as p95,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY jm.duration_ms) as p99,
  SUM(CASE WHEN j.status = 'done' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate
FROM jobs j
LEFT JOIN job_metrics jm ON j.id = jm.job_id
WHERE j.workspace_id = ?
  AND j.timestamp > datetime('now', '-7 days')
GROUP BY DATE(timestamp)
ORDER BY date DESC;
```

#### Cost Analysis Query
```sql
-- Daily cost breakdown by model
SELECT 
  DATE(j.timestamp) as date,
  j.agent as model,
  COUNT(*) as job_count,
  SUM(jm.total_tokens) as total_tokens,
  SUM(jm.cost_usd) as total_cost,
  AVG(jm.cost_usd) as avg_cost_per_job
FROM jobs j
JOIN job_metrics jm ON j.id = jm.job_id
WHERE j.workspace_id = ?
  AND j.timestamp > datetime('now', '-30 days')
GROUP BY DATE(j.timestamp), j.agent
ORDER BY date DESC, total_cost DESC;
```

#### Bottleneck Detection Query

**CRITICAL FIX:** SQLite does NOT support `PERCENTILE_CONT` or `STDDEV`. Use window functions instead:

```sql
-- Identify jobs taking significantly longer than average for their type
WITH avg_by_type AS (
  SELECT 
    j.type,
    AVG(jm.duration_ms) as avg_duration,
    MAX(jm.duration_ms) as max_duration
  FROM jobs j
  JOIN job_metrics jm ON j.id = jm.job_id
  WHERE j.workspace_id = ?
  GROUP BY j.type
),
median_by_type AS (
  SELECT 
    type,
    duration_ms as median_duration
  FROM (
    SELECT 
      j.type,
      jm.duration_ms,
      ROW_NUMBER() OVER (PARTITION BY j.type ORDER BY jm.duration_ms) as rn,
      COUNT(*) OVER (PARTITION BY j.type) as cnt
    FROM jobs j
    JOIN job_metrics jm ON j.id = jm.job_id
    WHERE j.workspace_id = ?
  )
  WHERE rn = CAST(cnt * 0.5 AS INTEGER)
)
SELECT 
  j.id,
  j.name,
  j.type,
  jm.duration_ms,
  a.avg_duration,
  a.median_duration,
  jm.duration_ms / NULLIF(a.avg_duration, 1) as slowdown_factor
FROM jobs j
JOIN job_metrics jm ON j.id = jm.job_id
JOIN avg_by_type a ON j.type = a.type
LEFT JOIN median_by_type m ON j.type = m.type
WHERE j.workspace_id = ?
  AND jm.duration_ms > a.avg_duration * 2  -- At least 2x slower
ORDER BY slowdown_factor DESC
LIMIT 20;
```

**Alternative (simpler):** Use `ntile()` window function for percentiles:
```sql
SELECT MAX(duration_ms) as p95
FROM (
  SELECT duration_ms, ntile(100) OVER (ORDER BY duration_ms) as percentile
  FROM job_metrics
)
WHERE percentile <= 95;
```

### Technical Approach
1. **Analytics Engine** (`src/analytics/`)
   - `engine.ts` - Core analytics computation
   - `performance.ts` - Performance metrics calculator
   - `cost.ts` - Cost analysis engine
   - `bottleneck.ts` - Bottleneck detector
   - `predictive.ts` - Predictive analytics (basic ML)
   - `cache.ts` - Cache computed metrics (TTL)

2. **API Endpoints** (`src/routes/analytics.ts`)
   - `GET /api/analytics/performance?workspace=X&range=7d`
   - `GET /api/analytics/cost?workspace=X&range=30d`
   - `GET /api/analytics/bottlenecks?workspace=X`
   - `GET /api/analytics/predictions?jobId=X`
   - `GET /api/analytics/export?type=csv&metrics=performance,cost`

3. **Dashboard Integration** (`src/dashboard/pages/analytics.ts`)
   - New "Analytics" tab in navigation
   - Chart library integration (Chart.js or D3.js - lightweight)
   - Real-time metric updates via WebSocket
   - Interactive drill-down (click chart → see job list)

4. **Alert System** (`src/analytics/alerts.ts`)
   - Configurable thresholds (duration > X, cost > Y)
   - Alert history tracking in DB
   - WebSocket push notifications to dashboard
   - Optional email/webhook notifications (future)

### Files to Create/Modify
- `src/analytics/engine.ts` - Core analytics computation
- `src/analytics/performance.ts` - Performance metrics
- `src/analytics/cost.ts` - Cost analysis
- `src/analytics/bottleneck.ts` - Bottleneck detection
- `src/analytics/predictive.ts` - Predictive analytics
- `src/analytics/alerts.ts` - Alert system
- `src/analytics/cache.ts` - Metrics caching
- `src/routes/analytics.ts` - Analytics API endpoints
- `src/dashboard/pages/analytics.ts` - Analytics dashboard page
- `src/dashboard/components/charts.ts` - Chart components
- `src/types.ts` - Add analytics types
- `package.json` - Add chart library dependency

### Chart Library Recommendation
**Chart.js** - Lightweight, simple API, good for AgentHQ needs:
```typescript
// Example: Performance trend chart
import Chart from 'chart.js/auto';

const ctx = document.getElementById('performanceChart');
new Chart(ctx, {
  type: 'line',
  data: {
    labels: metrics.durationTrend.map(d => d.date),
    datasets: [{
      label: 'Avg Duration (ms)',
      data: metrics.durationTrend.map(d => d.avgMs),
      borderColor: 'rgb(75, 192, 192)',
      tension: 0.1
    }]
  }
});
```

---

## Implementation Phases

### Phase 5.1: Database Foundation (Priority: High)
**Goal:** Establish database persistence layer
**Duration:** ~3-5 days

**Tasks:**
1. Design and implement database schema (SQLite)
2. Create database abstraction layer with interface
3. Implement SQLite adapter using `bun:sqlite`
4. Build migration system for schema versioning
5. Create initial population script (scan files → DB)
6. Add file system watchers for incremental updates
7. Update configuration to enable/disable DB
8. Write unit tests for DB operations
9. Migration guide for existing deployments

**Success Criteria:**
- Database populated from existing files on first run
- File changes reflected in DB within 1 second
- All existing queries work through DB layer
- 10x faster query response times for filtered/sorted requests
- Fallback to file scanning if DB unavailable
- **Monitor metrics:** writes/sec, queue depth, corruption events
- **Migration trigger:** IF (writes > 50/sec OR queue_depth > 100 OR corruption > 0) THEN migrate to PostgreSQL

### Phase 5.2: WebSocket Infrastructure (Priority: High)
**Goal:** Replace SSE with WebSocket for bidirectional communication
**Duration:** ~2-4 days

**Tasks:**
1. Design WebSocket message protocol
2. Implement WebSocket server with Bun.serve upgrade
3. Create connection manager for client tracking
4. Build subscription manager for selective broadcasting
5. Implement command handlers (cancel, pause, resume, commit)
6. Add client-side WebSocket client with reconnection
7. Maintain SSE endpoint for backward compatibility
8. Add heartbeat/ping-pong mechanism
9. Write integration tests for WebSocket flows

**Success Criteria:**
- Clients can subscribe to specific workspaces/chains
- Commands execute and respond within 100ms
- Reconnection works transparently after connection drop
- Multiple clients see each other's actions in real-time
- No breaking changes to existing SSE clients

### Phase 5.3: Core Analytics Engine (Priority: Medium)
**Goal:** Implement performance and cost analytics
**Duration:** ~3-5 days

**Tasks:**
1. Design analytics interfaces (PerformanceMetrics, CostMetrics, etc.)
2. Implement analytics engine with SQL query builders
3. Build performance metrics calculator
4. Build cost analysis engine
5. Create analytics API endpoints
6. Add metrics caching layer (5-minute TTL)
7. Implement export functionality (CSV/JSON)
8. Write unit tests for analytics calculations
9. Add analytics to types.ts

**Success Criteria:**
- Performance metrics computed accurately from job data
- Cost analysis shows breakdown by model and workspace
- API responds with metrics within 200ms (cached)
- Export generates valid CSV/JSON files
- Metrics update in real-time as jobs complete

### Phase 5.4: Analytics Dashboard (Priority: Medium)
**Goal:** Build visual analytics dashboard page
**Duration:** ~2-3 days

**Tasks:**
1. Add Chart.js dependency
2. Create analytics dashboard page layout
3. Build chart components (line, bar, pie)
4. Implement time range selector (24h/7d/30d)
5. Add workspace filter integration
6. Create drill-down views (click chart → job list)
7. Add real-time chart updates via WebSocket
8. Style analytics page to match existing design
9. Add responsive layout for mobile

**Success Criteria:**
- Analytics page loads within 500ms
- Charts render correctly with real data
- Time range and workspace filters work
- Real-time updates reflect new jobs immediately
- Drill-down shows underlying data correctly

### Phase 5.5: Advanced Analytics (Priority: Low)
**Goal:** Add bottleneck detection and predictive analytics
**Duration:** ~3-4 days

**Tasks:**
1. Implement bottleneck detection algorithm
2. Build slowest jobs/tools analysis
3. Create anomaly detection (basic statistical)
4. Implement predictive completion time estimator
5. Build alert system with configurable thresholds
6. Add alert history tracking to database
7. Create alerts dashboard widget
8. Add WebSocket notifications for alerts
9. Write documentation for analytics features

**Success Criteria:**
- Bottlenecks identified correctly (>2x slower than avg)
- Anomaly detection flags unusual jobs (>3 std dev)
- Completion time estimates within 20% accuracy
- Alerts trigger when thresholds exceeded
- Alert history persisted and queryable

---

## Testing Strategy

### Unit Tests
- Database operations (insert, update, query, delete)
- Analytics calculations (performance, cost, bottleneck)
- WebSocket message parsing and validation
- Subscription manager logic
- Metrics caching and invalidation

### Integration Tests
- Full WebSocket flow (connect → subscribe → command → response)
- Database population from files
- File watcher → DB update → WebSocket broadcast
- Analytics API endpoints with real data
- Chart rendering with mock data

### Performance Tests
- Database query performance (should be <50ms for filtered queries)
- WebSocket broadcast latency (should be <100ms)
- Analytics computation time (should be <200ms cached)
- File watcher responsiveness (should update DB within 1s)

### Load Tests
- 100+ concurrent WebSocket connections
- 10,000+ jobs in database
- 1,000+ file changes per minute
- Multiple workspaces with heavy activity

---

## Configuration Changes

### New Environment Variables
```bash
# Database settings
DB_ENABLED=true
DB_TYPE=sqlite  # or 'postgres'
DB_PATH=.agenthq.db
# DB_URL=postgres://user:pass@host:port/dbname

# Analytics settings
ANALYTICS_ENABLED=true
ANALYTICS_CACHE_TTL=300  # seconds
ANALYTICS_ALERT_ENABLED=true

# WebSocket settings
WS_ENABLED=true
WS_HEARTBEAT_INTERVAL=30  # seconds
WS_RECONNECT_DELAY=5  # seconds
```

### Updated workspaces.json (no changes required)
Database and analytics work with existing workspace configuration.

---

## Migration & Rollout Plan

### Phase 5.1 Rollout (Database)
1. Deploy with `DB_ENABLED=false` initially
2. Run initial population script offline
3. Verify database content matches file scans
4. Enable `DB_ENABLED=true` with fallback to files
5. Monitor query performance for 24h
6. Gradually remove file-based query paths

### Phase 5.2 Rollout (WebSocket)
1. Deploy WebSocket alongside existing SSE
2. Add feature flag in dashboard for WebSocket
3. Test with small group of users
4. Monitor connection stability and latency
5. Gradually roll out to all users
6. Keep SSE for read-only/legacy clients

### Phase 5.3-5.5 Rollout (Analytics)
1. Deploy analytics API endpoints (disabled in UI)
2. Verify metric calculations are accurate
3. Add analytics page behind feature flag
4. Enable for testing workspace only
5. Collect feedback and iterate
6. Enable globally once stable

---

## Success Metrics

### Database Persistence
- Query latency reduced by 10x (from ~500ms to ~50ms)
- CPU usage reduced by 50% (less file scanning)
- Support 100,000+ jobs without performance degradation
- Zero data loss during file → DB sync

### WebSocket Communication
- 99.9% connection uptime
- <100ms command response time
- Support 100+ concurrent connections per server
- <5s reconnection time after network interruption

### Analytics & Metrics
- 95% accuracy on completion time predictions
- Identify 80%+ of bottlenecks correctly
- Cost tracking within 5% of actual API costs
- Alert false positive rate <10%

---

## Dependencies & Prerequisites

### New Dependencies (package.json)
```json
{
  "dependencies": {
    "@openrouter/agent": "latest",
    "dotenv": "^17.4.2",
    "zod": "latest",
    "chart.js": "^4.4.0"  // NEW: For analytics charts
  },
  "devDependencies": {
    "@types/bun": "latest",
    "fast-check": "^4.8.0",
    "typescript": "latest",
    "@types/chart.js": "^2.9.41"  // NEW
  }
}
```

### Bun Built-in Modules Used
- `bun:sqlite` - SQLite database (zero-config)
- `Bun.serve` WebSocket upgrade - Native WebSocket support
- `Bun.file` - File system operations
- `Bun.Glob` - File pattern matching
- `Bun.watch` - File system watching (future: may use fs.watch instead)

### No External Services Required
- SQLite is embedded (single file database)
- No Redis, Memcached, or external cache needed
- No message queue required (WebSocket is the queue)
- Optional: PostgreSQL for production (user-provided)

---

## Risk Assessment & Mitigation

### Risk 1: Database Migration Complexity
**Impact:** High | **Probability:** Medium
**Mitigation:**
- Comprehensive testing with production-sized datasets
- Fallback to file-based queries if DB fails
- Staged rollout with feature flag
- Backup/restore procedures documented

### Risk 2: WebSocket Connection Stability
**Impact:** Medium | **Probability:** Medium
**Mitigation:**
- Automatic reconnection with exponential backoff
- SSE fallback for read-only clients
- Heartbeat mechanism to detect dead connections
- Connection pool limits to prevent resource exhaustion

### Risk 3: Analytics Performance Impact
**Impact:** Medium | **Probability:** Low
**Mitigation:**
- Aggressive caching (5-minute TTL)
- Async computation (don't block API requests)
- Query optimization with proper indexes
- Rate limiting on analytics endpoints

### Risk 4: Data Inconsistency (File vs DB)
**Impact:** High | **Probability:** Low
**Mitigation:**
- Files remain source of truth
- DB is always derived from files
- Reconciliation job runs nightly
- Admin endpoint to force full resync

---

## Future Enhancements (Out of Scope for Phase 5)

### Authentication & Authorization
- User accounts with role-based access control
- Workspace-level permissions
- API key management for programmatic access
- Audit log for all actions

### Distributed Monitoring
- Monitor agents across multiple machines
- Central AgentHQ server aggregating multiple instances
- Cross-workspace analytics
- Cluster management

### Advanced ML/AI Features
- Deep learning models for better predictions
- Natural language queries ("show me slow jobs from yesterday")
- Automatic root cause analysis
- Recommendation engine for optimization

### Integration Ecosystem
- Slack/Teams notifications for alerts
- Jira/GitHub issue creation from failures
- Prometheus metrics export
- Grafana dashboard templates
- OpenTelemetry integration

---

## Documentation Requirements

### User Documentation
- `docs/database-setup.md` - Database configuration and migration
- `docs/websocket-api.md` - WebSocket protocol specification
- `docs/analytics-guide.md` - Understanding analytics metrics
- `docs/troubleshooting.md` - Common issues and solutions
- Update `README.md` with new features

### Developer Documentation
- `docs/database-schema.md` - Complete schema with examples
- `docs/architecture.md` - System architecture diagrams
- `docs/contributing.md` - How to add new analytics metrics
- `src/db/README.md` - Database module documentation
- `src/websocket/README.md` - WebSocket module documentation
- `src/analytics/README.md` - Analytics engine documentation

### API Documentation
- OpenAPI/Swagger spec for analytics endpoints
- WebSocket message reference
- Code examples for common operations
- Postman collection for testing

---

## Deliverables Checklist

### Phase 5.1: Database Persistence
- [ ] Database schema (SQLite + PostgreSQL)
- [ ] Database abstraction interface
- [ ] SQLite implementation
- [ ] Migration system
- [ ] Initial population script
- [ ] File watchers for incremental sync
- [ ] Configuration integration
- [ ] Unit tests (>80% coverage)
- [ ] Integration tests
- [ ] Performance benchmarks
- [ ] Migration guide document

### Phase 5.2: WebSocket Infrastructure
- [ ] WebSocket message protocol design
- [ ] WebSocket server implementation
- [ ] Connection manager
- [ ] Subscription manager
- [ ] Command handlers (cancel, pause, resume, commit)
- [ ] Client-side WebSocket client
- [ ] Reconnection logic
- [ ] Heartbeat mechanism
- [ ] SSE backward compatibility
- [ ] Integration tests
- [ ] API documentation

### Phase 5.3: Core Analytics Engine
- [ ] Analytics type definitions
- [ ] Performance metrics calculator
- [ ] Cost analysis engine
- [ ] Analytics API endpoints
- [ ] Metrics caching layer
- [ ] Export functionality (CSV/JSON)
- [ ] Unit tests
- [ ] API documentation
- [ ] Example queries

### Phase 5.4: Analytics Dashboard
- [ ] Chart.js integration
- [ ] Analytics page layout
- [ ] Chart components (line, bar, pie)
- [ ] Time range selector
- [ ] Workspace filter integration
- [ ] Drill-down views
- [ ] Real-time updates
- [ ] Responsive design
- [ ] User guide

### Phase 5.5: Advanced Analytics
- [ ] Bottleneck detection algorithm
- [ ] Anomaly detection
- [ ] Predictive completion estimator
- [ ] Alert system
- [ ] Alert history tracking
- [ ] Alerts dashboard widget
- [ ] WebSocket alert notifications
- [ ] Configuration interface
- [ ] Advanced analytics guide

---

## Questions for Spec Session

### Scope & Prioritization
1. Should all three features (WebSocket, DB, Analytics) be included in Phase 5, or split across multiple phases?
2. Which phase should be delivered first? (Recommendation: DB → WebSocket → Analytics)
3. Is PostgreSQL support required for MVP, or can it be added later?

### Database Design
1. Should job metrics (duration, tokens, cost) be stored for every job, or only when available?
2. How long should historical data be retained? (30d? 90d? Forever?)
3. Should we implement soft deletes or hard deletes when files are removed?
4. Do we need audit logging for database modifications?

### WebSocket Features
1. What agent control commands are most critical? (cancel, pause, resume, restart?)
2. Should we support private messages between specific users?
3. Do we need rate limiting on WebSocket commands?
4. Should WebSocket connections require authentication tokens?

### Analytics Priorities
1. Which analytics metrics are most valuable? (performance? cost? both?)
2. Should we track tool-level metrics (how long each tool call takes)?
3. Is anomaly detection required for MVP, or can it be a follow-up?
4. What alert delivery mechanisms are needed? (WebSocket only? Email? Slack?)

### Integration & Compatibility
1. Are there any existing monitoring/logging systems we need to integrate with?
2. Should we maintain full backward compatibility with file-based scanning?
3. Do we need to support SQLite + PostgreSQL simultaneously (multi-tenancy)?
4. Should analytics be exportable to external BI tools (Tableau, Power BI)?

### Operational Concerns
1. What's the expected scale? (number of workspaces, jobs per day, concurrent users)
2. Are there any deployment constraints? (Docker, VM, serverless, etc.)
3. Do we need high availability / failover support?
4. What's the disaster recovery strategy? (backups, restore procedures)

---

## Technical Constraints & Assumptions

### Assumptions
1. Bun runtime is available and will remain the primary runtime
2. Users have write access to the AgentHQ directory (for SQLite file)
3. Filesystem is reliable and not subject to corruption
4. Network latency between client and server is <100ms
5. Concurrent user count is <100 per instance
6. Total job count is <1 million per workspace

### Constraints
1. Must work on Windows (primary development environment)
2. Must be cross-platform (Linux, macOS as secondary targets)
3. No external dependencies beyond npm packages
4. Zero-config for basic setup (SQLite, no complex installation)
5. Maintain existing .env + workspaces.json configuration approach
6. No breaking changes to existing API endpoints

---

## Appendix: Example User Flows

### Flow 1: Developer Cancels Long-Running Job
1. Developer opens AgentHQ dashboard
2. Sees job "analyze-performance" running for 45 minutes
3. Clicks "Cancel" button on job card
4. WebSocket sends `{ type: 'cancel-job', jobId: '...', workspaceId: '...' }`
5. Server validates request and terminates agent process
6. Server broadcasts job status update to all subscribed clients
7. Dashboard immediately shows job status as "cancelled"
8. Developer receives confirmation toast notification

### Flow 2: Analytics Identifies Bottleneck
1. Developer navigates to Analytics tab
2. Selects "scottish-water" workspace and "7d" time range
3. Dashboard queries `/api/analytics/bottlenecks?workspace=scottish-water`
4. Server computes bottleneck analysis from database
5. Chart shows "grep_search" tool taking 80% of total time
6. Developer clicks chart bar to drill down
7. Dashboard shows list of jobs using grep_search with durations
8. Developer identifies pattern: searching large unindexed directories
9. Developer optimizes queries or adds caching

### Flow 3: Real-Time Cost Monitoring
1. Project manager opens dashboard at start of work day
2. WebSocket connects and subscribes to cost updates
3. As team runs agents, cost metrics update in real-time
4. Dashboard shows: $12.50 spent today, $3.20 projected remaining
5. Alert triggers when daily budget threshold (90%) reached
6. WebSocket pushes alert notification to all connected users
7. Dashboard shows warning banner with current spend and recommendations
8. Manager reviews expensive jobs and adjusts agent workflows

### Flow 4: Database Migration from Files
1. Admin stops AgentHQ server
2. Runs migration script: `bun run src/db/migrate.ts`
3. Script scans all workspace files and populates database
4. Progress shown: "Processing workspace 1/3... 500/1000 jobs"
5. Migration completes, validation runs automatically
6. Report generated: "Migrated 3 workspaces, 2,431 jobs, 156 chains, 892 sessions"
7. Admin verifies sample queries return correct data
8. Admin enables `DB_ENABLED=true` in .env
9. Server starts with database-backed queries
10. Dashboard loads 10x faster, all features work as before

---

## Success Criteria Summary

### Database Persistence
✅ Query response time reduced by 10x (500ms → 50ms)  
✅ Support 100,000+ jobs without performance degradation  
✅ File changes reflected in database within 1 second  
✅ Zero data loss during file synchronization  
✅ Fallback to file scanning works if database unavailable  

### WebSocket Communication
✅ Command response time <100ms (cancel, pause, resume)  
✅ Support 100+ concurrent connections per instance  
✅ Automatic reconnection within 5 seconds after disconnect  
✅ Multiple users see real-time updates simultaneously  
✅ SSE endpoint remains available for backward compatibility  

### Analytics & Metrics
✅ Performance metrics computed accurately (±5% error)  
✅ Cost tracking within 5% of actual API costs  
✅ Bottleneck detection identifies 80%+ of slow operations  
✅ Completion time predictions within 20% accuracy  
✅ Alert false positive rate <10%  
✅ Analytics dashboard loads within 500ms  
✅ Charts update in real-time as jobs complete  

---

## Glossary

**SSE (Server-Sent Events):** Unidirectional HTTP-based protocol for server→client streaming  
**WebSocket:** Bidirectional full-duplex protocol over TCP  
**TTL (Time To Live):** Cache expiration time  
**P50/P95/P99:** Performance percentiles (50th, 95th, 99th)  
**Anomaly Score:** Statistical measure of how unusual a data point is (Z-score)  
**Bottleneck:** Component or operation that limits overall system performance  
**Soft Delete:** Mark records as deleted without removing from database  
**ACID:** Atomicity, Consistency, Isolation, Durability (database transaction properties)  
**Drill-down:** Navigate from summary to detailed view by clicking  
**Workspace:** Single Kiro engagement/project with its own sessions and jobs  
**Chain:** Sequence of related sessions grouped by topic/spec  
**Job:** Single agent execution with output and logs  
**Session:** Kiro conversation state snapshot  

---

## References

### Internal Documentation
- `README.md` - AgentHQ overview and quick start
- `docs/multi-workspace-setup.md` - Multi-workspace configuration guide
- `src/types.ts` - Domain type definitions
- `src/scan/` - File scanning implementation
- `src/routes/` - API endpoint implementations

### External Resources
- Bun WebSocket documentation: https://bun.sh/docs/api/websockets
- Bun SQLite documentation: https://bun.sh/docs/api/sqlite
- Chart.js documentation: https://www.chartjs.org/docs/latest/
- WebSocket protocol RFC: https://datatracker.ietf.org/doc/html/rfc6455
- SQLite documentation: https://www.sqlite.org/docs.html

---

**END OF PROMPT**

---

## Instructions for Spec Session Agent

This prompt contains complete context for creating a Kiro spec with:
1. **Requirements document** - Extract from "Key Requirements" sections
2. **Design document** - Extract from "Technical Approach", "Database Schema", and architecture details
3. **Tasks document** - Extract from "Implementation Phases" and deliverables checklist

Create the spec in `.kiro/specs/phase-5-observability-platform/` with comprehensive requirements, detailed design decisions, and actionable tasks for each sub-phase (5.1 through 5.5).
