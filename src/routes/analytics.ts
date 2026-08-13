/**
 * Analytics REST route handlers.
 *
 * Registers four analytics endpoints and one export endpoint:
 *   GET /api/analytics/performance
 *   GET /api/analytics/cost
 *   GET /api/analytics/bottlenecks
 *   GET /api/analytics/predictions
 *   GET /api/analytics/export
 *
 * All computation results are wrapped in a 30-second timeout (Req 10.1).
 * Cache-then-compute pattern is applied for workspace-scoped endpoints (Req 2.7).
 * Workspace existence is validated via a lightweight DB probe (Req 7.6).
 * Job existence is validated before predictive computation (Req 7.7).
 */

import type { Router } from '../router.ts';
import type { DbAdapter } from '../db/adapter.ts';
import { computePerformanceMetrics } from '../analytics/metrics.ts';
import { computeCostMetrics } from '../analytics/cost.ts';
import { detectBottlenecks } from '../analytics/bottleneck.ts';
import { estimateETA } from '../analytics/predictions.ts';
import { analyticsCache } from '../analytics/cache.ts';
import type { PerformanceMetrics } from '../analytics/metrics.ts';
import type { CostMetrics } from '../analytics/cost.ts';
import type { BottleneckAnalysis } from '../analytics/bottleneck.ts';
import type { PredictiveMetrics } from '../analytics/predictions.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout for any single analytics computation (AC 10.1). */
const COMPUTATION_TIMEOUT_MS = 30_000;

/** Accepted time-range tokens. */
const VALID_RANGES = ['24h', '7d', '30d'] as const;
type Range = (typeof VALID_RANGES)[number];

/** Accepted export metric types. */
const VALID_METRIC_TYPES = ['performance', 'cost', 'bottlenecks'] as const;
type MetricType = (typeof VALID_METRIC_TYPES)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a promise in a 30-second timeout.
 *
 * Rejects with `Error('TIMEOUT')` if the computation does not complete in
 * time (AC 10.1). Callers should catch and convert to HTTP 503.
 */
function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('TIMEOUT')),
        COMPUTATION_TIMEOUT_MS,
      ),
    ),
  ]);
}

/** Build a JSON error response with the given HTTP status. */
function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build a JSON success response. */
function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Validate the `range` query parameter.
 *
 * Returns the typed range on success, or a 400 Response on failure (AC 7.5).
 */
function parseRange(
  raw: string | null,
): { ok: true; range: Range } | { ok: false; response: Response } {
  if (raw === null || !(VALID_RANGES as readonly string[]).includes(raw)) {
    return {
      ok: false,
      response: errorResponse(
        400,
        'invalid range: must be one of [24h, 7d, 30d]',
      ),
    };
  }
  return { ok: true, range: raw as Range };
}

/**
 * Validate the `workspace` query parameter and confirm it exists in the DB.
 *
 * Returns the workspaceId on success or an appropriate error Response (AC 7.6).
 * HTTP 400 when the parameter is missing, HTTP 404 when no jobs exist for it.
 */
async function validateWorkspace(
  raw: string | null,
  db: DbAdapter,
): Promise<{ ok: true; workspaceId: string } | { ok: false; response: Response }> {
  if (raw === null || raw.trim() === '') {
    return {
      ok: false,
      response: errorResponse(400, 'workspace parameter required'),
    };
  }

  // Probe the jobs table; a zero-row result means workspace not found (AC 7.6).
  let probeResult: { rows: unknown[] };
  try {
    probeResult = await db.query<{ found: number }>(
      `SELECT 1 AS found FROM jobs WHERE workspace_id = ? LIMIT 1`,
      [raw],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      response: errorResponse(500, `analytics computation failed: ${msg}`),
    };
  }

  if (probeResult.rows.length === 0) {
    return {
      ok: false,
      response: errorResponse(404, 'workspace not found'),
    };
  }

  return { ok: true, workspaceId: raw };
}

// ---------------------------------------------------------------------------
// CSV export formatter
// ---------------------------------------------------------------------------

/** Quote a CSV field value: wrap in double quotes and escape inner quotes. */
function csvQuote(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

/** Serialise an array of record objects to CSV with a header row. */
function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const headerRow = headers.map(csvQuote).join(',');
  const dataRows = rows.map((row) =>
    headers.map((h) => csvQuote(row[h])).join(','),
  );
  return [headerRow, ...dataRows].join('\r\n');
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register all analytics routes on the provided router.
 *
 * Must be called after the DB has finished initialising (see `monitor.ts`).
 *
 * @param router - Application router
 * @param db     - Initialised database adapter
 */
export function register(router: Router, db: DbAdapter): void {
  // -------------------------------------------------------------------------
  // GET /api/analytics/performance
  // -------------------------------------------------------------------------
  router.get('/api/analytics/performance', async (req, _params) => {
    const url = new URL(req.url);

    const rangeResult = parseRange(url.searchParams.get('range'));
    if (!rangeResult.ok) return rangeResult.response;

    const wsResult = await validateWorkspace(url.searchParams.get('workspace'), db);
    if (!wsResult.ok) return wsResult.response;

    const { range } = rangeResult;
    const { workspaceId } = wsResult;
    const cacheKey = `perf:${workspaceId}:${range}`;

    const cached = analyticsCache.get<PerformanceMetrics>(cacheKey);
    if (cached !== null) return jsonResponse(cached);

    try {
      const metrics = await withTimeout(
        computePerformanceMetrics(db, workspaceId, range),
      );
      analyticsCache.set(cacheKey, metrics);
      return jsonResponse(metrics);
    } catch (err) {
      if (err instanceof Error && err.message === 'TIMEOUT') {
        return errorResponse(503, 'computation timed out after 30 seconds');
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errorResponse(500, `analytics computation failed: ${msg}`);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/analytics/cost
  // -------------------------------------------------------------------------
  router.get('/api/analytics/cost', async (req, _params) => {
    const url = new URL(req.url);

    const rangeResult = parseRange(url.searchParams.get('range'));
    if (!rangeResult.ok) return rangeResult.response;

    const wsResult = await validateWorkspace(url.searchParams.get('workspace'), db);
    if (!wsResult.ok) return wsResult.response;

    const { range } = rangeResult;
    const { workspaceId } = wsResult;
    const cacheKey = `cost:${workspaceId}:${range}`;

    const cached = analyticsCache.get<CostMetrics>(cacheKey);
    if (cached !== null) return jsonResponse(cached);

    try {
      const metrics = await withTimeout(
        computeCostMetrics(db, workspaceId, range),
      );
      analyticsCache.set(cacheKey, metrics);
      return jsonResponse(metrics);
    } catch (err) {
      if (err instanceof Error && err.message === 'TIMEOUT') {
        return errorResponse(503, 'computation timed out after 30 seconds');
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errorResponse(500, `analytics computation failed: ${msg}`);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/analytics/bottlenecks
  // -------------------------------------------------------------------------
  router.get('/api/analytics/bottlenecks', async (req, _params) => {
    const url = new URL(req.url);

    const wsResult = await validateWorkspace(url.searchParams.get('workspace'), db);
    if (!wsResult.ok) return wsResult.response;

    const { workspaceId } = wsResult;
    const cacheKey = `bottleneck:${workspaceId}`;

    const cached = analyticsCache.get<BottleneckAnalysis>(cacheKey);
    if (cached !== null) return jsonResponse(cached);

    try {
      const analysis = await withTimeout(detectBottlenecks(db, workspaceId));
      analyticsCache.set(cacheKey, analysis);
      return jsonResponse(analysis);
    } catch (err) {
      if (err instanceof Error && err.message === 'TIMEOUT') {
        return errorResponse(503, 'computation timed out after 30 seconds');
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errorResponse(500, `analytics computation failed: ${msg}`);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/analytics/predictions
  // -------------------------------------------------------------------------
  router.get('/api/analytics/predictions', async (req, _params) => {
    const url = new URL(req.url);
    const jobId = url.searchParams.get('jobId');

    if (jobId === null || jobId.trim() === '') {
      return errorResponse(400, 'jobId parameter required');
    }

    try {
      const metrics = await withTimeout(estimateETA(db, jobId));
      return jsonResponse(metrics);
    } catch (err) {
      if (err instanceof Error && err.message === 'TIMEOUT') {
        return errorResponse(503, 'computation timed out after 30 seconds');
      }
      if (
        err instanceof Error &&
        err.message === 'Job not found or not running'
      ) {
        return errorResponse(404, 'job not found');
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errorResponse(500, `analytics computation failed: ${msg}`);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/analytics/export
  // -------------------------------------------------------------------------
  router.get('/api/analytics/export', async (req, _params) => {
    const url = new URL(req.url);

    // Validate export type (AC 8.1).
    const exportType = url.searchParams.get('type');
    if (exportType === null || !['csv', 'json'].includes(exportType)) {
      return errorResponse(
        400,
        "invalid or missing type parameter: must be 'csv' or 'json'",
      );
    }

    // Validate requested metric types (AC 8.4).
    const metricsParam = url.searchParams.get('metrics');
    const requestedTypes: MetricType[] = [];
    if (metricsParam !== null && metricsParam.trim() !== '') {
      for (const raw of metricsParam.split(',').map((s) => s.trim())) {
        if (!(VALID_METRIC_TYPES as readonly string[]).includes(raw)) {
          return errorResponse(400, `unrecognized metric type: ${raw}`);
        }
        requestedTypes.push(raw as MetricType);
      }
    } else {
      // Default: export all metric types.
      requestedTypes.push(...VALID_METRIC_TYPES);
    }

    // Validate date range (AC 8.6).
    const fromParam = url.searchParams.get('from');
    const toParam = url.searchParams.get('to');
    if (fromParam !== null && toParam !== null) {
      const fromMs = Date.parse(fromParam);
      const toMs = Date.parse(toParam);
      if (!isNaN(fromMs) && !isNaN(toMs) && fromMs > toMs) {
        return errorResponse(400, 'invalid date range: from must be <= to');
      }
    }

    // Workspace is required for export to scope the data.
    const wsResult = await validateWorkspace(url.searchParams.get('workspace'), db);
    if (!wsResult.ok) return wsResult.response;
    const { workspaceId } = wsResult;

    // Collect requested metrics.
    type ExportRow = Record<string, unknown>;
    const exportRows: ExportRow[] = [];

    try {
      await withTimeout(
        (async () => {
          if (requestedTypes.includes('performance')) {
            const perf = await computePerformanceMetrics(db, workspaceId, '30d');
            exportRows.push({
              metric_type: 'performance',
              avg_duration_ms: perf.avg_duration_ms,
              median_duration_ms: perf.median_duration_ms,
              p95_duration_ms: perf.p95_duration_ms,
              p99_duration_ms: perf.p99_duration_ms,
              throughput_per_hour: perf.throughput_per_hour,
              success_rate_percent: perf.success_rate_percent,
            });
          }

          if (requestedTypes.includes('cost')) {
            const cost = await computeCostMetrics(db, workspaceId, '30d');
            exportRows.push({
              metric_type: 'cost',
              total_cost_usd: cost.total_cost_usd,
              total_tokens: cost.total_tokens,
              cost_per_job_usd: cost.cost_per_job_usd,
              jobs_count: cost.jobs_count,
            });
          }

          if (requestedTypes.includes('bottlenecks')) {
            const bn = await detectBottlenecks(db, workspaceId);
            for (const job of bn.slowest_jobs) {
              exportRows.push({
                metric_type: 'bottleneck',
                job_id: job.job_id,
                duration_ms: job.duration_ms,
                slowdown_factor: job.slowdown_factor,
                severity: job.severity,
              });
            }
          }
        })(),
      );
    } catch (err) {
      if (err instanceof Error && err.message === 'TIMEOUT') {
        return errorResponse(503, 'computation timed out after 30 seconds');
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errorResponse(500, `analytics computation failed: ${msg}`);
    }

    const filename = `analytics-export.${exportType}`;

    // AC 8.2: CSV export — only runs when format is "csv".
    if (exportType === 'csv') {
      const csv = toCsv(exportRows);
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    // AC 8.3: JSON export.
    return new Response(JSON.stringify(exportRows), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  });
}
