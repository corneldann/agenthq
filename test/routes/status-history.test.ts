/**
 * Unit tests for the status-history route.
 *
 * Uses a minimal mock DbAdapter — no real SQLite database is opened.
 *
 * Requirements: 4.4, 4.5, 12.1
 */

import { describe, it, expect } from 'bun:test';
import { createRouter } from '../../src/router.ts';
import { register } from '../../src/routes/status-history.ts';
import type { DbAdapter, QueryResult, ExecResult } from '../../src/db/adapter.ts';
import type { DbJobStatusHistory } from '../../src/db/adapter.ts';

// ---------------------------------------------------------------------------
// Mock DbAdapter factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal DbAdapter whose `query` method returns the provided rows.
 * Captures the last SQL and params so tests can assert against them.
 */
function makeMockDb(rows: DbJobStatusHistory[]): {
  db: DbAdapter;
  lastSql: () => string;
  lastParams: () => unknown[];
} {
  let capturedSql = '';
  let capturedParams: unknown[] = [];

  const db: DbAdapter = {
    async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      capturedSql = sql;
      capturedParams = params;
      return { rows: rows as unknown as T[], rowCount: rows.length };
    },
    async execute(_sql: string, _params?: unknown[]): Promise<ExecResult> {
      return { rowsAffected: 0 };
    },
    async transaction(fn: (adapter: DbAdapter) => Promise<void>): Promise<void> {
      await fn(db);
    },
    async close(): Promise<void> {
      // no-op
    },
  };

  return {
    db,
    lastSql: () => capturedSql,
    lastParams: () => capturedParams,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<DbJobStatusHistory> = {}): DbJobStatusHistory {
  return {
    id: 1,
    job_id: 'job-abc',
    workspace_id: 'ws-1',
    old_status: 'running',
    new_status: 'done',
    reason: null,
    changed_at: '2024-06-01T10:00:00Z',
    ...overrides,
  };
}

async function dispatch(router: ReturnType<typeof createRouter>, url: string): Promise<Response> {
  const req = new Request(`http://localhost${url}`);
  const match = router.match(req);
  if (!match) {
    return new Response(JSON.stringify({ error: 'no route matched' }), { status: 404 });
  }
  return match.handler(req, match.params);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/status-history/:jobId', () => {
  // -------------------------------------------------------------------------
  // 1. Known job with transitions
  // -------------------------------------------------------------------------
  it('returns 200 with ordered transitions array for a known jobId', async () => {
    const row1 = makeRow({
      id: 2,
      old_status: 'running',
      new_status: 'done',
      changed_at: '2024-06-01T12:00:00Z',
      reason: null,
    });
    const row2 = makeRow({
      id: 1,
      old_status: 'queued',
      new_status: 'running',
      changed_at: '2024-06-01T10:00:00Z',
      reason: null,
    });

    // Rows already ordered DESC (as the DB would return them)
    const { db } = makeMockDb([row1, row2]);
    const router = createRouter();
    register(router, db);

    const res = await dispatch(router, '/api/status-history/job-abc');

    expect(res.status).toBe(200);

    const body = await res.json() as { jobId: string; transitions: unknown[] };
    expect(body.jobId).toBe('job-abc');
    expect(body.transitions).toHaveLength(2);

    // First transition (most recent) should correspond to row1
    const t0 = body.transitions[0] as {
      oldStatus: string;
      newStatus: string;
      timestamp: string;
      reason: null;
    };
    expect(t0.oldStatus).toBe('running');
    expect(t0.newStatus).toBe('done');
    expect(t0.timestamp).toBe('2024-06-01T12:00:00Z');
    expect(t0.reason).toBeNull();

    // Second transition corresponds to row2
    const t1 = body.transitions[1] as {
      oldStatus: string;
      newStatus: string;
      timestamp: string;
      reason: null;
    };
    expect(t1.oldStatus).toBe('queued');
    expect(t1.newStatus).toBe('running');
    expect(t1.timestamp).toBe('2024-06-01T10:00:00Z');
  });

  // -------------------------------------------------------------------------
  // 2. Unknown jobId — returns 404
  // -------------------------------------------------------------------------
  it('returns 404 with error body when no rows exist for jobId', async () => {
    const { db } = makeMockDb([]);
    const router = createRouter();
    register(router, db);

    const res = await dispatch(router, '/api/status-history/unknown-job');

    expect(res.status).toBe(404);

    const body = await res.json() as { error: string };
    expect(body.error).toBe('job not found');
  });

  // -------------------------------------------------------------------------
  // 3. Parameterized query — no string interpolation
  // -------------------------------------------------------------------------
  it('uses parameterized query with ? placeholder and passes jobId as parameter', async () => {
    const { db, lastSql, lastParams } = makeMockDb([makeRow()]);
    const router = createRouter();
    register(router, db);

    await dispatch(router, '/api/status-history/job-xyz');

    const sql = lastSql();
    const params = lastParams();

    // The SQL must contain a ? placeholder (parameterized)
    expect(sql).toContain('?');
    // The SQL must NOT contain the raw jobId inline
    expect(sql).not.toContain('job-xyz');
    // The jobId must be passed as a parameter
    expect(params).toContain('job-xyz');
  });

  // -------------------------------------------------------------------------
  // 4. Reason field is preserved when present
  // -------------------------------------------------------------------------
  it('maps reason column to reason field in transition', async () => {
    const row = makeRow({
      old_status: 'running',
      new_status: 'error',
      reason: 'process exited with code 1',
    });

    const { db } = makeMockDb([row]);
    const router = createRouter();
    register(router, db);

    const res = await dispatch(router, '/api/status-history/job-abc');
    expect(res.status).toBe(200);

    const body = await res.json() as { transitions: Array<{ reason: string | null }> };
    expect(body.transitions[0]?.reason).toBe('process exited with code 1');
  });

  // -------------------------------------------------------------------------
  // 5. Content-Type header
  // -------------------------------------------------------------------------
  it('sets content-type: application/json on success', async () => {
    const { db } = makeMockDb([makeRow()]);
    const router = createRouter();
    register(router, db);

    const res = await dispatch(router, '/api/status-history/job-abc');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('sets content-type: application/json on 404', async () => {
    const { db } = makeMockDb([]);
    const router = createRouter();
    register(router, db);

    const res = await dispatch(router, '/api/status-history/no-such-job');
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
