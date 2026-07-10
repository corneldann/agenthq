// src/routes/git.ts
// Route handlers for git operations: GET /git-status, POST /git-commit

import path from 'node:path';
import type { Router } from '../router.ts';
import type { GitStatus, GitCommitResult } from '../types.ts';
import { WORKSPACE_ROOT, KIRO_TOOLS_DIR } from '../constants.ts';
import { DefaultConfigurationLoader, type WorkspaceConfig } from '../config/workspace-config.ts';
import { filterByWorkspace, createFilterResponse } from './helpers/filter.ts';
import { scanGitStatus } from '../scan/git.ts';

export function register(router: Router): void {
  // GET /git-status — repository state via git status --porcelain -b
  // Accepts optional workspaceId query parameter for workspace filtering
  router.get('/git-status', async (req, _params) => {
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

    // Handle zero workspaces case per Requirement 7.3.1
    if (workspaces.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No workspaces configured' }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }

    // Scan git status for all configured workspaces
    const gitStatuses: GitStatus[] = await Promise.all(
      workspaces.map(workspace => 
        scanGitStatus(workspace.WORKSPACE_ROOT, workspace.id)
      )
    );

    // Apply workspace filtering using common helper
    const filterResult = filterByWorkspace(gitStatuses, workspaceId, workspaces);
    return createFilterResponse(filterResult);
  });

  // POST /git-commit — spawn git-commit-worker.ps1 and return jobStem
  router.post('/git-commit', async (_req, _params) => {
    try {
      const workerScript = path.join(KIRO_TOOLS_DIR, 'git-commit-worker.ps1');
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const jobStem = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
        + `-${pad(now.getHours())}${pad(now.getMinutes())}-git-commit`;
      Bun.spawn(
        ['powershell.exe', '-ExecutionPolicy', 'Bypass', '-File', workerScript],
        { cwd: WORKSPACE_ROOT, stdout: 'ignore', stderr: 'ignore' }
      );
      const result: GitCommitResult = { jobStem };
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json', 'connection': 'close' },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: `failed to spawn git-commit-worker: ${msg}` }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
  });
}
