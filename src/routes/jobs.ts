// routes/jobs.ts — Job list, log file, and build-queue route handlers.

import type { Router } from '../router.ts';
import type { BuildQueueRecord } from '../types.ts';
import { OUTPUT_DIR, BUILD_QUEUE_FILE } from '../constants.ts';
import { scanJobs } from '../scan/jobs.ts';
import { DefaultConfigurationLoader, type WorkspaceConfig } from '../config/workspace-config.ts';
import { filterByWorkspace, createFilterResponse } from './helpers/filter.ts';

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
