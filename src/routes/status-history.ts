// routes/status-history.ts — Status history route handler.
//
// Exposes GET /api/status-history/:jobId which returns the full transition
// history for a given job, ordered by most-recent first.
//
// Requirements: 4.4, 4.5, 11.1

import type { Router } from '../router.ts';
import type { DbAdapter, DbJobStatusHistory } from '../db/adapter.ts';

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

interface StatusTransition {
  oldStatus: string;
  newStatus: string;
  timestamp: string;
  reason: string | null;
}

interface StatusHistoryResponse {
  jobId: string;
  transitions: StatusTransition[];
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register the status-history route onto `router`.
 *
 * @param router - The app router
 * @param db     - Database adapter used to query job_status_history
 */
export function register(router: Router, db: DbAdapter): void {
  // ------------------------------------------------------------------------
  // GET /api/status-history/:jobId
  //
  // Returns ordered transition history for the given jobId.
  // 404 when no rows exist for the jobId (Req 4.5).
  // ------------------------------------------------------------------------
  router.get('/api/status-history/:jobId', async (_req, params) => {
    const jobId = params['jobId'];

    // Parameterized query — never string-interpolates user input (Req 11.1)
    const result = await db.query<DbJobStatusHistory>(
      'SELECT * FROM job_status_history WHERE job_id = ? ORDER BY changed_at DESC',
      [jobId]
    );

    if (result.rows.length === 0) {
      return new Response(
        JSON.stringify({ error: 'job not found' }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      );
    }

    const transitions: StatusTransition[] = result.rows.map((row) => ({
      oldStatus: row.old_status,
      newStatus: row.new_status,
      timestamp: row.changed_at,
      reason: row.reason,
    }));

    const body: StatusHistoryResponse = { jobId, transitions };

    return new Response(
      JSON.stringify(body),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
}
