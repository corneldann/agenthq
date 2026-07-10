# Design Document: Phase 5.3 — Analytics Layer

## Overview

Phase 5.3 adds advanced analytics to AgentHQ: performance metrics collection, cost analysis, bottleneck detection, and predictive ETA estimation. Results are cached (5-minute TTL) and exposed via REST endpoints with a new dashboard page featuring inline SVG charts.

The analytics layer builds on the database layer (Phase 5.1) for metrics storage and queries, and integrates with the WebSocket layer (Phase 5.2) for real-time metric update notifications.

```
Phase 5.3: Analytics Layer
           ↓
    src/analytics/ (computation)
           ↓
    src/db/ (Phase 5.1) → query job_metrics
           ↓
    REST endpoints → dashboard charts
           ↓
    WebSocket (Phase 5.2) → real-time updates
```

**Dependencies:** Requires Phase 5.1 (Database Layer) and Phase 5.2 (WebSocket Layer) completed.

---

## Architecture

### Component Diagram

```
┌────────────────────────────────────────────────────────┐
│                Bun.serve (monitor.ts)                  │
│                                                        │
│  HTTP Routes                    Workers                │
│  ─────────────                  ───────                │
│  GET  /api/analytics/performance  metricsCollector     │
│  GET  /api/analytics/cost                              │
│  GET  /api/analytics/bottlenecks                       │
│  GET  /api/analytics/predictions                       │
│  GET  /api/analytics/export                            │
└────────────────────┬───────────────────────────────────┘
                     │
      ┌──────────────▼──────────────┐
      │  src/analytics/  (Analytics)│
      │  metrics.ts    — perf agg   │
      │  cost.ts       — cost agg   │
      │  bottleneck.ts — slowdown   │
      │  predictions.ts— ETA        │
      │  cache.ts      — 5-min TTL  │
      └──────────────┬──────────────┘
                     │
            ┌────────▼────────┐
            │ src/db/ (5.1)   │
            │ job_metrics     │
            └─────────────────┘
```

### Module Structure

```
src/
├── config/
│   └── analytics-config.ts   # loadAnalyticsConfig()
├── analytics/
│   ├── metrics.ts            # computePerformanceMetrics()
│   ├── cost.ts               # computeCostMetrics()
│   ├── bottleneck.ts         # detectBottlenecks()
│   ├── predictions.ts        # estimateETA()
│   └── cache.ts              # AnalyticsCache — 5-min TTL
├── routes/
│   └── analytics.ts          # register(router) — analytics endpoints
├── workers/
│   └── metricsCollector.ts   # startMetricsCollector()
migrations/
└── 003_job_metrics.sql       # job_metrics table
src/dashboard/
├── pages/
│   └── analytics.ts          # Analytics page
└── components/
    ├── barChart.ts           # Inline SVG bar chart
    └── lineChart.ts          # Inline SVG line chart
```

---

## Components and Interfaces

### Metrics Collector Worker

**`src/workers/metricsCollector.ts`** — Extracts metrics from completed job logs:


```typescript
import { watch } from 'fs';
import { readFileSync } from 'fs';
import type { DbAdapter } from '../db/adapter.ts';

export function startMetricsCollector(db: DbAdapter, outputDir: string): void {
  watch(outputDir, { recursive: true }, (eventType, filename) => {
    if (!filename?.endsWith('.log')) return;

    const path = join(outputDir, filename);
    extractAndStoreMetrics(db, path).catch(err => {
      console.error(`Metrics collection failed for ${path}:`, err);
    });
  });
}

async function extractAndStoreMetrics(db: DbAdapter, logPath: string): Promise<void> {
  const content = readFileSync(logPath, 'utf-8');
  const jobId = extractJobIdFromPath(logPath);

  // Extract metrics using regex
  const durationMatch = content.match(/Duration: (\d+)ms/);
  const inputTokensMatch = content.match(/Input tokens: (\d+)/);
  const outputTokensMatch = content.match(/Output tokens: (\d+)/);
  const costMatch = content.match(/Cost: \$(\d+\.\d+)/);
  const toolCallsMatch = content.match(/Tool calls: (\d+)/);

  await db.execute(
    `INSERT INTO job_metrics (job_id, workspace_id, duration_ms, input_tokens, 
     output_tokens, total_tokens, cost_usd, tool_calls, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(job_id) DO UPDATE SET
       duration_ms = excluded.duration_ms,
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       total_tokens = excluded.total_tokens,
       cost_usd = excluded.cost_usd,
       tool_calls = excluded.tool_calls`,
    [
      jobId,
      extractWorkspaceId(logPath),
      durationMatch ? parseInt(durationMatch[1], 10) : null,
      inputTokensMatch ? parseInt(inputTokensMatch[1], 10) : null,
      outputTokensMatch ? parseInt(outputTokensMatch[1], 10) : null,
      inputTokensMatch && outputTokensMatch
        ? parseInt(inputTokensMatch[1], 10) + parseInt(outputTokensMatch[1], 10)
        : null,
      costMatch ? parseFloat(costMatch[1]) : null,
      toolCallsMatch ? parseInt(toolCallsMatch[1], 10) : null
    ]
  );
}
```


### Performance Metrics Computation

**`src/analytics/metrics.ts`** — Computes performance analytics:

```typescript
import type { DbAdapter } from '../db/adapter.ts';

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

export async function computePerformanceMetrics(
  db: DbAdapter,
  workspaceId: string,
  range: '24h' | '7d' | '30d'
): Promise<PerformanceMetrics> {
  const rangeMap = { '24h': 1, '7d': 7, '30d': 30 };
  const days = rangeMap[range];

  // Query all jobs in range
  const jobs = await db.query<{ duration_ms: number; status: string }>(
    `SELECT jm.duration_ms, j.status
     FROM job_metrics jm
     JOIN jobs j ON jm.job_id = j.id
     WHERE jm.workspace_id = ?
       AND j.timestamp >= datetime('now', '-${days} days')
       AND jm.duration_ms IS NOT NULL`,
    [workspaceId]
  );

  if (jobs.rows.length === 0) {
    return {
      workspace_id: workspaceId,
      range,
      avg_duration_ms: null,
      median_duration_ms: null,
      p95_duration_ms: null,
      p99_duration_ms: null,
      throughput_per_hour: null,
      throughput_per_day: null,
      success_rate_percent: null,
      total_jobs: 0,
      computed_at: new Date().toISOString()
    };
  }

  // Compute metrics
  const durations = jobs.rows.map(j => j.duration_ms).sort((a, b) => a - b);
  const successCount = jobs.rows.filter(j => j.status === 'done').length;

  return {
    workspace_id: workspaceId,
    range,
    avg_duration_ms: average(durations),
    median_duration_ms: percentile(durations, 50),
    p95_duration_ms: percentile(durations, 95),
    p99_duration_ms: percentile(durations, 99),
    throughput_per_hour: jobs.rows.length / (days * 24),
    throughput_per_day: jobs.rows.length / days,
    success_rate_percent: (successCount / jobs.rows.length) * 100,
    total_jobs: jobs.rows.length,
    computed_at: new Date().toISOString()
  };
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function percentile(sorted: number[], p: number): number {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}
```


### Cost Analytics

**`src/analytics/cost.ts`** — Computes cost analytics:

```typescript
import type { DbAdapter } from '../db/adapter.ts';

export interface CostMetrics {
  workspace_id: string;
  range: '24h' | '7d' | '30d';
  total_cost_usd: number | null;
  total_tokens: number | null;
  cost_per_job_usd: number | null;
  jobs_count: number;
  cost_by_agent: Record<string, number>;
  wasted_cost_usd: number | null;
  projected_monthly_usd: number | null;
  daily_trend: Array<{ date: string; cost_usd: number; token_count: number }>;
  computed_at: string;
}

export async function computeCostMetrics(
  db: DbAdapter,
  workspaceId: string,
  range: '24h' | '7d' | '30d'
): Promise<CostMetrics> {
  const rangeMap = { '24h': 1, '7d': 7, '30d': 30 };
  const days = rangeMap[range];

  // Aggregate costs
  const result = await db.query<{
    total_cost: number;
    total_tokens: number;
    job_count: number;
  }>(
    `SELECT SUM(cost_usd) as total_cost, SUM(total_tokens) as total_tokens, COUNT(*) as job_count
     FROM job_metrics jm
     JOIN jobs j ON jm.job_id = j.id
     WHERE jm.workspace_id = ?
       AND j.timestamp >= datetime('now', '-${days} days')`,
    [workspaceId]
  );

  const { total_cost, total_tokens, job_count } = result.rows[0] || {};

  // Costs by agent
  const byAgent = await db.query<{ agent: string; total_cost: number }>(
    `SELECT j.agent, SUM(jm.cost_usd) as total_cost
     FROM job_metrics jm
     JOIN jobs j ON jm.job_id = j.id
     WHERE jm.workspace_id = ?
       AND j.timestamp >= datetime('now', '-${days} days')
     GROUP BY j.agent`,
    [workspaceId]
  );

  const cost_by_agent: Record<string, number> = {};
  for (const row of byAgent.rows) {
    cost_by_agent[row.agent] = row.total_cost;
  }

  // Wasted cost (error jobs)
  const wastedResult = await db.query<{ wasted: number }>(
    `SELECT SUM(jm.cost_usd) as wasted
     FROM job_metrics jm
     JOIN jobs j ON jm.job_id = j.id
     WHERE jm.workspace_id = ?
       AND j.timestamp >= datetime('now', '-${days} days')
       AND j.status = 'error'`,
    [workspaceId]
  );

  // Daily trend
  const trendResult = await db.query<{ date: string; cost_usd: number; token_count: number }>(
    `SELECT DATE(j.timestamp) as date, SUM(jm.cost_usd) as cost_usd, SUM(jm.total_tokens) as token_count
     FROM job_metrics jm
     JOIN jobs j ON jm.job_id = j.id
     WHERE jm.workspace_id = ?
       AND j.timestamp >= datetime('now', '-${days} days')
     GROUP BY DATE(j.timestamp)
     ORDER BY date ASC`,
    [workspaceId]
  );

  return {
    workspace_id: workspaceId,
    range,
    total_cost_usd: total_cost || null,
    total_tokens: total_tokens || null,
    cost_per_job_usd: job_count > 0 ? (total_cost || 0) / job_count : null,
    jobs_count: job_count || 0,
    cost_by_agent,
    wasted_cost_usd: wastedResult.rows[0]?.wasted || null,
    projected_monthly_usd: total_cost ? (total_cost / days) * 30 : null,
    daily_trend: trendResult.rows,
    computed_at: new Date().toISOString()
  };
}
```


### Bottleneck Detection

**`src/analytics/bottleneck.ts`** — Detects slow operations:

```typescript
import type { DbAdapter } from '../db/adapter.ts';

export interface BottleneckJob {
  job_id: string;
  job_type: string;
  duration_ms: number;
  avg_duration_ms: number;
  slowdown_factor: number;
  severity: 'low' | 'medium' | 'high';
  recommendation: string;
}

export interface BottleneckAnalysis {
  workspace_id: string;
  slowest_jobs: BottleneckJob[];
  top_tools_by_time: Array<{ tool_name: string; total_ms: number; call_count: number; pct_of_total: number }>;
  contention_periods: Array<{ period_start: string; concurrent_jobs: number }>;
  computed_at: string;
}

export async function detectBottlenecks(
  db: DbAdapter,
  workspaceId: string
): Promise<BottleneckAnalysis> {
  // Compute average duration per job type
  const avgByType = await db.query<{ type: string; avg_duration: number }>(
    `SELECT j.type, AVG(jm.duration_ms) as avg_duration
     FROM job_metrics jm
     JOIN jobs j ON jm.job_id = j.id
     WHERE jm.workspace_id = ?
       AND jm.duration_ms IS NOT NULL
     GROUP BY j.type`,
    [workspaceId]
  );

  const avgMap = new Map<string, number>();
  for (const row of avgByType.rows) {
    avgMap.set(row.type, row.avg_duration);
  }

  // Find jobs with slowdown_factor >= 2
  const jobs = await db.query<{
    job_id: string;
    type: string;
    duration_ms: number;
  }>(
    `SELECT j.id as job_id, j.type, jm.duration_ms
     FROM job_metrics jm
     JOIN jobs j ON jm.job_id = j.id
     WHERE jm.workspace_id = ?
       AND jm.duration_ms IS NOT NULL`,
    [workspaceId]
  );

  const bottlenecks: BottleneckJob[] = [];

  for (const job of jobs.rows) {
    const avgDuration = avgMap.get(job.type) || job.duration_ms;
    const slowdownFactor = job.duration_ms / avgDuration;

    if (slowdownFactor < 2) continue; // Not a bottleneck

    const severity =
      slowdownFactor >= 5 ? 'high' : slowdownFactor >= 2 ? 'medium' : 'low';

    bottlenecks.push({
      job_id: job.job_id,
      job_type: job.type,
      duration_ms: job.duration_ms,
      avg_duration_ms: avgDuration,
      slowdown_factor: slowdownFactor,
      severity,
      recommendation: `Job type ${job.type} is ${slowdownFactor.toFixed(1)}x slower than average (${avgDuration.toFixed(0)}ms avg, ${job.duration_ms}ms observed)`
    });
  }

  // Sort by slowdown factor, take top 10
  bottlenecks.sort((a, b) => b.slowdown_factor - a.slowdown_factor);
  const slowest_jobs = bottlenecks.slice(0, 10);

  return {
    workspace_id: workspaceId,
    slowest_jobs,
    top_tools_by_time: [], // TODO: Implement tool timing analysis
    contention_periods: [], // TODO: Implement contention detection
    computed_at: new Date().toISOString()
  };
}
```


### Predictive Analytics

**`src/analytics/predictions.ts`** — Estimates completion times:

```typescript
import type { DbAdapter } from '../db/adapter.ts';

export interface PredictiveMetrics {
  job_id: string;
  job_type: string;
  elapsed_ms: number;
  estimated_remaining_ms: number | null;
  estimated_completion_at: string | null;
  confidence_score: number | null;
  low_confidence: boolean;
  success_probability: number | null;
  is_anomalous: boolean;
  anomaly_score: number | null;
  sample_count: number;
  cold_start: boolean;
}

export async function estimateETA(
  db: DbAdapter,
  jobId: string
): Promise<PredictiveMetrics> {
  // Get running job info
  const jobResult = await db.query<{
    type: string;
    timestamp: string;
  }>(
    `SELECT type, timestamp FROM jobs WHERE id = ? AND status = 'running'`,
    [jobId]
  );

  if (jobResult.rows.length === 0) {
    throw new Error('Job not found or not running');
  }

  const job = jobResult.rows[0];
  const elapsed_ms = Date.now() - new Date(job.timestamp).getTime();

  // Get historical completed jobs of same type
  const history = await db.query<{ duration_ms: number; status: string }>(
    `SELECT jm.duration_ms, j.status
     FROM job_metrics jm
     JOIN jobs j ON jm.job_id = j.id
     WHERE j.type = ?
       AND j.status IN ('done', 'error')
       AND jm.duration_ms IS NOT NULL`,
    [job.type]
  );

  const sample_count = history.rows.length;
  const cold_start = sample_count < 5;

  if (cold_start) {
    return {
      job_id: jobId,
      job_type: job.type,
      elapsed_ms,
      estimated_remaining_ms: null,
      estimated_completion_at: null,
      confidence_score: null,
      low_confidence: true,
      success_probability: null,
      is_anomalous: false,
      anomaly_score: null,
      sample_count,
      cold_start: true
    };
  }

  // Compute statistics
  const durations = history.rows.map(r => r.duration_ms);
  const mean = durations.reduce((sum, d) => sum + d, 0) / durations.length;
  const variance = durations.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) / durations.length;
  const stddev = Math.sqrt(variance);
  const cv = stddev / mean; // Coefficient of variation

  const confidence_score = Math.max(0, 1 - cv);
  const low_confidence = cv > 0.5;

  const estimated_remaining_ms = Math.max(0, mean - elapsed_ms);
  const estimated_completion_at = new Date(Date.now() + estimated_remaining_ms).toISOString();

  // Success probability
  const successCount = history.rows.filter(r => r.status === 'done').length;
  const success_probability = successCount / sample_count;

  // Anomaly detection
  const is_anomalous = elapsed_ms > mean * 2;
  const anomaly_score = is_anomalous
    ? Math.min(100, ((elapsed_ms - mean) / stddev) * 10)
    : 0;

  return {
    job_id: jobId,
    job_type: job.type,
    elapsed_ms,
    estimated_remaining_ms,
    estimated_completion_at,
    confidence_score,
    low_confidence,
    success_probability,
    is_anomalous,
    anomaly_score,
    sample_count,
    cold_start: false
  };
}
```


### Analytics Cache

**`src/analytics/cache.ts`** — 5-minute TTL cache:

```typescript
export interface AnalyticsCacheEntry<T> {
  data: T;
  expires_at: number;
}

export class AnalyticsCache {
  private cache = new Map<string, AnalyticsCacheEntry<unknown>>();
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minutes

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expires_at) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  set<T>(key: string, data: T): void {
    this.cache.set(key, {
      data,
      expires_at: Date.now() + this.TTL_MS
    });
  }

  invalidateWorkspace(workspaceId: string): void {
    for (const key of this.cache.keys()) {
      if (key.includes(workspaceId)) {
        this.cache.delete(key);
      }
    }
  }
}

export const analyticsCache = new AnalyticsCache();
```

---

## REST API Endpoints

**`src/routes/analytics.ts`** — Analytics endpoints:

```typescript
import type { Router } from '../router.ts';
import type { DbAdapter } from '../db/adapter.ts';
import { computePerformanceMetrics } from '../analytics/metrics.ts';
import { computeCostMetrics } from '../analytics/cost.ts';
import { detectBottlenecks } from '../analytics/bottleneck.ts';
import { estimateETA } from '../analytics/predictions.ts';
import { analyticsCache } from '../analytics/cache.ts';

export function register(router: Router, db: DbAdapter): void {
  router.get('/api/analytics/performance', async (req) => {
    const url = new URL(req.url);
    const workspaceId = url.searchParams.get('workspace');
    const range = url.searchParams.get('range') as '24h' | '7d' | '30d' | null;

    if (!workspaceId) {
      return new Response(JSON.stringify({ error: 'workspace parameter required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!range || !['24h', '7d', '30d'].includes(range)) {
      return new Response(JSON.stringify({ error: 'invalid range: must be one of [24h, 7d, 30d]' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const cacheKey = `perf:${workspaceId}:${range}`;
    let metrics = analyticsCache.get(cacheKey);

    if (!metrics) {
      metrics = await computePerformanceMetrics(db, workspaceId, range);
      analyticsCache.set(cacheKey, metrics);
    }

    return new Response(JSON.stringify(metrics), {
      headers: { 'Content-Type': 'application/json' }
    });
  });

  router.get('/api/analytics/cost', async (req) => {
    // Similar to performance endpoint
  });

  router.get('/api/analytics/bottlenecks', async (req) => {
    // Similar pattern
  });

  router.get('/api/analytics/predictions', async (req) => {
    const url = new URL(req.url);
    const jobId = url.searchParams.get('jobId');

    if (!jobId) {
      return new Response(JSON.stringify({ error: 'jobId parameter required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const metrics = await estimateETA(db, jobId);

    return new Response(JSON.stringify(metrics), {
      headers: { 'Content-Type': 'application/json' }
    });
  });

  router.get('/api/analytics/export', async (req) => {
    const url = new URL(req.url);
    const type = url.searchParams.get('type');

    if (!type || !['csv', 'json'].includes(type)) {
      return new Response(JSON.stringify({ error: 'invalid or missing type parameter: must be \'csv\' or \'json\'' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Export logic here
  });
}
```

---

## Dashboard Integration

### Analytics Page

**`src/dashboard/pages/analytics.ts`** — Dashboard page with charts:

```typescript
import { state } from '../state.ts';
import { api } from '../api.ts';
import { renderBarChart } from '../components/barChart.ts';
import { renderLineChart } from '../components/lineChart.ts';

export function renderAnalyticsPage(): string {
  return `
    <div class="analytics-page">
      <h1>Analytics</h1>
      
      <div class="time-range-picker">
        <button data-range="24h">24 Hours</button>
        <button data-range="7d" class="active">7 Days</button>
        <button data-range="30d">30 Days</button>
      </div>

      <div class="metrics-grid">
        <div class="metric-card" id="perf-metrics"></div>
        <div class="metric-card" id="cost-metrics"></div>
        <div class="metric-card" id="bottlenecks"></div>
      </div>

      <div class="charts-grid">
        <div class="chart-container" id="duration-trend"></div>
        <div class="chart-container" id="cost-breakdown"></div>
      </div>
    </div>
  `;
}

export async function loadAnalytics(range: '24h' | '7d' | '30d'): Promise<void> {
  const workspace = state.get('selectedWorkspace');

  // Fetch metrics
  const [perf, cost, bottlenecks] = await Promise.all([
    api.getPerformanceMetrics(workspace, range),
    api.getCostMetrics(workspace, range),
    api.getBottlenecks(workspace)
  ]);

  // Update metrics cards
  document.getElementById('perf-metrics')!.innerHTML = renderPerfCard(perf);
  document.getElementById('cost-metrics')!.innerHTML = renderCostCard(cost);
  document.getElementById('bottlenecks')!.innerHTML = renderBottlenecksCard(bottlenecks);

  // Render charts
  document.getElementById('duration-trend')!.innerHTML = renderLineChart(
    perf.daily_trend.map(d => ({ x: d.date, y: d.avg_duration_ms })),
    { title: 'Average Duration Trend', yLabel: 'Duration (ms)' }
  );

  document.getElementById('cost-breakdown')!.innerHTML = renderBarChart(
    Object.entries(cost.cost_by_agent).map(([agent, cost]) => ({ label: agent, value: cost })),
    { title: 'Cost by Agent', yLabel: 'Cost (USD)' }
  );
}
```

---

## Configuration

```typescript
// src/config/analytics-config.ts

export interface AnalyticsConfig {
  enabled: boolean;       // ANALYTICS_ENABLED (default: true)
  cacheTtl: number;       // ANALYTICS_CACHE_TTL seconds (default: 300)
}

export function loadAnalyticsConfig(env: Record<string, string | undefined>): AnalyticsConfig {
  const enabled = env.ANALYTICS_ENABLED?.toLowerCase();
  let cacheTtl = parseInt(env.ANALYTICS_CACHE_TTL || '300', 10);

  if (cacheTtl < 1 || cacheTtl > 86400) {
    console.warn(`ANALYTICS_CACHE_TTL ${cacheTtl} out of range [1, 86400], clamping`);
    cacheTtl = Math.max(1, Math.min(86400, cacheTtl));
  }

  return {
    enabled: enabled !== 'false',
    cacheTtl
  };
}
```

---

## Database Schema Extension

```sql
-- migrations/003_job_metrics.sql

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

CREATE INDEX IF NOT EXISTS idx_metrics_workspace
  ON job_metrics(workspace_id);

CREATE INDEX IF NOT EXISTS idx_metrics_cost
  ON job_metrics(workspace_id, cost_usd) WHERE cost_usd IS NOT NULL;
```

---

## Data Models

### Performance Metrics

```typescript
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
  computed_at: string;  // ISO 8601
}
```

### Cost Metrics

```typescript
export interface CostMetrics {
  workspace_id: string;
  range: '24h' | '7d' | '30d';
  total_cost_usd: number | null;
  total_tokens: number | null;
  cost_per_job_usd: number | null;
  jobs_count: number;
  cost_by_agent: Record<string, number>;
  wasted_cost_usd: number | null;
  projected_monthly_usd: number | null;
  daily_trend: Array<{ date: string; cost_usd: number; token_count: number }>;
  computed_at: string;
}
```

### Bottleneck Analysis

```typescript
export interface BottleneckJob {
  job_id: string;
  job_type: string;
  duration_ms: number;
  avg_duration_ms: number;
  slowdown_factor: number;
  severity: 'low' | 'medium' | 'high';
  recommendation: string;
}

export interface BottleneckAnalysis {
  workspace_id: string;
  slowest_jobs: BottleneckJob[];
  top_tools_by_time: Array<{ tool_name: string; total_ms: number; call_count: number; pct_of_total: number }>;
  contention_periods: Array<{ period_start: string; concurrent_jobs: number }>;
  computed_at: string;
}
```

### Predictive Metrics

```typescript
export interface PredictiveMetrics {
  job_id: string;
  job_type: string;
  elapsed_ms: number;
  estimated_remaining_ms: number | null;
  estimated_completion_at: string | null;
  confidence_score: number | null;     // 0–1
  low_confidence: boolean;
  success_probability: number | null;  // 0–1
  is_anomalous: boolean;
  anomaly_score: number | null;        // 0–100
  sample_count: number;
  cold_start: boolean;
}
```

### Job Metrics (Database)

```typescript
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
```

---

## Correctness Properties

### Invariants

1. **Non-Negative Metrics** — All numeric metrics MUST be ≥ 0: duration_ms, tokens, cost_usd, retry_count, error_count
2. **Success Rate Bounds** — success_rate_percent MUST be in range [0, 100] or NULL
3. **Confidence Score Bounds** — confidence_score MUST be in range [0, 1] or NULL
4. **Cold-Start Consistency** — If sample_count < 5, THEN cold_start MUST be true AND all predictions MUST be NULL

### Round-Trip Properties

1. **Cache Consistency** — If cache hit occurs, returned metrics MUST match fresh computation (within cache TTL window)
2. **Export Format Preservation** — CSV export → parse → should reconstruct original metric values (within floating-point precision)

### Bounded Operations

1. **API Response Time** — Performance/cost endpoints MUST respond within 200ms for typical datasets
2. **Query Timeout** — Analytics queries MUST abort after 30 seconds
3. **Cache TTL** — Cached results MUST expire after 5 minutes (300 seconds)

### Statistical Properties

1. **Percentile Ordering** — For any dataset: p50 ≤ p95 ≤ p99
2. **Confidence Inverse Relationship** — Higher coefficient of variation (CV) MUST result in lower confidence_score
3. **Anomaly Threshold** — is_anomalous = true IFF current_duration > 2 × avg_duration

---

## Error Handling

### Failure Modes and Recovery

**Metrics Collection Failure**
- **Detection:** Log parsing throws exception or regex match fails
- **Response:** Log warning "metric extraction failed for <jobId>: <field>: <reason>", store NULL for failed field
- **Recovery:** Partial metrics stored; collection continues for other jobs; manual log inspection may be needed

**Query Timeout**
- **Detection:** Analytics query exceeds 30 seconds
- **Response:** Abort query, return HTTP 503 with error "computation timed out after 30 seconds"
- **Recovery:** Client should reduce query scope (shorter time range, fewer metrics); no automatic retry

**Cold Start (Insufficient Data)**
- **Detection:** Historical sample count < 5 for job type
- **Response:** Return NULL for all predictions with `cold_start: true`
- **Recovery:** Automatic as more jobs complete; predictions become available once ≥5 samples exist

**Cache Invalidation Race**
- **Detection:** Job completes while cached metrics are being served
- **Response:** Stale data served until cache expires (max 5 minutes)
- **Recovery:** Automatic cache expiry; WebSocket broadcast notifies clients of new data

**Database Unavailable During Analytics Query**
- **Detection:** Database query throws exception
- **Response:** Return HTTP 500 with error "analytics computation failed: <reason>"
- **Recovery:** Client may retry; underlying database issue must be resolved (see Phase 5.1 error handling)

**Export Format Error**
- **Detection:** CSV generation fails due to special characters or encoding issues
- **Response:** Return HTTP 500 with error "export failed: <reason>"
- **Recovery:** Client should try JSON export instead; or request smaller dataset

---

## Testing Strategy

### Unit Tests
- Metrics computation (percentiles, averages)
- Cost aggregation
- Bottleneck detection logic
- ETA prediction with cold-start handling

### Integration Tests
- Metrics collector extracts from logs
- Cache invalidation on job completion
- API endpoint response times

### Property-Based Tests
- All numeric metrics ≥ 0
- success_rate_percent in [0, 100]
- Confidence score in [0, 1]

---

## Migration Path

1. **Phase 5.1 → 5.3** — Add job_metrics table, start metrics collector
2. **Historical data** — Metrics collector processes existing .log files on startup
3. **Dashboard integration** — Add Analytics page to dashboard nav
