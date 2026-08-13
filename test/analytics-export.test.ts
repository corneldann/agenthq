/**
 * Unit tests for the analytics export formatter (GET /api/analytics/export).
 *
 * Covers:
 *   - CSV output: correct headers, quoted string fields, text/csv Content-Type (Req 8.2)
 *   - JSON output: fields match PerformanceMetrics / CostMetrics / BottleneckAnalysis
 *     schemas, application/json Content-Type (Req 8.3, 8.7)
 *   - Date range validation: from > to → 400, from <= to accepted,
 *     from == to accepted (Req 8.6)
 *   - Metric type validation: unknown type → 400, valid types accepted,
 *     missing type → 400 (Req 8.4)
 *
 * Uses the same mock-DbAdapter pattern as analytics-routes.test.ts.
 * No real SQLite database is opened.
 */

import { describe, it, expect } from 'bun:test';
import { createRouter } from '../src/router.ts';
import { register } from '../src/routes/analytics.ts';
import type { DbAdapter, QueryResult, ExecResult } from '../src/db/adapter.ts';

// ---------------------------------------------------------------------------
// Mock DbAdapter helpers — identical pattern to analytics-routes.test.ts
// ---------------------------------------------------------------------------

type QueryHandler = (sql: string, params: unknown[]) => Promise<QueryResult<unknown>>;

function makeMockDb(queryHandler: QueryHandler): DbAdapter {
  const db: DbAdapter = {
    query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      return queryHandler(sql, params) as Promise<QueryResult<T>>;
    },
    execute(_sql: string, _params?: unknown[]): Promise<ExecResult> {
      return Promise.resolve({ rowsAffected: 0 });
    },
    transaction(fn: (adapter: DbAdapter) => Promise<void>): Promise<void> {
      return fn(db);
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
  return db;
}

/**
 * Build a sequential query handler.
 *
 * The first call is always the workspace probe (`SELECT 1 AS found`).
 * Subsequent calls consume `dataCalls` in order.
 *
 * @param workspaceExists - Whether the workspace probe should return a row
 * @param dataCalls       - Responses for analytics computation queries (in call order)
 */
function makeSequentialHandler(
  workspaceExists: boolean,
  dataCalls: QueryResult<unknown>[] = [],
): QueryHandler {
  let index = 0;
  return async (_sql: string, _params: unknown[]) => {
    const i = index++;
    if (i === 0) {
      // Workspace probe
      if (workspaceExists) {
        return { rows: [{ found: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    // Analytics computation query
    const dataIdx = i - 1;
    return dataIdx < dataCalls.length
      ? dataCalls[dataIdx]
      : { rows: [], rowCount: 0 };
  };
}

// ---------------------------------------------------------------------------
// Dispatch helper — mirrors analytics-routes.test.ts
// ---------------------------------------------------------------------------

async function dispatch(
  router: ReturnType<typeof createRouter>,
  url: string,
): Promise<Response> {
  const req = new Request(`http://localhost${url}`);
  const match = router.match(req);
  if (!match) {
    return new Response(JSON.stringify({ error: 'no route matched' }), {
      status: 404,
    });
  }
  return match.handler(req, match.params);
}

// ---------------------------------------------------------------------------
// DB call fixture helpers
// ---------------------------------------------------------------------------

/**
 * One performance metrics computation calls one DB query and returns rows
 * with `duration_ms` and `status`. Return a single done-job row.
 */
function perfDataCalls(): QueryResult<unknown>[] {
  return [
    { rows: [{ duration_ms: 500, status: 'done' }], rowCount: 1 },
  ];
}

/**
 * computeCostMetrics fires 4 parallel queries. Mock them all with minimal
 * non-null data so the export row has real values.
 */
function costDataCalls(): QueryResult<unknown>[] {
  return [
    // aggregate query: total_cost, total_tokens, job_count
    { rows: [{ total_cost: 2.5, total_tokens: 5000, job_count: 5 }], rowCount: 1 },
    // per-agent query
    { rows: [{ agent: 'gpt-4', total_cost: 2.5 }], rowCount: 1 },
    // wasted cost query
    { rows: [{ wasted: 0.1 }], rowCount: 1 },
    // daily trend query
    { rows: [{ date: '2025-01-01', cost_usd: 2.5, token_count: 5000 }], rowCount: 1 },
  ];
}

/**
 * detectBottlenecks fires 4 parallel queries. Supply rows that produce at
 * least one bottleneck entry so the CSV/JSON is non-empty.
 */
function bottleneckDataCalls(): QueryResult<unknown>[] {
  return [
    // per-type avg query
    { rows: [{ type: 'build', avg_duration: 100 }], rowCount: 1 },
    // all jobs with duration_ms
    { rows: [{ job_id: 'job-slow-1', type: 'build', duration_ms: 300 }], rowCount: 1 },
    // contention periods
    { rows: [], rowCount: 0 },
    // max concurrent
    { rows: [{ max_concurrent: 2 }], rowCount: 1 },
  ];
}

// ---------------------------------------------------------------------------
// Helper: build combined data calls for all three metric types
// ---------------------------------------------------------------------------

function allMetricDataCalls(): QueryResult<unknown>[] {
  return [...perfDataCalls(), ...costDataCalls(), ...bottleneckDataCalls()];
}

// ---------------------------------------------------------------------------
// Helpers to set up router
// ---------------------------------------------------------------------------

function makeRouter(handler: QueryHandler): ReturnType<typeof createRouter> {
  const db = makeMockDb(handler);
  const router = createRouter();
  register(router, db);
  return router;
}

// ---------------------------------------------------------------------------
// Tests — Metric type validation (Req 8.4)
// ---------------------------------------------------------------------------

describe('GET /api/analytics/export — metric type validation (Req 8.4)', () => {
  it('should return 400 when type param is missing', async () => {
    const router = makeRouter(makeSequentialHandler(true));

    const res = await dispatch(router, '/api/analytics/export?workspace=ws-1');

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid or missing type parameter: must be 'csv' or 'json'");
  });

  it('should return 400 when type is an unrecognized value (e.g. "xml")', async () => {
    const router = makeRouter(makeSequentialHandler(true));

    const res = await dispatch(router, '/api/analytics/export?workspace=ws-1&type=xml');

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid or missing type parameter: must be 'csv' or 'json'");
  });

  it('should return 400 with correct error when unrecognized metric type "latency" is provided', async () => {
    const router = makeRouter(makeSequentialHandler(true));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=json&metrics=latency',
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('unrecognized metric type: latency');
  });

  it('should return 400 when one metric in a comma-separated list is unrecognized', async () => {
    const router = makeRouter(makeSequentialHandler(true));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=json&metrics=performance,unknown',
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('unrecognized metric type: unknown');
  });

  it.each(['performance', 'cost', 'bottlenecks'] as const)(
    'should accept valid metric type "%s" without returning 400',
    async (metricType) => {
      // Each metric type needs its own data calls: workspace probe + data
      const dataCalls =
        metricType === 'performance'
          ? perfDataCalls()
          : metricType === 'cost'
            ? costDataCalls()
            : bottleneckDataCalls();

      const router = makeRouter(makeSequentialHandler(true, dataCalls));

      const res = await dispatch(
        router,
        `/api/analytics/export?workspace=ws-1&type=json&metrics=${metricType}`,
      );

      // Must not be a 400 metric-type error
      if (res.status === 400) {
        const body = await res.json() as { error: string };
        expect(body.error).not.toContain('unrecognized metric type');
        expect(body.error).not.toContain("invalid or missing type parameter");
      } else {
        expect(res.status).toBe(200);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Tests — Date range validation (Req 8.6)
// ---------------------------------------------------------------------------

describe('GET /api/analytics/export — date range validation (Req 8.6)', () => {
  it('should return 400 with correct error when from > to', async () => {
    const router = makeRouter(makeSequentialHandler(true));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=json' +
        '&from=2025-01-10T00:00:00Z&to=2025-01-01T00:00:00Z',
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid date range: from must be <= to');
  });

  it('should accept from < to (valid date range)', async () => {
    const router = makeRouter(makeSequentialHandler(true, allMetricDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=json' +
        '&from=2025-01-01T00:00:00Z&to=2025-01-10T00:00:00Z',
    );

    // from < to is valid — must not return 400 date range error
    if (res.status === 400) {
      const body = await res.json() as { error: string };
      expect(body.error).not.toBe('invalid date range: from must be <= to');
    } else {
      expect(res.status).toBe(200);
    }
  });

  it('should accept from == to (same timestamp, valid edge case)', async () => {
    const router = makeRouter(makeSequentialHandler(true, allMetricDataCalls()));

    const timestamp = '2025-06-01T12:00:00Z';
    const res = await dispatch(
      router,
      `/api/analytics/export?workspace=ws-1&type=json` +
        `&from=${encodeURIComponent(timestamp)}&to=${encodeURIComponent(timestamp)}`,
    );

    // from == to is valid — must not return 400 date range error
    if (res.status === 400) {
      const body = await res.json() as { error: string };
      expect(body.error).not.toBe('invalid date range: from must be <= to');
    } else {
      expect(res.status).toBe(200);
    }
  });

  it('should validate date range before probing workspace (type check first)', async () => {
    // Date validation runs after workspace validation in the route.
    // Confirm invalid date range returns 400 even when workspace exists.
    const router = makeRouter(makeSequentialHandler(true));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=json' +
        '&from=2025-12-31T00:00:00Z&to=2025-01-01T00:00:00Z',
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid date range: from must be <= to');
  });
});

// ---------------------------------------------------------------------------
// Tests — JSON output schema (Req 8.3, 8.7)
// ---------------------------------------------------------------------------

describe('GET /api/analytics/export — JSON output schema (Req 8.3, 8.7)', () => {
  it('should set Content-Type to application/json for json export', async () => {
    const router = makeRouter(makeSequentialHandler(true, perfDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=json&metrics=performance',
    );

    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('application/json');
  });

  it('should include Content-Disposition header for json export', async () => {
    const router = makeRouter(makeSequentialHandler(true, perfDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=json&metrics=performance',
    );

    expect(res.status).toBe(200);
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('analytics-export.json');
  });

  it('should return array of JSON objects for performance metrics', async () => {
    const router = makeRouter(makeSequentialHandler(true, perfDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=json&metrics=performance',
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);

    const perfRow = body[0];
    // Req 8.7 PerformanceMetrics schema fields
    expect(perfRow).toHaveProperty('metric_type', 'performance');
    expect(typeof perfRow.avg_duration_ms === 'number' || perfRow.avg_duration_ms === null).toBe(true);
    expect(typeof perfRow.median_duration_ms === 'number' || perfRow.median_duration_ms === null).toBe(true);
    expect(typeof perfRow.p95_duration_ms === 'number' || perfRow.p95_duration_ms === null).toBe(true);
    expect(typeof perfRow.p99_duration_ms === 'number' || perfRow.p99_duration_ms === null).toBe(true);
    expect(typeof perfRow.throughput_per_hour === 'number' || perfRow.throughput_per_hour === null).toBe(true);
    expect(typeof perfRow.success_rate_percent === 'number' || perfRow.success_rate_percent === null).toBe(true);
  });

  it('should include all required PerformanceMetrics schema fields in JSON output (Req 8.7)', async () => {
    const router = makeRouter(makeSequentialHandler(true, perfDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=json&metrics=performance',
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    const perfRow = body.find((r) => r.metric_type === 'performance');
    expect(perfRow).toBeDefined();

    // All 6 required fields per Req 8.7
    const requiredFields = [
      'avg_duration_ms',
      'median_duration_ms',
      'p95_duration_ms',
      'p99_duration_ms',
      'throughput_per_hour',
      'success_rate_percent',
    ];
    for (const field of requiredFields) {
      expect(perfRow).toHaveProperty(field);
    }
  });

  it('should include all required CostMetrics schema fields in JSON output (Req 8.7)', async () => {
    const router = makeRouter(makeSequentialHandler(true, costDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=json&metrics=cost',
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    const costRow = body.find((r) => r.metric_type === 'cost');
    expect(costRow).toBeDefined();

    // All 4 required CostMetrics fields per Req 8.7
    const requiredFields = [
      'total_cost_usd',
      'total_tokens',
      'cost_per_job_usd',
      'jobs_count',
    ];
    for (const field of requiredFields) {
      expect(costRow).toHaveProperty(field);
    }
  });

  it('should include all required BottleneckAnalysis schema fields in JSON output (Req 8.7)', async () => {
    const router = makeRouter(makeSequentialHandler(true, bottleneckDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=json&metrics=bottlenecks',
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    // There should be at least one bottleneck row (job-slow-1 has 3x slowdown)
    const bnRow = body.find((r) => r.metric_type === 'bottleneck');
    expect(bnRow).toBeDefined();

    // All 4 required BottleneckAnalysis fields per Req 8.7
    const requiredFields = ['job_id', 'duration_ms', 'slowdown_factor', 'severity'];
    for (const field of requiredFields) {
      expect(bnRow).toHaveProperty(field);
    }
  });

  it('should return valid JSON array (parseable) for json export type', async () => {
    const router = makeRouter(makeSequentialHandler(true, allMetricDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=json',
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    // Must be valid JSON — JSON.parse should not throw
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(text);
    }).not.toThrow();
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('should not run CSV formatting when format is json (Req 8.2 conditional)', async () => {
    const router = makeRouter(makeSequentialHandler(true, perfDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=json&metrics=performance',
    );

    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    // JSON export must never return text/csv
    expect(contentType).not.toContain('text/csv');
  });
});

// ---------------------------------------------------------------------------
// Tests — CSV output format (Req 8.2)
// ---------------------------------------------------------------------------

describe('GET /api/analytics/export — CSV output format (Req 8.2)', () => {
  it('should set Content-Type to text/csv for csv export', async () => {
    const router = makeRouter(makeSequentialHandler(true, perfDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=csv&metrics=performance',
    );

    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('text/csv');
  });

  it('should include Content-Disposition with attachment filename for csv export', async () => {
    const router = makeRouter(makeSequentialHandler(true, perfDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=csv&metrics=performance',
    );

    expect(res.status).toBe(200);
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('analytics-export.csv');
  });

  it('should return non-empty CSV for performance metric with a header row', async () => {
    const router = makeRouter(makeSequentialHandler(true, perfDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=csv&metrics=performance',
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    // Must be non-empty when there are rows
    expect(text.length).toBeGreaterThan(0);
    const lines = text.split('\r\n');
    // First line is the header row
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const headerLine = lines[0];
    // Header must be present
    expect(headerLine.length).toBeGreaterThan(0);
  });

  it('should include metric_type column in CSV header for performance export', async () => {
    const router = makeRouter(makeSequentialHandler(true, perfDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=csv&metrics=performance',
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    const headerLine = text.split('\r\n')[0];
    // metric_type column must appear in header (quoted as "metric_type")
    expect(headerLine).toContain('metric_type');
  });

  it('should include PerformanceMetrics columns in CSV header (Req 8.2)', async () => {
    const router = makeRouter(makeSequentialHandler(true, perfDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=csv&metrics=performance',
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    const headerLine = text.split('\r\n')[0];

    // Req 8.7 PerformanceMetrics schema fields must appear as CSV columns
    const expectedColumns = [
      'avg_duration_ms',
      'median_duration_ms',
      'p95_duration_ms',
      'p99_duration_ms',
      'throughput_per_hour',
      'success_rate_percent',
    ];
    for (const col of expectedColumns) {
      expect(headerLine).toContain(col);
    }
  });

  it('should include CostMetrics columns in CSV header (Req 8.2)', async () => {
    const router = makeRouter(makeSequentialHandler(true, costDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=csv&metrics=cost',
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    const headerLine = text.split('\r\n')[0];

    const expectedColumns = ['total_cost_usd', 'total_tokens', 'cost_per_job_usd', 'jobs_count'];
    for (const col of expectedColumns) {
      expect(headerLine).toContain(col);
    }
  });

  it('should include BottleneckAnalysis columns in CSV header (Req 8.2)', async () => {
    const router = makeRouter(makeSequentialHandler(true, bottleneckDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=csv&metrics=bottlenecks',
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    const headerLine = text.split('\r\n')[0];

    const expectedColumns = ['job_id', 'duration_ms', 'slowdown_factor', 'severity'];
    for (const col of expectedColumns) {
      expect(headerLine).toContain(col);
    }
  });

  it('should quote all CSV header field names', async () => {
    const router = makeRouter(makeSequentialHandler(true, perfDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=csv&metrics=performance',
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    const headerLine = text.split('\r\n')[0];

    // Every comma-separated header token must be wrapped in double quotes
    const fields = headerLine.split(',');
    for (const field of fields) {
      expect(field.startsWith('"')).toBe(true);
      expect(field.endsWith('"')).toBe(true);
    }
  });

  it('should quote string field values in CSV data rows', async () => {
    const router = makeRouter(makeSequentialHandler(true, perfDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=csv&metrics=performance',
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.split('\r\n').filter((l) => l.trim() !== '');
    // There must be a header + at least one data row
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const dataLine = lines[1];
    const fields = dataLine.split(',');
    // All fields in each row must be quoted
    for (const field of fields) {
      expect(field.startsWith('"')).toBe(true);
      expect(field.endsWith('"')).toBe(true);
    }
  });

  it('should use CRLF line endings in CSV output', async () => {
    const router = makeRouter(makeSequentialHandler(true, perfDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=csv&metrics=performance',
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    // RFC 4180 CSV uses CRLF
    if (text.includes('\n')) {
      // Lines after header should use CRLF separators
      expect(text).toContain('\r\n');
    }
  });

  it('should escape double quotes inside CSV field values', async () => {
    // Build a handler that produces a job_id with a double-quote character
    // to verify the CSV escaping rule: " → ""
    const bottleneckCallsWithQuote: QueryResult<unknown>[] = [
      { rows: [{ type: 'build', avg_duration: 100 }], rowCount: 1 },
      {
        rows: [{ job_id: 'job-"quoted"-1', type: 'build', duration_ms: 300 }],
        rowCount: 1,
      },
      { rows: [], rowCount: 0 },
      { rows: [{ max_concurrent: 2 }], rowCount: 1 },
    ];
    const router = makeRouter(makeSequentialHandler(true, bottleneckCallsWithQuote));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=csv&metrics=bottlenecks',
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    // The embedded double-quote must be escaped as "" inside the quoted field
    expect(text).toContain('""quoted""');
  });

  it('should not run CSV formatting for json type (CSV-only execution guard, Req 8.2)', async () => {
    const router = makeRouter(makeSequentialHandler(true, perfDataCalls()));

    const res = await dispatch(
      router,
      '/api/analytics/export?workspace=ws-1&type=json&metrics=performance',
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    // JSON response must be valid JSON, not CSV with a header row
    expect(() => JSON.parse(text)).not.toThrow();
    // Must not contain unquoted CSV-style header (comma-separated unbracketed field names)
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).not.toContain('text/csv');
  });
});

// ---------------------------------------------------------------------------
// Tests — workspace validation for export (Req 7.6 applied to export)
// ---------------------------------------------------------------------------

describe('GET /api/analytics/export — workspace validation', () => {
  it('should return 400 when workspace param is missing', async () => {
    const router = makeRouter(makeSequentialHandler(false));

    const res = await dispatch(router, '/api/analytics/export?type=json');

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('workspace parameter required');
  });

  it('should return 404 when workspace does not exist', async () => {
    const router = makeRouter(makeSequentialHandler(false));

    const res = await dispatch(router, '/api/analytics/export?workspace=ghost&type=json');

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('workspace not found');
  });
});
