// src/routes/git.ts
// Route handlers for git operations: GET /git-status, POST /git-commit

import path from 'node:path';
import type { Router } from '../router.ts';
import type { GitStatus, GitCommitResult } from '../types.ts';
import { WORKSPACE_ROOT, KIRO_TOOLS_DIR } from '../constants.ts';

export function register(router: Router): void {
  // GET /git-status — repository state via git status --porcelain -b
  router.get('/git-status', async (_req, _params) => {
    try {
      const proc = Bun.spawn(
        ['git', 'status', '--porcelain', '-b'],
        { cwd: WORKSPACE_ROOT, stdout: 'pipe', stderr: 'pipe' }
      );
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return new Response(
          JSON.stringify({ error: `git status failed: ${stderr.trim()}` }),
          { status: 500, headers: { 'content-type': 'application/json' } }
        );
      }
      const stdout = await new Response(proc.stdout).text();
      const lines = stdout.split('\n');

      let branch = '';
      let ahead = 0;
      let behind = 0;
      const staged: string[] = [];
      const modified: string[] = [];
      const untracked: string[] = [];

      for (const line of lines) {
        if (line.startsWith('## ')) {
          // ## main...origin/main [ahead 2] [behind 1]
          const branchMatch = line.match(/^## ([^\.\s]+)/);
          if (branchMatch) branch = branchMatch[1];
          const aheadMatch = line.match(/\[ahead (\d+)\]/);
          if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
          const behindMatch = line.match(/\[behind (\d+)\]/);
          if (behindMatch) behind = parseInt(behindMatch[1], 10);
          continue;
        }
        if (line.length < 3) continue;

        const indexCol = line[0];
        const worktreeCol = line[1];
        // Path starts at char 3 (after "XY ")
        const filePath = line.slice(3);

        if (indexCol === '?' && worktreeCol === '?') {
          untracked.push(filePath);
        } else if (indexCol !== ' ') {
          // staged takes precedence — index column is non-space
          staged.push(filePath);
        } else if (worktreeCol !== ' ') {
          // modified — index is space, worktree is non-space
          modified.push(filePath);
        }
      }

      const clean = staged.length === 0 && modified.length === 0 && untracked.length === 0;
      const gitStatus: GitStatus = { branch, clean, modified, staged, untracked, ahead, behind };
      return new Response(JSON.stringify(gitStatus), {
        headers: { 'content-type': 'application/json', 'connection': 'close' },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: `failed to spawn git: ${msg}` }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
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
