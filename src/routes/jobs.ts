// routes/jobs.ts — Job list, log file, and build-queue route handlers.

import type { Router } from '../router.ts';
import type { BuildQueueRecord, Job } from '../types.ts';
import type { IMemoryClient } from '../memory/types.ts';
import type { DbAdapter } from '../db/adapter.ts';
import { OUTPUT_DIR, BUILD_QUEUE_FILE, MEMORY_EXTRACTION_ENABLED } from '../constants.ts';
import { scanJobs } from '../scan/jobs.ts';
import { DefaultConfigurationLoader, type WorkspaceConfig } from '../config/workspace-config.ts';
import { filterByWorkspace, createFilterResponse } from './helpers/filter.ts';
import { scopeFromJob } from '../memory/scopes.ts';
import { GENERIC_REJECT_PATTERNS } from '../memory/extraction.ts';

// ---------------------------------------------------------------------------
// MEMORY marker extraction constants
// ---------------------------------------------------------------------------

const MEMORY_MARKER_REGEX = /^MEMORY:\s*(.+)$/gim;

// ---------------------------------------------------------------------------
// Module-private validation
// ---------------------------------------------------------------------------

/**
 * Validate a fact string against length and pattern rejection rules.
 * 
 * A valid fact must:
 * - Be between 20 and 500 characters (inclusive)
 * - Not match any GENERIC_REJECT_PATTERNS from Phase 6.2
 * 
 * @param text The fact text to validate
 * @returns true if the fact is valid, false otherwise
 */
function isValidFact(text: string): boolean {
  const len = text.length;
  
  // Length check: must be in [20, 500]
  if (len < 20 || len > 500) {
    return false;
  }
  
  // Pattern rejection: must not match any generic reject pattern
  for (const pattern of GENERIC_REJECT_PATTERNS) {
    if (pattern.test(text)) {
      return false;
    }
  }
  
  return true;
}

// ---------------------------------------------------------------------------
// Public marker extraction
// ---------------------------------------------------------------------------

/**
 * Extract MEMORY: markers from agent job output and store them via IMemoryClient.
 * 
 * Scans the output text for lines matching /^MEMORY:\s*(.+)$/gim, validates each
 * fact against length and pattern rules, stores valid facts via client.retain(),
 * and writes a memory_extraction DB record for each successfully stored fact.
 * 
 * Guarded by MEMORY_EXTRACTION_ENABLED feature flag — returns immediately when false.
 * 
 * Individual retain failures are logged at ERROR and skipped (do not abort the flow).
 * Storage-layer validation failures are logged at WARN and skipped.
 * 
 * @param output The raw job output text to scan for MEMORY: markers
 * @param job The Job record providing scope context
 * @param client IMemoryClient for storing validated facts
 * @param db DbAdapter for writing memory_extraction records
 */
export async function extractMarkersFromOutput(
  output: string,
  job: Job,
  client: IMemoryClient,
  db: DbAdapter,
): Promise<void> {
  // Feature flag guard: return early when extraction is disabled
  if (!MEMORY_EXTRACTION_ENABLED) {
    return;
  }

  const matches = [...output.matchAll(MEMORY_MARKER_REGEX)];
  
  if (matches.length === 0) {
    console.debug(`[marker-extraction] job ${job.id}: no MEMORY: markers found`);
    return;
  }
  
  console.debug(`[marker-extraction] job ${job.id}: found ${matches.length} MEMORY: marker(s)`);
  
  const scope = scopeFromJob(job);
  let storedCount = 0;
  let rejectedCount = 0;
  
  for (const match of matches) {
    const fact = match[1]!.trim();
    
    // Pre-storage validation
    if (!isValidFact(fact)) {
      console.debug(
        `[marker-extraction] job ${job.id}: rejected invalid fact (length=${fact.length}): "${fact.slice(0, 80)}"`
      );
      rejectedCount++;
      continue;
    }
    
    // Store via client.retain
    let retainedId: string;
    try {
      retainedId = await client.retain(fact, scope);
    } catch (retainErr) {
      console.error(
        `[marker-extraction] job ${job.id}: client.retain failed for fact "${fact.slice(0, 80)}" — skipping:`,
        retainErr
      );
      // Rely on RetryQueue (handled by MemoryCircuitBreaker) — do not rethrow
      continue;
    }
    
    // Write memory_extraction DB record
    // Marker facts: source='marker', tier='hot', quality_score=1.0
    const extractedAt = new Date().toISOString();
    const lastModified = Date.now();
    
    try {
      await db.execute(
        `INSERT INTO memory_extraction
           (job_id, workspace_id, extracted_at, raw_text, memory_count,
            quality_score, embedding_status, tier, source, last_modified)
         VALUES (?, ?, ?, ?, 1, 1.0, 'embedded', 'hot', 'marker', ?)`,
        [job.id, job.workspaceId, extractedAt, fact, lastModified]
      );
      
      storedCount++;
      console.info(
        `[marker-extraction] job ${job.id}: stored marker fact (id=${retainedId}): "${fact.slice(0, 80)}"`
      );
    } catch (dbErr) {
      // Storage-layer validation failure — log at WARN, do not propagate
      console.warn(
        `[marker-extraction] job ${job.id}: DB insert failed for fact "${fact.slice(0, 80)}" — skipping:`,
        dbErr
      );
    }
  }
  
  console.info(
    `[marker-extraction] job ${job.id}: extraction complete — stored ${storedCount}, rejected ${rejectedCount}`
  );
}

export function register(router: Router): void {
  // ------------------------------------------------------------------
  // GET /jobs — full list of Job objects from OUTPUT_DIR
  // Accepts optional workspaceId query parameter for workspace filtering
  // ------------------------------------------------------------------
  router.get('/jobs', async (req, _params) => {
    // Load workspace configurations for validation
    const configLoader = new DefaultConfigurationLoader();
    let workspaces: WorkspaceConfig[] = [];
    try {
      workspaces = await configLoader.loadWorkspaces();
    } catch (error) {
      // If workspace config fails to load, return error
      return new Response(
        JSON.stringify({ error: 'Failed to load workspace configuration' }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }

    // Extract workspaceId query parameter
    const url = new URL(req.url);
    const workspaceId = url.searchParams.get('workspaceId') || undefined;

    // Scan all jobs
    const jobs = await scanJobs();

    // Apply workspace filtering using common helper
    const filterResult = filterByWorkspace(jobs, workspaceId, workspaces);
    return createFilterResponse(filterResult);
  });

  // ------------------------------------------------------------------
  // GET /log/:id — raw .log file content for a given job stem
  // ------------------------------------------------------------------
  router.get('/log/:id', async (_req, params) => {
    const id = decodeURIComponent(params.id);
    const logPath = `${OUTPUT_DIR}/${id}.log`;
    const file = Bun.file(logPath);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }
    const text = await file.text();
    return new Response(text, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  });

  // ------------------------------------------------------------------
  // GET /build-queue — parsed records from BUILD_QUEUE_FILE
  // Accepts optional workspaceId query parameter for workspace filtering
  // ------------------------------------------------------------------
  router.get('/build-queue', async (req, _params) => {
    // Load workspace configurations for validation
    const configLoader = new DefaultConfigurationLoader();
    let workspaces: WorkspaceConfig[] = [];
    try {
      workspaces = await configLoader.loadWorkspaces();
    } catch (error) {
      // If workspace config fails to load, return error
      return new Response(
        JSON.stringify({ error: 'Failed to load workspace configuration' }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }

    // Extract workspaceId query parameter
    const url = new URL(req.url);
    const workspaceId = url.searchParams.get('workspaceId') || undefined;

    try {
      const text = await Bun.file(BUILD_QUEUE_FILE).text().catch(() => "");
      const records: BuildQueueRecord[] = text
        .split("\n")
        .filter(l => l.trim())
        .map(l => {
          try { return JSON.parse(l) as BuildQueueRecord; } catch { return null; }
        })
        .filter((r): r is BuildQueueRecord => r !== null && !!r.stem);
      
      // Apply workspace filtering using common helper
      const filterResult = filterByWorkspace(records, workspaceId, workspaces);
      return createFilterResponse(filterResult);
    } catch {
      return new Response("[]", {
        headers: { "content-type": "application/json", "connection": "close" },
      });
    }
  });
}
