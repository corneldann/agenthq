// src/routes/memory-extraction.ts
// Route handlers for memory extraction operations.
//
// POST /api/memory/extract/:jobId  — re-trigger extraction for a single job
// POST /api/memory/backfill        — queue extraction for N unprocessed jobs
//
// Both routes require dbReady=true (registered from monitor.ts only when the
// DB has successfully initialised). When MEMORY_EXTRACTION_ENABLED=false,
// the extract endpoint returns 503 immediately; the backfill endpoint also
// returns 503 before any DB query.

import type { Router } from '../router.ts';
import type { DbAdapter, DbJob, DbMemoryExtraction } from '../db/adapter.ts';
import type { IMemoryClient } from '../memory/types.ts';
import type { Job } from '../types.ts';
import { MEMORY_EXTRACTION_ENABLED } from '../constants.ts';
import { extractAndStore } from '../memory/extraction.ts';

// ---------------------------------------------------------------------------
// JSON response helper — keeps handler bodies concise
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// DbJob → Job domain-type projection
// ---------------------------------------------------------------------------

/**
 * Project a `DbJob` row onto the `Job` domain type expected by `extractAndStore`.
 *
 * The DB row uses snake_case; `Job` uses camelCase. Only the fields consumed
 * by the extraction pipeline are mapped here — additional fields are carried
 * over by the spread so the type system remains satisfied.
 */
function jobFromDbRow(row: DbJob): Job {
  return {
    id: row.id,
    name: row.name,
    jobChain: row.job_chain,
    sessionChainId: row.session_chain_id,
    timestamp: row.timestamp,
    type: row.type,
    agent: row.agent,
    status: row.status,
    lines: row.lines,
    lastLine: row.last_line,
    hasLog: row.has_log !== 0,
    logError: row.log_error !== 0,
    mdFile: row.md_file,
    logFile: row.log_file,
    agentDone: row.agent_done,
    sizeBytes: row.size_bytes,
    workspaceId: row.workspace_id,
  };
}

// ---------------------------------------------------------------------------
// register — export consumed by monitor.ts
// ---------------------------------------------------------------------------

/**
 * Register memory-extraction routes on the given router.
 *
 * @param router - Application router instance.
 * @param db     - Initialised database adapter (must be ready).
 * @param client - IMemoryClient used by the extraction pipeline.
 */
export function register(
  router: Router,
  db: DbAdapter,
  client: IMemoryClient,
): void {
  // -----------------------------------------------------------------------
  // POST /api/memory/extract/:jobId
  // Re-trigger extraction for a single completed job.
  //
  // Validation order (per design spec Req 4.2):
  //   1. Feature flag check   → 503 when MEMORY_EXTRACTION_ENABLED=false
  //   2. Job existence check  → 404 when jobId not in DB
  //   3. Run extraction       → extractAndStore (idempotent via upsert)
  //   4. Read back result row → return { jobId, memoryCount, qualityScore }
  // -----------------------------------------------------------------------
  router.post('/api/memory/extract/:jobId', async (_req, params) => {
    // 1. Feature flag — checked before any DB query (Req 4.2(a))
    if (!MEMORY_EXTRACTION_ENABLED) {
      return jsonResponse({ error: 'memory extraction disabled' }, 503);
    }

    const jobId = params.jobId;

    // 2. Job existence check (Req 4.2(b))
    let jobRow: DbJob;
    try {
      const { rows } = await db.query<DbJob>(
        'SELECT * FROM jobs WHERE id = ? AND deleted_at IS NULL',
        [jobId],
      );
      if (rows.length === 0) {
        return jsonResponse({ error: 'not found' }, 404);
      }
      jobRow = rows[0]!;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[memory-extraction] DB query failed for job ${jobId}:`, msg);
      return jsonResponse({ error: 'internal error' }, 500);
    }

    // 3. Run extraction — fires even when a row already exists (overwrite semantics)
    await extractAndStore(jobFromDbRow(jobRow), db, client);

    // 4. Read back the result row and return the response shape
    try {
      const { rows: resultRows } = await db.query<DbMemoryExtraction>(
        'SELECT * FROM memory_extraction WHERE job_id = ? AND deleted_at IS NULL',
        [jobId],
      );
      const row = resultRows[0];
      return jsonResponse(
        {
          jobId,
          memoryCount: row?.memory_count ?? 0,
          qualityScore: row?.quality_score ?? 0,
        },
        200,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[memory-extraction] result read-back failed for job ${jobId}:`, msg);
      // Extraction completed; only the read-back failed — return partial success
      return jsonResponse({ jobId, memoryCount: 0, qualityScore: 0 }, 200);
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/memory/backfill
  // Queue sequential extraction for the N most-recent unprocessed jobs in a
  // workspace (default N=100; capped at 100; minimum 1).
  //
  // Request body: { workspaceId: string, limit?: number }
  // Response:     { queued: number, appliedLimit: number }
  //
  // Validation:
  //   - MEMORY_EXTRACTION_ENABLED=false → 503
  //   - workspaceId missing / empty     → 400
  //   - limit < 1 or non-integer        → 400
  //   - limit > 100                     → silently capped at 100 (Req 4.4)
  // -----------------------------------------------------------------------
  router.post('/api/memory/backfill', async (req, _params) => {
    // Feature flag check (Req 4.3 — 503 applies when explicitly called via HTTP)
    if (!MEMORY_EXTRACTION_ENABLED) {
      return jsonResponse({ error: 'memory extraction disabled' }, 503);
    }

    // Parse and validate request body
    let body: { workspaceId?: unknown; limit?: unknown };
    try {
      body = (await req.json()) as { workspaceId?: unknown; limit?: unknown };
    } catch {
      return jsonResponse({ error: 'invalid JSON body' }, 400);
    }

    // workspaceId — required, must be a non-empty string
    if (typeof body.workspaceId !== 'string' || body.workspaceId.trim() === '') {
      return jsonResponse({ error: 'workspaceId required' }, 400);
    }
    const workspaceId = body.workspaceId.trim();

    // limit — optional; default 100, min 1, max 100 (silent cap)
    let limit = 100;
    if (body.limit !== undefined) {
      if (!Number.isInteger(body.limit) || (body.limit as number) < 1) {
        return jsonResponse({ error: 'limit must be a positive integer' }, 400);
      }
      limit = Math.min(body.limit as number, 100);
    }

    // Query the most-recent unprocessed (no existing memory_extraction row) jobs
    let jobsToProcess: DbJob[];
    try {
      const { rows } = await db.query<DbJob>(
        `SELECT j.*
         FROM jobs j
         LEFT JOIN memory_extraction me
           ON me.job_id = j.id AND me.deleted_at IS NULL
         WHERE j.workspace_id = ?
           AND j.status IN ('done', 'reported')
           AND j.deleted_at IS NULL
           AND me.id IS NULL
         ORDER BY j.timestamp DESC
         LIMIT ?`,
        [workspaceId, limit],
      );
      jobsToProcess = rows;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[memory-extraction] backfill query failed for workspace ${workspaceId}:`, msg);
      return jsonResponse({ error: 'internal error' }, 500);
    }

    // Run extractions sequentially with 500ms delay between each (Req 4.5)
    let queued = 0;
    for (const row of jobsToProcess) {
      await extractAndStore(jobFromDbRow(row), db, client);
      queued++;

      // Delay between jobs to avoid LLM rate-limit bursts — skip after last job
      if (queued < jobsToProcess.length) {
        await new Promise<void>(resolve => setTimeout(resolve, 500));
      }
    }

    return jsonResponse({ queued, appliedLimit: limit }, 200);
  });
}
