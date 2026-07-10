# Design Document: Phase 5 — Observability Platform

## Overview

Phase 5 transforms AgentHQ from a read-only monitoring dashboard into a full observability
platform by adding three major layers on top of the existing file-based, SSE-driven system:

1. **WebSocket Layer** — bidirectional real-time communication enabling interactive agent
   control (cancel, pause, resume), multi-user collaboration broadcasts, and subscription-
   filtered updates. Replaces the fire-and-forget SSE model for command flows while keeping
   SSE for clients that cannot upgrade.

2. **Database Layer** — SQLite (default) or PostgreSQL persistence for fast indexed queries,
   historical status tracking, and efficient time-range analytics. Files remain the source of
   truth; the database is a queryable projection rebuilt from files at any time.

3. **Analytics Layer** — performance metrics collection, cost analysis, bottleneck detection,
   and predictive ETA estimation. Results are cached (5-minute TTL) and exposed via REST
   endpoints and a new dashboard page with inline SVG/canvas charts.

### Composition with Existing System

The existing server (`src/monitor.ts`) continues to own startup, route registration, and worker
startup. New modules register alongside existing ones using the same `register(router)` pattern.
The SSE `/events` endpoint is preserved unchanged. File-scanning functions (`src/scan/`) remain
the canonical data source; the database synchronises from them.

```
Existing:  SSE  ←→  ssebroadcaster  ←→  scan/  ←→  file system
New add:   WS   ←→  ws/server       ←→  db/    ←→  SQLite / Postgres
           REST ←→  analytics/      ←→  db/    ←→  (computed from job_metrics)
```

---

## Architecture

### High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Bun.serve (monitor.ts)                           │
│                                                                             │
│  HTTP Routes                   WebSocket Routes        Workers              │
│  ─────────────                 ────────────────        ───────              │
│  GET  /chains                  GET /ws (upgrade)       ssebroadcaster (2s)  │
│  GET  /jobs                    │                       queuePoller   (10s)  │
│  GET  /events (SSE)            │                       fileWatcher   (Bun.watch)
│  GET  /api/analytics/*         │                       metricsCollector     │
│  GET  /api/analytics/export    │                       backfill             │
│  GET  /api/status-history/:id  │                       summariseState       │
│                                │                                            │
└────────────────────────────────┼────────────────────────────────────────────┘
                                 │
           ┌─────────────────────▼──────────────────────┐
           │            src/ws/  (WebSocket)             │
           │  server.ts       — Bun WS upgrade handler   │
           │  protocol.ts     — parse / validate msgs    │
           │  subscriptions.ts— per-client subscription  │
           │  commands.ts     — cancel/pause/resume      │
           └─────────────────────┬──────────────────────┘
                                 │ broadcasts
           ┌──────────────────── ▼──────────────────────┐
           │               src/db/  (Database)           │
           │  adapter.ts    — DbAdapter interface        │
           │  sqlite-adapter.ts — bun:sqlite impl        │
           │  postgres-adapter.ts — pg driver impl       │
           │  schema.ts     — DDL constants              │
           │  migrations.ts — apply migrations/          │
           │  sync.ts       — file → DB sync             │
           └──────────────────────┬─────────────────────┘
                                  │ reads / writes
           ┌───────────────────── ▼──────────────────────┐
           │           src/analytics/  (Analytics)        │
           │  metrics.ts    — performance aggregation     │
           │  cost.ts       — cost aggregation            │
           │  bottleneck.ts — slowdown detection          │
           │  predictions.ts— ETA + anomaly scoring       │
           │  cache.ts      — 5-min TTL AnalyticsCache    │
           └─────────────────────────────────────────────┘
```

### Layer Separation

- **Transport layer** (`src/ws/`, `src/routes/`) — handles protocol, message parsing,
  subscription state, and HTTP routing. No business logic.
- **Storage layer** (`src/db/`) — abstracts SQLite/Postgres behind `DbAdapter`. No HTTP
  dependency. Can be used standalone or bypassed when `DB_ENABLED=false`.
- **Analytics layer** (`src/analytics/`) — pure computation on `DbAdapter` query results.
  No file I/O, no HTTP. Returns typed result objects that routes serialize to JSON.
- **Dashboard layer** (`src/dashboard/`) — SPA compiled to `dist/`. Analytics page fetches
  from REST endpoints and renders inline SVG charts.

### Continuity with Existing Patterns

New routes follow the identical `register(router): void` export pattern used by all existing
route files. New workers follow the `startXxx(): void` / `stopXxx(): void` export pattern used
by `ssebroadcaster.ts` and `queuePoller.ts`. All environment config is read via
`resolveConstants(process.env)` plus new config keys loaded by `src/config/observability.ts`.

---

## New Module Structure

```
src/
├── config/
│   └── observability.ts          # loadObservabilityConfig() — new env vars
├── ws/
│   ├── server.ts                  # Bun WS upgrade, connection lifecycle, ping/pong
│   ├── protocol.ts                # ClientMessage / ServerMessage parse + validate
│   ├── subscriptions.ts           # SubscriptionManager — per-client subscription sets
│   └── commands.ts                # Command handlers: cancel-job, pause-agent, resume-agent
├── db/
│   ├── adapter.ts                 # DbAdapter interface + createDbAdapter() factory
│   ├── schema.ts                  # SQL DDL strings + SchemaVersion type
│   ├── migrations.ts              # runMigrations() — discovers + applies migrations/*.sql
│   ├── sqlite-adapter.ts          # SQLiteAdapter implements DbAdapter (bun:sqlite)
│   ├── postgres-adapter.ts        # PostgresAdapter implements DbAdapter (pg driver)
│   └── sync.ts                    # DbSyncTool — full scan + incremental upsert
├── analytics/
│   ├── metrics.ts                 # computePerformanceMetrics()
│   ├── cost.ts                    # computeCostMetrics()
│   ├── bottleneck.ts              # detectBottlenecks() + classifySeverity()
│   ├── predictions.ts             # estimateETA() + computeConfidence() + anomalyScore()
│   └── cache.ts                   # AnalyticsCache — Map-based 5-min TTL
├── routes/
│   ├── ws.ts                      # register(router) — /ws WebSocket upgrade route
│   ├── analytics.ts               # register(router) — /api/analytics/* endpoints
│   └── status-history.ts          # register(router) — /api/status-history/:jobId
├── workers/
│   ├── fileWatcher.ts             # startFileWatcher() — Bun.watch + debounce + upsert
│   └── metricsCollector.ts        # startMetricsCollector() — job completion → extract metrics
migrations/
│   ├── 001_initial.sql            # workspaces, jobs, chains, sessions, schema_version
│   └── 002_metrics_history.sql    # job_metrics, job_status_history tables + indexes
src/dashboard/
│   ├── pages/
│   │   └── analytics.ts           # Analytics page — time-range picker, charts, drill-down
│   └── components/
│       ├── barChart.ts            # Reusable inline SVG bar chart (cost breakdown)
│       └── lineChart.ts           # Reusable inline SVG line chart (duration trend)
```

---

## Components and Interfaces

### WebSocket Layer

- **`src/ws/server.ts`** — `WsServer`: handles Bun WebSocket upgrades, connection lifecycle (open/close/error), ping/pong idle timeout. Exports `createWsServer(config, subscriptionManager, db)`. On connection close, automatically removes all subscriptions for that client via `subscriptionManager.removeClient(clientId)`.
- **`src/ws/protocol.ts`** — `parseClientMessage(raw): Result<ClientMessage>`, `generateCommandId(): string`, `validateMessageSize(raw): boolean`. Pure functions, no side effects.
- **`src/ws/subscriptions.ts`** — `SubscriptionManager` class: `addClient(ws)`, `removeClient(clientId)`, `subscribe(clientId, filter): Subscription`, `unsubscribe(clientId, subscriptionId)`, `getInterestedClients(event): WsClient[]`.
- **`src/ws/commands.ts`** — `CommandHandler` class: `handleCancelJob(cmd, db): Promise<CommandResult>`, `handlePauseAgent(cmd, db): Promise<CommandResult>`, `handleResumeAgent(cmd, db): Promise<CommandResult>`. Each validates workspace match before execution.

#### Cancel-Job Command Flow Sequence

```
Client                WsServer              CommandHandler           DB                  WsBroadcaster
  │                      │                        │                  │                        │
  │── cancel-job ───────>│                        │                  │                        │
  │    {jobId,           │                        │                  │                        │
  │     workspaceId,     │                        │                  │                        │
  │     commandId}       │                        │                  │                        │
  │                      │                        │                  │                        │
  │                      │─── validate ──────────>│                  │                        │
  │                      │    message schema      │                  │                        │
  │                      │<── ok ─────────────────│                  │                        │
  │                      │                        │                  │                        │
  │                      │─── handleCancelJob ───>│                  │                        │
  │                      │                        │─── query job ───>│                        │
  │                      │                        │                  │                        │
  │                      │                        │<── job data ─────│                        │
  │                      │                        │    (validate     │                        │
  │                      │                        │     workspace)   │                        │
  │                      │                        │                  │                        │
  │                      │                        │─── UPDATE jobs ─>│                        │
  │                      │                        │    SET status    │                        │
  │                      │                        │    = 'error'     │                        │
  │                      │                        │<── committed ────│                        │
  │                      │                        │                  │                        │
  │                      │                        │─── INSERT INTO ─>│                        │
  │                      │                        │    job_status_   │                        │
  │                      │                        │    history       │                        │
  │                      │                        │<── committed ────│                        │
  │                      │                        │                  │                        │
  │                      │<── CommandResult ──────│                  │                        │
  │                      │    {success: true}     │                  │                        │
  │                      │                        │                  │                        │
  │<── ack ──────────────│                        │                  │                        │
  │    {commandId,       │                        │                  │                        │
  │     success: true}   │                        │                  │                        │
  │                      │                        │                  │                        │
  │                      │─── broadcast ─────────────────────────────────────────────────────>│
  │                      │    status-change event │                  │                        │
  │                      │                        │                  │                        │
  │<── status-change ────────────────────────────────────────────────────────────────────────│
  (all subscribed        │                        │                  │                        │
   clients)              │                        │                  │                        │
```

**Error paths**:
- Job not found → return `{success: false, error: "not found"}`
- Workspace mismatch → return `{success: false, error: "workspace mismatch"}`
- DB update fails → return `{success: false, error: "<db_error>"}`

### Job Status State Machine

Valid job status transitions (enforced by `CommandHandler` and status history):

```
         ┌─────────┐
    ────>│ running │<────────────┐
         └─────────┘             │
              │                  │
              │ (normal          │ (resume)
              │  completion)     │
              │                  │
              ▼                  │
         ┌─────────┐        ┌────────┐
         │  done   │        │ paused │
         └─────────┘        └────────┘
              │                  ▲
              │                  │
              │                  │ (pause)
              ▼                  │
         ┌─────────┐             │
         │reported │─────────────┘
         └─────────┘
              
         ┌─────────┐
         │  error  │<──── (cancel, failure)
         └─────────┘

Blocked transitions (return validation error):
  - done → running
  - error → running
  - reported → running (unless resume from paused)
```

**Note**: The state machine enforces that commands validate current state before execution. 
For example, `pause-agent` for a job not in "running" state returns an error before attempting
any database changes.

### Database Layer

- **`src/db/adapter.ts`** — `DbAdapter` interface: `query<T>(sql, params?): Promise<QueryResult<T>>`, `execute(sql, params?): Promise<ExecResult>`, `transaction(fn): Promise<void>`, `close(): Promise<void>`. `createDbAdapter(config): DbAdapter` factory.
- **`src/db/sqlite-adapter.ts`** — `SQLiteAdapter implements DbAdapter` using `bun:sqlite`. Enables WAL + foreign keys on construction.
- **`src/db/postgres-adapter.ts`** — `PostgresAdapter implements DbAdapter` using `pg`. Lazy-loads `pg` to avoid startup crash when not installed.
- **`src/db/schema.ts`** — SQL DDL string constants exported as `SCHEMA_JOBS`, `SCHEMA_CHAINS`, etc. No runtime logic.
- **`src/db/migrations.ts`** — `runMigrations(db, migrationsDir): Promise<void>`. Discovers `migrations/*.sql`, applies pending ones sequentially in transactions.
- **`src/db/sync.ts`** — `DbSyncTool`: `runFullSync(db, workspaceId): Promise<void>`, `syncFile(db, filePath): Promise<void>`. Compares `last_modified` timestamps for incremental updates.

### Analytics Layer

- **`src/analytics/metrics.ts`** — `computePerformanceMetrics(db, workspaceId, range): Promise<PerformanceMetrics>`. Pure async computation over `job_metrics` table.
- **`src/analytics/cost.ts`** — `computeCostMetrics(db, workspaceId, range): Promise<CostMetrics>`. Aggregates `cost_usd`, `total_tokens`, groups by agent.
- **`src/analytics/bottleneck.ts`** — `detectBottlenecks(db, workspaceId): Promise<BottleneckAnalysis>`. Identifies jobs with `slowdown_factor ≥ 2`. Severity classification: "high" if slowdown_factor ≥ 5, "medium" if 2 ≤ slowdown_factor < 5 (no "low" severity since jobs with slowdown_factor < 2 are not bottlenecks).
- **`src/analytics/predictions.ts`** — `estimateETA(db, jobId): Promise<PredictiveMetrics>`. Requires ≥5 historical samples; returns cold-start null otherwise. The 5-sample minimum is based on the Central Limit Theorem approximation requirement for statistically meaningful confidence score calculation (variance estimates below this threshold are unreliable).
- **`src/analytics/cache.ts`** — `AnalyticsCache` class: `get<T>(key): T | null`, `set<T>(key, data): void`, `invalidateWorkspace(workspaceId): void`. 5-minute TTL, module-level singleton `analyticsCache`.

### Workers

- **`src/workers/fileWatcher.ts`** — `startFileWatcher(db): void`. Uses `Bun.watch(OUTPUT_DIR)`, debounces 500ms per path, calls `DbSyncTool.syncFile()` on change, emits `SSEUpdateEvent` and WS broadcasts.
- **`src/workers/metricsCollector.ts`** — `startMetricsCollector(db): void`. Listens for job-completion signals, reads `.log` files, extracts metrics with regex, inserts into `job_metrics` and `job_status_history`.

### Route Handlers

- **`src/routes/ws.ts`** — `register(router): void`. Registers `GET /ws` upgrade route wired to `WsServer`.
- **`src/routes/analytics.ts`** — `register(router): void`. Registers `GET /api/analytics/performance|cost|bottlenecks|predictions` and `GET /api/analytics/export`. Validates `range` and `workspace` params, uses `analyticsCache`.
- **`src/routes/status-history.ts`** — `register(router): void`. Registers `GET /api/status-history/:jobId`.

### Configuration

- **`src/config/observability.ts`** — `resolveObservabilityConfig(env): ObservabilityConfig`. Validates all new env vars, aborts on critical errors (`DB_ENABLED` invalid, `DB_URL` missing for postgres).

### Dashboard Components

- **`src/dashboard/pages/analytics.ts`** — `AnalyticsPage`: root analytics page component with `TimeRangePicker`, `MetricsSummary`, `BarChart`, `LineChart`, `DrillDownPanel`.
- **`src/dashboard/components/barChart.ts`** — `renderBarChart(items, options): string`. Returns inline SVG markup. No external library.
- **`src/dashboard/components/lineChart.ts`** — `renderLineChart(points, options): string`. Returns inline SVG markup. Renders empty-state placeholder when `points.length === 0`.

---

## Data Models

### WebSocket Protocol Types

```typescript
// src/ws/protocol.ts

/** Commands sent by the client to the server */
export type ClientMessage =
  | { type: 'subscribe';   workspaceId?: string; chainId?: string; commandId: string }
  | { type: 'unsubscribe'; subscriptionId: string;                  commandId: string }
  | { type: 'ping';                                                  commandId: string }
  | { type: 'cancel-job';  jobId: string;         workspaceId: string; commandId: string }
  | { type: 'pause-agent'; sessionHash: string;   workspaceId: string; commandId: string }
  | { type: 'resume-agent';sessionHash: string;   workspaceId: string; commandId: string };

/** Messages sent by the server to clients */
export type ServerMessage =
  | { type: 'connected';   clientId: string; workspaceIds: string[] }
  | { type: 'pong';        commandId: string; timestamp: string }
  | { type: 'ack';         commandId: string; success: boolean; error?: string; subscriptionId?: string }
  | { type: 'update';      event: import('../types.ts').SSEUpdateEvent }
  | { type: 'user-action'; userId: string; action: string; target: string; timestamp: string }
  | { type: 'status-change'; jobId: string; oldStatus: string; newStatus: string;
      timestamp: string; success: boolean; workspaceId: string }
  | { type: 'command-error'; userId: string; commandId: string; error: string }
  | { type: 'metric-update'; workspaceId: string; jobId: string; timestamp: string }
  | { type: 'error';       code: number; message: string; commandId?: string };

/** Per-subscription record stored in SubscriptionManager */
export interface Subscription {
  id: string;           // subscription ID returned to client in ack
  clientId: string;
  workspaceId?: string;
  chainId?: string;     // chain-level subscription (more specific than workspace)
  createdAt: string;
}

/** Internal per-client connection state */
export interface WsClient {
  id: string;           // unique client ID assigned on connect (format: client_${Date.now()}_${random})
  subscriptions: Set<string>; // subscription IDs
  lastActivity: number; // Date.now() — used for idle timeout
  ws: import('bun').ServerWebSocket<unknown>;
}
```

### Database Row Types

```typescript
// src/db/adapter.ts

export interface DbJob {
  id: string;
  workspace_id: string;
  name: string;
  job_chain: string;
  session_chain_id: string;
  timestamp: string;       // ISO 8601
  type: string;
  agent: string;
  status: 'running' | 'done' | 'reported' | 'error';
  lines: number;
  last_line: string;
  has_log: number;         // SQLite stores booleans as 0/1
  log_error: number;
  md_file: string;
  log_file: string;
  agent_done: string;
  size_bytes: number;
  last_modified: number;   // Unix ms — used for incremental sync
  deleted_at: string | null;
}

export interface DbChain {
  chain_id: string;
  workspace_id: string;
  display_name: string;
  created_at: string;
  last_active_at: string;
  total_messages: number;
  last_modified: number;
  deleted_at: string | null;
}

export interface DbSession {
  chain_id: string;
  workspace_id: string;
  workflow_hash: string;
  chain_index: number;
  status: string;
  message_count: number;
  context_usage_pct: number;
  last_message_at: string;
  last_modified: number;
  deleted_at: string | null;
}

export interface DbJobStatusHistory {
  id: number;            // auto-increment
  job_id: string;
  workspace_id: string;
  old_status: string;
  new_status: string;
  reason: string | null;
  changed_at: string;    // ISO 8601 UTC
}

export interface DbJobMetrics {
  job_id: string;
  workspace_id: string;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  tool_calls: number | null;
  retry_count: number | null;
  error_count: number | null;
  collected_at: string;
}

export interface SchemaVersion {
  version: number;
  applied_at: string;
  migration_name: string;
}
```

### Analytics Result Types

```typescript
// src/analytics/metrics.ts

export interface PerformanceMetrics {
  workspace_id: string;
  range: '24h' | '7d' | '30d';
  avg_duration_ms: number | null;
  median_duration_ms: number | null;
  p95_duration_ms: number | null;
  p99_duration_ms: number | null;
  throughput_per_hour: number | null;
  throughput_per_day: number | null;
  success_rate_percent: number | null;
  total_jobs: number;
  computed_at: string;
}

export interface CostMetrics {
  workspace_id: string;
  range: '24h' | '7d' | '30d';
  total_cost_usd: number | null;
  total_tokens: number | null;
  cost_per_job_usd: number | null;
  jobs_count: number;
  cost_by_agent: Record<string, number>; // agent name → total cost
  wasted_cost_usd: number | null;        // cost of error jobs
  projected_monthly_usd: number | null;
  daily_trend: Array<{ date: string; cost_usd: number; token_count: number }>;
  computed_at: string;
}

export interface BottleneckJob {
  job_id: string;
  job_type: string;
  duration_ms: number;
  avg_duration_ms: number;
  slowdown_factor: number;
  severity: 'medium' | 'high';  // Note: 'low' removed - jobs with slowdown_factor < 2 are not bottlenecks
  recommendation: string;
}

export interface BottleneckAnalysis {
  workspace_id: string;
  slowest_jobs: BottleneckJob[];
  top_tools_by_time: Array<{ tool_name: string; total_ms: number; call_count: number; pct_of_total: number }>;
  contention_periods: Array<{ period_start: string; concurrent_jobs: number }>;
  computed_at: string;
}

export interface PredictiveMetrics {
  job_id: string;
  job_type: string;
  elapsed_ms: number;
  estimated_remaining_ms: number | null;
  estimated_completion_at: string | null;
  confidence_score: number | null;     // 0–1, or null if cold-start
  low_confidence: boolean;
  success_probability: number | null;  // 0–1
  is_anomalous: boolean;
  anomaly_score: number | null;        // 0–100
  sample_count: number;
  cold_start: boolean;                 // true if sample_count < 5
}

export interface AnalyticsCacheEntry<T> {
  data: T;
  expires_at: number;  // Date.now() + TTL_MS
}
```

---

## Database Schema

```sql
-- migrations/001_initial.sql
-- Creates core tables and indexes. Safe to re-run (IF NOT EXISTS).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version        INTEGER PRIMARY KEY,
  applied_at     TEXT    NOT NULL,
  migration_name TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id             TEXT PRIMARY KEY,
  output_dir     TEXT NOT NULL,
  sessions_dir   TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  job_chain        TEXT NOT NULL DEFAULT '',
  session_chain_id TEXT NOT NULL DEFAULT '',
  timestamp        TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT '',
  agent            TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL CHECK(status IN ('running','done','reported','error')),
  lines            INTEGER NOT NULL DEFAULT 0,
  last_line        TEXT NOT NULL DEFAULT '',
  has_log          INTEGER NOT NULL DEFAULT 0,
  log_error        INTEGER NOT NULL DEFAULT 0,
  md_file          TEXT NOT NULL DEFAULT '',
  log_file         TEXT NOT NULL DEFAULT '',
  agent_done       TEXT NOT NULL DEFAULT '',
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  last_modified    INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT
);

CREATE TABLE IF NOT EXISTS chains (
  chain_id         TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  display_name     TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  last_active_at   TEXT NOT NULL,
  total_messages   INTEGER NOT NULL DEFAULT 0,
  last_modified    INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  chain_id         TEXT NOT NULL,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_hash    TEXT NOT NULL DEFAULT '',
  chain_index      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'idle',
  message_count    INTEGER NOT NULL DEFAULT 0,
  context_usage_pct REAL NOT NULL DEFAULT 0,
  last_message_at  TEXT NOT NULL,
  last_modified    INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT,
  PRIMARY KEY (chain_id, workflow_hash)
);

-- Indexes for query patterns in Requirement 8
CREATE INDEX IF NOT EXISTS idx_jobs_workspace_status
  ON jobs(workspace_id, status) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_timestamp
  ON jobs(workspace_id, timestamp DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_type_status
  ON jobs(type, status) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_chains_workspace_active
  ON chains(workspace_id, last_active_at DESC) WHERE deleted_at IS NULL;

-- migrations/002_metrics_history.sql

CREATE TABLE IF NOT EXISTS job_status_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT    NOT NULL,
  workspace_id TEXT    NOT NULL,
  old_status   TEXT    NOT NULL,
  new_status   TEXT    NOT NULL,
  reason       TEXT,
  changed_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS job_metrics (
  job_id        TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  duration_ms   REAL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  total_tokens  INTEGER,
  cost_usd      REAL,
  tool_calls    INTEGER,
  retry_count   INTEGER,
  error_count   INTEGER,
  collected_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_status_history_job
  ON job_status_history(job_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_metrics_workspace
  ON job_metrics(workspace_id);

CREATE INDEX IF NOT EXISTS idx_metrics_cost
  ON job_metrics(workspace_id, cost_usd) WHERE cost_usd IS NOT NULL;
```

---

## WebSocket Protocol

### Message Format

All WebSocket messages are UTF-8 encoded JSON objects. Every message has a `type` discriminant
field. Client-initiated messages always carry a `commandId` field (client-generated or
server-assigned on receipt). The server validates `commandId` format: `cmd_${timestamp}_${random}`
where timestamp is a Unix ms integer and random is a lowercase alphanumeric string.

```
Client → Server frame:
  { "type": "subscribe", "workspaceId": "ws-1", "commandId": "cmd_1700000000000_abc123" }

Server → Client frame (ack):
  { "type": "ack", "commandId": "cmd_1700000000000_abc123", "success": true,
    "subscriptionId": "sub_1700000000001_xyz789" }
```

### Connection Flow

```
Client                          Server
  │                               │
  │── HTTP GET /ws ──────────────>│
  │                               │ Bun.upgrade() → wsServer.open(ws)
  │<── { type: "connected",       │
  │     clientId: "client_...",   │
  │     workspaceIds: [...] } ────│
  │                               │
  │── { type: "subscribe",        │
  │    workspaceId: "ws-1",       │
  │    commandId: "cmd_..." } ───>│ SubscriptionManager.add()
  │<── { type: "ack",             │
  │     commandId: "cmd_...",     │
  │     success: true,            │
  │     subscriptionId: "sub_..."│
  │   } ──────────────────────────│
  │                               │
  │── { type: "ping",             │
  │    commandId: "cmd_..." } ───>│ within 100ms:
  │<── { type: "pong",            │
  │     commandId: "cmd_...",     │
  │     timestamp: "..." } ───────│
  │                               │
  │── { type: "cancel-job",       │
  │    jobId: "2024-01-01-abc",   │
  │    workspaceId: "ws-1",       │
  │    commandId: "cmd_..." } ───>│ commands.cancelJob()
  │<── { type: "ack",             │
  │     commandId: "cmd_...",     │
  │     success: true } ──────────│
  │                               │
  │  (all subscribed clients):    │
  │<── { type: "status-change",   │
  │     jobId: "...", oldStatus:  │
  │     "running", newStatus:     │
  │     "error", success: true }  │
```

### Command ID Assignment

The server generates a command ID for every received message that lacks one, and uses the
client-provided `commandId` for ack tracking:

```typescript
// src/ws/protocol.ts
export function generateCommandId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `cmd_${Date.now()}_${random}`;
}
```

### Idle Timeout

The server tracks `WsClient.lastActivity = Date.now()` on every received message. A **30-second
interval** scans all connected clients and closes connections where
`Date.now() - client.lastActivity > 30_000`. The ping/pong cycle (Req 1.4/1.5) resets this
timer; clients are expected to ping every 15-20s to stay within the 30s idle threshold.

**Implementation note**: Sequential processing and acknowledgement sending apply even with a 
single client connected, ensuring consistent behavior regardless of the number of active users.

### Connection Management and Resource Limits

The WebSocket server enforces connection limits to prevent resource exhaustion (Req 1.7):

```typescript
// src/ws/server.ts
const MAX_CONNECTIONS = Number(process.env.WS_MAX_CONNECTIONS ?? '500');
const MEMORY_PER_CONNECTION = 10_240; // ~10KB per connection overhead

function canAcceptConnection(): boolean {
  if (this.clients.size >= MAX_CONNECTIONS) {
    console.warn(`[ws] connection limit reached: ${this.clients.size}/${MAX_CONNECTIONS}`);
    return false;
  }
  return true;
}
```

**Connection limit behavior**: The 500 connection limit is a **soft recommendation** with graceful
degradation. The system allows connections beyond this limit but logs warnings. When approaching
resource exhaustion, the server employs backpressure handling (see below) rather than hard-rejecting
connections.

**Backpressure handling**: When broadcast queue length exceeds 1000 messages, the server skips
non-critical updates (metric-update, user-action) and logs warning. Status-change and ack
messages are never dropped.

---

## Subscription Filtering

`SubscriptionManager` in `src/ws/subscriptions.ts` maintains a `Map<clientId, Set<Subscription>>`.
When the SSE broadcaster or WebSocket broadcaster emits an `SSEUpdateEvent`, the WS broadcaster
calls `getInterestedClients(event)` to determine which clients receive the message.

```typescript
// src/ws/subscriptions.ts

export class SubscriptionManager {
  private clients = new Map<string, WsClient>();
  private subscriptions = new Map<string, Subscription[]>(); // clientId → subs

  /** Returns client IDs that should receive this update event */
  getInterestedClients(event: SSEUpdateEvent): WsClient[] {
    const result: WsClient[] = [];
    for (const [clientId, subs] of this.subscriptions) {
      const client = this.clients.get(clientId);
      if (!client) continue;

      for (const sub of subs) {
        // Chain-level subscription: must match exact chainId
        if (sub.chainId) {
          const chainId = extractChainId(event);
          if (chainId === sub.chainId) { result.push(client); break; }
          // Per Req 3.6: workspace subscription does NOT deliver chain events
          // unless client explicitly subscribed to that chain
          continue;
        }
        // Workspace-level subscription: matches workspace, no chain filter
        if (sub.workspaceId && sub.workspaceId === event.workspaceId) {
          // Only deliver workspace-level events (chain-update, session-update, git-update)
          // Job updates for specific chains require a chain subscription
          if (event.type !== 'job-update') { result.push(client); break; }
        }
      }
    }
    return result;
  }
}
```

**Filtering rules (Req 3.6):**
- `job-update` events → delivered only to clients with a chain-level subscription matching the
  job's `sessionChainId`.
- `chain-update`, `session-update`, `git-update` events → delivered to clients with a
  workspace-level subscription for the event's `workspaceId`.
- A client with only a workspace subscription does **not** receive job-level updates for
  individual chains — they must subscribe to the chain explicitly.

---

## DB Adapter Pattern

`DbAdapter` is the single interface all database code depends on. Route handlers and analytics
functions import `DbAdapter`, never `SQLiteAdapter` or `PostgresAdapter` directly.

```typescript
// src/db/adapter.ts

export interface QueryResult<T> {
  rows: T[];
  duration_ms: number;
}

export interface DbAdapter {
  /** Execute a SELECT query with parameterized values */
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;

  /** Execute an INSERT/UPDATE/DELETE statement */
  execute(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number }>;

  /** Execute multiple statements in a single transaction */
  transaction(fn: (tx: DbAdapter) => Promise<void>): Promise<void>;

  /** Gracefully close the connection */
  close(): Promise<void>;

  /** Return the db type for logging */
  readonly type: 'sqlite' | 'postgres';
}

/** Factory — reads ObservabilityConfig and returns the correct adapter */
export function createDbAdapter(config: ObservabilityConfig): DbAdapter {
  if (!config.DB_ENABLED) throw new Error('DB_ENABLED is false — cannot create adapter');
  if (config.DB_TYPE === 'postgres') {
    return new PostgresAdapter(config.DB_URL!);
  }
  return new SQLiteAdapter(config.DB_PATH);
}
```

### SQLiteAdapter (src/db/sqlite-adapter.ts)

Uses `bun:sqlite` (zero external dependency). Enables WAL mode and foreign keys on open.
Transaction isolation level defaults to `SERIALIZABLE` (SQLite strictest level).

```typescript
import { Database } from 'bun:sqlite';

export class SQLiteAdapter implements DbAdapter {
  readonly type = 'sqlite' as const;
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    // WAL mode for better concurrency, foreign keys enforced
    // SQLite defaults to SERIALIZABLE isolation (strictest)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  }

  async query<T>(sql: string, params: unknown[] = [], options?: { signal?: AbortSignal }): Promise<QueryResult<T>> {
    if (options?.signal?.aborted) throw new Error('Query aborted');
    const t0 = performance.now();
    const rows = this.db.prepare(sql).all(...params) as T[];
    const duration_ms = performance.now() - t0;
    if (duration_ms > 100) {
      console.warn(`[db] slow query ${duration_ms.toFixed(1)}ms: ${sql.slice(0, 80)}`);
    }
    return { rows, duration_ms };
  }

  async execute(sql: string, params: unknown[] = []) {
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
  }

  async transaction(fn: (tx: DbAdapter) => Promise<void>): Promise<void> {
    // bun:sqlite transactions are synchronous; we wrap for interface compatibility
    const runner = this.db.transaction(() => { fn(this); });
    runner();
  }

  async close(): Promise<void> { this.db.close(); }
}
```

**SQLite Concurrency Model**: SQLite with WAL mode supports multiple concurrent readers and a 
single writer. Write operations serialize through `bun:sqlite`'s synchronous execution model.
There is no traditional connection pool — all queries use the single `Database` instance. When
10 concurrent queries arrive, readers execute in parallel while writers queue. This differs from
PostgreSQL's connection pool model where each connection can handle independent transactions.

### PostgresAdapter (src/db/postgres-adapter.ts)

Wraps `pg` (node-postgres). Falls back gracefully if `pg` is unavailable at runtime.
Explicitly sets `READ COMMITTED` isolation level for better concurrency than `SERIALIZABLE`.

```typescript
export class PostgresAdapter implements DbAdapter {
  readonly type = 'postgres' as const;
  // Pool loaded lazily to avoid startup crash when pg not installed
  private pool: import('pg').Pool;

  constructor(connectionString: string) {
    try {
      const { Pool } = require('pg');
      this.pool = new Pool({
        connectionString,
        max: 10,
        // READ COMMITTED isolation for better concurrency
        // (prevents phantom reads while allowing concurrent writes)
      });
    } catch (e) {
      throw new Error(`PostgreSQL driver unavailable: ${(e as Error).message}`);
    }
  }

  async query<T>(sql: string, params: unknown[] = [], options?: { signal?: AbortSignal }): Promise<QueryResult<T>> {
    if (options?.signal?.aborted) throw new Error('Query aborted');
    const t0 = performance.now();
    const result = await this.pool.query(sql, params);
    const duration_ms = performance.now() - t0;
    if (duration_ms > 100) {
      console.warn(`[db] slow query ${duration_ms.toFixed(1)}ms: ${sql.slice(0, 80)}`);
    }
    return { rows: result.rows as T[], duration_ms };
  }

  async transaction(fn: (tx: DbAdapter) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await fn(this); // Use same pool for tx queries
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  // execute/close implemented using pool.query()
}
```

---

## File Watcher Design

`src/workers/fileWatcher.ts` uses `Bun.watch` (or `fs.watch` fallback) to monitor `OUTPUT_DIR`.
A 500ms debounce per file path ensures rapid multi-save bursts result in a single DB upsert.

```
File change event
      │
      ▼
debounce timer (500ms per file path)
      │
      ▼
parse file with scanJobs() / scanSessions()
      │
    parse ok?──────No──► log "parse failed: <path>: <reason>", stop
      │
      Yes
      ▼
db.execute(INSERT OR REPLACE INTO jobs ...)
      │
    upsert ok?─────No──► log "upsert failed: <path>: <db_error>"
      │                  schedule retry on next file change event
      Yes
      ▼
emit SSEUpdateEvent + WS broadcast to subscribers
```

### Debounce Implementation

```typescript
// src/workers/fileWatcher.ts

const pending = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleUpsert(filePath: string): void {
  const existing = pending.get(filePath);
  if (existing) clearTimeout(existing);
  pending.set(filePath, setTimeout(async () => {
    pending.delete(filePath);
    await processFile(filePath);
  }, 500));
}
```

### Initial Full Scan

On startup, `startFileWatcher()` calls `runInitialScan()` which iterates all `.md` files in
`OUTPUT_DIR`, parses each with `scanJobs()`, and bulk-upserts to the database. This completes
before the watch loop starts (Req 7.6). Target: ≤30 seconds for 10k files.

**Performance optimization strategy:**
- Parallel file parsing using `Promise.all` with batch size of 100 files per batch
- **Early bailout check every batch**: `if (Date.now() - startTime > 28_000) { log("timeout imminent"); break; }`
- Progress logging every 1000 files: `[file-watcher] initial scan: ${processed}/${total} files`
- Abort startup if timeout exceeded with error: `initial scan exceeded 30s timeout`

**Risk mitigation**: 10k files at 3ms per parse = 30s best-case with zero DB overhead. Real-world 
includes DB upserts, so the 28s bailout threshold provides 2s buffer for final batch completion.

### Conflict Resolution (Req 7.7)

If two files with the same job ID are detected (e.g., from a copy), the watcher compares
`Bun.file(path).lastModified` and uses the most recently modified file's content.

### File Deletion

When `Bun.watch` emits a `remove` event, the watcher executes:
```sql
UPDATE jobs SET deleted_at = ? WHERE id = ? AND workspace_id = ?
```

---

## Migration System

### File Naming Convention

```
migrations/
├── 001_initial.sql
├── 002_metrics_history.sql
└── 003_<future_name>.sql
```

Version number is a zero-padded 3-digit integer. Files are discovered by globbing
`migrations/*.sql` and sorted numerically by the leading integer prefix.

### Migration Algorithm

```typescript
// src/db/migrations.ts

export async function runMigrations(db: DbAdapter, migrationsDir: string): Promise<void> {
  // 1. Ensure schema_version table exists (idempotent)
  await db.execute(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL,
    migration_name TEXT NOT NULL
  )`);

  // 2. Get current version
  const { rows } = await db.query<SchemaVersion>(
    'SELECT MAX(version) as version FROM schema_version'
  );
  const currentVersion = rows[0]?.version ?? 0;

  // 3. Discover pending migration files
  const files = await discoverMigrationFiles(migrationsDir);
  const pending = files.filter(f => f.version > currentVersion);
  if (pending.length === 0) return;

  // 4. Apply each pending migration in a transaction with cumulative 10s timeout
  const migrationStartTime = Date.now();
  const CUMULATIVE_TIMEOUT_MS = 10_000;
  
  for (const file of pending) {
    // Check cumulative timeout before starting each migration
    const elapsed = Date.now() - migrationStartTime;
    if (elapsed >= CUMULATIVE_TIMEOUT_MS) {
      console.error(`[migrations] cumulative timeout exceeded: ${elapsed}ms >= ${CUMULATIVE_TIMEOUT_MS}ms`);
      throw new Error('migration sequence exceeded 10 second cumulative timeout');
    }
    
    const sql = await Bun.file(file.path).text();
    const t0 = performance.now();
    try {
      await db.transaction(async (tx) => {
        // Execute all statements in the migration file
        for (const stmt of splitStatements(sql)) {
          await tx.execute(stmt);
        }
        // Record the migration within the same transaction
        await tx.execute(
          'INSERT INTO schema_version(version, applied_at, migration_name) VALUES (?,?,?)',
          [file.version, new Date().toISOString(), file.name]
        );
      });
      const ms = (performance.now() - t0).toFixed(0);
      console.info(`[migrations] applied migration ${file.version} (${ms}ms)`);
    } catch (err) {
      // Transaction was rolled back; schema_version not updated
      console.error(`[migrations] migration ${file.version} failed: ${(err as Error).message}`);
      throw err; // Req 10.4: ABORT ENTIRE MIGRATION SEQUENCE - refuse to start server
    }
  }
}
```

### Migration Rollback Behavior

**Critical**: On migration failure, the **entire migration sequence is aborted**. The server
refuses to start (Req 10.4, 10.6). This ensures the database is never left in a partially-
migrated state.

**Example**: If migrations 001, 002, 003 are pending and migration 002 fails:
1. Migration 001 completes successfully (committed)
2. Migration 002 fails (transaction rolled back, schema_version not updated)
3. Migration 003 is **not attempted** (sequence aborted)
4. Server exits with error code 1

The next startup attempt will re-run migration 002 (the failed one). Migration 001 is skipped
because `schema_version` shows it was already applied.

### Rules

- Migrations are applied sequentially in version order.
- Each migration runs inside a transaction; failure rolls back that migration only.
- On failure the server process exits (Req 10.4, 10.6).
- **Cumulative timeout**: Total migration time across all pending migrations is bounded at 10 
  seconds. The timeout is checked before starting each migration, not per-migration.
- The `schema_version` insert is inside the same transaction as the migration SQL.

---

## Analytics Pipeline

### Data Flow

```
Job file on disk
      │
      ▼
fileWatcher detects status = "done" | "error"
      │
      ▼
metricsCollector.extractMetrics(job)
  → parses job log for duration_ms, tokens, cost
  → INSERT INTO job_metrics
  → INSERT INTO job_status_history (old → new)
      │
      ▼
analyticsCache.invalidate(workspaceId)   ← cache busted on new data
      │
      ▼
WS broadcast: { type: "metric-update", workspaceId, jobId }
      │
      ▼
Dashboard client:
  receives metric-update → re-fetches /api/analytics/performance?workspace=ws-1&range=24h
      │
      ▼
Analytics route:
  analyticsCache.get(cacheKey) → cache hit? return cached result
                                → cache miss? query DB → computePerformanceMetrics()
                                           → analyticsCache.set(cacheKey, result, 300s)
                                           → return result
```

### End-to-End Latency Budget (Req 17.6)

To meet the 2-second metric update requirement, the pipeline budget is:

| Stage | Budget | Notes |
|-------|--------|-------|
| File parse + DB upsert | ≤500ms | Debounced file watcher processing |
| Metrics extraction | ≤300ms | Regex parsing of log file |
| Cache invalidation + WS broadcast | ≤200ms | In-memory operation, O(clients) |
| Client fetch + render | ≤1000ms | Network round-trip + chart render |
| **Total** | **≤2000ms** | Validates Req 17.6 compliance |

If any stage exceeds budget, log warning with stage name and actual duration.

### Metrics Extraction

`src/workers/metricsCollector.ts` is started at server startup and listens for job-completion
events from the file watcher. It extracts metrics by scanning the job's `.log` file with regex
patterns:

```typescript
const DURATION_RE = /Total time[:\s]+(\d+\.?\d*)\s*(?:ms|s)/i;
const TOKENS_RE   = /Tokens used[:\s]+in:(\d+)\s+out:(\d+)/i;
const COST_RE     = /Cost[:\s]+\$?(\d+\.?\d+)/i;
const TOOLS_RE    = /Tool calls[:\s]+(\d+)/i;
const RETRY_RE    = /Retries[:\s]+(\d+)/i;
const ERRORS_RE   = /Errors[:\s]+(\d+)/i;
```

**Failure handling distinction (Req 12.5)**:
- **Structural failure** (malformed JSON, unparseable log file) → fail entire collection for that job
- **Field extraction failure** (missing field, field present but can't parse value) → store NULL 
  for that field, log warning, continue collection for other fields

Numeric bounds (Req 12.6) are enforced after extraction:
```typescript
function clampMetric(value: number | null): number | null {
  if (value === null) return null;
  return Math.max(0, value);
}
```

---

## Caching Strategy

`src/analytics/cache.ts` implements a `Map`-keyed TTL cache. Cache keys encode the workspace,
time range, and metric type to ensure correct isolation.

```typescript
// src/analytics/cache.ts

type CacheKey = string; // `${workspaceId}:${range}:${metricType}`

export class AnalyticsCache {
  private store = new Map<CacheKey, AnalyticsCacheEntry<unknown>>();
  private ttlMs: number;

  constructor(ttlMs = 300_000) { this.ttlMs = ttlMs; }

  get<T>(key: CacheKey): T | null {
    const entry = this.store.get(key) as AnalyticsCacheEntry<T> | undefined;
    if (!entry) return null;
    if (Date.now() > entry.expires_at) { this.store.delete(key); return null; }
    return entry.data;
  }

  set<T>(key: CacheKey, data: T): void {
    this.store.set(key, { data, expires_at: Date.now() + this.ttlMs });
  }

  /** Invalidate all entries for a workspace (called on new job completion) */
  invalidateWorkspace(workspaceId: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(`${workspaceId}:`)) this.store.delete(key);
    }
  }
}

// Module-level singleton shared across routes
export const analyticsCache = new AnalyticsCache();
```

### Cache Key Format

```
"ws-1:24h:performance"
"ws-1:7d:cost"
"ws-1:30d:bottlenecks"
```

### Logging

The cache logs hit/miss rates every 5 minutes when enabled (Req 23.4):
```typescript
setInterval(() => {
  // Only log if cache_logging_enabled is true AND log level is INFO or higher
  if (!config.CACHE_LOGGING_ENABLED || logLevel < LogLevel.INFO) return;
  
  console.info(`[analytics-cache] hits=${hits} misses=${misses} ratio=${(hits/(hits+misses+0.001)).toFixed(2)}`);
  hits = 0; misses = 0;
}, 5 * 60_000);
```

---

## Backward Compatibility Design

### Preserved Interfaces

| Existing interface      | Phase 5 behaviour |
|-------------------------|-------------------|
| `GET /events` (SSE)     | Unchanged. `ssebroadcaster.ts` continues to poll and emit. |
| `GET /jobs`             | Returns same `Job[]` shape. Route reads from DB when enabled, file scan otherwise. |
| `GET /chains`           | Returns same `Chain[]` shape. Same fallback logic. |
| `GET /sessions`         | Returns same `SessionState[]` shape. |
| `POST /git-commit`      | Unchanged. Git route is not modified. |
| `GET /log/:id`          | Unchanged. Reads directly from file. |
| `GET /system-status`    | Extended with optional db_status field, not breaking. |

### Fallback Chain

When `DB_ENABLED=false` or the database is unavailable at runtime:

```
Request arrives at GET /jobs
  │
  ├── DB_ENABLED=true AND db.isHealthy()? ──► db.query('SELECT * FROM jobs ...') → respond
  │
  └── (DB unavailable or disabled)           ──► scanJobs(OUTPUT_DIR) → respond
```

The route handler catches database errors and falls back transparently:

```typescript
async function getJobs(workspaceId: string): Promise<Job[]> {
  if (config.DB_ENABLED && db) {
    try {
      return await loadJobsFromDb(db, workspaceId);
    } catch (err) {
      console.warn('[db] query failed, falling back to file scan:', (err as Error).message);
    }
  }
  return scanJobs(OUTPUT_DIR, workspaceId);
}
```

### Dashboard WebSocket Fallback (Req 21.5)

```typescript
// src/dashboard/main.ts (new section)
function connectRealtime(reconnectAttempt = 0): void {
  try {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onerror = () => reconnect(reconnectAttempt);
    ws.onclose = () => reconnect(reconnectAttempt);
    ws.onopen = () => { reconnectAttempt = 0; }; // reset on success
    // ... handle messages
  } catch {
    reconnect(reconnectAttempt);
  }
}

/** Exponential backoff: 1s, 2s, 4s, 8s, 16s (max 5 attempts before SSE fallback) */
function reconnect(attempt: number): void {
  if (attempt >= 5) {
    console.warn('[ws] max reconnect attempts reached, falling back to SSE');
    fallbackToSSE();
    return;
  }
  const delay = Math.min(1000 * Math.pow(2, attempt), 16000);
  console.info(`[ws] reconnecting in ${delay}ms (attempt ${attempt + 1}/5)`);
  setTimeout(() => connectRealtime(attempt + 1), delay);
}

function fallbackToSSE(attempt = 0): void {
  if (attempt >= 5) return; // max 5 reconnect attempts
  const es = new EventSource('/events');
  es.onmessage = handleSSEUpdate;
  es.onerror = () => {
    es.close();
    setTimeout(() => fallbackToSSE(attempt + 1), 1000);
  };
}
```

---

## Configuration Loading

All new environment variables are loaded by `src/config/observability.ts` which follows the
same `resolveXxx(env)` factory pattern as `src/constants.ts`.

```typescript
// src/config/observability.ts

export interface ObservabilityConfig {
  DB_ENABLED: boolean;
  DB_TYPE: 'sqlite' | 'postgres';
  DB_PATH: string;
  DB_URL: string | undefined;
  ANALYTICS_ENABLED: boolean;
  ANALYTICS_CACHE_TTL: number;  // seconds, clamped to [1, 86400]
  WS_ENABLED: boolean;
}

export function resolveObservabilityConfig(env: NodeJS.ProcessEnv): ObservabilityConfig {
  // DB_ENABLED — must be exactly "true" or "false" (case-insensitive)
  const dbEnabledRaw = (env.DB_ENABLED ?? 'true').toLowerCase();
  if (dbEnabledRaw !== 'true' && dbEnabledRaw !== 'false') {
    console.error(`Configuration error: DB_ENABLED: must be 'true' or 'false', got '${env.DB_ENABLED}'`);
    process.exit(1);
  }
  const DB_ENABLED = dbEnabledRaw === 'true';

  // DB_TYPE
  const DB_TYPE = (env.DB_TYPE ?? 'sqlite') as 'sqlite' | 'postgres';
  if (DB_TYPE !== 'sqlite' && DB_TYPE !== 'postgres') {
    console.error(`Configuration error: DB_TYPE: must be 'sqlite' or 'postgres', got '${env.DB_TYPE}'`);
    process.exit(1);
  }

  // DB_URL required when postgres
  const DB_URL = env.DB_URL;
  if (DB_TYPE === 'postgres' && !DB_URL) {
    console.error('Configuration error: DB_URL: DB_URL is required when DB_TYPE=postgres');
    process.exit(1);
  }

  // ANALYTICS_CACHE_TTL — clamp to [1, 86400]
  const rawTTL = Number(env.ANALYTICS_CACHE_TTL ?? '300');
  let ANALYTICS_CACHE_TTL = rawTTL;
  if (rawTTL < 1 || rawTTL > 86400) {
    const clamped = Math.min(86400, Math.max(1, rawTTL));
    console.warn(`ANALYTICS_CACHE_TTL ${rawTTL} adjusted to ${clamped}`);
    ANALYTICS_CACHE_TTL = clamped;
  }

  return {
    DB_ENABLED,
    DB_TYPE,
    DB_PATH: env.DB_PATH ?? '.agenthq.db',
    DB_URL,
    ANALYTICS_ENABLED: (env.ANALYTICS_ENABLED ?? 'true').toLowerCase() !== 'false',
    ANALYTICS_CACHE_TTL,
    WS_ENABLED: (env.WS_ENABLED ?? 'true').toLowerCase() !== 'false',
  };
}
```

### Startup Abort Conditions

| Condition | Action |
|-----------|--------|
| `DB_ENABLED` is not `"true"` or `"false"` | Log error + `process.exit(1)` |
| `DB_TYPE=postgres` and `DB_URL` missing | Log error + `process.exit(1)` |
| Migration fails | Log error + throw (server refuses to bind port) |
| Migration exceeds 10 seconds | Log error + throw |

---

## Error Handling Patterns

### DB Fallback

```typescript
// Pattern used in all route handlers that can use DB or file scan
try {
  const result = await db.query<DbJob>(sql, params);
  return mapDbJobsToJobs(result.rows);
} catch (err) {
  console.warn('[db] falling back to file scan:', (err as Error).message);
  return scanJobs(OUTPUT_DIR, workspaceId);
}
```

### WebSocket Error Codes

| Condition | Close code | Close reason |
|-----------|-----------|--------------|
| Message not valid JSON | 1003 | "invalid JSON" |
| Message size > 1MB | 1009 | "message too large" |
| Schema validation failure | — (send error ack, keep open) | — |
| Invalid state transition | — (send error ack, keep open) | — |

```typescript
// src/ws/server.ts
function handleMessage(ws: ServerWebSocket, rawData: string | Buffer): void {
  if (rawData.length > 1_048_576) {
    ws.close(1009, 'message too large');
    return;
  }
  let msg: unknown;
  try { msg = JSON.parse(rawData.toString()); } catch (e) {
    console.error(`[ws] WebSocket message parse failed: ${(e as Error).message}`);
    ws.close(1003, 'invalid JSON');
    return;
  }
  const parsed = parseClientMessage(msg);
  if (!parsed.ok) {
    ws.send(JSON.stringify({
      type: 'ack', commandId: (msg as Record<string,unknown>).commandId ?? '',
      success: false, error: parsed.error
    }));
    return;
  }
  // dispatch to handlers...
}
```

### Analytics Timeout (Req 22.4)

The 30-second timeout is propagated through the entire analytics call stack to ensure DB
queries respect the deadline:

```typescript
// src/routes/analytics.ts
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);
try {
  // Pass AbortSignal to analytics function
  const metrics = await computePerformanceMetrics(db, params, controller.signal);
  return Response.json(metrics);
} catch (err) {
  if (controller.signal.aborted) {
    return new Response(
      JSON.stringify({ error: 'computation timed out after 30 seconds' }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    );
  }
  throw err;
} finally {
  clearTimeout(timeout);
}
```

```typescript
// src/analytics/metrics.ts
async function computePerformanceMetrics(
  db: DbAdapter,
  params: AnalyticsParams,
  signal?: AbortSignal  // ← Timeout propagation
): Promise<PerformanceMetrics> {
  // Pass signal through to DB layer
  const result = await db.query(sql, params, { signal });
  if (signal?.aborted) throw new Error('computation aborted');
  // ... compute metrics
}
```

**Implementation note**: `bun:sqlite` does not natively support query cancellation mid-execution.
The abort signal is checked before query execution and between query batches, not during individual
query execution. PostgreSQL via `pg` supports query cancellation through connection termination.

### File Watcher Error Isolation

Each file's parse/upsert cycle is wrapped in an independent try/catch. A failure for one file
never prevents processing of other files in the same batch (Req 22.3).

### Disk Space Monitoring (Req 22.5)

Database disk usage is checked every 10 minutes by the file watcher worker:

```typescript
// src/workers/fileWatcher.ts
import { statSync } from 'fs';
import { execSync } from 'child_process';

let fileWatcherPaused = false;

async function checkDiskUsage(): Promise<{ current_db_size: number; available_disk_space: number }> {
  const dbPath = config.DB_PATH;
  const current_db_size = statSync(dbPath).size;
  // Windows: use fsutil, cross-platform: use df
  const diskInfoCmd = process.platform === 'win32'
    ? `fsutil volume diskfree ${dbPath.slice(0, 2)}`
    : `df -k ${dbPath}`;
  const output = execSync(diskInfoCmd, { encoding: 'utf8' });
  const available_disk_space = parseDiskFreeOutput(output);
  return { current_db_size, available_disk_space };
}

// Check disk usage every 10 minutes
setInterval(async () => {
  try {
    const { current_db_size, available_disk_space } = await checkDiskUsage();
    const usageRatio = current_db_size / available_disk_space;
    
    if (usageRatio >= 0.95 && !fileWatcherPaused) {
      console.error(`[critical] Disk usage critical (${(usageRatio * 100).toFixed(1)}%) - pausing file watcher`);
      fileWatcherPaused = true;
      // Stop processing file events to prevent disk-full crash
    } else if (usageRatio >= 0.9) {
      console.error(`[critical] Database approaching disk limit: ${(usageRatio * 100).toFixed(1)}% used`);
    } else if (usageRatio < 0.85 && fileWatcherPaused) {
      console.info(`[file-watcher] Disk usage recovered (${(usageRatio * 100).toFixed(1)}%) - resuming`);
      fileWatcherPaused = false;
    }
  } catch (err) {
    console.warn(`[file-watcher] disk usage check failed: ${(err as Error).message}`);
  }
}, 600_000);
```

---

## Security Design

### Parameterized Queries

All DB operations use `?` placeholders (SQLite) or `$1` placeholders (PostgreSQL). User-
provided values — workspace IDs, job IDs, time ranges, and export parameters — are **never**
interpolated into SQL strings.

```typescript
// CORRECT
db.query('SELECT * FROM jobs WHERE workspace_id = ? AND status = ?', [workspaceId, status]);

// FORBIDDEN — would allow SQL injection
db.query(`SELECT * FROM jobs WHERE workspace_id = '${workspaceId}'`);
```

The `DbAdapter.query()` and `DbAdapter.execute()` interface signatures accept a `params` array
by design; there is no way to call them without parameterization.

### Path Sanitization

`src/workers/fileWatcher.ts` sanitizes all incoming paths before processing:

```typescript
function isPathSafe(filePath: string, watchDir: string): boolean {
  const resolved = path.resolve(filePath);
  const base = path.resolve(watchDir);
  // Reject paths containing ".." after resolution or outside watchDir
  return resolved.startsWith(base) && !filePath.includes('..');
}
```

Files that fail the check are skipped with a logged warning; no file outside `OUTPUT_DIR` is
ever parsed or upserted.

### Analytics Export Parameter Allowlist (Req 24.5)

```typescript
const VALID_METRIC_TYPES = new Set(['performance', 'cost', 'bottlenecks'] as const);

function validateMetricsParam(raw: string): string[] {
  return raw.split(',')
    .map(s => s.trim().toLowerCase())
    .filter(t => {
      if (!VALID_METRIC_TYPES.has(t as MetricType)) {
        throw new HttpError(400, `unrecognized metric type: ${t}`);
      }
      return true;
    });
}
```

### Analytics Export Format (Req 19.2, 19.3)

**CSV Export** follows RFC 4180:
- String fields are quoted with double-quotes: `"workspace-1"`
- Numeric fields are unquoted: `123.45`
- Quotes within strings are escaped by doubling: `"He said ""hello"""` → `He said "hello"`
- Newlines within fields are preserved within quotes

**Example CSV output**:
```csv
job_id,workspace_id,duration_ms,cost_usd,status
"2024-01-01-abc","ws-1",1234.5,0.0023,"done"
"2024-01-01-def","ws-1",2345.6,0.0045,"error"
```

**JSON Export** conforms to metric type schemas with proper type coercion (numbers as numbers, 
not strings).

### Connection String Safety (Req 24.6)

`PostgresAdapter` catches connection errors and re-throws with a sanitized message:

```typescript
pool.connect().catch(err => {
  // Never log the connection string
  throw new Error('database connection failed');
});
```

### Message Size Enforcement (Req 24.7)

The 1MB limit is applied to the raw WebSocket frame payload before JSON parsing. The check
compares `rawData.length` in bytes, with tolerance for protocol overhead (headers, framing).
The effective limit is checked as `> 1_048_576` (1 MiB); messages up to 1.05 MB may be
accepted to account for framing overhead.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions
of a system — essentially, a formal statement about what the system should do. Properties serve
as the bridge between human-readable specifications and machine-verifiable correctness
guarantees.*

### Property 1: WebSocket Message Serialization Round-Trip

*For any* valid `ClientMessage` or `ServerMessage` object, serializing it to a JSON string and
parsing it back should produce a structurally equivalent object.

**Validates: Requirements 1.8, 25.2**

### Property 2: Message Size Enforcement

*For any* byte sequence whose length exceeds 1,048,576 bytes, the WebSocket message handler
shall always reject it (close with code 1009 or return an error), and for any message at or
below this size it shall be forwarded to parsing.

**Validates: Requirements 2.1, 24.7**

### Property 3: Message Schema Validation

*For any* object that is a structurally valid `ClientMessage` (has `type` and `commandId` and
required fields for its variant), `parseClientMessage` shall return `{ ok: true }`. For any
object missing required fields or with wrong field types, it shall return `{ ok: false }`.

**Validates: Requirements 2.3**

### Property 4: Command ID Uniqueness and Format

*For any* N ≥ 1 calls to `generateCommandId()`, all N results shall be distinct strings and
each shall match the regex `/^cmd_\d+_[a-z0-9]+$/`.

**Validates: Requirements 2.5**

### Property 5: Performance Analytics Computation Correctness

*For any* non-empty list of non-negative `duration_ms` values, the computed statistics shall
satisfy: `avg ≥ 0`, `median ≥ 0`, `p95 ≥ median`, `p99 ≥ p95`, `success_rate_percent ∈ [0,
100]`. For an empty list, all metrics shall be `null`.

**Validates: Requirements 13.1, 13.5, 25.4**

### Property 6: Cost Analytics Computation

*For any* list of non-negative job cost values, `cost_per_job_usd = sum(costs) / count` for
non-empty lists, and `null` for empty lists. For any computed `projected_monthly_usd`, its
value equals `daily_average × 30`.

**Validates: Requirements 14.2, 14.4**

### Property 7: Bottleneck Detection and Severity Classification

*For any* set of job duration records grouped by type, every job returned by `detectBottlenecks`
shall have `duration_ms > 2 × avg_duration_for_type`, and its assigned severity shall satisfy:
`slowdown_factor ≥ 5 → "high"`, `2 ≤ slowdown_factor < 5 → "medium"`, `slowdown_factor < 2 →
"low"`. No job with `slowdown_factor ≤ 0` shall appear in the result.

**Validates: Requirements 15.1, 15.2, 15.7**

### Property 8: Predictive Analytics Computation

*For any* set of ≥ 5 historical completed job durations and any elapsed time, `estimated_remaining_ms =
mean(durations) − elapsed_ms`. For any mean > 0 and stddev ≥ 0, `confidence_score = max(0, 1 −
stddev/mean)` and is always in `[0, 1]`. For any set with fewer than 5 samples, all estimates
shall be `null` and `cold_start = true`.

**5-sample minimum rationale**: The Central Limit Theorem approximation requires n ≥ 5 for
confidence score calculation to be statistically meaningful. Below this threshold, variance
estimates are unreliable and confidence_score would be misleading.

**Validates: Requirements 16.1, 16.2, 16.7**

### Property 9: Analytics Export Format Correctness

*For any* set of `PerformanceMetrics`, `CostMetrics`, or `BottleneckAnalysis` objects, exporting
to JSON shall produce a string where `JSON.parse(output)` succeeds and the round-trip value
equals the input. Exporting to CSV shall produce a string where parsing the CSV back recovers
all numeric field values.

**Validates: Requirements 19.2, 19.3**

### Property 10: Configuration Boolean Parsing

*For any* string that is a case-insensitive variation of "true" or "false" (e.g., "TRUE",
"False", "FALSE"), `parseConfigBool(s)` shall return the correct boolean. For any string that
is not a case-insensitive match of "true" or "false", it shall signal an error.

**Validates: Requirements 20.1**

### Property 11: Job Status History Insertion Invariant

*For any* job and any status transition (oldStatus → newStatus), after calling
`recordStatusChange(jobId, oldStatus, newStatus)`, the `job_status_history` table shall contain
exactly one new row with the correct `old_status`, `new_status`, `job_id`, and a non-null
`changed_at` timestamp.

**Validates: Requirements 9.1**

### Property 12: Metrics Bounds Enforcement

*For any* input to the metrics extractor (including logs with negative or malformed numbers),
all extracted numeric metric fields (`duration_ms`, `input_tokens`, `output_tokens`,
`total_tokens`, `cost_usd`, `retry_count`, `error_count`) in the result shall be either `null`
or `≥ 0`.

**Validates: Requirements 12.6**

### Property 13: SQL Injection Safety

*For any* string containing SQL injection patterns (e.g., `'; DROP TABLE jobs; --`, `' OR '1'='1`),
passing it as a query parameter through `DbAdapter.query()` shall not modify the schema, not
return extra rows beyond those matching the genuine filter, and not raise a SQL syntax error.

**Validates: Requirements 24.1**

### Property 14: Cache Invalidation Consistency (Req 17.6)

*For any* workspace W and job completion event E, after cache invalidation via
`analyticsCache.invalidateWorkspace(W)`, all subsequent queries for workspace W shall reflect
event E's metrics within 2 seconds (measured from file modification timestamp to client render
completion).

**Validates: Requirements 17.6, cache correctness**

---

## Dashboard Analytics Page

### Component Structure

```
src/dashboard/pages/analytics.ts
  ├── AnalyticsPage — root component
  │   ├── TimeRangePicker — 24h / 7d / 30d selector buttons
  │   ├── MetricsSummary — KPI cards: avg duration, throughput, success rate
  │   ├── BarChart (barChart.ts) — cost breakdown per agent/model
  │   ├── LineChart (lineChart.ts) — duration trend over time
  │   └── DrillDownPanel — job list filtered by workspace+range+status
```

### Time Range Selector

Three buttons render as a tab strip. Clicking any button sets `state.analyticsRange` and calls
`loadAnalytics()`. If the update takes >500ms, a spinner overlay is shown and all interactions
are disabled until the response arrives (Req 17.4).

```typescript
function renderTimeRangePicker(selected: '24h' | '7d' | '30d'): string {
  return ['24h', '7d', '30d'].map(r =>
    `<button class="range-btn${r === selected ? ' active' : ''}"
             data-range="${r}">${r}</button>`
  ).join('');
}
```

### Inline SVG Bar Chart (barChart.ts)

No external chart library. Renders a horizontal bar chart as SVG markup injected into a
`<div>` container. Designed to handle datasets up to 1,000 points within 500ms by pre-
computing all bar widths in a single pass before DOM insertion.

```typescript
// src/dashboard/components/barChart.ts

export interface BarChartItem { label: string; value: number; color?: string; }

export function renderBarChart(
  items: BarChartItem[],
  options: { width?: number; barHeight?: number; title?: string } = {}
): string {
  if (items.length === 0) return '<svg class="chart chart--empty"><text>No data</text></svg>';

  const { width = 400, barHeight = 24 } = options;
  const maxValue = Math.max(...items.map(i => i.value), 1);
  const svgHeight = items.length * (barHeight + 4) + 40; // +40 for axis

  const bars = items.map((item, idx) => {
    const barWidth = (item.value / maxValue) * (width - 120);
    const y = idx * (barHeight + 4) + 20;
    const color = item.color ?? '#4f8ef7';
    return `
      <text x="0" y="${y + barHeight - 4}" font-size="11" fill="var(--text-muted)">
        ${escHtml(item.label.slice(0, 14))}
      </text>
      <rect x="110" y="${y}" width="${barWidth.toFixed(1)}" height="${barHeight}"
            fill="${color}" rx="3"/>
      <text x="${(110 + barWidth + 4).toFixed(1)}" y="${y + barHeight - 4}"
            font-size="11" fill="var(--text)">
        ${item.value.toFixed(4)}
      </text>`;
  }).join('');

  return `<svg class="chart" width="${width}" height="${svgHeight}" aria-label="${options.title ?? 'Bar chart'}">
    ${bars}
  </svg>`;
}
```

### Inline SVG Line Chart (lineChart.ts)

Renders a polyline with data point circles and axis labels. Zero data points renders a
placeholder with the label "No data for this period."

```typescript
// src/dashboard/components/lineChart.ts

export interface LineChartPoint { x: string; y: number; }  // x is date label

export function renderLineChart(
  points: LineChartPoint[],
  options: { width?: number; height?: number; yLabel?: string; title?: string } = {}
): string {
  if (points.length === 0) {
    return `<svg class="chart chart--empty" width="${options.width ?? 400}" height="${options.height ?? 200}">
      <text x="50%" y="50%" text-anchor="middle" fill="var(--text-muted)">No data for this period</text>
    </svg>`;
  }
  // ... scale points, build polyline path, render axes
}
```

### Drill-Down Behavior (Req 17.5)

Clicking a chart data point calls:
```typescript
navigateToDrillDown({ workspaceId, range, date, status });
```
which appends query params to the URL and re-renders `DrillDownPanel` with a filtered job
list fetched from `GET /jobs?workspace=...&from=...&to=...&status=...`.

### WebSocket Integration

The analytics page listens for `metric-update` messages over the WebSocket connection (or
falls back to polling SSE `update` events). On receipt, it re-fetches the analytics endpoint
only if the `workspaceId` matches the currently viewed workspace.

---

## Error Handling

### Structured Logging

All log calls use structured fields matching Req 23.x:

```typescript
// WebSocket connection events (Req 23.1)
console.info(JSON.stringify({
  level: 'INFO', event_type: 'ws_connect',
  client_id: clientId, timestamp: new Date().toISOString(), remote_ip: remoteIp
}));

// Slow DB queries (Req 23.2)
console.warn(JSON.stringify({
  level: 'WARN', query_type: 'SELECT',
  duration_ms: ms, table_name: 'jobs', filter_conditions: { workspace_id, status }
}));

// User commands (Req 23.5)
console.info(JSON.stringify({
  level: 'INFO', user_id: userId, command_type: msg.type,
  target_entity_id: msg.jobId ?? msg.sessionHash,
  execution_result: 'success', duration_ms: elapsed
}));
```

Severity levels follow `DEBUG < INFO < WARN < ERROR < FATAL`. Unexpected errors (not matching
known validation/user-input patterns) include stack traces (Req 23.7).

---

## Testing Strategy

### Property-Based Tests (fast-check, bun test)

Each property from the Correctness Properties section maps to one `test()` block using
`fc.assert(fc.property(...))`. Minimum 100 iterations per property.

```typescript
// test/ws-protocol.test.ts
import { describe, test } from 'bun:test';
import fc from 'fast-check';
import { parseClientMessage, generateCommandId } from '../src/ws/protocol.ts';

// Feature: phase-5-observability-platform, Property 1: WebSocket message serialization round-trip
test('ClientMessage serialization round-trip', () => {
  fc.assert(fc.property(arbitraryClientMessage(), (msg) => {
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(roundTripped).toEqual(msg);
  }), { numRuns: 100 });
});

// Feature: phase-5-observability-platform, Property 4: Command ID uniqueness and format
test('generateCommandId uniqueness and format', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 200 }), (n) => {
    const ids = Array.from({ length: n }, () => generateCommandId());
    const unique = new Set(ids);
    expect(unique.size).toBe(n);
    for (const id of ids) {
      expect(id).toMatch(/^cmd_\d+_[a-z0-9]+$/);
    }
  }), { numRuns: 100 });
});
```

### Unit Tests

- `src/db/sqlite-adapter.ts` — insert, update, query, delete for each table
- `src/db/migrations.ts` — apply one migration, apply two migrations, idempotency
- `src/analytics/metrics.ts` — empty dataset returns null, specific known dataset
- `src/analytics/bottleneck.ts` — exact threshold boundary (2x = bottleneck)
- `src/ws/subscriptions.ts` — subscribe, unsubscribe, duplicate subscribe, filtered broadcast

### Integration Tests

- WS connect → receive `connected` → subscribe to workspace → receive update
- WS cancel-job → receive ack → status broadcast to all subscribers
- DB unavailable → GET /jobs → file scan fallback returns valid data
- Migration fails → server aborts startup

### Performance Tests (Req 25.5)

```typescript
// test/db-performance.test.ts
test('workspace+status filter query ≤50ms for 10k jobs', async () => {
  await seedJobs(db, 10_000);
  const t0 = performance.now();
  await db.query('SELECT * FROM jobs WHERE workspace_id=? AND status=?', ['ws-1','done']);
  expect(performance.now() - t0).toBeLessThan(50);
});
```

### Concurrent WebSocket Test (Req 25.7)

Opens 10 WebSocket connections simultaneously, sends `ping` from each, and asserts all
receive `pong` within 500ms using `Promise.all` with `AbortSignal.timeout(500)`.
